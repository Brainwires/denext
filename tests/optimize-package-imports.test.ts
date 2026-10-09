// `optimizePackageImports`: barrel analysis over synthetic packages, the import rewrite, and an
// end-to-end esbuild bundle proving the lucide-react startup-chunk explosion is gone.
//
// The e2e bundle reproduces the T3 Code bug: a `"sideEffects": false` icon package whose barrel
// re-exports every icon AND whose `dynamic` module `import()`s every icon (so each icon is a
// code-splitting entry). Importing one icon through the barrel leaves a bare
// `import "./chunk-<icon>.js"` for every icon in the entry chunk; with the rewrite it doesn't.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join, SEPARATOR } from "@std/path";
import * as esbuild from "esbuild";
import {
  analyzeBarrel,
  type AutoOptimizePackageImports,
  autoOptimizePackageImports,
  type BarrelExport,
  type BarrelResolvers,
  DEFAULT_OPTIMIZE_PACKAGE_IMPORTS,
  optimizePackageImportsList,
  packageMatcher,
  type RewriteContext,
  rewriteOptimizedImports,
  withOptimizedPackageImports,
} from "../src/build/optimize-package-imports.ts";
import {
  appResolverPlugin,
  BROWSER_CONDITIONS,
  catalogResolverPlugin,
  probeSourceFile,
  resolveNodeFrom,
  stopNextCompat,
  withPackageSideEffects,
} from "../src/build/next-compat.ts";
import { buildNextCompatClientEntries } from "../src/build/next-compat-build.ts";
import { validateDenextConfig, warnUnknownConfigKeys } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

const FIXTURES = fromFileUrl(new URL("./fixtures/optimize-package-imports/", import.meta.url));
const BARRELS = join(FIXTURES, "barrels");

const resolvers: BarrelResolvers = {
  resolveBare: (fromDir, spec) => resolveNodeFrom(fromDir, spec, BROWSER_CONDITIONS),
  probe: probeSourceFile,
};

/** `name → "file-basename:importName"` for compact assertions. */
async function analyze(dir: string): Promise<Record<string, string>> {
  const barrel = join(BARRELS, dir, "index.js");
  const map = await analyzeBarrel(barrel, resolvers);
  const out: Record<string, string> = {};
  for (const [name, where] of map) {
    const rel = where.file.slice(join(BARRELS, dir).length + 1).split(SEPARATOR).join("/");
    out[name] = `${rel}:${where.importName}`;
  }
  return out;
}

// --- Barrel analysis -------------------------------------------------------------------

Deno.test("analyzeBarrel: named, default-as, star, star-as, import-then-export forms", async () => {
  const map = await analyze("forms");
  assertEquals(map.a, "lib.js:a");
  assertEquals(map.c, "lib.js:b", "`b as c` imports `b`");
  assertEquals(map.D, "d.js:default");
  assertEquals(map.DIcon, "d.js:default");
  assertEquals(map.s1, "star.js:s1", "`export *` maps to the defining module");
  assertEquals(map.n1, "nested.js:n1", "a nested `export *` is followed");
  assertEquals(map.default, undefined, "`export *` never re-exports `default`");
  assertEquals(map.ns, "ns.js:*", "`export * as ns` is a namespace import");
  assertEquals(map.innerNs, "inner.js:*", "`import * as x` + `export { x as y }` maps through");
  assertEquals(map.fromImport, "lib.js:x");
  assertEquals(map.DefAgain, "d.js:default");
  assertEquals(map.oddName, "lib.js:odd-name", "string export names are kept verbatim");
  assertEquals(map.gone, "index.js:gone", "an unresolvable re-export stays on the barrel");
});

Deno.test("analyzeBarrel: names the barrel defines itself stay on the barrel", async () => {
  const map = await analyze("own-code");
  assertEquals(map.a, "lib.js:a", "a pure barrel's re-exports still map through");
  assertEquals(map.helper, "index.js:helper");
  assertEquals(map.K, "index.js:K");
  assertEquals(map.L, "index.js:L");
});

Deno.test("analyzeBarrel: a barrel that runs code maps every name to itself", async () => {
  assertEquals(await analyze("effectful"), { a: "index.js:a" });
  // A call in an initializer is code, too.
  const init = await analyze("effectful-init");
  assertEquals(init.a, "index.js:a");
  assertEquals(init.registry, "index.js:registry");
});

