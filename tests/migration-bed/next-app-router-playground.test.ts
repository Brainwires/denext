// Migration bed: vercel/next-app-router-playground — Vercel's own App Router feature tour
// (nested/parallel/intercepting routes, route groups, loading/error/not-found files,
// `cacheComponents` with cached components + functions, MDX + codehike, view transitions,
// useLinkStatus; 54 pages, no external services, pnpm). The broadest single App Router
// surface a real repo exercises, which is why it was the third hand-run migration bed
// (2026-09-06: ten framework fixes came out of it).
//
// Pin: cd0363f (2026-07-23) is the last commit before the playground adopted Next 16.4
// canary's navigation-stage APIs (`unstable_navigation` / `unstable_prefetch` from
// `next/cache`, #233), which denext's compat layer does not provide (KNOWN-LIMITATIONS →
// Experimental / unstable APIs). Bump deliberately, with that gap closed or waived.
//
// NETWORK-REQUIRED (GitHub clone + pnpm install): `deno task test:migration-bed`.

import { type Bed, runBed } from "./_bed.ts";

const PLAYGROUND: Bed = {
  name: "next-app-router-playground",
  repo: "https://github.com/vercel/next-app-router-playground.git",
  sha: "cd0363f3aefd4f4b50ee1b7655feefcc04695f4c",
  install: [["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]],
  kind: "next",
  routes: [
    { path: "/", contains: "Next.js Playground" },
    { path: "/layouts/electronics", contains: "Nested layouts" },
    { path: "/parallel-routes", contains: "Parallel Routes" },
    { path: "/route-groups", contains: "Route Groups" },
    { path: "/cached-components", contains: "Cached React Server Components" },
    { path: "/cached-functions", contains: "Cached Functions" },
    { path: "/loading", contains: "Loading.js" },
    { path: "/error", contains: "Error.js" },
    { path: "/use-link-status", contains: "useLinkStatus" },
    { path: "/view-transitions", contains: "View Transitions" },
    // `[section]/layout.tsx` AND `page.tsx` both call notFound(): per-segment signal boundaries.
    { path: "/not-found/does-not-exist", status: 404, contains: "Not Found" },
    // Next private folders (`_hooks`, `_patterns`) are not routes.
    { path: "/_hooks", status: 404, contains: "404" },
    { path: "/nope", status: 404, contains: "404" },
  ],
};

Deno.test({
  name: "migration bed: vercel/next-app-router-playground migrates, builds, and renders",
  sanitizeOps: false,
  sanitizeResources: false,
}, (t) => runBed(t, PLAYGROUND));
