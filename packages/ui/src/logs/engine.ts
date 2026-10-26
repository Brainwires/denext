// A reader of one compose project's container logs through the Docker Engine API — what the
// stack's `dashboard-logs` relay uses (`relay.ts`), so the dashboard itself never touches the
// Docker socket. Only two kinds of request are ever made, both GET: the container list (filtered
// to this project's compose label) and one container's logs. A container's inspect document —
// which carries its environment, every secret in it — is read only for the relay's OWN
// container, to learn which compose project it belongs to, and nothing from it but that label
// leaves this module.

import type { LogLine } from "./source.ts";
import { type PsRow, type ServiceHealth, serviceHealth } from "@denext/denext/internal/ui-host";

/** The compose labels Docker Compose stamps on every container it creates. */
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";

/** The most log lines one container is asked for. */
export const ENGINE_MAX_TAIL = 5_000;

/** A GET against the Docker Engine API. */
export type EngineGet = (path: string, signal?: AbortSignal) => Promise<Response>;

/**
 * A GET over the Engine's Unix socket (`/var/run/docker.sock`): `fetch` through a Unix-socket
 * proxy, so the request is plain HTTP/1.1 to the daemon.
 *
 * @param socket The socket's path.
 * @returns The GET.
 */
export function socketGet(socket: string): EngineGet {
  let client: Deno.HttpClient | undefined;
  return (path, signal) => {
    client ??= Deno.createHttpClient({ proxy: { transport: "unix", path: socket } });
    return fetch(`http://docker${path}`, { client, signal });
  };
}

/** A JSON answer, or a clear error for anything but a 200. */
async function json<T>(get: EngineGet, path: string, signal?: AbortSignal): Promise<T> {
  const res = await get(path, signal);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`the Docker Engine answered ${res.status} for ${path.split("?")[0]}`);
  }
  return await res.json() as T;
}

/**
 * The compose project a container belongs to (from its own labels).
 *
 * @param get The Engine GET.
 * @param container The container's id or name (inside a container: its `HOSTNAME`).
 * @returns The project's name.
 */
export async function projectOf(get: EngineGet, container: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error("bad container name");
  const doc = await json<{ Config?: { Labels?: Record<string, string> } }>(
    get,
    `/containers/${container}/json`,
  );
  const project = doc.Config?.Labels?.[PROJECT_LABEL];
  if (!project) throw new Error("this container was not started by Docker Compose");
  return project;
}

/** One container as the Engine's list describes it. */
interface ListedContainer {
  Id: string;
  Created?: number;
  State?: string;
  Status?: string;
  Labels?: Record<string, string>;
}

/** A container's compose service, when it belongs to `project`. */
function serviceOf(c: ListedContainer, project: string): string | undefined {
  return c.Labels?.[PROJECT_LABEL] === project ? c.Labels?.[SERVICE_LABEL] : undefined;
}

/** Whether `c` was created after `seen` (or there is no `seen`). */
function isNewer(c: ListedContainer, seen: ListedContainer | undefined): boolean {
  return !seen || (c.Created ?? 0) > (seen.Created ?? 0);
}

/**
 * The project's newest container per compose service, in service-name order.
 *
 * @param get The Engine GET.
 * @param project The compose project.
 * @returns Service name → its newest container.
 */
async function newestContainers(
  get: EngineGet,
  project: string,
): Promise<[string, ListedContainer][]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${PROJECT_LABEL}=${project}`] }));
  const list = await json<ListedContainer[]>(get, `/containers/json?all=1&filters=${filters}`);
  const newest = new Map<string, ListedContainer>();
  for (const c of list) {
    const service = serviceOf(c, project);
    if (service && isNewer(c, newest.get(service))) newest.set(service, c);
  }
  return [...newest.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The project's services, each with the id of its newest container.
 *
 * @param get The Engine GET.
 * @param project The compose project.
 * @returns Service name → container id, in name order.
 */
export async function projectServices(
  get: EngineGet,
  project: string,
): Promise<Map<string, string>> {
  return new Map((await newestContainers(get, project)).map(([name, c]) => [name, c.Id]));
}

/**
 * The text of a logs stream: a non-TTY container's output is multiplexed in frames of an
 * 8-byte header (stream, three zero bytes, a big-endian length) and a payload; a TTY
 * container's is the raw text.
 *
 * @param bytes The body.
 * @returns The text.
 */
export function demux(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  const framed = bytes.length >= 8 && bytes[0] <= 2 && bytes[1] === 0 && bytes[2] === 0 &&
    bytes[3] === 0;
  if (!framed) return decoder.decode(bytes);
  let out = "";
  let at = 0;
  while (at + 8 <= bytes.length) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + at + 4, 4).getUint32(0);
    out += decoder.decode(bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size)), {
      stream: true,
    });
    at += 8 + size;
  }
  return out + decoder.decode();
}

/**
 * Split a timestamped line (`2026-10-14T09:00:00.123456789Z text`) into its time and text.
 *
 * @param service The service the line came from.
 * @param line The line.
 * @returns The log line.
 */
export function timestamped(service: string, line: string): LogLine {
  const match = /^(\d{4}-\d\d-\d\dT\S+Z)\s?(.*)$/.exec(line);
  return match ? { service, time: match[1], text: match[2] } : { service, text: line };
}

/**
 * One container's last `tail` lines (since `since`, epoch seconds), oldest first.
 *
 * @param get The Engine GET.
 * @param service The service, named on each line.
 * @param container The container id.
 * @param options `tail` and `since`.
 * @returns The lines.
 */
export async function containerLogs(
  get: EngineGet,
  service: string,
  container: string,
  options: { tail: number; since?: number },
): Promise<LogLine[]> {
  const tail = Math.max(1, Math.min(ENGINE_MAX_TAIL, Math.trunc(options.tail)));
  const since = options.since !== undefined ? `&since=${Math.trunc(options.since)}` : "";
  const res = await get(
    `/containers/${container}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}${since}`,
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`the Docker Engine answered ${res.status} for the ${service} logs`);
  }
  const text = demux(new Uint8Array(await res.arrayBuffer()));
  return text.split("\n").filter((l) => l !== "").map((l) => timestamped(service, l));
}

/** A listed container as a `docker compose ps` row: its state, health verdict and exit code. */
function psRowOf(service: string, c: ListedContainer): PsRow {
  const status = c.Status ?? "";
  const health = /\((healthy|unhealthy|health: starting)\)/.exec(status)?.[1];
  const exit = /^Exited \((\d+)\)/.exec(status)?.[1];
  return {
    Service: service,
    State: c.State ?? "unknown",
    ...(health ? { Health: health === "health: starting" ? "starting" : health } : {}),
    ...(exit !== undefined ? { ExitCode: Number(exit) } : {}),
  };
}

/**
 * The project's services as `docker compose ps` describes them, from the Engine's container list
 * (the newest container of each): its state, its health check's verdict, its exit code.
 *
 * @param get The Engine GET.
 * @param project The compose project.
 * @returns Each service's verdict, in name order.
 */
export async function projectHealth(get: EngineGet, project: string): Promise<ServiceHealth[]> {
  return (await newestContainers(get, project)).map(([name, c]) => serviceHealth(psRowOf(name, c)));
}
