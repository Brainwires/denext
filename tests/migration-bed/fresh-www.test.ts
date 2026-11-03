// Migration bed: Fresh's own website (`www/` in freshframework/fresh) — a Fresh 2 app on Vite
// with Tailwind 4: `main.ts` middleware (`trailingSlashes`, a host redirect), `_app` reading
// middleware state, `_layout`s and `_middleware`s (state, redirects, a response-copying
// analytics wrapper), an `_error` page that renders 404s, a `[...slug]` docs route reading
// Markdown from the repo, handler-only routes (redirects, a `routeOverride` proxy), a form POST
// answered with a 303, Partials, and nine islands using `@preact/signals`. `denext migrate`
// generates `app/` and `middleware.ts` around the untouched route modules, then the app is
// built, served, every route is fetched (pages are server-rendered: they read with JS off), and
// in headless Chromium the home page's counter island is hydrated and clicked, and a recipe
// button (`f-partial`) swaps its `<Partial name="recipe">` region in place.
//
// Pin: 39b5f06 (the `2.3.3` release tag). `www/` is a member of the repo's Deno workspace;
// `prepare` makes it a standalone app (the root import map folded into `www/deno.json`, the
// workspace config removed), as a project created with `@fresh/init` is. `afterMigrateEdit`
// applies the one hand fix `migrate --check` reports: the docs route picks a file path by Vite's
// `import.meta.env.PROD` (migrate points it at `denext/fresh/env`, where it is true under
// `denext start`), but the source runs in place, so the development branch is the right one. The `/@version/path` route proxies GitHub at
// request time, so it is not asserted.
// NETWORK-REQUIRED (GitHub fetch + JSR/npm downloads): `deno task test:migration-bed`.

import { join } from "@std/path";
import { type Bed, runBed } from "./_bed.ts";

/** Fold the workspace root's import map and compiler options into `www/deno.json`. */
async function standalone(app: string): Promise<void> {
  const root = JSON.parse(await Deno.readTextFile(join(app, "..", "deno.json")));
  const www = JSON.parse(await Deno.readTextFile(join(app, "deno.json")));
  www.imports = { ...root.imports, ...www.imports };
  www.compilerOptions = root.compilerOptions;
  await Deno.writeTextFile(join(app, "deno.json"), JSON.stringify(www, null, 2));
  await Deno.remove(join(app, "..", "deno.json"));
  await Deno.remove(join(app, "..", "deno.lock"));
}

/** The docs route's build-output path pick (`import.meta.env.PROD`) → the in-place branch. */
async function dropViteEnv(app: string): Promise<void> {
  const file = join(app, "routes", "docs", "[...slug].tsx");
  const source = await Deno.readTextFile(file);
  const fixed = source.replace("importMetaEnv.PROD", "false");
  if (fixed === source) throw new Error("fresh-www bed: the import.meta.env line moved");
  await Deno.writeTextFile(file, fixed);
}

/** What a browser sends: the www handlers answer a non-HTML client differently. */
const HTML = { accept: "text/html" };

const FRESH_WWW: Bed = {
  name: "fresh-www",
  repo: "https://github.com/freshframework/fresh.git",
  sha: "39b5f06f8a7d7fa02dd2e2950f2291d04ef9fea7",
  subdir: "www",
  install: [],
  prepare: standalone,
  afterMigrateEdit: dropViteEnv,
  kind: "fresh",
  routes: [
    // The home page: handler state for `_app`, a server-rendered island (JS off). The handler
    // answers a non-browser client (Deno's `fetch`, no `Accept: text/html`) with a redirect.
    { path: "/", headers: HTML, contains: "Interactive island" },
    {
      path: "/",
      headers: HTML,
      contains: "<title>Fresh - The simple, approachable, productive web framework.",
    },
    { path: "/", status: 307, contains: "Redirecting to", location: "deno.land/x/fresh@" },
    // A handler-only index route redirects.
    { path: "/docs", status: 302, contains: "", location: "/docs/introduction" },
    // `[...slug]` renders Markdown inside the docs `_layout`; its title comes from ctx.state.
    { path: "/docs/introduction", contains: "<title>Introduction | Fresh docs" },
    { path: "/docs/introduction", contains: '<div class="layout">' }, // the docs `_layout`
    { path: "/docs/concepts/architecture", contains: "Architecture" },
    { path: "/docs/1.x/introduction", contains: "Fresh" },
    // The docs `_middleware` redirects old and canary URLs.
    {
      path: "/docs/canary/introduction",
      status: 301,
      contains: "",
      location: "/docs/introduction",
    },
    {
      path: "/docs/getting-started/fetching-data",
      status: 307,
      contains: "",
      location: "/docs/getting-started/custom-handlers",
    },
    // An unknown docs page and an unknown path: the `_error` page, at 404.
    { path: "/docs/no-such-page", status: 404, contains: "Couldn’t find what you’re looking for." },
    { path: "/no-such-page", status: 404, contains: "Couldn’t find what you’re looking for." },
    // A page reading the query in its handler.
    { path: "/thanks?vote=lemon-cake", contains: "lemon cake" },
    // A handler-only route answering with a redirect.
    {
      path: "/update",
      headers: HTML,
      status: 307,
      contains: "Redirecting to",
      location: "/docs/concepts/updating",
    },
    // The recipe pages only answer Partial requests; a full request is redirected (as in Fresh).
    { path: "/recipes/lemonade", status: 302, contains: "", location: "/#partials" },
    // A trailing slash: denext's own canonical redirect (308) answers before main.ts's
    // `trailingSlashes("never")` (302) would.
    { path: "/docs/introduction/", status: 308, contains: "", location: "/docs/introduction" },
    // A static file moved from static/ to public/.
    { path: "/fresh-badge.svg", contains: "<svg" },
  ],
  browser: {
    path: "/",
    hydrated: 'document.querySelector("button[title=\\"Add 1\\"]") !== null && ' +
      "[...document.scripts].some((s) => s.src.includes('/_denext/client/'))",
    interact: {
      click: 'button[title="Add 1"]',
      until: '[...document.querySelectorAll(".tabular-nums")].some((e) => e.textContent === "4")',
    },
    // A Partial: the button fetches /recipes/lemonade?fresh-partial=true and swaps the region.
    navigate: {
      click: 'button[f-partial="/recipes/lemonade"]',
      until: 'document.body.textContent.includes("1 ¾ cups white sugar") && ' +
        'document.body.textContent.includes("Interactive island")',
    },
  },
};

Deno.test({
  name: "migration bed: Fresh's www app (Fresh 2 + Vite) migrates, builds, renders and hydrates",
}, (t) => runBed(t, FRESH_WWW));
