// Metro's `require.context` in React Native mode (src/build/require-context.ts). An Expo app that
// renders its own root (`<ExpoRoot context={require.context("./app")} />`, Tamagui's Expo starter)
// built, then threw "require.context is not a function" in the browser: esbuild has no such API.
// Each literal call is now a generated module listing the matching files. Bundled with esbuild
// over a temp app and run.

import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { requireContextPlugins, rewriteRequireContext } from "../src/build/require-context.ts";

async function bundle(files: Record<string, string>): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_require_context_" });
  try {
    for (const [rel, text] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), text);
    }
    const out = await esbuild.build({
      entryPoints: [join(dir, "index.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      plugins: requireContextPlugins(dir),
    });
    const code = out.outputFiles[0].text;
    return await import(`data:text/javascript;base64,${btoa(code)}`);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

const APP = {
  "app/_layout.js": 'export const name = "layout";\n',
  "app/index.js": 'export const name = "index";\n',
  "app/user/[id].js": 'export const name = "user";\n',
  "app/notes.md": "not a source file\n",
  "app/node_modules/x.js": "export const name = 'nm';\n",
};

Deno.test("require.context: Metro's defaults (recursive, every source file), sync", async () => {
  const mod = await bundle({
    ...APP,
    "index.js": 'const ctx = require.context("./app");\n' +
      "export const keys = ctx.keys();\n" +
      'export const user = ctx("./user/[id].js").name;\n' +
      'export const resolved = ctx.resolve("./index.js");\n' +
      "export let missing; try { ctx('./nope.js'); } catch (e) { missing = e.message; }\n",
  });
  assertEquals(mod.keys, ["./_layout.js", "./index.js", "./user/[id].js"]);
  assertEquals(mod.user, "user");
  assertEquals(mod.resolved, "./index.js");
  assertEquals(mod.missing, 'require.context: no module "./nope.js"');
});

Deno.test("require.context: recursive false, a regExp and the lazy mode", async () => {
  const mod = await bundle({
    ...APP,
    "index.js": "const flat = require.context('./app', false, /index\\.js$/);\n" +
      "const lazy = require.context('./app', true, /\\.js$/, 'lazy');\n" +
      "export const flatKeys = flat.keys();\n" +
      "export const lazyKeys = lazy.keys();\n" +
      'export const user = await lazy("./user/[id].js").then((m) => m.name);\n',
  });
  assertEquals(mod.flatKeys, ["./index.js"]);
  assertEquals(mod.lazyKeys, ["./_layout.js", "./index.js", "./user/[id].js"]);
  assertEquals(mod.user, "user");
});

Deno.test("rewriteRequireContext: a module without a literal call is left alone", async () => {
  assertEquals(rewriteRequireContext("const x = require('./a');\n", "/app/index.js"), null);
  assertEquals(rewriteRequireContext("require.context(dir);\n", "/app/index.js"), null);
  await assertRejects(
    () => bundle({ "index.js": "require.context(dynamicDir);\n" }),
    Error,
  );
});
