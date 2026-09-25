// React Native mode (`reactNative: true`): react-native → react-native-web for every importer,
// `.web.*` first (relative and package subpath), JSX in `.js`, the RN build-time globals, the
// throwing stub for a native-only deep import, and Expo's root style in the SPA shell. The
// resolver is exercised through a real esbuild bundle over a tiny temp node_modules fixture,
// with the same plugins and options the SPA compat bundle gets, and the output is executed.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import {
  appResolverPlugin,
  BROWSER_CONDITIONS,
  catalogResolverPlugin,
} from "../src/build/next-compat.ts";
import {
  expoShimPlugin,
  findReactNativeWeb,
  reactNativeBundleOptions,
  reactNativeDefines,
  reactNativeWebPlugin,
  WEB_PLATFORM_EXTENSIONS,
  withAppearancePolyfill,
  withNativeModuleExports,
} from "../src/build/react-native.ts";
import { spaShellHtml } from "../src/build/spa.ts";
import { resolveProject, validateDenextConfig } from "../src/build/paths.ts";
import { createSpaDevState } from "../src/build/spa/dev-state.ts";
import { expoRouterRoot } from "../src/build/expo-router.ts";
import {
  type DenextConfig,
  reactNativeOptions,
  reactNativeRootStyle,
} from "../src/server/config.ts";

/** Write `files` (relative path → contents) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/**
 * The fixture: a real `react-native` whose entry is Flow (unparseable: reaching it fails the
 * build), a `react-native-web` that must win, a package with a `.web.js` subpath variant and
 * JSX in a `.js` file, and app source with a `.web.tsx` sibling.
 */
const FIXTURE: Record<string, string> = {
  "deno.json": "{}\n",
  "node_modules/react-native/package.json": JSON.stringify({
    name: "react-native",
    main: "index.js",
  }),
  "node_modules/react-native/index.js": "import typeof View from './View';\nexport default 1;\n",
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
    sideEffects: false,
  }),
  "node_modules/react-native-web/dist/index.js":
    'export { default as View } from "./exports/View";\n',
  "node_modules/react-native-web/dist/exports/View/index.js": 'export default "RNW_VIEW";\n',
  "node_modules/react-native-web/dist/modules/AssetRegistry/index.js":
    'export const getAssetByID = () => "RNW_ASSET_REGISTRY";\n',
  // A dependency importing react-native itself: it must get react-native-web too.
  "node_modules/dep/package.json": JSON.stringify({ name: "dep", module: "index.js" }),
  "node_modules/dep/index.js":
    'import { View } from "react-native";\nexport const depView = View;\n',
  // A package subpath with a web variant, and JSX shipped in a plain `.js`.
  "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", module: "index.js" }),
  "node_modules/pkg/index.js": "export {};\n",
  "node_modules/pkg/lib/thing.js": 'export const thing = "NATIVE_THING";\n',
  "node_modules/pkg/lib/thing.web.js": 'export const thing = "WEB_THING";\n',
  "node_modules/pkg/lib/jsx.js": "export const el = <b>JSX_IN_JS</b>;\n",
  "comp.tsx": 'export const comp = "NATIVE_COMP";\n',
  "comp.web.tsx": 'export const comp = "WEB_COMP";\n',
  "entry.tsx": `import { View } from "react-native";
import DeepView from "react-native/Libraries/Components/View/View";
import { getAssetByID } from "react-native/Libraries/Image/AssetRegistry";
import deviceInfo, { getConstants } from "react-native/Libraries/Utilities/NativeDeviceInfo";
import { depView } from "dep";
import { thing } from "pkg/lib/thing";
import { el } from "pkg/lib/jsx";
import { comp } from "./comp";
function attempt(fn) { try { fn(); return "no error"; } catch (err) { return err.message; } }
export const result = {
  View, DeepView, depView, thing, comp, el,
  asset: getAssetByID(),
  dev: __DEV__,
  global: global === globalThis,
  expoOs: process.env.EXPO_OS,
  namedStub: attempt(() => getConstants()),
  defaultStub: attempt(() => deviceInfo()),
};
`,
};

