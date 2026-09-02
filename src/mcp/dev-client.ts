// Discover a running denext dev server and read its live event log.
//
// `denext dev` publishes its address to `<project>/.denext/dev.json` on boot (removed on
// drain). The MCP live tools read that file, then fetch `/_denext/dev-state` to get the dev
// black box — recent server errors + browser console/errors. A stale file (the server died
// without cleanup) just makes the fetch fail, which the caller reports as "not running".

import { join } from "@std/path";
import type { DevEvent } from "../build/dev-events.ts";

/** The `.denext/dev.json` a running dev server writes. */
export interface DevInfo {
  /** The origin to reach the dev server at, e.g. `http://127.0.0.1:3000`. */
  origin: string;
  port: number;
  hostname: string;
  pid: number;
  startedAt: number;
}

/** The `/_denext/dev-state` response: recent events + the total retained. */
export interface DevState {
  events: DevEvent[];
  total: number;
}

/**
 * Read `<dir>/.denext/dev.json`, the address a running dev server published.
 *
 * @param dir The project directory.
 * @returns The dev-server info, or null when no dev server is running (no file).
 */
export async function readDevInfo(dir: string): Promise<DevInfo | null> {
  try {
    const info = JSON.parse(await Deno.readTextFile(join(dir, ".denext", "dev.json")));
    return typeof info?.origin === "string" ? info as DevInfo : null;
  } catch {
    return null;
  }
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
): Promise<DevState | null> {
  const info = await readDevInfo(dir);
  if (!info) return null;
  const params = new URLSearchParams();
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  try {
    // A wedged dev server must not hang the tool (the MCP loop dispatches serially).
    const res = await fetch(`${info.origin}/_denext/dev-state${qs ? `?${qs}` : ""}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return await res.json() as DevState;
  } catch {
    return null;
  }
}