Deno.test("analyzeBarrel: a decorator is code that runs (class or member) — never looked through", async () => {
  assertEquals(await analyze("decorated"), { a: "index.js:a" });
  const member = await analyze("decorated-member");
  assertEquals(member.a, "index.js:a");
  assertEquals(member.Store, "index.js:Store");
});

Deno.test("analyzeBarrel: the parse is reused across builds until the file changes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_opi_cache_" });
  try {
    await Deno.writeTextFile(join(dir, "lib.js"), "export const a = 1;\n");
    await Deno.writeTextFile(join(dir, "index.js"), 'export { a } from "./lib.js";\n');
    const barrel = join(dir, "index.js");
    // A fresh resolvers object per call = a fresh build (dev rebuild).
    const build = () => analyzeBarrel(barrel, { ...resolvers });
    assertEquals((await build()).get("a")?.file, join(dir, "lib.js"));
    assertEquals((await build()).get("a")?.file, join(dir, "lib.js"), "unchanged: same answer");
    // An edit (new size + mtime) invalidates the cached parse.
    await Deno.writeTextFile(join(dir, "index.js"), 'export { a } from "./lib.js";\nrun();\n');
    await Deno.utime(barrel, new Date(), new Date(Date.now() + 5_000));
    assertEquals((await build()).get("a")?.file, barrel, "now effectful: the name stays");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('analyzeBarrel: a directive (`"use client"`) barrel is never looked through', async () => {
  assertEquals(await analyze("directive"), { a: "index.js:a" });
});

Deno.test("analyzeBarrel: an effectful module behind `export *` keeps its names", async () => {
  // mid.js runs code, so `leaf` is imported from mid.js (which still runs), not leaf.js.
  assertEquals(await analyze("effectful-star"), { leaf: "mid.js:leaf", own: "mid.js:own" });
});

Deno.test("analyzeBarrel: `export *` cycles terminate and keep every reachable name", async () => {
  assertEquals(await analyze("cycle"), { A: "a.js:A", B: "b.js:B" });
});

Deno.test("analyzeBarrel: a name two stars disagree on is dropped; an explicit one wins", async () => {
  const map = await analyze("ambiguous");
  assertEquals(map.dup, undefined, "ambiguous star exports are not exported at all");
  assertEquals(map.onlyP, "p.js:onlyP");
  assertEquals(map.onlyQ, "q.js:onlyQ");
  assertEquals(map.pickedDup, "p.js:dup");
});

Deno.test("analyzeBarrel: extensionless and directory re-exports resolve through the probe", async () => {
  const map = await analyze("extensionless");
  assertEquals(map.Alarm, "icons/Alarm.js:default");
  assertEquals(map.more, "more/index.js:more");
});

Deno.test("analyzeBarrel: an unreadable barrel yields an empty map", async () => {
  assertEquals((await analyzeBarrel(join(BARRELS, "nope.js"), resolvers)).size, 0);
});

// --- The rewrite -----------------------------------------------------------------------

const BARREL = "/nm/pkg/index.js";

/** A rewrite context over an in-memory export map (no filesystem). */
function fakeContext(
  exports: Record<string, BarrelExport>,
  packages: string[] = ["pkg"],
): RewriteContext {
  return {
    matcher: packageMatcher(packages),
    resolveBarrel: (_dir, spec) => Promise.resolve(spec.startsWith("pkg") ? BARREL : null),
    exportsOf: () => Promise.resolve(new Map(Object.entries(exports))),
  };
}

const EXPORTS: Record<string, BarrelExport> = {
  Check: { file: "/nm/pkg/icons/check.js", importName: "default" },
  CheckIcon: { file: "/nm/pkg/icons/check.js", importName: "default" },
  X: { file: "/nm/pkg/icons/x.js", importName: "default" },
  util: { file: "/nm/pkg/util.js", importName: "helper" },
  icons: { file: "/nm/pkg/icons/index.js", importName: "*" },
  Own: { file: BARREL, importName: "Own" },
};

const rewrite = (src: string, exports = EXPORTS, packages?: string[]) =>
  rewriteOptimizedImports(src, "/app/src/main.tsx", fakeContext(exports, packages));

Deno.test("rewrite: named imports go to their defining modules, aliases kept", async () => {
  const out = await rewrite(
    `import { Check, X as Close, util } from "pkg";\nuse(Check, Close, util);\n`,
  );
  assertEquals(
    out,
    `import { default as Check } from "/nm/pkg/icons/check.js"; ` +
      `import { default as Close } from "/nm/pkg/icons/x.js"; ` +
      `import { helper as util } from "/nm/pkg/util.js";\nuse(Check, Close, util);\n`,
  );
});

Deno.test("rewrite: several names from one module share one import", async () => {
  const out = await rewrite(`import { Check, CheckIcon } from "pkg";`);
  assertEquals(
    out,
    `import { default as Check, default as CheckIcon } from "/nm/pkg/icons/check.js";`,
  );
});

Deno.test("rewrite: a namespace re-export becomes `import * as`", async () => {
  assertEquals(
    await rewrite(`import { icons } from "pkg";`),
    `import * as icons from "/nm/pkg/icons/index.js";`,
  );
});

Deno.test("rewrite: unmapped and barrel-defined names stay on the original specifier", async () => {
  const out = await rewrite(`import { Check, Own, Unknown as U } from 'pkg';`);
  assertEquals(
    out,
    `import { Own, Unknown as U } from "pkg"; import { default as Check } from "/nm/pkg/icons/check.js";`,
  );
});

Deno.test("rewrite: type-only specifiers are never rewritten (and become `import type`)", async () => {
  assertEquals(await rewrite(`import type { Check } from "pkg";`), null);
  assertEquals(await rewrite(`import { type Check } from "pkg";`), null, "no value names");
  const out = await rewrite(`import { type CheckIcon, X } from "pkg";`);
  assertEquals(
    out,
    `import type { CheckIcon } from "pkg"; import { default as X } from "/nm/pkg/icons/x.js";`,
  );
});

Deno.test("rewrite: default, namespace, re-export and dynamic forms are untouched", async () => {
  assertEquals(await rewrite(`import * as all from "pkg";`), null);
  assertEquals(await rewrite(`import Pkg from "pkg";`), null);
  assertEquals(await rewrite(`export { Check } from "pkg";`), null);
  assertEquals(await rewrite(`export * from "pkg";`), null);
  assertEquals(await rewrite(`const m = await import("pkg");`), null);
  assertEquals(await rewrite(`import "pkg";`), null);
  // A default import alongside named ones keeps the default on the barrel.
  assertEquals(
    await rewrite(`import Pkg, { X } from "pkg";`),
    `import Pkg from "pkg"; import { default as X } from "/nm/pkg/icons/x.js";`,
  );
});

Deno.test("rewrite: only listed packages, exact or `/*` subpaths, are touched", async () => {
  assertEquals(await rewrite(`import { Check } from "pkg-other";`), null);
  assertEquals(await rewrite(`import { Check } from "other";`), null);
  assertEquals(await rewrite(`import { Check } from "pkg/sub";`), null, "no wildcard entry");
  const sub = await rewrite(`import { X } from "pkg/sub";`, EXPORTS, ["pkg/*"]);
  assertEquals(sub, `import { default as X } from "/nm/pkg/icons/x.js";`);
});

Deno.test("rewrite: the module keeps its line count and the rest of its text", async () => {
  const src =
    `"use client";\n// ✓ multi-byte\nimport {\n  Check,\n  X,\n} from "pkg";\nexport const n = 1;\n`;
  const out = (await rewrite(src))!;
  assertStringIncludes(out, `"use client";\n// ✓ multi-byte\n`);
  assertStringIncludes(out, `export const n = 1;\n`);
  // One line replaced a four-line import, padded with the three newlines it spanned: every
  // line after it keeps its number (sourcemaps, stack traces).
  assertEquals(out.split("\n").length, src.split("\n").length);
  const lineOf = (text: string, needle: string) =>
    text.split("\n").findIndex((l) => l.includes(needle));
  assertEquals(lineOf(out, "export const n"), lineOf(src, "export const n"));
});

Deno.test("rewrite: a multi-line import does not shift a later stack-trace line", async () => {
  const src = `import {\n  Check,\n  X,\n} from "pkg";\nthrow new Error("line5");\n`;
  const out = (await rewrite(src))!;
  assertEquals(out.split("\n")[4], `throw new Error("line5");`);
  assertEquals(out.split("\n").length, src.split("\n").length);
});

Deno.test("rewrite: a decorated app module still has its imports rewritten", async () => {
  const src = `import { Check } from "pkg";\n@sealed\nclass A {}\nuse(Check, A);\n`;
  const out = (await rewrite(src))!;
  assertStringIncludes(out, `from "/nm/pkg/icons/check.js"`);
  assertStringIncludes(out, "@sealed\nclass A {}");
});

Deno.test("rewrite: an unparseable module is left exactly as written", async () => {
  assertEquals(await rewrite(`import { Check } from "pkg";\nconst = ;`), null);
});

Deno.test("packageMatcher: pre-filter needs a static `from` of a listed package", () => {
  const m = packageMatcher(["lucide-react", "react-icons/*"]);
  assert(m.mentions(`import { A } from "lucide-react"`));
  assert(m.mentions(`import{A}from'lucide-react'`));
  assert(m.mentions(`import { FaX } from "react-icons/fa"`));
  assert(!m.mentions(`const s = "lucide-react";`));
  assert(!m.mentions(`import { FaX } from "react-icons"`));
  assert(m.matches("react-icons/fa6") && !m.matches("react-icons"));
  assert(!packageMatcher([]).mentions(`import { A } from "lucide-react"`));
});

// --- Config ----------------------------------------------------------------------------

Deno.test("optimizePackageImportsList: defaults ∪ configured, the legacy spelling honored", () => {
  assertEquals(optimizePackageImportsList(undefined), [...DEFAULT_OPTIMIZE_PACKAGE_IMPORTS]);
  assert(DEFAULT_OPTIMIZE_PACKAGE_IMPORTS.includes("lucide-react"));
  const top = optimizePackageImportsList({ optimizePackageImports: ["my-icons", "lucide-react"] });
  assertEquals(top.filter((p) => p === "lucide-react").length, 1, "de-duplicated");
  assert(top.includes("my-icons"));
  const legacy = optimizePackageImportsList({
    experimental: { optimizePackageImports: ["old-icons"] },
  });
  assert(legacy.includes("old-icons"));
  const both = optimizePackageImportsList({
    optimizePackageImports: ["new"],
    experimental: { optimizePackageImports: ["old"] },
  });
  assert(both.includes("new") && !both.includes("old"), "the top-level field wins");
});

Deno.test("optimizePackageImportsList: `false` disables everything; `!pkg` removes an entry", () => {
  assertEquals(optimizePackageImportsList({ optimizePackageImports: false }), []);
  assertEquals(
    optimizePackageImportsList({
      optimizePackageImports: false,
      experimental: { optimizePackageImports: ["old"] },
    }),
    [],
    "top-level false wins over the legacy spelling",
  );
  const list = optimizePackageImportsList({
    optimizePackageImports: ["!recharts", "!react-icons/*", "my-icons", "!not-listed"],
  });
  assert(!list.includes("recharts") && !list.includes("react-icons/*"));
  assert(list.includes("lucide-react") && list.includes("my-icons"));
  assert(!list.some((p) => p.startsWith("!")), "exclusions never reach the matcher");
  // An exclusion also removes a package the list itself added.
  assertEquals(
    optimizePackageImportsList({ optimizePackageImports: ["x", "!x"] }).includes("x"),
    false,
  );
});

Deno.test("config: optimizePackageImports is validated and the Next spelling dev-warns", () => {
  validateDenextConfig({ optimizePackageImports: ["a", "b/*", "!lucide-react"] });
  validateDenextConfig({ optimizePackageImports: false });
  for (const bad of [true, ["!"], [""]]) {
    let msg = "";
    try {
      validateDenextConfig({ optimizePackageImports: bad } as unknown as DenextConfig);
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "`optimizePackageImports` must be", JSON.stringify(bad));
  }
  let legacyFalse = "";
  try {
    validateDenextConfig({
      experimental: { optimizePackageImports: false },
    } as unknown as DenextConfig);
  } catch (e) {
    legacyFalse = (e as Error).message;
  }
  assertStringIncludes(
    legacyFalse,
    "`experimental.optimizePackageImports`",
    "only top-level takes false",
  );
  let threw = "";
  try {
    validateDenextConfig({ optimizePackageImports: [1] } as unknown as DenextConfig);
  } catch (e) {
    threw = (e as Error).message;
  }
  assertStringIncludes(threw, "`optimizePackageImports` must be an array of package names");
  try {
    validateDenextConfig({
      experimental: { optimizePackageImports: "lucide-react" },
    } as unknown as DenextConfig);
    threw = "";
  } catch (e) {
    threw = (e as Error).message;
  }
  assertStringIncludes(threw, "`experimental.optimizePackageImports`");

  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg: string) => void warnings.push(msg);
  try {
    warnUnknownConfigKeys({
      optimizePackageImports: [],
      experimental: { optimizePackageImports: [] },
    });
  } finally {
    console.warn = orig;
  }
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assertStringIncludes(warnings[0], "is still honored for now but has moved");
});

