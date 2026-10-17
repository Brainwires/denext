// `denext desktop dev --inspect-renderer[=<addr>]`: open the window's RENDERER (the page, not the
// Deno runtime) to a debugger. `desktop dev` launches the built executable itself, so it puts the
// environment the runtime's own `deno desktop --inspect-renderer` would set on that launch, per
// webview backend (keep the table in sync with the fork's `desktop_renderer_inspect::plan`, see
// its `doc/denext-inspect-renderer.md`):
//
//   CEF (every OS)      CDP on http://127.0.0.1:<port>   LAUFEY_REMOTE_DEBUGGING_PORT=<port>
//   WebView2 (Windows)  CDP on http://127.0.0.1:<port>   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
//                                                         += --remote-debugging-port=<port>
//   WebKitGTK (Linux)   WebKit's inspector (not CDP)     WEBKIT_INSPECTOR_HTTP_SERVER=<host:port>
//   WKWebView (macOS)   no remote port                   none (Safari > Develop)
//
// The hosts honour these only while DevTools are on (`LAUFEY_INSPECTABLE`, always on in `dev`); a
// packaged app with DevTools off clears them. A remote debugging port is full control of the page
// and its origin's storage, so the address must be loopback unless the caller opts in.

import { isLoopbackHost } from "../utils/loopback.ts";
import type { DesktopOs } from "./desktop-capabilities.ts";
import type { DesktopRuntimeBackend } from "./desktop-runtime.ts";

/** The env var the CEF host reads for Chromium's `remote_debugging_port`. */
const CEF_REMOTE_DEBUGGING_PORT_ENV = "LAUFEY_REMOTE_DEBUGGING_PORT";
/** WebView2's documented extra-browser-arguments override. */
const WEBVIEW2_BROWSER_ARGS_ENV = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
/** WebKitGTK's remote inspector HTTP server address. */
const WEBKIT_INSPECTOR_HTTP_ENV = "WEBKIT_INSPECTOR_HTTP_SERVER";

/** A parsed `--inspect-renderer` address. Port 0 means "pick a free one". */
export interface InspectRendererAddr {
  readonly host: string;
  readonly port: number;
}

/** What {@linkcode inspectRendererPlan} decided for a backend. */
export interface InspectRendererPlan {
  /** `cdp` (Chrome DevTools Protocol), `webkit` (WebKit's own inspector), or `none`. */
  readonly protocol: "cdp" | "webkit" | "none";
  /** The env to put on the window's launch. */
  readonly env: Record<string, string>;
  /** The inspector's HTTP endpoint (`http://127.0.0.1:<port>`), when there is one. */
  readonly endpoint?: string;
  /** Lines to print about it (what to open, what is not available). */
  readonly notes: readonly string[];
}

/**
 * Parse the flag's value: `true` (the bare flag) or `""` is `127.0.0.1` with a free port; otherwise
 * `<port>`, `:<port>`, `<host>`, `<host>:<port>` or `[<ipv6>]:<port>`. A non-loopback host is
 * refused unless `allowRemote` (the debugging port is full control of the page).
 *
 * @param value The flag's value.
 * @param allowRemote Accept a non-loopback host.
 * @returns The address (port 0 when none was given).
 * @throws {Error} A malformed address, a bad port, or a refused non-loopback host.
 */
export function parseInspectRendererAddr(
  value: string | true,
  allowRemote = false,
): InspectRendererAddr {
  const raw = value === true ? "" : value.trim();
  const { host, port } = splitAddr(raw);
  if (!host) throw new Error(`--inspect-renderer: no host in "${raw}"`);
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(
      `--inspect-renderer: refusing the non-loopback address "${host}". The renderer's debugging ` +
        "port gives whoever reaches it full control of the page, its storage and its cookies. " +
        "Pass --inspect-renderer-allow-remote to expose it anyway.",
    );
  }
  return { host, port };
}