/** Bundle the fixture's entry with React Native mode's plugins/options and run it. */
async function bundleAndRun(dev: boolean): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_" });
  try {
    await writeTree(dir, FIXTURE);
    const configPath = join(dir, "deno.json");
    const result = await esbuild.build({
      entryPoints: [join(dir, "entry.tsx")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      jsx: "transform",
      jsxFactory: "__h",
      define: { ...reactNativeDefines(dev), "process.env.NODE_ENV": '"test"' },
      loader: { ".js": "jsx" },
      // The SPA chain's order: the RN resolver (an extra plugin) ahead of the app and
      // node_modules resolvers, both probing the web extensions first.
      plugins: [
        reactNativeWebPlugin(dir),
        appResolverPlugin(configPath, WEB_PLATFORM_EXTENSIONS),
        catalogResolverPlugin(dir, "all", BROWSER_CONDITIONS, WEB_PLATFORM_EXTENSIONS),
      ],
    });
    const code = new TextDecoder().decode(result.outputFiles![0].contents);
    const g = globalThis as { __h?: unknown };
    g.__h = (_tag: string, _props: unknown, ...children: unknown[]) => children.join("");
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return (await import(url)).result;
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("reactNative bundle: react-native-web wins for every importer; .web.* first; JSX in .js", async () => {
  const r = await bundleAndRun(false);
  assertEquals(r.View, "RNW_VIEW", "app import of react-native → react-native-web");
  assertEquals(r.depView, "RNW_VIEW", "a dependency's import of react-native too");
  assertEquals(r.DeepView, "RNW_VIEW", "Libraries/…/View → react-native-web's exports/View");
  assertEquals(r.asset, "RNW_ASSET_REGISTRY", "Libraries/Image/AssetRegistry → modules/");
  assertEquals(r.comp, "WEB_COMP", "relative import: comp.web.tsx beats comp.tsx");
  assertEquals(r.thing, "WEB_THING", "package subpath: thing.web.js beats thing.js");
  assertEquals(r.el, "JSX_IN_JS", "JSX in a node_modules .js parses");
});

Deno.test("reactNative bundle: the RN globals are defined (__DEV__ follows dev)", async () => {
  const prod = await bundleAndRun(false);
  assertEquals(prod.dev, false);
  assertEquals(prod.global, true, "global → globalThis");
  assertEquals(prod.expoOs, "web");
  assertEquals((await bundleAndRun(true)).dev, true);
});

Deno.test("reactNative bundle: a native-only deep import loads, and throws naming it when called", async () => {
  const r = await bundleAndRun(false);
  const spec = "react-native/Libraries/Utilities/NativeDeviceInfo";
  for (const message of [r.namedStub, r.defaultStub] as string[]) {
    assertStringIncludes(message, `"${spec}" has no react-native-web equivalent`);
  }
});

/**
 * The codegen fixture: a TurboModule / Fabric package that named-imports the codegen entry
 * points from `react-native` (which react-native-web lacks) and from their deep paths, and
 * calls `getEnforcing` only lazily — as a web fallback behind a check.
 */
const CODEGEN_FIXTURE: Record<string, string> = {
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
    sideEffects: false,
  }),
  "node_modules/react-native-web/dist/index.js":
    'export { default as View } from "./exports/View";\n',
  "node_modules/react-native-web/dist/exports/View/index.js": 'export default "RNW_VIEW";\n',
  "node_modules/codegen-pkg/package.json": JSON.stringify({
    name: "codegen-pkg",
    module: "index.js",
  }),
  "node_modules/codegen-pkg/index.js":
    `import { TurboModuleRegistry, codegenNativeComponent, View } from "react-native";
import * as RN from "react-native";
import codegenDeep from "react-native/Libraries/Utilities/codegenNativeComponent";
import codegenNativeCommands from "react-native/Libraries/Utilities/codegenNativeCommands.js";
import { get as deepGet } from "react-native/Libraries/TurboModule/TurboModuleRegistry";
export const NativeThing = codegenNativeComponent("RNThingView");
export const DeepThing = codegenDeep("RNDeepView");
export const Commands = codegenNativeCommands({ supportedCommands: ["focus"] });
export const nativeModule = TurboModuleRegistry.get("ThingModule");
export const deepModule = deepGet("ThingModule");
import NativeThingModule from "./NativeThingModule.js";
export { NativeThingModule };
export const sameRegistry = RN.TurboModuleRegistry === TurboModuleRegistry;
export { View };
`,
  // A codegen spec: getEnforcing at module top level, as React Native's codegen emits it.
  "node_modules/codegen-pkg/NativeThingModule.js":
    `import { TurboModuleRegistry } from "react-native";
export default TurboModuleRegistry.getEnforcing("ThingModule");
`,
  "entry.js": 'export * from "codegen-pkg";\n',
};

