// `denext dashboard-logs`: the stack's log relay. It is the only container of the stack that
// reaches the Docker socket, and it answers exactly two GETs, both for its own compose project:
//
//   GET /v1/services                          → { ok, services: ["db", "web", …] }
//   GET /v1/logs?service=web&tail=500&since=N → { ok, lines: [{ service, time, text }] }
//
// Every request needs `Authorization: Bearer <token>` (derived from the dashboard password; see
// `relayToken`), compared in constant time. Nothing else of the Engine API is reachable through
// it: no inspect document (a container's environment), no exec, no archive, no write. The relay
// is on a network of its own with the dashboard, and publishes no port.

import { serveWithPortFallback } from "../../server/serve-utils.ts";
import { constantTimeEqual } from "../security.ts";
import {
  containerLogs,
  ENGINE_MAX_TAIL,
  type EngineGet,
  projectOf,
  projectServices,
} from "./engine.ts";
import { LOG_SERVICE_NAME, type LogLine } from "./source.ts";

/** The port the relay listens on unless told otherwise. */
export const DEFAULT_RELAY_PORT = 3101;

/** How long the project's service list is reused, in ms. */
const SERVICES_TTL_MS = 10_000;

/** The most lines one answer carries (every service together). */
const MAX_LINES = 10_000;

/** Options for {@linkcode startLogsRelay}. */
export interface LogsRelayOptions {
  /** The address to bind (default `127.0.0.1`; the stack passes `0.0.0.0`). */
  readonly hostname?: string;
  /** The port (default {@linkcode DEFAULT_RELAY_PORT}; `0` picks one). */
  readonly port?: number;
  /** The bearer token callers must present; `null` refuses every request (no password set). */
  readonly token: string | null;
  /** The Engine GET (over the socket). */
  readonly engine: EngineGet;
  /** This container's id or name, to find its compose project (default: `$HOSTNAME`). */
  readonly self: string;
  /** Stops the relay. */
  readonly signal?: AbortSignal;
}

/** A JSON answer. */
function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Why a request is refused before anything is read: no password set (`503`), no or another
 * bearer token (`401`, compared in constant time), anything but a GET (`405`) — else `null`.
 */
function refusal(request: Request, token: string | null): Response | null {
  if (token === null) {
    return reply({ ok: false, reason: "locked: DASHBOARD_PASSWORD is not set" }, 503);
  }
  const auth = request.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!constantTimeEqual(presented, token)) {
    return reply({ ok: false, reason: "unauthorized" }, 401);
  }
  if (request.method !== "GET") return reply({ ok: false, reason: "method not allowed" }, 405);
  return null;
}

/** The relay's request handler (exported for tests). */
export function relayHandler(
  options: Pick<LogsRelayOptions, "token" | "engine" | "self">,
): (request: Request) => Promise<Response> {
  let cache: { at: number; services: Map<string, string> } | undefined;
  let project: string | undefined;
  const services = async (): Promise<Map<string, string>> => {
    if (cache && Date.now() - cache.at < SERVICES_TTL_MS) return cache.services;
    project ??= await projectOf(options.engine, options.self);
    cache = { at: Date.now(), services: await projectServices(options.engine, project) };
    return cache.services;
  };
  return async (request) => {
    const refused = refusal(request, options.token);
    if (refused) return refused;
    const url = new URL(request.url);
    try {
      if (url.pathname === "/v1/services") {
        return reply({ ok: true, services: [...(await services()).keys()] });
      }
      if (url.pathname === "/v1/logs") return reply(await logs(url, await services(), options));
      return reply({ ok: false, reason: "not found" }, 404);
    } catch (error) {
      console.error("denext dashboard-logs:", error instanceof Error ? error.message : error);
      return reply({ ok: false, reason: "the Docker Engine could not be read" }, 502);
    }
  };
}

/** `GET /v1/logs`: one service's lines, or every service's. */
async function logs(
  url: URL,
  known: Map<string, string>,
  options: Pick<LogsRelayOptions, "engine">,
): Promise<{ ok: true; lines: LogLine[] } | { ok: false; reason: string }> {
  const service = url.searchParams.get("service") ?? "";
  if (service && (!LOG_SERVICE_NAME.test(service) || !known.has(service))) {
    return { ok: false, reason: "unknown service" };
  }
  const window = logsWindow(url);
  const lines: LogLine[] = [];
  for (const [name, id] of known) {
    if (service && name !== service) continue;
    lines.push(...await containerLogs(options.engine, name, id, window));
  }
  return { ok: true, lines: lines.slice(Math.max(0, lines.length - MAX_LINES)) };
}

/** `?tail=` (1 … the Engine's cap, default 500) and `?since=` (seconds back) as the Engine wants them. */
function logsWindow(url: URL): { tail: number; since?: number } {
  const tail = Math.max(1, Math.min(ENGINE_MAX_TAIL, Number(url.searchParams.get("tail")) || 500));
  const back = Number(url.searchParams.get("since"));
  if (!Number.isFinite(back) || back <= 0) return { tail };
  return { tail, since: Math.floor(Date.now() / 1000 - back) };
}

/** A running relay. */
export interface LogsRelay {
  /** The bound port. */
  readonly port: number;
  /** Resolves once it has stopped. */
  readonly finished: Promise<void>;
}

/**
 * Start the relay.
 *
 * @param options Where to bind, the token, the Engine and this container's name.
 * @returns The bound relay.
 */
export function startLogsRelay(options: LogsRelayOptions): LogsRelay {
  const handle = relayHandler(options);
  const server = serveWithPortFallback({
    port: options.port ?? DEFAULT_RELAY_PORT,
    hostname: options.hostname ?? "127.0.0.1",
    strict: true,
    signal: options.signal,
    onListen: () => {},
  }, handle);
  return { port: (server.addr as Deno.NetAddr).port, finished: server.finished };
}
