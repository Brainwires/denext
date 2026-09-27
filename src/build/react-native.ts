// React Native mode (`reactNative` in denext.config.ts): build an Expo / React Native app's
// source for the web through react-native-web, with no hand patches.
//
// What Metro + babel-preset-expo do for a web build, restated for the SPA's esbuild bundle
// (measured in the 2026-09-24 spike, REACT-NATIVE-EXPO.md):
//
//   - `react-native` and every `react-native/…` subpath resolve to the installed
//     react-native-web — for EVERY importer, ahead of the node_modules resolver, so a real
//     `react-native` in node_modules (Flow source) is never reached. The package is resolved
//     to its realpath, so its own pnpm-private deps (`styleq`, `fbjs`, …) resolve beside it.
//     A deep `react-native/Libraries/…` import maps to react-native-web's equivalent where
//     one exists; otherwise it loads a stub that throws, naming the import, when used.
//   - The codegen / TurboModule entry points react-native-web lacks — `TurboModuleRegistry`,
//     `codegenNativeComponent`, `codegenNativeCommands` and `requireNativeComponent` — are
//     added to its entry and back their deep `Libraries/…` imports: no native module is
//     registered (`get` → null, `getEnforcing` returns a module that throws, naming it, on
//     first use), a native component renders nothing, and native commands do nothing. React
//     Native internals a library may import (`CodegenTypes`, `DevMenu`,
//     `NativeComponentRegistry`, `PushNotificationIOS`, `registerCallableModule`, `Systrace`)
//     are load-safe no-ops.
//   - The entry also gains the React Native APIs react-native-web has no module for, from the
//     shell overlay (`PermissionsAndroid`, `ToastAndroid`, `ActionSheetIOS`, `DevSettings`,
//     `PlatformColor`, `DynamicColorIOS`, `RootTagContext`), the `useAnimatedValue` family
//     over its own `Animated`, `InputAccessoryView` and `NativeAppEventEmitter` from its own
//     modules, and `unstable_batchedUpdates` from `react-dom` (withNativeModuleExports).
//   - `.web.tsx` / `.web.ts` / `.web.jsx` / `.web.js` are probed first (the bundler's
//     `platformExtensions`), for relative/alias imports and package subpaths.
//   - `.js` parses as JSX (the bundler's `jsxInJs`).
//   - `__DEV__`, `global` and `process.env.EXPO_OS` are defined at build time.
//   - react-native-web's `Appearance` gains `setColorScheme` (React Native 0.72+), which it
//     lacks: an override `getColorScheme()`, the change listeners and the root element's
//     `color-scheme` honour.
//   - The shell overlay: react-native-web stays pinned and unforked, and each of its modules
//     named in RN_OVERLAY_EXPORTS (the mocks — Keyboard, KeyboardAvoidingView, BackHandler,
//     StatusBar, AccessibilityInfo, I18nManager, Alert, RefreshControl — plus Platform,
//     Linking, AppState, Vibration, Share, Clipboard and SafeAreaView, whose browser-only
//     versions fall short in the Capacitor shell, and InputAccessoryView, which it leaves
//     unimplemented) loads as a one-line module that re-exports denext's
//     implementation from `denext/react-native` (src/react-native/, a prebuilt runtime entry
//     sharing the app's one denext instance). Replacing the module file, not the `react-native`
//     entry, reaches every importer: the app, libraries, deep `react-native/Libraries/…`
//     imports and react-native-web's own internals (its FlatList builds a RefreshControl).
//     Unused ones still tree-shake away (react-native-web is `sideEffects: false`). The
//     components take react-native-web's `View` from the replaced module. `Platform.OS` stays
//     "web" in the shell: react-native-web and the libraries on top of it pick their DOM code
//     paths by it (see src/react-native/platform.ts).
//   - `expo-router/_ctx` (Metro's `require.context` over the route directory) resolves to a
//     module generated from the app's `app/` (or `src/app/`) files (expo-router.ts), and the
//     app's `expo-router` / `expo-router/stack` / `expo-router/tabs` imports get `Stack` /
//     `Tabs` drawn by `denext/navigation` (expo-router-navigators.ts; the bundle then includes
//     the `Activity` runtime, which hidden stack screens need).
//   - `react-native-windows` / `react-native-macos` resolve to `react-native` plus what each
//     adds (Flyout, Popup, Glyph, AppTheme, DynamicColorMacOS, the desktop View props, …),
//     from the overlay (react-native-desktop.ts).
//   - React Native's FlatList / SectionList / VirtualizedList and the FlashList / LegendList
//     packages run on denext's VirtualList unless `reactNative: { lists: "library" }`
//     (react-native-lists.ts).
//   - Each `expo-*` package in the `denext/expo` manifest (and its known subpaths) resolves
//     to its `denext/expo/<name>` shim, unless `reactNative: { expoShims: false }`; the
//     shims' react-native-web bridge resolves to the app's react-native-web.
//
// The SPA shell's root style lives with the shell (spa/shared.ts).

