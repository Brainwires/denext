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
// scheme-agnostic (compat).

/** What {@link verifyOrigin} needs from the app config. */
export interface OriginCheckOptions {
  /** Extra origins (`https://app.example.com`) or bare hosts allowed to call. */
  allowedOrigins?: string[];
  /** The app's public origin; makes the own-host check scheme-strict. */
  canonicalOrigin?: string;
  /** Trust `x-forwarded-proto` to learn the public scheme (behind a trusted proxy only). */
  trustForwardedHeaders?: boolean;
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
  const u = originCandidate(request);
  if (!u) return false;

  const { fullOrigins, bareHosts } = allowedOriginSets(options);
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
 * The configured allowlist: `canonicalOrigin` + full-origin entries are scheme-strict;
 * a bare-host entry (no `/`) matches any scheme (compat). Malformed entries are ignored.
 *
 * @param options Allowlist / canonical origin.
 * @returns The scheme-strict origins and the scheme-agnostic hosts.
 */
function allowedOriginSets(
  options: OriginCheckOptions,
): { fullOrigins: Set<string>; bareHosts: Set<string> } {
  const fullOrigins = new Set<string>();
  const bareHosts = new Set<string>();
  if (options.canonicalOrigin) {
    try {
      fullOrigins.add(new URL(options.canonicalOrigin).origin);
    } catch { /* ignore malformed config */ }
  }
  for (const o of options.allowedOrigins ?? []) {
    try {
      fullOrigins.add(new URL(o).origin);
    } catch {
      if (o.length > 0 && !o.includes("/")) bareHosts.add(o);
    }
  }
  return { fullOrigins, bareHosts };
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
