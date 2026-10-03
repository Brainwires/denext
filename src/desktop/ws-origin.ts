/**
 * Where a page's WebSocket to its own server goes. On the web (and under the stock Deno Desktop
 * runtime) that is `ws(s)://<location.host>`. Under denext's pinned Deno Desktop runtime the page
 * runs at a custom origin (`desktop.app.origin`, e.g. `myapp://app`) served over an in-process
 * transport that carries no WebSockets: they go through the runtime's loopback relay instead, whose
 * address the desktop runtime injects into the page as `globalThis.__denext.wsOrigin`
 * (`ws://127.0.0.1:<port>`). The relay admits only an `Origin` equal to the app origin, which is
 * exactly what the page's own WebSocket sends.
 *
 * Client-safe: web APIs only, nothing runs at import. Imported by denext's Live client and
 * re-exported from `denext/desktop/client`.
 *
 * @module
 */

/** The injected global, read through a cast (JSR refuses a module that declares globals). */
function injectedWsOrigin(): unknown {
  const g = (globalThis as { __denext?: { desktop?: unknown; wsOrigin?: unknown } }).__denext;
  return typeof g === "object" && g !== null && g.desktop === true ? g.wsOrigin : undefined;
}

/**
 * The pinned runtime's WebSocket relay origin (`ws://127.0.0.1:<port>`) when this page runs in a
 * Deno Desktop window at a custom app origin, else `undefined` (the web, mobile, the stock
 * desktop runtime, SSR). Only a `ws:` / `wss:` origin with no path, query or credentials counts.
 *
 * @returns The relay origin, or `undefined`.
 * @example
 * ```ts
 * import { desktopWsOrigin } from "denext/desktop/client";
 *
 * const relay = desktopWsOrigin(); // "ws://127.0.0.1:51234" in a pinned-runtime window
 * ```
 */
export function desktopWsOrigin(): string | undefined {
  const raw = injectedWsOrigin();
  if (typeof raw !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return undefined;
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * The URL for a WebSocket from this page to its own server at `path` (`"/api/socket"`): the
 * runtime's relay under denext's pinned Deno Desktop runtime ({@linkcode desktopWsOrigin}), else
 * `wss://` / `ws://` on the page's own host. Off a page (no `location`) it returns `path` as is.
 *
 * @param path An absolute path, with an optional query (`"/ws?room=1"`).
 * @returns The WebSocket URL.
 * @throws {TypeError} When `path` does not start with a single `/`.
 * @example
 * ```ts
 * import { desktopWebSocketUrl } from "denext/desktop/client";
 *
 * const socket = new WebSocket(desktopWebSocketUrl("/api/events"));
 * ```
 */
export function desktopWebSocketUrl(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("desktopWebSocketUrl: the path must start with a single '/'");
  }
  const relay = desktopWsOrigin();
  if (relay) return relay + path;
  const loc = (globalThis as { location?: { protocol?: string; host?: string } }).location;
  if (!loc?.host) return path;
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${path}`;
}