import { basename, dirname, join } from "@std/path";
import type * as esbuild from "esbuild";
import { type DenextConfig, reactNativeOptions } from "../server/config.ts";
import { BROWSER_CONDITIONS, resolveInPackageDir, withPackageSideEffects } from "./next-compat.ts";
import { EXPO_FILTER, EXPO_RN_BRIDGE, expoShimSpecifier } from "./expo-shims.ts";
import { expoRouterContextPlugin } from "./expo-router.ts";
import { expoRouterNavigatorsPlugin } from "./expo-router-navigators.ts";
import { listAdaptersPlugin } from "./react-native-lists.ts";
import { reanimatedWorkletsPlugin } from "./reanimated.ts";
import { desktopReactNativePlugin } from "./react-native-desktop.ts";
import { reactNativeAliasesPlugin, resolveInstead } from "./react-native-aliases.ts";

/** The web platform extensions React Native mode probes ahead of the plain ones. */
export const WEB_PLATFORM_EXTENSIONS: readonly string[] = [
  ".web.tsx",
  ".web.ts",
  ".web.jsx",
  ".web.js",
];

/** The package every `react-native` import is redirected to. */
const WEB_PACKAGE = "react-native-web";

/** The esbuild namespace of the throwing stub for a native-only deep import. */
const STUB_NAMESPACE = "denext-react-native-stub";

/**
 * The specifier of the web stand-ins for React Native's codegen / TurboModule entry points
 * ({@linkcode nativeModulesSource}); it resolves into {@linkcode NATIVE_NAMESPACE}.
 */
const NATIVE_MODULES = "denext-react-native-native-modules";

/** The esbuild namespace of the codegen / TurboModule stand-ins and their deep-import faces. */
const NATIVE_NAMESPACE = "denext-react-native-native";

/**
 * The deep `react-native/Libraries/…` imports served by the stand-ins instead of
 * react-native-web (which has no `codegenNative*`, and whose vendored `TurboModuleRegistry`
 * fails with a native-binary message), each as the module source that re-exports them.
 */
const NATIVE_DEEP_IMPORTS: Readonly<Record<string, string>> = {
  "Libraries/TurboModule/TurboModuleRegistry":
    `export { get, getEnforcing } from "${NATIVE_MODULES}";\n`,
  "Libraries/Utilities/codegenNativeComponent":
    `export { codegenNativeComponent, codegenNativeComponent as default } from "${NATIVE_MODULES}";\n`,
  "Libraries/Utilities/codegenNativeCommands":
    `export { codegenNativeCommands, codegenNativeCommands as default } from "${NATIVE_MODULES}";\n`,
  "Libraries/ReactNative/requireNativeComponent":
    `export { requireNativeComponent, requireNativeComponent as default } from "${NATIVE_MODULES}";\n`,
  "Libraries/NativeComponent/NativeComponentRegistry":
    `import { NativeComponentRegistry as R } from "${NATIVE_MODULES}";\n` +
    "export var get = R.get, getWithFallback_DEPRECATED = R.getWithFallback_DEPRECATED, " +
    "setRuntimeConfigProvider = R.setRuntimeConfigProvider, " +
    "unstable_hasStaticViewConfig = R.unstable_hasStaticViewConfig;\n",
  "Libraries/Performance/Systrace": `import { Systrace as S } from "${NATIVE_MODULES}";\n` +
    "export var isEnabled = S.isEnabled, setEnabled = S.setEnabled, beginEvent = S.beginEvent, " +
    "endEvent = S.endEvent, beginAsyncEvent = S.beginAsyncEvent, " +
    "endAsyncEvent = S.endAsyncEvent, counterEvent = S.counterEvent;\n",
  "Libraries/Core/registerCallableModule":
    `export { registerCallableModule as default } from "${NATIVE_MODULES}";\n`,
  "Libraries/PushNotificationIOS/PushNotificationIOS":
    `export { PushNotificationIOS as default } from "${NATIVE_MODULES}";\n`,
};

/**
 * The names react-native-web's entry gains from {@linkcode nativeModulesSource}: the codegen /
 * TurboModule entry points, `requireNativeComponent` (the same stand-in as
 * `codegenNativeComponent`), and load-safe no-ops for React Native internals a library may
 * import (`CodegenTypes`, `DevMenu`, `NativeComponentRegistry`, `PushNotificationIOS`,
 * `registerCallableModule`, `Systrace`).
 */
const NATIVE_ENTRY_EXPORTS = [
  "TurboModuleRegistry",
  "codegenNativeComponent",
  "codegenNativeCommands",
  "requireNativeComponent",
  "NativeComponentRegistry",
  "CodegenTypes",
  "DevMenu",
  "PushNotificationIOS",
  "registerCallableModule",
  "Systrace",
] as const;

/**
 * The names react-native-web's entry gains from the shell overlay (`denext/react-native`,
 * src/react-native/): React Native APIs react-native-web does not have at all.
 */
export const OVERLAY_ENTRY_EXPORTS: readonly string[] = [
  "ActionSheetIOS",
  "DevSettings",
  "DynamicColorIOS",
  "PermissionsAndroid",
  "PlatformColor",
  "RootTagContext",
  "ToastAndroid",
];

