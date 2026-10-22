// The next-compat server bundle pins each app module's `import.meta` to its source file
// (src/build/compat-import-meta.ts). The end-to-end case (a route reading a font beside itself,
// served by `denext start` after the project moved) is
// tests/integration/next-compat-import-meta-url.test.ts; the compiled binary's is in
// tests/integration/compile-compat.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { pinImportMetaPlugins } from "../src/build/compat-import-meta.ts";

const FILES: Record<string, string> = {
  ".denext/server/.entries/app.ts": [
    `export * as route from "../../../app/route.ts";`,
    `export * as claimed from "../../../app/claimed.ts";`,
    `export * as view from "../../../app/view.js";`,
    `export * as typed from "../../../app/typed.mts";`,
    `export * as none from "../../../app/none.ts";`,
    `export * as pkg from "../../../node_modules/pkg/index.js";`,
    `export const gen = import.meta.url;`,
  ].join("\n"),
  "app/route.ts": `export const url = import.meta.url;\nexport const dir = import.meta.dirname;\n`,
  "app/claimed.ts": `export const placeholder = 0;\n`,
  "app/view.js": `export const el = <i>{import.meta.url}</i>;\n`,
  "app/typed.mts": `export const typed: string = import.meta.filename;\n`,
  "app/none.ts": `export const none = 1;\n`,
  "node_modules/pkg/index.js": `export const pkg = import.meta.url;\n`,
};

/** A caller plugin answering claimed.ts first (as bytes): its result is pinned too. */
const caller: esbuild.Plugin = {
  name: "caller",
  setup(build) {
    build.onLoad({ filter: /claimed\.ts$/ }, () => ({
      contents: new TextEncoder().encode(`export const claimed = import.meta.url;\n`),
      loader: "ts",
    }));
    build.onLoad({ filter: /none\.ts$/ }, () => undefined);
  },
};

async function bundle(dir: string, outdir: string | undefined): Promise<string> {
  const out = await esbuild.build({
    entryPoints: { app: join(dir, ".denext/server/.entries/app.ts") },
    outdir: join(dir, ".denext/server"),
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    jsxImportSource: "react",
    external: ["react", "react/*"],
    absWorkingDir: dir,
    logLevel: "silent",
    plugins: pinImportMetaPlugins([caller], {
      projectDir: dir,
      buildDir: join(dir, ".denext"),
      outdir,
      jsxInJs: true,
    }),
  });
  return new TextDecoder().decode(out.outputFiles[0].contents);
}

Deno.test("pinImportMetaPlugins: the app's modules keep their source file's import.meta", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_meta_pin_" }));
  try {
    for (const [rel, src] of Object.entries(FILES)) {
      await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), src);
    }
    // Relative to the bundle: the project and its `.denext` move together.
    const rel = await bundle(dir, join(dir, ".denext/server"));
    for (const file of ["route.ts", "claimed.ts", "view.js", "typed.mts"]) {
      assertStringIncludes(rel, `new URL("../../app/${file}", import.meta.url).href`);
    }
    assertStringIncludes(rel, "__dnxDirname(", "dirname is computed from the pinned URL");
    assertStringIncludes(rel, "__dnxFileUrlToPath(", "filename too");
    assert(!rel.includes(dir), "no build-machine path in a relocatable bundle");
    // node_modules and the build dir's generated modules keep the bundle's own URL.
    assertStringIncludes(rel, "var pkg = import.meta.url;");
    assertStringIncludes(rel, "var gen = import.meta.url;");

    // Absolute (an entry not written straight into the outdir).
    const abs = await bundle(dir, undefined);
    assertStringIncludes(abs, JSON.stringify(toFileUrl(join(dir, "app/route.ts")).href));
    assertStringIncludes(abs, JSON.stringify(join(dir, "app")), "import.meta.dirname");
    assertStringIncludes(abs, "var pkg = import.meta.url;");
    assertEquals(abs.includes("__dnxDirname("), false);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
