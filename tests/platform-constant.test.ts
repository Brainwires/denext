// `denext/platform`: the build target as a compile-time constant. Every read of `platform` in
// the app's own modules folds to the target's name (and `platform === "…"` to a boolean) on each
// build path — the native App Router (`deno bundle` + the export's server copies), SPA mode on
// both bundlers, the drop-in App Router's esbuild bundles, and the unbundled dev loop — so the
// other targets' branches are dead-code-eliminated.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { compileFeatureModules, foldBuildConstants } from "../src/build/feature-transform.ts";
import { bundleSourceFiles } from "../src/build/bundle.ts";
import { createUnbundledDev } from "../src/build/dev-unbundled.ts";
import { createUseCacheLoader } from "../src/build/use-cache-loader.ts";
import { platformFoldPlugin } from "../src/build/platform-fold-plugin.ts";
import { spaSourceTransformPlugin } from "../src/build/spa-compiler-plugin.ts";
import type { Platform } from "../src/build/platform-extensions.ts";
import type * as esbuild from "../src/build/esbuild/mod.ts";
import { platform as runtimePlatform } from "../src/platform.ts";
import { exportInChild } from "./helpers/bounded-build.ts";

const IMPORT = `import { platform } from "denext/platform";\n`;
const fold = async (src: string, target: Platform = "ios") =>
  await foldBuildConstants(src, { platform: target });

Deno.test("platform: unfolded, the constant reads web", () => {
  assertEquals(runtimePlatform, "web");
});

Deno.test("fold: a comparison with a string literal folds to a boolean", async () => {
  const { code, changed } = await fold(
    `${IMPORT}export const a = platform === "ios";\nexport const b = "web" !== platform;\n` +
      `export const c = platform == "android";\nexport const d = platform != "ios";\n`,
  );
  assert(changed);
  assertStringIncludes(code, "export const a = true;");
  assertStringIncludes(code, "export const b = true;");
  assertStringIncludes(code, "export const c = false;");
  assertStringIncludes(code, "export const d = false;");
});

Deno.test("fold: any other read becomes the target's name", async () => {
  const { code } = await fold(
    `${IMPORT}export const v = { platform, k: platform, [platform]: 1 };\n` +
      `export function E() { return <i title={platform}>{platform}</i>; }\n` +
      `switch (platform) { case "ios": break; }\nexport const t = (platform as string).length;\n`,
    "android",
  );
  assertStringIncludes(code, `{ platform: "android", k: "android", ["android"]: 1 }`);
  assertStringIncludes(code, `<i title={"android"}>{"android"}</i>`);
  assertStringIncludes(code, `switch ("android")`);
  assertStringIncludes(code, `("android" as string).length`);
});

Deno.test("fold: names, types, members and the import itself are left alone", async () => {
  const { code } = await fold(
    `${IMPORT}export const a = x.platform;\nlet t: typeof platform;\n` +
      `export const o = { platform: 1 };\nexport { platform };\n`,
  );
  assertStringIncludes(code, IMPORT);
  assertStringIncludes(code, "x.platform");
  assertStringIncludes(code, "typeof platform");
  assertStringIncludes(code, "{ platform: 1 }");
  assertStringIncludes(code, "export { platform };");
});

Deno.test("fold: an aliased import and a namespace import fold", async () => {
  const { code } = await fold(
    `import { platform as target } from "denext/platform";\nimport * as P from "denext/platform";\n` +
      `export const a = target === "ios" ? 1 : 2;\nexport const b = P.platform;\n`,
  );
  assertStringIncludes(code, "export const a = true ? 1 : 2;");
  assertStringIncludes(code, `export const b = "ios";`);
});

Deno.test("fold: a same-named binding not from denext/platform, or a shadowed one, is not folded", async () => {
  assertEquals(
    (await fold(`const platform = "x";\nexport const a = platform === "ios";\n`)).changed,
    false,
  );
  const shadowed = `${IMPORT}export function f(platform: string) { return platform === "ios"; }\n`;
  assertEquals((await fold(shadowed)).changed, false);
  const typeOnly = `import type { platform } from "denext/platform";\nlet v: typeof platform;\n`;
  assertEquals((await fold(typeOnly)).changed, false);
});

Deno.test("fold: without a target, platform is left alone and features still fold", async () => {
  const src = `${IMPORT}import { feature } from "denext/feature";\n` +
    `export const a = platform === "ios" && feature("X");\n`;
  const { code } = await foldBuildConstants(src, { features: { X: true } });
  assertStringIncludes(code, `platform === "ios" && true`);
});

