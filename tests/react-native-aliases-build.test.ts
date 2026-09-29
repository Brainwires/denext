// React Native mode's community-package aliases at build time (src/build/react-native-aliases.ts):
// a `runtime` entry resolves to its prebuilt `denext/react-native-compat/<name>` module; a
// `generated` factory builds exports from the app's own package (required: the drawer over
// `@react-navigation/native`; optional: keyboard-controller's Reanimated hooks, skipped when
// Reanimated is not installed); a `navigator` entry re-exports the real package with its
// `create*Navigator` from `denext/navigation` (expo-router's internals keep the real one); a
// `.svg` import becomes a react-native-svg component when the app uses the transformer; and
// `reactNative.aliases` turns each off. The runtime modules are stand-ins here; their
// behaviour is in tests/react-native-aliases-*.test.ts.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import { reactNativeBundleOptions } from "../src/build/react-native.ts";
import {
  communityRuntimeEntries,
  communityRuntimeFiles,
  enabledCommunityAliases,
  factoryModuleSource,
  isCommunityBridgeImport,
  navigatorModuleSource,
  svgComponentSource,
} from "../src/build/react-native-aliases.ts";
import { runtimeEntryPoints } from "../src/build/next-compat.ts";
import { COMMUNITY_ALIASES } from "../src/react-native-compat/manifest.ts";
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

/** A package whose `index.js` is `source`. */
function pkg(name: string, source: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, main: "index.js" }),
    [`node_modules/${name}/index.js`]: source,
  };
}

/** The app's installed packages (the real ones the aliases replace, and their peers). */
const PACKAGES: Record<string, string> = {
  ...pkg("@react-navigation/native", 'export const id = "CORE";\n'),
  ...pkg(
    "@react-navigation/native-stack",
    'export const createNativeStackNavigator = () => "REAL_STACK";\n' +
      'export const NativeStackView = "REAL_VIEW";\n',
  ),
  ...pkg("@react-navigation/bottom-tabs", 'export const createBottomTabNavigator = "REAL_TABS";\n'),
  ...pkg("@react-navigation/drawer", 'throw new Error("the real drawer was bundled");\n'),
  ...pkg("react-native-webview", 'export default "REAL_WEBVIEW";\n'),
  ...pkg(
    "react-native-keyboard-controller",
    'export const KeyboardProvider = "REAL_KP";\nexport const useReanimatedKeyboardAnimation = "REAL_REA";\n',
  ),
  ...pkg("react", "export function createElement(type, props) { return { type, props }; }\n"),
  ...pkg("react-native-svg", 'export const SvgXml = "SVG_XML";\n'),
  // expo-router's own navigator imports keep the real package.
  "node_modules/expo-router/package.json": JSON.stringify({ name: "expo-router", main: "i.js" }),
  "node_modules/expo-router/i.js":
    'export { createNativeStackNavigator as internalStack } from "@react-navigation/native-stack";\n',
  "logo.svg": '<svg viewBox="0 0 10 10"><circle r="5"/></svg>',
  "entry.js": `import WebView from "react-native-webview";
import * as stack from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createDrawerNavigator, DrawerItem } from "@react-navigation/drawer";
import { KeyboardProvider, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { internalStack } from "expo-router/i.js";
import Logo from "./logo.svg";
export const result = {
  WebView,
  stack: stack.createNativeStackNavigator(),
  stackView: stack.NativeStackView,
  tabs: createBottomTabNavigator(),
  drawer: createDrawerNavigator(),
  DrawerItem,
  KeyboardProvider,
  useReanimatedKeyboardAnimation,
  internalStack: internalStack(),
  Logo: typeof Logo === "function" ? Logo({ width: 4 }) : Logo,
};
`,
};