// --- End to end: the lucide startup-chunk explosion --------------------------------------

/** A temp app with the fake icon package installed, importing one icon + the dynamic map. */
async function scaffoldApp(): Promise<{ dir: string; entry: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_opi_" });
  await copy(join(FIXTURES, "fake-icons"), join(dir, "node_modules", "fake-icons"));
  await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
  const entry = join(dir, "main.js");
  await Deno.writeTextFile(
    entry,
    `import { Icon3 } from "fake-icons";\n` +
      `import dynamicIconImports from "fake-icons/dynamic.mjs";\n` +
      `console.log(Icon3(), Object.keys(dynamicIconImports).length);\n`,
  );
  return { dir, entry };
}

/** Bundle the app code-split; return the entry chunk's bare chunk imports + all outputs. */
async function bundleApp(optimize: boolean): Promise<{ bare: string[]; files: string[] }> {
  const { dir, entry } = await scaffoldApp();
  try {
    const chain = [appResolverPlugin(join(dir, "deno.json")), catalogResolverPlugin(dir, "all")];
    const plugins = optimize
      ? withOptimizedPackageImports(chain, {
        packages: optimizePackageImportsList({ optimizePackageImports: ["fake-icons"] }),
        resolvers,
      })
      : chain;
    const result = await esbuild.build({
      entryPoints: { main: entry },
      bundle: true,
      splitting: true,
      format: "esm",
      write: false,
      outdir: join(dir, "out"),
      treeShaking: true,
      logLevel: "silent",
      plugins,
    });
    const main = result.outputFiles!.find((f) => /[\\/]main\.js$/.test(f.path))!;
    const text = new TextDecoder().decode(main.contents);
    return {
      bare: [...text.matchAll(/^import\s*"\.\/(chunk-[^"]+\.js)";/gm)].map((m) => m[1]),
      files: result.outputFiles!.map((f) => f.path.slice(dir.length)),
    };
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("e2e: without the rewrite, every dynamically-split icon is a bare startup import", async () => {
  // Pins the bug the option exists for: if esbuild ever stops doing this, the test says so.
  const { bare } = await bundleApp(false);
  assert(bare.length >= 12, `expected a bare import per icon, got ${bare.length}`);
});

Deno.test("e2e: with the rewrite, the entry chunk no longer pulls every icon chunk", async () => {
  const { bare, files } = await bundleApp(true);
  assert(bare.length <= 2, `expected at most a couple of bare imports, got ${bare.length}`);
  // Every icon is still its own lazily-loaded chunk for `dynamicIconImports`.
  assert(files.filter((f) => /[\\/]icon-\d+-/.test(f)).length >= 12, files.join("\n"));
});

Deno.test("e2e: the rewritten icon and the dynamic import are ONE module (no duplicate copy)", async () => {
  const { dir, entry } = await scaffoldApp();
  try {
    const result = await esbuild.build({
      entryPoints: { main: entry },
      bundle: true,
      splitting: true,
      format: "esm",
      write: false,
      outdir: join(dir, "out"),
      metafile: true,
      logLevel: "silent",
      plugins: withOptimizedPackageImports(
        [appResolverPlugin(join(dir, "deno.json")), catalogResolverPlugin(dir, "all")],
        { packages: ["fake-icons"], resolvers },
      ),
    });
    const icon3 = Object.keys(result.metafile!.inputs).filter((p) => p.endsWith("icons/icon-3.js"));
    assertEquals(icon3.length, 1, `icon-3.js entered the graph as: ${icon3.join(", ")}`);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("e2e: the real compat client bundler applies the option (TS app source, deno-loader)", async () => {
  // Through buildNextCompatClientEntries: the whole compat plugin chain, the app module loaded
  // as TSX (a type-only specifier alongside), the node_modules resolver under `nodeResolve`.
  const { dir } = await scaffoldApp();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: {} }));
    const app = join(dir, "app.tsx");
    await Deno.writeTextFile(
      app,
      `import { Icon3, type IconProps } from "fake-icons";\n` +
        `import dynamicIconImports from "fake-icons/dynamic.mjs";\n` +
        `export const x: [string, unknown, IconProps?] = [Icon3(), dynamicIconImports];\n`,
    );
    const bare = async (packages: string[]) => {
      const clientDir = join(dir, `client-${packages.length}`);
      await buildNextCompatClientEntries({
        projectDir: dir,
        configPath: join(dir, "deno.json"),
        outDir: join(dir, ".denext"),
        clientDir,
        entries: [{
          id: "index",
          source: `import { x } from ${JSON.stringify(app)};\nconsole.log(x);\n`,
        }],
        resolveAllNodeModules: true,
        optimizePackageImports: packages,
      });
      const main = await Deno.readTextFile(join(clientDir, "index.js"));
      return [...main.matchAll(/^import\s*"\.\//gm)].length;
    };
    assert((await bare([])) >= 12, "the unoptimized build shows the bug");
    assert((await bare(["fake-icons"])) <= 2, "the optimized build does not");
  } finally {
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Automatic barrels: shared-barrel lazy routes ----------------------------------------
//
// The T3 Code case (`@pierre/diffs`, `@pierre/trees`, `@base-ui/react`): the startup graph and a
// lazily loaded route import different names from one `"sideEffects": false` barrel. esbuild's
// code splitting then puts EVERY module the barrel re-exports into a chunk the startup graph
// loads, the lazy route's modules included (plain esbuild 0.24–0.28 does this). Looking through
// the barrel automatically keeps each defining module with the code that imports it.

/** A static `import … from "./chunk.js"` / `import "./chunk.js"` (never a dynamic `import()`). */
const STATIC_CHUNK_IMPORT = /\bimport\s*(?:[^;"'()]*?\bfrom\s*)?["']\.\/([^"']+)["']/g;

/** The package's three modules, each with a marker string the output is searched for. */
const SHARED_MODULES: Record<string, string> = {
  "index.js":
    `export { a } from "./a.js";\nexport { b } from "./b.js";\nexport { c } from "./c.js";\n`,
  "a.js": `export function a() { return "BODY_A"; }\n`,
  "b.js": `export function b() { return "BODY_B"; }\n`,
  "c.js": `export function c() { return "BODY_C"; }\nglobalThis.__sharedC = "SIDE_C";\n`,
};

/** A temp app: `main.js` imports `a` from the barrel and lazy-loads `route.js`, which imports `b`. */
async function sharedBarrelApp(pkgJson: Record<string, unknown>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_opi_auto_" });
  const pkgDir = join(dir, "node_modules", "shared-barrel");
  await Deno.mkdir(pkgDir, { recursive: true });
  await Deno.writeTextFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "shared-barrel", type: "module", main: "index.js", ...pkgJson }),
  );
  for (const [name, text] of Object.entries(SHARED_MODULES)) {
    await Deno.writeTextFile(join(pkgDir, name), text);
  }
  await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
  await Deno.writeTextFile(
    join(dir, "main.js"),
    `import { a } from "shared-barrel";\nconsole.log(a());\n` +
      `import("./route.js").then((m) => m.run());\n`,
  );
  await Deno.writeTextFile(
    join(dir, "route.js"),
    `import { b } from "shared-barrel";\nexport function run() { return b(); }\n`,
  );
  return dir;
}

const autoResolvers: BarrelResolvers = {
  ...resolvers,
  sideEffectFree: async (file) => (await withPackageSideEffects(file)).sideEffects === false,
};

interface SplitResult {
  /** The text of the entry chunk plus every chunk it statically imports (transitively). */
  startup: string;
  /** Every output file's text. */
  all: string;
  /** How many times `b.js` entered the module graph. */
  bCopies: number;
}

/** Bundle the app code-split, optionally behind an earlier plugin, and split startup from lazy. */
async function bundleShared(
  dir: string,
  opts: { auto?: { exclude: string[] } | null; lead?: esbuild.Plugin[] },
): Promise<SplitResult> {
  const chain = [
    ...(opts.lead ?? []),
    appResolverPlugin(join(dir, "deno.json")),
    catalogResolverPlugin(dir, "all"),
  ];
  const plugins = opts.auto
    ? withOptimizedPackageImports(chain, {
      packages: [],
      resolvers: autoResolvers,
      auto: opts.auto,
    })
    : chain;
  try {
    const result = await esbuild.build({
      entryPoints: { main: join(dir, "main.js") },
      bundle: true,
      splitting: true,
      format: "esm",
      write: false,
      outdir: join(dir, "out"),
      metafile: true,
      logLevel: "silent",
      plugins,
    });
    const byName = new Map(
      result.outputFiles!.map((f) => [f.path.slice(f.path.lastIndexOf("/") + 1), f.text]),
    );
    const seen = new Set<string>();
    const walk = (name: string) => {
      if (seen.has(name) || !byName.has(name)) return;
      seen.add(name);
      for (const m of byName.get(name)!.matchAll(STATIC_CHUNK_IMPORT)) {
        walk(m[1]);
      }
    };
    walk("main.js");
    return {
      startup: [...seen].map((n) => byName.get(n)).join("\n"),
      all: [...byName.values()].join("\n"),
      bCopies: Object.keys(result.metafile!.inputs).filter((p) => p.endsWith("shared-barrel/b.js"))
        .length,
    };
  } finally {
    await esbuild.stop();
  }
}

Deno.test("auto barrels: without them, the lazy route's module is in the startup graph", async () => {
  // Pins the esbuild behaviour the automatic look-through exists for.
  const dir = await sharedBarrelApp({ sideEffects: false });
  try {
    const { startup } = await bundleShared(dir, {});
    assertStringIncludes(startup, "BODY_A");
    assertStringIncludes(startup, "BODY_B", "esbuild no longer hoists the barrel's modules?");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("auto barrels: a sideEffects-false barrel is looked through without being listed", async () => {
  const dir = await sharedBarrelApp({ sideEffects: false });
  try {
    const { startup, all, bCopies } = await bundleShared(dir, { auto: { exclude: [] } });
    assertStringIncludes(startup, "BODY_A");
    assert(!startup.includes("BODY_B"), `the lazy route's module is still at startup:\n${startup}`);
    assertStringIncludes(all, "BODY_B", "it is still bundled, in the lazy chunk");
    assert(!all.includes("BODY_C") && !all.includes("SIDE_C"), "the unused module never loads");
    assertEquals(bCopies, 1, "one copy of b.js");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("auto barrels: a package without sideEffects false (or with the array form) is untouched", async () => {
  for (const pkgJson of [{}, { sideEffects: ["./b.js"] }, { sideEffects: true }]) {
    const dir = await sharedBarrelApp(pkgJson);
    try {
      const { startup } = await bundleShared(dir, { auto: { exclude: [] } });
      assertStringIncludes(startup, "BODY_B", `rewritten despite ${JSON.stringify(pkgJson)}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("auto barrels: a sideEffects array that names no module the barrel loads is looked through", async () => {
  // `@pierre/diffs`: `"sideEffects": ["dist/components/web-components.js"]`, a file the barrel
  // does not import.
  for (const sideEffects of [["./web-components.js"], ["*.css"]]) {
    const dir = await sharedBarrelApp({ sideEffects });
    try {
      const { startup, all } = await bundleShared(dir, { auto: { exclude: [] } });
      assert(
        !startup.includes("BODY_B"),
        `not looked through under ${JSON.stringify(sideEffects)}`,
      );
      assertStringIncludes(all, "BODY_B");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("auto barrels: a barrel that loads a module the sideEffects array names is untouched", async () => {
  // c.js (unused) has side effects: esbuild keeps it, so skipping the barrel would drop them.
  const dir = await sharedBarrelApp({ sideEffects: ["./c.js"] });
  try {
    const { startup } = await bundleShared(dir, { auto: { exclude: [] } });
    assertStringIncludes(startup, "BODY_B");
    assertStringIncludes(startup, "SIDE_C", "the side-effectful module still runs at startup");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("auto barrels: a name from another package stays on the barrel; its own names move", async () => {
  // `@pierre/diffs` re-exports a few `shiki` names beside its own modules.
  const dir = await sharedBarrelApp({ sideEffects: false });
  const pkgDir = join(dir, "node_modules", "shared-barrel");
  const otherDir = join(dir, "node_modules", "other-pkg");
  await Deno.mkdir(otherDir, { recursive: true });
  await Deno.writeTextFile(
    join(otherDir, "package.json"),
    JSON.stringify({ name: "other-pkg", type: "module", main: "index.js", sideEffects: false }),
  );
  await Deno.writeTextFile(join(otherDir, "index.js"), `export const o = () => "BODY_O";\n`);
  await Deno.writeTextFile(
    join(pkgDir, "index.js"),
    SHARED_MODULES["index.js"] + `export { o } from "other-pkg";\n`,
  );
  try {
    // The startup graph imports only the package's own `a`: `b` stays with the lazy route.
    const { startup, all } = await bundleShared(dir, { auto: { exclude: [] } });
    assert(!startup.includes("BODY_B"), `not looked through:\n${startup}`);
    assertStringIncludes(all, "BODY_B");
    // Importing the other package's `o` keeps that import on the barrel, and it still works.
    await Deno.writeTextFile(
      join(dir, "main.js"),
      `import { a, o } from "shared-barrel";\nconsole.log(a(), o());\n` +
        `import("./route.js").then((m) => m.run());\n`,
    );
    const withOther = await bundleShared(dir, { auto: { exclude: [] } });
    assertStringIncludes(withOther.startup, "BODY_O");
    assertStringIncludes(withOther.startup, "BODY_A");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("auto barrels: an excluded package (`!pkg`) is untouched", async () => {
  const dir = await sharedBarrelApp({ sideEffects: false });
  try {
    const { startup } = await bundleShared(dir, { auto: { exclude: ["shared-barrel"] } });
    assertStringIncludes(startup, "BODY_B");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("auto barrels: a specifier the build resolves elsewhere (an alias) is never rewritten", async () => {
  // An earlier plugin owns `shared-barrel` (the way denext's runtime owns `react`): the
  // node_modules barrel is not the module the build loads, so its files must not be imported.
  const dir = await sharedBarrelApp({ sideEffects: false });
  await Deno.writeTextFile(
    join(dir, "alias.js"),
    `export const a = () => "ALIAS_A";\nexport const b = () => "ALIAS_B";\n`,
  );
  const alias: esbuild.Plugin = {
    name: "alias",
    setup(build) {
      build.onResolve({ filter: /^shared-barrel$/ }, () => ({ path: join(dir, "alias.js") }));
    },
  };
  try {
    const { all } = await bundleShared(dir, { auto: { exclude: [] }, lead: [alias] });
    assertStringIncludes(all, "ALIAS_B");
    assert(!all.includes("BODY_"), `the node_modules package leaked in:\n${all}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("auto barrels: the real compat client bundler looks through by default", async () => {
  const dir = await sharedBarrelApp({ sideEffects: false });
  try {
    const startupOf = async (auto: AutoOptimizePackageImports | null) => {
      const clientDir = join(dir, `client-${auto ? "auto" : "off"}`);
      await buildNextCompatClientEntries({
        projectDir: dir,
        configPath: join(dir, "deno.json"),
        outDir: join(dir, ".denext"),
        clientDir,
        entries: [{ id: "index", source: `import ${JSON.stringify(join(dir, "main.js"))};\n` }],
        resolveAllNodeModules: true,
        optimizePackageImports: [],
        autoOptimizePackageImports: auto,
      });
      const texts = new Map<string, string>();
      for await (const e of Deno.readDir(clientDir)) {
        if (e.name.endsWith(".js")) {
          texts.set(e.name, await Deno.readTextFile(join(clientDir, e.name)));
        }
      }
      const seen = new Set<string>();
      const walk = (name: string) => {
        if (seen.has(name) || !texts.has(name)) return;
        seen.add(name);
        for (const m of texts.get(name)!.matchAll(STATIC_CHUNK_IMPORT)) {
          walk(m[1]);
        }
      };
      walk("index.js");
      return [...seen].map((n) => texts.get(n)).join("\n");
    };
    assertStringIncludes(await startupOf(null), "BODY_B", "off: the bug");
    const on = await startupOf(autoOptimizePackageImports(undefined));
    assert(!on.includes("BODY_B"), "on (the default config): fixed");
  } finally {
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("autoOptimizePackageImports: on by default; `false` or `!*` turns it off; `!pkg` excludes", () => {
  assertEquals(autoOptimizePackageImports(undefined), { exclude: [] });
  assertEquals(autoOptimizePackageImports({ optimizePackageImports: ["x"] }), { exclude: [] });
  assertEquals(autoOptimizePackageImports({ optimizePackageImports: false }), null);
  assertEquals(autoOptimizePackageImports({ optimizePackageImports: ["!*", "x"] }), null);
  assertEquals(
    autoOptimizePackageImports({ optimizePackageImports: ["!@base-ui/react", "lucide-react"] }),
    { exclude: ["@base-ui/react"] },
  );
  assert(!optimizePackageImportsList({ optimizePackageImports: ["!*"] }).includes("*"));
});