Deno.test("reactNative bundle: TurboModuleRegistry / codegenNative* bind and degrade on the web", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_codegen_" });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    await writeTree(dir, CODEGEN_FIXTURE);
    const options = reactNativeBundleOptions({ reactNative: true }, dir, true)!;
    const result = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      define: options.define,
      plugins: options.plugins,
    });
    const code = new TextDecoder().decode(result.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    // Importing it evaluates every top-level codegen call: none of them throws.
    const r = await import(url);
    assertEquals(r.View, "RNW_VIEW", "react-native-web's own exports are intact");
    assertEquals(r.nativeModule, null, "TurboModuleRegistry.get → null");
    assertEquals(r.deepModule, null, "the deep TurboModuleRegistry too");
    assertEquals(r.sameRegistry, true, "a namespace import sees the same registry");
    // getEnforcing ran at load (the spec's top level) without throwing; use throws.
    const mod = r.NativeThingModule;
    const err = assertThrows(() => mod.someMethod(), Error);
    assertStringIncludes(err.message, '"ThingModule" is unavailable on the web');
    assertThrows(() => mod.CONSTANT, Error, '"ThingModule" is unavailable on the web');
    assertEquals(await Promise.resolve(mod), mod, "awaiting it does not throw (not thenable)");
    assertEquals(mod.then, undefined);
    assertEquals(mod.$$typeof, undefined, "not mistaken for a React element");
    assertEquals(mod[Symbol.toPrimitive], undefined);
    assertEquals(String(mod), "[native module ThingModule (unavailable on the web)]");
    assertEquals(`${mod}`, "[native module ThingModule (unavailable on the web)]");
    // Introspection (logging, error overlays, test matchers) never throws.
    const description = "[native module ThingModule (unavailable on the web)]";
    assertEquals(JSON.stringify(mod), JSON.stringify(description), "toJSON → the description");
    assertEquals(mod.constructor, Object);
    for (const key of ["__esModule", "inspect", "nodeType", "asymmetricMatch"]) {
      assertEquals(mod[key], undefined, key);
    }
    assertEquals(mod["@@__IMMUTABLE_ITERABLE__@@"], undefined, "@@-prefixed keys");
    assertEquals(Object.prototype.toString.call(mod), "[object Object]");
    const log = console.log;
    const logged: string[] = [];
    // Format the way console.log does (Deno.inspect), capturing the output.
    console.log = (...args: unknown[]) => logged.push(args.map((a) => Deno.inspect(a)).join(" "));
    try {
      console.log(mod);
    } finally {
      console.log = log;
    }
    assertEquals(logged.length, 1, "console.log(mod) does not throw");
    assertThrows(() => mod.getConstants, Error, '"ThingModule" is unavailable on the web');
    assertEquals(r.NativeThing({}), null, "a codegen component renders nothing");
    assertEquals(r.NativeThing({}), null);
    assertEquals(r.DeepThing({}), null, "the deep codegenNativeComponent too");
    assertEquals(r.NativeThing.displayName, "RNThingView");
    assertEquals(warnings.length, 2, "one dev warning per component name");
    assertStringIncludes(warnings[0], "<RNThingView> is a native component");
    assertStringIncludes(warnings[1], "<RNDeepView>");
    assertEquals(r.Commands.focus("ref"), undefined, "native commands are no-ops");
    assertEquals(r.Commands.anything(), undefined);
    assertEquals(r.Commands.then, undefined, "the commands object is not thenable");
  } finally {
    console.warn = warn;
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withNativeModuleExports: appended to an ES or CommonJS entry; existing names kept", () => {
  const esm = withNativeModuleExports('export { default as View } from "./View";\n');
  assertStringIncludes(
    esm,
    'export { TurboModuleRegistry, codegenNativeComponent, codegenNativeCommands } from "denext-react-native-native-modules";',
  );
  const partial = withNativeModuleExports(
    "export const TurboModuleRegistry = {};\nexport function codegenNativeComponent() {}\n" +
      "export function codegenNativeCommands() {}\n",
  );
  assert(!partial.includes("denext-react-native-native-modules"), "all present: unchanged");
  const cjs = withNativeModuleExports("exports.View = 1;\nexports.TurboModuleRegistry = {};\n");
  assertStringIncludes(cjs, 'require("denext-react-native-native-modules")');
  assertStringIncludes(
    cjs,
    "exports.codegenNativeComponent = __denextNative.codegenNativeComponent;",
  );
  assert(!cjs.includes("exports.TurboModuleRegistry = __denextNative"), "its own is kept");
});

