// SPA static export (src/build/spa/build.ts `exportSpa` over the staging swap in
// src/build/export-pipeline/out-dir.ts): a re-export leaves exactly the new build in `out/`
// (no stale content-hashed chunk from an earlier one), a failed export leaves the previous
// `out/` intact, an output dir whose replacement would destroy project files is refused
// (on the App Router and Pages Router paths too, by real location: case variants on a
// case-insensitive filesystem and symlinks are resolved), `spa.precompress: false` ships
// no `.gz` siblings, and `spa.ota: true` stamps `_denext/ota.json` over the final tree.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { walk } from "@std/fs";
import { basename, join, relative } from "@std/path";
import { staticExport } from "../src/build/export.ts";
import { resolveExportOutDir, swapStagingDir } from "../src/build/export-pipeline/out-dir.ts";
import type { ProjectPaths } from "../src/build/paths.ts";
import { collectOtaManifest } from "../src/build/ota-manifest.ts";

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

Deno.test({
  name: "exportSpa: spa.ota writes _denext/ota.json last, over every file but .gz siblings",
  ...bundling,
}, async () => {
  const dir = await spaFixture(", ota: true");
  try {
    await Deno.writeTextFile(join(dir, "public", "robots.txt"), "User-agent: *\n");
    await staticExport(dir);
    const out = join(dir, "out");
    const manifest = JSON.parse(await Deno.readTextFile(join(out, "_denext", "ota.json")));
    const files = await filesUnder(out);
    assert(files.some((f) => f.endsWith(".gz")), "precompression still ran");
    // Exactly the export's files (public/ included), minus the .gz siblings and itself.
    assertEquals(
      manifest.files.map((f: { path: string }) => f.path),
      files.filter((f) => !f.endsWith(".gz") && f !== "_denext/ota.json"),
    );
    assert(manifest.files.some((f: { path: string }) => f.path === "robots.txt"));
    // And it is the manifest `denext ota manifest` derives from the same tree.
    assertEquals(manifest, await collectOtaManifest(out));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "exportSpa: no _denext/ota.json unless spa.ota is on",
  ...bundling,
}, async () => {
  const dir = await spaFixture();
  try {
    await staticExport(dir);
    assert(!(await filesUnder(join(dir, "out"))).includes("_denext/ota.json"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveExportOutDir: refuses a dir the export must not replace wholesale", async () => {
  const paths = {
    projectDir: "/proj",
    appDir: "/proj/app",
    publicDir: "/proj/public",
    outDir: "/proj/.denext",
    config: { mode: "spa", spa: { entry: "./src/main.tsx" } },
  } as unknown as ProjectPaths;
  assertEquals(await resolveExportOutDir(paths), "/proj/out");
  assertEquals(await resolveExportOutDir(paths, "build/web"), "/proj/build/web");
  // A name that merely STARTS like a protected path (or like `..`) is its own directory.
  assertEquals(await resolveExportOutDir(paths, "app-out"), "/proj/app-out");
  assertEquals(await resolveExportOutDir(paths, "..out"), "/proj/..out");
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
    await assertRejects(
      () => resolveExportOutDir(paths, outDir),
      Error,
      reason,
      `outDir "${outDir}"`,
    );
  }
});

/** True when the filesystem holding the temp dir ignores case (APFS / NTFS defaults). */
async function tempFsIgnoresCase(): Promise<boolean> {
  const dir = await Deno.makeTempDir({ prefix: "denext_case_probe_" });
  try {
    await Deno.writeTextFile(join(dir, "case-probe"), "");
    return await exists(join(dir, "CASE-PROBE"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const CASE_INSENSITIVE = await tempFsIgnoresCase();

/** A throwaway project on disk with a `.git/HEAD` and `app/page.tsx` to protect. */
async function guardedProject(): Promise<{ dir: string; paths: ProjectPaths }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_out_guard_" });
  await Deno.mkdir(join(dir, ".git"));
  await Deno.writeTextFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await Deno.mkdir(join(dir, "app"));
  await Deno.writeTextFile(join(dir, "app", "page.tsx"), "export default () => null;\n");
  await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
  const paths = {
    projectDir: dir,
    appDir: join(dir, "app"),
    publicDir: join(dir, "public"),
    outDir: join(dir, ".denext"),
    config: null,
  } as unknown as ProjectPaths;
  return { dir, paths };
}

Deno.test({
  name: "resolveExportOutDir: case variants of protected dirs are refused (case-insensitive FS)",
  // On a case-sensitive filesystem `.GIT` really is a different directory from `.git`.
  ignore: !CASE_INSENSITIVE,
}, async () => {
  const { dir, paths } = await guardedProject();
  try {
    // `.git` and `app/` exist (real path + inode match); `public/`, `node_modules/` and
    // `.denext/` do not (the case-folded spelling alone must catch those).
    const refused: Array<[string, string]> = [
      [".GIT", "overlaps the project's .git"],
      [".Git", "overlaps the project's .git"],
      [".GIT/hooks", "overlaps the project's .git"],
      ["APP", "overlaps the project's app"],
      ["App/nested", "overlaps the project's app"],
      ["PUBLIC", "overlaps the project's public"],
      ["Node_Modules", "overlaps the project's node_modules"],
      [".DENEXT", "overlaps the project's .denext"],
    ];
    for (const [outDir, reason] of refused) {
      await assertRejects(
        () => resolveExportOutDir(paths, outDir),
        Error,
        reason,
        `outDir "${outDir}"`,
      );
    }
    assertEquals(await resolveExportOutDir(paths, "OUT"), join(dir, "OUT"));
    assert(await exists(join(dir, ".git", "HEAD")), ".git is untouched");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: 'staticExport: outDir ".GIT" is refused and .git survives (case-insensitive FS)',
  ignore: !CASE_INSENSITIVE,
  ...bundling,
}, async () => {
  const dir = await spaFixture();
  try {
    await Deno.mkdir(join(dir, ".git"));
    await Deno.writeTextFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const before = await filesUnder(dir);
    await assertRejects(() => staticExport(dir, { outDir: ".GIT" }), Error, "the project's .git");
    assertEquals(await filesUnder(dir), before, "nothing was written or removed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveExportOutDir: symlinks are compared by where they really lead", async () => {
  const { dir, paths } = await guardedProject();
  const outside = await Deno.makeTempDir({ prefix: "denext_out_guard_outside_" });
  try {
    const link = (name: string, to: string) => Deno.symlink(to, join(dir, name), { type: "dir" });
    await link("to-root", dir);
    await link("to-git", join(dir, ".git"));
    await link("to-outside", outside);
    await link("dangling", join(dir, "nowhere"));
    await Deno.mkdir(join(dir, "build"));
    await link("to-build", join(dir, "build"));
    const refused: Array<[string, string]> = [
      // The target itself is a link: the swap would act on the link, so it is refused outright.
      ["to-root", "is a symlink"],
      ["to-git", "is a symlink"],
      // A symlinked parent that lands the target inside a protected dir or outside the project.
      ["to-git/out", "overlaps the project's .git"],
      ["to-root/.git", "overlaps the project's .git"],
      ["to-root/app/out", "overlaps the project's app"],
      ["to-outside/out", "outside the project"],
      ["dangling/out", "cannot be resolved"],
      // An existing file is not a dedicated output directory.
      ["deno.json", "not a directory"],
    ];
    for (const [outDir, reason] of refused) {
      await assertRejects(
        () => resolveExportOutDir(paths, outDir),
        Error,
        reason,
        `outDir "${outDir}"`,
      );
    }
    // A symlinked parent that resolves to a safe dir inside the project is fine; the lexical
    // path comes back, as before.
    assertEquals(await resolveExportOutDir(paths, "to-build/web"), join(dir, "to-build", "web"));
    assertEquals(await resolveExportOutDir(paths), join(dir, "out"));
    assert(await exists(join(dir, ".git", "HEAD")), ".git is untouched");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

/** A throwaway Pages Router project (a `pages/` tree, no `app/`) with a `.git` to protect. */
async function pagesFixture(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_pages_export_" });
  await Deno.writeTextFile(join(dir, "deno.json"), DENO_JSON);
  await Deno.mkdir(join(dir, "pages"));
  await Deno.writeTextFile(
    join(dir, "pages", "index.tsx"),
    "export default function Home() {\n  return <p>hi</p>;\n}\n",
  );
  await Deno.mkdir(join(dir, "public"));
  await Deno.writeTextFile(join(dir, "public", "kept.txt"), "kept");
  await Deno.mkdir(join(dir, ".git"));
  await Deno.writeTextFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

Deno.test({
  name: "staticExport (Pages Router): an unsafe outDir is refused before anything is removed",
  ...bundling,
}, async () => {
  const dir = await pagesFixture();
  try {
    await Deno.symlink(join(dir, ".git"), join(dir, "to-git"), { type: "dir" });
    const before = await filesUnder(dir);
    const refused: Array<[string, string]> = [
      [".", "the project root"],
      [".git", "overlaps the project's .git"],
      ["to-git", "is a symlink"],
      ["to-git/out", "overlaps the project's .git"],
      ["public", "overlaps the project's public"],
      ...(CASE_INSENSITIVE ? [[".GIT", "overlaps the project's .git"] as [string, string]] : []),
    ];
    for (const [outDir, reason] of refused) {
      await assertRejects(() => staticExport(dir, { outDir }), Error, reason, `outDir "${outDir}"`);
    }
    assertEquals(await filesUnder(dir), before, "nothing was written or removed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "staticExport (Pages Router): out/ is replaced through the staging swap",
  ...bundling,
}, async () => {
  const dir = await pagesFixture();
  const out = join(dir, "out");
  try {
    const first = await staticExport(dir);
    assertEquals(first.outDir, out);
    assertEquals(await filesUnder(out), ["kept.txt"], "public/ lands at the site root");
    await Deno.remove(join(dir, "public", "kept.txt"));
    await Deno.writeTextFile(join(dir, "public", "added.txt"), "added");
    await staticExport(dir);
    assertEquals(await filesUnder(out), ["added.txt"], "nothing from the earlier export lingers");
    assert(!(await exists(join(dir, "out.staging"))), "no staging dir left behind");
    assert(!(await exists(join(dir, "out.prev"))), "no previous-export dir left behind");
  } finally {
    await Deno.remove(dir, { recursive: true });
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

Deno.test("swapStagingDir: a failed swap puts the previous output back", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_swap_" });
  try {
    const out = join(dir, "out");
    await Deno.mkdir(out);
    await Deno.writeTextFile(join(out, "index.html"), "previous");
    // A staging dir that isn't there makes the second rename fail after `out` moved aside.
    await assertRejects(() => swapStagingDir(join(dir, "missing.staging"), out));
    assertEquals(await Deno.readTextFile(join(out, "index.html")), "previous");
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["out"], "no .prev left behind");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