/** Bundle a module branching on `platform` through the native fold for `target`. */
async function nativeBundle(target: Platform): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_platform_native_" });
  const root = new URL("../", import.meta.url).href;
  try {
    const modPath = join(dir, "mod.ts");
    await Deno.writeTextFile(join(dir, "ios.ts"), `export const ios = () => "IOS_ONLY_TOKEN";\n`);
    await Deno.writeTextFile(
      modPath,
      `${IMPORT}import { ios } from "./ios.ts";\n` +
        `export function run() { return platform === "ios" ? ios() : "OTHER_TOKEN_" + platform; }\n`,
    );
    const map = await compileFeatureModules([modPath], {}, {
      outDir: dir,
      features: {},
      platform: target,
    });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "denext/platform": `${root}src/platform.ts`, ...map } }),
    );
    const entry = `import { run } from "${toFileUrl(modPath).href}";\n` +
      `(globalThis as Record<string, unknown>).run = run;\n`;
    const out = await bundleSourceFiles(entry, {
      configPath: join(dir, "deno.json"),
      minify: true,
    });
    return [...out.files.values()].join("\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("native bundle: the ios target keeps its branch and drops the others'", async () => {
  const js = await nativeBundle("ios");
  assertStringIncludes(js, "IOS_ONLY_TOKEN");
  assert(!js.includes("OTHER_TOKEN_"), "the other targets' branch shipped");
});

Deno.test("native bundle: the android target drops the ios branch and the module only it imports", async () => {
  const js = await nativeBundle("android");
  assert(!js.includes("IOS_ONLY_TOKEN"), "the ios branch shipped");
  assertStringIncludes(js, "OTHER_TOKEN_");
  assertStringIncludes(js, "android");
});

/** Drive an esbuild plugin's first matching `onLoad` on one file. */
async function loadThrough(plugin: esbuild.Plugin | undefined, path: string) {
  assert(plugin);
  type OnLoad = (args: { path: string }) => Promise<{ contents: string } | null>;
  const loads: Array<{ filter: RegExp; fn: OnLoad }> = [];
  plugin.setup(
    {
      initialOptions: {},
      onLoad: ({ filter }: { filter: RegExp }, fn: OnLoad) => loads.push({ filter, fn }),
      onResolve: () => {},
    } as unknown as esbuild.PluginBuild,
  );
  for (const load of loads.filter((l) => l.filter.test(path))) {
    const out = await load.fn({ path });
    if (out) return out.contents;
  }
  return undefined;
}

