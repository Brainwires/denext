// The scan behind the serial-test list (tests/serial-tests.ts): which test files change
// process-wide state (`Deno.env.set` / `Deno.env.delete` / `Deno.chdir`, themselves, through a
// listed helper, or by running a src export listed in `SERIAL_SOURCES`, followed through the
// imports). tests/serial-tests.test.ts asserts the list against it; `deno task regen`
// (scripts/gen-serial-tests.ts) rewrites the list from it.

import { walk } from "@std/fs";
import { dirname, fromFileUrl, join, normalize, relative } from "@std/path";
import { SERIAL_HELPERS, SERIAL_SOURCES } from "../../tests/serial-tests.ts";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));

/** A change to process-wide state, as source text. */
export const MUTATES = /\bDeno\.(?:env\.(?:set|delete)|chdir)\s*\(/;

/** The `.ts` files under `dir` (repo-relative, `/`-separated) and their text. */
export async function sources(
  dir: string,
  skip: RegExp[] = [],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (
    const e of walk(join(ROOT, dir), { exts: [".ts", ".tsx"], includeDirs: false, skip })
  ) {
    const rel = relative(ROOT, e.path).replaceAll("\\", "/");
    out.set(rel, await Deno.readTextFile(e.path));
  }
  return out;
}

/** The test files under `tests/` that run in the parallel suites (not e2e / migration-bed). */
export function parallelSuiteFiles(): Promise<Map<string, string>> {
  return sources("tests", [/[/\\](?:e2e|migration-bed|fixtures)[/\\]/]);
}

/** The repo's own import-map aliases (`denext/server` → `src/server/mod.ts`). */
export const ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(
    (JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json"))) as {
      imports: Record<string, string>;
    }).imports,
  ).filter(([, to]) => to.startsWith("./")).map(([from, to]) => [from, to.slice(2)]),
);

/** Every static / dynamic import and re-export specifier in `src`. */
function specifiers(src: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
  return [...src.matchAll(re)].map((m) => m[1]);
}

/** `spec` imported from `from`, as a repo-relative path (`undefined`: outside the repo / npm). */
function resolveSpec(from: string, spec: string): string | undefined {
  if (spec.startsWith(".")) return normalize(join(dirname(from), spec)).replaceAll("\\", "/");
  return ALIASES[spec];
}

/** The repo modules `start` reaches through its imports (itself included). */
const reachCache = new Map<string, Set<string>>();
async function reaches(start: string): Promise<Set<string>> {
  const cached = reachCache.get(start);
  if (cached) return cached;
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    const text = await Deno.readTextFile(join(ROOT, file)).catch(() => undefined);
    if (text === undefined) continue;
    seen.add(file);
    for (const spec of specifiers(text)) {
      const to = resolveSpec(file, spec);
      if (to && !seen.has(to)) queue.push(to);
    }
  }
  reachCache.set(start, seen);
  return seen;
}

/** Whether the imports of `src` (the file at `path`) reach `target`. */
async function importsReach(path: string, src: string, target: string): Promise<boolean> {
  for (const spec of specifiers(src)) {
    const to = resolveSpec(path, spec);
    if (to && (await reaches(to)).has(target)) return true;
  }
  return false;
}

/** The names `src` imports, each with the repo module it imports it from. */
function namedImports(path: string, src: string): Array<[name: string, from: string]> {
  const out: Array<[string, string]> = [];
  const re = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const [, names, spec] of src.matchAll(re)) {
    const from = resolveSpec(path, spec);
    if (!from) continue;
    for (const part of names.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name) out.push([name, from]);
    }
  }
  return out;
}

/**
 * The `SERIAL_SOURCES` module `path` runs a mutating export of (an import of one of its listed
 * exports, from a module reaching it), or a mutating verb of (`.get("<verb>")!.run(` with the
 * module reached); `undefined` when none.
 */
export async function serialSourceRun(path: string, src: string): Promise<string | undefined> {
  const imports = namedImports(path, src);
  for (const [source, { exports, verbs = [] }] of Object.entries(SERIAL_SOURCES)) {
    for (const [name, from] of imports) {
      if (exports.includes(name) && (await reaches(from)).has(source)) return source;
    }
    const runsVerb = verbs.some((v) => new RegExp(`\\.get\\("${v}"\\)[!?]?\\.run\\(`).test(src));
    if (runsVerb && await importsReach(path, src, source)) {
      return source;
    }
  }
  return undefined;
}

/** Whether a test-side file changes process-wide state itself or through a src export. */
export async function mutates(path: string, src: string): Promise<boolean> {
  return MUTATES.test(src) || (await serialSourceRun(path, src)) !== undefined;
}

/** The test files that change process-wide state (the list SERIAL_TESTS must hold), sorted. */
export async function mutatingTestFiles(): Promise<string[]> {
  const files = await parallelSuiteFiles();
  const mutating: string[] = [];
  for (const [path, src] of files) {
    // The list's own test names the listed exports in its fixtures; it changes nothing.
    if (!path.endsWith(".test.ts") || path === "tests/serial-tests.test.ts") continue;
    const viaHelper = SERIAL_HELPERS.some((h) => src.includes(`/${h.split("/").pop()}"`));
    if (viaHelper || await mutates(path, src)) mutating.push(path);
  }
  return mutating.sort();
}
