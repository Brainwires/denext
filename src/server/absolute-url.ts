// Absolute-URL helpers: resolve the request's public origin so generated
// `og:image`/canonical URLs are absolute, as crawlers require.
//
// SECURITY: `X-Forwarded-Proto`/`X-Forwarded-Host` are attacker-controllable
// unless a trusted reverse proxy sets them, so they are **ignored by default**.
// A deployment behind a trusted proxy opts in with `trustForwardedHeaders`, or
// pins the origin outright with `canonicalOrigin` (which wins over any header).
// Without either, the standard `Host` header (then the request URL) is used.
//
// SECURITY (cache poisoning): even the plain `Host` header is client-controlled. An origin
// derived from it may only appear in a PER-REQUEST response — never in output a cache
// stores and replays to other visitors (ISR, `force-static`, a `cdnCacheHeaders`
// response). Cacheable output resolves against {@linkcode stableBaseUrl} instead
// (`canonicalOrigin`, else the page's `metadataBase`), and stays relative without one.

import { isProductionEnv } from "./session.ts";

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

/**
 * Resolve `path` against a STABLE base — `canonicalOrigin` first, else the page's
 * `metadataBase` — never against the request. This is the only resolver output that a
 * shared cache may store: a request's `Host` / `X-Forwarded-Host` is client-controlled,
 * so an origin taken from it and cached would be replayed to every later visitor (web
 * cache poisoning). Next.js likewise resolves file-convention metadata URLs against
 * `metadataBase`, never the request Host.
 *
 * @param path A root-relative path (`/opengraph-image`) or an absolute URL.
 * @param canonicalOrigin The configured public origin, if any.
 * @param metadataBase The page's `metadataBase`, if any.
 * @returns The absolute URL, or `null` when no stable base is configured (or it is invalid).
 */
export function stableBaseUrl(
  path: string,
  canonicalOrigin: string | undefined,
  metadataBase: string | URL | undefined,
): string | null {
  const base = canonicalOrigin ? stripTrailingSlash(canonicalOrigin) + "/" : metadataBase;
  if (!base) return null;
  try {
    return new URL(path, base).href;
  } catch {
    return null;
  }
}

let warnedNoStableOrigin = false;

/**
 * Warn once per process, in production, that output which may be cached wanted an
 * absolute URL but no stable origin is configured — so it was left relative (or, for a
 * per-request response, taken from the Host header and marked `no-store`) instead of
 * baking a client-supplied Host into a shared cache entry.
 *
 * @param what What needed the absolute URL (e.g. `"metadata"`).
 */
export function warnNoStableOrigin(what: string): void {
  if (warnedNoStableOrigin || !isProductionEnv()) return;
  warnedNoStableOrigin = true;
  console.warn(
    `denext: ${what} needs an absolute origin but neither \`canonicalOrigin\` ` +
      "(DENEXT_CANONICAL_ORIGIN) nor the page's `metadataBase` is set. A cacheable page keeps " +
      "og:image relative and omits hreflang / canonical links, and a per-request response " +
      "derives the origin from the Host header and is sent `no-store`, because an origin taken " +
      "from a request header must never reach a shared cache. Set `canonicalOrigin` " +
      '(e.g. "https://example.com") or `metadataBase`.',
  );
}
