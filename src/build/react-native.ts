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
//   - `.web.tsx` / `.web.ts` / `.web.jsx` / `.web.js` are probed first (the bundler's
//     `platformExtensions`), for relative/alias imports and package subpaths.
//   - `.js` parses as JSX (the bundler's `jsxInJs`).
//   - `__DEV__`, `global` and `process.env.EXPO_OS` are defined at build time.
//
// The SPA shell's root style lives with the shell (spa/shared.ts).

import { basename, dirname, join } from "@std/path";
import type * as esbuild from "esbuild";
import { type DenextConfig, reactNativeOptions } from "../server/config.ts";
import { BROWSER_CONDITIONS, resolveInPackageDir, withPackageSideEffects } from "./next-compat.ts";

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

/** `react-native` itself or any `react-native/…` subpath (not `react-native-web`, etc.). */
const REACT_NATIVE_FILTER = /^react-native(?:\/.*)?$/;

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
        const file = await resolveReactNativeSpecifier(dir, args.path);
        return file
          ? await withPackageSideEffects(file)
          : { path: args.path, namespace: STUB_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, (args) => ({
        contents: nativeOnlyStubSource(args.path),
        loader: "js",
      }));
    },
  };
}

/** What React Native mode adds to the SPA's compat bundle. */
export interface ReactNativeBundleOptions {
  /** The `define` entries ({@linkcode reactNativeDefines}). */
  define: Record<string, string>;
  /** The react-native → react-native-web resolver, ahead of the built-in resolvers. */
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
  if (!reactNativeOptions(config)) return null;
  return {
    define: reactNativeDefines(dev),
    plugins: [reactNativeWebPlugin(projectDir)],
    platformExtensions: WEB_PLATFORM_EXTENSIONS,
    jsxInJs: true,
  };
}
