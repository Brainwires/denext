// Absolute-URL helpers: resolve the request's public origin so generated
// `og:image`/canonical URLs are absolute, as crawlers require.
//
// SECURITY: `X-Forwarded-Proto`/`X-Forwarded-Host` are attacker-controllable
// unless a trusted reverse proxy sets them, so they are **ignored by default**.
// A deployment behind a trusted proxy opts in with `trustForwardedHeaders`, or
// pins the origin outright with `canonicalOrigin` (which wins over any header).
// Without either, the standard `Host` header (then the request URL) is used.

/** Options controlling how {@linkcode requestOrigin} resolves the public origin. */
export interface OriginOptions {
  /**
   * An explicit canonical origin (e.g. `"https://example.com"`) that overrides
   * all request-derived values. The most robust option — set it when the public
   * origin is known and fixed.
   */
  canonicalOrigin?: string;
  /**
   * Trust `X-Forwarded-Proto`/`X-Forwarded-Host` from the request. Enable this
   * ONLY when a trusted reverse proxy sets those headers; otherwise a client can
   * spoof the origin. Ignored when {@link canonicalOrigin} is set. Default false.
   */
  trustForwardedHeaders?: boolean;
}

/** Strip a single trailing slash so origins concatenate cleanly. */
function stripTrailingSlash(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

/**
 * The public origin (`scheme://host`) for `request`. Resolution order:
 * `canonicalOrigin` (if set) → forwarded headers (only when
 * `trustForwardedHeaders` is set) → the `Host` header → the request URL. Only
 * the first value of a comma-separated forwarded header is used.
 *
 * @param request The incoming request.
 * @param opts Origin-resolution options (defaults ignore forwarded headers).
 * @returns The origin, e.g. `https://example.com`.
 */
export function requestOrigin(request: Request, opts: OriginOptions = {}): string {
  if (opts.canonicalOrigin) return stripTrailingSlash(opts.canonicalOrigin);

  const url = new URL(request.url);
  const first = (name: string): string | null => {
    const v = request.headers.get(name);
    return v ? v.split(",")[0].trim() : null;
  };

  let proto = url.protocol.replace(/:$/, "");
  let host = request.headers.get("host") ?? url.host;
  if (opts.trustForwardedHeaders) {
    proto = first("x-forwarded-proto") ?? proto;
    host = first("x-forwarded-host") ?? host;
  }
  return `${proto}://${host}`;
}

/**
 * Resolve `path` against the request's public {@linkcode requestOrigin}. An
 * already-absolute URL is returned unchanged; a root-relative path is made
 * absolute against the origin.
 *
 * @param request The incoming request.
 * @param path A path (`/opengraph-image`) or absolute URL.
 * @param opts Origin-resolution options passed to {@link requestOrigin}.
 * @returns The absolute URL string.
 */
export function absoluteUrl(request: Request, path: string, opts: OriginOptions = {}): string {
  return new URL(path, requestOrigin(request, opts) + "/").href;
}
