// `resolveAlias` (src/build/resolve-alias.ts): module aliases for the esbuild bundles, optionally
// importer-sensitive (`except`: packages whose own imports keep the original). The uniwind shape
// (`react-native` → its web components, except inside uniwind) is expressed in config alone;
// exercised through real esbuild bundles over temp `node_modules` fixtures, and a SPA export.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join, toFileUrl } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { BROWSER_CONDITIONS, catalogResolverPlugin } from "../src/build/next-compat.ts";
import { reactNativeWebPlugin } from "../src/build/react-native.ts";
import { aliasRules, isPackageFile, resolveAliasPlugins } from "../src/build/resolve-alias.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { ResolveAliasConfig } from "../src/server/config.ts";
import { exportInChild } from "./helpers/bounded-build.ts";

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

Deno.test("aliasRules: the string and object forms normalize; none is null", () => {
  assertEquals(aliasRules(undefined), null);
  assertEquals(aliasRules({}), null);
  const rules = aliasRules({ a: "./x.ts", b: { to: "pkg/sub", except: ["pkg"] } })!;
  assertEquals(rules.get("a"), { to: "./x.ts", except: [] });
  assertEquals(rules.get("b"), { to: "pkg/sub", except: ["pkg"] });
});

Deno.test("isPackageFile: plain, pnpm and scoped layouts", () => {
  assert(isPackageFile("/app/node_modules/uniwind/dist/a.js", "uniwind"));
  assert(
    isPackageFile("/app/node_modules/.pnpm/uniwind@1.0.0/node_modules/uniwind/a.js", "uniwind"),
  );
  assert(isPackageFile("/app/node_modules/@scope/pkg/a.js", "@scope/pkg"));
  assert(!isPackageFile("/app/node_modules/uniwind-extra/a.js", "uniwind"));
  assert(!isPackageFile("/app/src/uniwind/a.js", "uniwind"));
});

Deno.test("config validation: both forms pass, a bad shape names its field", () => {
  validateDenextConfig({
    resolveAlias: {
      "react-native": { to: "uniwind/components/web", except: ["uniwind"] },
      x: "./y",
    },
  });
  assertThrows(
    () => validateDenextConfig({ resolveAlias: { x: { to: "" } } }),
    Error,
    '`resolveAlias["x"].to` must name a module',
  );
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => validateDenextConfig({ resolveAlias: { x: { to: "y", except: "z" } } as any }),
    Error,
    "except` must be an array of package names",
  );
});

const RNW = "node_modules/react-native-web";
const UW = "node_modules/uniwind";

/** react-native-web, and a uniwind whose web components wrap it. */
const FIXTURE: Record<string, string> = {
  "deno.json": "{}\n",
  [`${RNW}/package.json`]: JSON.stringify({ name: "react-native-web", module: "dist/index.js" }),
  [`${RNW}/dist/index.js`]: 'export const View = "RNW_VIEW";\n',
  [`${UW}/package.json`]: JSON.stringify({
    name: "uniwind",
    exports: { "./components/web": "./dist/web.js" },
  }),
  [`${UW}/dist/web.js`]: 'export * from "react-native";\nexport const wrapped = "UNIWIND_WEB";\n',
  "src/shim.ts": 'export const shim = "LOCAL_SHIM";\n',
  "entry.js":
    'import { View, wrapped } from "react-native";\nimport { shim } from "legacy-sdk";\n' +
    "export const result = { View, wrapped, shim };\n",
};

