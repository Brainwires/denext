// React Native mode's uniwind support (src/build/react-native-uniwind.ts): with `uniwind`
// installed, `react-native` resolves to uniwind's web components (except inside uniwind),
// react-native-web's StyleSheet gets uniwind's ordered sheet, and uniwind's config module
// registers the app's themes, as uniwind's own Vite plugin does. Exercised through a real
// esbuild bundle over a temp node_modules fixture; the output is executed.

import { assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import {
  appResolverPlugin,
  BROWSER_CONDITIONS,
  catalogResolverPlugin,
} from "../src/build/next-compat.ts";
import { reactNativeWebPlugin, WEB_PLATFORM_EXTENSIONS } from "../src/build/react-native.ts";
import {
  uniwindPlugin,
  uniwindReinitSource,
  uniwindThemes,
} from "../src/build/react-native-uniwind.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

/** Write `files` (relative path → contents) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

const RNW = "node_modules/react-native-web";
const UW = "node_modules/uniwind/dist/module";

/** react-native-web with a StyleSheet that reads its ordered sheet, and uniwind over it. */
const BASE: Record<string, string> = {
  "deno.json": "{}\n",
  [`${RNW}/package.json`]: JSON.stringify({ name: "react-native-web", module: "dist/index.js" }),
  [`${RNW}/dist/index.js`]: 'export { default as View } from "./exports/View";\n' +
    'export { default as StyleSheet } from "./exports/StyleSheet";\n',
  [`${RNW}/dist/exports/View/index.js`]: 'export default "RNW_VIEW";\n',
  [`${RNW}/dist/exports/StyleSheet/index.js`]:
    'import create from "./createOrderedCSSStyleSheet";\nexport default { sheet: create() };\n',
  [`${RNW}/dist/exports/StyleSheet/createOrderedCSSStyleSheet.js`]:
    'export default () => "RNW_SHEET";\n',
  "entry.js": `import { View, StyleSheet, uniwindView } from "react-native";
import { Uniwind } from "uniwind/dist/module/core/config/config.js";
export const result = { View, sheet: StyleSheet.sheet, uniwindView, themes: Uniwind.themes };
`,
};

/** uniwind's web components (re-exporting react-native-web), its sheet and its config. */
const UNIWIND: Record<string, string> = {
  "node_modules/uniwind/package.json": JSON.stringify({ name: "uniwind" }),
  [`${UW}/components/web/index.js`]:
    'export * from "react-native";\nexport const uniwindView = "UNIWIND_VIEW";\n',
  [`${UW}/components/web/createOrderedCSSStyleSheet.js`]: 'export default () => "UNIWIND_SHEET";\n',
  [`${UW}/core/config/config.js`]: "class Builder {\n  themes = [];\n" +
    "  __reinit(_cb, themes) { this.themes = themes; }\n}\nexport const Uniwind = new Builder();\n",
};

/** Bundle `entry.js` over `files` with the uniwind plugin ahead of the RN resolvers, and run it. */
async function run(
  files: Record<string, string>,
  themes: readonly string[],
): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_uniwind_" });
  try {
    await writeTree(dir, files);
    const out = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      plugins: [
        uniwindPlugin(dir, themes),
        reactNativeWebPlugin(dir),
        appResolverPlugin(join(dir, "deno.json"), WEB_PLATFORM_EXTENSIONS),
        catalogResolverPlugin(dir, "all", BROWSER_CONDITIONS, WEB_PLATFORM_EXTENSIONS),
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

Deno.test("uniwind: react-native is uniwind's components, its sheet replaces react-native-web's, themes register", async () => {
  const r = await run({ ...BASE, ...UNIWIND }, ["light", "dark", "ocean"]);
  assertEquals(r.uniwindView, "UNIWIND_VIEW", "the app's react-native is uniwind's components");
  assertEquals(r.View, "RNW_VIEW", "which wrap react-native-web (uniwind's own import)");
  assertEquals(r.sheet, "UNIWIND_SHEET", "react-native-web's StyleSheet gets the ordered sheet");
  assertEquals(r.themes, ["light", "dark", "ocean"], "the config module registers the themes");
});

Deno.test("uniwind: without the package installed nothing changes", async () => {
  const files = {
    ...BASE,
    "entry.js": 'import { View, StyleSheet } from "react-native";\n' +
      "export const result = { View, sheet: StyleSheet.sheet };\n",
  };
  const r = await run(files, ["light", "dark"]);
  assertEquals([r.View, r.sheet], ["RNW_VIEW", "RNW_SHEET"]);
});

Deno.test("uniwindThemes / uniwindReinitSource: light, dark, then extraThemes; false turns it off", () => {
  const spa: DenextConfig = { mode: "spa", spa: { entry: "./index.ts" } };
  assertEquals(uniwindThemes({ ...spa, reactNative: true }), ["light", "dark"]);
  assertEquals(
    uniwindThemes({ ...spa, reactNative: { uniwind: { extraThemes: ["ocean", "dark"] } } }),
    ["light", "dark", "ocean"],
  );
  assertEquals(uniwindThemes({ ...spa, reactNative: { uniwind: false } }), null);
  assertEquals(uniwindThemes(spa), null, "React Native mode off");
  assertEquals(
    uniwindReinitSource(["light", "dark"]),
    '\n;Uniwind.__reinit(() => ({}), ["light","dark"]);\n',
  );
});

Deno.test("reactNative.uniwind is validated", () => {
  const spa: DenextConfig = { mode: "spa", spa: { entry: "./index.ts" } };
  validateDenextConfig({ ...spa, reactNative: { uniwind: true } });
  validateDenextConfig({ ...spa, reactNative: { uniwind: { extraThemes: ["a"] } } });
  assertThrows(
    () => validateDenextConfig({ ...spa, reactNative: { uniwind: "yes" as never } }),
    Error,
    "reactNative.uniwind",
  );
  assertThrows(
    () => validateDenextConfig({ ...spa, reactNative: { uniwind: { extraThemes: [1] as never } } }),
    Error,
    "reactNative.uniwind.extraThemes",
  );
});