/**
 * The names react-native-web's entry gains from its own modules, which it ships but leaves out
 * of its entry: each name's module under `exports/` (its default export). `InputAccessoryView`
 * is then replaced by the overlay (see {@linkcode RN_OVERLAY_EXPORTS}); `NativeAppEventEmitter`
 * is React Native's alias of `DeviceEventEmitter`.
 */
export const WEB_ENTRY_EXPORTS: Readonly<Record<string, string>> = {
  InputAccessoryView: "InputAccessoryView",
  NativeAppEventEmitter: "DeviceEventEmitter",
};

/**
 * React Native's `Animated` hooks the entry gains, each built by the overlay's
 * `createAnimatedHook` over react-native-web's own `Animated` (the node class it constructs).
 */
export const ANIMATED_HOOK_EXPORTS: Readonly<Record<string, "Value" | "ValueXY" | "Color">> = {
  useAnimatedValue: "Value",
  useAnimatedValueXY: "ValueXY",
  useAnimatedColor: "Color",
};

/** The names the entry re-exports from `react-dom` (denext's, in React Native mode). */
const REACT_DOM_ENTRY_EXPORTS = ["unstable_batchedUpdates"] as const;

/**
 * `react-native` itself or any `react-native/…` subpath (not `react-native-web`, etc.), and
 * the `denext/expo/*` shims' bridge to react-native-web's primitives.
 */
const REACT_NATIVE_FILTER = new RegExp(`^(?:react-native(?:/.*)?|${EXPO_RN_BRIDGE})$`);

/**
 * The build-time globals React Native code expects: `__DEV__` (Metro's dev flag; true in dev,
 * false in a production build), Node's `global` as `globalThis` (reanimated, gesture-handler)
 * and `process.env.EXPO_OS`, which babel-preset-expo inlines as the target platform.
 *
 * @param dev Whether this is a dev build.
 * @returns The esbuild `define` entries.
 */
export function reactNativeDefines(dev: boolean): Record<string, string> {
  return {
    __DEV__: String(dev),
    global: "globalThis",
    "process.env.EXPO_OS": JSON.stringify("web"),
  };
}

/**
 * The realpath of the `react-native-web` package directory visible from `projectDir` (walking
 * up `node_modules` like Node), or null when it is not installed. The realpath, not the
 * symlink: pnpm keeps a package's own deps next to its real location.
 *
 * @param projectDir Where the lookup starts.
 */
