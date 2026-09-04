/**
 * `@denext/denext/plugin-kit` — the blessed, **semver-stable** toolkit for
 * **router-class plugins**: packages that own a render pipeline of their own (claim
 * requests, server-render, hydrate, bundle, and cache their routes) rather than just
 * hooking a seam. {@link https://jsr.io/@denext/pages-router | `@denext/pages-router`}
 * is the reference consumer; React-Router- and TanStack-Router-on-denext plugins are
 * the intended future ones.
 *
 * ## Why this module exists
 *
 * denext's core (`src/router`, `src/build`, `src/server`) must stay free to evolve.
 * The stability promise is therefore **narrow and explicit**: a router-class plugin
 * imports the seams it extends and the primitives it reuses from **exactly two
 * places** —
 *
 * 1. `@denext/denext` — the normal app API (`h`, `Fragment`, `renderToString`,
 *    hooks, `Suspense`, …). Stable because every denext app depends on it.
 * 2. `@denext/denext/plugin-kit` (this module) — the plugin **contract seams** plus
 *    the **pipeline primitives** below. Stable by signature: the *names and shapes*
 *    here are covered by semver; **where they live inside `src/` is not** and may
 *    move between minors. This facade absorbs that churn.
 *
 * Anything imported from any other path (`@denext/denext/server` beyond these names,
 * deep `src/…` modules) is **not** part of the router-plugin contract and can change
 * without a major bump. Keeping the promised set this small is what lets the core be
 * refactored freely.
 *
 * @module
 */

// ── Contract seams ─────────────────────────────────────────────────────────
// The plugin object and the context its `setup` receives — see the full contract
// in {@link https://github.com/…/PLUGINS.md | PLUGINS.md}.
export type {
  DenextPlugin,
  PluginBuildContext,
  PluginBuildStep,
  PluginContext,
  PluginMode,
  PluginRequestHandler,
  PluginTeardown,
  RouteSynthesizer,
} from "../server/mod.ts";
// For the `addCommand` seam (contribute a `denext <verb>`).
export type { CommandContext, CommandSpec } from "../cli/command.ts";

// ── Route matching ─────────────────────────────────────────────────────────
// Parse denext route patterns and match request paths against them — the reusable
// core of the file router, so a plugin's own route tree matches identically.
export { matchSegments, parsePattern, peelLocale, specificity } from "../server/mod.ts";
export type { RouteParams, Segment } from "../server/mod.ts";

// ── Incremental static regeneration ────────────────────────────────────────
// The page cache backing `getStaticProps`-style revalidation.
export { PageCache } from "../server/mod.ts";

// ── Client-route bundling (build step) ─────────────────────────────────────
// Produce a route's browser entry bundle — call from an `addBuildStep` to emit a
// plugin's client bundles for production.
export { bundleRoutes } from "../build/plugin-bundle.ts";

// ── CSS pipeline (build step) ──────────────────────────────────────────────
// Compile and collect a route's CSS the same way the core App Router does.
export { buildAppCss, extractRouteCss } from "../build/plugin-css.ts";
export type { AppCss } from "../build/plugin-css.ts";

// ── Client hydration & fast refresh ────────────────────────────────────────
// Hydrate a plugin-rendered tree in the browser, and register component families
// so dev Fast Refresh reaches plugin routes.
export { hydrateRoot } from "../client/mod.ts";
export { enableFastRefresh, registerFamily } from "../client/refresh-runtime.ts";
