// React Native mode's small react-native-web patches and Metro's image-density resolution,
// as one esbuild plugin (registered by reactNativeBundleOptions in ./react-native.ts):
//
//   - `ScrollView` is wrapped by `withScrollSnap` (denext/react-native): snapToInterval,
//     snapToOffsets, snapToAlignment, snapToStart / snapToEnd, decelerationRate and
//     disableIntervalMomentum become CSS scroll snap (react-native-web implements only
//     pagingEnabled).
//   - `Text` is wrapped by `withFontScaling`, `PixelRatio` by `withFontScaleRatio`, and
//     `Dimensions`' `fontScale` reads `reactNativeFontScale()`: the OS text size (Dynamic Type,
//     Android's font scale) reaches allowFontScaling / maxFontSizeMultiplier,
//     PixelRatio.getFontScale() and useWindowDimensions().fontScale (react-native-web reports 1).
//   - `Image` is passed through `withImageStatics`: the `resolveAssetSource`,
//     `getSizeWithHeaders`, `prefetchWithMetadata` and `abortPrefetch` statics react-native-web
//     lacks. `PixelRatio` gains React Native's no-op `startDetecting`.
//   - `AppRegistry` is passed through `withAppRegistry` (with react-native-web's `View`):
//     sections, `getRunnable` / `getRegistry`, `setSurfaceProps`, `setRootViewStyleProvider`
//     and the headless-task registry.
//   - `LogBox` gains React Native's `isInstalled` / `clearAllLogs` / `addLog` /
//     `addConsoleLog` / `addException` (`withLogBoxStatics`, its production behaviour) and
//     `LayoutAnimation` its `setEnabled` (`withLayoutAnimationStatics`).
//   - `StyleSheet` gains `setStyleAttributePreprocessor` (`withStyleSheetStatics`), and
//     react-native-web's style `preprocess` step runs the registered processors first
//     (`processStyleAttributes`), so they reach compiled and inline styles alike.
//   - An image import (`require("./logo.png")`) with Metro-style `@2x` / `@3x` siblings (the
//     base file may be missing, as in Metro) resolves to a module that bundles each variant and
//     exports the URL of the one this screen wants (`pickImageScale`), still a string.
//
// react-native-web stays unforked: each patch rewrites one module's default export (ES and
// CommonJS builds) and leaves a module it does not recognise unchanged.

import { basename, dirname, extname, join } from "@std/path";
import type * as esbuild from "esbuild";

/** The prebuilt runtime the patches call into. */
const OVERLAY = "denext/react-native";

/** The react-native-web modules whose default export is wrapped, and the wrapper. */
const WRAPPED: Readonly<Record<string, string>> = {
  AppRegistry: "withAppRegistry",
  Image: "withImageStatics",
  LayoutAnimation: "withLayoutAnimationStatics",
  LogBox: "withLogBoxStatics",
  ScrollView: "withScrollSnap",
  StyleSheet: "withStyleSheetStatics",
  Text: "withFontScaling",
  PixelRatio: "withFontScaleRatio",
};

/** The wrapped modules whose wrapper also takes react-native-web's `View` (`../View`). */
const WRAPPED_WITH_VIEW: ReadonlySet<string> = new Set(["AppRegistry"]);

/** A wrapped module, ES or CommonJS build: group 1 is `cjs/`, group 2 the name. */
const WRAPPED_MODULE = new RegExp(
  `[\\\\/]react-native-web[\\\\/]dist[\\\\/](cjs[\\\\/])?exports[\\\\/](${
    Object.keys(WRAPPED).join("|")
  })[\\\\/]index\\.js$`,
);

/** react-native-web's `Dimensions` (ES or CommonJS build). */
const DIMENSIONS_MODULE =
  /[\\/]react-native-web[\\/]dist[\\/](cjs[\\/])?exports[\\/]Dimensions[\\/]index\.js$/;

/**
 * `source` with its default export passed through `wrapper` from denext/react-native:
 * `export default X;` / `export default class X {…}` in the ES build, `exports.default = X;`
 * in the CommonJS one. Unchanged when no such export is found.
 *
 * @param source The module source.
 * @param wrapper The denext/react-native export that wraps the default export.
 * @param cjs Whether the module is from the CommonJS build.
 * @param withView Also pass react-native-web's `View` (the sibling `../View` module).
 * @returns The patched source.
 */
