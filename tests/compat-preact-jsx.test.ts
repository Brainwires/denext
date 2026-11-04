// A Preact app on the compat (esbuild) path compiles its JSX with Preact's runtime. `denext
// migrate` writes `compilerOptions.jsxImportSource: "preact"` for a Preact or Fresh app and maps
// `preact/jsx-runtime` to `denext/preact/jsx-runtime` (Preact's `options.vnode` / `options.event`
// hooks, signals bound as DOM props). The compat bundle used to compile every app's JSX against
// `react/jsx-runtime` (denext's own runtime), so a migrated Preact app with node_modules (the
// compat SPA path) never ran those hooks: create-preact's migration bed lost its `options.vnode`.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { compatJsxImportSource } from "../src/build/next-compat.ts";
import { inChild } from "./helpers/isolated.ts";

const REPO = new URL("../", import.meta.url);
const src = (path: string) => new URL(path, REPO).href;

Deno.test("compatJsxImportSource: preact only when the app's config says so", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_compat_jsx_" });
  try {
    const at = (name: string) => join(dir, name);
    await Deno.writeTextFile(
      at("deno.jsonc"),
      `{\n  // a Preact app\n  "compilerOptions": { "jsxImportSource": "preact", },\n}\n`,
    );
    assertEquals(await compatJsxImportSource(at("deno.jsonc")), "preact");
    assertEquals(await compatJsxImportSource(toFileUrl(at("deno.jsonc")).href), "preact");
    await Deno.writeTextFile(
      at("deno.json"),
      JSON.stringify({ compilerOptions: { jsxImportSource: "@emotion/react" } }),
    );
    assertEquals(await compatJsxImportSource(at("deno.json")), "react");
    await Deno.writeTextFile(at("bad.json"), "{ not json");
    assertEquals(await compatJsxImportSource(at("bad.json")), "react");
    assertEquals(await compatJsxImportSource(at("missing.json")), "react");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** What the compat client bundle's `src/main.tsx` imports (esbuild's paths), for a given config. */
async function mainImports(jsxImportSource?: string): Promise<string[]> {
  const dir = await Deno.makeTempDir({ prefix: "denext_compat_preact_" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", ...(jsxImportSource ? { jsxImportSource } : {}) },
        imports: {
          "preact": src("src/compat/preact/mod.ts"),
          "preact/jsx-runtime": src("src/compat/preact/jsx-runtime.ts"),
        },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default { mode: "spa", spa: { entry: "./src/main.tsx" }, compatibilityMode: true };\n`,
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "src", "main.tsx"),
      `import { options, render } from "preact";\n` +
        `options.vnode = (v) => { if (v.type === "main") v.props["data-marked"] = ""; };\n` +
        `render(<main>app</main>, document.getElementById("root")!);\n`,
    );
    // `DENEXT_ANALYZE=1` keeps the client bundle's esbuild metafile (`analyze-meta.json`).
    await inChild({
      env: { DENEXT_ANALYZE: "1" },
      imports: `import { staticExport } from "@repo/src/build/export.ts";`,
      body: `await staticExport(${JSON.stringify(dir)}); return null;`,
    });
    const meta = JSON.parse(
      await Deno.readTextFile(join(dir, "out", "_denext", "analyze-meta.json")),
    ) as { inputs: Record<string, { imports: { path: string }[] }> };
    const main = Object.entries(meta.inputs).find(([k]) => k.endsWith("src/main.tsx"));
    assert(main, `no src/main.tsx input in ${Object.keys(meta.inputs).join(", ")}`);
    return main[1].imports.map((i) => i.path.replaceAll("\\", "/"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("compat SPA: jsxImportSource preact compiles the app's JSX with Preact's runtime", async () => {
  // Preact's runtime: its source module, or the prebuilt runtime file a `denext/*` import reaches.
  const preactRuntime = (p: string) =>
    p.endsWith("src/compat/preact/jsx-runtime.ts") || p.endsWith("/preact-jsx-runtime.js");
  const preact = await mainImports("preact");
  assert(preact.some(preactRuntime), preact.join(", "));
  // Without it the app's JSX stays on denext's own runtime, as before.
  const plain = await mainImports();
  assert(!plain.some(preactRuntime), plain.join(", "));
});
