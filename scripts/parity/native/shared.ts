// Small helpers shared across the native parity scripts (capture / check / gaps /
// refresh), extracted so the four verbs don't carry copies of the same argument parse,
// expo-comparison setup, symbol count, npm install, and child-output parse.

import { extractDenextSurfacesFor } from "../extract-denext.ts";
import type { Baseline, Surface } from "../types.ts";
import { expoDenextTargets, type ExpoShims } from "./spec.ts";

/** The shared `-- / --offline / <target...>` CLI parse for the native parity verbs. */
export function parseNativeArgs(): { offline: boolean; only: string[] } {
  const args = Deno.args.filter((a) => a !== "--");
  return {
    offline: args.includes("--offline"),
    only: args.filter((a) => !a.startsWith("--")),
  };
}

/** Total exported-symbol count across a captured surface set (the refresh summary line). */
export function countSurfaceSymbols(surfaces: Surface[]): number {
  return surfaces.reduce((n, s) => n + Object.keys(s.symbols).length, 0);
}

/**
 * The real-vs-denext expo comparison inputs shared by the gate ({@link ./check.ts}) and
 * the gap writer ({@link ./gaps.ts}): a specifier→baseline-surface index and denext's
 * shim surfaces (extracted with `tolerateMissing`, so an unwritten shim reports empty).
 */
export async function expoParitySetup(
  root: string,
  baseline: Baseline,
  shims: ExpoShims,
): Promise<{ baseBySpec: Map<string, Surface>; denext: Surface[] }> {
  const baseBySpec = new Map(baseline.surfaces.map((s) => [s.specifier, s]));
  const denext = await extractDenextSurfacesFor(root, expoDenextTargets(shims), {
    tolerateMissing: true,
  });
  return { baseBySpec, denext };
}

/**
 * Install the given `dir`'s package.json into a `node_modules` and throw on failure.
 * `--legacy-peer-deps` keeps each package at its own requested version (a peer range
 * must not drag another package's version around; the extractor only reads each own
 * `.d.ts`). The install step is intentionally the same shape as the React harness's
 * (`scripts/parity/refresh.ts`); the two harnesses are kept independent by design.
 */
export async function npmInstall(dir: string): Promise<void> {
  // fallow-ignore-next-line code-duplication -- intentional mirror of the React harness (scripts/parity/refresh.ts); the two capture paths stay independent
  const install = await new Deno.Command("npm", {
    args: ["install", "--no-audit", "--no-fund", "--loglevel=error", "--legacy-peer-deps"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (install.code !== 0) {
    throw new Error(`npm install failed:\n${new TextDecoder().decode(install.stderr)}`);
  }
}

/**
 * Decode a `_real-runner.ts` child process's output and parse the JSON payload line it
 * prints (deno may print npm "Download/Initialize" lines first, so the last `{`-line is
 * taken). Mirrors the React harness's parse step by design — see {@link npmInstall}.
 */
export function parseExtractorOutput(
  code: number,
  stdout: Uint8Array,
  stderr: Uint8Array,
): unknown {
  // fallow-ignore-next-line code-duplication -- intentional mirror of the React harness (scripts/parity/refresh.ts); the two capture paths stay independent
  const err = new TextDecoder().decode(stderr);
  if (code !== 0) throw new Error(`real-surface extraction failed:\n${err}`);
  const text = new TextDecoder().decode(stdout).trim();
  const jsonLine = text.split("\n").filter((l) => l.startsWith("{")).at(-1)!;
  return JSON.parse(jsonLine);
}
