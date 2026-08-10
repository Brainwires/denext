// Build-time flags injected by esbuild `define` in src/build/next-compat.ts.
// Absent when running un-bundled (deno test / deno run); read only through
// src/runtime/class-flag.ts, which defaults it on in that case.

/** True when the class-component runtime is compiled in (see `classComponents` config). */
declare const __DENEXT_CLASS_COMPONENTS__: boolean;
