// React Native mode: `react-native-windows` and `react-native-macos`. An app written for the
// desktop React Native forks imports them (or `react-native` aliased to them by Metro); in React
// Native mode each resolves to a module that re-exports `react-native` (react-native-web with the
// shell overlay) and adds what the package adds to React Native, built by the overlay's desktop
// factories over react-native-web's own components (src/react-native/desktop.ts). A deep
// `react-native-windows/Libraries/…` import resolves as the same `react-native/Libraries/…`
// path. The real packages (Flow source, native projects) are never read, so neither needs to be
// installed. What each provides is recorded in src/react-native/desktop-manifest.ts.
//
// With `reactNative.desktopPackage` set, a bare `react-native` import in the app's own source
// (not node_modules, not a generated module) resolves as that package too: what Metro's
// out-of-tree platform resolution does for a macOS / Windows build, so the app's unmodified
// `import { View, Flyout } from "react-native"` gets the desktop View props and additions.

import type * as esbuild from "esbuild";
import { resolveInstead } from "./react-native-aliases.ts";

/** A desktop package, or a subpath of one. Group 1 is the flavor, group 2 the subpath. */
const DESKTOP_FILTER = /^react-native-(windows|macos)(\/.*)?$/;

/** The shell overlay's prebuilt runtime specifier (`RN_OVERLAY` in react-native.ts, which imports this module). */
const OVERLAY = "denext/react-native";

/** The esbuild namespace of the generated desktop entry modules. */
const NAMESPACE = "denext-react-native-desktop";

/** The additions each package's entry gains, as `export var` lines over the overlay. */
const ADDITIONS: Readonly<Record<"windows" | "macos", readonly string[]>> = {
  windows: [
    'export var View = /* @__PURE__ */ __desktop.createDesktopView(__View, "windows");',
    "export var ViewWindows = View;",
    "export var Flyout = /* @__PURE__ */ __desktop.createFlyout(__Modal, __View);",
    "export var Popup = /* @__PURE__ */ __desktop.createPopup(__Modal, __View);",
    "export var Glyph = /* @__PURE__ */ __desktop.createGlyph(__Text);",
    "export var AppTheme = __desktop.AppTheme;",
    "export var supportKeyboard = __desktop.supportKeyboard;",
    "export var EventPhase = __desktop.EventPhase;",
    "export var HandledEventPhase = __desktop.HandledEventPhase;",
  ],
  macos: [
    'export var View = /* @__PURE__ */ __desktop.createDesktopView(__View, "macos");',
    "export var DynamicColorMacOS = __desktop.DynamicColorMacOS;",
    "export var ColorWithSystemEffectMacOS = __desktop.ColorWithSystemEffectMacOS;",
  ],
};

/**
 * The module `react-native-<flavor>` resolves to: `react-native`'s exports, with the
 * package's own additions (and its desktop `View`) from the overlay. The overlay is read
 * through a namespace, so each addition binds statically and an unused one tree-shakes away.
 *
 * @param flavor `"windows"` or `"macos"`.
 * @returns The module source.
 */
export function desktopEntrySource(flavor: "windows" | "macos"): string {
  return [
    'export * from "react-native";',
    'import { Modal as __Modal, Text as __Text, View as __View } from "react-native";',
    `import * as __desktop from ${JSON.stringify(OVERLAY)};`,
    ...ADDITIONS[flavor],
    "",
  ].join("\n");
}

/** Whether an import comes from the app's own source: a file outside node_modules. */
function isAppSource(args: esbuild.OnResolveArgs): boolean {
  return args.namespace === "file" && args.importer !== "" &&
    !/[\\/]node_modules[\\/]/.test(args.importer);
}

/**
 * The esbuild plugin that resolves `react-native-windows` / `react-native-macos` (and their
 * subpaths) in React Native mode (see the module comment). It must run ahead of the
 * `react-native` → react-native-web resolver when `desktopPackage` is set.
 *
 * @param desktopPackage `reactNative.desktopPackage`: the package a bare `react-native` import
 *   in the app's own source resolves as (unset: `react-native` is not redirected).
 * @returns The plugin.
 */
export function desktopReactNativePlugin(
  desktopPackage?: "react-native-macos" | "react-native-windows",
): esbuild.Plugin {
  const aliased = desktopPackage === undefined
    ? undefined
    : desktopPackage === "react-native-windows"
    ? "windows"
    : "macos";
  return {
    name: "denext-react-native-desktop",
    setup(build) {
      if (aliased) {
        build.onResolve(
          { filter: /^react-native$/ },
          (args) =>
            isAppSource(args)
              ? { path: aliased, namespace: NAMESPACE, pluginData: args.resolveDir }
              : null,
        );
      }
      build.onResolve({ filter: DESKTOP_FILTER }, (args) => {
        const [, flavor, sub] = DESKTOP_FILTER.exec(args.path)!;
        if (sub) return resolveInstead(build, `react-native${sub}`, args);
        return { path: flavor, namespace: NAMESPACE, pluginData: args.resolveDir };
      });
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
        contents: desktopEntrySource(args.path as "windows" | "macos"),
        loader: "js",
        resolveDir: typeof args.pluginData === "string" ? args.pluginData : undefined,
      }));
    },
  };
}
