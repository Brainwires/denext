// Build-time flags injected by esbuild `define` in src/build/next-compat.ts.
// Guard sites read the bare identifier directly (e.g. `if (__DENEXT_CLASS_COMPONENTS__)`)
// so esbuild's `define` folds the branch and dead-code-eliminates the class runtime
// when off. Absent when running un-bundled (deno test / deno run) — importing
// src/runtime/class-flag.ts (a side-effect module) installs a `globalThis` default
// (on) so the bare reads resolve. Any module referencing this must both
// `/// <reference path=".../globals.d.ts" />` and import class-flag for its side effect.

/** True when the class-component runtime is compiled in (see `classComponents` config). */
declare const __DENEXT_CLASS_COMPONENTS__: boolean;