export async function findReactNativeWeb(projectDir: string): Promise<string | null> {
  let dir = projectDir;
  for (;;) {
    const candidate = join(dir, "node_modules", WEB_PACKAGE);
    try {
      if ((await Deno.stat(join(candidate, "package.json"))).isFile) {
        return await Deno.realPath(candidate);
      }
    } catch { /* not here — keep walking up */ }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where, inside react-native-web, a `react-native/<sub>` import may live, most specific first.
 * `Libraries/<path>` (React Native's internal layout) tries react-native-web's vendored copy
 * of the same path, then the public export and the internal module of the same name
 * (`Libraries/Components/View/View` → `exports/View`, `Libraries/Image/AssetRegistry` →
 * `modules/AssetRegistry`). Anything else is taken relative to `dist/`.
 */
function webCandidates(sub: string): string[] {
  if (!sub.startsWith("Libraries/")) return [`dist/${sub}`];
  const rest = sub.slice("Libraries/".length).replace(/\.js$/, "");
  const name = basename(rest);
  return [`dist/vendor/react-native/${rest}`, `dist/exports/${name}`, `dist/modules/${name}`];
}

/** The first real file among `base`, `base.js` and `base/index.js`, realpath'd, or null. */
async function probeWebFile(base: string): Promise<string | null> {
  for (const candidate of [base, `${base}.js`, join(base, "index.js")]) {
    try {
      if ((await Deno.stat(candidate)).isFile) return await Deno.realPath(candidate);
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * The react-native-web file a `react-native` specifier resolves to, or null when it has no
 * web equivalent (the caller substitutes the throwing stub).
 *
 * @param webDir The react-native-web package directory ({@linkcode findReactNativeWeb}).
 * @param spec `react-native` or a `react-native/…` subpath.
 */
async function resolveReactNativeSpecifier(
  webDir: string,
  spec: string,
): Promise<string | null> {
  if (spec === "react-native") return await resolveInPackageDir(webDir, "", BROWSER_CONDITIONS);
  for (const candidate of webCandidates(spec.slice("react-native/".length))) {
    const hit = await probeWebFile(join(webDir, candidate));
    if (hit) return hit;
  }
  return null;
}

/**
 * The stub module for a deep `react-native/…` import with no web equivalent. Importing it is
 * harmless (a native-only internal is often imported by a module the web build never runs);
 * calling or constructing any export throws an error that names the import.
 *
 * It is CommonJS so any named import binds: esbuild's ESM-from-CJS interop copies the
 * module's own keys onto an object whose PROTOTYPE is the module's prototype, and the
 * `getPrototypeOf` trap answers with a proxy that hands the stub out for every other name.
 *
 * @param spec The specifier the stub stands in for.
 * @returns The module source.
 */
function nativeOnlyStubSource(spec: string): string {
  const message = `denext reactNative: "${spec}" has no react-native-web equivalent (a ` +
    "native-only React Native internal). Give the importing module a .web.* variant, or " +
    "map the import to a web shim.";
  return `var message = ${JSON.stringify(message)};
function fail() { throw new Error(message); }
var stub;
var names = new Proxy({}, {
  get: function (_target, key) { return typeof key === "symbol" ? undefined : stub; },
});
stub = new Proxy(function () {}, {
  get: function (_target, key) {
    if (typeof key === "symbol" || key === "__esModule" || key === "then") return undefined;
    return stub;
  },
  getPrototypeOf: function () { return names; },
  apply: fail,
  construct: fail,
});
module.exports = stub;
`;
}

/**
 * The key into {@linkcode NATIVE_DEEP_IMPORTS} for a `react-native/…` specifier, or null.
 *
 * @param spec A `react-native/…` specifier.
 */
function nativeDeepImport(spec: string): string | null {
  const sub = spec.slice("react-native/".length).replace(/\.js$/, "");
  return Object.hasOwn(NATIVE_DEEP_IMPORTS, sub) ? sub : null;
}

/**
 * The web stand-ins for React Native's codegen / TurboModule entry points. No native module is
 * registered on the web, so `TurboModuleRegistry.get(name)` is null and
 * `TurboModuleRegistry.getEnforcing(name)` returns a stand-in that loads harmlessly (codegen
 * specs call it at module top level) and throws an error naming the module on first use: any
 * genuine member name. Introspection is exempt, so logging and error overlays never throw:
 *   - `toString` / `toJSON` → a description naming the module; `constructor` → `Object`;
 *   - `then` (not thenable), `$$typeof` (not a React element), `__esModule`, `inspect`,
 *     `nodeType`, `asymmetricMatch`, `@@`-prefixed keys and symbol keys → `undefined`. A
 * `codegenNativeComponent(name)` (and `requireNativeComponent(name)`, and
 * `NativeComponentRegistry.get(name)`) component renders nothing (warning once per name in dev),
 * and `codegenNativeCommands()` returns commands that do nothing.
 *
 * The React Native internals a library may import load and do nothing: `CodegenTypes` is an
 * empty object (its members are types), `DevMenu.show()`, `registerCallableModule()` and
 * `Systrace`'s events are no-ops (`Systrace.isEnabled()` is false), and `PushNotificationIOS`
 * reports no permission, no notifications and no initial notification (use
 * `denext/mobile`'s push and local notifications).
 *
 * @returns The module source.
 */
function nativeModulesSource(): string {
  return `function get(_name) { return null; }
function getEnforcing(name) {
  var message = "denext reactNative: the native module \\"" + name + "\\" is unavailable " +
    "on the web (TurboModuleRegistry.getEnforcing). Guard its use behind Platform.OS, give " +
    "the importing module a .web.* variant, or map the package to a web shim.";
  function describe() { return "[native module " + name + " (unavailable on the web)]"; }
  var ignored = new Set([
    "then", "$$typeof", "__esModule", "inspect", "nodeType", "asymmetricMatch",
  ]);
  return new Proxy({}, {
    get: function (_target, key) {
      if (typeof key === "symbol" || key.startsWith("@@") || ignored.has(key)) return undefined;
      if (key === "toString" || key === "toJSON") return describe;
      if (key === "constructor") return Object;
      throw new Error(message);
    },
  });
}
var TurboModuleRegistry = { get: get, getEnforcing: getEnforcing };
var warned = /* @__PURE__ */ new Set();
function nativeComponent(name, via) {
  function NativeComponent() {
    if ((typeof __DEV__ === "undefined" || __DEV__) && !warned.has(name)) {
      warned.add(name);
      console.warn("denext reactNative: <" + name + "> is a native component " +
        "(" + via + ") with no web implementation; it renders nothing on the web.");
    }
    return null;
  }
  NativeComponent.displayName = name;
  return NativeComponent;
}
function codegenNativeComponent(name) { return nativeComponent(name, "codegenNativeComponent"); }
function requireNativeComponent(name) { return nativeComponent(name, "requireNativeComponent"); }
function noop() {}
function codegenNativeCommands() {
  return new Proxy({}, {
    get: function (_target, key) {
      return typeof key === "symbol" || key === "then" ? undefined : noop;
    },
  });
}
var NativeComponentRegistry = {
  get: function (name) { return nativeComponent(name, "NativeComponentRegistry"); },
  getWithFallback_DEPRECATED: function (name) {
    return nativeComponent(name, "NativeComponentRegistry");
  },
  setRuntimeConfigProvider: noop,
  unstable_hasStaticViewConfig: function () { return false; },
};
var CodegenTypes = {};
var DevMenu = { show: noop };
function registerCallableModule() {}
var asyncCookie = 0;
var Systrace = {
  isEnabled: function () { return false; },
  setEnabled: noop,
  beginEvent: noop,
  endEvent: noop,
  beginAsyncEvent: function () { return ++asyncCookie; },
  endAsyncEvent: noop,
  counterEvent: noop,
};
var PushNotificationIOS = /* @__PURE__ */ (function () {
  function none() { return { alert: false, badge: false, sound: false }; }
  function call(value) { return function (cb) { if (typeof cb === "function") cb(value()); }; }
  function P(nativeNotif) { this._data = nativeNotif || {}; }
  P.FetchResult = {
    NewData: "UIBackgroundFetchResultNewData",
    NoData: "UIBackgroundFetchResultNoData",
    ResultFailed: "UIBackgroundFetchResultFailed",
  };
  [
    "presentLocalNotification", "scheduleLocalNotification", "cancelAllLocalNotifications",
    "removeAllDeliveredNotifications", "removeDeliveredNotifications",
    "setApplicationIconBadgeNumber", "cancelLocalNotifications", "addEventListener",
    "removeEventListener", "abandonPermissions",
  ].forEach(function (key) { P[key] = noop; });
  P.getDeliveredNotifications = call(function () { return []; });
  P.getScheduledLocalNotifications = call(function () { return []; });
  P.getApplicationIconBadgeNumber = call(function () { return 0; });
  P.checkPermissions = call(none);
  P.getAuthorizationStatus = call(function () { return 0; });
  P.requestPermissions = function () { return Promise.resolve(none()); };
  P.getInitialNotification = function () { return Promise.resolve(null); };
  [
    "getMessage", "getSound", "getCategory", "getAlert", "getContentAvailable", "getBadgeCount",
    "getData", "getThreadID",
  ].forEach(function (key) { P.prototype[key] = function () { return null; }; });
  P.prototype.finish = noop;
  return P;
})();
export {
  TurboModuleRegistry, get, getEnforcing, codegenNativeComponent, codegenNativeCommands,
  requireNativeComponent, NativeComponentRegistry, CodegenTypes, DevMenu, PushNotificationIOS,
  registerCallableModule, Systrace,
};
`;
}

/** react-native-web's entry module, its ES build or its CommonJS one. */
const WEB_ENTRY_MODULE = /[\\/]react-native-web[\\/]dist[\\/](?:cjs[\\/])?index\.js$/;

/** Which of the entry additions' sources this build can resolve ({@linkcode withNativeModuleExports}). */
export interface EntrySources {
  /** `denext/react-native` resolves: add {@linkcode OVERLAY_ENTRY_EXPORTS} and the Animated hooks. */
  readonly overlay?: boolean;
  /** `react-dom` resolves: add `unstable_batchedUpdates`. */
  readonly reactDom?: boolean;
  /** The react-native-web `exports/<name>` modules present (for {@linkcode WEB_ENTRY_EXPORTS}). */
  readonly webModules?: ReadonlySet<string>;
}

/** Whether `source` (an entry) already exports `name`. */
function exportsName(source: string, name: string): boolean {
  return new RegExp(`\\bexport\\b[^;]*\\b${name}\\b|\\bexports\\.${name}\\b`).test(source);
}

/** A group of names the entry gains from one module: ES and CommonJS source for them. */
interface AdditionGroup {
  readonly names: readonly string[];
  readonly esm: (names: readonly string[]) => string;
  readonly cjs: (names: readonly string[]) => string;
}

/** `exports.<name> = <from>.<name>` for each name. */
function cjsAssign(from: string, names: readonly string[]): string {
  return names.map((name) => `exports.${name} = ${from}.${name};\n`).join("");
}

/** `require(spec)`'s default export, as react-native-web's CommonJS modules shape it. */
function cjsDefault(spec: string): string {
  return `(function (m) { return m && m.__esModule ? m.default : m; })(require(${
    JSON.stringify(spec)
  }))`;
}

/** The addition groups for `sources` (only the ones whose source resolves). */
function additionGroups(sources: EntrySources): AdditionGroup[] {
  const overlay = JSON.stringify(RN_OVERLAY);
  const groups: AdditionGroup[] = [{
    names: NATIVE_ENTRY_EXPORTS,
    esm: (names) => `export { ${names.join(", ")} } from "${NATIVE_MODULES}";\n`,
    cjs: (names) =>
      `var __denextNative = require("${NATIVE_MODULES}");\n` + cjsAssign("__denextNative", names),
  }];
  if (sources.overlay) {
    // Through a namespace, so an overlay without one of the names (a stale prebuilt runtime, a
    // test stand-in) reads undefined with a warning instead of failing the build; esbuild
    // still binds each `__denextOverlay.<name>` statically and drops the unused ones.
    groups.push({
      names: OVERLAY_ENTRY_EXPORTS,
      esm: (names) =>
        `import * as __denextOverlay from ${overlay};\n` +
        names.map((n) => `export var ${n} = __denextOverlay.${n};\n`).join(""),
      cjs: (names) =>
        `var __denextOverlay = require(${overlay});\n` +
        cjsAssign("__denextOverlay", names),
    });
  }
  if (sources.overlay && sources.webModules?.has("Animated")) {
    const hook = (name: string, animated: string) =>
      `/* @__PURE__ */ __denextAnimatedHook(${animated}, "${ANIMATED_HOOK_EXPORTS[name]}")`;
    groups.push({
      names: Object.keys(ANIMATED_HOOK_EXPORTS),
      esm: (names) =>
        `import __denextAnimated from "./exports/Animated";\n` +
        `import * as __denextOverlayHooks from ${overlay};\n` +
        "var __denextAnimatedHook = __denextOverlayHooks.createAnimatedHook;\n" +
        names.map((n) => `export var ${n} = ${hook(n, "__denextAnimated")};\n`).join(""),
      cjs: (names) =>
        `var __denextAnimatedHook = require(${overlay}).createAnimatedHook;\n` +
        names.map((n) => `exports.${n} = ${hook(n, cjsDefault("./exports/Animated"))};\n`)
          .join(""),
    });
  }
  // A module the overlay replaces (InputAccessoryView) loads `denext/react-native` itself.
  const web = Object.keys(WEB_ENTRY_EXPORTS).filter((n) =>
    sources.webModules?.has(WEB_ENTRY_EXPORTS[n]) &&
    (sources.overlay || !Object.hasOwn(RN_OVERLAY_EXPORTS, WEB_ENTRY_EXPORTS[n]))
  );
  if (web.length > 0) {
    groups.push({
      names: web,
      esm: (names) =>
        names.map((n) => `export { default as ${n} } from "./exports/${WEB_ENTRY_EXPORTS[n]}";\n`)
          .join(""),
      cjs: (names) =>
        names.map((n) => `exports.${n} = ${cjsDefault(`./exports/${WEB_ENTRY_EXPORTS[n]}`)};\n`)
          .join(""),
    });
  }
  if (sources.reactDom) {
    groups.push({
      names: REACT_DOM_ENTRY_EXPORTS,
      esm: (names) => `export { ${names.join(", ")} } from "react-dom";\n`,
      cjs: (names) => cjsAssign('require("react-dom")', names),
    });
  }
  return groups;
}

/**
 * react-native-web's entry with the React Native names it lacks appended, so
 * `import { requireNativeComponent, PermissionsAndroid } from "react-native"` binds:
 *
 * - always, {@linkcode NATIVE_ENTRY_EXPORTS} from {@linkcode nativeModulesSource} (the
 *   codegen / TurboModule entry points, `requireNativeComponent`, the internals' no-ops);
 * - when `denext/react-native` resolves, {@linkcode OVERLAY_ENTRY_EXPORTS} from the shell
 *   overlay, and (with react-native-web's `Animated`) {@linkcode ANIMATED_HOOK_EXPORTS} built
 *   by its `createAnimatedHook`;
 * - {@linkcode WEB_ENTRY_EXPORTS} whose react-native-web module exists;
 * - when `react-dom` resolves (denext's, in React Native mode), `unstable_batchedUpdates`.
 *
 * A name the entry already exports is left to it. An ES entry gains `export … from` lines; a
 * CommonJS one (no `export` statement) gains `exports.<name>` assignments. Every addition is a
 * re-export or a `/* @__PURE__ *\/` call, so an unused one tree-shakes away.
 *
 * @param source The entry's source.
 * @param sources Which additions' sources resolve in this build (default: only the native ones).
 * @returns The entry source with the additions.
 */
export function withNativeModuleExports(source: string, sources: EntrySources = {}): string {
  const esm = /^\s*export\s/m.test(source);
  let tail = "";
  for (const group of additionGroups(sources)) {
    const missing = group.names.filter((name) => !exportsName(source, name));
    if (missing.length > 0) tail += esm ? group.esm(missing) : group.cjs(missing);
  }
  return tail === "" ? source : `${source}\n${tail}`;
}

/**
 * Which entry additions' sources resolve for react-native-web's entry at `entry`: the overlay
 * and `react-dom` through the build's own resolvers, the `exports/<name>` modules on disk. A
 * bare build (no prebuilt runtime) gets only the native additions instead of a resolve error.
 *
 * @param build The esbuild plugin build.
 * @param entry The entry module's path.
 */
async function entrySources(build: esbuild.PluginBuild, entry: string): Promise<EntrySources> {
  const resolveDir = dirname(entry);
  const resolves = async (spec: string) =>
    (await build.resolve(spec, { kind: "import-statement", resolveDir })).errors.length === 0;
  const names = ["Animated", ...Object.values(WEB_ENTRY_EXPORTS)];
  const present = await Promise.all(
    names.map(async (name) => (await probeWebFile(join(resolveDir, "exports", name))) !== null),
  );
  return {
    overlay: await resolves(RN_OVERLAY),
    reactDom: await resolves("react-dom"),
    webModules: new Set(names.filter((_, i) => present[i])),
  };
}

/** react-native-web's `Appearance` module (its ES build), which the polyfill below extends. */
const APPEARANCE_MODULE =
  /[\\/]react-native-web[\\/]dist[\\/]exports[\\/]Appearance[\\/]index\.js$/;

/**
 * `Appearance.setColorScheme` (React Native 0.72+) for react-native-web, which lacks it:
 * `setColorScheme("light" | "dark")` overrides the system scheme, which
 * `getColorScheme()` and every change listener (so `useColorScheme()`) then report, and sets
 * `color-scheme` on the root element; `"unspecified"` or `null` restores the system scheme.
 * While an override is set, system changes are not reported. Appended to the module that
 * defines `Appearance`, so the one object every importer shares gets it.
 *
 * @param name The module's local name for the `Appearance` object.
 * @returns The source to insert ahead of its `export default`.
 */
function appearancePolyfillSource(name: string): string {
  return `;(function (A) {
  if (!A || typeof A.setColorScheme === "function") return;
  var override = null;
  var systemGet = A.getColorScheme.bind(A);
  var systemAdd = A.addChangeListener.bind(A);
  var listeners = new Set();
  function current() { return override || systemGet(); }
  A.getColorScheme = current;
  A.setColorScheme = function (scheme) {
    var before = current();
    override = scheme === "light" || scheme === "dark" ? scheme : null;
    if (typeof document !== "undefined" && document.documentElement) {
      if (override) document.documentElement.style.colorScheme = override;
      else document.documentElement.style.removeProperty("color-scheme");
    }
    var after = current();
    if (after !== before) listeners.forEach(function (l) { l({ colorScheme: after }); });
  };
  A.addChangeListener = function (listener) {
    listeners.add(listener);
    var system = systemAdd(function (event) { if (!override) listener(event); });
    return { remove: function () { listeners.delete(listener); system.remove(); } };
  };
})(${name});
`;
}

/**
 * react-native-web's `Appearance` module with {@linkcode appearancePolyfillSource} inserted
 * ahead of its `export default`, or the source unchanged when it has no such export (a
 * react-native-web that already has `setColorScheme` is left alone at run time).
 *
 * @param source The module source.
 */
export function withAppearancePolyfill(source: string): string {
  const match = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(source);
  if (!match) return source;
  return source.slice(0, match.index) + appearancePolyfillSource(match[1]) +
    source.slice(match.index);
}

/** The prebuilt runtime specifier of the shell overlay (`src/react-native/mod.ts`). */
export const RN_OVERLAY = "denext/react-native";

/**
 * The react-native-web modules the shell overlay replaces, by export name: `"value"` re-exports
 * denext's export of the same name; `"view"` is a component built by denext's
 * `create<Name>(View)` from react-native-web's own `View`.
 */
export const RN_OVERLAY_EXPORTS: Readonly<Record<string, "value" | "view">> = {
  AccessibilityInfo: "value",
  Alert: "value",
  AppState: "value",
  BackHandler: "value",
  Clipboard: "value",
  I18nManager: "value",
  InputAccessoryView: "view",
  Keyboard: "value",
  KeyboardAvoidingView: "view",
  Linking: "value",
  Platform: "value",
  RefreshControl: "view",
  SafeAreaView: "view",
  Share: "value",
  StatusBar: "value",
  Vibration: "value",
};

/** A replaced react-native-web module (ES or CommonJS build); group 1 is `cjs/`, 2 the name. */
const OVERLAY_MODULE = new RegExp(
  `[\\\\/]react-native-web[\\\\/]dist[\\\\/](cjs[\\\\/])?exports[\\\\/](${
    Object.keys(RN_OVERLAY_EXPORTS).join("|")
  })[\\\\/]index\\.js$`,
);

/**
 * The source that stands in for react-native-web's module `name`: a re-export of denext's
 * export of that name, or, for a component built on react-native-web's `View`, denext's
 * `create<name>(View)` over the sibling `View` module. The ES build gets an ES module; the
 * CommonJS build gets `module.exports = …`, as react-native-web's own CommonJS modules do.
 *
 * @param name A key of {@linkcode RN_OVERLAY_EXPORTS}.
 * @param cjs Whether the module is from react-native-web's CommonJS build.
 * @returns The module source.
 */
export function overlayModuleSource(name: string, cjs: boolean): string {
  const view = RN_OVERLAY_EXPORTS[name] === "view";
  if (!cjs) {
    return view
      ? `import View from "../View";\nimport { create${name} } from "${RN_OVERLAY}";\n` +
        `export default /* @__PURE__ */ create${name}(View);\n`
      : `export { ${name} as default } from "${RN_OVERLAY}";\n`;
  }
  const overlay = `require(${JSON.stringify(RN_OVERLAY)})`;
  return view
    ? `"use strict";\nvar View = require("../View");\n` +
      `if (View && View.__esModule) View = View.default;\n` +
      `module.exports = ${overlay}.create${name}(View);\n`
    : `"use strict";\nmodule.exports = ${overlay}.${name};\n`;
}

/**
 * The esbuild plugin that sends `react-native` (and its subpaths) to react-native-web. It
 * must run ahead of the app and node_modules resolvers, which is where the SPA bundle's
 * `extraPlugins` go.
 *
 * @param projectDir Where react-native-web is looked up from.
 */
export function reactNativeWebPlugin(projectDir: string): esbuild.Plugin {
  let webDir: Promise<string | null> | null = null;
  return {
    name: "denext-react-native-web",
    setup(build) {
      build.onResolve({ filter: REACT_NATIVE_FILTER }, async (args) => {
        const dir = await (webDir ??= findReactNativeWeb(projectDir));
        if (!dir) {
          return {
            errors: [{
              text: `\`reactNative\` is on, but ${WEB_PACKAGE} is not installed — add it to ` +
                `the project's dependencies (\`npm install ${WEB_PACKAGE}\`).`,
            }],
          };
        }
        const spec = args.path === EXPO_RN_BRIDGE ? "react-native" : args.path;
        const native = nativeDeepImport(spec);
        if (native) return { path: native, namespace: NATIVE_NAMESPACE, sideEffects: false };
        const file = await resolveReactNativeSpecifier(dir, spec);
        return file
          ? await withPackageSideEffects(file)
          : { path: args.path, namespace: STUB_NAMESPACE };
      });
      build.onResolve({ filter: new RegExp(`^${NATIVE_MODULES}$`) }, () => ({
        path: NATIVE_MODULES,
        namespace: NATIVE_NAMESPACE,
        sideEffects: false,
      }));
      build.onLoad({ filter: /.*/, namespace: NATIVE_NAMESPACE }, (args) => ({
        contents: args.path === NATIVE_MODULES
          ? nativeModulesSource()
          : NATIVE_DEEP_IMPORTS[args.path],
        loader: "js",
      }));
      build.onLoad({ filter: WEB_ENTRY_MODULE }, async (args) => ({
        contents: withNativeModuleExports(
          await Deno.readTextFile(args.path),
          await entrySources(build, args.path),
        ),
        loader: "js",
        resolveDir: dirname(args.path),
      }));
      build.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, (args) => ({
        contents: nativeOnlyStubSource(args.path),
        loader: "js",
      }));
      build.onLoad({ filter: OVERLAY_MODULE }, (args) => {
        const [, cjs, name] = OVERLAY_MODULE.exec(args.path)!;
        return {
          contents: overlayModuleSource(name, cjs !== undefined),
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
      build.onLoad({ filter: APPEARANCE_MODULE }, async (args) => ({
        contents: withAppearancePolyfill(await Deno.readTextFile(args.path)),
        loader: "js",
        resolveDir: dirname(args.path),
      }));
    },
  };
}

/**
 * The esbuild plugin that sends each `expo-*` package in the `denext/expo` manifest (and its
 * known subpaths, such as `expo/fetch`) to its `denext/expo/<name>` shim. It re-resolves
 * that specifier through the build, so the shim comes from the prebuilt denext runtime and
 * shares the app's one denext instance. A package that is not in the manifest (or an
 * unknown subpath of one) resolves normally.
 */
export function expoShimPlugin(): esbuild.Plugin {
  return {
    name: "denext-expo-shims",
    setup(build) {
      build.onResolve({ filter: EXPO_FILTER }, async (args) => {
        const shim = expoShimSpecifier(args.path);
        return shim ? await resolveInstead(build, shim, args) : null;
      });
    },
  };
}

/** What React Native mode adds to the SPA's compat bundle. */
export interface ReactNativeBundleOptions {
  /** The `define` entries ({@linkcode reactNativeDefines}). */
  define: Record<string, string>;
  /**
   * The react-native → react-native-web resolver, expo-router's route context and its
   * `Stack` / `Tabs` drawn by `denext/navigation`, (unless
   * `expoShims: false`) the `expo-*` → `denext/expo/*` resolver and (unless
   * `lists: "library"`) the list adapters, ahead of the built-in resolvers.
   */
  plugins: esbuild.Plugin[];
  /** The `.web.*` extensions, probed first. */
  platformExtensions: readonly string[];
  /** Parse `.js` as JSX. */
  jsxInJs: true;
  /**
   * Include the `Activity` runtime: the Expo Router navigators keep hidden stack screens in an
   * `Activity`, which must tear their effects down.
   */
  usesActivity: true;
}

/**
 * The bundle options React Native mode contributes, or null when `reactNative` is off.
 *
 * @param config The app config.
 * @param projectDir The project root (react-native-web is looked up from here).
 * @param dev Whether this is a dev build (sets `__DEV__`).
 */
export function reactNativeBundleOptions(
  config: DenextConfig | null | undefined,
  projectDir: string,
  dev: boolean,
): ReactNativeBundleOptions | null {
  const options = reactNativeOptions(config);
  if (!options) return null;
  return {
    define: reactNativeDefines(dev),
    plugins: [
      // Ahead of the react-native-web resolver: `desktopPackage` claims app-source
      // `react-native` imports first.
      desktopReactNativePlugin(options.desktopPackage),
      reactNativeWebPlugin(projectDir),
      expoRouterContextPlugin(projectDir),
      expoRouterNavigatorsPlugin(),
      ...(options.expoShims === false ? [] : [expoShimPlugin()]),
      ...(options.lists === "library" ? [] : [listAdaptersPlugin(projectDir)]),
      reanimatedWorkletsPlugin(projectDir, { dev }),
      reactNativeAliasesPlugin(projectDir, config),
    ],
    platformExtensions: WEB_PLATFORM_EXTENSIONS,
    jsxInJs: true,
    usesActivity: true,
  };
}
