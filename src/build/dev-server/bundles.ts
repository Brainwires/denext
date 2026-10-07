// On-demand client bundles (per route, and the app-wide Flight entry), the client entry /
// stylesheet URLs a rendered page links, and the per-generation middleware runner.

import type { Platform } from "../platform-extensions.ts";
import type { PageRoute } from "../../router/manifest.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../../server/middleware.ts";
import { momentumSafeScrollEnabled } from "../../server/config.ts";
import {
  bundleFlightEntry,
  bundleGlobalError,
  type BundleOutput,
  bundleRoute,
  entryCode,
} from "../bundle.ts";
import {
  type BoundaryManifest,
  buildBoundaryManifest,
  importFunctionExports,
  routeEntryFiles,
} from "../module-graph.ts";
import { bundleResolution } from "./assets.ts";
import { isCompat } from "./compat.ts";
import { devBoundaryFor, flightRoutesFor, getManifest, getUnbundled } from "./manifest.ts";
import { renderPlatform } from "./platform.ts";
import { routeDevMeta } from "./route-meta.ts";
import { type DevState, FLIGHT_BUNDLE_PATH, ROUTE_BUNDLE_PATH, ROUTE_CSS_PATH } from "./state.ts";

/** Stash a bundle's split chunks (everything but the entry) for serving. */
function cacheChunks(st: DevState, bundle: BundleOutput): void {
  for (const [name, code] of bundle.files) {
    if (name !== bundle.entry) st.chunkCache.set(name, code);
  }
}

/**
 * The bundle cache key of a target's bundle: the route path for web (what the compat build
 * fills), else the target and the route path (another target's platform files).
 */
function bundleKey(key: string, platform: Platform): string {
  return platform === "web" ? key : `${platform}\0${key}`;
}

/** The bundle cache key of a non-web target's Flight entry (web's is `st.flightBundle`). */
const FLIGHT_KEY = "\0flight";

/**
 * Bundle one route's client entry (native path) and cache it + its chunks. The entry carries
 * the route files' DevTools metadata ({@linkcode routeDevMeta}) — this bundled path has no
 * per-module transform to append it.
 */
async function buildRouteBundle(
  st: DevState,
  route: PageRoute,
  platform: Platform,
): Promise<string> {
  const bundle = await bundleRoute(route, {
    configPath: st.paths.configPath,
    momentumSafeScroll: momentumSafeScrollEnabled(st.paths.config),
    ...await bundleResolution(st, platform),
    // A whole-route bundle stubs the actions it imports, as the Flight bundle does.
    server: (await devBoundaryFor(st, platform)).manifest.server,
    dev: true, // emit Fast Refresh registration into the entry
    devMetaFooter: await routeDevMeta(st, route),
  });
  cacheChunks(st, bundle);
  const js = entryCode(bundle);
  st.bundleCache.set(bundleKey(route.routePath, platform), js);
  return js;
}

/**
 * The client bundle for a route, built on first hit and coalesced so a burst of requests
 * doesn't spawn duplicate `deno bundle` subprocesses.
 *
 * BLD-M3 — dev/prod bundling divergence (documented, intentional): the dev server bundles
 * each route INDEPENDENTLY and lazily (for fast incremental rebuilds), so the client
 * runtime is inlined per route rather than hoisted into one shared chunk the way the
 * production build's single code-split pass does (see `bundleRoutes` in build.ts). denext
 * only ever loads one route entry per page, so this is latent — but the PRODUCTION build is
 * the source of truth for runtime-singleton behavior. Always verify a release against
 * `denext build` output, not just the dev server.
 */
export async function getRouteBundle(
  st: DevState,
  route: PageRoute,
  platform: Platform = "web",
): Promise<string> {
  if (await isCompat(st)) {
    // Compat client entries are built (into bundleCache) per generation, for web (a
    // next-compat app serves every shell the web target in dev).
    const cached = st.bundleCache.get(route.routePath);
    if (cached) return cached;
    await getManifest(st);
    return st.bundleCache.get(route.routePath) ?? "";
  }
  // Each target's bundle resolves its own platform files, and so is cached apart.
  const key = bundleKey(route.routePath, platform);
  const cached = st.bundleCache.get(key);
  if (cached) return cached;
  const pending = st.routeInFlight.get(key);
  if (pending) return pending;
  const build = buildRouteBundle(st, route, platform);
  st.routeInFlight.set(key, build);
  try {
    return await build;
  } finally {
    st.routeInFlight.delete(key);
  }
}

