/**
 * Shared constants for `@denext/htmx`, in their own module so `mod.ts` and
 * `command.ts` can both use them without an initialization cycle.
 *
 * @module
 */

/**
 * The htmx version this package vendors and wraps. `@denext/htmx`'s own version
 * tracks this string, so `@denext/htmx@2.0.10` ships htmx 2.0.10.
 */
export const HTMX_VERSION = "2.0.10";

/**
 * SHA-256 (hex) of the exact vendored `vendor/htmx.min.js` bytes — the official htmx
 * {@link HTMX_VERSION} release (https://unpkg.com/htmx.org@2.0.10/dist/htmx.min.js).
 * The runtime ships as `script-src 'self'`, so a silent drift (bad merge, tampered
 * re-vendor) would run with full same-origin trust; `tests/htmx.test.ts` asserts the
 * vendored file still matches this hash to fail the build on any change.
 */
export const HTMX_INTEGRITY_SHA256 =
  "71ea67185bfa8c98c39d31717c6fce5d852370fcdfd129db4543774d3145c0de";

/** Byte length of the vendored runtime — a cheap first-line integrity check. */
export const HTMX_BYTE_SIZE = 51238;

/** Same-origin path the vendored htmx runtime is served from (before `basePath`). */
export const HTMX_RUNTIME_PATH = "/_denext/htmx/htmx.min.js";
