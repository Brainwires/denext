/**
 * Which desktop runtime is serving the app, and what a trusted request looks like in it — the
 * shared core of every token-gated `/_denext/desktop/*` gate (the capability bridge, the
 * auth-session endpoint, the boot beacon, the quit endpoint) and of the token-injection decision.
 *
 * Two worlds, decided ONCE at startup from what the runtime publishes ({@linkcode
 * resolveDesktopTrust}), never per request:
 *
 * - **`memory`** — the denext-pinned desktop runtime. It serves the page at a stable custom origin
 *   (`desktop.app.origin`, default `app://localhost`) through a webview scheme handler that feeds an
 *   in-process memory transport, and publishes that origin as `DENO_DESKTOP_APP_ORIGIN`. Every
 *   request reaches `Deno.serve` over the memory transport (`info.remoteAddr.transport ===
 *   "memory"` and an `http+memory:` request URL). Only the serve info is proof: the URL is NOT —
 *   an absolute-form request target over TCP (`POST http+memory://app/x HTTP/1.1`) makes Deno
 *   report exactly that URL — so a request is trusted only when `info` says memory (see
 *   {@linkcode isMemoryTransport}). Trust = the memory transport AND the per-launch token; an `Origin`, when present, must equal the app origin
 *   byte for byte, and a request without one is accepted only because it came over the memory
 *   transport. WebSocket upgrades arrive through the runtime's loopback relay, which admits only an
 *   `Origin` equal to the app origin; the app checks the same again. The runtime marks what it
 *   relays ({@linkcode isRelayConnection}); on such a request nothing but an upgrade with the exact
 *   `Origin` is accepted, and no per-launch token is ever injected.
 * - **`loopback`** — the stock Deno Desktop runtime (no memory transport, no published origin). The
 *   page runs at `http://127.0.0.1:<port>` and the gates keep their loopback rules: a loopback
 *   `Host` (the DNS-rebinding defence) and an `Origin` equal to `http://<Host>`.
 *
 * A published origin the runtime should never produce (unparseable) is **`refuse`**: every gate
 * fails closed and no token is injected.
 *
 * @module
 */

import { parseDesktopAppOrigin } from "./app-origin.ts";

/** The env var the denext-pinned runtime publishes the page origin in (`myapp://app`). */
export const DESKTOP_APP_ORIGIN_ENV = "DENO_DESKTOP_APP_ORIGIN";
/**
 * The env var the denext-pinned runtime publishes its WebSocket-only loopback relay in
 * (`ws://127.0.0.1:<port>`): the address the page dials for a WebSocket to its own server.
 */
export const DESKTOP_WS_ORIGIN_ENV = "DENO_DESKTOP_WS_ORIGIN";

/** The hosts the runtime's WebSocket relay may listen on (it binds loopback only). */
const RELAY_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The relay origin the page dials for a WebSocket to its own server (injected as
 * `globalThis.__denext.wsOrigin`), from the runtime-published `DENO_DESKTOP_WS_ORIGIN`: a `ws:`
 * origin on a loopback host with a port, nothing else. Anything else (unset, unparseable, a path,
 * a remote host) is `undefined`, so the page keeps dialing its own host. Pure.
 *
 * @param published The `DENO_DESKTOP_WS_ORIGIN` value, if any.
 * @returns The normalized origin (`ws://127.0.0.1:51234`), or `undefined`.
 */
export function resolveDesktopWsOrigin(published: string | undefined): string | undefined {
  if (!published) return undefined;
  let url: URL;
  try {
    url = new URL(published);
  } catch {
    return undefined;
  }
  if (url.protocol !== "ws:" || !RELAY_HOSTS.has(url.hostname) || url.port === "") return undefined;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return undefined;
  }
  return `ws://${url.host}`;
}

/** The desktop world the app runs in (see the module docs). */
export type DesktopTrust =
  | { readonly kind: "loopback" }
  | { readonly kind: "memory"; readonly origin: string }
  | { readonly kind: "refuse"; readonly reason: string };

/** The stock-runtime world: the default wherever no trust is passed. */
export const LOOPBACK_TRUST: DesktopTrust = Object.freeze({ kind: "loopback" });

/** What {@linkcode resolveDesktopTrust} decided, plus a startup warning worth printing. */
export interface DesktopTrustDecision {
  readonly trust: DesktopTrust;
  readonly warning?: string;
}

