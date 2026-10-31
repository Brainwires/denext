// The framework version as a dependency-free module, for the CLI's startup path (`denext
// --version`, help): importing `mod.ts` for it would load the whole client and runtime surface.
// `deno task bump` writes it together with `mod.ts`'s `VERSION`; tests/cli-startup-graph.test.ts
// checks that the two agree.

/** The denext framework version (the same value as `VERSION` from `denext`). */
export const VERSION = "4.11.1";
