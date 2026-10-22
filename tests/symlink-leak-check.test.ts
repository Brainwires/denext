// The client bundles' server-code checks under a symlinked spelling (macOS `/var` →
// `/private/var`, so every `$TMPDIR` project; a symlinked home or workspace folder). The bundlers
// hand the checks real paths while a project, a boundary or a temp dir may be named through the
// link: compared as given, a stubbed `"use server"` module counted as unstubbed (the build failed
// with "a 'use server' module would ship") and a real server-only leak counted as outside the
// app (the build passed). Each check compares canonical spellings.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { serverStubPlugin } from "../src/build/next-compat.ts";
import { clientImportMap, generateServerStub } from "../src/build/client-imports.ts";
import { findServerOnlyLeaks } from "../src/build/server-only-scan.ts";

/**
 * A real temp dir `real` and a symlink `link` to it (in a second temp dir), or `null` when this
 * host can't create one: the test then logs why it skips. On Windows it is a junction, which
 * needs no privilege.
 */
async function linkedDir(): Promise<{ real: string; link: string; cleanup: () => void } | null> {
  const real = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-leak-real-" }));
  const hold = await Deno.makeTempDir({ prefix: "denext-leak-link-" });
  const cleanup = () => {
    Deno.removeSync(hold, { recursive: true });
    Deno.removeSync(real, { recursive: true });
  };
  const link = join(hold, "link");
  try {
    await Deno.symlink(real, link, { type: "junction" });
  } catch (err) {
    cleanup();
    console.warn(`skipped: this host can't create a directory symlink (${err})`);
    return null;
  }
  return { real, link, cleanup };
}

Deno.test("serverStubPlugin: an action registered through a symlink is stubbed", async () => {
  const made = await linkedDir();
  if (!made) return;
  try {
    await Deno.writeTextFile(
      join(made.real, "known.ts"),
      `"use server";\nexport const k = () => "K_SECRET";\n`,
    );
    await Deno.writeTextFile(
      join(made.real, "other.ts"),
      `"use server";\nexport const o = () => "O_SECRET";\n`,
    );
    await Deno.writeTextFile(join(made.real, "entry.ts"), `export * from "./known.ts";\n`);
    await Deno.writeTextFile(join(made.real, "entry2.ts"), `export * from "./other.ts";\n`);
    const build = (entryDir: string, entry: string) =>
      esbuild.build({
        entryPoints: [join(entryDir, entry)],
        bundle: true,
        write: false,
        format: "esm",
        absWorkingDir: entryDir,
        external: ["denext/*"],
        logLevel: "silent",
        // The boundary names the module through the link; esbuild loads it by its real path.
        plugins: [serverStubPlugin(
          [["k1", { url: toFileUrl(join(made.link, "known.ts")).href, exports: ["k"] }]],
          generateServerStub,
        )],
      });
    for (const entryDir of [made.link, made.real]) {
      const ok = await build(entryDir, "entry.ts");
      const text = new TextDecoder().decode(ok.outputFiles[0].contents);
      assertEquals(text.includes("K_SECRET"), false, `entry through ${entryDir}`);
      assertStringIncludes(text, "clientActionStub");
    }
    // A module the boundary does not hold is still refused through the link.
    const err = await assertRejects(() => build(made.link, "entry2.ts"));
    assertStringIncludes(String(err), `a "use server" module would ship to the browser`);
  } finally {
    await esbuild.stop();
    made.cleanup();
  }
});

Deno.test("findServerOnlyLeaks: a leak is caught whichever side is named through a symlink", async () => {
  const made = await linkedDir();
  if (!made) return;
  try {
    await Deno.mkdir(join(made.real, "app"));
    await Deno.writeTextFile(
      join(made.real, "app", "leak.ts"),
      `import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n`,
    );
    await Deno.writeTextFile(join(made.real, "app", "clean.ts"), `export const c = 1;\n`);
    for (const projectDir of [made.real, made.link]) {
      for (const shippedDir of [made.real, made.link]) {
        const leaks = await findServerOnlyLeaks(
          [join(shippedDir, "app", "leak.ts"), join(shippedDir, "app", "clean.ts")],
          projectDir,
        );
        assertEquals(
          leaks,
          [{ module: join(shippedDir, "app", "leak.ts"), signals: ["node-import"] }],
          `project ${projectDir}, shipped ${shippedDir}`,
        );
      }
    }
    // A module outside the project is never the app's, in any spelling.
    assertEquals(
      await findServerOnlyLeaks([join(made.link, "app", "leak.ts")], join(made.real, "other")),
      [],
    );
  } finally {
    made.cleanup();
  }
});

Deno.test("clientImportMap: a server module named through a symlink is stubbed at its real URL too", async () => {
  const made = await linkedDir();
  if (!made) return;
  const scratch = await Deno.makeTempDir({ prefix: "denext-leak-map-" });
  try {
    await Deno.writeTextFile(join(made.real, "act.ts"), `"use server";\nexport const a = 1;\n`);
    const { importMap } = await clientImportMap({
      projectDir: null,
      server: [["a1", { url: toFileUrl(join(made.link, "act.ts")).href, exports: ["a"] }]],
      dir: scratch,
    });
    const stub = importMap[toFileUrl(join(made.link, "act.ts")).href];
    assertEquals(typeof stub, "string");
    // Deno resolves the import to the real path: that spelling (and its extensionless form)
    // must reach the same stub.
    assertEquals(importMap[toFileUrl(join(made.real, "act.ts")).href], stub);
    assertEquals(importMap[toFileUrl(join(made.real, "act")).href], stub);
  } finally {
    await Deno.remove(scratch, { recursive: true });
    made.cleanup();
  }
});
