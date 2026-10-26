// The test files a change should run first: every changed test file, and every test file that
// imports a changed module directly (resolved import specifiers, not a name grep). Direct
// importers only — cheap enough for the pre-push precheck; the full suite stays in CI.
//
//   git diff --name-only origin/development... | deno run -A scripts/affected-tests.ts
//   deno run -A scripts/affected-tests.ts src/build/serial-child.ts tests/helpers/port.ts
//
// Prints one repo-relative path per line. e2e, migration-bed and fixture files are left out
// (they need a browser, a bed or are not tests).

import { dirname, fromFileUrl, join, normalize, relative } from "@std/path";
import { ALIASES, parallelSuiteFiles } from "./lib/serial-scan.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

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
 * The tests to run for `changed`: the changed test files themselves, then every test file whose
 * imports name a changed file, sorted.
 *
 * @param changed Repo-relative paths that changed.
 * @param tests Every test file and its source (`parallelSuiteFiles()` by default).
 */
export function affectedTests(
  changed: readonly string[],
  tests: ReadonlyMap<string, string>,
): string[] {
  const wanted = new Set(changed.map((p) => p.replaceAll("\\", "/")));
  const out = new Set<string>();
  for (const path of wanted) if (isTestFile(path) && tests.has(path)) out.add(path);
  for (const [path, src] of tests) {
    if (!isTestFile(path) || out.has(path)) continue;
    for (const spec of importSpecifiers(src)) {
      const target = resolveSpecifier(path, spec);
      if (target && wanted.has(target)) {
        out.add(path);
        break;
      }
    }
  }
  return [...out].sort();
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