export function wrapDefaultExport(
  source: string,
  wrapper: string,
  cjs: boolean,
  withView = false,
): string {
  if (cjs) {
    const m = /(exports\.default\s*=\s*)(?!void\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*;/
      .exec(source);
    if (!m) return source;
    const view = withView
      ? ', (function (m) { return m && m.__esModule ? m.default : m; })(require("../View"))'
      : "";
    return source.slice(0, m.index) +
      `${m[1]}require(${JSON.stringify(OVERLAY)}).${wrapper}(${m[2]}${view});` +
      source.slice(m.index + m[0].length);
  }
  const imp = `\nimport { ${wrapper} as __denextWrap } from ${JSON.stringify(OVERLAY)};\n` +
    (withView ? 'import __denextView from "../View";\n' : "");
  const arg = withView ? ", __denextView" : "";
  const cls = /export\s+default\s+class\s+([A-Za-z_$][\w$]*)/.exec(source);
  if (cls) {
    return source.slice(0, cls.index) + `class ${cls[1]}` +
      source.slice(cls.index + cls[0].length) + imp +
      `export default __denextWrap(${cls[1]}${arg});\n`;
  }
  const m = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;/.exec(source);
  if (!m) return source;
  return source.slice(0, m.index) + `export default __denextWrap(${m[1]}${arg});` +
    source.slice(m.index + m[0].length) + imp;
}

/** react-native-web's style `preprocess` module (ES or CommonJS build). */
const PREPROCESS_MODULE =
  /[\\/]react-native-web[\\/]dist[\\/](cjs[\\/])?exports[\\/]StyleSheet[\\/]preprocess\.js$/;

/**
 * react-native-web's style `preprocess` with `processStyleAttributes` (denext/react-native)
 * applied to its input first, so `StyleSheet.setStyleAttributePreprocessor`'s processors see
 * every style. Unchanged when the function is not found.
 *
 * @param source The module source.
 * @param cjs Whether the module is from the CommonJS build.
 * @returns The patched source.
 */
export function withStyleAttributePreprocessing(source: string, cjs: boolean): string {
  const m = /function preprocess\(\s*([A-Za-z_$][\w$]*)\s*(?:,[^)]*)?\)\s*\{/.exec(source);
  if (!m) return source;
  const at = m.index + m[0].length;
  const patched = source.slice(0, at) + `\n  ${m[1]} = __denextProcessStyle(${m[1]});` +
    source.slice(at);
  return patched +
    (cjs
      ? `\nfunction __denextProcessStyle(style) {\n  return require(${
        JSON.stringify(OVERLAY)
      }).processStyleAttributes(style);\n}\n`
      : `\nimport { processStyleAttributes as __denextProcessStyle } from ${
        JSON.stringify(OVERLAY)
      };\n`);
}

/**
 * react-native-web's `Dimensions` with `fontScale` read from `reactNativeFontScale()` (its
 * `fontScale: 1` literals), so `Dimensions.get()`, its change events and
 * `useWindowDimensions()` report the OS text size. Unchanged when there is no such literal.
 *
 * @param source The module source.
 * @param cjs Whether the module is from the CommonJS build.
 * @returns The patched source.
 */
export function withDimensionsFontScale(source: string, cjs: boolean): string {
  if (!/fontScale:\s*1\b/.test(source)) return source;
  const patched = source.replace(/fontScale:\s*1\b/g, "fontScale: __denextFontScale()");
  return patched +
    (cjs
      ? `\nfunction __denextFontScale() {\n  return require(${
        JSON.stringify(OVERLAY)
      }).reactNativeFontScale();\n}\n`
      : `\nimport { reactNativeFontScale as __denextFontScale } from ${
        JSON.stringify(OVERLAY)
      };\n`);
}

// ---- @2x / @3x image variants -------------------------------------------------------------------

/** The esbuild namespace of the generated image modules. */
const IMAGE_NAMESPACE = "denext-rn-image-scales";

/** A relative image import Metro resolves by density. */
const IMAGE_IMPORT = /^\.\.?\/.*\.(?:png|jpe?g|gif|webp|bmp)$/i;

/** `name@<scale>x.ext` (group 1 the scale) for `name` and `ext`. */
function variantPattern(name: string, ext: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc(name)}(?:@(\\d+(?:\\.\\d+)?)x)?${esc(ext)}$`);
}

/**
 * The density variants of the image at `path` that exist on disk: `[scale, file]` for
 * `name.ext` (scale 1, as in Metro) and each `name@<n>x.ext` (a plain `name.ext` wins over
 * `name@1x.ext`), ascending. Empty unless a variant above or below 1x exists (a plain import,
 * or a lone `@1x`, is left to the normal loader), so an image without `@2x` / `@3x` siblings,
 * in the app or in `node_modules`, is never claimed.
 *
 * @param path The imported image's absolute path.
 * @returns The variants.
 */
export async function imageScaleVariants(path: string): Promise<[number, string][]> {
  const dir = dirname(path);
  const ext = extname(path);
  const pattern = variantPattern(basename(path, ext), ext);
  const byScale = new Map<number, string>();
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile && !entry.isSymlink) continue;
      const m = pattern.exec(entry.name);
      if (!m) continue;
      const scale = m[1] === undefined ? 1 : Number(m[1]);
      if (!(scale > 0)) continue;
      // The plain file is Metro's 1x; `@1x` stands in only when it is missing.
      if (scale === 1 && byScale.has(1) && m[1] !== undefined) continue;
      byScale.set(scale, join(dir, entry.name));
    }
  } catch {
    return [];
  }
  if (![...byScale.keys()].some((s) => s !== 1)) return [];
  return [...byScale].sort((a, b) => a[0] - b[0]);
}

/**
 * The generated module for an image with density variants: CommonJS (so `require()` returns
 * the URL string itself, as for any image), bundling each variant through the normal loader.
 * Each variant is required by its file name relative to the image's folder (the module's
 * `resolveDir`), so it resolves exactly as the original relative import did.
 *
 * @param variants `[scale, file]` pairs.
 * @returns The module source.
 */
export function imageScaleModule(variants: ReadonlyArray<readonly [number, string]>): string {
  const list = variants.map(([scale, file]) =>
    `[${scale}, require(${JSON.stringify(`./${basename(file)}`)})]`
  );
  return `"use strict";\nmodule.exports = require(${
    JSON.stringify(OVERLAY)
  }).pickImageScale([\n  ` +
    list.join(",\n  ") + "\n]);\n";
}

/**
 * The esbuild plugin: react-native-web's `AppRegistry` / `Image` / `ScrollView` / `StyleSheet` /
 * `Text` / `PixelRatio` / `Dimensions` patches and the `@2x` / `@3x` image resolution (see the module docs).
 *
 * @returns The plugin.
 */
export function reactNativePatchesPlugin(): esbuild.Plugin {
  return {
    name: "denext-react-native-patches",
    setup(build) {
      build.onLoad({ filter: WRAPPED_MODULE }, async (args) => {
        const [, cjs, name] = WRAPPED_MODULE.exec(args.path)!;
        return {
          contents: wrapDefaultExport(
            await Deno.readTextFile(args.path),
            WRAPPED[name],
            cjs !== undefined,
            WRAPPED_WITH_VIEW.has(name),
          ),
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
      build.onLoad({ filter: PREPROCESS_MODULE }, async (args) => ({
        contents: withStyleAttributePreprocessing(
          await Deno.readTextFile(args.path),
          PREPROCESS_MODULE.exec(args.path)![1] !== undefined,
        ),
        loader: "js",
        resolveDir: dirname(args.path),
      }));
      build.onLoad({ filter: DIMENSIONS_MODULE }, async (args) => ({
        contents: withDimensionsFontScale(
          await Deno.readTextFile(args.path),
          DIMENSIONS_MODULE.exec(args.path)![1] !== undefined,
        ),
        loader: "js",
        resolveDir: dirname(args.path),
      }));
      build.onResolve({ filter: IMAGE_IMPORT }, async (args) => {
        if (!args.resolveDir) return undefined;
        const path = join(args.resolveDir, args.path);
        // A variant the generated module requires: the file itself (it exists: the module lists
        // only files found on disk), for the normal image loader. No other resolver claims a
        // path from this namespace.
        if (args.namespace === IMAGE_NAMESPACE) return { path, namespace: "file" };
        const variants = await imageScaleVariants(path);
        if (variants.length === 0) return undefined;
        return { path, namespace: IMAGE_NAMESPACE, pluginData: variants };
      });
      build.onLoad({ filter: /.*/, namespace: IMAGE_NAMESPACE }, (args) => ({
        contents: imageScaleModule(args.pluginData as [number, string][]),
        loader: "js",
        resolveDir: dirname(args.path),
      }));
    },
  };
}
