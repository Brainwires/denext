// Discover a running denext dev server and read its live event log.
//
// `denext dev` publishes its address to `<project>/.denext/dev.json` on boot (removed on
// drain). The MCP live tools read that file, then fetch `/_denext/dev-state` to get the dev
// black box — recent server errors + browser console/errors. A stale file (the server died
// without cleanup) just makes the fetch fail, which the caller reports as "not running".
//
// "Running" is decided by that probe, never by the file's `pid`: the pid is the process that
// LISTENS (a re-exec'd `deno run` child of the CLI, not the `denext dev` process the user
// started), and it is what the server's own `/_denext/dev-state` answers with — so an
// identity check compares the two, and nothing here asks the OS whether a pid is alive.
//
// A loopback or wildcard bind is reachable at more than one address (`localhost` may resolve
// to `::1` only; a `::` listener may refuse IPv4), so a reader tries each loopback spelling
// of the published port ({@linkcode DevInfo.origins}) until one answers.
//
// The same discovery backs the DevTools bridge: `/_denext/dev-inspect` returns the latest
// component tree the in-page inspector pushed, which is what the component-tree/
// why-render/hook-state tools render.

import { join } from "@std/path";
import type { DevEvent } from "../build/dev-events.ts";
import type { InspectSnapshot } from "../client/devtools-inspect-sink.ts";

/**
 * The DevTools bridge endpoint (`src/build/dev-server/state.ts`'s `DEV_INSPECT_PATH`).
 *
 * A copy of the VALUE, not an import: this module is reached by `denext ui`'s Setup and Dev
 * pages,
 * whose module graph is asserted never to touch `src/build/dev-server/` (and through it
 * the bundler). A test asserts the two spellings stay equal.
 */
const DEV_INSPECT_PATH = "/_denext/dev-inspect";

/** The `.denext/dev.json` a running dev server writes. */
export interface DevInfo {
  /** The origin to reach the dev server at, e.g. `http://127.0.0.1:3000`. */
  origin: string;
  /**
   * Every loopback origin the server may answer at, {@linkcode DevInfo.origin} first, then
   * the other loopback spellings of the same scheme and port (`127.0.0.1`, `[::1]`,
   * `localhost`).
   */
  origins: string[];
  port: number;
  hostname: string;
  pid: number;
  startedAt: number;
}

/**
 * The `/_denext/dev-state` response: recent events + the total retained. (Named for the
 * response, not the dev server's own `DevState` record in `src/build/dev-server/state.ts`
 * — this is the JSON an out-of-process reader gets, and nothing more.)
 */
export interface DevStateResponse {
  events: DevEvent[];
  total: number;
  /** The dev server's own process id — the one its `dev.json` names. */
  pid: number;
  /** The project directory it serves, as it resolved it. */
  projectDir: string;
}

/**
 * Read `<dir>/.denext/dev.json`, the address a running dev server published.
 *
 * @param dir The project directory.
 * @returns The dev-server info, or null when no dev server is running (no file), the file
 *   names anything but a loopback http(s) origin, or its `pid` is not a real process id.
 */
