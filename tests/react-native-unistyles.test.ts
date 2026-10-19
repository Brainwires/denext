// React Native mode's Unistyles 3 support (src/build/react-native-unistyles.ts), what its Babel
// plugin does to the app's own modules: the app's `react-native` gives Unistyles' wrapped
// components (react-native-web's do not read a Unistyles style: Unistyles' example app rendered
// with every style dropped), and `styles.useVariants(…)` applies to the rest of its block
// (without the rewrite the call's result was thrown away and the variants never applied).
// Exercised through a real esbuild bundle over a temp node_modules fixture; the output is run.

import { assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import {
  appResolverPlugin,
  BROWSER_CONDITIONS,
  catalogResolverPlugin,
} from "../src/build/next-compat.ts";
import { reactNativeWebPlugin, WEB_PLATFORM_EXTENSIONS } from "../src/build/react-native.ts";
import {
  rewriteUseVariants,
  unistylesEnabled,
  unistylesPlugins,
  unistylesReactNativeSource,
} from "../src/build/react-native-unistyles.ts";
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
const UNI = "node_modules/react-native-unistyles";

/** react-native-web, a library that imports react-native, and the app's entry. */
const BASE: Record<string, string> = {
  "deno.json": "{}\n",
  [`${RNW}/package.json`]: JSON.stringify({ name: "react-native-web", module: "dist/index.js" }),
  [`${RNW}/dist/index.js`]: 'export const View = "RNW_VIEW";\nexport const Text = "RNW_TEXT";\n' +
    'export const Platform = { OS: "web" };\n',
  "node_modules/some-lib/package.json": JSON.stringify({ name: "some-lib", module: "index.js" }),
  "node_modules/some-lib/index.js": 'export { View as libView } from "react-native";\n',
  "entry.js": 'import { View, Text, Platform, unstable_NativeView } from "react-native";\n' +
    'import { libView } from "some-lib";\n' +
    "export const result = { View, Text, os: Platform.OS, native: unstable_NativeView, libView };\n",
};

/** Unistyles' published layout: its wrapped components under lib/module/components/native. */
const UNISTYLES: Record<string, string> = {
  [`${UNI}/package.json`]: JSON.stringify({
    name: "react-native-unistyles",
    exports: {
      "./components/native/*": { browser: "./lib/module/components/native/*" },
    },
  }),
  [`${UNI}/lib/module/components/native/View.js`]:
    'import { View as V } from "react-native";\nexport const View = "UNI(" + V + ")";\n',
  [`${UNI}/lib/module/components/native/View.native.js`]: "throw new Error('native');\n",
  [`${UNI}/lib/module/components/native/NativeView.js`]:
    'import { View as V } from "react-native";\nexport const NativeView = "UNI_NATIVE(" + V + ")";\n',
};

/** Bundle `entry.js` over `files` with the Unistyles plugins ahead of the RN resolvers; run it. */
async function run(files: Record<string, string>): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_unistyles_" });
  try {
    await writeTree(dir, files);
    const out = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      plugins: [
        ...unistylesPlugins(dir),
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

Deno.test("unistyles: the app's react-native gives Unistyles' wrapped components", async () => {
  const r = await run({ ...BASE, ...UNISTYLES });
  assertEquals(r.View, "UNI(RNW_VIEW)", "Unistyles' View, wrapping react-native-web's");
  assertEquals(r.Text, "RNW_TEXT", "a component this Unistyles does not wrap stays");
  assertEquals(r.os, "web", "the rest of react-native is react-native as it is");
  assertEquals(r.native, "UNI_NATIVE(RNW_VIEW)", "React Native 0.83's unstable_NativeView");
  assertEquals(r.libView, "RNW_VIEW", "a package's own react-native import is left alone");
});

Deno.test("unistyles: without the package installed nothing changes", async () => {
  const r = await run({
    ...BASE,
    "entry.js":
      'import { View, Text } from "react-native";\nimport { libView } from "some-lib";\n' +
      "export const result = { View, Text, libView };\n",
  });
  assertEquals([r.View, r.Text, r.libView], ["RNW_VIEW", "RNW_TEXT", "RNW_VIEW"]);
});

Deno.test("unistylesReactNativeSource: re-exports react-native with the wrapped components", () => {
  assertEquals(
    unistylesReactNativeSource(["View", "Text", "NativeText", "Unknown"]),
    'export * from "react-native";\n' +
      'export { View } from "react-native-unistyles/components/native/View";\n' +
      'export { Text } from "react-native-unistyles/components/native/Text";\n' +
      'export { NativeText as unstable_NativeText } from "react-native-unistyles/components/native/NativeText";\n',
  );
});

Deno.test("rewriteUseVariants: the rest of the block reads the variant styles", async () => {
  const source = `const sheet = (v) => ({
  label: v ? "label:" + v.size : "label",
  useVariants(next) { return sheet(next); },
});
const styles = sheet();
export function Screen(size) {
  const before = styles.label;
  styles.useVariants({ size });
  if (size === "skip") return before;
  return before + " -> " + styles.label;
}
export function Twice() {
  styles.useVariants({ size: "s" });
  const first = styles.label;
  styles.useVariants({ size: "l" });
  return first + "," + styles.label;
}
export const untouched = styles.label;
`;
  const out = await rewriteUseVariants(source);
  const url = `data:text/javascript;base64,${btoa(out!)}`;
  const mod = await import(url);
  assertEquals(mod.Screen("large"), "label -> label:large");
  assertEquals(mod.Screen("skip"), "label");
  assertEquals(mod.Twice(), "label:s,label:l");
  assertEquals(mod.untouched, "label");
  assertEquals(await rewriteUseVariants("const a = styles.label;\n"), null);
  assertEquals(await rewriteUseVariants("x.useVariants(a, b);\n"), null, "one argument only");
});

Deno.test("reactNative.unistyles: on by default in React Native mode, false turns it off", () => {
  const spa: DenextConfig = { mode: "spa", spa: { entry: "./index.ts" } };
  assertEquals(unistylesEnabled({ ...spa, reactNative: true }), true);
  assertEquals(unistylesEnabled({ ...spa, reactNative: { unistyles: false } }), false);
  assertEquals(unistylesEnabled(spa), false);
  validateDenextConfig({ ...spa, reactNative: { unistyles: false } });
  assertThrows(
    () => validateDenextConfig({ ...spa, reactNative: { unistyles: "yes" as never } }),
    Error,
    "reactNative.unistyles",
  );
});
