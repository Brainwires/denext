/// <reference path="./globals.d.ts" />
/**
 * `denext/feature` — compile-time feature flags.
 *
 * Author a gated branch with {@linkcode feature}:
 *
 * ```ts
 * import { feature } from "denext/feature";
 * if (feature("NEW_CHECKOUT")) {
 *   // …only reaches the bundle when experimental.features.NEW_CHECKOUT is true
 * }
 * ```
 *
 * `feature()` always returns the configured value — the server and every client bundle are
 * seeded with `experimental.features`. At build time a `feature("KEY")` call with a
 * string-literal KEY is additionally FOLDED to `true`/`false` where the build can, so the
 * bundler dead-code-eliminates the untaken branch (the gated code, and anything only it
 * imports, costs zero bytes when off): the native App Router's component modules, the SPA
 * bundle, and dev. On the compat (drop-in) App Router path the call is read at runtime with
 * no DCE (it is seeded, so still correct).
 *
 * A call the fold can't resolve statically (a non-literal argument, or a key not listed
 * in config) stays a runtime call and returns the seeded value — `false` for any key not
 * in `experimental.features`. Server rendering and unbundled runs read the same seeded
 * map (see src/runtime/feature-flags.ts).
 *
 * @module
 */
import "./runtime/feature-flags.ts";

/**
 * Whether the feature flag `name` is enabled. A `feature("KEY")` call with a **string
 * literal** argument is folded to a boolean literal at build time (for a KEY listed in
 * `experimental.features`) so the branch is dead-code eliminated; otherwise it reads the
 * build-seeded flag map at runtime, defaulting to `false` for any unset flag.
 *
 * @param name The flag name, matching a key in `experimental.features`.
 */
export function feature(name: string): boolean {
  return __DENEXT_FEATURES__[name] === true;
}
