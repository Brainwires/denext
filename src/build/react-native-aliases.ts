// React Native mode's community-package aliases (src/react-native-compat/manifest.ts): the
// popular React Native libraries whose native half a WebView lacks resolve to denext
// implementations, so an app's imports run unchanged — the way the `expo-*` shims do for Expo.
//
//   - A `runtime` entry resolves to its prebuilt runtime module,
//     `denext/react-native-compat/<name>` (src/react-native-compat/<name>.ts), which shares the
//     app's one denext instance. When the entry has a `generated` factory (the drawer navigator
//     over the app's `@react-navigation/native`, keyboard-controller's Reanimated hooks over the
//     app's `react-native-reanimated`), the import resolves to a generated module that
//     re-exports the runtime module and adds the factory's exports, built from the app's
//     package; an `optional` factory whose package is not installed is skipped.
//   - A `navigator` entry (`@react-navigation/native-stack`, `@react-navigation/bottom-tabs`)
//     resolves to a generated module that re-exports the real package and replaces its
//     `create*Navigator` with `denext/navigation`'s factory over the app's
//     `@react-navigation/native`. expo-router's own imports keep the real package (its
//     `Stack` / `Tabs` are swapped by expo-router-navigators.ts).
//   - The `transform` entry `react-native-svg-transformer`: when the app has both it and
//     react-native-svg, a JS import of a `.svg` file is a component that renders the file
//     through react-native-svg's `SvgXml` (Metro's svg-transformer, restated); CSS `url()`s
//     keep the file loader.
//
// `reactNative: { aliases: { "<package>": false } }` resolves that package normally again.

import { dirname, join, toFileUrl } from "@std/path";
import type * as esbuild from "esbuild";
import { type DenextConfig, reactNativeOptions } from "../server/config.ts";
import {
  COMMUNITY_ALIASES,
  type CommunityAlias,
  type CommunityAliasFactory,
} from "../react-native-compat/manifest.ts";

/** The prebuilt runtime specifier prefix of the stand-ins. */
const RUNTIME_PREFIX = "denext/react-native-compat/";

/** The esbuild namespace of the generated alias modules. */
const NAMESPACE = "denext-rn-aliases";

/** The esbuild namespace of `.svg` files compiled to components. */
const SVG_NAMESPACE = "denext-rn-svg";

/** The query a generated module's own import of the real package carries. */
const REAL = "denext-rn-real";

/** The manifest key of the `.svg` transform. */
const SVG_TRANSFORM = "react-native-svg-transformer";

/** The manifest key of react-native-safe-area-context's provider patch. */
const SAFE_AREA = "react-native-safe-area-context";

/** react-native-safe-area-context's web provider module (ES, CommonJS or source build). */
const SAFE_AREA_PROVIDER =
  /[\\/]react-native-safe-area-context[\\/](?:lib[\\/](module|commonjs)[\\/]NativeSafeAreaProvider\.web\.js|src[\\/]NativeSafeAreaProvider\.web\.tsx)$/;

/**
 * The module that stands in for react-native-safe-area-context's web provider: denext's
 * `createNativeSafeAreaProvider` over react-native-web's `View` (the shell's insets through
 * `useSafeAreaInsets`, not CSS `env()` alone). The package's `SafeAreaView`,
 * `useSafeAreaInsets` and `useSafeAreaFrame` then follow.
 *
 * @param cjs Whether the replaced module is the package's CommonJS build.
 * @returns The module source.
 */
function safeAreaProviderSource(cjs: boolean): string {
  if (cjs) {
    return `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n` +
      `exports.NativeSafeAreaProvider = require("denext/react-native")` +
      `.createNativeSafeAreaProvider(require("react-native").View);\n`;
  }
  return `import { View } from "react-native";\n` +
    `import { createNativeSafeAreaProvider } from "denext/react-native";\n` +
    `export const NativeSafeAreaProvider = /* @__PURE__ */ createNativeSafeAreaProvider(View);\n`;
}

/** The manifest key of NativeWind's JSX runtime. */
const NATIVEWIND = "nativewind";

/** The automatic JSX runtime's modules, which NativeWind's replace in the app's own source. */
const JSX_RUNTIME = /^react\/jsx-(?:dev-)?runtime$/;

/** An importer inside an installed package. */
const PACKAGE_IMPORTER = /[\\/]node_modules[\\/]/;

/** An importer inside expo-router, which keeps the real navigator packages. */
const EXPO_ROUTER_IMPORTER = /[\\/]node_modules[\\/](?:expo-router|@expo[\\/]router)[\\/]/;

/**
 * Resolve `spec` through the build's own resolvers in place of `args.path` (same importer,
 * kind and directory): how React Native mode points an import at a prebuilt `denext/*`
 * runtime entry so it shares the app's one denext instance.
 *
 * @param build The esbuild plugin build.
 * @param spec The specifier to resolve instead.
 * @param args The original resolve arguments.
 * @returns The resolution (or its errors), as an `onResolve` result.
 */
