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
 *   `Origin` equal to the app origin; the app checks the same again.
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
 * Decide the desktop world from the runtime-published origin (`DENO_DESKTOP_APP_ORIGIN`) and the
 * configured one (`desktop.app.origin`). Pure, so it is testable without a runtime.
 *
 * - No published origin → `loopback` (the stock runtime). A configured origin is then not in
 *   effect, which is worth a warning.
 * - A published origin that does not parse → `refuse`.
 * - Otherwise `memory` at the PUBLISHED origin — the one the page really runs at and the one the
 *   runtime's WebSocket relay compares `Origin` against. A different configured origin (a stale
 *   `.deno-desktop/app.json`) is warned about.
 *
 * @param published The `DENO_DESKTOP_APP_ORIGIN` value, if any.
 * @param configured The configured `desktop.app.origin`, if any.
 * @returns The trust decision.
 */
export function resolveDesktopTrust(
  published: string | undefined,
  configured?: string,
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
 * The memory-world origin check shared by the gates: the request came over the memory transport,
 * and its `Origin`, if any, is exactly the app origin. `requireOrigin` additionally demands the
 * header (a WebSocket upgrade through the relay always carries one).
 *
 * @param trust The `memory` trust.
 * @param request The request.
 * @param info The serve handler info, when known.
 * @param requireOrigin Whether an `Origin` header is mandatory.
 * @returns `null` to proceed, else why it is refused (`"transport"` or `"origin"`).
 */
export function memoryGate(
  trust: { readonly origin: string },
  request: Request,
  info: DesktopServeInfo | undefined,
  requireOrigin = false,
): "transport" | "origin" | null {
  if (!isMemoryTransport(request, info)) return "transport";
  const origin = request.headers.get("origin");
  if (origin === null) return requireOrigin ? "origin" : null;
  return origin === trust.origin ? null : "origin";
}
