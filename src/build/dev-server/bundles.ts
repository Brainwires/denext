// On-demand client bundles (per route, and the app-wide Flight entry), the client entry /
// stylesheet URLs a rendered page links, and the per-generation middleware runner.

import type { PageRoute } from "../../router/manifest.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../../server/middleware.ts";
import { bundleFlightEntry, type BundleOutput, bundleRoute, entryCode } from "../bundle.ts";
import { buildBoundaryManifest, importFunctionExports, routeEntryFiles } from "../module-graph.ts";
import { bundleImportMap } from "./assets.ts";
import { isCompat } from "./compat.ts";
import { getManifest, getUnbundled } from "./manifest.ts";
import { type DevState, FLIGHT_BUNDLE_PATH, ROUTE_BUNDLE_PATH, ROUTE_CSS_PATH } from "./state.ts";

/** Stash a bundle's split chunks (everything but the entry) for serving. */
function cacheChunks(st: DevState, bundle: BundleOutput): void {
  for (const [name, code] of bundle.files) {
    if (name !== bundle.entry) st.chunkCache.set(name, code);
  }
}

/** Bundle one route's client entry (native path) and cache it + its chunks. */
async function buildRouteBundle(st: DevState, route: PageRoute): Promise<string> {
  const bundle = await bundleRoute(route, {
    configPath: st.paths.configPath,
    importMap: await bundleImportMap(st),
    dev: true, // emit Fast Refresh registration into the entry
  });
  cacheChunks(st, bundle);
  const js = entryCode(bundle);
  st.bundleCache.set(route.routePath, js);
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
export async function getRouteBundle(st: DevState, route: PageRoute): Promise<string> {
  const cached = st.bundleCache.get(route.routePath);
  if (cached) return cached;
  if (await isCompat(st)) {
    // Compat client entries are built (into bundleCache) per generation.
    await getManifest(st);
    return st.bundleCache.get(route.routePath) ?? "";
  }
  const pending = st.routeInFlight.get(route.routePath);
  if (pending) return pending;
  const build = buildRouteBundle(st, route);
  st.routeInFlight.set(route.routePath, build);
  try {
    return await build;
  } finally {
    st.routeInFlight.delete(route.routePath);
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
export async function getFlightBundle(st: DevState): Promise<string> {
  const m = await getManifest(st);
  if (await isCompat(st)) {
    if (st.unbundledActive && st.compatBoundary) {
      return await getUnbundled(st).serveFlightEntry(st.compatBoundary);
    }
    return st.flightBundle ?? "";
  }
  if (st.flightBundle) return st.flightBundle;
  const boundary = await buildBoundaryManifest(st.paths.appDir, [
    ...new Set(m.pages.flatMap(routeEntryFiles)),
  ], { exportsOf: importFunctionExports });
  if (st.unbundledActive) {
    st.flightBundle = await getUnbundled(st).serveFlightEntry(boundary);
    return st.flightBundle;
  }
  const bundle = await bundleFlightEntry(boundary, {
    configPath: st.paths.configPath,
    importMap: await bundleImportMap(st),
    dev: true, // emit Fast Refresh registration for client islands
  });
  cacheChunks(st, bundle);
  st.flightBundle = entryCode(bundle);
  return st.flightBundle;
}

/**
 * The script a rendered page hydrates from: the Flight entry for boundary routes; the
 * route's unbundled entry module when the unbundled loop owns it (native App Router only
 * — an MDX/unsupported route falls back to the bundled whole-route path); else the bundled
 * route entry.
 */
export function clientEntryFor(st: DevState, route: PageRoute): string {
  if (st.flightRoutes.has(route.routePath)) return FLIGHT_BUNDLE_PATH;
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
