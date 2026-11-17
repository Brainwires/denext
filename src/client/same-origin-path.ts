/**
 * The client half of `callbackUrl` coercion, shared by `signIn` / `signOut` and the
 * passkey helpers.
 *
 * @module
 */

/** C0 controls, space and DEL: the URL parser drops or trims them, so they are removed first. */
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000- \u007f]/g;

/**
 * Coerce a caller-supplied `callbackUrl` to a **same-origin path**, because these helpers
 * navigate to it: `signOut({ callbackUrl })` assigns it to `location.href`, and `signIn`
 * hands it to the server which reflects it back as a `Location`. A `callbackUrl` is
 * routinely read straight out of the current URL's query, so only a path on this origin is
 * kept: not a `javascript:` / `data:` value, a protocol-relative `//other.test/x` or an
 * absolute URL on another origin.
 *
 * Control characters and whitespace are stripped first (the URL parser ignores them, so
 * `/\t/other.test` would otherwise read as protocol-relative). An absolute URL on the page's
 * OWN origin keeps only its path + query + hash; anything else falls back. The server
 * coerces again (`sameOriginRedirect`) — this is the half that protects the purely
 * client-side navigation, which never reaches the server at all.
 *
 * @param requested The caller's `callbackUrl`, if any.
 * @param fallback Where to go when `requested` is absent or foreign.
 * @returns A same-origin path, always starting with a single `/`, or `fallback`.
 */
export function sameOriginPath<F extends string | undefined>(
  requested: string | undefined,
  fallback: F,
): string | F {
  const clean = requested?.replace(CONTROL_CHARS, "");
  if (!clean) return fallback;
  const origin = typeof location === "undefined" ? undefined : location.origin;
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) {
    // Absolute (or scheme-like: `javascript:`, `data:`) — admitted only on our own origin.
    try {
      const url = new URL(clean);
      if (origin && url.origin === origin) return url.pathname + url.search + url.hash;
    } catch { /* not a URL at all */ }
    return fallback;
  }
  // Protocol-relative (`//other.test/x`, `/\other.test/x`) is a foreign origin dressed as a
  // path; a value that is not rooted at all is not a path we are willing to guess at either.
  if (!clean.startsWith("/") || /^\/[/\\]/.test(clean)) return fallback;
  return clean;
}