/** `host` / `port` of an address string (no host → 127.0.0.1, no port → 0). */
function splitAddr(raw: string): InspectRendererAddr {
  if (raw === "") return { host: "127.0.0.1", port: 0 };
  if (/^\d+$/.test(raw)) return { host: "127.0.0.1", port: parsePort(raw) };
  const v6 = raw.match(/^\[([^\]]+)\](?::(\d*))?$/);
  if (v6) return { host: v6[1], port: v6[2] ? parsePort(v6[2]) : 0 };
  const colon = raw.lastIndexOf(":");
  if (colon < 0) return { host: raw, port: 0 };
  if (raw.indexOf(":") !== colon) {
    throw new Error(`--inspect-renderer: write an IPv6 address in brackets ([::1]:9229): "${raw}"`);
  }
  const host = raw.slice(0, colon) || "127.0.0.1";
  const port = raw.slice(colon + 1);
  return { host, port: port === "" ? 0 : parsePort(port) };
}

function parsePort(text: string): number {
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--inspect-renderer: "${text}" is not a port (0-65535)`);
  }
  return port;
}

/**
 * A free TCP port on loopback (bound, read and released).
 *
 * @returns The port.
 */
export function freeLoopbackPort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

/**
 * The address with port 0 replaced by a free loopback port.
 *
 * @param addr The parsed address.
 * @param pick The port picker (tests pass a fixed one).
 * @returns The address to use.
 */
function resolveInspectRendererAddr(
  addr: InspectRendererAddr,
  pick: () => number = freeLoopbackPort,
): InspectRendererAddr {
  return addr.port === 0 ? { ...addr, port: pick() } : addr;
}

/**
 * The launch env (and what to tell the user) for inspecting `backend`'s renderer on `os`.
 *
 * @param backend The project's `desktop.backend` (deno.json).
 * @param os The host OS.
 * @param addr The address, its port already resolved.
 * @param inherited The env the window would inherit (an existing
 *   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is kept, the port appended).
 * @returns The plan.
 */
export function inspectRendererPlan(
  backend: DesktopRuntimeBackend,
  os: DesktopOs,
  addr: InspectRendererAddr,
  inherited: Readonly<Record<string, string | undefined>> = {},
): InspectRendererPlan {
  const port = String(addr.port);
  // Chromium (CEF and WebView2) binds its remote debugging port on loopback whatever is asked.
  const cdpEndpoint = `http://127.0.0.1:${port}`;
  const loopbackOnly = isLoopbackHost(addr.host)
    ? []
    : [`Chromium listens on loopback only; ${addr.host} is not used (forward the port instead).`];
  if (backend === "cef") {
    return {
      protocol: "cdp",
      env: { [CEF_REMOTE_DEBUGGING_PORT_ENV]: port },
      endpoint: cdpEndpoint,
      notes: loopbackOnly,
    };
  }
  if (os === "windows") {
    const prior = inherited[WEBVIEW2_BROWSER_ARGS_ENV]?.trim();
    const arg = `--remote-debugging-port=${port}`;
    return {
      protocol: "cdp",
      env: { [WEBVIEW2_BROWSER_ARGS_ENV]: prior ? `${prior} ${arg}` : arg },
      endpoint: cdpEndpoint,
      notes: loopbackOnly,
    };
  }
  if (os === "linux") {
    const host = addr.host.includes(":") ? `[${addr.host}]` : addr.host;
    return {
      protocol: "webkit",
      env: { [WEBKIT_INSPECTOR_HTTP_ENV]: `${host}:${port}` },
      endpoint: `http://${host}:${port}`,
      notes: [
        "WebKitGTK serves WebKit's own inspector (open the endpoint in a browser), not the Chrome " +
        'DevTools Protocol; set deno.json desktop.backend to "cef" for CDP.',
      ],
    };
  }
  return {
    protocol: "none",
    env: {},
    notes: [
      "WKWebView has no remote debugging port: inspect the window from Safari > Develop, or set " +
      'deno.json desktop.backend to "cef" for the Chrome DevTools Protocol.',
    ],
  };
}

/** One `/json/list` target. */
export interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly title?: string;
  readonly webSocketDebuggerUrl?: string;
}

/**
 * The page targets of a `/json/list` answer (other target kinds, and entries without a
 * WebSocket, are dropped).
 *
 * @param body The parsed JSON.
 * @returns The pages.
 */
export function cdpPages(body: unknown): CdpTarget[] {
  if (!Array.isArray(body)) return [];
  return body.filter((t): t is CdpTarget =>
    typeof t === "object" && t !== null && (t as CdpTarget).type === "page" &&
    typeof (t as CdpTarget).id === "string" &&
    typeof (t as CdpTarget).webSocketDebuggerUrl === "string"
  );
}

