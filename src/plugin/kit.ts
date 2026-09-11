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
 * imports the seams it extends and the primitives it reuses from **two server-side
 * places** —
 *
 * 1. `@denext/denext` — the normal app API (`h`, `Fragment`, `renderToString`,
 *    hooks, `Suspense`, …). Stable because every denext app depends on it.
 * 2. `@denext/denext/plugin-kit` (this module) — the plugin **contract seams** plus
 *    the **pipeline primitives** below (route matching, the page cache, bundling, CSS,
 *    the next-compat build, `revalidatePath`, the config/type contracts). Stable by
 *    signature: the *names and shapes* here are covered by semver; **where they live
 *    inside `src/` is not** and may move between minors. This facade absorbs that churn.
 *
 * — plus, for the code it ships to the BROWSER, the two client entries every app uses:
 * `@denext/denext/client` (`hydrateRoot`, `h`) and `@denext/denext/client-runtime`
 * (`registerFamily`/`enableFastRefresh` in a generated hydration entry). Anything
 * imported from any other path (`@denext/denext/server` beyond the names re-exported
 * here, deep `src/…` modules) is **not** part of the router-plugin contract and can
 * change without a major bump. Keeping the promised set this small is what lets the
 * core be refactored freely.
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
  PluginPrepareStep,
  PluginRequestHandler,
  PluginTeardown,
  PrepareStepOptions,
  RouteSynthesizer,
} from "../server/mod.ts";
// For the `addCommand` seam (contribute a `denext <verb>`).
export type { CommandContext, CommandSpec } from "../cli/command.ts";

// ── Route matching ─────────────────────────────────────────────────────────
// Parse denext route patterns and match request paths against them — the reusable
// core of the file router, so a plugin's own route tree matches identically.
export {
  compareSpecificity,
  matchSegments,
  parsePattern,
  peelLocale,
  specificity,
} from "../server/mod.ts";
export type { I18nConfig, RouteParams, Segment } from "../server/mod.ts";

// ── Server primitives a router plugin reuses ───────────────────────────────
// Cache invalidation for plugin-rendered routes; the component/VNode/config type contracts
// a plugin's own render pipeline is written against.
export { revalidatePath, revalidateTag } from "../server/mod.ts";
// Bounded request-body reading (size cap + idle timeout), the same guard Server Actions use.
export { cappedBody, readCappedBody, STALLED, TOO_LARGE } from "../server/mod.ts";
// Re-wrap a request around the bytes `readCappedBody` produced (keeps method/headers/remote addr).
export { bufferedRequest } from "../server/body.ts";
// Route-handler introspection: the definition (schemas, error codes, summary) a `defineApi`
// endpoint declares — what an OpenAPI / docs plugin walks to describe an app's API.
export { apiDefinitionOf } from "../server/mod.ts";
export type { ApiDefinition, ApiRouteMeta } from "../server/mod.ts";
// Server-side observation of a `createChannel` push stream — what a plugin bridging channel
// events into another protocol (GraphQL subscriptions, SSE, a queue) consumes, so it needs no
// second event bus and follows the app's `ChannelTransport` across instances.
export { tapChannel } from "../server/mod.ts";
export type { Channel, ChannelTapHandlers } from "../server/mod.ts";
// The same-origin proof every state-changing denext RPC applies (Server Actions, the typed-API
// batch). A plugin that mounts its own POST endpoint (GraphQL, webhooks, RPC) must apply it —
// a cross-site `<form>` reaches a plugin handler with the victim's cookies otherwise.
export { verifyOrigin } from "../server/origin-check.ts";
export type { OriginCheckOptions } from "../server/origin-check.ts";
// Signed-token primitives (HMAC-SHA256 + base64url) for a plugin's own cookies — pass a
// plugin-specific `domain` so its tokens can never verify as denext's session cookie.
export { fromBase64Url, hmacSign, hmacVerify, toBase64Url } from "../server/session.ts";
export type {
  Component,
  DenextConfig,
  TailwindConfig,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
} from "../server/mod.ts";

// ── next-compat (npm React drop-in) build ──────────────────────────────────
// Compile an app's `react`/`next/*`-importing modules onto denext's React.
export {
  buildNextCompatModules,
  createNextCompatServerLoader,
} from "../build/next-compat-public.ts";
export type {
  BuildNextCompatModulesOptions,
  NextCompatServerLoaderOptions,
} from "../build/next-compat-public.ts";

// ── MDX compile (build step) ───────────────────────────────────────────────
// Compile one MDX/Markdown source to a component-module string with the framework's
// (build-time, opt-in npm) `@mdx-js/mdx` — what `@denext/content-collections` precompiles
// `.mdx` entries with. Pass `jsxImportSource: "denext"` for a native app.
export { compileMdxSource } from "../build/next-compat.ts";
export type { MdxBuildOptions } from "../build/next-compat.ts";

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

// ── Remix / React Router route-module codegen ─────────────────────────────────
/**
 * The Remix route-module codegen `denext migrate --from remix` uses, as a namespace: the
 * swc-based split of a route module into a `"use client"` component + a server data module
 * ({@linkcode remixCodegen.analyzeModule analyzeModule}) and the generated denext wrappers
 * ({@linkcode remixCodegen.pageWrapperSource pageWrapperSource} and siblings). A router
 * plugin (`@denext/react-router`) uses it to generate the same wrappers into `.denext/` for
 * an app whose sources stay untouched.
 */
export * as remixCodegen from "../build/remix-codegen.ts";
