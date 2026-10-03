// Drive `runDesktop` (src/build/desktop.ts) without a window or a listening socket: `Deno.serve` is
// captured so a test calls the exact handler the desktop window would reach. Shared by the
// runDesktop and desktop security suites.

import { assert } from "@std/assert";
import { join } from "@std/path";
import {
  type DesktopRuntime,
  runDesktop,
  type RunDesktopOptions,
} from "../../src/build/desktop.ts";
import type { DesktopServeInfo } from "../../src/desktop/transport.ts";
import { withDenoProps } from "./deno-stub.ts";

/** The per-launch token header. */
export const TOKEN_HEADER = "x-denext-desktop-token";
/** The bridge's RPC endpoint. */
export const RPC = "/_denext/desktop/rpc";

/**
 * The slice of `Deno.desktop` that marks a runtime 2.9.7-denext.7 or later (`authSession.cancel`,
 * shipped with the relay marking): without it a published app origin is refused.
 */
export const DENEXT7_DESKTOP = Object.freeze({
  authSession: Object.freeze({
    capabilities: () => ({ supported: false }),
    start: () =>
      Promise.reject(Object.assign(new Error("not_supported"), { code: "not_supported" })),
    cancel: () => false,
  }),
});

/** The serve call `runDesktop` made. */
export interface Served {
  opts: { port?: number; hostname?: string; onError: (e: unknown) => Response };
  handler: (req: Request, info: DesktopServeInfo) => Response | Promise<Response>;
}

/** An export with a shell (carrying a strict CSP) and one asset. */
export async function exportDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-run-desktop-" });
  await Deno.writeTextFile(
    join(dir, "index.html"),
    `<!doctype html><html><head><meta http-equiv="content-security-policy" ` +
      `content="default-src 'self'; script-src 'self'"></head><body><div id="root"></div></body></html>`,
  );
  await Deno.writeTextFile(join(dir, "app.js"), "console.log('app')");
  return dir;
}

/**
 * Run `runDesktop(options)` with `Deno.serve` captured, `env` applied and `deno` members defined,
 * and the process-wide `unhandledrejection` guard it installs removed again afterwards.
 */
export async function boot(
  options: RunDesktopOptions,
  { env = {}, deno = {} }: {
    env?: Record<string, string | undefined>;
    deno?: Record<string, unknown>;
  } = {},
): Promise<{ runtime: DesktopRuntime; served: Served; errors: string[] }> {
  let served: Served | undefined;
  const errors: string[] = [];
  const prevError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  const guards: EventListenerOrEventListenerObject[] = [];
  const add = globalThis.addEventListener;
  globalThis.addEventListener =
    ((type: string, l: EventListenerOrEventListenerObject, o?: unknown) => {
      if (type === "unhandledrejection") guards.push(l);
      return add.call(globalThis, type, l, o as AddEventListenerOptions);
    }) as typeof globalThis.addEventListener;
  const keys = [
    "DENEXT_DESKTOP_DEV_URL",
    "DENEXT_DESKTOP_DEV_LAN",
    "DENO_DESKTOP_APP_ORIGIN",
    "PORT",
  ];
  const prevEnv = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  for (const k of keys) {
    const v = env[k];
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    const runtime = await withDenoProps({
      serve: (opts: Served["opts"], handler: Served["handler"]) => {
        served = { opts, handler };
        return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
      },
      ...deno,
    }, () => runDesktop(options));
    assert(served, "runDesktop started a server");
    return { runtime, served, errors };
  } finally {
    console.error = prevError;
    globalThis.addEventListener = add;
    for (const l of guards) globalThis.removeEventListener("unhandledrejection", l);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

/** A loopback request the stock runtime's window would send. */
export function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { "sec-fetch-dest": "document", ...headers } });
}

/**
 * A page-side RPC through the captured handler: a POST from the window's own loopback origin
 * carrying the per-launch token. Resolves the bridge's JSON envelope.
 */
export function pageRpc(
  served: Served,
  token: string,
  origin = "http://127.0.0.1:1",
): (cap: string, method: string, args?: unknown) => Promise<
  { ok: boolean; data?: unknown; error?: { code: string } }
> {
  return async (cap, method, args = {}) =>
    await (await served.handler(
      new Request(`${origin}${RPC}`, {
        method: "POST",
        headers: {
          [TOKEN_HEADER]: token,
          origin,
          "content-type": "application/json",
          "sec-fetch-dest": "empty",
        },
        body: JSON.stringify({ cap, method, args }),
      }),
      {},
    )).json();
}
