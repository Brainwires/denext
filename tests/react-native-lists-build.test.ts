// React Native mode's list adapters at build time: react-native-web's FlatList, SectionList
// and VirtualizedList modules load as denext's adapters built over the app's own View /
// StyleSheet / RefreshControl (for the `react-native` entry, a deep import and
// react-native-web's internals alike); `@shopify/flash-list`, `@legendapp/list` and
// `@legendapp/list/react-native` resolve to denext's shims while `@legendapp/list/react` stays
// the real package; `reactNative: { lists: "library" }` restores every original. The runtime
// modules are stand-ins here; the adapters' behaviour is in react-native-lists.test.ts.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import { reactNativeBundleOptions } from "../src/build/react-native.ts";
import { listModuleSource, listPackageSource } from "../src/build/react-native-lists.ts";
import { runtimeEntryPoints } from "../src/build/next-compat.ts";
import { LIST_PACKAGES, RN_LIST_COMPONENTS } from "../src/react-native/lists/manifest.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";

/** Write `files` (relative path → contents) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

const RNW = "node_modules/react-native-web";
const NAMES = [
  "View",
  "StyleSheet",
  "RefreshControl",
  "Animated",
  "Text",
  "Keyboard",
  ...RN_LIST_COMPONENTS,
];

/** A react-native-web whose modules export their own name, plus the two list packages. */
const FIXTURE: Record<string, string> = {
  [`${RNW}/package.json`]: JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
    sideEffects: false,
  }),
  [`${RNW}/dist/index.js`]: NAMES.map((n) => `export { default as ${n} } from "./exports/${n}";\n`)
    .join(""),
  ...Object.fromEntries(
    NAMES.filter((n) => n !== "Animated").map((n) => [
      `${RNW}/dist/exports/${n}/index.js`,
      `export default "RNW_${n}";\n`,
    ]),
  ),
  [`${RNW}/dist/exports/Animated/index.js`]:
    `export default { createAnimatedComponent: (c) => "ANIMATED(" + c + ")" };\n`,
  // react-native-web's own internals reach its FlatList module directly.
  [`${RNW}/dist/vendor/react-native/FlatList/index.js`]: 'export default "RNW_VENDOR_FlatList";\n',
  "node_modules/@shopify/flash-list/package.json": JSON.stringify({
    name: "@shopify/flash-list",
    main: "index.js",
  }),
  "node_modules/@shopify/flash-list/index.js": 'export const FlashList = "REAL_FlashList";\n' +
    'export const AnimatedFlashList = "REAL_Animated";\nexport const useRecyclingState = () => {};\n',
  "node_modules/@legendapp/list/package.json": JSON.stringify({
    name: "@legendapp/list",
    exports: {
      "./react": "./react.js",
      "./react-native": "./react-native.js",
      "./keyboard": "./keyboard.js",
      "./reanimated": "./reanimated.js",
      ".": "./react-native.js",
    },
  }),
  "node_modules/@legendapp/list/react.js": 'export const LegendList = "REAL_DOM_LegendList";\n',
  "node_modules/@legendapp/list/react-native.js":
    'export const LegendList = "REAL_RN_LegendList";\nexport const internal = "INTERNAL";\n',
  // The package's Reanimated / keyboard integrations import its private `internal` API.
  "node_modules/@legendapp/list/keyboard.js":
    'import { internal } from "@legendapp/list/react-native";\n' +
    'export const KeyboardAwareLegendList = "REAL_KB_" + internal;\n' +
    'export const useKeyboardScrollToEnd = "REAL_SCROLL_TO_END";\n',
  "node_modules/@legendapp/list/reanimated.js":
    'export const AnimatedLegendList = "REAL_ANIMATED";\n',
  "node_modules/react-native-reanimated/package.json": JSON.stringify({
    name: "react-native-reanimated",
    main: "index.js",
  }),
  "node_modules/react-native-reanimated/index.js": 'export const useSharedValue = "REANIMATED";\n',
  "entry.js": `import { FlatList, SectionList, VirtualizedList, Text } from "react-native";
import DeepFlatList from "react-native/Libraries/Lists/FlatList";
import { FlashList, AnimatedFlashList, useRecyclingState } from "@shopify/flash-list";
import { LegendList } from "@legendapp/list";
import { LegendList as RNLegendList } from "@legendapp/list/react-native";
import { LegendList as DomLegendList } from "@legendapp/list/react";
import Vendored from "react-native-web/dist/vendor/react-native/FlatList";
import { KeyboardAwareLegendList, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
export const result = {
  FlatList, SectionList, VirtualizedList, Text, DeepFlatList, FlashList, AnimatedFlashList,
  useRecyclingState: typeof useRecyclingState, LegendList, RNLegendList, DomLegendList, Vendored,
  KeyboardAwareLegendList, useKeyboardScrollToEnd, AnimatedLegendList,
};
`,
};

