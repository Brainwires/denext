// `denext patch` core (src/build/patches.ts): npm patches created from node_modules vs a
// pristine copy and re-applied idempotently; the denext patch edited via working copies,
// materialized with absolutized imports and import-mapped in deno.json; the esbuild plugin
// that feeds the patched framework source to a bundle; delete undoing both.

import * as esbuild from "../src/build/esbuild/mod.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  applyNpmPatch,
  applyPatches,
  createDenextPatch,
  createNpmPatch,
  deletePatch,
  editDenextFile,
  findPatch,
  listPatches,
  loadDenextPatchSet,
  parsePatchFileName,
  type PatchEntry,
  patchFileName,
  patchPlugin,
  patchRuntime,
  revertNpmPatch,
} from "../src/build/patches.ts";
import {
  FIRST_PATCHED_DEPENDENCIES_RUNTIME,
  supportsPatchedDependencies,
} from "../src/build/deno-version.ts";
import toolchainPin from "../src/build/deno-toolchain-pin.json" with { type: "json" };

Deno.test("patch file names round-trip, scoped packages included", () => {
  assertEquals(patchFileName("left-pad", "1.3.0"), "left-pad+1.3.0.patch");
  assertEquals(patchFileName("@scope/name", "1.2.3"), "@scope+name+1.2.3.patch");
  assertEquals(parsePatchFileName("left-pad+1.3.0.patch"), { name: "left-pad", version: "1.3.0" });
  assertEquals(parsePatchFileName("@scope+name+1.2.3.patch"), {
    name: "@scope/name",
    version: "1.2.3",
  });
  assertEquals(parsePatchFileName("denext+2.0.6.patch"), { name: "denext", version: "2.0.6" });
  assertEquals(parsePatchFileName("notes.txt"), null);
});

const LEFT_PAD =
  `"use strict";\nmodule.exports = leftPad;\nfunction leftPad(str, len) {\n  return str + "-" + len;\n}\n`;

/** A project with an installed `left-pad` and a pristine copy elsewhere. */
async function npmProject(): Promise<{ dir: string; installed: string; pristine: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_patches_npm_" });
  const installed = join(dir, "node_modules", "left-pad");
  const pristine = join(dir, ".pristine", "left-pad");
  for (const d of [installed, pristine]) {
    await Deno.mkdir(d, { recursive: true });
    await Deno.writeTextFile(
      join(d, "package.json"),
      `{ "name": "left-pad", "version": "1.3.0" }\n`,
    );
    await Deno.writeTextFile(join(d, "index.js"), LEFT_PAD);
  }
  await Deno.writeTextFile(join(dir, "deno.json"), `{ "imports": {} }\n`);
  return { dir, installed, pristine };
}

