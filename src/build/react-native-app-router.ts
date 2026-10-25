// React Native mode (`reactNative` in denext.config.ts) on the App Router.
//
// An App Router app with `reactNative` builds through the next-compat (esbuild) pipeline, as an
// SPA does: `detectNextCompat` turns it on. Each of its three bundles — the server bundle
// (every route module, rendered by the server), the Flight islands bundle and the client route
// bundles — gets React Native mode's resolvers (react-native → react-native-web, `expo-*` →
// `denext/expo/*`, the list adapters, the community stand-ins, …), its build-time globals,
// `.web.*` first and JSX in `.js`, so a Server Component and a `"use client"` component may both
// import `react-native`.
//
// Server rendering: react-native-web turns `StyleSheet.create` styles into atomic CSS rules in a
// style sheet of its own, which on the server is a string. The server bundle registers that
// sheet with the server renderer (SERVER_PRELUDE), which writes it into each page's `<head>` as
// `<style id="react-native-stylesheet">` once the page's shell has rendered
// (../runtime/server-style-sheets.ts, read by ../server/render-page.ts). react-native-web on the
// client adopts the element by that id, so the first paint is styled and hydration reuses the
// rules. The rules a Suspense boundary that streams later adds go out ahead of it
// (../server/late-style-sheets.ts). In `dev` the per-module loop serves these apps as SPA mode's
// (./dev-unbundled/react-native.ts), covering the route entries and Flight islands.
//
// Not on the App Router: expo-router (it is a router; `app/` is the App Router's — an import
// fails the build, naming the App Router equivalents), uniwind (its stylesheet pass is the SPA
// build's) and the SPA shell's options (`rootStyle`, `fonts`; the config rejects `fonts`).

import type { CompatReactNativeOptions } from "./next-compat-build.ts";
import { reactNativeBundleOptions } from "./react-native.ts";
import type { DenextConfig } from "../server/config.ts";

/** The server renderer's style-sheet registry (see ../runtime/server-style-sheets.ts). */
const REGISTRY = 'Symbol.for("denext.serverStyleSheets")';

/**
 * Put ahead of the server bundle's entry: registers react-native-web's style sheet (by the id
 * its client adopts) with the server renderer. Re-registering (a dev rebuild loads a new bundle)
 * replaces the previous generation's sheet.
 */
export const SERVER_PRELUDE = `import { StyleSheet as __denextRnwStyleSheet } from "react-native";
(globalThis[${REGISTRY}] ??= new Map()).set("react-native-stylesheet", () => __denextRnwStyleSheet.getSheet());
`;

/**
 * What React Native mode adds to the App Router's compat bundles, or undefined when
 * `reactNative` is off (each bundle is then built exactly as without it).
 *
 * @param config The app config.
 * @param projectDir The project root (react-native-web is looked up from here).
 * @param dev Whether this is a dev build (sets `__DEV__`).
 */
export function reactNativeCompatOptions(
  config: DenextConfig | null | undefined,
  projectDir: string,
  dev: boolean,
): CompatReactNativeOptions | undefined {
  const rn = reactNativeBundleOptions(config, projectDir, dev, true);
  if (!rn) return undefined;
  return {
    plugins: rn.plugins,
    define: rn.define,
    platformExtensions: rn.platformExtensions,
    jsxInJs: rn.jsxInJs,
    serverPrelude: SERVER_PRELUDE,
  };
}