/** Each factory returns a description of the primitives it was built over. */
const factory = (name: string) =>
  `export function create${name}(p) { return "DENEXT_${name}(" + p.View + "," + p.StyleSheet + "," + p.RefreshControl + ")"; }\n`;

/** The prebuilt runtime modules' stand-ins. */
const STAND_INS: Record<string, string> = {
  "denext/react-native": ["FlatList", "SectionList", "VirtualizedList"].map(factory).join("") +
    'export function createRefreshControl(View) { return "DENEXT_RefreshControl(" + View + ")"; }\n' +
    "export const Keyboard = { dismiss() {} };\n",
  "denext/react-native/flash-list": factory("FlashList") +
    LIST_PACKAGES["@shopify/flash-list"].reexports.map((n) =>
      `export const ${n.split(" as ")[0]} = () => {};\n`
    )
      .join(""),
  "denext/react-native/legend-list": factory("LegendList") +
    LIST_PACKAGES["@legendapp/list"].reexports.map((n) => `export const ${n} = () => {};\n`)
      .join("") +
    "export function legendKeyboardExports(r, L, K) {\n" +
    '  return { KeyboardAwareLegendList: "DENEXT_KB(" + L + "," + r.useSharedValue + "," +' +
    ' typeof K.dismiss + ")", useKeyboardScrollToEnd: "SCROLL_TO_END" };\n}\n' +
    "export function legendReanimatedExports(L) {\n" +
    '  return { AnimatedLegendList: "DENEXT_ANIMATED(" + L + ")" };\n}\n',
};

