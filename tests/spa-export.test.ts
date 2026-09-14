// SPA static export (src/build/spa/build.ts `exportSpa` over the staging swap in
// src/build/export-pipeline/out-dir.ts): a re-export leaves exactly the new build in `out/`
// (no stale content-hashed chunk from an earlier one), a failed export leaves the previous
// `out/` intact, an output dir whose replacement would destroy project files is refused
// (on the App Router path too), and `spa.precompress: false` ships no `.gz` siblings.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { walk } from "@std/fs";
import { basename, join, relative } from "@std/path";
import { staticExport } from "../src/build/export.ts";
import { resolveExportOutDir } from "../src/build/export-pipeline/out-dir.ts";
import type { ProjectPaths } from "../src/build/paths.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/** The import map a throwaway project needs to resolve denext from this checkout. */
const DENO_JSON = JSON.stringify({
  compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
  imports: {
    "denext": abs("mod.ts"),
    "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
    "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
    "denext/server": abs("src/server/mod.ts"),
    "denext/client": abs("src/client/mod.ts"),
  },
});

/** (Re)write the lazily imported module — large enough that precompression writes a `.gz`. */
function writeLazy(dir: string, version: string): Promise<void> {
  const text = `${version} ${"lorem ipsum dolor sit amet ".repeat(60)}`;
  return Deno.writeTextFile(
    join(dir, "src", "lazy.ts"),
    `export const msg = ${JSON.stringify(text)};\n`,
  );
}

