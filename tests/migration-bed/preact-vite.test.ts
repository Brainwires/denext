// Migration bed: Preact's own starter — create-preact's Vite template with its router option
// (`templates/base` + `templates/config/router` in preactjs/create-preact): `@preact/preset-vite`,
// preact-iso's `<LocationProvider>` / `<Router>` / `<Route>` / `useLocation`, an SVG imported as
// an asset, CSS imports, and `render()` into `#app`. `denext migrate` takes the SPA path with the
// Preact layer (preact → denext, preact-iso → denext/preact-iso), then the app is built, served,
// its shell checked with JS off, and in headless Chromium it renders and a header link navigates
// on the client.
//
// Pin: 3903ab1 (2026-09-30). create-preact assembles a project from its templates at run time
// (`templates/base`, then `templates/config/router` into `src/`, plus `preact-iso` as a
// dependency); the install and `prepare` do the same steps.
// NETWORK-REQUIRED (GitHub fetch + npm install): `deno task test:migration-bed`.

import { copy } from "@std/fs";
import { join } from "@std/path";
import { type Bed, runBed } from "./_bed.ts";

const PREACT_VITE: Bed = {
  name: "preact-vite",
  repo: "https://github.com/preactjs/create-preact.git",
  sha: "3903ab1d48abf04492d6b8624a0e6f6e93f5c516",
  subdir: "templates/base",
  install: [
    ["npm", "pkg", "set", "dependencies.preact-iso=^2.12.2"],
    ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
  ],
  // The router option: create-preact copies `templates/config/router` over `src/`.
  prepare: async (app) => {
    await copy(join(app, "..", "config", "router"), join(app, "src"), { overwrite: true });
    await Deno.rename(join(app, "_gitignore"), join(app, ".gitignore"));
  },
  kind: "preact",
  routes: [
    // The SPA shell (what a browser without JS gets): the template's title and mount point.
    { path: "/", contains: "<title>Vite + Preact</title>" },
    { path: "/", contains: '<div id="app">' },
    // Every path serves the shell; preact-iso routes it in the browser.
    { path: "/404", contains: '<div id="app">' },
    // A public file.
    { path: "/vite.svg", contains: "<svg" },
  ],
  browser: {
    path: "/",
    hydrated: 'document.querySelector("h1")?.textContent.includes("Get Started") === true',
    interact: {
      click: 'header a[href="/404"]',
      until: 'location.pathname === "/404" && document.body.textContent.includes("404: Not Found")',
    },
  },
};

Deno.test({
  name: "migration bed: create-preact's Vite + preact-iso app migrates, builds and routes",
  sanitizeOps: false,
  sanitizeResources: false,
}, (t) => runBed(t, PREACT_VITE));
