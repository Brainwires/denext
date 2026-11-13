// Migration bed: Deno SaaSKit (denoland/saaskit), a real-world Fresh 1.7 app with five plugins in
// its `fresh.config.ts` — four local ones (`kv-oauth`: `/signin`, `/callback`, `/signout` routes;
// `session`: middleware that reads the session from Deno KV; `error-handling` and
// `security-headers`: middleware) and a remote one (`fresh_ga4`'s analytics middleware) — beside
// Fresh's Tailwind plugin, Deno KV data, Markdown blog posts, islands and `_app` / `_404` /
// `_500`. `denext migrate` keeps `fresh.config.ts` (minus the Tailwind plugin) and its plugins run
// as Fresh runs them: nothing is left as won't-migrate.
//
// Pin: bc8043e (main, 2026-02). `prepare` gives the kv-oauth plugin the GitHub OAuth variables it
// reads at start (dummy values: `/signin` only builds the authorize redirect). `deno install`
// after migrate installs its npm dependencies, so its Tailwind v3 stylesheet compiles with the
// app's own `tailwindcss`, as denext does for a v3 app.
// NETWORK-REQUIRED (GitHub fetch + deno.land / JSR / npm downloads): `deno task test:migration-bed`.

import { join } from "@std/path";
import { type Bed, runBed } from "./_bed.ts";

/** The GitHub OAuth variables `createGitHubOAuthConfig()` reads (dummy: no sign-in completes). */
async function oauthEnv(app: string): Promise<void> {
  await Deno.writeTextFile(
    join(app, ".env"),
    "GITHUB_CLIENT_ID=bed-client-id\nGITHUB_CLIENT_SECRET=bed-client-secret\n",
  );
}

const SAASKIT: Bed = {
  name: "fresh-saaskit",
  repo: "https://github.com/denoland/saaskit.git",
  sha: "bc8043e85a1e8ba8d097ce21af3b7b49e7dfc5ad",
  install: [],
  prepare: oauthEnv,
  // The app's npm dependencies installed (`nodeModulesDir: "auto"`), so its Tailwind v3 config
  // compiles with its own `tailwindcss` (denext picks the compiler by the installed version).
  afterMigrate: [["$deno", "install"]],
  kind: "fresh",
  wontMigrate: [],
  // SaaSKit opens Deno KV at start, which needs its `deno.json`'s `"unstable": ["kv"]`; the CLI
  // under test runs from this checkout and resolves its own config, not the app's (a
  // JSR-installed CLI's `denext task start` resolves the app's), so the bed stops after the build.
  serve: false,
  files: [
    // The config stays for its plugins, without Fresh's Tailwind plugin.
    { path: "fresh.config.ts", contains: ["kvOAuthPlugin", "ga4Plugin()"], absent: ["tailwind"] },
    { path: "middleware.ts", contains: ["plugins: freshConfig.default?.plugins"] },
    { path: "denext.config.ts", contains: ["plugins: [freshPlugins()]"] },
  ],
  routes: [
    // The home page reads items from Deno KV (none yet) inside _app.
    { path: "/", contains: "<html" },
    // A Markdown blog listing and a post.
    { path: "/blog", contains: "Blog" },
    // A plugin route (kv-oauth): the GitHub authorize redirect.
    { path: "/signin", status: 302, contains: "", location: "github.com/login/oauth/authorize" },
    // A page the session plugin's middleware guards: signed out, it redirects to /signin.
    { path: "/account", status: 303, contains: "", location: "/signin" },
    // The _404 page.
    { path: "/no-such-page", status: 404, contains: "Page not found" },
  ],
  browser: {
    path: "/",
    hydrated: "[...document.scripts].some((s) => s.src.includes('/_denext/client/'))",
  },
};

Deno.test({
  name: "migration bed: Deno SaaSKit (Fresh 1.7 + five plugins) migrates with nothing left out",
}, (t) => runBed(t, SAASKIT));
