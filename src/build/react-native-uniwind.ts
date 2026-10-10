// React Native mode's uniwind support: what uniwind's own Vite plugin (`uniwind/vite`) does to
// a web build, applied when the app has `uniwind` installed (unless `reactNative.uniwind` is
// `false`):
//
//   - `react-native` resolves to uniwind's web components (`className` on every React Native
//     component), except inside uniwind itself, whose components wrap react-native-web's;
//   - react-native-web's `StyleSheet` gets uniwind's `createOrderedCSSStyleSheet` (the layered
//     sheet that keeps react-native-web's styles under Tailwind's);
//   - uniwind's config module registers the app's themes (`light`, `dark` and
//     `reactNative.uniwind.extraThemes`, the `extraThemes` given to `withUniwindConfig`), so
//     `ScopedTheme` / `Uniwind.setTheme` accept them.
//
// The stylesheet itself is the app's Tailwind input compiled by `tailwind: { input, output }`
// (it `@import`s `"uniwind"`: the package's `uniwind.css`, which `uniwind generate-artifacts`
// writes).

import { dirname, join } from "@std/path";
import type * as esbuild from "esbuild";
import { type DenextConfig, reactNativeOptions } from "../server/config.ts";
import { findInstalledPackage } from "./installed-package.ts";

/** uniwind's web components, relative to the package. */
const COMPONENTS = "dist/module/components/web/index.js";
/** uniwind's layered `createOrderedCSSStyleSheet`, relative to the package. */
const ORDERED_SHEET = "dist/module/components/web/createOrderedCSSStyleSheet.js";
/** uniwind's web config module (its `Uniwind` builder). */
const CONFIG_MODULE = /[\\/]uniwind[\\/]dist[\\/]module[\\/]core[\\/]config[\\/]config\.js$/;
/** react-native-web's `StyleSheet` directory, the one importer of the ordered sheet. */
const STYLE_SHEET_DIR =
  /[\\/]react-native-web[\\/]dist[\\/](?:cjs[\\/])?exports[\\/]StyleSheet[\\/]/;

/**
 * The themes uniwind registers for `config` (`light`, `dark`, then
 * `reactNative.uniwind.extraThemes`), or null when the integration is off.
 *
 * @param config The app config.
 */
export function uniwindThemes(config: DenextConfig | null | undefined): string[] | null {
  const options = reactNativeOptions(config);
  if (!options || options.uniwind === false) return null;
  const option = options.uniwind;
  const extra = typeof option === "object" ? option.extraThemes ?? [] : [];
  return [...new Set(["light", "dark", ...extra])];
}

/**
 * The source appended to uniwind's config module: register `themes` (what the Vite plugin's
 * transform appends).
 *
 * @param themes The theme names.
 */
export function uniwindReinitSource(themes: readonly string[]): string {
  return `\n;Uniwind.__reinit(() => ({}), ${JSON.stringify(themes)});\n`;
}

/** Whether `path` is a file of the package at `pkgDir`. */
function inside(path: string, pkgDir: string): boolean {
  return path.startsWith(pkgDir + "/") || path.startsWith(pkgDir + "\\");
}

/**
 * The esbuild plugin behind React Native mode's uniwind support (see the module comment). It
 * does nothing when uniwind is not installed. Registered ahead of the react-native-web
 * resolver, which then resolves uniwind's own `react-native` imports.
 *
 * @param projectDir Where `uniwind` is looked up from.
 * @param themes The themes to register ({@linkcode uniwindThemes}).
 */
export function uniwindPlugin(projectDir: string, themes: readonly string[]): esbuild.Plugin {
  let found: Promise<string | null> | null = null;
  const uniwind = () => found ??= findInstalledPackage(projectDir, "uniwind");
  return {
    name: "denext-react-native-uniwind",
    setup(build) {
      build.onResolve({ filter: /^react-native$/ }, async (args) => {
        const dir = await uniwind();
        if (!dir || (args.importer && inside(args.importer, dir))) return undefined;
        return { path: join(dir, COMPONENTS) };
      });
      build.onResolve({ filter: /^\.\/createOrderedCSSStyleSheet(?:\.js)?$/ }, async (args) => {
        if (!STYLE_SHEET_DIR.test(args.importer)) return undefined;
        const dir = await uniwind();
        return dir ? { path: join(dir, ORDERED_SHEET) } : undefined;
      });
      build.onLoad({ filter: CONFIG_MODULE }, async (args) => ({
        contents: (await Deno.readTextFile(args.path)) + uniwindReinitSource(themes),
        loader: "js",
        resolveDir: dirname(args.path),
      }));
    },
  };
}
