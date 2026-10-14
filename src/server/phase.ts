// The build phase: `denext build` / `denext export` evaluate `denext.config.ts` (and every
// module it imports) to read routes and settings, but the app does not serve. Runtime secrets
// are usually absent there — a Docker `RUN deno task build` layer has no `.env` — so config
// helpers that refuse to boot without a secret (`denextAuth({ secret: Deno.env.get(…)! })`)
// relax those checks while the phase is set, and enforce them in full at `denext start` /
// `denext dev`. Set in the environment, so a worker or child process of the build sees it too.

import { envGet } from "../runtime/env-safe.ts";

/** The variable `denext build` / `denext export` set for the run (`DENEXT_PHASE=build`). */
const PHASE_ENV = "DENEXT_PHASE";

/**
 * The per-isolate flag (also set by {@linkcode markBuildPhase}): a test sets it on
 * `globalThis` instead of the environment, which every `--parallel` test module shares.
 */
const BUILD_PHASE = Symbol.for("denext.buildPhase");

/**
 * Whether this process is building (`denext build` / `denext export`), not serving.
 *
 * @returns `true` while `DENEXT_PHASE=build` (or the per-isolate flag is set).
 */
export function isBuildPhase(): boolean {
  return (globalThis as Record<symbol, unknown>)[BUILD_PHASE] === true ||
    envGet(PHASE_ENV) === "build";
}

/** Mark this process (and the processes it starts) as building. A read-only env is left alone. */
export function markBuildPhase(): void {
  (globalThis as Record<symbol, unknown>)[BUILD_PHASE] = true;
  try {
    Deno.env.set(PHASE_ENV, "build");
  } catch {
    // No env write permission: the checks stay strict.
  }
}