/**
 * The first denext Deno Desktop runtime that marks what its WebSocket relay forwards
 * ({@linkcode DESKTOP_RELAY_HEADER}); the memory world needs it or later.
 */
export const DESKTOP_RELAY_MARKING_RUNTIME = "2.9.7-denext.7";

/**
 * Whether the running desktop runtime marks relayed requests ({@linkcode DESKTOP_RELAY_HEADER}).
 * Feature-detected, never version-sniffed: `Deno.desktop.authSession.cancel` shipped in the same
 * runtime release as the marking ({@linkcode DESKTOP_RELAY_MARKING_RUNTIME}), and every runtime
 * that has the memory transport since has both. The stock runtime has neither (and no relay).
 *
 * @param desktop `Deno.desktop` (default: the running runtime's).
 * @returns Whether relayed requests carry the mark.
 */
export function runtimeMarksRelay(
  desktop: unknown = (Deno as unknown as { desktop?: unknown }).desktop,
): boolean {
  try {
    const session = (desktop as { authSession?: { cancel?: unknown } } | null | undefined)
      ?.authSession;
    return typeof session?.cancel === "function";
  } catch {
    return false;
  }
}

/**
 * Decide the desktop world from the runtime-published origin (`DENO_DESKTOP_APP_ORIGIN`) and the
 * configured one (`desktop.app.origin`). Pure given `marksRelay`, so it is testable without a
 * runtime.
 *
 * - No published origin → `loopback` (the stock runtime, which has no relay). A configured origin
 *   is then not in effect, which is worth a warning.
 * - A published origin that does not parse → `refuse`.
 * - A published origin from a runtime that does not mark relayed requests (a denext runtime
 *   older than {@linkcode DESKTOP_RELAY_MARKING_RUNTIME}, however it was supplied:
 *   `DENORT_DESKTOP_BIN` / `LAUFEY_DEV_DIR`, `DENEXT_DESKTOP_RUNTIME_DIR` or an old packaged
 *   build) → `refuse`: any local process could reach the app through its relay looking like the
 *   page, so no token is injected and every desktop endpoint is refused.
 * - Otherwise `memory` at the PUBLISHED origin — the one the page really runs at and the one the
 *   runtime's WebSocket relay compares `Origin` against. A different configured origin (a stale
 *   `.deno-desktop/app.json`) is warned about.
 *
 * @param published The `DENO_DESKTOP_APP_ORIGIN` value, if any.
 * @param configured The configured `desktop.app.origin`, if any.
 * @param marksRelay Whether the runtime marks relayed requests (default: detected from the
 *   running runtime, {@linkcode runtimeMarksRelay}).
 * @returns The trust decision.
 */
export function resolveDesktopTrust(
  published: string | undefined,
  configured?: string,
  marksRelay: boolean = runtimeMarksRelay(),
): DesktopTrustDecision {
  if (published === undefined || published === "") {
    return {
      trust: LOOPBACK_TRUST,
      ...(configured
        ? {
          warning: `desktop.app.origin "${configured}" is not in effect: this desktop runtime ` +
            "serves the app on a loopback port (the custom origin needs the denext-pinned " +
            "Deno Desktop runtime).",
        }
        : {}),
    };
  }
  const parsed = parseDesktopAppOrigin(published);
  if (!parsed.ok) {
    return {
      trust: {
        kind: "refuse",
        reason: `${DESKTOP_APP_ORIGIN_ENV} is not a valid app origin (${parsed.error})`,
      },
    };
  }
  if (!marksRelay) {
    return {
      trust: {
        kind: "refuse",
        reason: `this Deno Desktop runtime is older than ${DESKTOP_RELAY_MARKING_RUNTIME} (it ` +
          "does not mark requests from its WebSocket relay, so they can't be told from the " +
          "page's). Rebuild with the runtime denext pins (unset DENORT_DESKTOP_BIN, " +
          "LAUFEY_DEV_DIR and DENEXT_DESKTOP_RUNTIME_DIR), or set DENEXT_DESKTOP_RUNTIME=stock",
      },
    };
  }
  const origin = parsed.value.origin;
  const cfg = configured ? parseDesktopAppOrigin(configured) : undefined;
  const warning = cfg?.ok && cfg.value.origin !== origin
    ? `desktop.app.origin is "${cfg.value.origin}" but the runtime serves the app at "${origin}"` +
      " (a stale .deno-desktop/app.json? repackage the app)."
    : undefined;
  return { trust: { kind: "memory", origin }, ...(warning ? { warning } : {}) };
}