Deno.test("esbuild plugins: the SPA transforms and the fold plugin claim only modules importing denext/platform", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_platform_plugin_" });
  try {
    const store = join(dir, "store.mts");
    await Deno.writeTextFile(store, `${IMPORT}export const ios = platform === "ios";\n`);
    const plain = join(dir, "plain.tsx");
    await Deno.writeTextFile(plain, `export const platform = "x";\n`);
    for (
      const plugin of [
        spaSourceTransformPlugin(dir, {}, false, "ios"),
        platformFoldPlugin(dir, "ios"),
      ]
    ) {
      assertStringIncludes(await loadThrough(plugin, store) ?? "", "export const ios = true;");
      assertEquals(await loadThrough(plugin, plain), undefined);
    }
    // With other transforms on, the chain folds the components it claims.
    const chained = spaSourceTransformPlugin(dir, { features: { X: true } }, false, "macos");
    const comp = join(dir, "App.tsx");
    await Deno.writeTextFile(comp, `${IMPORT}export const App = () => <b>{platform}</b>;\n`);
    assertStringIncludes(await loadThrough(chained, comp) ?? "", `<b>{"macos"}</b>`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unbundled dev: each request's target gets its own fold", async () => {
  const root = new URL("../", import.meta.url);
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_platform_dev_" }));
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": new URL("mod.ts", root).href,
        "denext/platform": new URL("src/platform.ts", root).href,
        "denext/jsx-runtime": new URL("src/jsx/jsx-runtime.ts", root).href,
        "denext/jsx-dev-runtime": new URL("src/jsx/jsx-runtime.ts", root).href,
        "denext/client": new URL("src/client/mod.ts", root).href,
      },
    }),
  );
  const file = join(dir, "src", "a.ts");
  await Deno.writeTextFile(
    file,
    `${IMPORT}export const v = platform === "ios" ? "I" : platform;\n`,
  );
  const dev = createUnbundledDev({
    projectDir: dir,
    appDir: join(dir, "src"),
    configPath: join(dir, "deno.json"),
    outDir: join(dir, ".denext"),
    compat: false,
  });
  try {
    const ios = (await dev._internal.transform(file, "ios")).code;
    const web = (await dev._internal.transform(file, "web")).code;
    assert(/true \? "I"/.test(ios), ios);
    assert(/false \? "I" : "web"/.test(web), web);
  } finally {
    await dev.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("server copies: a render for a target loads modules reading platform as folded copies", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_platform_copies_" }));
  try {
    await Deno.writeTextFile(join(dir, "leaf.ts"), `${IMPORT}export const v = platform;\n`);
    await Deno.writeTextFile(join(dir, "page.ts"), `export { v } from "./leaf.ts";\n`);
    const loads: string[] = [];
    const loader = createUseCacheLoader((p) => {
      loads.push(p);
      return Promise.resolve({});
    }, { projectDir: dir, cacheDir: join(dir, ".copies"), useCache: false, platform: "android" });
    await loader(join(dir, "page.ts"));
    const copy = loads[0];
    assert(copy.includes(".copies"), `the page loaded as itself: ${copy}`);
    let leaf = "";
    for await (const e of Deno.readDir(join(dir, ".copies"))) {
      const text = await Deno.readTextFile(join(dir, ".copies", e.name));
      if (text.includes("export const v")) leaf = text;
    }
    assertStringIncludes(leaf, `export const v = "android";`);
    // `web` is the runtime value: nothing is copied.
    const webLoads: string[] = [];
    const web = createUseCacheLoader((p) => {
      webLoads.push(p);
      return Promise.resolve({});
    }, { projectDir: dir, cacheDir: join(dir, ".web"), useCache: false, platform: "web" });
    await web(join(dir, "page.ts"));
    assertEquals(webLoads, [toFileUrl(join(dir, "page.ts")).href]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Scaffold an app in a temp dir whose import map points `denext` at this checkout. */
async function scaffold(files: Record<string, string>, extra: Record<string, string> = {}) {
  const dir = await Deno.makeTempDir({ prefix: "denext_platform_export_" });
  const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;
  const all: Record<string, string> = {
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/platform": abs("src/platform.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
        ...extra,
      },
    }),
    ...files,
  };
  for (const [name, src] of Object.entries(all)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

/** Every `.js` file of an export's client dir, concatenated. */
async function exportedJs(outDir: string): Promise<string> {
  const client = join(outDir, "_denext", "client");
  let all = "";
  for await (const e of Deno.readDir(client)) {
    if (e.isFile && e.name.endsWith(".js")) all += await Deno.readTextFile(join(client, e.name));
  }
  return all;
}

const BRANCHES = `${IMPORT}export function pick() {\n` +
  `  if (platform === "ios") return "IOS_BRANCH";\n` +
  `  if (platform === "android") return "ANDROID_BRANCH";\n` +
  `  return "OTHER_BRANCH_" + platform;\n}\n`;

for (const compat of [false, true]) {
  Deno.test({
    name: `SPA export (${compat ? "esbuild" : "deno bundle"} path): only the target's branch ships`,
  }, async () => {
    const dir = await scaffold({
      "denext.config.ts":
        `export default { mode: "spa", ${compat ? "compatibilityMode: true, " : ""}` +
        `spa: { entry: "./src/main.ts" } };\n`,
      "src/main.ts": `import { pick } from "./pick.ts";\n` +
        `(globalThis as Record<string, unknown>).pick = pick;\n`,
      "src/pick.ts": BRANCHES,
    }, compat ? { "react": new URL("../src/compat/react.ts", import.meta.url).href } : {});
    try {
      const { outDir } = await exportInChild(dir, { platform: "android" });
      const js = await exportedJs(outDir);
      assertStringIncludes(js, "ANDROID_BRANCH");
      assert(!js.includes("IOS_BRANCH"), "the ios branch shipped");
      assert(!js.includes("OTHER_BRANCH_"), "the fallback branch shipped");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("App Router export --platform ios: the render and the client bundle take the ios branch", async () => {
  const dir = await scaffold({
    "app/page.tsx": `import { Badge } from "../components/Badge.tsx";\n` +
      `import { platform } from "denext/platform";\n` +
      `export default function Page(){ return <main data-p={platform}><Badge/></main>; }\n`,
    "components/Badge.tsx": `"use client"\nimport { useState } from "denext";\n${IMPORT}` +
      `export function Badge(){ const [n] = useState(0);\n` +
      `  return <b>{platform === "ios" ? "IOS_BADGE" : "OTHER_BADGE"}{n}</b>; }\n`,
  });
  try {
    const { outDir } = await exportInChild(dir, { platform: "ios" });
    const html = await Deno.readTextFile(join(outDir, "index.html"));
    assertStringIncludes(html, `data-p="ios"`);
    assertStringIncludes(html, "IOS_BADGE");
    assert(!html.includes("OTHER_BADGE"));
    const js = await exportedJs(outDir);
    assertStringIncludes(js, "IOS_BADGE");
    assert(!js.includes("OTHER_BADGE"), "the other targets' branch shipped");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
