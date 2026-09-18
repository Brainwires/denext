// Discover a running denext dev server and read its live event log.
//
// `denext dev` publishes its address to `<project>/.denext/dev.json` on boot (removed on
// drain). The MCP live tools read that file, then fetch `/_denext/dev-state` to get the dev
// black box — recent server errors + browser console/errors. A stale file (the server died
// without cleanup) just makes the fetch fail, which the caller reports as "not running".
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
    const origin = loopbackOrigin(info?.origin);
    return origin && processId(info?.pid) ? { ...info, origin } as DevInfo : null;
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

/** The hosts a dev server's published origin can name (it rewrites `0.0.0.0` to loopback). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The origin a `dev.json` names, only when it is a loopback http(s) address — rebuilt from its
 * parts, so no path, query or fragment rides along. A dev server only ever writes one of those;
 * anything else is a committed or planted file pointing the MCP tools at another host.
 */
function loopbackOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  const web = url.protocol === "http:" || url.protocol === "https:";
  return web && LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null;
}

/**
 * How every request to the dev server is made: with a deadline (a wedged dev server must not
 * hang the tool — the MCP loop dispatches serially) and with redirects REFUSED. The origin was
 * checked to be loopback, and `fetch` following a `Location` would undo that check: a planted
 * loopback listener answering `302` to another host would carry the tool off the machine.
 */
function devRequest(): RequestInit {
  return { signal: AbortSignal.timeout(5000), redirect: "error" };
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
  try {
    const res = await fetch(`${info.origin}/_denext/dev-state${qs ? `?${qs}` : ""}`, devRequest());
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
  try {
    const res = await fetch(`${info.origin}${DEV_INSPECT_PATH}${qs}`, devRequest());
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, reason: res.status === 404 ? "no-snapshot" : "no-dev-server" };
    }
    return { ok: true, inspect: await res.json() as DevInspect };
  } catch {
    return { ok: false, reason: "no-dev-server" };
  }
}
