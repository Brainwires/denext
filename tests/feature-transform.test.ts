// Unit tests for the compile-time feature-flag fold (src/build/feature-transform.ts):
// `feature("KEY")` folds to a boolean literal for configured keys, passes through otherwise,
// and never touches a module that doesn't import `denext/feature`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { compileFeatureModules, transformFeatures } from "../src/build/feature-transform.ts";
import { bundleSourceFiles } from "../src/build/bundle.ts";
import { spaSourceTransformPlugin } from "../src/build/spa-compiler-plugin.ts";
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
  const root = new URL("../", import.meta.url).pathname; // repo root
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
  let fn: ((args: { path: string }) => Promise<{ contents: string } | null>) | undefined;
  plugin.setup(
    {
      onLoad: (_f: unknown, cb: typeof fn) => {
        fn = cb;
      },
      onResolve: () => {},
    } as unknown as esbuild.PluginBuild,
  );
  assert(fn, "the plugin registered no onLoad");
  return (await fn({ path }))?.contents;
}

Deno.test("the fold reads the top-level `features` config key (and its legacy alias)", async () => {
  // `features` graduated out of `experimental` in 2.5: the top-level key drives the fold, the
  // legacy spelling still does when the top-level one is absent, and top-level wins when both
  // are set (the maps are not merged).
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
    const legacy = await loadThrough(
      spaSourceTransformPlugin(dir, { experimental: { features: { FLAG: true } } }),
      file,
    );
    assertStringIncludes(legacy ?? "", "export const on = true;");
    const both = await loadThrough(
      spaSourceTransformPlugin(dir, {
        features: { FLAG: false },
        experimental: { features: { FLAG: true } },
      }),
      file,
    );
    assertStringIncludes(both ?? "", "export const on = false;");
    // No flags configured anywhere → the plugin is not even installed.
    assertEquals(spaSourceTransformPlugin(dir, {}), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("e2e: an OFF flag DCEs the gated branch + its import from deno bundle", async () => {
  const all = await bundleWithFold(false);
  assert(!all.includes("GATED_MARKER_TOKEN"), "gated code must be eliminated when the flag is off");
});

Deno.test("e2e: an ON flag keeps the gated branch in deno bundle", async () => {
  const all = await bundleWithFold(true);
  assertStringIncludes(all, "GATED_MARKER_TOKEN");
});
