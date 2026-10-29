// Migration bed: Tamagui's free starter (`npm create tamagui`'s "Next + Expo" template,
// tamagui/starter-free), its Expo app (`apps/expo`) built in React Native mode for the web:
// Tamagui 2 (rc) over react-native-web, expo-router 6 with its own root (`index.js` renders
// `<ExpoRoot context={require.context("./app")} />`), Solito screens from the `app` workspace
// package and `@my/ui` from `packages/ui`, yarn 4 workspaces.
//
// What it found in denext (fixed at the root, each with its own test): JSX in a `.js` module
// failed the build (the deno loader ignored React Native mode's `.js` → `jsx` loader:
// tests/deno-loader-plugins.test.ts), and Metro's `require.context` threw in the browser
// (tests/require-context.test.ts).
//
// Pin: 7ccaf93 (2026-02-25), tamagui 2.0.0-rc.16, expo 54. `--mode=skip-build` skips the root
// postinstall (`tamagui check` + the workspace builds): `@my/ui` and `app` ship as source.
// The theme switch on the home screen toggles @tamagui/next-theme, which the Expo app does not
// provide (a no-op on Metro's web build too), so the interaction is the Sheet.
// NETWORK-REQUIRED (GitHub fetch + yarn install): `deno task test:migration-bed`.

import { type Bed, runBed } from "./_bed.ts";

/** The home screen's button whose label is `text`, clicked. */
const press = (text: string) =>
  `[...document.querySelectorAll("button, [role=button]")].find((b) => ` +
  `b.innerText.includes(${JSON.stringify(text)})).click()`;

/** The top of the Sheet's "Made by" line, relative to the viewport's height. */
const sheetTop = `(() => { const e = [...document.querySelectorAll("*")].find((n) => ` +
  `n.childElementCount === 0 && n.textContent === "Made by"); ` +
  `return e ? e.getBoundingClientRect().top / innerHeight : 2; })()`;

const TAMAGUI: Bed = {
  name: "tamagui-starter-free",
  repo: "https://github.com/tamagui/starter-free.git",
  sha: "7ccaf93527d89f301db13968aaeef0f1febd1e4b",
  subdir: "apps/expo",
  install: [["yarn", "install", "--mode=skip-build"]],
  kind: "expo",
  routes: [
    // A SPA: every route is the shell; the browser check renders them.
    { path: "/", contains: '<div id="root">' },
    { path: "/user/nate", contains: "<title>yourprojectsname</title>" },
  ],
  browser: {
    path: "/",
    hydrated: 'document.body.innerText.includes("Welcome to Tamagui.") && ' +
      'document.body.innerText.includes("Link to user")',
    // The circular button opens the Sheet: its content slides up from below the screen.
    interact: {
      press: `[...document.querySelectorAll("button")].find((b) => !b.innerText.trim() && ` +
        `b.getBoundingClientRect().width === 64).click()`,
      until: `${sheetTop} < 0.9`,
    },
    navigate: {
      press: press("Link to user"),
      until: 'location.pathname === "/user/nate" && ' +
        'document.body.innerText.includes("User ID: nate")',
    },
  },
};

Deno.test({
  name: "migration bed: Tamagui's starter (Expo app) builds, renders and navigates on the web",
}, (t) => runBed(t, TAMAGUI));
