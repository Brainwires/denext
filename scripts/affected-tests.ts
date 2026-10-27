// The test files a change should run first: every changed test file, every test file that
// imports a changed module directly (resolved import specifiers, not a name grep), and the tests
// listed in INDIRECT_TESTS for a module whose rules other tests reach only through another module
// and their fixtures. Direct importers otherwise — cheap enough for the pre-push precheck; the full
// suite stays in CI.
//
//   git diff --name-only origin/development... | deno run -A scripts/affected-tests.ts
//   deno run -A scripts/affected-tests.ts src/build/serial-child.ts tests/helpers/port.ts
//
// Prints one repo-relative path per line. e2e, migration-bed and fixture files are left out
// (they need a browser, a bed or are not tests).

import { dirname, fromFileUrl, join, normalize, relative } from "@std/path";
import { ALIASES, parallelSuiteFiles } from "./lib/serial-scan.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/**
 * Tests a module's change must select although they do not import it: they reach its rules
 * through another module, with fixtures that depend on them. `src/build/deno-version.ts`'s version
 * schemes decide how the toolchain (src/build/deno-toolchain.ts, toolchain-prune.ts) reads the
 * `X.Y.Z-denext.N` / `3.0.0-rc.N` versions in those tests' fixtures; a change there broke five
 * deno-toolchain tests that no direct importer ran.
 */
export const INDIRECT_TESTS: Readonly<Record<string, readonly RegExp[]>> = {
  "src/build/deno-version.ts": [
    /^tests\/deno-toolchain(?:-[\w-]+)?\.test\.ts$/,
    /^tests\/toolchain-(?:audit|prune)\.test\.ts$/,
    /^tests\/esbuild-binary\.test\.ts$/,
  ],
};

/** Whether `path` is a test file the parallel suites run. */
export function isTestFile(path: string): boolean {
  return /^tests\/.*\.test\.ts$/.test(path) &&
    !/^tests\/(?:e2e|migration-bed)\//.test(path) && !/\/fixtures\//.test(path);
}

/** Every import / re-export / dynamic-import specifier in `src`, outside template strings. */
export function importSpecifiers(src: string): string[] {
  const code = src.replace(/`(?:\\.|[^`\\])*`/g, "``");
  const out: string[] = [];
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']|\bimport\s*\(\s*new URL\(\s*["']([^"']+)["']/gm;
  for (const m of code.matchAll(re)) out.push(m[1] ?? m[2]);
  return out;
}

/**
 * The repo-relative module `spec` names from `importer` (repo-relative), or null when it is not
 * one of this repo's files (a JSR / npm / URL import).
 */
export function resolveSpecifier(importer: string, spec: string): string | null {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return normalize(join(dirname(importer), spec)).replaceAll("\\", "/");
  }
  if (ALIASES[spec]) return ALIASES[spec];
  return null;
}

/**
 * The tests to run for `changed`: the changed test files themselves, every test file whose
 * imports name a changed file, and the {@linkcode INDIRECT_TESTS} of a changed module, sorted.
 *
 * @param changed Repo-relative paths that changed.
 * @param tests Every test file and its source (`parallelSuiteFiles()` by default).
 * @param indirect Tests selected by a module they do not import (default {@linkcode INDIRECT_TESTS}).
 */
export function affectedTests(
  changed: readonly string[],
  tests: ReadonlyMap<string, string>,
  indirect: Readonly<Record<string, readonly RegExp[]>> = INDIRECT_TESTS,
): string[] {
  const wanted = new Set(changed.map((p) => p.replaceAll("\\", "/")));
  const out = new Set<string>();
  for (const path of wanted) if (isTestFile(path) && tests.has(path)) out.add(path);
  const patterns = [...wanted].flatMap((p) => indirect[p] ?? []);
  for (const [path, src] of tests) {
    if (!isTestFile(path) || out.has(path)) continue;
    if (patterns.some((re) => re.test(path)) || importsAny(path, src, wanted)) out.add(path);
  }
  return [...out].sort();
}

/** Whether the test file `path` (source `src`) imports one of `modules`. */
function importsAny(path: string, src: string, modules: ReadonlySet<string>): boolean {
  return importSpecifiers(src).some((spec) => {
    const target = resolveSpecifier(path, spec);
    return target !== null && modules.has(target);
  });
}

/** The paths named on the command line, else read from stdin (one per line). */
async function inputPaths(): Promise<string[]> {
  if (Deno.args.length > 0) return [...Deno.args];
  const text = await new Response(Deno.stdin.readable).text();
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

if (import.meta.main) {
  const changed = (await inputPaths()).map((p) => relative(ROOT, join(ROOT, p)));
  for (const path of affectedTests(changed, await parallelSuiteFiles())) console.log(path);
}
