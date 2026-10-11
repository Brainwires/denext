// Unit tests for the compile-time feature-flag fold (src/build/feature-transform.ts):
// `feature("KEY")` folds to a boolean literal for configured keys, passes through otherwise,
// and never touches a module that doesn't import `denext/feature`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { compileFeatureModules, transformFeatures } from "../src/build/feature-transform.ts";
import { clientTransforms } from "../src/build/build-pipeline/transforms.ts";
import { computeBoundaryRoutes, resetModuleGraphCache } from "../src/build/module-graph.ts";
import { resolveProject } from "../src/build/paths.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { bundleSourceFiles } from "../src/build/bundle.ts";
import { spaSourceTransformPlugin } from "../src/build/spa-compiler-plugin.ts";
import { createUnbundledDev } from "../src/build/dev-unbundled.ts";
import { staticExport } from "../src/build/export.ts";
import type * as esbuild from "esbuild";

const IMPORT = `import { feature } from "denext/feature";\n`;

Deno.test("folds a configured true flag to the literal", async () => {
  const src = `${IMPORT}export const on = feature("NEW_UI") ? "a" : "b";\n`;
  const { code, changed } = await transformFeatures(src, { NEW_UI: true });
  assertEquals(changed, true);
  assertStringIncludes(code, "true ?");
  assertEquals(code.includes('feature("NEW_UI")'), false);
});

Deno.test("folds a configured false flag to the literal", async () => {
  const src = `${IMPORT}if (feature("OLD")) { drop(); }\n`;
  const { code, changed } = await transformFeatures(src, { OLD: false });
  assertEquals(changed, true);
  assertStringIncludes(code, "if (false)");
});

Deno.test("leaves an unconfigured key as a runtime call", async () => {
  const src = `${IMPORT}export const v = feature("UNSET");\n`;
  const { code, changed } = await transformFeatures(src, { OTHER: true });
  assertEquals(changed, false);
  assertStringIncludes(code, 'feature("UNSET")');
});

Deno.test("honors an aliased import binding", async () => {
  const src = `import { feature as flag } from "denext/feature";\nexport const v = flag("X");\n`;
  const { code, changed } = await transformFeatures(src, { X: true });
  assertEquals(changed, true);
  assertStringIncludes(code, "export const v = true;");
});

Deno.test("ignores a same-named call not bound to denext/feature", async () => {
  const src = `function feature(_: string) { return false; }\nexport const v = feature("X");\n`;
  const { changed } = await transformFeatures(src, { X: true });
  assertEquals(changed, false);
});

Deno.test("does NOT fold a call shadowed by a local param of the same name", async () => {
  // `feature` is imported, but the inner `pick(feature)` param shadows it — that call is not
  // the helper and must be left alone.
  const src = `${IMPORT}export function pick(feature: (k: string) => boolean) {\n` +
    `  return feature("X");\n}\n`;
  const { changed } = await transformFeatures(src, { X: true });
  assertEquals(changed, false);
});

Deno.test("ignores a non-literal argument", async () => {
  const src = `${IMPORT}export const v = (k: string) => feature(k);\n`;
  const { changed } = await transformFeatures(src, { X: true });
  assertEquals(changed, false);
});

Deno.test("absolutizes relative imports only when relocating a folded module", async () => {
  const src = `${IMPORT}import { x } from "./sib.ts";\nexport const v = feature("X") ? x : 0;\n`;
  const url = "file:///proj/app/mod.ts";
  const { code, changed } = await transformFeatures(src, { X: true }, { moduleUrl: url });
  assertEquals(changed, true);
  assertStringIncludes(code, "file:///proj/app/sib.ts");
});

Deno.test("a module without the import is returned verbatim", async () => {
  const src = `export const v = 1;\n`;
  const { code, changed } = await transformFeatures(src, { X: true });
  assertEquals(changed, false);
  assertEquals(code, src);
});