Deno.test("reactNative bundle: a missing react-native-web is a clear build error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_missing_" });
  try {
    await writeTree(dir, { "entry.js": 'import "react-native";\n' });
    assertEquals(await findReactNativeWeb(dir), null);
    const err = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [reactNativeWebPlugin(dir)],
    }).then(() => null, (e: Error) => e);
    assert(err, "the build must fail");
    assertStringIncludes(err.message, "react-native-web is not installed");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reactNativeDefines and reactNativeBundleOptions", () => {
  assertEquals(reactNativeDefines(true), {
    __DEV__: "true",
    global: "globalThis",
    "process.env.EXPO_OS": '"web"',
  });
  assertEquals(reactNativeDefines(false).__DEV__, "false");
  assertEquals(reactNativeBundleOptions({}, "/p", false), null, "off by default");
  assertEquals(reactNativeBundleOptions({ reactNative: false }, "/p", false), null);
  const on = reactNativeBundleOptions({ reactNative: true }, "/p", true)!;
  assertEquals(on.define.__DEV__, "true");
  assertEquals(on.platformExtensions, [".web.tsx", ".web.ts", ".web.jsx", ".web.js"]);
  assertEquals(on.jsxInJs, true);
  assertEquals(on.plugins.map((p) => p.name), [
    "denext-react-native-web",
    "denext-expo-router-ctx",
    "denext-expo-shims",
  ]);
  const off = reactNativeBundleOptions({ reactNative: { expoShims: false } }, "/p", false)!;
  assertEquals(
    off.plugins.map((p) => p.name),
    ["denext-react-native-web", "denext-expo-router-ctx"],
    "expoShims: false",
  );
});

/**
 * The expo fixture: real `expo-haptics` and `expo` packages (which must NOT win), an
 * unshimmed `expo-location` (which must resolve normally), and react-native-web for the shims'
 * bridge. `denext/expo/*` is stood in for by a plugin, as the prebuilt runtime is in a build.
 */
const EXPO_FIXTURE: Record<string, string> = {
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
  }),
  "node_modules/react-native-web/dist/index.js": 'export const View = "RNW_VIEW";\n',
  "node_modules/expo-haptics/package.json": JSON.stringify({ name: "expo-haptics", main: "i.js" }),
  "node_modules/expo-haptics/i.js": 'export const impactAsync = "REAL_EXPO_HAPTICS";\n',
  "node_modules/expo/package.json": JSON.stringify({ name: "expo", main: "i.js" }),
  "node_modules/expo/i.js": 'export const registerRootComponent = "REAL_EXPO";\n',
  "node_modules/expo/config.js": 'export const config = "REAL_EXPO_CONFIG";\n',
  "node_modules/expo/fetch.js": 'export const fetch = "REAL_EXPO_FETCH";\n',
  "node_modules/expo-file-system/package.json": JSON.stringify({
    name: "expo-file-system",
    exports: { ".": "./i.js", "./legacy": "./legacy.js" },
  }),
  "node_modules/expo-file-system/i.js": 'export const File = "REAL_EXPO_FS";\n',
  "node_modules/expo-file-system/legacy.js":
    'export const readAsStringAsync = "REAL_EXPO_FS_LEGACY";\n',
  "node_modules/expo-location/package.json": JSON.stringify({
    name: "expo-location",
    main: "i.js",
  }),
  "node_modules/expo-location/i.js":
    'export const getCurrentPositionAsync = "REAL_EXPO_LOCATION";\n',
  "entry.js": `import { impactAsync } from "expo-haptics";
import { registerRootComponent } from "expo";
import { fetch } from "expo/fetch";
import { config } from "expo/config.js";
import { getCurrentPositionAsync } from "expo-location";
import { readAsStringAsync } from "expo-file-system/legacy";
import { View } from "denext-expo-react-native";
export const result = { impactAsync, registerRootComponent, fetch, config, getCurrentPositionAsync, readAsStringAsync, View };
`,
};

