// Published framework source carries no JSX syntax: no `.tsx`/`.jsx` under `src/`, beside
// `mod.ts`/`cli.ts`, or in any path a workspace package publishes.
//
// Why: at publish time JSR rewrites a package's `compilerOptions.jsxImportSource` into a per-file
// `@jsxImportSource` pragma resolved through the import map (Fresh on JSR ships
// `/** @jsxImportSource npm:preact@… */`). denext's own source is `"denext"` → `./mod.ts`, so a
// published `.tsx` would resolve `<mod.ts>/jsx-runtime` — `denext ui` run from
// `jsr:@denext/denext/cli` would break. Framework views are built with `h()` in `.ts` files.
//
// It also carries no `declare global`: JSR refuses a package whose module changes the global
// types ("modifying global types is not allowed"), and `deno publish --dry-run` does not catch it
// (2.10.0-rc.4's first publish failed on it). Read an injected global through a cast instead.

import { assertEquals } from "@std/assert";
import { globToRegExp, join } from "@std/path";

/** The repository root. */
const ROOT = new URL("../", import.meta.url).pathname;

/** A file in JSX syntax. */
const JSX_FILE = /\.[jt]sx$/;

/** The one-line reason, printed with every offender. */
const WHY = "no JSX syntax in published framework source — build views with h() in .ts files: " +
  "JSR rewrites compilerOptions.jsxImportSource into per-file @jsxImportSource pragmas " +
  '(denext\'s "denext" maps to ./mod.ts, so <mod.ts>/jsx-runtime would not resolve from jsr:)';

/** Directory names a package never publishes (its own tests, examples, installs). */
const NEVER_PUBLISHED: ReadonlySet<string> = new Set(["tests", "examples", "node_modules"]);

/** The part of a `deno.json` this test reads. */
interface PublishConfig {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

/** A `publish.exclude` list as a predicate over package-relative paths. */
function excluder(exclude: readonly string[] = []): (rel: string) => boolean {
  const entries = exclude.map((entry) => entry.replace(/^\.\//, "").replace(/\/+$/, ""));
  const globs = entries.map((entry) => globToRegExp(entry, { extended: true, globstar: true }));
  return (rel) =>
    entries.some((entry) => rel === entry || rel.startsWith(`${entry}/`)) ||
    globs.some((glob) => glob.test(rel));
}

/** Every file at or under `rel` (relative to `base`) that the package would publish. */
async function filesUnder(
  base: string,
  rel: string,
  excluded: (rel: string) => boolean,
): Promise<string[]> {
  const name = rel.split("/").pop() ?? rel;
  if (excluded(rel) || NEVER_PUBLISHED.has(name)) return [];
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(join(base, rel));
  } catch {
    return []; // an `include` entry that does not exist (yet) publishes nothing
  }
  if (!info.isDirectory) return [rel];
  const found: string[] = [];
  for await (const entry of Deno.readDir(join(base, rel))) {
    found.push(...await filesUnder(base, `${rel}/${entry.name}`, excluded));
  }
  return found;
}

/** A directory's `deno.json` `publish` block (empty when it has none). */
async function publishConfig(dir: string): Promise<PublishConfig> {
  const json = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
  return (json.publish ?? {}) as PublishConfig;
}

/** The root package: `src/` and every file beside `mod.ts`/`cli.ts`. */
async function rootFiles(): Promise<string[]> {
  const excluded = excluder((await publishConfig(ROOT)).exclude);
  const roots = ["src"];
  for await (const entry of Deno.readDir(ROOT)) if (entry.isFile) roots.push(entry.name);
  const found = await Promise.all(roots.map((rel) => filesUnder(ROOT, rel, excluded)));
  return found.flat();
}

/** Every workspace package's published paths (its `publish.include`, else the whole package). */
async function packageFiles(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(join(ROOT, "packages"))) {
    const dir = join(ROOT, "packages", entry.name);
    if (!entry.isDirectory) continue;
    const publish = await publishConfig(dir).catch((): PublishConfig => ({}));
    const excluded = excluder(publish.exclude);
    for (const rel of publish.include ?? ["."]) {
      const clean = rel.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
      const files = await filesUnder(dir, clean, excluded);
      found.push(...files.map((file) => `packages/${entry.name}/${file.replace(/^\.\//, "")}`));
    }
  }
  return found;
}

/** Every published file of the root package and the workspace packages, repo-relative. */
async function publishedFiles(): Promise<string[]> {
  return [...await rootFiles(), ...await packageFiles()].sort();
}

Deno.test("published framework source has no .tsx/.jsx files", async () => {
  const offenders = (await publishedFiles()).filter((file) => JSX_FILE.test(file));
  assertEquals(offenders, [], `${WHY}\n  ${offenders.join("\n  ")}`);
});

Deno.test("published framework source never declares global types", async () => {
  const offenders: string[] = [];
  for (const file of (await publishedFiles()).filter((f) => /\.[cm]?[jt]s$/.test(f))) {
    const text = await Deno.readTextFile(join(ROOT, file));
    if (/^\s*declare\s+global\b/m.test(text)) offenders.push(file);
  }
  assertEquals(
    offenders,
    [],
    "JSR refuses a published module that modifies the global types (`declare global`); " +
      `read the global through a cast instead:\n  ${offenders.join("\n  ")}`,
  );
});

Deno.test("the publish-set walk honours publish.exclude and never-published directories", () => {
  const excluded = excluder(["lib/", "./vendor", "**/*.gen.ts"]);
  assertEquals(
    ["lib", "lib/a.tsx", "vendor/x.tsx", "src/a.gen.ts", "src/view.ts", "library.ts"].map(
      excluded,
    ),
    [true, true, true, true, false, false],
  );
});
