// The serial list stays true: every test file that changes process-wide state (`Deno.env.set` /
// `Deno.env.delete` / `Deno.chdir`, itself, through a listed helper, or by running a src export
// listed in `SERIAL_SOURCES`, followed through the imports) is in `tests/serial-tests.ts`, and every
// listed file still does; every src module that changes it is listed; and `scripts/test-run.ts`
// keeps the listed files out of the parallel pass.

import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { dirname, fromFileUrl, join, normalize, relative } from "@std/path";
import {
  SERIAL_HELPERS,
  SERIAL_SOURCE_EXEMPT,
  SERIAL_SOURCES,
  SERIAL_TESTS,
} from "./serial-tests.ts";
import { testPasses } from "../scripts/test-run.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** A change to process-wide state, as source text. */
const MUTATES = /\bDeno\.(?:env\.(?:set|delete)|chdir)\s*\(/;

/** The `.ts` files under `dir` (repo-relative, `/`-separated) and their text. */
async function sources(
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
function parallelSuiteFiles(): Promise<Map<string, string>> {
  return sources("tests", [/[/\\](?:e2e|migration-bed|fixtures)[/\\]/]);
}

/** The repo's own import-map aliases (`denext/server` → `src/server/mod.ts`). */
const ALIASES: Record<string, string> = Object.fromEntries(
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
async function serialSourceRun(path: string, src: string): Promise<string | undefined> {
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
async function mutates(path: string, src: string): Promise<boolean> {
  return MUTATES.test(src) || (await serialSourceRun(path, src)) !== undefined;
}

Deno.test("serial tests: each file that changes process-wide state is listed, and only those", async () => {
  const files = await parallelSuiteFiles();
  const helpers = new Set(SERIAL_HELPERS);
  const mutating: string[] = [];
  for (const [path, src] of files) {
    // This file's own fixtures name the listed exports; it changes nothing.
    if (!path.endsWith(".test.ts") || path === "tests/serial-tests.test.ts") continue;
    const viaHelper = SERIAL_HELPERS.some((h) => src.includes(`/${h.split("/").pop()}"`));
    if (viaHelper || await mutates(path, src)) mutating.push(path);
  }
  assertEquals(mutating.sort(), [...SERIAL_TESTS].sort());
  for (const h of helpers) assert(await mutates(h, files.get(h) ?? ""), `${h} no longer mutates`);
  // A helper (not a test) that starts mutating must be listed with the helpers.
  const unlisted: string[] = [];
  for (const [path, src] of files) {
    if (path.endsWith(".test.ts") || path === "tests/serial-tests.ts" || helpers.has(path)) {
      continue;
    }
    if (await mutates(path, src)) unlisted.push(path);
  }
  assertEquals(unlisted, []);
});

Deno.test("serial tests: every src module that changes process-wide state is listed", async () => {
  const src = await sources("src");
  const mutating = [...src].filter(([, text]) => MUTATES.test(text)).map(([p]) => p).sort();
  const listed = [...Object.keys(SERIAL_SOURCES), ...Object.keys(SERIAL_SOURCE_EXEMPT)].sort();
  assertEquals(mutating, listed);
  // Each listed export is still exported from its module.
  for (const [source, { exports }] of Object.entries(SERIAL_SOURCES)) {
    for (const name of exports) {
      const exported = new RegExp(
        `\\bexport\\s+(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`,
      );
      assert(exported.test(src.get(source)!), `${source} no longer exports ${name}`);
    }
  }
});

Deno.test("serial tests: a test is serial when it runs a listed src export or verb", async () => {
  const at = "tests/x.test.ts";
  // An import of the export, straight from its module or through a module that re-exports it.
  assertEquals(
    await serialSourceRun(at, `import { loadEnv } from "../src/server/env.ts";`),
    "src/server/env.ts",
  );
  assertEquals(
    await serialSourceRun(at, `import { loadEnv as l } from "denext/server";`),
    "src/server/env.ts",
  );
  // A verb run through the registry.
  assertEquals(
    await serialSourceRun(
      at,
      `import { buildRegistry } from "../src/cli/register.ts";\nbuildRegistry().get("analyze")!.run(c);`,
    ),
    "src/cli/commands/analyze.ts",
  );
  // A lookup without a run, a same-named import from elsewhere, or another export of the module
  // is not a run.
  assertEquals(
    await serialSourceRun(
      at,
      `import { buildRegistry } from "../src/cli/register.ts";\nbuildRegistry().get("dev");`,
    ),
    undefined,
  );
  assertEquals(
    await serialSourceRun(at, `import { loadEnv } from "../scripts/env.ts";`),
    undefined,
  );
  assertEquals(
    await serialSourceRun(at, `import { parseEnv } from "../src/server/env.ts";`),
    undefined,
  );
});

Deno.test("test-run: the serial files leave the parallel pass and run on their own", () => {
  const serial = ["tests/a.test.ts", "tests/integration/b.test.ts", "tests/e2e/c.test.ts"];
  const all = testPasses(["--ignore=tests/e2e/,tests/migration-bed/"], serial);
  assertEquals(all.parallel, [
    "test",
    "-A",
    "--unstable-kv",
    "--parallel",
    "--ignore=tests/e2e/,tests/migration-bed/,tests/a.test.ts,tests/integration/b.test.ts",
  ]);
  assertEquals(all.serial, [
    "test",
    "-A",
    "--unstable-kv",
    "tests/a.test.ts",
    "tests/integration/b.test.ts",
  ]);
  // A path narrows both passes; flags reach both.
  const integration = testPasses(["--fail-fast", "tests/integration/"], serial);
  assertEquals(integration.parallel, [
    "test",
    "-A",
    "--unstable-kv",
    "--fail-fast",
    "--parallel",
    "--ignore=tests/integration/b.test.ts",
    "tests/integration/",
  ]);
  assertEquals(integration.serial, [
    "test",
    "-A",
    "--unstable-kv",
    "--fail-fast",
    "tests/integration/b.test.ts",
  ]);
  assertEquals(testPasses(["tests/other/"], serial).serial, null);
});

Deno.test("test-run: a flag's separate value stays with its flag; `--` args reach both passes", () => {
  const serial = ["tests/a.test.ts"];
  const passes = testPasses(
    ["--filter", "foo bar", "-c", "deno.json", "--reporter=dot", "tests/", "--", "--x", "y"],
    serial,
  );
  assertEquals(passes.parallel, [
    "test",
    "-A",
    "--unstable-kv",
    "--filter",
    "foo bar",
    "-c",
    "deno.json",
    "--reporter=dot",
    "--parallel",
    "--ignore=tests/a.test.ts",
    "tests/",
    "--",
    "--x",
    "y",
  ]);
  assertEquals(passes.serial, [
    "test",
    "-A",
    "--unstable-kv",
    "--filter",
    "foo bar",
    "-c",
    "deno.json",
    "--reporter=dot",
    "tests/a.test.ts",
    "--",
    "--x",
    "y",
  ]);
  // `foo` was a value, not a path: with no path, every serial file is in scope.
  assertEquals(testPasses(["--filter", "foo"], serial).serial?.at(-1), "tests/a.test.ts");
});
