// Migration bed: Unistyles 3's Expo example (`apps/expo-example` in
// jpudysz/react-native-unistyles), built in React Native mode for the web: expo-router 57 with a
// custom `Stack` header (the theme switcher), `StyleSheet.create` with theme functions, dynamic
// functions, variants and breakpoints, React Native 0.86.
//
// What it found in denext (fixed at the root, each with its own test): the app's styles were
// all dropped (react-native-web's components do not read a Unistyles style; React Native mode
// now does what the Unistyles Babel plugin does: tests/react-native-unistyles.test.ts),
// `styles.useVariants` never applied (same file), React Native 0.83's `unstable_NativeView` /
// `unstable_NativeText` failed the build (tests/react-native-core-build.test.ts), every
// `<Stack.Screen>` was dropped, titles with it (tests/expo-router-stack-screen.test.ts), and a
// screen's `header` option was ignored (tests/navigation-native-dom.test.ts).
//
// Pin: 8fc9f36 (2026-10-17). The example builds against the monorepo's library source (a
// workspace dependency and tsconfig `paths`); the bed uses the published package of the same
// version, 3.5.3, as an app outside the monorepo does, and installs the example alone.
// NETWORK-REQUIRED (GitHub fetch + npm install): `deno task test:migration-bed`.

import { type Bed, runBed } from "./_bed.ts";

/** A home-screen card's background colour. */
const cardBackground =
  `getComputedStyle(document.querySelector('[data-testid="screen-basics"]')).backgroundColor`;

const UNISTYLES: Bed = {
  name: "unistyles-expo-example",
  repo: "https://github.com/jpudysz/react-native-unistyles.git",
  sha: "8fc9f36d1e57c18b944b75f8dd8054ef112d9d01",
  subdir: "apps/expo-example",
  install: [
    ["npm", "pkg", "set", "dependencies.react-native-unistyles=3.5.3"],
    [
      "npm",
      "install",
      "--workspaces=false",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      "--ignore-scripts",
    ],
  ],
  // The library source the monorepo aliases (its `unifiber` submodule is not cloned).
  prepare: async (app) => {
    const file = `${app}/tsconfig.json`;
    const tsconfig = JSON.parse(await Deno.readTextFile(file));
    delete tsconfig.compilerOptions.paths;
    await Deno.writeTextFile(file, JSON.stringify(tsconfig, null, 2) + "\n");
  },
  kind: "expo",
  routes: [
    { path: "/", contains: '<div id="root">' },
    { path: "/variants", contains: "<title>expo-example</title>" },
  ],
  browser: {
    path: "/",
    // The custom header (theme switcher) and a themed card: the light theme's surface.
    hydrated: `!!document.querySelector('[data-testid="theme-dark"]') && ` +
      `document.body.innerText.includes("Every screen covers") && ` +
      `${cardBackground} === "rgb(255, 255, 255)"`,
    interact: {
      click: '[data-testid="theme-dark"]',
      until: `${cardBackground} === "rgb(28, 28, 30)"`,
    },
    navigate: {
      click: '[data-testid="screen-variants"]',
      until: 'location.pathname === "/variants" && ' +
        'document.body.innerText.includes("Selected variants")',
    },
  },
};

Deno.test({
  name: "migration bed: Unistyles' Expo example builds, renders, themes and navigates on the web",
  sanitizeOps: false,
  sanitizeResources: false,
}, (t) => runBed(t, UNISTYLES));