/**
 * The lines announcing a page: its WebSocket and a DevTools frontend URL for Chrome.
 *
 * @param page The target.
 * @returns The lines.
 */
function cdpPageLines(page: CdpTarget): string[] {
  const ws = page.webSocketDebuggerUrl!;
  return [
    `  ▸ Renderer page ${page.url}`,
    `      WebSocket  ${ws}`,
    `      DevTools   devtools://devtools/bundled/inspector.html?ws=${
      ws.replace(/^wss?:\/\//, "")
    }`,
  ];
}

/** Options for {@linkcode announceCdpPages}. */
export interface AnnounceOptions {
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
  /** Between polls (default 500 ms). */
  readonly intervalMs?: number;
  /** Give up after this long (default 60 s). */
  readonly timeoutMs?: number;
}

/**
 * Poll `<endpoint>/json/list` until the window's page has navigated (a page target whose URL is
 * not `about:blank`; the target, and so its WebSocket, is the same before and after), then print
 * every such page found on that poll. On timeout it prints the blank pages it saw, if any, else
 * one line; it stops at once when `signal` aborts.
 *
 * @param endpoint The CDP endpoint (`http://127.0.0.1:<port>`).
 * @param opts Logging, cancellation and timing.
 * @returns The pages announced (none on timeout / abort).
 */
export async function announceCdpPages(
  endpoint: string,
  opts: AnnounceOptions,
): Promise<CdpTarget[]> {
  const doFetch = opts.fetch ?? fetch;
  const interval = opts.intervalMs ?? 500;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const print = (pages: CdpTarget[]) => {
    for (const page of pages) for (const line of cdpPageLines(page)) opts.log(line);
    return pages;
  };
  let blank: CdpTarget[] = [];
  while (!opts.signal.aborted && Date.now() < deadline) {
    try {
      const res = await doFetch(`${endpoint}/json/list`, { signal: opts.signal });
      const pages = res.ok ? cdpPages(await res.json()) : (await res.body?.cancel(), []);
      const loaded = pages.filter((p) => p.url !== "about:blank");
      if (loaded.length > 0) return print(loaded);
      if (pages.length > 0) blank = pages;
    } catch { /* not listening yet, or aborted */ }
    await delay(interval, opts.signal);
  }
  if (opts.signal.aborted) return [];
  if (blank.length > 0) return print(blank);
  opts.log(`  ▸ No renderer page appeared at ${endpoint}/json/list; is the window open?`);
  return [];
}

/** Resolve after `ms`, or at once when `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** What {@linkcode inspectRendererLaunch} takes. */
export interface InspectRendererLaunchInput {
  /** The flag's value (`true` for the bare flag). */
  readonly value: string | true;
  /** `--inspect-renderer-allow-remote`. */
  readonly allowRemote: boolean;
  readonly backend: DesktopRuntimeBackend;
  readonly os: DesktopOs;
  /** The env the window inherits (defaults to none). */
  readonly inherited?: Readonly<Record<string, string | undefined>>;
  /** The free-port picker (tests pass a fixed one). */
  readonly pickPort?: () => number;
}

/**
 * Everything `desktop dev --inspect-renderer` needs: the address (a free loopback port for a bare
 * flag), the env for the window's launch, and the lines to print before it opens.
 *
 * @param input The flag and the window's backend / OS.
 * @returns The address, the plan, and the banner lines.
 * @throws {Error} A malformed or refused address.
 */
export function inspectRendererLaunch(
  input: InspectRendererLaunchInput,
): { addr: InspectRendererAddr; plan: InspectRendererPlan; lines: string[] } {
  const addr = resolveInspectRendererAddr(
    parseInspectRendererAddr(input.value, input.allowRemote),
    input.pickPort,
  );
  const plan = inspectRendererPlan(input.backend, input.os, addr, input.inherited);
  const lines = [
    plan.protocol === "cdp"
      ? `  ▸ Renderer inspector (Chrome DevTools Protocol): ${plan.endpoint}/json/list`
      : plan.protocol === "webkit"
      ? `  ▸ Renderer inspector (WebKit): ${plan.endpoint}`
      : "  ▸ Renderer inspector: not available on this backend",
    ...plan.notes.map((n) => `    ${n}`),
  ];
  return { addr, plan, lines };
}
