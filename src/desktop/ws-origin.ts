/**
 * Where a page's WebSocket to its own server goes. On the web (and under the stock Deno Desktop
 * runtime) that is `ws(s)://<location.host>`. Under denext's pinned Deno Desktop runtime the page
 * runs at a custom origin (`desktop.app.origin`, e.g. `myapp://app`) served over an in-process
 * transport that carries no WebSockets: they go through the runtime's loopback relay instead. The
 * runtime publishes the relay's URL, per-launch token included
 * (`ws://127.0.0.1:<port>/.deno-desktop-relay/<64 hex>`), and the desktop runtime injects it into
 * the page as `globalThis.__denext.wsUrl`. The page dials that URL with its own path appended
 * (`…/<token>/api/ws?x=1`); the relay checks the token and the exact app `Origin`, strips the
 * prefix, and `Deno.serve` sees `GET /api/ws?x=1`.
 *
 * Client-safe: web APIs only, nothing runs at import. Imported by denext's Live client and
 * re-exported from `denext/desktop/client`.
 *
 * @module
 */

/** The relay path the runtime requires: its prefix, then the per-launch token. */
const RELAY_PATH = /^\/\.deno-desktop-relay\/[0-9a-f]{64}$/;
/** The hosts the runtime's WebSocket relay may listen on (it binds loopback only). */
const RELAY_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The relay URL in `raw` when it is exactly what the runtime publishes: `ws:` on a loopback host
 * with a port, the path `/.deno-desktop-relay/<64 lowercase hex>`, and nothing else (no
 * credentials, query, fragment or trailing slash). Anything else is `undefined`. Pure.
 *
 * @param raw The candidate (`DENO_DESKTOP_WS_URL`, or the injected `__denext.wsUrl`).
 * @returns The normalized URL, or `undefined`.
 */
export function parseDesktopRelayUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "" || /[?#]/.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "ws:" || !RELAY_HOSTS.has(url.hostname) || url.port === "") return undefined;
  if (url.username || url.password || !RELAY_PATH.test(url.pathname)) return undefined;
  return `ws://${url.host}${url.pathname}`;
}

/** The injected global, read through a cast (JSR refuses a module that declares globals). */
function injectedWsUrl(): unknown {
  const g = (globalThis as { __denext?: { desktop?: unknown; wsUrl?: unknown } }).__denext;
  return typeof g === "object" && g !== null && g.desktop === true ? g.wsUrl : undefined;
}

/**
 * The pinned runtime's WebSocket relay URL (`ws://127.0.0.1:<port>/.deno-desktop-relay/<token>`)
 * when this page runs in a Deno Desktop window at a custom app origin, else `undefined` (the web,
 * mobile, the stock desktop runtime, SSR). It carries the relay's per-launch token: append a path
 * to it ({@linkcode desktopWebSocketUrl} does), and don't hand it to other code.
 *
 * @returns The relay URL, or `undefined`.
 * @example
 * ```ts
 * import { desktopWsUrl } from "denext/desktop/client";
 *
 * const relay = desktopWsUrl(); // "ws://127.0.0.1:51234/.deno-desktop-relay/<token>" in a window
 * ```
 */
export function desktopWsUrl(): string | undefined {
  return parseDesktopRelayUrl(injectedWsUrl());
}

/**
 * The URL for a WebSocket from this page to its own server at `path` (`"/api/socket"`, or a bare
 * query `"?room=1"` for `/`): the runtime's relay under denext's pinned Deno Desktop runtime
 * ({@linkcode desktopWsUrl}; the server then sees `GET <path>`), else `wss://` / `ws://` on the
 * page's own host. Off a page (no `location`) it returns the absolute path as is.
 *
 * @param path An absolute path with an optional query (`"/ws?room=1"`), or a query (`"?room=1"`).
 * @returns The WebSocket URL.
 * @throws {TypeError} When `path` starts with neither a single `/` nor `?`.
 * @example
 * ```ts
 * import { desktopWebSocketUrl } from "denext/desktop/client";
 *
 * const socket = new WebSocket(desktopWebSocketUrl("/api/events"));
 * ```
 */
export function desktopWebSocketUrl(path: string): string {
  if (
    typeof path !== "string" ||
    !((path.startsWith("/") && !path.startsWith("//")) || path.startsWith("?"))
  ) {
    throw new TypeError("desktopWebSocketUrl: the path must start with a single '/' or with '?'");
  }
  const relay = desktopWsUrl();
  if (relay) return relay + path;
  const absolute = path.startsWith("?") ? `/${path}` : path;
  const loc = (globalThis as { location?: { protocol?: string; host?: string } }).location;
  if (!loc?.host) return absolute;
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${absolute}`;
}