/**
 * Flight (RSC): one app-wide entry containing only the `"use client"` modules; boundary
 * routes hydrate from it instead of the whole-tree bundle. Compat: the SSR bundles are
 * built by refreshBoundary via ensureCompatBuilt, but the CLIENT flight entry serves
 * unbundled when active (islands on their own @fs URLs, react/npm from the runtime + npm
 * bundle). Native unbundled: each island on its own @fs URL, so editing an island
 * hot-swaps that single module in place — the same per-module HMR as native routes.
 */
export async function getFlightBundle(st: DevState, platform: Platform = "web"): Promise<string> {
  const m = await getManifest(st);
  if (await isCompat(st)) {
    // A next-compat app serves every shell the web target in dev: its server render is the
    // per-generation esbuild bundle, built for web.
    if (st.unbundledActive && st.compatBoundary) {
      return await getUnbundled(st).serveFlightEntry(st.compatBoundary, "web");
    }
    return st.flightBundle ?? "";
  }
  const web = platform === "web";
  const cached = web ? st.flightBundle : st.bundleCache.get(bundleKey(FLIGHT_KEY, platform));
  if (cached) return cached;
  // The target's own islands: its platform files may reach other `"use client"` modules.
  const boundary = web
    ? await buildBoundaryManifest(st.paths.appDir, [
      ...new Set(m.pages.flatMap(routeEntryFiles)),
    ], { exportsOf: importFunctionExports })
    : (await devBoundaryFor(st, platform)).manifest;
  const entry = st.unbundledActive
    ? await getUnbundled(st).serveFlightEntry(boundary, platform)
    : await bundledFlightEntry(st, boundary, platform);
  if (web) st.flightBundle = entry;
  else st.bundleCache.set(bundleKey(FLIGHT_KEY, platform), entry);
  return entry;
}

/** The bundled path's Flight entry for a target (its chunks cached for serving). */
async function bundledFlightEntry(
  st: DevState,
  boundary: BoundaryManifest,
  platform: Platform,
): Promise<string> {
  const bundle = await bundleFlightEntry(boundary, {
    configPath: st.paths.configPath,
    momentumSafeScroll: momentumSafeScrollEnabled(st.paths.config),
    ...await bundleResolution(st, platform),
    dev: true, // emit Fast Refresh registration for client islands
    classRuntime: "eager", // dev installs the class runtime unconditionally
  });
  cacheChunks(st, bundle);
  return entryCode(bundle);
}

/**
 * The `global-error.tsx` hydration bundle, built on demand (this page only appears when an
 * uncaught error escaped rendering, so it is bundled fresh per hit — cheap and always current
 * with the latest edit). Its shared chunks are cached so the entry's basename imports resolve.
 */
export async function getGlobalErrorBundle(
  st: DevState,
  platform: Platform = "web",
): Promise<string> {
  const m = await getManifest(st);
  if (!m.rootGlobalError) return "// no global-error.tsx";
  const target = (await isCompat(st)) ? "web" : platform;
  const bundle = await bundleGlobalError(m.rootGlobalError, {
    configPath: st.paths.configPath,
    momentumSafeScroll: momentumSafeScrollEnabled(st.paths.config),
    ...await bundleResolution(st, target),
    server: (await devBoundaryFor(st, target)).manifest.server,
    dev: true,
  });
  cacheChunks(st, bundle);
  return entryCode(bundle);
}

/**
 * The script a rendered page hydrates from: the Flight entry for boundary routes; the
 * route's unbundled entry module when the unbundled loop owns it (native App Router only
 * — an MDX/unsupported route falls back to the bundled whole-route path); else the bundled
 * route entry.
 */
export function clientEntryFor(st: DevState, route: PageRoute): string {
  if (flightRoutesFor(st, renderPlatform()).has(route.routePath)) return FLIGHT_BUNDLE_PATH;
  if (st.unbundledActive && getUnbundled(st).supportsRoute(route)) {
    return getUnbundled(st).entryUrlFor(route);
  }
  return `${ROUTE_BUNDLE_PATH}?p=${encodeURIComponent(route.routePath)}`;
}

/**
 * Link a per-route stylesheet only when the project has CSS at all; the CSS handler
 * serves the route's extracted subset (possibly empty).
 */
export function styleHrefsFor(st: DevState, route: PageRoute): string[] | undefined {
  return st.cssAssets ? [`${ROUTE_CSS_PATH}?p=${encodeURIComponent(route.routePath)}`] : undefined;
}

/** Middleware runner, rebuilt whenever the generation changes. */
export async function getMiddleware(st: DevState): Promise<MiddlewareRunner> {
  if (!st.paths.middlewarePath) return null;
  if (st.middlewareGen !== st.generation) {
    const mod = await st.load(st.paths.middlewarePath);
    st.middlewareRunner = createMiddlewareRunner(mod as never);
    st.middlewareGen = st.generation;
  }
  return st.middlewareRunner;
}