/** The prebuilt runtime modules' stand-ins. */
const STAND_INS: Record<string, string> = {
  "denext/react-native-compat/webview": 'export default "DENEXT_WEBVIEW";\n',
  "denext/react-native-compat/drawer": "export function drawerNavigatorExports(core) {\n" +
    '  return { createDrawerNavigator: () => "DENEXT_DRAWER(" + core.id + ")" };\n}\n' +
    'export const DrawerItem = "DENEXT_DrawerItem";\n',
  "denext/react-native-compat/keyboard-controller":
    "export function reanimatedKeyboardExports(r) {\n" +
    '  return { useReanimatedKeyboardAnimation: "REANIMATED(" + r.id + ")" };\n}\n' +
    'export const useReanimatedKeyboardAnimation = "FALLBACK";\n' +
    'export const KeyboardProvider = "DENEXT_KP";\n',
  "denext/navigation": "export function createNativeStackNavigatorFactory(core) {\n" +
    '  return () => "DENEXT_STACK(" + core.id + ")";\n}\n' +
    "export function createBottomTabNavigatorFactory(core) {\n" +
    '  return () => "DENEXT_TABS(" + core.id + ")";\n}\n',
};

/** Bundle the fixture's entry with React Native mode's plugins under `config`. */
async function bundle(
  config: DenextConfig,
  extra: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_aliases_" });
  try {
    await writeTree(dir, { ...PACKAGES, ...extra });
    const options = reactNativeBundleOptions(config, dir, false)!;
    const standIn: esbuild.Plugin = {
      name: "stand-ins",
      setup(build) {
        build.onResolve(
          { filter: /^denext\/(?:react-native-compat\/.+|navigation|react-native)$/ },
          (args) => ({ path: args.path, namespace: "stand-in" }),
        );
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
      loader: { ".svg": "text" },
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

/** react-native-reanimated, installed. */
const REANIMATED = pkg("react-native-reanimated", 'export const id = "REA";\n');
/** react-native-svg-transformer, installed. */
const SVG_TRANSFORMER = pkg("react-native-svg-transformer", "export {};\n");

Deno.test("reactNative aliases: every kind resolves to denext by default", async () => {
  const r = await bundle({ reactNative: true }, { ...REANIMATED, ...SVG_TRANSFORMER });
  assertEquals(r.WebView, "DENEXT_WEBVIEW", "a runtime entry");
  assertEquals(r.stack, "DENEXT_STACK(CORE)", "native-stack's navigator from denext/navigation");
  assertEquals(r.stackView, "REAL_VIEW", "the rest of native-stack is the real package's");
  assertEquals(r.tabs, "DENEXT_TABS(CORE)");
  assertEquals(r.drawer, "DENEXT_DRAWER(CORE)", "the drawer factory over @react-navigation/native");
  assertEquals(r.DrawerItem, "DENEXT_DrawerItem", "the runtime module re-exported");
  assertEquals(r.KeyboardProvider, "DENEXT_KP");
  assertEquals(r.useReanimatedKeyboardAnimation, "REANIMATED(REA)", "Reanimated is installed");
  assertEquals(r.internalStack, "REAL_STACK", "expo-router's own import keeps the real package");
  const logo = r.Logo as { type: string; props: { xml: string; width: number } };
  assertEquals(logo.type, "SVG_XML", "a .svg import is a react-native-svg component");
  assertStringIncludes(logo.props.xml, "<circle");
  assertEquals(logo.props.width, 4, "props pass through");
});

Deno.test("reactNative aliases: an optional factory's package missing keeps the fallback; no transformer, no svg component", async () => {
  const r = await bundle({ reactNative: true });
  assertEquals(r.useReanimatedKeyboardAnimation, "FALLBACK");
  assertStringIncludes(String(r.Logo), "<circle", "the .svg stays a file (here: text)");
});

Deno.test("reactNative.aliases: false resolves a package normally again", async () => {
  const r = await bundle({
    reactNative: {
      aliases: {
        "react-native-webview": false,
        "@react-navigation/native-stack": false,
        "react-native-keyboard-controller": false,
        "react-native-svg-transformer": false,
      },
    },
  }, { ...REANIMATED, ...SVG_TRANSFORMER });
  assertEquals(r.WebView, "REAL_WEBVIEW");
  assertEquals(r.stack, "REAL_STACK");
  assertEquals(r.KeyboardProvider, "REAL_KP");
  assertEquals(r.useReanimatedKeyboardAnimation, "REAL_REA");
  assertStringIncludes(String(r.Logo), "<circle");
  assertEquals(r.tabs, "DENEXT_TABS(CORE)", "the others stay aliased");
});

Deno.test("reactNative aliases: generated module shapes", () => {
  const factory = factoryModuleSource("denext/react-native-compat/x", {
    from: "dep",
    factory: "make",
    exports: ["A", "B"],
    optional: false,
  });
  assertStringIncludes(factory, 'export * from "denext/react-native-compat/x";');
  assertStringIncludes(factory, 'import * as __dep from "dep";');
  assertStringIncludes(factory, "export const B = __made.B;");
  assertEquals(
    factoryModuleSource("denext/react-native-compat/x", null),
    'export * from "denext/react-native-compat/x";\n',
  );
  const nav = navigatorModuleSource(
    "@react-navigation/bottom-tabs",
    COMMUNITY_ALIASES["@react-navigation/bottom-tabs"],
  );
  assertStringIncludes(nav, 'export * from "@react-navigation/bottom-tabs?denext-rn-real";');
  assertStringIncludes(nav, "export const createBottomTabNavigator = /* @__PURE__ */ __factory(");
  assertStringIncludes(svgComponentSource('<svg a="1"/>'), 'const xml = "<svg a=\\"1\\"/>";');
});

Deno.test("reactNative aliases: the stand-ins are prebuilt runtime entries; their bridge stays external", () => {
  const runtime = COMMUNITY_ALIASES["react-native-webview"];
  assertEquals(runtime.kind, "runtime");
  const entries = communityRuntimeEntries((rel) => `file:///fw/${rel}`);
  assertEquals(entries["rn-compat-webview"], "file:///fw/src/react-native-compat/webview.ts");
  assertEquals(
    communityRuntimeFiles()["denext/react-native-compat/webview"],
    "rn-compat-webview.js",
  );
  assertEquals(
    runtimeEntryPoints("file:///fw/")["rn-compat-webview"],
    "file:///fw/src/react-native-compat/webview.ts",
  );
  const kinds = Object.values(COMMUNITY_ALIASES).filter((a) => a.kind === "runtime").length;
  assert(Object.keys(entries).length <= kinds && Object.keys(entries).length > 0);
  assert(!("rn-compat-" in entries), "navigators and transforms have no runtime entry");
  assert(
    isCommunityBridgeImport(
      "./internal/react-native.ts",
      "/fw/src/react-native-compat/webview.ts",
    ),
  );
  assert(
    isCommunityBridgeImport(
      "../internal/react-native.ts",
      "https://jsr.io/@denext/denext/2.11.0/src/react-native-compat/internal/x.ts",
    ),
  );
  assert(!isCommunityBridgeImport("./internal/react-native.ts", "/fw/src/expo/blur.ts"));
  assert(!isCommunityBridgeImport("./react-native.ts", "/fw/src/react-native-compat/menu.ts"));
});

Deno.test("reactNative.aliases: a map of known package names to booleans, validated", () => {
  const spa: DenextConfig = { mode: "spa", spa: { entry: "./src/main.tsx" } };
  validateDenextConfig({ ...spa, reactNative: { aliases: { "react-native-webview": false } } });
  assertThrows(
    () =>
      validateDenextConfig({
        ...spa,
        reactNative: { aliases: { "react-native-webveiw": false } },
      }),
    Error,
    'is not an aliased package (did you mean "react-native-webview"?)',
  );
  assertThrows(
    () =>
      validateDenextConfig({
        ...spa,
        reactNative: { aliases: { "react-native-webview": "no" as unknown as boolean } },
      }),
    Error,
    "`reactNative.aliases.react-native-webview` must be a boolean",
  );
  assertThrows(
    () => validateDenextConfig({ ...spa, reactNative: { aliases: [] as never } }),
    Error,
    "`reactNative.aliases` must be an object",
  );
  const on = enabledCommunityAliases({ reactNative: { aliases: { "react-native-share": false } } });
  assert(!("react-native-share" in on) && "react-native-keychain" in on);
  assertEquals(
    Object.keys(enabledCommunityAliases({ reactNative: true })).length,
    Object.keys(COMMUNITY_ALIASES).length,
  );
});

Deno.test("reactNative aliases: NativeWind's JSX runtime runs the app's JSX; css-interop gets a default export", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_nativewind_" });
  try {
    await writeTree(dir, {
      ...pkg("nativewind", "export {};\n"),
      "node_modules/nativewind/jsx-runtime/package.json": JSON.stringify({ main: "index.js" }),
      "node_modules/nativewind/jsx-runtime/index.js":
        'module.exports = require("react-native-css-interop/jsx-runtime");\n',
      "node_modules/react-native-css-interop/package.json": JSON.stringify({
        name: "react-native-css-interop",
      }),
      "node_modules/react-native-css-interop/jsx-runtime.js":
        'const r = require("react/jsx-runtime");\n' +
        "exports.jsx = (t, p) => ({ interop: true, inner: r.default.jsx(t, p) });\n",
      // A package's own JSX keeps the plain runtime.
      ...pkg(
        "some-lib",
        'import { jsx } from "react/jsx-runtime";\nexport const lib = jsx("b", {});\n',
      ),
      "entry.js": 'import { jsx } from "react/jsx-runtime";\nimport { lib } from "some-lib";\n' +
        'export const result = { app: jsx("a", { className: "p-4" }), lib };\n',
    });
    const run = async (config: DenextConfig) => {
      const options = reactNativeBundleOptions(config, dir, false)!;
      const plainRuntime: esbuild.Plugin = {
        name: "plain-jsx",
        setup(build) {
          build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
            path: "jsx",
            namespace: "plain-jsx",
          }));
          build.onLoad({ filter: /.*/, namespace: "plain-jsx" }, () => ({
            contents: "export const jsx = (type, props) => ({ type, props });\n",
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
        plugins: [...options.plugins, plainRuntime],
      });
      const code = new TextDecoder().decode(out.outputFiles![0].contents);
      return (await import(`data:text/javascript;base64,${btoa(code)}`)).result;
    };
    const on = await run({ reactNative: true });
    assertEquals(on.app, { interop: true, inner: { type: "a", props: { className: "p-4" } } });
    assertEquals(on.lib, { type: "b", props: {} }, "a package's JSX is untouched");
    const off = await run({ reactNative: { aliases: { nativewind: false } } });
    assertEquals(off.app, { type: "a", props: { className: "p-4" } });
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reactNative aliases: react-native-safe-area-context's web provider is denext's", async () => {
  const provider = "node_modules/react-native-safe-area-context/lib/module/";
  const extra = {
    "node_modules/react-native-web/package.json": JSON.stringify({
      name: "react-native-web",
      module: "dist/index.js",
    }),
    "node_modules/react-native-web/dist/index.js": 'export const View = "RNW_View";\n',
    "node_modules/react-native-safe-area-context/package.json": JSON.stringify({
      name: "react-native-safe-area-context",
      module: "lib/module/index.js",
    }),
    [`${provider}index.js`]:
      'export { NativeSafeAreaProvider } from "./NativeSafeAreaProvider.web.js";\n',
    [`${provider}NativeSafeAreaProvider.web.js`]: 'export const NativeSafeAreaProvider = "REAL";\n',
    "entry.js": 'import { NativeSafeAreaProvider } from "react-native-safe-area-context";\n' +
      "export const result = { NativeSafeAreaProvider };\n",
  };
  STAND_INS["denext/react-native"] =
    'export const createNativeSafeAreaProvider = (View) => "DENEXT_SAFE_AREA(" + View + ")";\n';
  try {
    assertEquals(
      (await bundle({ reactNative: true }, extra)).NativeSafeAreaProvider,
      "DENEXT_SAFE_AREA(RNW_View)",
    );
    const off = await bundle({
      reactNative: { aliases: { "react-native-safe-area-context": false } },
    }, extra);
    assertEquals(off.NativeSafeAreaProvider, "REAL");
  } finally {
    delete STAND_INS["denext/react-native"];
  }
});