// End-to-end: the native path (compileFeatureModules → import-map redirect → `deno bundle`).
// An OFF flag must remove the gated branch AND the module it alone imports; an ON flag keeps it.
// Shells out to `deno bundle`, so give it room.
async function bundleWithFold(flag: boolean): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_feature_" });
  const root = new URL("../", import.meta.url).href; // repo root
  const modPath = join(dir, "mod.ts");
  const markerPath = join(dir, "marker.ts");
  await Deno.writeTextFile(markerPath, `export const gated = () => "GATED_MARKER_TOKEN";\n`);
  await Deno.writeTextFile(
    modPath,
    `import { feature } from "denext/feature";\n` +
      `import { gated } from "./marker.ts";\n` +
      `export function run() { if (feature("FLAG")) { console.log(gated()); } }\n`,
  );
  const modUrl = toFileUrl(modPath).href;
  const featureMap = await compileFeatureModules([modPath], {}, {
    outDir: dir,
    features: { FLAG: flag },
  });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: { "denext/feature": `${root}src/feature.ts`, ...featureMap },
    }),
  );
  try {
    // Retain `run` (assign it to a global) so it isn't tree-shaken as unused — then the flag,
    // not dead-code removal of an uncalled export, decides whether the gated branch survives.
    const entry =
      `import { run } from "${modUrl}";\n(globalThis as Record<string, unknown>).run = run;\n`;
    const out = await bundleSourceFiles(entry, { configPath: join(dir, "deno.json") });
    return [...out.files.values()].join("\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Drive the SPA transform plugin's `onLoad` on one file, as esbuild would. */
async function loadThrough(
  plugin: esbuild.Plugin | undefined,
  path: string,
): Promise<string | undefined> {
  assert(plugin, "the feature fold is enabled for this config");
  type OnLoad = (args: { path: string }) => Promise<{ contents: string } | null>;
  const loads: Array<{ filter: RegExp; fn: OnLoad }> = [];
  plugin.setup(
    {
      initialOptions: {},
      onLoad: ({ filter }: { filter: RegExp }, fn: OnLoad) => loads.push({ filter, fn }),
      onResolve: () => {},
    } as unknown as esbuild.PluginBuild,
  );
  // esbuild runs the first `onLoad` whose filter matches.
  const load = loads.find((l) => l.filter.test(path));
  assert(load, `the plugin registered no onLoad for ${path}`);
  return (await load.fn({ path }))?.contents;
}

Deno.test("the fold reads the top-level `features` config key", async () => {
  // `features` graduated out of `experimental` in 2.5, and the legacy spelling was removed in
  // 3.0: only the top-level key drives the fold.
  const dir = await Deno.makeTempDir({ prefix: "denext_feature_cfg_" });
  try {
    const file = join(dir, "App.tsx");
    await Deno.writeTextFile(
      file,
      `${IMPORT}export const on = feature("FLAG");
`,
    );
    const graduated = await loadThrough(
      spaSourceTransformPlugin(dir, { features: { FLAG: true } }),
      file,
    );
    assertStringIncludes(graduated ?? "", "export const on = true;");
    // No flags configured anywhere → the plugin is not even installed.
    assertEquals(spaSourceTransformPlugin(dir, {}), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// The build's fold covers a plain `.ts` / `.mts` / `.js` / `.mjs` module a client bundle can
// contain (a hook or store calling `feature()`), not just `.tsx` / `.jsx`; a module only the
// server tree reaches is left alone (it reads the flag at runtime).
Deno.test("clientTransforms (features): client .ts/.mts/.js/.mjs modules are folded, server-only ones are not", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_feature_sources_" }));
  const flagged = (name: string) => `${IMPORT}export const ${name} = feature("FLAG");\n`;
  const files: Record<string, string> = {
    // A Flight route: the island and its modules ship, the page's data module does not.
    "app/page.tsx":
      `import { Island } from "./island.tsx";\nimport { serverOnly } from "./data.ts";\n` +
      `export default function Page() { return [serverOnly, Island]; }\n`,
    "app/data.ts": flagged("serverOnly"),
    "app/island.tsx": `"use client";\n${IMPORT}import { a } from "./a.ts";\n` +
      `import { b } from "./b.mts";\nimport { c } from "./c.js";\nimport { d } from "./d.mjs";\n` +
      `export function Island() { return [feature("FLAG"), a, b, c, d]; }\n`,
    "app/a.ts": flagged("a"),
    "app/b.mts": flagged("b"),
    "app/c.js": flagged("c"),
    "app/d.mjs": flagged("d"),
  };
  try {
    for (const [name, src] of Object.entries(files)) {
      await Deno.mkdir(join(dir, name, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, name), src);
    }
    const paths = await resolveProject(dir);
    const manifest = await scanRoutes(paths.appDir);
    const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
    assertEquals([...flightRoutes], ["/"]);
    const map = await clientTransforms({
      projectDir: dir,
      paths: { ...paths, config: { features: { FLAG: true } } },
      manifest,
      flightRoutes,
    });
    const url = (p: string) => toFileUrl(join(dir, p)).href;
    for (const p of ["app/island.tsx", "app/a.ts", "app/b.mts", "app/c.js", "app/d.mjs"]) {
      assert(map[url(p)], `${p} was not folded`);
      const code = await Deno.readTextFile(new URL(map[url(p)]));
      assertEquals(code.includes('feature("FLAG")'), false, `${p} kept the call`);
    }
    assertEquals(map[url("app/data.ts")], undefined, "app/data.ts (server-only) was folded");
  } finally {
    resetModuleGraphCache();
    await Deno.remove(dir, { recursive: true });
  }
});

// `denext dev` serves each first-party module through the unbundled loop's per-module
// transform, which folds `feature()` whatever the module's extension: a plain `.ts` / `.mts` /
// `.js` / `.mjs` hook or store reads the configured value in dev, as it does in a build. Both the
// App Router loop and the SPA loop (`spaIslands`) are covered.
for (const spaIslands of [false, true]) {
  Deno.test(`unbundled dev (${spaIslands ? "SPA" : "App Router"}): .ts/.mts/.js/.mjs modules are folded`, async () => {
    const root = new URL("../", import.meta.url);
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_feature_dev_" }));
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": new URL("mod.ts", root).href,
          "denext/feature": new URL("src/feature.ts", root).href,
          "denext/jsx-runtime": new URL("src/jsx/jsx-runtime.ts", root).href,
          "denext/jsx-dev-runtime": new URL("src/jsx/jsx-runtime.ts", root).href,
          "denext/client": new URL("src/client/mod.ts", root).href,
        },
      }),
    );
    const modules = ["a.ts", "b.mts", "c.js", "d.mjs"];
    for (const name of modules) {
      await Deno.writeTextFile(
        join(dir, "src", name),
        `${IMPORT}export const on = feature("FLAG") ? "on" : "off";\n`,
      );
    }
    const dev = createUnbundledDev({
      projectDir: dir,
      appDir: join(dir, "src"),
      configPath: join(dir, "deno.json"),
      outDir: join(dir, ".denext"),
      compat: false,
      features: { FLAG: true },
      spaIslands,
    });
    try {
      for (const name of modules) {
        const { code } = await dev._internal.transform(join(dir, "src", name), "web");
        assertEquals(code.includes('feature("FLAG")'), false, `${name} kept the call:\n${code}`);
        assert(/\btrue\b/.test(code), `${name} has the folded literal:\n${code}`);
      }
    } finally {
      await dev.stop();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("e2e: an OFF flag DCEs the gated branch + its import from deno bundle", async () => {
  const all = await bundleWithFold(false);
  assert(!all.includes("GATED_MARKER_TOKEN"), "gated code must be eliminated when the flag is off");
});

Deno.test("e2e: an ON flag keeps the gated branch in deno bundle", async () => {
  const all = await bundleWithFold(true);
  assertStringIncludes(all, "GATED_MARKER_TOKEN");
});

// The SPA compat (esbuild) production build folds `feature()` in the app's plain `.ts` / `.mts` /
// `.js` / `.mjs` modules too, not only its `.tsx` / `.jsx` components: an OFF flag's branch (and
// the marker string it alone carries) is gone from the shipped bundle.
Deno.test({
  name: "SPA export (esbuild path): feature() folds in .ts/.mts/.js/.mjs modules",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_feature_" });
  const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;
  const gated = (name: string) =>
    `${IMPORT}export function ${name}() {\n` +
    `  if (feature("FLAG")) return "OFF_BRANCH_${name.toUpperCase()}";\n` +
    `  return "KEPT_${name.toUpperCase()}";\n}\n`;
  const files: Record<string, string> = {
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/feature": abs("src/feature.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
        "react": abs("src/compat/react.ts"),
        "react/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
      },
    }),
    "denext.config.ts": `export default { mode: "spa", compatibilityMode: true, ` +
      `features: { FLAG: false }, spa: { entry: "./src/main.ts" } };\n`,
    "src/main.ts": `import { a } from "./a.ts";\nimport { b } from "./b.mts";\n` +
      `import { c } from "./c.js";\nimport { d } from "./d.mjs";\n` +
      `(globalThis as Record<string, unknown>).fns = [a, b, c, d];\n`,
    "src/a.ts": gated("a"),
    "src/b.mts": gated("b"),
    "src/c.js": gated("c"),
    "src/d.mjs": gated("d"),
  };
  try {
    for (const [name, src] of Object.entries(files)) {
      await Deno.mkdir(join(dir, name, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, name), src);
    }
    await staticExport(dir);
    const client = join(dir, "out", "_denext", "client");
    let all = "";
    for await (const e of Deno.readDir(client)) {
      if (e.isFile && e.name.endsWith(".js")) all += await Deno.readTextFile(join(client, e.name));
    }
    for (const name of ["a", "b", "c", "d"]) {
      assertStringIncludes(all, `KEPT_${name.toUpperCase()}`);
      assertEquals(
        all.includes(`OFF_BRANCH_${name.toUpperCase()}`),
        false,
        `${name}: the OFF flag's branch shipped`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SPA transform plugin: a plain module without the denext/feature import is not claimed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_feature_plain_" });
  try {
    const plugin = spaSourceTransformPlugin(dir, { features: { FLAG: true } });
    const plain = join(dir, "util.ts");
    await Deno.writeTextFile(plain, `export const feature = (k: string) => k;\nfeature("FLAG");\n`);
    assertEquals(await loadThrough(plugin, plain), undefined);
    const flagged = join(dir, "store.mts");
    await Deno.writeTextFile(flagged, `${IMPORT}export const on = feature("FLAG");\n`);
    assertStringIncludes(await loadThrough(plugin, flagged) ?? "", "export const on = true;");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
