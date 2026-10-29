// Migration bed: TanStack's own Start example (`examples/react/start-basic` in TanStack/router)
// — Start on Vite with `tanstackStart({ srcDirectory: 'src' })`, file routes with a pathless
// layout, a server route (`customScript[.]js.ts`), a `beforeLoad` redirect, a not-found
// component, `~/` tsconfig paths and Tailwind 4. `denext migrate` wires the
// `@denext/tanstack-start` plugin (the Start options carried from vite.config.ts), then the app
// is built, served and opened in headless Chromium.
//
// Pin: 140efa4 ("ci: Version Packages (#8701)", 2026-10-14), whose example asks for
// @tanstack/react-start ^1.169.2 and @tanstack/react-router ^1.170.44 — the versions
// examples/tanstack-start runs. Those two are pinned exactly before the install, so the bed does
// not float to a Start release the plugin has not met. The posts and users pages fetch from
// jsonplaceholder.typicode.com at render, so they are not asserted.
// NETWORK-REQUIRED (GitHub fetch + npm install): `deno task test:migration-bed`.

import { type Bed, runBed } from "./_bed.ts";

const START_BASIC: Bed = {
  name: "tanstack-start-basic",
  repo: "https://github.com/TanStack/router.git",
  sha: "140efa4347859f04a9d95f8e61031196341d3d78",
  subdir: "examples/react/start-basic",
  install: [
    [
      "npm",
      "pkg",
      "set",
      "dependencies.@tanstack/react-start=1.169.2",
      "dependencies.@tanstack/react-router=1.170.44",
    ],
    ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
  ],
  kind: "tanstack-start",
  routes: [
    { path: "/", contains: "Welcome Home!!!" },
    // A pathless layout route's child.
    { path: "/route-a", contains: "m A!" },
    // A server route answers with its handler.
    { path: "/customScript.js", contains: 'console.log("Hello from customScript.js!")' },
    // `beforeLoad` throws a redirect.
    { path: "/redirect", status: 307, contains: "", location: "/posts" },
    // The root route's notFoundComponent.
    { path: "/this-route-does-not-exist", status: 404, contains: "does not exist" },
  ],
  browser: {
    path: "/",
    hydrated: '"__TSS_START_OPTIONS__" in globalThis && ' +
      'document.body.textContent.includes("Welcome Home!!!")',
    navigate: {
      click: 'a[href="/route-a"]',
      until: 'location.pathname === "/route-a" && document.body.textContent.includes("A!")',
    },
  },
};

Deno.test({
  name: "migration bed: TanStack/router start-basic (TanStack Start) migrates, builds, and renders",
}, (t) => runBed(t, START_BASIC));