/**
 * The part of `Deno.ServeHandlerInfo` the gates read. Typed loosely because `transport: "memory"`
 * is not in the stock `Deno.NetAddr` type.
 */
export interface DesktopServeInfo {
  /** The peer address; `transport` is `"memory"` for the runtime's in-process transport. */
  readonly remoteAddr?: { readonly transport?: string };
}

/**
 * Whether `request` arrived over the runtime's in-process memory transport: the serve `info` says
 * `remoteAddr.transport === "memory"` AND the URL has the `http+memory:` scheme — both hold for
 * every real memory request. The info is REQUIRED (no info → `false`, fail closed): the URL alone
 * is spoofable over TCP with an absolute-form request target (`POST http+memory://app/x HTTP/1.1`
 * yields `request.url === "http+memory://app/x"` on a TCP listener), while `remoteAddr` comes from
 * the listener itself.
 *
 * @param request The request.
 * @param info The `Deno.serve` handler info.
 * @returns Whether it is a memory-transport request.
 */
export function isMemoryTransport(request: Request, info?: DesktopServeInfo): boolean {
  if (info?.remoteAddr?.transport !== "memory") return false;
  try {
    return new URL(request.url).protocol === "http+memory:";
  } catch {
    return false;
  }
}

/**
 * The request header the denext-pinned runtime sets on every request it forwards from its loopback
 * WebSocket relay into the memory transport, and strips from anything a client sends (through the
 * relay or the webview's scheme handler). A request that carries it came from SOME local process
 * that dialed the relay — not necessarily the app's page — so it is never treated like a page
 * request: only a WebSocket upgrade with the exact app `Origin` is accepted on it.
 */
export const DESKTOP_RELAY_HEADER = "x-deno-desktop-relay";

/**
 * Whether `request` came through the runtime's loopback WebSocket relay rather than the webview's
 * scheme handler — the ONE place the relay marking is read, so the contract with the runtime is
 * adjusted here alone. The header's presence is the mark, whatever its value (a client cannot
 * forge its ABSENCE: the runtime strips client copies and adds its own). Headers that cannot be
 * read count as relayed (fail closed).
 *
 * @param request The request.
 * @returns Whether it is relay-marked.
 */
export function isRelayConnection(request: Request): boolean {
  try {
    return request.headers.has(DESKTOP_RELAY_HEADER);
  } catch {
    return true;
  }
}

/** Whether `request` is a WebSocket upgrade (unreadable headers: not one). */
function isUpgradeRequest(request: Request): boolean {
  try {
    return request.headers.get("upgrade")?.toLowerCase() === "websocket";
  } catch {
    return false;
  }
}

/**
 * The memory-world origin check shared by the gates: the request came over the memory transport,
 * and its `Origin`, if any, is exactly the app origin. `requireOrigin` additionally demands the
 * header (a WebSocket upgrade through the relay always carries one). A relay-marked request
 * ({@linkcode isRelayConnection}) is held to more: it must be a WebSocket upgrade (`"relay"`
 * otherwise) and must carry the exact `Origin` — a missing one is never taken as same-origin there.
 *
 * @param trust The `memory` trust.
 * @param request The request.
 * @param info The serve handler info, when known.
 * @param requireOrigin Whether an `Origin` header is mandatory.
 * @returns `null` to proceed, else why it is refused (`"transport"`, `"relay"` or `"origin"`).
 */
export function memoryGate(
  trust: { readonly origin: string },
  request: Request,
  info: DesktopServeInfo | undefined,
  requireOrigin = false,
): "transport" | "relay" | "origin" | null {
  if (!isMemoryTransport(request, info)) return "transport";
  const relayed = isRelayConnection(request);
  if (relayed && !isUpgradeRequest(request)) return "relay";
  const origin = request.headers.get("origin");
  if (origin === null) return requireOrigin || relayed ? "origin" : null;
  return origin === trust.origin ? null : "origin";
}