/** Bundle the fixture's entry with `resolveAlias` ahead of the RN resolver, and run it. */
async function run(alias: ResolveAliasConfig): Promise<Record<string, unknown>> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_resolve_alias_" }));
  try {
    await writeTree(dir, FIXTURE);
    const out = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: [
        ...resolveAliasPlugins(dir, alias),
        reactNativeWebPlugin(dir),
        catalogResolverPlugin(dir, "all", BROWSER_CONDITIONS),
      ],
    });
    const code = new TextDecoder().decode(out.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return (await import(url)).result;
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("resolveAlias: an importer-sensitive alias wraps the module it replaces", async () => {
  const r = await run({
    "react-native": { to: "uniwind/components/web", except: ["uniwind"] },
    "legacy-sdk": "./src/shim.ts",
  });
  assertEquals(r.wrapped, "UNIWIND_WEB", "the app's react-native is uniwind's components");
  assertEquals(r.View, "RNW_VIEW", "which reach react-native-web (uniwind's own import kept)");
  assertEquals(r.shim, "LOCAL_SHIM", "a ./ target is the project's file");
});

Deno.test({
  name: "resolveAlias: a SPA compat export applies the configured aliases",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_resolve_alias_spa_" });
  const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;
  try {
    await writeTree(dir, {
      "deno.json": JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
        imports: {
          "denext": abs("mod.ts"),
          "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
          "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
          "denext/server": abs("src/server/mod.ts"),
          "denext/client": abs("src/client/mod.ts"),
          "react": abs("src/compat/react.ts"),
        },
      }),
      "package.json": JSON.stringify({ name: "app", dependencies: { "kit": "1.0.0" } }),
      "node_modules/kit/package.json": JSON.stringify({ name: "kit", module: "index.js" }),
      "node_modules/kit/index.js": 'export const kit = "REAL_KIT";\n',
      "node_modules/kit-web/package.json": JSON.stringify({ name: "kit-web", module: "index.js" }),
      "node_modules/kit-web/index.js":
        'import { kit } from "kit";\nexport const wrappedKit = "WEB_KIT+" + kit;\nexport { kit };\n',
      "denext.config.ts": `export default { mode: "spa", compatibilityMode: true, ` +
        `spa: { entry: "./src/main.ts" }, ` +
        `resolveAlias: { kit: { to: "kit-web", except: ["kit-web"] } } };\n`,
      "src/main.ts": `import { kit, wrappedKit } from "kit";\n` +
        `(globalThis as Record<string, unknown>).k = [kit, wrappedKit];\n`,
    });
    const { outDir } = await exportInChild(dir);
    const client = join(outDir, "_denext", "client");
    let js = "";
    for await (const e of Deno.readDir(client)) {
      if (e.isFile && e.name.endsWith(".js")) js += await Deno.readTextFile(join(client, e.name));
    }
    assertStringIncludes(js, "WEB_KIT+");
    assertStringIncludes(js, "REAL_KIT");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "resolveAlias: a target that is an import-map entry resolves (a npm package gets it too)",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_resolve_alias_map_" });
  const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;
  try {
    await writeTree(dir, {
      "deno.json": JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
        imports: {
          "denext": abs("mod.ts"),
          "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
          "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
          "denext/server": abs("src/server/mod.ts"),
          "denext/client": abs("src/client/mod.ts"),
          "react": abs("src/compat/react.ts"),
          // A file URL, as `--denext-local-path` maps `denext/*` entries.
          "app/kit-shim": toFileUrl(join(dir, "src", "kit-shim.ts")).href,
        },
      }),
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { "kit": "1.0.0", "lib": "1.0.0" },
      }),
      "node_modules/kit/package.json": JSON.stringify({ name: "kit", module: "index.js" }),
      "node_modules/kit/index.js": 'export const kit = "REAL_KIT";\n',
      "node_modules/lib/package.json": JSON.stringify({ name: "lib", module: "index.js" }),
      "node_modules/lib/index.js":
        'import { kit } from "kit";\nexport const viaLib = "LIB+" + kit;\n',
      "src/kit-shim.ts": 'export const kit = "SHIM_KIT";\n',
      "denext.config.ts": `export default { mode: "spa", compatibilityMode: true, ` +
        `spa: { entry: "./src/main.ts" }, resolveAlias: { kit: "app/kit-shim" } };\n`,
      "src/main.ts": `import { kit } from "kit";\nimport { viaLib } from "lib";\n` +
        `(globalThis as Record<string, unknown>).k = [kit, viaLib];\n`,
    });
    const { outDir } = await exportInChild(dir);
    const client = join(outDir, "_denext", "client");
    let js = "";
    for await (const e of Deno.readDir(client)) {
      if (e.isFile && e.name.endsWith(".js")) js += await Deno.readTextFile(join(client, e.name));
    }
    assertStringIncludes(js, "SHIM_KIT");
    assertEquals(js.includes("REAL_KIT"), false, "the npm package's import is aliased too");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
