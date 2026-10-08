// SPA mode runs the configured `plugins` (src/build/spa/build.ts `preparePlugins`): `denext
// build` and `denext export` set each plugin up under their own mode, then run its prepare steps
// before the bundle, so a codegen step's output is there for the app to import. A prepare step
// gets a `PluginPrepareContext` (no emit seam). Build steps (`emitFile`) are covered in
// tests/plugin-emit.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { resetPlugins } from "../src/plugin/mod.ts";
import { staticExport } from "../src/build/export.ts";
import { build } from "../src/build/build.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/**
 * A plugin that records the mode it was set up under and registers a prepare step that writes
 * `src/generated.ts` (which the app imports) plus what its context carried.
 */
const CODEGEN_PLUGIN = `{
  name: "test-codegen",
  async setup(ctx) {
    await Deno.writeTextFile(ctx.projectRoot + "/setup-mode.txt", ctx.mode);
    ctx.addPrepareStep(async (p) => {
      await Deno.writeTextFile(
        p.projectRoot + "/src/generated.ts",
        'export const generated = "PREPARED_BY_PLUGIN";\\n',
      );
      await Deno.writeTextFile(
        p.projectRoot + "/prepare-context.json",
        JSON.stringify({ keys: Object.keys(p).sort(), spa: p.config.mode }),
      );
    });
  },
}`;

/** A SPA project whose entry imports the module the plugin's prepare step generates. */
async function spaProject(compat: boolean): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_spa_plugins_" }));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: compat ? "react" : "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/client": abs("src/client/mod.ts"),
        "react": abs("src/compat/react.ts"),
        "react/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default { mode: "spa"${compat ? ", compatibilityMode: true" : ""}, ` +
      `plugins: [${CODEGEN_PLUGIN}], spa: { entry: "./src/main.ts" } };\n`,
  );
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(
    join(dir, "src/main.ts"),
    `import { generated } from "./generated.ts";\nconsole.log(generated);\n`,
  );
  return dir;
}

/** Every `.js` file under `dir` (recursively), concatenated. */
async function allJs(dir: string): Promise<string> {
  let text = "";
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) text += await allJs(p);
    else if (e.name.endsWith(".js")) text += await Deno.readTextFile(p);
  }
  return text;
}

for (const compat of [false, true]) {
  const path = compat ? "esbuild" : "native";
  for (const mode of ["export", "build"] as const) {
    Deno.test({
      name: `SPA ${mode} (${path} path): plugins are set up and their prepare steps run first`,
      sanitizeResources: false,
      sanitizeOps: false,
    }, async () => {
      resetPlugins();
      const dir = await spaProject(compat);
      try {
        if (mode === "export") await staticExport(dir);
        else await build(dir);
        assertEquals(await Deno.readTextFile(join(dir, "setup-mode.txt")), mode);
        // The prepare step ran before the bundle: the module it wrote is in the client code.
        const client = await allJs(join(dir, mode === "export" ? "out" : ".denext"));
        assertStringIncludes(client, "PREPARED_BY_PLUGIN");
        const seen = JSON.parse(await Deno.readTextFile(join(dir, "prepare-context.json")));
        assertEquals(seen.keys, ["appDir", "config", "outDir", "projectRoot"]);
        assertEquals(seen.spa, "spa");
        assert(!seen.keys.includes("emitFile"), "a prepare step has no emit seam");
      } finally {
        resetPlugins();
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
}