export async function resolveInstead(
  build: esbuild.PluginBuild,
  spec: string,
  args: esbuild.OnResolveArgs,
): Promise<esbuild.OnResolveResult> {
  const result = await build.resolve(spec, {
    kind: args.kind,
    importer: args.importer,
    resolveDir: args.resolveDir,
  });
  if (result.errors.length > 0) return { errors: result.errors };
  return { path: result.path, namespace: result.namespace, external: result.external };
}

/** A regex source matching `text` literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** The `denext/react-native-compat/<name>` name of a runtime entry: its module's file name. */
function communityRuntimeName(alias: CommunityAlias): string {
  return alias.module.replace(/^\.\//, "").replace(/\.ts$/, "");
}

/** The runtime entries of the manifest (one per module, however many packages share it). */
function runtimeModules(): string[] {
  const names = Object.values(COMMUNITY_ALIASES)
    .filter((alias) => alias.kind === "runtime")
    .map(communityRuntimeName);
  return [...new Set(names)].sort();
}

/**
 * The prebuilt-runtime entry points of the stand-ins: `rn-compat-<name>` → the module's
 * source URL.
 *
 * @param url Turns a framework-relative path (`src/react-native-compat/webview.ts`) into a URL.
 * @returns The entries, merged into the runtime's entry points.
 */
export function communityRuntimeEntries(url: (rel: string) => string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of runtimeModules()) {
    entries[`rn-compat-${name}`] = url(`src/react-native-compat/${name}.ts`);
  }
  return entries;
}

/**
 * `denext/react-native-compat/<name>` → its prebuilt runtime file (`rn-compat-<name>.js`).
 *
 * @returns The specifier → file map.
 */
export function communityRuntimeFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of runtimeModules()) files[`${RUNTIME_PREFIX}${name}`] = `rn-compat-${name}.js`;
  return files;
}

/**
 * Whether an import of `path` from `importer` is the stand-ins' react-native-web bridge
 * (`src/react-native-compat/internal/react-native.ts`), which the prebuild leaves external
 * as the `denext/expo/*` shims' bridge is.
 *
 * @param path The import path as written.
 * @param importer The importing module (a path or URL).
 */
export function isCommunityBridgeImport(path: string, importer: string): boolean {
  if (!path.endsWith("react-native.ts") || !importer.includes("/src/react-native-compat/")) {
    return false;
  }
  try {
    const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(importer) ? importer : toFileUrl(importer).href;
    return new URL(path, base).pathname.endsWith(
      "/src/react-native-compat/internal/react-native.ts",
    );
  } catch {
    return false;
  }
}

/**
 * The manifest entries React Native mode aliases under `config`: every entry, minus those
 * `reactNative.aliases` turns off.
 *
 * @param config The app config.
 * @returns Package name → entry.
 */
export function enabledCommunityAliases(
  config: DenextConfig | null | undefined,
): Record<string, CommunityAlias> {
  const off = reactNativeOptions(config)?.aliases ?? {};
  const out: Record<string, CommunityAlias> = {};
  for (const [pkg, alias] of Object.entries(COMMUNITY_ALIASES)) {
    if (off[pkg] !== false) out[pkg] = alias;
  }
  return out;
}

/** The package a specifier aliases (the package itself or a listed subpath), or undefined. */
function aliasedPackage(
  spec: string,
  aliases: Record<string, CommunityAlias>,
): string | undefined {
  if (Object.hasOwn(aliases, spec)) return spec;
  return Object.keys(aliases).find((pkg) =>
    (aliases[pkg].subpaths ?? []).some((sub) => spec === `${pkg}/${sub}`)
  );
}

/**
 * The generated module for a `runtime` entry with a factory: the runtime module re-exported,
 * plus the factory's exports built from the app's package (which shadow the runtime module's
 * own exports of the same names).
 *
 * @param runtime The runtime specifier (`denext/react-native-compat/drawer`).
 * @param factory The entry's factory, or null to re-export the runtime module alone.
 * @returns The module source (ESM).
 */
export function factoryModuleSource(
  runtime: string,
  factory: CommunityAliasFactory | null,
): string {
  const lines = [`export * from ${JSON.stringify(runtime)};`];
  if (factory) {
    lines.push(
      `import * as __dep from ${JSON.stringify(factory.from)};`,
      `import { ${factory.factory} as __factory } from ${JSON.stringify(runtime)};`,
      `const __made = /* @__PURE__ */ __factory(__dep);`,
      ...factory.exports.map((name) => `export const ${name} = __made.${name};`),
    );
  }
  return lines.join("\n") + "\n";
}

