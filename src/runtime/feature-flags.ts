/// <reference path="../globals.d.ts" />
/**
 * Feature-flag build gate — the **un-bundled** runtime default.
 *
 * `denext/feature`'s `feature("KEY")` calls are folded to boolean literals at build
 * time (see src/build/feature-transform.ts), so a configured branch is dead-code
 * eliminated by both bundlers. Any call the fold leaves (an unconfigured key, a
 * non-literal argument, a module the fold didn't reach) falls back to the runtime
 * shim, which reads the bare `__DENEXT_FEATURES__` map.
 *
 * Un-bundled (dev before transform, `deno test`, `deno run`) no map exists, so
 * importing this module for its side effect installs an empty `globalThis` default
 * (every flag off) so the bare read resolves. The server seeds the real values from
 * `experimental.features` in `resolveProject` (src/build/paths.ts); the esbuild compat
 * paths seed it via `define`. In a folded/defined build this whole block becomes
 * `typeof {…} === "undefined"` → `false` and folds away.
 *
 * @module
 */

if (typeof __DENEXT_FEATURES__ === "undefined") {
  (globalThis as { __DENEXT_FEATURES__?: Record<string, boolean> }).__DENEXT_FEATURES__ = {};
}