/** Bundle the fixture's entry with React Native mode's plugins under `config`. */
async function bundle(config: DenextConfig): Promise<Record<string, string>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_lists_" });
  try {
    await writeTree(dir, FIXTURE);
    const options = reactNativeBundleOptions(config, dir, false)!;
    const standIn: esbuild.Plugin = {
      name: "stand-ins",
      setup(build) {
        build.onResolve({ filter: /^denext\/react-native(\/.*)?$/ }, (args) => ({
          path: args.path,
          namespace: "stand-in",
        }));
        build.onLoad({ filter: /.*/, namespace: "stand-in" }, (args) => ({
          contents: STAND_INS[args.path],
          loader: "js",
        }));
      },
    };
    const out = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: [...options.plugins, standIn],
    });
    const code = new TextDecoder().decode(out.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return (await import(url)).result;
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

const OVER = "RNW_View,RNW_StyleSheet,DENEXT_RefreshControl(RNW_View)";

Deno.test("reactNative lists: FlatList / SectionList / VirtualizedList and both packages run on denext by default", async () => {
  const r = await bundle({ reactNative: true });
  assertEquals(r.FlatList, `DENEXT_FlatList(${OVER})`, "built over react-native-web's View");
  assertEquals(r.SectionList, `DENEXT_SectionList(${OVER})`);
  assertEquals(r.VirtualizedList, `DENEXT_VirtualizedList(${OVER})`);
  assertEquals(r.DeepFlatList, r.FlatList, "a deep Libraries/Lists import too");
  assertEquals(r.Text, "RNW_Text");
  assertEquals(r.FlashList, `DENEXT_FlashList(${OVER})`);
  assertEquals(r.AnimatedFlashList, `ANIMATED(${r.FlashList})`);
  assertEquals(r.useRecyclingState, "function");
  assertEquals(r.LegendList, `DENEXT_LegendList(${OVER})`);
  assertEquals(r.RNLegendList, r.LegendList, "@legendapp/list/react-native too");
  assertEquals(r.DomLegendList, "REAL_DOM_LegendList", "the DOM build stays the real package");
  assertEquals(r.Vendored, "RNW_VENDOR_FlatList", "the per-list escape: the vendored original");
  assertEquals(
    r.KeyboardAwareLegendList,
    `DENEXT_KB(${r.LegendList},REANIMATED,function)`,
    "@legendapp/list/keyboard: built over the same LegendList, the app's Reanimated, Keyboard",
  );
  assertEquals(r.useKeyboardScrollToEnd, "SCROLL_TO_END");
  assertEquals(r.AnimatedLegendList, `DENEXT_ANIMATED(${r.LegendList})`, "/reanimated too");
});

Deno.test('reactNative lists: lists: "library" restores every original', async () => {
  const r = await bundle({ reactNative: { lists: "library" } });
  assertEquals(r.FlatList, "RNW_FlatList");
  assertEquals(r.SectionList, "RNW_SectionList");
  assertEquals(r.VirtualizedList, "RNW_VirtualizedList");
  assertEquals(r.FlashList, "REAL_FlashList");
  assertEquals(r.LegendList, "REAL_RN_LegendList");
  assertEquals(r.RNLegendList, "REAL_RN_LegendList");
  assertEquals(r.KeyboardAwareLegendList, "REAL_KB_INTERNAL");
  assertEquals(r.AnimatedLegendList, "REAL_ANIMATED");
});

Deno.test("listModuleSource / listPackageSource: ES and CommonJS shapes; the shims are prebuilt runtime entries", () => {
  const es = listModuleSource("FlatList", false);
  assertStringIncludes(es, 'import View from "../View";');
  assertStringIncludes(es, "createFlatList({ View, StyleSheet, RefreshControl })");
  const cjs = listModuleSource("SectionList", true);
  const module = { exports: {} as unknown };
  const mods: Record<string, unknown> = {
    "denext/react-native": { createSectionList: (p: Record<string, string>) => `SL(${p.View})` },
    "../View": { __esModule: true, default: "V" },
    "../StyleSheet": "S",
    "../RefreshControl": "R",
  };
  new Function("module", "exports", "require", cjs)(module, module.exports, (s: string) => mods[s]);
  assertEquals(module.exports, "SL(V)");
  const flash = listPackageSource(LIST_PACKAGES["@shopify/flash-list"]);
  assertStringIncludes(flash, 'from "react-native"');
  assertStringIncludes(flash, "export const FlashList = /* @__PURE__ */ createFlashList(");
  const entries = runtimeEntryPoints("file:///fw/");
  assertEquals(entries["react-native-flash-list"], "file:///fw/src/react-native/flash-list.ts");
  assertEquals(entries["react-native-legend-list"], "file:///fw/src/react-native/legend-list.ts");
  assertEquals(Object.keys(LIST_PACKAGES).length, 4);
  const keyboard = listPackageSource(LIST_PACKAGES["@legendapp/list/keyboard"]);
  assertStringIncludes(keyboard, 'import * as Reanimated from "react-native-reanimated";');
  assertStringIncludes(
    keyboard,
    "= /* @__PURE__ */ legendKeyboardExports(Reanimated, LegendList, Keyboard);",
  );
});

Deno.test('reactNative.lists: "denext" | "library", validated', () => {
  const spa: DenextConfig = { mode: "spa", spa: { entry: "./src/main.tsx" } };
  validateDenextConfig({ ...spa, reactNative: { lists: "denext" } });
  validateDenextConfig({ ...spa, reactNative: { lists: "library" } });
  assertThrows(
    () => validateDenextConfig({ ...spa, reactNative: { lists: "rnw" as "library" } }),
    Error,
    '`reactNative.lists` must be "denext" or "library"',
  );
  const names = (c: DenextConfig) =>
    reactNativeBundleOptions(c, "/p", false)!.plugins.map((p) => p.name);
  assert(names({ reactNative: true }).includes("denext-react-native-lists"), "on by default");
  assert(!names({ reactNative: { lists: "library" } }).includes("denext-react-native-lists"));
});
