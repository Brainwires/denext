// React Native mode's `react-native` entry additions at build time: the React Native names
// react-native-web does not export (requireNativeComponent and the internals' no-ops, the
// overlay's PermissionsAndroid / ToastAndroid / …, the useAnimatedValue family over
// react-native-web's Animated, InputAccessoryView / NativeAppEventEmitter from its own modules,
// unstable_batchedUpdates from react-dom) bind through a real esbuild bundle, degrade to the
// native ones when the overlay cannot resolve, and tree-shake away when unused. The overlay is a
// stand-in here; its behaviour is in react-native-core-apis.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import {
  ANIMATED_HOOK_EXPORTS,
  OVERLAY_ENTRY_EXPORTS,
  reactNativeBundleOptions,
  RN_OVERLAY_EXPORTS,
  WEB_ENTRY_EXPORTS,
  withNativeModuleExports,
} from "../src/build/react-native.ts";

/** Write `files` (relative path → contents) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/** A react-native-web whose entry lacks the names React Native mode adds. */
const RNW: Record<string, string> = {
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
    sideEffects: false,
  }),
  "node_modules/react-native-web/dist/index.js": [
    "View",
    "Text",
    "Animated",
    "TouchableNativeFeedback",
  ]
    .map((n) => `export { default as ${n} } from "./exports/${n}";\n`).join(""),
  "node_modules/react-native-web/dist/exports/View/index.js": 'export default "RNW_VIEW";\n',
  "node_modules/react-native-web/dist/exports/Text/index.js": 'export default "RNW_TEXT";\n',
  "node_modules/react-native-web/dist/exports/Animated/index.js":
    "export default { Value: function V(v) { this.v = v; }, ValueXY: function XY() {}, " +
    "Color: function C() {} };\n",
  "node_modules/react-native-web/dist/exports/DeviceEventEmitter/index.js":
    'export default "RNW_DEVICE_EVENTS";\n',
  "node_modules/react-native-web/dist/exports/InputAccessoryView/index.js":
    'export default "RNW_UNIMPLEMENTED";\n',
  "node_modules/react-native-web/dist/exports/ProgressBar/index.js":
    'export default "RNW_PROGRESS_BAR";\n',
  // react-native-web's unimplemented TouchableNativeFeedback and its press-event hook.
  "node_modules/react-native-web/dist/exports/TouchableNativeFeedback/index.js":
    'export default "RNW_UNIMPLEMENTED";\n',
  "node_modules/react-native-web/dist/modules/usePressEvents/index.js":
    'export default "RNW_PRESS";\n',
  // react-native-web's own SafeAreaView (replaced by the overlay).
  "node_modules/react-native-web/dist/exports/SafeAreaView/index.js": 'export default "RNW_SAV";\n',
  // The modules it vendors from React Native and its asset registry (React Native 0.88's
  // `EventEmitter`, `VirtualizedSectionList` and `AssetRegistry`), and the list primitives.
  "node_modules/react-native-web/dist/vendor/react-native/vendor/emitter/EventEmitter.js":
    "export default class EventEmitter { listenerCount() { return 0; } }\n",
  "node_modules/react-native-web/dist/vendor/react-native/VirtualizedSectionList/index.js":
    'export default "RNW_VSL";\n',
  "node_modules/react-native-web/dist/modules/AssetRegistry/index.js":
    "var assets = [];\nexport function registerAsset(a) { return assets.push(a); }\n" +
    "export function getAssetByID(id) { return assets[id - 1]; }\n",
  "node_modules/react-native-web/dist/exports/StyleSheet/index.js": 'export default "RNW_SHEET";\n',
  "node_modules/react-native-web/dist/exports/RefreshControl/index.js":
    'export default "RNW_RC";\n',
  "all.js": `import * as RN from "react-native";
import requireDeep from "react-native/Libraries/ReactNative/requireNativeComponent";
import * as Systrace from "react-native/Libraries/Performance/Systrace";
import PushDeep from "react-native/Libraries/PushNotificationIOS/PushNotificationIOS";
import resolveDeep from "react-native/Libraries/Image/resolveAssetSource";
export const names = Object.keys(RN).sort();
export const RNs = RN;
export { requireDeep, Systrace, PushDeep, resolveDeep };
`,
  "only-text.js": 'import { Text } from "react-native";\nexport const result = Text;\n',
};