/** A throwaway SPA project; `spaExtra` is spliced into its `spa` config block. */
async function spaFixture(spaExtra = ""): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_export_" });
  await Deno.writeTextFile(join(dir, "deno.json"), DENO_JSON);
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default { mode: "spa", spa: { entry: "./src/main.ts"${spaExtra} } };\n`,
  );
  await Deno.mkdir(join(dir, "src"));
  await Deno.mkdir(join(dir, "public"));
  // A dynamic import, so the bundle splits the lazy module into a content-hashed chunk.
  await Deno.writeTextFile(
    join(dir, "src", "main.ts"),
    `const { msg } = await import("./lazy.ts");\nconsole.log(msg);\n`,
  );
  await writeLazy(dir, "v1");
  return dir;
}

/** Every file under `dir`, relative and sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const e of walk(dir, { includeDirs: false })) files.push(relative(dir, e.path));
  return files.sort();
}

/** The split chunks: client `.js` files other than the entry. */
function chunks(files: string[]): string[] {
  return files.filter((f) =>
    f.startsWith("_denext/client/") && f.endsWith(".js") && f !== "_denext/client/index.js"
  );
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

const bundling = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "exportSpa: a re-export after a code change leaves exactly the new build in out/",
  ...bundling,
}, async () => {
  const dir = await spaFixture();
  const out = join(dir, "out");
  try {
    await Deno.writeTextFile(join(dir, "public", "kept.txt"), "kept");
    await Deno.writeTextFile(join(dir, "public", "dropped.txt"), "dropped");
    await staticExport(dir);
    const first = await filesUnder(out);
    const firstChunks = chunks(first);
    assert(firstChunks.length > 0, `the lazy import splits into a chunk: ${first.join(", ")}`);
    assert(first.some((f) => f.endsWith(".js.gz")), "precompression stays on by default");
    assert(first.includes("dropped.txt"), "public/ is copied to the site root");

    await writeLazy(dir, "v2");
    await Deno.remove(join(dir, "public", "dropped.txt"));
    const result = await staticExport(dir);
    assertEquals(result.outDir, out);
    const second = await filesUnder(out);
    assert(chunks(second).length > 0, "the new build has its chunk");
    assertEquals(
      firstChunks.filter((c) => second.includes(c)),
      [],
      "no content-hashed chunk from the first build survives the re-export",
    );
    assert(second.includes("kept.txt"), "public/ is carried into every export");
    assert(!second.includes("dropped.txt"), "a file removed from public/ leaves out/ too");
    // Re-exporting over an existing out/ yields exactly the tree a clean export does.
    await staticExport(dir, { outDir: "fresh" });
    assertEquals(second, await filesUnder(join(dir, "fresh")));
    assert(!(await exists(join(dir, "out.staging"))), "no staging dir left behind");
    assert(!(await exists(join(dir, "out.prev"))), "no previous-export dir left behind");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "exportSpa: a failed export leaves the previous out/ intact",
  ...bundling,
}, async () => {
  const dir = await spaFixture();
  const out = join(dir, "out");
  try {
    await staticExport(dir);
    const before = await filesUnder(out);
    await Deno.writeTextFile(join(dir, "src", "lazy.ts"), "export const msg = ;\n");
    await assertRejects(() => staticExport(dir));
    assertEquals(await filesUnder(out), before, "the previous export is still whole");
    assert(!(await exists(join(dir, "out.staging"))), "the half-written staging dir is removed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "exportSpa: spa.precompress: false ships no .gz siblings",
  ...bundling,
}, async () => {
  const dir = await spaFixture(", precompress: false");
  try {
    await staticExport(dir);
    const files = await filesUnder(join(dir, "out"));
    assert(chunks(files).length > 0, "the export still emits its chunks");
    assertEquals(files.filter((f) => f.endsWith(".gz")), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveExportOutDir: refuses a dir the export must not replace wholesale", () => {
  const paths = {
    projectDir: "/proj",
    appDir: "/proj/app",
    publicDir: "/proj/public",
    outDir: "/proj/.denext",
    config: { mode: "spa", spa: { entry: "./src/main.tsx" } },
  } as unknown as ProjectPaths;
  assertEquals(resolveExportOutDir(paths), "/proj/out");
  assertEquals(resolveExportOutDir(paths, "build/web"), "/proj/build/web");
  // A name that merely STARTS like a protected path (or like `..`) is its own directory.
  assertEquals(resolveExportOutDir(paths, "app-out"), "/proj/app-out");
  assertEquals(resolveExportOutDir(paths, "..out"), "/proj/..out");
  const refused: Array<[string, string]> = [
    [".", "the project root"],
    ["", "the project root"],
    ["..", "outside the project"],
    ["../sibling", "outside the project"],
    ["public", "overlaps the project's public"],
    ["public/out", "overlaps the project's public"],
    ["app", "overlaps the project's app"],
    [".denext", "overlaps the project's .denext"],
    ["src", "overlaps the project's src/main.tsx"],
    ["node_modules", "overlaps the project's node_modules"],
    [".git", "overlaps the project's .git"],
  ];
  for (const [outDir, reason] of refused) {
    assertThrows(() => resolveExportOutDir(paths, outDir), Error, reason, `outDir "${outDir}"`);
  }
});

Deno.test({
  name: "staticExport: an unsafe outDir is refused before anything is written or removed",
  ...bundling,
}, async () => {
  const dir = await spaFixture();
  const sibling = `${dir}-sibling`;
  const appProject = await Deno.makeTempDir({ prefix: "denext_app_export_guard_" });
  try {
    await Deno.mkdir(sibling);
    await Deno.writeTextFile(join(sibling, "keep.txt"), "keep");
    const before = await filesUnder(dir);
    await assertRejects(() => staticExport(dir, { outDir: "." }), Error, "the project root");
    await assertRejects(
      () => staticExport(dir, { outDir: `../${basename(sibling)}` }),
      Error,
      "outside the project",
    );
    await assertRejects(() => staticExport(dir, { outDir: "src" }), Error, "src/main.ts");
    assertEquals(await filesUnder(dir), before, "the SPA project is untouched");
    assertEquals(await filesUnder(sibling), ["keep.txt"], "the outside dir is untouched");

    // The App Router export replaces its target through the same swap, so it is guarded too.
    await Deno.writeTextFile(join(appProject, "deno.json"), DENO_JSON);
    await Deno.mkdir(join(appProject, "app"));
    await Deno.writeTextFile(
      join(appProject, "app", "page.tsx"),
      "export default function Page() {\n  return <p>hi</p>;\n}\n",
    );
    await assertRejects(
      () => staticExport(appProject, { outDir: "." }),
      Error,
      "the project root",
    );
    assert(
      await exists(join(appProject, "app", "page.tsx")),
      "the App Router project is untouched",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(sibling, { recursive: true }).catch(() => {});
    await Deno.remove(appProject, { recursive: true });
  }
});
