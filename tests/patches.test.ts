// `denext patch` core (src/build/patches.ts): npm patches created from node_modules vs a
// pristine copy and re-applied idempotently; the denext patch edited via working copies,
// materialized with absolutized imports and import-mapped in deno.json; the esbuild plugin
// that feeds the patched framework source to a bundle; delete undoing both.

import * as esbuild from "esbuild";
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
  patchFileName,
  patchPlugin,
  revertNpmPatch,
} from "../src/build/patches.ts";

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
      `import { doc } from "${
        join(fw, "src", "server", "document.ts")
      }";\nconsole.log(doc({ title: "x" }));\n`,
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