/** Bundle the expo fixture with React Native mode's plugins (`expoShims` on or off). */
async function bundleExpoFixture(expoShims: boolean): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_expo_" });
  try {
    await writeTree(dir, EXPO_FIXTURE);
    const options = reactNativeBundleOptions(
      { reactNative: { expoShims } },
      dir,
      false,
    )!;
    const standIn: esbuild.Plugin = {
      name: "denext-expo-stand-in",
      setup(build) {
        build.onResolve({ filter: /^denext\/expo\// }, (args) => ({
          path: args.path,
          namespace: "stand-in",
        }));
        build.onLoad({ filter: /.*/, namespace: "stand-in" }, (args) => ({
          contents: `const shim = ${JSON.stringify(args.path)};
export { shim as impactAsync, shim as registerRootComponent, shim as fetch, shim as readAsStringAsync };`,
          loader: "js",
        }));
      },
    };
    const result = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: [...options.plugins, standIn],
    });
    const code = new TextDecoder().decode(result.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return (await import(url)).result;
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("reactNative bundle: expo-* resolves to its denext/expo shim; unshimmed ones resolve normally", async () => {
  const r = await bundleExpoFixture(true);
  assertEquals(r.impactAsync, "denext/expo/haptics", "expo-haptics → the shim, not the package");
  assertEquals(r.registerRootComponent, "denext/expo/expo", "expo → denext/expo/expo");
  assertEquals(r.fetch, "denext/expo/expo", "the known subpath expo/fetch → the same shim");
  assertEquals(r.config, "REAL_EXPO_CONFIG", "an unknown subpath resolves normally");
  assertEquals(
    r.readAsStringAsync,
    "denext/expo/file-system/legacy",
    "a subpath with its own shim → that shim",
  );
  assertEquals(
    r.getCurrentPositionAsync,
    "REAL_EXPO_LOCATION",
    "a package without a shim resolves normally",
  );
  assertEquals(r.View, "RNW_VIEW", "the shims' bridge → react-native-web");
  assertEquals(expoShimPlugin().name, "denext-expo-shims");
});

Deno.test("reactNative bundle: expoShims: false resolves every expo-* package normally", async () => {
  const r = await bundleExpoFixture(false);
  assertEquals(r.impactAsync, "REAL_EXPO_HAPTICS");
  assertEquals(r.registerRootComponent, "REAL_EXPO");
  assertEquals(r.fetch, "REAL_EXPO_FETCH");
  assertEquals(r.readAsStringAsync, "REAL_EXPO_FS_LEGACY");
});

const SPA = { entry: "./src/main.tsx" };
const ROOT_STYLE = "html,body,#root{height:100%;margin:0}#root{display:flex}";

Deno.test("spaShellHtml: Expo's root style only in reactNative mode, before spa.head", async () => {
  const plain = await spaShellHtml({ spa: SPA, scriptSrc: "/x.js" });
  assert(!plain.includes("display:flex"), "no root style without reactNative");
  const rn = await spaShellHtml({
    spa: { ...SPA, head: "<style>#root{background:red}</style>" },
    scriptSrc: "/x.js",
    reactNativeRootStyle: true,
  });
  assertStringIncludes(rn, `<style>${ROOT_STYLE}</style>`);
  assert(rn.indexOf(ROOT_STYLE) < rn.indexOf("background:red"), "spa.head can override it");
  const custom = await spaShellHtml({
    spa: { ...SPA, rootId: "app" },
    scriptSrc: "/x.js",
    reactNativeRootStyle: true,
  });
  assertStringIncludes(custom, "#app{display:flex}");
});

Deno.test("reactNative config: options, root-style switch, validation", () => {
  assertEquals(reactNativeOptions({}), null);
  assertEquals(reactNativeOptions({ reactNative: true }), {});
  assertEquals(reactNativeOptions({ reactNative: { rootStyle: false } }), { rootStyle: false });
  assertEquals(reactNativeRootStyle({ reactNative: true }), true);
  assertEquals(reactNativeRootStyle({ reactNative: { rootStyle: false } }), false);
  assertEquals(reactNativeRootStyle({}), false);
  const spa: DenextConfig = { mode: "spa", spa: SPA };
  validateDenextConfig({ ...spa, reactNative: true });
  validateDenextConfig({ ...spa, reactNative: { rootStyle: false } });
  validateDenextConfig({ ...spa, reactNative: { expoShims: false } });
  assertThrows(
    () => validateDenextConfig({ ...spa, reactNative: { expoShims: 1 as unknown as boolean } }),
    Error,
    "`reactNative.expoShims` must be a boolean",
  );
  validateDenextConfig({ reactNative: false });
  assertThrows(
    () => validateDenextConfig({ ...spa, reactNative: "yes" as unknown as boolean }),
    Error,
    "`reactNative` must be a boolean or an options object",
  );
  assertThrows(
    () =>
      validateDenextConfig({
        ...spa,
        reactNative: { rootStyle: "no" as unknown as boolean },
      }),
    Error,
    "`reactNative.rootStyle` must be a boolean",
  );
  assertThrows(
    () => validateDenextConfig({ reactNative: true }),
    Error,
    "applies only in SPA mode",
  );
});

/** react-native-web 0.21's `Appearance` module, verbatim in shape (no `setColorScheme`). */
const RNW_APPEARANCE = `'use client';
function getQuery() {
  return window.matchMedia != null ? window.matchMedia('(prefers-color-scheme: dark)') : null;
}
var query = getQuery();
var listenerMapping = new WeakMap();
var Appearance = {
  getColorScheme() {
    return query && query.matches ? 'dark' : 'light';
  },
  addChangeListener(listener) {
    var mappedListener = listenerMapping.get(listener);
    if (!mappedListener) {
      mappedListener = _ref => {
        listener({ colorScheme: _ref.matches ? 'dark' : 'light' });
      };
      listenerMapping.set(listener, mappedListener);
    }
    if (query) query.addListener(mappedListener);
    function remove() {
      var mapped = listenerMapping.get(listener);
      if (query && mapped) query.removeListener(mapped);
      listenerMapping.delete(listener);
    }
    return { remove };
  }
};
export default Appearance;`;

Deno.test("reactNative bundle: Appearance.setColorScheme overrides the scheme, listeners and the root", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_appearance_" });
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  // A system media query that reports light and can flip, and a root element.
  const mediaListeners = new Set<(e: { matches: boolean }) => void>();
  const media = {
    matches: false,
    addListener: (l: (e: { matches: boolean }) => void) => mediaListeners.add(l),
    removeListener: (l: (e: { matches: boolean }) => void) => mediaListeners.delete(l),
  };
  const rootStyle = new Map<string, string>();
  g.window = { matchMedia: () => media };
  g.document = {
    documentElement: {
      style: {
        set colorScheme(v: string) {
          rootStyle.set("color-scheme", v);
        },
        removeProperty: (name: string) => rootStyle.delete(name),
      },
    },
  };
  try {
    await writeTree(dir, {
      "node_modules/react-native-web/package.json": JSON.stringify({
        name: "react-native-web",
        module: "dist/index.js",
      }),
      "node_modules/react-native-web/dist/index.js":
        'export { default as Appearance } from "./exports/Appearance";\n',
      "node_modules/react-native-web/dist/exports/Appearance/index.js": RNW_APPEARANCE,
      // Another module importing the same Appearance (as useColorScheme does).
      "node_modules/react-native-web/dist/exports/useColorScheme/index.js":
        'import Appearance from "../Appearance";\nexport default () => Appearance.getColorScheme();\n',
      "entry.js": `import { Appearance } from "react-native";
import useColorScheme from "react-native/Libraries/Utilities/useColorScheme";
export { Appearance, useColorScheme };
`,
    });
    const options = reactNativeBundleOptions({ reactNative: true }, dir, false)!;
    const result = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: options.plugins,
    });
    const code = new TextDecoder().decode(result.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    const { Appearance, useColorScheme: colorSchemeOf } = await import(url);
    const seen: string[] = [];
    const sub = Appearance.addChangeListener((e: { colorScheme: string }) =>
      seen.push(e.colorScheme)
    );
    assertEquals(Appearance.getColorScheme(), "light");
    Appearance.setColorScheme("dark");
    assertEquals(Appearance.getColorScheme(), "dark");
    assertEquals(colorSchemeOf(), "dark", "every importer shares the extended object");
    assertEquals(rootStyle.get("color-scheme"), "dark");
    assertEquals(seen, ["dark"]);
    // A system change is not reported while overridden.
    media.matches = true;
    for (const l of mediaListeners) l({ matches: true });
    assertEquals(seen, ["dark"]);
    // "unspecified" restores the system scheme (now dark: no change to report).
    Appearance.setColorScheme("unspecified");
    assertEquals(Appearance.getColorScheme(), "dark");
    assertEquals(rootStyle.has("color-scheme"), false);
    assertEquals(seen, ["dark"]);
    Appearance.setColorScheme("light");
    assertEquals(seen, ["dark", "light"]);
    Appearance.setColorScheme(null);
    assertEquals(seen, ["dark", "light", "dark"]);
    for (const l of mediaListeners) l({ matches: false });
    assertEquals(seen, ["dark", "light", "dark", "light"], "system changes report again");
    sub.remove();
    Appearance.setColorScheme("dark");
    assertEquals(seen.length, 4, "a removed listener hears nothing");
    assertEquals(mediaListeners.size, 0);
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withAppearancePolyfill: inserted ahead of the default export; left alone without one", () => {
  const out = withAppearancePolyfill("var A = {};\nexport default A;");
  assertStringIncludes(out, "})(A);\nexport default A;");
  assertEquals(withAppearancePolyfill("module.exports = {};"), "module.exports = {};");
});

