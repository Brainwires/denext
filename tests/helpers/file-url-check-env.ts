// The environment for a `deno check` child that type-checks a module importing denext's sources
// by absolute `file:` URL. Toolchain runtime 2.9.7-denext.22's native TypeScript 7 check can't
// resolve such an import (TS2307; see KNOWN-LIMITATIONS.md), so on that runtime the child runs the
// in-process TypeScript, which `DENEXT_NATIVE_CHECK=0` selects for denext's own verbs. On any other
// Deno (a runtime with the fix, stock Deno) the child keeps its default engine.

/** The runtimes whose native check misses absolute `file:` imports. */
const AFFECTED_RUNTIMES = new Set(["2.9.7-denext.22"]);

/**
 * The `env` for a `deno check` child that imports by absolute `file:` URL.
 *
 * @param version The Deno running the child (default: this process's).
 * @returns `{ DENO_CHECK_ENGINE: "tsc" }` on an affected runtime, else `{}`.
 */
export function fileUrlCheckEnv(version: string = Deno.version.deno): Record<string, string> {
  return AFFECTED_RUNTIMES.has(version) ? { DENO_CHECK_ENGINE: "tsc" } : {};
}
