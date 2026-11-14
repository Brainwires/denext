// Migration bed: Deno's Node.js compatibility test viewer (denoland/node_test_viewer, the site
// behind node-test-viewer.deno.dev), a real-world app on stable Fresh 2 (`jsr:@fresh/core@^2.2`)
// with Vite and Tailwind 4: a `main.ts` app with middleware and `fsRoutes("/")`, `_app`, page
// handlers that fetch the test reports, dynamic `[date]` pages, `[os].json` / `[os].errors.txt`
// routes (partial segments the folder tree cannot hold), four chart / table islands, a `client.ts`
// with the Tailwind stylesheet, and `"unstable": ["kv"]` in its `deno.json`. Nothing is left as
// won't-migrate; the app is built, served (its handlers fetch the reports from the network) and
// hydrated.
//
// Pin: 476b984 (main, 2026-05). NETWORK-REQUIRED (GitHub fetch, the report downloads, JSR / npm):
// `deno task test:migration-bed`.

import { type Bed, runBed } from "./_bed.ts";

const NODE_TEST_VIEWER: Bed = {
  name: "fresh-node-test-viewer",
  repo: "https://github.com/denoland/node_test_viewer.git",
  sha: "476b9844223c66c773ffea31a8f0bfcd747acda5",
  install: [],
  kind: "fresh",
  wontMigrate: [],
  files: [
    { path: "middleware.ts", contains: ['import * as main from "./main.ts";'] },
    // `[os].json` is a partial segment: middleware.ts answers it.
    { path: "middleware.ts", contains: ['pattern: "/results/:date/:os.json"'] },
  ],
  routes: [
    { path: "/", contains: "<title>Node test viewer" },
    // A day's page, its handler reading that day's reports.
    { path: "/results/2026-11-01", contains: "2026-11-01" },
    { path: "/results/2026-11-01/darwin.json", contains: '"date":"2026-11-01"' },
    { path: "/results/2026-11-01/linux.errors.txt", contains: "" },
    { path: "/no-such-page", status: 404, contains: "Not Found" },
  ],
  browser: {
    path: "/",
    hydrated: "[...document.scripts].some((s) => s.src.includes('/_denext/client/'))",
  },
};

Deno.test({
  name: "migration bed: Deno's node_test_viewer (stable Fresh 2 + Vite + Tailwind 4)",
}, (t) => runBed(t, NODE_TEST_VIEWER));
