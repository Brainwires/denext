// Same-origin verification for state-changing RPC endpoints (Server Actions, the typed-API
// batch endpoint): the CSRF gate. Extracted from the action handler so every endpoint that
// replays the caller's cookies into server work applies the identical rule.
//
// Prefers the `Origin` header, falls back to `Referer`, and rejects when neither is present —
// a state-changing RPC defaults to deny. Full-origin allowlist entries (and `canonicalOrigin`)
// are matched scheme-strictly. For the request's own Host, the scheme is compared only when
// we can determine the site is HTTPS (via `canonicalOrigin`, a trusted `X-Forwarded-Proto`, or
// the request URL) — so an `http://host` origin is rejected for an HTTPS app, without breaking
// a TLS-terminating proxy where the scheme is unknown. Bare-host allowlist entries stay
// scheme-agnostic among the web schemes (compat). The host-based rules apply to `http(s)`
// origins only; a custom-scheme origin (a Deno Desktop window's `myapp://app`) is accepted only
// when the `Origin` header is byte-exactly the app's own `desktop.app.origin` or a listed
// custom-scheme entry. A browser cannot produce a custom-scheme origin from a web page, so this
// does not widen browser-borne CSRF.

import { parseDesktopAppOrigin } from "../desktop/app-origin.ts";

/** What {@link verifyOrigin} needs from the app config. */
export interface OriginCheckOptions {
  /** Extra origins (`https://app.example.com`) or bare hosts allowed to call. */
  allowedOrigins?: string[];
  /** The app's public origin; makes the own-host check scheme-strict. */
  canonicalOrigin?: string;
  /** Trust `x-forwarded-proto` to learn the public scheme (behind a trusted proxy only). */
  trustForwardedHeaders?: boolean;
  /**
   * The app's own Deno Desktop origin (`desktop.app.origin`, normalized: `myapp://app`). An
   * `Origin` header exactly equal to it is accepted.
   */
  desktopAppOrigin?: string;
}

/**
 * Is this request from the app's own origin (or an explicitly allowed one)?
 *
 * @param request The incoming request.
 * @param options Allowlist / canonical origin / proxy trust.
 * @returns True when the caller may perform a state-changing RPC.
 */
export function verifyOrigin(request: Request, options: OriginCheckOptions): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  const { fullOrigins, bareHosts, customOrigins } = allowedOriginSets(options);
  const rawOrigin = request.headers.get("origin");
  if (rawOrigin !== null && customOrigins.has(rawOrigin)) return true;
  const u = originCandidate(request);
  if (!u || !isWebOrigin(u)) return false;

  if (fullOrigins.has(u.origin)) return true;
  if (bareHosts.has(u.host)) return true;
  if (u.host === host) {
    // Own host: block an HTTP → HTTPS downgrade when we know the site is HTTPS.
    return !isKnownHttps(request, options) || u.protocol === "https:";
  }
  return false;
}

/**
 * The caller's claimed origin: the `Origin` header, else `Referer`, parsed; `null` when neither
 * is present or the value is not a URL (→ the caller must deny).
 *
 * @param request The incoming request.
 * @returns The parsed candidate, or `null`.
 */
export function originCandidate(request: Request): URL | null {
  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (!candidate) return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/**
 * A custom-scheme app origin (`myapp://app`), validated and normalized exactly as
 * `desktop.app.origin` is; `null` for anything else (an `http(s)` origin, a bare host, a
 * reserved scheme, a malformed value).
 *
 * @param entry The configured value.
 * @returns The normalized origin (`scheme://host`), or `null`.
 */
export function customSchemeOrigin(entry: string): string | null {
  const parsed = parseDesktopAppOrigin(entry);
  return parsed.ok ? parsed.value.origin : null;
}

/** Whether `u` is a web (`http:`/`https:`) URL — the only schemes the host-based rules match. */
function isWebOrigin(u: URL): boolean {
  return u.protocol === "http:" || u.protocol === "https:";
}

/**
 * The Live WebSocket handshake's strict same-origin gate: the `Origin` header is required and
 * must be an `http(s)` origin on the request's own `Host`, or byte-exactly the app's own
 * `desktop.app.origin` (a Deno Desktop window).
 *
 * @param request The upgrade request.
 * @param desktopAppOrigin The app's normalized `desktop.app.origin`, if configured.
 * @returns True when the upgrade may proceed.
 */
export function sameOriginUpgrade(request: Request, desktopAppOrigin?: string): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  if (desktopAppOrigin !== undefined && origin === desktopAppOrigin) return true;
  try {
    const u = new URL(origin);
    return isWebOrigin(u) && u.host === host;
  } catch {
    return false;
  }
}