Deno.test("reactNative dev: an explicit unbundled: true is refused (the bundled loop is required)", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_rn_unbundled_" }));
  try {
    await writeTree(dir, {
      "denext.config.ts":
        'export default { mode: "spa", reactNative: true, spa: { entry: "index.ts" } };\n',
      "index.ts": "export {};\n",
      "deno.json": "{}\n",
    });
    const paths = await resolveProject(dir);
    assertThrows(
      () => createSpaDevState({ paths, unbundled: true }),
      Error,
      "`reactNative` apps develop on the bundled dev loop",
    );
    assertEquals(createSpaDevState({ paths }).unbundledOptIn, false, "the default is bundled");
    assertEquals(createSpaDevState({ paths, unbundled: false }).unbundledOptIn, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reactNative bundle: expo-router/_ctx is the app/ route context, generated at build", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_router_" });
  try {
    await writeTree(dir, {
      "app/_layout.tsx": 'export default "LAYOUT";\n',
      "app/index.tsx": 'export default "HOME";\n',
      "app/(tabs)/settings.tsx": 'export default "SETTINGS";\n',
      "app/[id].web.tsx": 'export default "WEB_ID";\n',
      "app/native-only.ios.tsx": 'export default "IOS";\n',
      "app/api/data+api.ts": "export const GET = 1;\n",
      "app/+html.tsx": 'export default "HTML";\n',
      "app/notes.md": "not a route\n",
      "entry.js": `import { ctx } from "expo-router/_ctx";
export const keys = ctx.keys();
export const home = ctx("./index.tsx").default;
export const settings = ctx("./(tabs)/settings.tsx").default;
export const resolved = ctx.resolve("./index.tsx");
let missing = "";
try { ctx("./nope.tsx"); } catch (err) { missing = err.message; }
export { missing };
`,
    });
    const options = reactNativeBundleOptions({ reactNative: true }, dir, false)!;
    const result = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: options.plugins,
    });
    const code = new TextDecoder().decode(result.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    const r = await import(url);
    assertEquals(r.keys, [
      "./(tabs)/settings.tsx",
      "./[id].web.tsx",
      "./_layout.tsx",
      "./index.tsx",
    ]);
    assertEquals(r.home, "HOME");
    assertEquals(r.settings, "SETTINGS");
    assertEquals(r.resolved, "./index.tsx");
    assertStringIncludes(r.missing, 'no route module "./nope.tsx"');
    // src/app is the other convention.
    await Deno.rename(join(dir, "app"), join(dir, "routes"));
    await Deno.mkdir(join(dir, "src/app"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src/app/index.tsx"), "export default 1;\n");
    assertEquals(await expoRouterRoot(dir), join(dir, "src/app"));
    await Deno.remove(join(dir, "src"), { recursive: true });
    assertEquals(await expoRouterRoot(dir), null);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