/** The stand-ins for `denext/react-native` (every name it must export) and `react-dom`. */
const STAND_INS: Record<string, string> = {
  "denext/react-native": [
    ...OVERLAY_ENTRY_EXPORTS.map((n) => `export const ${n} = "DENEXT_${n}";\n`),
    ...Object.entries(RN_OVERLAY_EXPORTS).map(([n, kind]) =>
      kind !== "value"
        ? `export function create${n}(View) { return "DENEXT_${n}(" + View + ")"; }\n`
        : `export const ${n} = "DENEXT_${n}";\n`
    ),
    "export function createAnimatedHook(Animated, kind) {\n" +
    "  return function hook(v) { return new Animated[kind](v); };\n}\n",
    "export function createVirtualizedSectionList(p) {\n" +
    '  return "DENEXT_VSL(" + p.View + "," + p.StyleSheet + ")";\n}\n',
  ].join(""),
  "react-dom": "export function unstable_batchedUpdates(fn, a) { return fn(a); }\n",
};

/** Bundle `entry` with React Native mode's plugins (and the stand-ins, unless `bare`). */
async function bundle(
  entry: string,
  bare = false,
): Promise<{ code: string; mod: Record<string, unknown> }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_core_build_" });
  try {
    await writeTree(dir, RNW);
    const options = reactNativeBundleOptions({ reactNative: true }, dir, false)!;
    const standIn: esbuild.Plugin = {
      name: "stand-ins",
      setup(build) {
        build.onResolve({ filter: /^(?:denext\/react-native|react-dom)$/ }, (args) => ({
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
      entryPoints: [join(dir, entry)],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      define: options.define,
      plugins: bare ? options.plugins : [...options.plugins, standIn],
    });
    const code = new TextDecoder().decode(out.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return { code, mod: await import(url) };
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("react-native entry: every added name binds from its source", async () => {
  const { mod } = await bundle("all.js");
  const RN = mod.RNs as Record<string, unknown>;
  const names = mod.names as string[];
  for (
    const name of [
      "requireNativeComponent",
      "NativeComponentRegistry",
      "CodegenTypes",
      "DevMenu",
      "PushNotificationIOS",
      "registerCallableModule",
      "Systrace",
      ...OVERLAY_ENTRY_EXPORTS,
      ...Object.keys(ANIMATED_HOOK_EXPORTS),
      ...Object.keys(WEB_ENTRY_EXPORTS),
      "unstable_batchedUpdates",
    ]
  ) {
    assert(names.includes(name), `react-native exports ${name}`);
  }
  assertEquals(RN.PermissionsAndroid, "DENEXT_PermissionsAndroid");
  assertEquals(RN.DrawerLayoutAndroid, "DENEXT_DrawerLayoutAndroid", "no longer a build error");
  assertEquals(RN.Settings, "DENEXT_Settings");
  assertEquals(RN.ProgressBarAndroid, "RNW_PROGRESS_BAR", "react-native-web's ProgressBar");
  assertEquals(
    RN.TouchableNativeFeedback,
    "DENEXT_TouchableNativeFeedback(RNW_PRESS)",
    "react-native-web's UnimplementedView is replaced, over its press handling",
  );
  // The overlay stand-in has no resolveAssetSource: the plain fallback resolves.
  const resolve = mod.resolveDeep as (s: unknown) => unknown;
  assertEquals(resolve("/a.png"), { uri: "/a.png", scale: 1 });
  assertEquals(resolve([{ uri: "/b.png", width: 2 }]), { uri: "/b.png", width: 2 });
  assertEquals(resolve(7), null);
  assertEquals(RN.NativeAppEventEmitter, "RNW_DEVICE_EVENTS", "RN's alias of DeviceEventEmitter");
  assertEquals(
    RN.InputAccessoryView,
    "DENEXT_InputAccessoryView(RNW_VIEW)",
    "react-native-web's UnimplementedView is replaced by the overlay",
  );
  const value = (RN.useAnimatedValue as (v: number) => { v: number })(3);
  assertEquals(value.v, 3, "useAnimatedValue builds react-native-web's Animated.Value");
  assertEquals(
    (RN.unstable_batchedUpdates as (f: (a: number) => number, a: number) => number)(
      (a) => a + 1,
      1,
    ),
    2,
  );
  // requireNativeComponent: a component that renders nothing (warns once in dev).
  const warn = console.warn;
  console.warn = () => {};
  try {
    const Native = (RN.requireNativeComponent as (n: string) => (p: unknown) => unknown)("RNFast");
    assertEquals(Native({}), null);
    assertEquals((Native as unknown as { displayName: string }).displayName, "RNFast");
    assertEquals((mod.requireDeep as (n: string) => (p: unknown) => unknown)("X")({}), null);
  } finally {
    console.warn = warn;
  }
  // The internals load and do nothing.
  const Systrace = RN.Systrace as Record<string, (...a: unknown[]) => unknown>;
  assertEquals(Systrace.isEnabled(), false);
  assertEquals(typeof Systrace.beginAsyncEvent("x"), "number");
  assertEquals((mod.Systrace as Record<string, () => boolean>).isEnabled(), false, "deep import");
  const Push = RN.PushNotificationIOS as Record<string, (...a: unknown[]) => unknown>;
  assertEquals(mod.PushDeep, Push);
  assertEquals(await Push.getInitialNotification(), null);
  assertEquals(await Push.requestPermissions(), { alert: false, badge: false, sound: false });
  let badge: unknown;
  Push.getApplicationIconBadgeNumber((n: unknown) => void (badge = n));
  assertEquals(badge, 0);
  const Registry = RN.NativeComponentRegistry as Record<string, (...a: unknown[]) => unknown>;
  assertEquals(Registry.unstable_hasStaticViewConfig("X"), false);
  assertEquals((RN.DevMenu as { show(): void }).show(), undefined);
  assertEquals(RN.CodegenTypes, {});
  assertEquals(Systrace.trace("x", () => 7), 7, "Systrace.trace runs the function");
  assertEquals(
    (mod.Systrace as Record<string, (n: string, f: () => number) => number>)
      .trace("y", () => 8),
    8,
  );
});

Deno.test("react-native entry: EventEmitter, VirtualizedSectionList and AssetRegistry (React Native 0.88)", async () => {
  const { mod } = await bundle("all.js");
  const RN = mod.RNs as Record<string, unknown>;
  const Emitter = RN.EventEmitter as new () => { listenerCount(): number };
  assertEquals(new Emitter().listenerCount(), 0, "react-native-web's vendored EventEmitter");
  assertEquals(
    RN.VirtualizedSectionList,
    "DENEXT_VSL(RNW_VIEW,RNW_SHEET)",
    "the vendored VirtualizedSectionList loads as denext's adapter",
  );
  const assets = RN.AssetRegistry as {
    registerAsset(a: unknown): number;
    getAssetByID(id: number): unknown;
  };
  const id = assets.registerAsset({ name: "logo" });
  assertEquals(id, 1, "ids start at 1 (truthy), as in React Native");
  assertEquals(assets.getAssetByID(id), { name: "logo" });
  const bare = (await bundle("all.js", true)).mod.names as string[];
  assert(bare.includes("EventEmitter") && bare.includes("AssetRegistry"));
  assert(!bare.includes("VirtualizedSectionList"), "its adapter needs the overlay");
});

Deno.test("react-native entry: unused additions tree-shake away", async () => {
  const { code, mod } = await bundle("only-text.js");
  assertEquals(mod.result, "RNW_TEXT");
  for (
    const marker of ["DENEXT_", "PushNotificationIOS", "UIBackgroundFetchResult", "RNW_DEVICE"]
  ) {
    assert(!code.includes(marker), `${marker} is not in a bundle that never uses it`);
  }
});

Deno.test("react-native entry: without a resolvable overlay, only the native additions", async () => {
  const { mod } = await bundle("all.js", true);
  const names = mod.names as string[];
  assert(names.includes("requireNativeComponent"));
  assert(names.includes("NativeAppEventEmitter"), "react-native-web's own modules still add");
  assert(!names.includes("InputAccessoryView"), "the overlay replaces that one: skipped too");
  assert(!names.includes("PermissionsAndroid"), "no overlay: no overlay names, no build error");
  assert(!names.includes("useAnimatedValue"));
  assert(!names.includes("unstable_batchedUpdates"), "react-dom does not resolve here");
});

Deno.test("withNativeModuleExports: overlay, Animated, web-module and react-dom groups (ES + CJS)", () => {
  const sources = {
    overlay: true,
    reactDom: true,
    webModules: new Set(["Animated", "DeviceEventEmitter", "InputAccessoryView"]),
  };
  const esm = withNativeModuleExports('export { default as View } from "./View";\n', sources);
  assertStringIncludes(esm, 'import * as __denextOverlay from "denext/react-native";');
  assertStringIncludes(esm, "export var PermissionsAndroid = __denextOverlay.PermissionsAndroid;");
  assertStringIncludes(
    esm,
    'export var useAnimatedValueXY = /* @__PURE__ */ __denextAnimatedHook(__denextAnimated, "ValueXY");',
  );
  assertStringIncludes(
    esm,
    'export { default as NativeAppEventEmitter } from "./exports/DeviceEventEmitter";',
  );
  assertStringIncludes(esm, 'export { unstable_batchedUpdates } from "react-dom";');
  const cjs = withNativeModuleExports("exports.View = 1;\nexports.PlatformColor = 2;\n", sources);
  assertStringIncludes(cjs, "exports.PermissionsAndroid = __denextOverlay.PermissionsAndroid;");
  assert(!cjs.includes("exports.PlatformColor = __denextOverlay"), "its own is kept");
  assertStringIncludes(
    cjs,
    'exports.unstable_batchedUpdates = require("react-dom").unstable_batchedUpdates;',
  );
  assertStringIncludes(cjs, "exports.useAnimatedColor = /* @__PURE__ */ __denextAnimatedHook(");
  // Run the CommonJS additions against stand-ins: every name binds.
  const module = { exports: {} as Record<string, unknown> };
  const req = (spec: string): unknown =>
    ({
      "denext-react-native-native-modules": { requireNativeComponent: "NATIVE_RNC" },
      "denext/react-native": {
        ...Object.fromEntries(OVERLAY_ENTRY_EXPORTS.map((n) => [n, `OVL_${n}`])),
        createAnimatedHook: (_a: unknown, kind: string) => `HOOK_${kind}`,
      },
      "./exports/Animated": { __esModule: true, default: {} },
      "./exports/DeviceEventEmitter": "DEE",
      "./exports/InputAccessoryView": { __esModule: true, default: "IAV" },
      "react-dom": { unstable_batchedUpdates: "BATCH" },
    } as Record<string, unknown>)[spec] ?? {};
  new Function("module", "exports", "require", cjs)(module, module.exports, req);
  assertEquals(module.exports.PermissionsAndroid, "OVL_PermissionsAndroid");
  assertEquals(module.exports.useAnimatedColor, "HOOK_Color");
  assertEquals(module.exports.NativeAppEventEmitter, "DEE");
  assertEquals(module.exports.InputAccessoryView, "IAV");
  assertEquals(module.exports.unstable_batchedUpdates, "BATCH");
  assertEquals(module.exports.requireNativeComponent, "NATIVE_RNC");
});

Deno.test("the overlay module exports every name the entry takes from it", async () => {
  const overlay = await import("../src/react-native/mod.ts") as Record<string, unknown>;
  for (const name of [...OVERLAY_ENTRY_EXPORTS, "createAnimatedHook"]) {
    assert(overlay[name] !== undefined, `denext/react-native exports ${name}`);
  }
});

Deno.test("parity bundle surface: memberNames reads statics and object members, not builtins", async () => {
  const { memberNames } = await import("../scripts/parity/native/bundle.ts");
  class Base {
    static inherited = 1;
  }
  class Image extends Base {
    static prefetch() {}
  }
  assertEquals(
    memberNames(Image)?.filter((n) => !["length", "name", "prototype"].includes(n)),
    ["inherited", "prefetch"],
    "a class's own and inherited statics",
  );
  assertEquals(memberNames({ show() {}, SHORT: 0 }), ["SHORT", "show"]);
  assertEquals(memberNames(Object.create({ fromProto: 1 })), ["fromProto"]);
  assertEquals(memberNames("text"), undefined);
  assertEquals(memberNames(null), undefined);
});
