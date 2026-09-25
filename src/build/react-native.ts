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
//     `codegenNativeComponent` and `codegenNativeCommands` — are added to its entry and back
//     their deep `Libraries/…` imports: no native module is registered (`get` → null,
//     `getEnforcing` returns a module that throws, naming it, on first use), a native
//     component renders nothing, and native commands do nothing.
//   - `.web.tsx` / `.web.ts` / `.web.jsx` / `.web.js` are probed first (the bundler's
//     `platformExtensions`), for relative/alias imports and package subpaths.
//   - `.js` parses as JSX (the bundler's `jsxInJs`).
//   - `__DEV__`, `global` and `process.env.EXPO_OS` are defined at build time.
//   - react-native-web's `Appearance` gains `setColorScheme` (React Native 0.72+), which it
//     lacks: an override `getColorScheme()`, the change listeners and the root element's
//     `color-scheme` honour.
//   - `expo-router/_ctx` (Metro's `require.context` over the route directory) resolves to a
//     module generated from the app's `app/` (or `src/app/`) files (expo-router.ts).
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
};

/** The names react-native-web's entry gains from {@linkcode nativeModulesSource}. */
const NATIVE_ENTRY_EXPORTS = [
  "TurboModuleRegistry",
  "codegenNativeComponent",
  "codegenNativeCommands",
] as const;

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
 * `codegenNativeComponent(name)` component renders nothing (warning once per name in dev), and
 * `codegenNativeCommands()` returns commands that do nothing.
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
var warned = new Set();
function codegenNativeComponent(name) {
  function NativeComponent() {
    if ((typeof __DEV__ === "undefined" || __DEV__) && !warned.has(name)) {
      warned.add(name);
      console.warn("denext reactNative: <" + name + "> is a native component " +
        "(codegenNativeComponent) with no web implementation; it renders nothing on the web.");
    }
    return null;
  }
  NativeComponent.displayName = name;
  return NativeComponent;
}
function noop() {}
function codegenNativeCommands() {
  return new Proxy({}, {
    get: function (_target, key) {
      return typeof key === "symbol" || key === "then" ? undefined : noop;
    },
  });
}
export { TurboModuleRegistry, get, getEnforcing, codegenNativeComponent, codegenNativeCommands };
`;
}

/** react-native-web's entry module, its ES build or its CommonJS one. */
const WEB_ENTRY_MODULE = /[\\/]react-native-web[\\/]dist[\\/](?:cjs[\\/])?index\.js$/;

/**
 * react-native-web's entry with {@linkcode NATIVE_ENTRY_EXPORTS} appended (from
 * {@linkcode nativeModulesSource}), so `import { TurboModuleRegistry } from "react-native"`
 * binds. A name the entry already exports is left to it. An ES entry gains an
 * `export { … } from`; a CommonJS one (no `export` statement) gains `exports.<name>` assignments.
 *
 * @param source The entry's source.
 */
export function withNativeModuleExports(source: string): string {
  const missing = NATIVE_ENTRY_EXPORTS.filter((name) =>
    !new RegExp(`\\bexport\\b[^;]*\\b${name}\\b|\\bexports\\.${name}\\b`).test(source)
  );
  if (missing.length === 0) return source;
  const esm = /^\s*export\s/m.test(source);
  const tail = esm
    ? `export { ${missing.join(", ")} } from "${NATIVE_MODULES}";\n`
    : `var __denextNative = require("${NATIVE_MODULES}");\n` +
      missing.map((name) => `exports.${name} = __denextNative.${name};\n`).join("");
  return `${source}\n${tail}`;
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
        if (native) return { path: native, namespace: NATIVE_NAMESPACE };
        const file = await resolveReactNativeSpecifier(dir, spec);
        return file
          ? await withPackageSideEffects(file)
          : { path: args.path, namespace: STUB_NAMESPACE };
      });
      build.onResolve({ filter: new RegExp(`^${NATIVE_MODULES}$`) }, () => ({
        path: NATIVE_MODULES,
        namespace: NATIVE_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: NATIVE_NAMESPACE }, (args) => ({
        contents: args.path === NATIVE_MODULES
          ? nativeModulesSource()
          : NATIVE_DEEP_IMPORTS[args.path],
        loader: "js",
      }));
      build.onLoad({ filter: WEB_ENTRY_MODULE }, async (args) => ({
        contents: withNativeModuleExports(await Deno.readTextFile(args.path)),
        loader: "js",
        resolveDir: dirname(args.path),
      }));
      build.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, (args) => ({
        contents: nativeOnlyStubSource(args.path),
        loader: "js",
      }));
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
        if (!shim) return null;
        const result = await build.resolve(shim, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
        });
        if (result.errors.length > 0) return { errors: result.errors };
        return { path: result.path, namespace: result.namespace, external: result.external };
      });
    },
  };
}

/** What React Native mode adds to the SPA's compat bundle. */
export interface ReactNativeBundleOptions {
  /** The `define` entries ({@linkcode reactNativeDefines}). */
  define: Record<string, string>;
  /**
   * The react-native → react-native-web resolver, expo-router's route context and (unless
   * `expoShims: false`) the `expo-*` → `denext/expo/*` resolver, ahead of the built-in
   * resolvers.
   */
  plugins: esbuild.Plugin[];
  /** The `.web.*` extensions, probed first. */
  platformExtensions: readonly string[];
  /** Parse `.js` as JSX. */
  jsxInJs: true;
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
      reactNativeWebPlugin(projectDir),
      expoRouterContextPlugin(projectDir),
      ...(options.expoShims === false ? [] : [expoShimPlugin()]),
    ],
    platformExtensions: WEB_PLATFORM_EXTENSIONS,
    jsxInJs: true,
  };
}