Deno.test("npm: create records the node_modules edit; apply is idempotent; delete reverts", async () => {
  const { dir, installed, pristine } = await npmProject();
  const opts = { npmPristine: () => Promise.resolve(pristine), log: () => {} };
  try {
    const edited = LEFT_PAD.replace('str + "-" + len', '"PATCHED:" + str + "-" + len');
    await Deno.writeTextFile(join(installed, "index.js"), edited);
    const created = await createNpmPatch(dir, "left-pad", opts);
    assertEquals(created.files, ["index.js"]);
    const patch = await Deno.readTextFile(join(dir, "patches", "left-pad+1.3.0.patch"));
    assertStringIncludes(
      patch,
      "--- a/node_modules/left-pad/index.js\n+++ b/node_modules/left-pad/index.js\n",
    );
    assertStringIncludes(patch, '+  return "PATCHED:" + str + "-" + len;');
    assert(!patch.includes("package.json"), "unchanged files are not in the patch");

    const [entry] = await listPatches(dir);
    assertEquals(entry.kind, "npm");
    // Already applied (the edit is still on disk) → recognized, not re-applied.
    assertEquals(await applyNpmPatch(dir, entry, opts), "already-applied");
    // A fresh install (pristine files back) → applied.
    await Deno.writeTextFile(join(installed, "index.js"), LEFT_PAD);
    assertEquals(await applyNpmPatch(dir, entry, opts), "applied");
    assertEquals(await Deno.readTextFile(join(installed, "index.js")), edited);
    const report = await applyPatches(dir, opts);
    assertEquals(report, { applied: [], unchanged: ["left-pad@1.3.0"] });

    assertEquals(await revertNpmPatch(dir, entry), []);
    assertEquals(await Deno.readTextFile(join(installed, "index.js")), LEFT_PAD);
    assertEquals(await applyNpmPatch(dir, entry, opts), "applied");
    const removed = await deletePatch(dir, "1");
    assertEquals(removed.name, "left-pad");
    assertEquals(await listPatches(dir), []);
    assertEquals(await Deno.readTextFile(join(installed, "index.js")), LEFT_PAD, "delete reverted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("npm: a deleted and an added file are recorded (/dev/null), applied (remove / create) and reverted", async () => {
  const { dir, installed, pristine } = await npmProject();
  const opts = { npmPristine: () => Promise.resolve(pristine), log: () => {} };
  try {
    // The install deletes a pristine file and adds a new one.
    await Deno.writeTextFile(join(pristine, "extra.js"), "module.exports = 1;\n");
    await Deno.writeTextFile(join(installed, "added.js"), "module.exports = 2;\n");
    const created = await createNpmPatch(dir, "left-pad", opts);
    assertEquals(created.files.sort(), ["added.js", "extra.js"]);
    const patch = await Deno.readTextFile(created.file);
    assertStringIncludes(patch, "--- /dev/null\n+++ b/node_modules/left-pad/added.js\n");
    assertStringIncludes(patch, "--- a/node_modules/left-pad/extra.js\n+++ /dev/null\n");
    const [entry] = await listPatches(dir);
    // Already in the patched state → recognized.
    assertEquals(await applyNpmPatch(dir, entry, opts), "already-applied");
    // A fresh install (pristine tree): the deletion removes, the creation writes.
    await Deno.writeTextFile(join(installed, "extra.js"), "module.exports = 1;\n");
    await Deno.remove(join(installed, "added.js"));
    assertEquals(await applyNpmPatch(dir, entry, opts), "applied");
    assertEquals(await exists(join(installed, "extra.js")), false, "deleted by the patch");
    assertEquals(await Deno.readTextFile(join(installed, "added.js")), "module.exports = 2;\n");
    // Revert restores the deleted file and removes the added one.
    assertEquals(await revertNpmPatch(dir, entry), []);
    assertEquals(await Deno.readTextFile(join(installed, "extra.js")), "module.exports = 1;\n");
    assertEquals(await exists(join(installed, "added.js")), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("npm: a file too large to diff is skipped with a note, the rest of the patch is recorded", async () => {
  const { dir, installed, pristine } = await npmProject();
  const notes: string[] = [];
  const opts = { npmPristine: () => Promise.resolve(pristine), log: (m: string) => notes.push(m) };
  try {
    const huge = Array.from({ length: 60_000 }, (_, i) => `l${i}`).join("\n") + "\n";
    await Deno.writeTextFile(join(pristine, "bundle.js"), huge);
    await Deno.writeTextFile(join(installed, "bundle.js"), huge.replace("l7\n", "L7\n"));
    await Deno.writeTextFile(join(installed, "index.js"), LEFT_PAD.replace("str +", 'str + "!" +'));
    const created = await createNpmPatch(dir, "left-pad", opts);
    assertEquals(created.files, ["index.js"]);
    assertEquals(notes.length, 1);
    assertStringIncludes(notes[0], "bundle.js is too large to diff");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("npm: a patch may only write inside the package it names — traversal and absolute paths are refused", async () => {
  const { dir, pristine } = await npmProject();
  const opts = { npmPristine: () => Promise.resolve(pristine), log: () => {} };
  try {
    await Deno.mkdir(join(dir, "patches"), { recursive: true });
    // All-`+` hunks apply to a missing file, so a hostile patch could CREATE any path.
    const hostile = [
      "--- a/node_modules/left-pad/../../../pwned.txt",
      "+++ b/node_modules/left-pad/../../../pwned.txt",
      "@@ -0,0 +1 @@",
      "+owned",
      "",
    ].join("\n");
    await Deno.writeTextFile(join(dir, "patches", "left-pad+1.3.0.patch"), hostile);
    const [entry] = await listPatches(dir);
    await assertRejects(() => applyNpmPatch(dir, entry, opts), Error, "outside its package");
    await assertRejects(() => revertNpmPatch(dir, entry), Error, "outside its package");
    let exists = true;
    try {
      await Deno.stat(join(dir, "..", "..", "pwned.txt"));
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "nothing was written outside the project");
    // A project file outside node_modules/left-pad is just as off-limits.
    const sibling = hostile.replaceAll(
      "node_modules/left-pad/../../../pwned.txt",
      "app/api/admin/route.ts",
    );
    await Deno.writeTextFile(join(dir, "patches", "left-pad+1.3.0.patch"), sibling);
    const [siblingEntry] = await listPatches(dir);
    await assertRejects(() => applyNpmPatch(dir, siblingEntry, opts), Error, "outside its package");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("npm: a version mismatch warns; a hunk that no longer fits throws naming it", async () => {
  const { dir, installed, pristine } = await npmProject();
  const warnings: string[] = [];
  const opts = {
    npmPristine: () => Promise.resolve(pristine),
    log: (l: string) => void warnings.push(l),
  };
  try {
    await Deno.writeTextFile(join(installed, "index.js"), LEFT_PAD.replace('"-"', '"+"'));
    await createNpmPatch(dir, "left-pad", opts);
    // The package got upgraded: new version, and the patched line rewritten upstream.
    await Deno.writeTextFile(
      join(installed, "package.json"),
      `{ "name": "left-pad", "version": "1.4.0" }\n`,
    );
    await Deno.writeTextFile(
      join(installed, "index.js"),
      LEFT_PAD.replace('str + "-" + len', "pad(str, len)"),
    );
    const [entry] = await listPatches(dir);
    await assertRejects(() => applyNpmPatch(dir, entry, opts), Error, "hunk #1");
    assert(warnings.some((w) => w.includes("1.4.0") && w.includes("1.3.0")), "mismatch warned");
    // Re-creating against the new version replaces the old patch file.
    await createNpmPatch(dir, "left-pad", opts);
    assertEquals((await listPatches(dir)).map((p) => p.version), ["1.4.0"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const DOCUMENT =
  `import { escapeHtml } from "./render.ts";\nimport type { Meta } from "../types.ts";\n` +
  `export function doc(m: Meta): string {\n  return "<!DOCTYPE html>" + escapeHtml(m.title);\n}\n`;

/** A fake framework checkout (`file://` root) + an app that patches one of its files. */
async function frameworkProject(): Promise<{ dir: string; root: string; fw: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_patches_fw_" });
  const fw = join(dir, "framework");
  await Deno.mkdir(join(fw, "src", "server"), { recursive: true });
  await Deno.writeTextFile(
    join(fw, "deno.json"),
    `{ "name": "@denext/denext", "version": "9.9.9" }\n`,
  );
  await Deno.writeTextFile(join(fw, "src", "server", "document.ts"), DOCUMENT);
  await Deno.writeTextFile(
    join(fw, "src", "server", "render.ts"),
    `export const escapeHtml = (s: string) => s;\n`,
  );
  await Deno.writeTextFile(
    join(fw, "src", "types.ts"),
    `export interface Meta { title: string }\n`,
  );
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    `{\n  "imports": {\n    "denext": "jsr:@denext/denext@^9"\n  }\n}\n`,
  );
  return { dir, root: toFileUrl(fw).href + "/", fw };
}

Deno.test("denext: edit → create writes the patch, materializes with absolutized imports, and maps it in deno.json", async () => {
  const { dir, root, fw } = await frameworkProject();
  const opts = { frameworkRoot: root, frameworkVersion: "9.9.9", log: () => {} };
  try {
    const work = await editDenextFile(dir, "src/server/document.ts", opts);
    assertEquals(work, join(dir, "patches", ".work", "denext", "src", "server", "document.ts"));
    assertEquals(
      await Deno.readTextFile(work),
      DOCUMENT,
      "the working copy is the pristine source",
    );
    await Deno.writeTextFile(
      work,
      DOCUMENT.replace("<!DOCTYPE html>", "<!DOCTYPE html><!-- patched -->"),
    );
    const created = await createDenextPatch(dir, opts);
    assertEquals(created.files, ["src/server/document.ts"]);
    const patch = await Deno.readTextFile(join(dir, "patches", "denext+9.9.9.patch"));
    assertStringIncludes(
      patch,
      "--- a/denext/src/server/document.ts\n+++ b/denext/src/server/document.ts\n",
    );
    assertStringIncludes(
      patch,
      '+  return "<!DOCTYPE html><!-- patched -->" + escapeHtml(m.title);',
    );

    const materialized = await Deno.readTextFile(
      join(dir, "patches", "denext", "src", "server", "document.ts"),
    );
    assertStringIncludes(materialized, "<!-- patched -->");
    assertStringIncludes(
      materialized,
      `from "${root}src/server/render.ts"`,
      "relative import absolutized",
    );
    assertStringIncludes(materialized, `from "${root}src/types.ts"`, "../ import absolutized");
    const config = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(
      config.imports[`${root}src/server/document.ts`],
      "./patches/denext/src/server/document.ts",
    );
    assertEquals(config.imports.denext, "jsr:@denext/denext@^9", "other imports untouched");

    // Boot: nothing to change; the working copy re-opens with the patch applied.
    assertEquals(await applyPatches(dir, opts), { applied: [], unchanged: ["denext@9.9.9"] });
    await Deno.remove(work);
    assertStringIncludes(
      await Deno.readTextFile(await editDenextFile(dir, "src/server/document.ts", opts)),
      "<!-- patched -->",
    );

    // The patch set + esbuild plugin: the bundle gets the patched framework source.
    const set = await loadDenextPatchSet(dir);
    assert(set && set.has("src/server/document.ts"));
    const entry = join(dir, "entry.ts");
    await Deno.writeTextFile(
      entry,
      // JSON-quoted: a Windows path's backslashes must survive as a JS string literal.
      `import { doc } from ${
        JSON.stringify(join(fw, "src", "server", "document.ts"))
      };\nconsole.log(doc({ title: "x" }));\n`,
    );
    const out = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      plugins: [patchPlugin(set!, root)],
      logLevel: "silent",
    });
    assertStringIncludes(out.outputFiles[0].text, "<!-- patched -->");

    const removed = await deletePatch(dir, "denext");
    assertEquals(removed.version, "9.9.9");
    const after = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(Object.keys(after.imports), ["denext"], "managed import-map entries dropped");
    assertEquals(await findPatch(dir, "denext"), null);
    await assertRejects(() => Deno.stat(join(dir, "patches", "denext")), Deno.errors.NotFound);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

// esbuild names a file by the path it reached it through, which need not be the real one: on a
// Windows runner the temp dir is the 8.3 short name `C:\\Users\\RUNNER~1\\…` while the framework root
// is compared by its real path, so a patched file was loaded unpatched. Simulated here with a
// symlink esbuild is told to preserve (Windows needs a privilege for symlinks).
Deno.test({
  name:
    "denext: the bundle gets the patched source when esbuild reports another spelling of the path",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { dir, root, fw } = await frameworkProject();
    const opts = { frameworkRoot: root, frameworkVersion: "9.9.9", log: () => {} };
    try {
      const work = await editDenextFile(dir, "src/server/document.ts", opts);
      await Deno.writeTextFile(
        work,
        DOCUMENT.replace("<!DOCTYPE html>", "<!DOCTYPE html><!-- patched -->"),
      );
      await createDenextPatch(dir, opts);
      const alias = join(dir, "fw-alias");
      await Deno.symlink(fw, alias);
      const entry = join(dir, "entry.ts");
      await Deno.writeTextFile(
        entry,
        `import { doc } from ${
          JSON.stringify(join(alias, "src", "server", "document.ts"))
        };\nconsole.log(doc({ title: "x" }));\n`,
      );
      const out = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "esm",
        preserveSymlinks: true,
        plugins: [patchPlugin((await loadDenextPatchSet(dir))!, root)],
        logLevel: "silent",
      });
      assertStringIncludes(out.outputFiles[0].text, "<!-- patched -->");
    } finally {
      await esbuild.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("denext: create with no working copies explains what to do", async () => {
  const { dir, root } = await frameworkProject();
  try {
    await assertRejects(
      () => createDenextPatch(dir, { frameworkRoot: root, frameworkVersion: "9.9.9" }),
      Error,
      "denext patch edit denext",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext: a file swc's TSX parser rejects (TS-only casts) is still absolutized textually", async () => {
  const { dir, root, fw } = await frameworkProject();
  const opts = { frameworkRoot: root, frameworkVersion: "9.9.9", log: () => {} };
  const TS_ONLY =
    `import {\n  escapeHtml,\n} from "./render.ts";\nimport type { Meta } from "../types.ts";\n` +
    `export async function lazy(m: Meta): Promise<string> {\n  const n = <number> (m.title.length as unknown);\n` +
    `  const mod = await import("./render.ts");\n  return mod.escapeHtml(m.title) + n;\n}\n`;
  await Deno.writeTextFile(join(fw, "src", "server", "cast.ts"), TS_ONLY);
  try {
    const work = await editDenextFile(dir, "src/server/cast.ts", opts);
    await Deno.writeTextFile(work, TS_ONLY.replace("+ n;", '+ n + "!";'));
    await createDenextPatch(dir, opts);
    const out = await Deno.readTextFile(join(dir, "patches", "denext", "src", "server", "cast.ts"));
    assertStringIncludes(out, `} from "${root}src/server/render.ts";`);
    assertStringIncludes(out, `import type { Meta } from "${root}src/types.ts";`);
    assertStringIncludes(out, `await import("${root}src/server/render.ts")`);
    assert(!/["']\.\.?\//.test(out), "no relative specifier survives");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Make a link, or report that this machine can't (Windows without the symlink privilege). */
async function tryLink(target: string, path: string, type: "file" | "dir"): Promise<boolean> {
  try {
    await Deno.symlink(target, path, { type });
    return true;
  } catch (err) {
    // Windows without Developer Mode or the privilege: "A required privilege is not held by
    // the client. (os error 1314)".
    if (
      Deno.build.os === "windows" &&
      (err instanceof Deno.errors.PermissionDenied || /os error 1314/.test(String(err)))
    ) {
      console.warn("skipped: this Windows account may not create symlinks");
      return false;
    }
    throw err;
  }
}

/** A patch that rewrites `rel` in left-pad (pristine "a" → "b"), as a hostile repo could ship. */
async function linkPatch(dir: string, rel: string): Promise<PatchEntry> {
  await Deno.mkdir(join(dir, "patches"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "patches", "left-pad+1.3.0.patch"),
    [
      `--- a/node_modules/left-pad/${rel}`,
      `+++ b/node_modules/left-pad/${rel}`,
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n"),
  );
  return (await listPatches(dir))[0];
}

Deno.test("npm: a link inside the package never carries a patch's write outside it", async () => {
  const { dir, installed, pristine } = await npmProject();
  const outside = await Deno.makeTempDir({ prefix: "denext_patches_outside_" });
  const opts = { npmPristine: () => Promise.resolve(pristine), log: () => {} };
  try {
    const victim = join(outside, "victim.txt");
    await Deno.writeTextFile(victim, "a\n");
    // A file link (`rc` → a file outside), then a directory link (`etc/` → a directory outside).
    if (!await tryLink(victim, join(installed, "rc"), "file")) return;
    let entry = await linkPatch(dir, "rc");
    await assertRejects(() => applyNpmPatch(dir, entry, opts), Error, "outside the package");
    await assertRejects(() => revertNpmPatch(dir, entry), Error, "outside the package");
    assertEquals(await Deno.readTextFile(victim), "a\n", "the file outside is untouched");
    assert(await tryLink(outside, join(installed, "etc"), "dir"));
    entry = await linkPatch(dir, "etc/victim.txt");
    await assertRejects(() => applyNpmPatch(dir, entry, opts), Error, "outside the package");
    assertEquals(await Deno.readTextFile(victim), "a\n");
    // A dangling link would create its target wherever it points: refused as well.
    await Deno.symlink(join(outside, "new.txt"), join(installed, "dangling"), { type: "file" });
    entry = await linkPatch(dir, "dangling");
    await assertRejects(() => applyNpmPatch(dir, entry, opts), Error, "dangling link");
    assert(!(await exists(join(outside, "new.txt"))));
    // A link that stays inside the package is followed as before.
    await Deno.writeTextFile(join(installed, "real.txt"), "a\n");
    await Deno.symlink(join(installed, "real.txt"), join(installed, "alias"), { type: "file" });
    entry = await linkPatch(dir, "alias");
    assertEquals(await applyNpmPatch(dir, entry, opts), "applied");
    assertEquals(await Deno.readTextFile(join(installed, "real.txt")), "b\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("npm: node_modules/<pkg> may link into the workspace, never elsewhere on the machine", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_patches_ws_" });
  const opts = { log: () => {} };
  try {
    // A workspace: the app in apps/web, its left-pad linked (as pnpm does) to packages/left-pad.
    await Deno.writeTextFile(join(root, "deno.json"), `{ "workspace": ["./apps/web"] }\n`);
    const app = join(root, "apps", "web");
    const member = join(root, "packages", "left-pad");
    const elsewhere = await Deno.makeTempDir({ prefix: "denext_patches_elsewhere_" });
    for (const d of [member, elsewhere]) {
      await Deno.mkdir(d, { recursive: true });
      await Deno.writeTextFile(
        join(d, "package.json"),
        `{ "name": "left-pad", "version": "1.3.0" }\n`,
      );
      await Deno.writeTextFile(join(d, "x.txt"), "a\n");
    }
    await Deno.mkdir(join(app, "node_modules"), { recursive: true });
    if (!await tryLink(member, join(app, "node_modules", "left-pad"), "dir")) return;
    const entry = await linkPatch(app, "x.txt");
    assertEquals(await applyNpmPatch(app, entry, opts), "applied");
    assertEquals(await Deno.readTextFile(join(member, "x.txt")), "b\n");
    // The same link to a directory outside the project and its workspace is refused.
    await Deno.remove(join(app, "node_modules", "left-pad"));
    await Deno.symlink(elsewhere, join(app, "node_modules", "left-pad"), { type: "dir" });
    await assertRejects(
      () => applyNpmPatch(app, entry, opts),
      Error,
      "outside the project and its workspace",
    );
    assertEquals(await Deno.readTextFile(join(elsewhere, "x.txt")), "a\n");
    await Deno.remove(elsewhere, { recursive: true });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ── deno.json `patchedDependencies` (runtime 3.0.0-denext.3, DENEXT.md item 161) ───────────────

Deno.test("supportsPatchedDependencies: from runtime 3.0.0-denext.3 on", () => {
  assertEquals(FIRST_PATCHED_DEPENDENCIES_RUNTIME, "3.0.0-denext.3");
  for (const v of ["3.0.0-denext.3", "3.0.0-denext.10", "3.0.1"]) {
    assert(supportsPatchedDependencies(v), v);
  }
  for (const v of ["3.0.0-denext.2", "3.0.0-rc.7", "2.9.7-denext.14", "2.9.8", "x"]) {
    assert(!supportsPatchedDependencies(v), v);
  }
});

Deno.test("patchRuntime: the pinned toolchain, none under DENEXT_DENO=stock or a path", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(patchRuntime(env({})), toolchainPin.version);
  assertEquals(patchRuntime(env({ DENEXT_DENO: "pinned" })), toolchainPin.version);
  assertEquals(patchRuntime(env({ DENEXT_DENO: "stock" })), null);
  assertEquals(patchRuntime(env({ DENEXT_DENO: "/usr/local/bin/deno" })), null);
});

/** {@link npmProject} with `nodeModulesDir: "auto"` and a patched `index.js`. */
async function runtimeProject(
  config: Record<string, unknown> = { nodeModulesDir: "auto" },
): Promise<Awaited<ReturnType<typeof npmProject>>> {
  const project = await npmProject();
  await Deno.writeTextFile(join(project.dir, "deno.json"), JSON.stringify(config));
  await Deno.writeTextFile(
    join(project.installed, "index.js"),
    LEFT_PAD.replace('str + "-" + len', '"PATCHED:" + str + "-" + len'),
  );
  return project;
}

const readConfig = async (dir: string) =>
  JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
    patchedDependencies?: Record<string, string>;
  };

Deno.test("npm: on runtime 3.0.0-denext.3 create registers a package-relative patch in deno.json", async () => {
  const { dir, installed, pristine } = await runtimeProject({
    nodeModulesDir: "auto",
    patchedDependencies: { "other@1.0.0": "patches/other.patch" },
  });
  const lines: string[] = [];
  const opts = {
    npmPristine: () => Promise.resolve(pristine),
    log: (l: string) => void lines.push(l),
    runtime: "3.0.0-denext.3",
  };
  try {
    const created = await createNpmPatch(dir, "left-pad", opts);
    assertEquals(created.registered, "left-pad@1.3.0");
    assertEquals(lines, []);
    const copy = await Deno.readTextFile(join(dir, "patches", "npm", "left-pad+1.3.0.patch"));
    // What the runtime's applier reads: a `diff --git` section per file, paths in the package.
    assert(copy.startsWith("diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@"));
    assertStringIncludes(copy, '+  return "PATCHED:" + str + "-" + len;');
    assertEquals((await readConfig(dir)).patchedDependencies, {
      "other@1.0.0": "patches/other.patch",
      "left-pad@1.3.0": "patches/npm/left-pad+1.3.0.patch",
    });
    // The patch-package file is still written, and denext's boot apply stays a no-op.
    assertEquals((await listPatches(dir)).map((p) => p.name), ["left-pad"]);
    assertEquals(await applyPatches(dir, opts), { applied: [], unchanged: ["left-pad@1.3.0"] });

    // A re-create against another version replaces the registration and its copy.
    await Deno.writeTextFile(
      join(installed, "package.json"),
      `{ "name": "left-pad", "version": "1.4.0" }\n`,
    );
    await createNpmPatch(dir, "left-pad", opts);
    assertEquals((await readConfig(dir)).patchedDependencies, {
      "other@1.0.0": "patches/other.patch",
      "left-pad@1.4.0": "patches/npm/left-pad+1.4.0.patch",
    });
    assertEquals(
      [...Deno.readDirSync(join(dir, "patches", "npm"))].map((e) => e.name),
      ["left-pad+1.4.0.patch"],
    );

    // Delete drops the registration and the copy; the user's own entry stays.
    await deletePatch(dir, "left-pad");
    assertEquals((await readConfig(dir)).patchedDependencies, {
      "other@1.0.0": "patches/other.patch",
    });
    assertEquals([...Deno.readDirSync(join(dir, "patches", "npm"))], []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("npm: a workspace member registers in the workspace root's deno.json", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_patches_ws_" });
  const { dir, pristine } = await runtimeProject({ imports: {} });
  const member = join(root, "apps", "web");
  try {
    await Deno.mkdir(join(root, "apps"), { recursive: true });
    await Deno.rename(dir, member);
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ workspace: ["apps/web"], nodeModulesDir: "auto" }),
    );
    const opts = {
      npmPristine: () => Promise.resolve(pristine.replace(dir, member)),
      log: () => {},
      runtime: "3.0.0-denext.3",
    };
    const created = await createNpmPatch(member, "left-pad", opts);
    assertEquals(created.registered, "left-pad@1.3.0");
    assertEquals((await readConfig(root)).patchedDependencies, {
      "left-pad@1.3.0": "apps/web/patches/npm/left-pad+1.3.0.patch",
    });
    assertEquals((await readConfig(member)).patchedDependencies, undefined);
    await deletePatch(member, "left-pad");
    assertEquals((await readConfig(root)).patchedDependencies, undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("npm: no registration on an older runtime, without node_modules, or for an added file", async () => {
  // An older runtime: nothing beyond the patch-package file, and nothing said.
  {
    const { dir, pristine } = await runtimeProject();
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    try {
      const created = await createNpmPatch(dir, "left-pad", {
        npmPristine: () => Promise.resolve(pristine),
        log,
        runtime: "3.0.0-denext.2",
      });
      assertEquals(created.registered, undefined);
      assertEquals((await readConfig(dir)).patchedDependencies, undefined);
      assertEquals(lines, []);
      const none = await createNpmPatch(dir, "left-pad", {
        npmPristine: () => Promise.resolve(pristine),
        log,
        runtime: null,
      });
      assertEquals(none.registered, undefined);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
  // The runtime refuses to resolve without a node_modules directory, so it is never added there.
  {
    const { dir, pristine } = await runtimeProject({ imports: {} });
    const lines: string[] = [];
    try {
      const created = await createNpmPatch(dir, "left-pad", {
        npmPristine: () => Promise.resolve(pristine),
        log: (l) => void lines.push(l),
        runtime: "3.0.0-denext.3",
      });
      assertEquals(created.registered, undefined);
      assertEquals((await readConfig(dir)).patchedDependencies, undefined);
      assertEquals(lines.length, 1);
      assertStringIncludes(lines[0], "no node_modules directory");
      // A package.json project has one.
      await Deno.writeTextFile(join(dir, "package.json"), "{}");
      const again = await createNpmPatch(dir, "left-pad", {
        npmPristine: () => Promise.resolve(pristine),
        log: () => {},
        runtime: "3.0.0-denext.3",
      });
      assertEquals(again.registered, "left-pad@1.3.0");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
  // The runtime's applier changes existing files only: a patch that adds one keeps denext's
  // mechanism alone, and drops an earlier registration.
  {
    const { dir, installed, pristine } = await runtimeProject();
    const lines: string[] = [];
    const opts = {
      npmPristine: () => Promise.resolve(pristine),
      log: (l: string) => void lines.push(l),
      runtime: "3.0.0-denext.3",
    };
    try {
      assertEquals((await createNpmPatch(dir, "left-pad", opts)).registered, "left-pad@1.3.0");
      await Deno.writeTextFile(join(installed, "extra.js"), "module.exports = 1;\n");
      assertEquals((await createNpmPatch(dir, "left-pad", opts)).registered, undefined);
      assertStringIncludes(lines.join("\n"), "adds or deletes a file");
      assertEquals((await readConfig(dir)).patchedDependencies, undefined);
      assertEquals([...Deno.readDirSync(join(dir, "patches", "npm"))], []);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
