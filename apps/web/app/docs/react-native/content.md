---
title: React Native / Expo apps
slug: react-native
lead: Build a React Native or Expo app's own source for the web with react-native-web. Set reactNative in denext.config.ts and the bundler resolves the app the way Metro's web build does, with no patches.
---

denext can build a React Native / Expo app for the browser as a [SPA](/docs/spa):
`react-native` resolves to [react-native-web](https://necolas.github.io/react-native-web/),
the components render to the DOM, and denext's React runs them. Rendering stays DOM; this is
API compatibility, not native rendering.

It was measured on T3 Code's Expo app: with `reactNative: true` in place of hand patches to
the bundler, every deep-linked route renders the same text as before, and the only web-only
code left is the entry file, the app's own shims and its Tailwind wiring.

## Setup

Install `react-native-web` next to the app's other dependencies (`npm install react-native-web`,
or your workspace's package manager), then turn the mode on:

```ts
// denext.config.ts
import type { DenextConfig } from "denext/server";

export default {
  mode: "spa",
  reactNative: true,
  spa: { entry: "./web-entry.tsx", title: "My app" },
} satisfies DenextConfig;
```

The project needs a `deno.json` like any compat SPA: `react`, `react-dom` and the JSX runtimes
aliased to denext, and `"nodeModulesDir": "manual"` so the app's npm packages are read from its
`node_modules`. [`denext migrate`](/docs/migrating) writes that map for you. `react-native`
itself needs no entry: the resolve mode claims it.

## The web entry

Expo's `registerRootComponent` (and the `index.js` Metro starts from) is native-only. Give the
web build its own entry that registers the root component and mounts it on the SPA's `#root`:

```tsx
// web-entry.tsx
import { AppRegistry } from "react-native";
import App from "./src/App";

AppRegistry.registerComponent("main", () => App);
AppRegistry.runApplication("main", { rootTag: document.getElementById("root") });
```

Import anything the native entry imports first for its side effects, such as
`react-native-gesture-handler`, at the top of this file as well.

## What `reactNative` does

| Piece                  | Behaviour                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react-native` imports | `react-native` and every `react-native/…` subpath resolve to the installed react-native-web, for every importer, even when a real `react-native` is installed (its Flow source is never reached). The package is resolved to its real path, so pnpm works.    |
| Deep `Libraries/…`     | `react-native/Libraries/<path>` maps to react-native-web's vendored copy of the same path, then its export or internal module of the same name (`Libraries/Components/View/View` → `View`, `Libraries/Image/AssetRegistry` → `AssetRegistry`).                |
| Native-only internals  | A deep import with no web equivalent (`codegenNativeComponent`, the Fabric renderer shims) loads a stub. Importing it is harmless; calling or constructing any export throws an error that names the import.                                                  |
| Platform files         | `.web.tsx`, `.web.ts`, `.web.jsx` and `.web.js` are tried before the plain extensions, for relative and alias imports and for package subpaths, so `Button.web.tsx` wins over `Button.tsx` and a library's web build wins over its native spec files.         |
| JSX in `.js`           | `.js` files are parsed as JSX. React Native libraries ship JSX in `.js`, which Metro's Babel preset accepts.                                                                                                                                                  |
| Build-time globals     | `__DEV__` (true in `denext dev`, false in a production build), `global` → `globalThis`, and `process.env.EXPO_OS` → `"web"`.                                                                                                                                  |
| Root style             | The SPA shell gets Expo web's root style, `html,body,#root{height:100%;margin:0}` and `#root{display:flex}`, ahead of `spa.head`. React Native's root view is `flex: 1` and needs a sized flex parent; without it, overlays cover the page and take the taps. |

The mode always builds through the esbuild (compat) pipeline, and it applies to `denext build`,
`denext export` and `denext dev`. In dev a React Native app uses the bundled loop (a rebuild and
reload per change) rather than the per-module one, because the resolution above lives in the
bundler. Package subpath probing needs the default `nodeResolve`.

`reactNative` is valid only with `mode: "spa"`; anywhere else the config fails validation.

### Options

Pass an object instead of `true` to change a default:

```ts
reactNative: {
  // Leave the root style out (you set your own in spa.head or your CSS).
  rootStyle: false,
},
```

## Images

`require("./logo.png")` and `import logo from "./logo.png"` resolve to the emitted file's URL,
which react-native-web's `<Image source={…}>` accepts. Resolution-variant files (`logo@2x.png`,
`logo@3x.png`) are not picked by pixel ratio as Metro does: the file you name is the file you
get. Name the variant you want, or keep a plain `logo.png` next to the variants.

## Native-only packages

Packages with no web build (camera, secure storage, native modules) still need a web
replacement of your own. Two ways:

- Add a `.web.ts` beside the module that imports it, exporting a web implementation. The
  platform-file rule picks it up.
- Map the package to a shim in `deno.json`'s `imports`, for example
  `"expo-secure-store": "./web-shims/expo-secure-store.ts"`.

`denext/mobile` covers several of these on the web already, such as `secureStore`, `share`,
`haptic` and the clipboard; see [Desktop & mobile](/docs/desktop).

## Recipe: uniwind and Tailwind

uniwind styles React Native components with Tailwind classes. Its web
setup is specific to the app, so denext does not build it in. What it takes:

1. Compile the Tailwind input with denext's Tailwind integration:
   `tailwind: { input: "./global.css", output: "./global.gen.css" }` in `denext.config.ts`,
   and import `global.css` from the web entry.
2. Run `uniwind generate-artifacts` once for any themes beyond the default, and commit the
   generated CSS it writes.
3. Two importer-sensitive aliases: `react-native` imported from anywhere except uniwind's own
   files resolves to uniwind's web components (`uniwind/dist/module/components/web/index.js`),
   and react-native-web's `StyleSheet` importing `./createOrderedCSSStyleSheet` gets uniwind's
   version from the same directory.

denext's config has no seam for importer-sensitive aliases yet. Until it has one, apply step 3
with [`denext patch`](/docs/patches): patch `src/build/react-native.ts` so the `react-native`
resolver returns uniwind's index when the importer is outside `/uniwind/dist/`, and
`src/build/next-compat.ts`'s app resolver so the `./createOrderedCSSStyleSheet` import from
`react-native-web/dist/exports/StyleSheet` returns uniwind's file.