export async function readDevInfo(dir: string): Promise<DevInfo | null> {
  try {
    const info = JSON.parse(await Deno.readTextFile(join(dir, ".denext", "dev.json")));
    const origins = loopbackOrigins(info?.origin);
    return origins && processId(info?.pid)
      ? { ...info, origin: origins[0], origins } as DevInfo
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether `value` can be the pid a dev server wrote about itself: a safe integer above 1. A
 * dev server only ever writes its own `Deno.pid`; `-1` (every process the caller may signal),
 * `0` (the caller's process group) and `1` (init) are what a committed or planted file would
 * name to turn "stop the dev server" into something else.
 */
function processId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1;
}

/** The loopback spellings a reader tries, in order, after the published one. */
const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost"];

/** A wildcard bind as a published origin names it, mapped to its family's loopback. */
const WILDCARD_HOSTS: ReadonlyMap<string, string> = new Map([
  ["0.0.0.0", "127.0.0.1"],
  ["[::]", "[::1]"],
]);

/**
 * The origins a `dev.json`'s `origin` lets a reader try, only when it names a loopback (or
 * wildcard) http(s) address — rebuilt from its parts, so no path, query or fragment rides
 * along. A dev server only ever writes one of those; anything else is a committed or planted
 * file pointing the MCP tools at another host. The published origin comes first (a wildcard
 * as its family's loopback), then the other loopback spellings of the same scheme and port.
 *
 * Accepts the unbracketed IPv6 origin (`http://::1:5199`) an older dev server wrote for a
 * `localhost` bind that resolved to `::1`.
 */
function loopbackOrigins(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const url = parseOrigin(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  const host = WILDCARD_HOSTS.get(url.hostname) ?? url.hostname;
  if (!LOOPBACK_HOSTS.includes(host)) return null;
  const port = url.port ? `:${url.port}` : "";
  const first = `${url.protocol}//${host}${port}`;
  const rest = LOOPBACK_HOSTS.filter((h) => h !== host).map((h) => `${url.protocol}//${h}${port}`);
  return [first, ...rest];
}

/** `value` as a URL, or — the legacy unbracketed IPv6 form — with its host bracketed. */
function parseOrigin(value: string): URL | null {
  if (URL.canParse(value)) return new URL(value);
  const legacy = /^(https?):\/\/([0-9a-f]*:[0-9a-f:.]*):(\d+)\/?$/i.exec(value);
  const fixed = legacy ? `${legacy[1]}://[${legacy[2]}]:${legacy[3]}` : "";
  return legacy && URL.canParse(fixed) ? new URL(fixed) : null;
}

/**
 * Request `path` from the dev server `info` describes, trying each of its
 * {@linkcode DevInfo.origins} until one answers (any HTTP status counts as an answer; a
 * refused connection, a timeout or a refused redirect moves on to the next).
 *
 * Every attempt has a deadline (a wedged dev server must not hang the tool — the MCP loop
 * dispatches serially) and REFUSES redirects. The origins were checked to be loopback, and
 * `fetch` following a `Location` would undo that check: a planted loopback listener answering
 * `302` to another host would carry the tool off the machine.
 *
 * @param info The published dev-server info.
 * @param path The path (and query) to request, e.g. `/_denext/dev-state?limit=1`.
 * @param timeoutMs The per-attempt deadline.
 * @returns The first response and the origin that gave it, or null when none answered.
 */
export async function devFetch(
  info: Pick<DevInfo, "origin" | "origins">,
  path: string,
  timeoutMs = 5000,
): Promise<{ response: Response; origin: string } | null> {
  const origins = info.origins?.length ? info.origins : [info.origin];
  for (const origin of origins) {
    try {
      const response = await fetch(`${origin}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      return { response, origin };
    } catch { /* not answering at this spelling — try the next */ }
  }
  return null;
}

/**
 * Fetch the running dev server's recent events (server errors + browser console).
 *
 * @param dir The project directory.
 * @param opts `kind` (`error`|`console`) and `limit` filters, forwarded to the endpoint.
 * @returns The dev state, or null when no dev server is reachable.
 */
export async function fetchDevState(
  dir: string,
  opts: { kind?: string; limit?: number } = {},
): Promise<DevStateResponse | null> {
  const info = await readDevInfo(dir);
  if (!info) return null;
  const params = new URLSearchParams();
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const answer = await devFetch(info, `/_denext/dev-state${qs ? `?${qs}` : ""}`);
  if (!answer) return null;
  const res = answer.response;
  try {
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return await res.json() as DevStateResponse;
  } catch {
    return null;
  }
}

/** The `/_denext/dev-inspect` read: the page's latest component tree and how stale it is. */
export interface DevInspect {
  /** The tree the page's DevTools sink posted. */
  snapshot: InspectSnapshot;
  /** How long ago it arrived, on the dev server's clock (ms). */
  ageMs: number;
}

/**
 * Why an inspector read came back empty — the two cases an agent must be told apart: no
 * dev server at all, versus a dev server no page has ever pushed a tree to.
 */
export type DevInspectMiss = "no-dev-server" | "no-snapshot";

/** An inspector read: the snapshot, or which of the two empty cases applies. */
export type DevInspectResult =
  | { ok: true; inspect: DevInspect }
  | { ok: false; reason: DevInspectMiss };

/**
 * Fetch the latest component tree the running dev server holds for a page.
 *
 * @param dir The project directory.
 * @param url Optional page URL/path to select (default: the most recent page posted).
 * @returns The snapshot, or `no-dev-server` / `no-snapshot`.
 */
export async function fetchDevInspect(dir: string, url?: string): Promise<DevInspectResult> {
  const info = await readDevInfo(dir);
  if (!info) return { ok: false, reason: "no-dev-server" };
  const qs = url ? `?url=${encodeURIComponent(url)}` : "";
  const answer = await devFetch(info, `${DEV_INSPECT_PATH}${qs}`);
  if (!answer) return { ok: false, reason: "no-dev-server" };
  const res = answer.response;
  try {
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, reason: res.status === 404 ? "no-snapshot" : "no-dev-server" };
    }
    return { ok: true, inspect: await res.json() as DevInspect };
  } catch {
    return { ok: false, reason: "no-dev-server" };
  }
}