/** The `create*Navigator` export each navigator package's factory replaces. */
const NAVIGATOR_EXPORTS: Readonly<Record<string, string>> = {
  createNativeStackNavigatorFactory: "createNativeStackNavigator",
  createBottomTabNavigatorFactory: "createBottomTabNavigator",
};

/**
 * The generated module for a `navigator` entry: the real package re-exported, with its
 * `create*Navigator` drawn by `denext/navigation`.
 *
 * @param pkg The package (`@react-navigation/native-stack`).
 * @param alias Its manifest entry (`module` names the `denext/navigation` factory).
 * @returns The module source (ESM).
 */
export function navigatorModuleSource(pkg: string, alias: CommunityAlias): string {
  const created = NAVIGATOR_EXPORTS[alias.module];
  return [
    `import * as __core from "@react-navigation/native";`,
    `import { ${alias.module} as __factory } from "denext/navigation";`,
    `export * from ${JSON.stringify(`${pkg}?${REAL}`)};`,
    `export const ${created} = /* @__PURE__ */ __factory(__core);`,
  ].join("\n") + "\n";
}

/**
 * The module a `.svg` file compiles to: a component rendering the file's markup through
 * react-native-svg's `SvgXml`, its props (`width`, `height`, `fill`, `style`, …) passed on.
 *
 * @param xml The file's contents.
 * @returns The module source (ESM).
 */
export function svgComponentSource(xml: string): string {
  return [
    `import { createElement } from "react";`,
    `import { SvgXml } from "react-native-svg";`,
    `const xml = ${JSON.stringify(xml)};`,
    `function SvgComponent(props) {`,
    `  return createElement(SvgXml, Object.assign({ xml: xml }, props));`,
    `}`,
    `export default SvgComponent;`,
  ].join("\n") + "\n";
}

