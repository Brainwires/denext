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

/** Same-origin path the vendored htmx runtime is served from (before `basePath`). */
export const HTMX_RUNTIME_PATH = "/_denext/htmx/htmx.min.js";