/**
 * The configured allowlist: `canonicalOrigin` + full-origin entries are scheme-strict;
 * a bare-host entry (no `/`) matches any web scheme (compat); a custom-scheme entry and the
 * app's `desktopAppOrigin` match the raw `Origin` header byte-exactly (normalized). Malformed
 * entries are ignored.
 *
 * @param options Allowlist / canonical origin / desktop app origin.
 * @returns The scheme-strict origins, the scheme-agnostic hosts and the custom-scheme origins.
 */
function allowedOriginSets(options: OriginCheckOptions): OriginSets {
  const sets: OriginSets = {
    fullOrigins: new Set<string>(),
    bareHosts: new Set<string>(),
    customOrigins: new Set<string>(),
  };
  const canonical = options.canonicalOrigin ? webOrigin(options.canonicalOrigin) : null;
  if (canonical) sets.fullOrigins.add(canonical);
  const desktop = options.desktopAppOrigin ? customSchemeOrigin(options.desktopAppOrigin) : null;
  if (desktop) sets.customOrigins.add(desktop);
  for (const o of options.allowedOrigins ?? []) addAllowedOrigin(sets, o);
  return sets;
}

/** The allowlist {@link allowedOriginSets} builds. */
interface OriginSets {
  fullOrigins: Set<string>;
  bareHosts: Set<string>;
  customOrigins: Set<string>;
}

/** An `http(s)` URL's origin, or `null` for anything else (a non-web URL's origin is "null"). */
function webOrigin(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const u = new URL(value);
  return isWebOrigin(u) ? u.origin : null;
}

/**
 * File one `allowedOrigins` entry: a custom-scheme origin, an `http(s)` origin, else a bare host
 * (no `/`; a `host:port`, which parses as a `host:` scheme, included). Malformed → ignored.
 */
function addAllowedOrigin(sets: OriginSets, entry: string): void {
  const custom = customSchemeOrigin(entry);
  if (custom) return void sets.customOrigins.add(custom);
  const web = webOrigin(entry);
  if (web) sets.fullOrigins.add(web);
  else if (entry.length > 0 && !entry.includes("/")) sets.bareHosts.add(entry);
}

/**
 * Whether the site is known to be served over HTTPS (for CSRF downgrade rejection).
 *
 * SEC-L2 — behind a TLS-terminating proxy, `request.url` is the internal `http://` URL, so
 * this can't tell the public scheme is HTTPS on its own. Set `canonicalOrigin` (e.g.
 * `https://example.com`) or `trustForwardedHeaders: true` (only when the proxy sets
 * `x-forwarded-proto` and clients can't spoof it) so the HTTP→HTTPS downgrade check actually
 * engages. Without either, a proxied HTTPS site is treated as HTTP here and the downgrade
 * guard is a no-op.
 *
 * @param request The incoming request.
 * @param options Canonical origin / proxy trust.
 * @returns True when the public site is known to be HTTPS.
 */
function isKnownHttps(request: Request, options: OriginCheckOptions): boolean {
  if (options.canonicalOrigin) {
    try {
      return new URL(options.canonicalOrigin).protocol === "https:";
    } catch { /* ignore */ }
  }
  if (options.trustForwardedHeaders) {
    const xfp = request.headers.get("x-forwarded-proto");
    if (xfp) return xfp.split(",")[0].trim().toLowerCase() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}