/** Whether `name` resolves from `dir` (walking up `node_modules`, as Node does). */
async function installed(dir: string, name: string): Promise<boolean> {
  let cur = dir;
  for (;;) {
    try {
      if ((await Deno.stat(join(cur, "node_modules", name, "package.json"))).isFile) return true;
    } catch { /* not here — keep walking up */ }
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** The data a generated module's load needs. */
interface AliasData {
  /** The package. */
  readonly pkg: string;
  /** The importer's directory, where the generated module's own imports resolve from. */
  readonly resolveDir: string;
  /** A JSX runtime module re-exported with a default export (for NativeWind's CommonJS). */
  readonly jsx?: string;
}

/** The marker a generated module's own imports carry, so they take the plain resolution. */
const PLAIN = "denext-rn-plain";

/**
 * A JSX runtime module plus a default export of its namespace: react-native-css-interop's
 * CommonJS runtime reads `require("react/jsx-runtime").default.jsx`, which denext's ES module
 * has no default for.
 *
 * @param spec The runtime specifier (`react/jsx-runtime`).
 * @returns The module source (ESM).
 */
function jsxDefaultSource(spec: string): string {
  const s = JSON.stringify(spec);
  return `import * as __runtime from ${s};\nexport * from ${s};\nexport default __runtime;\n`;
}

/**
 * The esbuild plugin behind React Native mode's community-package aliases. Add it to React
 * Native mode's plugin list, ahead of the default resolution.
 *
 * @param projectDir The project root (installed packages are looked up from here).
 * @param config The app config (`reactNative.aliases` turns entries off).
 * @returns The plugin.
 */
export function reactNativeAliasesPlugin(
  projectDir: string,
  config: DenextConfig | null | undefined,
): esbuild.Plugin {
  const aliases = enabledCommunityAliases(config);
  const specifiers = Object.entries(aliases)
    .filter(([, alias]) => alias.kind !== "transform")
    .flatMap(([pkg, alias]) => [pkg, ...(alias.subpaths ?? []).map((sub) => `${pkg}/${sub}`)]);
  const filter = new RegExp(`^(?:${specifiers.map(literal).join("|")})$`);
  const optionalChecks = new Map<string, Promise<boolean>>();
  const svg = Object.hasOwn(aliases, SVG_TRANSFORM)
    ? Promise.all([
      installed(projectDir, "react-native-svg"),
      installed(projectDir, SVG_TRANSFORM),
    ]).then(([a, b]) => a && b)
    : Promise.resolve(false);
  const nativewind = Object.hasOwn(aliases, NATIVEWIND)
    ? installed(projectDir, NATIVEWIND)
    : Promise.resolve(false);
  return {
    name: "denext-react-native-aliases",
    setup(build) {
      // A generated module's bare imports resolve as if from a file in the importer's folder:
      // the app's node_modules resolver only answers `file`-namespace importers.
      const fromFolder = (args: esbuild.OnResolveArgs, path: string, data?: object) =>
        build.resolve(path, {
          kind: args.kind,
          importer: join(args.resolveDir, "denext-generated.js"),
          namespace: "file",
          resolveDir: args.resolveDir,
          pluginData: data,
        });
      for (const namespace of [NAMESPACE, SVG_NAMESPACE]) {
        build.onResolve({ filter: /^[^./]/, namespace }, async (args) => {
          if (args.path.startsWith("denext/") || args.path.endsWith(`?${REAL}`)) return undefined;
          const result = await fromFolder(args, args.path, { [PLAIN]: true });
          if (result.errors.length > 0) return { errors: result.errors };
          return { path: result.path, namespace: result.namespace, external: result.external };
        });
      }
      build.onResolve(
        { filter: new RegExp(`\\?${REAL}$`) },
        (args) => fromFolder(args, args.path.slice(0, -(REAL.length + 1)), { [REAL]: true }),
      );
      if (specifiers.length > 0) {
        build.onResolve({ filter }, async (args) => {
          if ((args.pluginData as Record<string, unknown> | undefined)?.[REAL]) return undefined;
          const pkg = aliasedPackage(args.path, aliases)!;
          const alias = aliases[pkg];
          if (alias.kind === "navigator") {
            if (EXPO_ROUTER_IMPORTER.test(args.importer)) return undefined;
            return {
              path: pkg,
              namespace: NAMESPACE,
              pluginData: { pkg, resolveDir: args.resolveDir } satisfies AliasData,
            };
          }
          const runtime = `${RUNTIME_PREFIX}${communityRuntimeName(alias)}`;
          if (alias.generated) {
            return {
              path: pkg,
              namespace: NAMESPACE,
              pluginData: { pkg, resolveDir: args.resolveDir } satisfies AliasData,
            };
          }
          return await resolveInstead(build, runtime, args);
        });
      }
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args) => {
        const { pkg, resolveDir, jsx } = args.pluginData as AliasData;
        if (jsx) return { contents: jsxDefaultSource(jsx), loader: "js", resolveDir };
        const alias = aliases[pkg];
        if (alias.kind === "navigator") {
          return { contents: navigatorModuleSource(pkg, alias), loader: "js", resolveDir };
        }
        const factory = alias.generated!;
        let use = true;
        if (factory.optional) {
          let check = optionalChecks.get(factory.from);
          if (!check) {
            check = installed(projectDir, factory.from);
            optionalChecks.set(factory.from, check);
          }
          use = await check;
        }
        const runtime = `${RUNTIME_PREFIX}${communityRuntimeName(alias)}`;
        return {
          contents: factoryModuleSource(runtime, use ? factory : null),
          loader: "js",
          resolveDir,
        };
      });
      // NativeWind: the app's own JSX runs through `nativewind/jsx-runtime` (what its Babel
      // preset's `jsxImportSource: "nativewind"` does), which turns `className` into styles
      // react-native-web applies; packages keep the plain runtime.
      build.onResolve({ filter: JSX_RUNTIME }, async (args) => {
        if ((args.pluginData as Record<string, unknown> | undefined)?.[PLAIN]) return undefined;
        if (args.namespace !== "file" || !await nativewind) return undefined;
        if (/[\\/]react-native-css-interop[\\/]/.test(args.importer)) {
          const data: AliasData = { pkg: NATIVEWIND, resolveDir: args.resolveDir, jsx: args.path };
          return { path: `${args.path}#default`, namespace: NAMESPACE, pluginData: data };
        }
        if (PACKAGE_IMPORTER.test(args.importer)) return undefined;
        return await resolveInstead(build, args.path.replace(/^react/, NATIVEWIND), args);
      });
      if (Object.hasOwn(aliases, SAFE_AREA)) {
        build.onLoad({ filter: SAFE_AREA_PROVIDER }, (args) => ({
          contents: safeAreaProviderSource(SAFE_AREA_PROVIDER.exec(args.path)![1] === "commonjs"),
          loader: "js",
          resolveDir: dirname(args.path),
        }));
      }
      build.onResolve({ filter: /\.svg$/ }, async (args) => {
        if (args.kind === "url-token" || args.kind === "import-rule") return undefined;
        if (/\.css$/.test(args.importer)) return undefined;
        if ((args.pluginData as Record<string, unknown> | undefined)?.[SVG_NAMESPACE]) {
          return undefined;
        }
        if (!await svg) return undefined;
        const result = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { [SVG_NAMESPACE]: true },
        });
        if (result.errors.length > 0) return { errors: result.errors };
        if (result.namespace !== "file" || result.external) {
          return { path: result.path, namespace: result.namespace, external: result.external };
        }
        return { path: result.path, namespace: SVG_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: SVG_NAMESPACE }, async (args) => ({
        contents: svgComponentSource(await Deno.readTextFile(args.path)),
        loader: "js",
        resolveDir: projectDir,
        watchFiles: [args.path],
      }));
    },
  };
}
