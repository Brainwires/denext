// The route manifest and the Flight boundary, refreshed per generation, plus the
// lazily-created unbundled dev loop.

import { type RouteManifest, scanRoutes } from "../../router/manifest.ts";
import { applyPlugins } from "../../plugin/mod.ts";
import { tagServerModules } from "../../runtime/server-action.ts";
import { emitTypedModules } from "../emit-typed-modules.ts";
import {
  type BoundaryManifest,
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "../module-graph.ts";
import { redirectBoundaryToCompat } from "../next-compat-loader.ts";
import { createUnbundledDev, type UnbundledDev } from "../dev-unbundled.ts";
import { getCss, getTransformMaps } from "./assets.ts";
import { ensureCompatBuilt, isCompat } from "./compat.ts";
import type { DevState } from "./state.ts";

/** The unbundled dev loop, created on first use (after compat detection settled). */
export function getUnbundled(st: DevState): UnbundledDev {
  return st.unbundled ??= createUnbundledDev({
    projectDir: st.paths.projectDir,
    appDir: st.paths.appDir,
    configPath: st.paths.configPath,
    outDir: st.paths.outDir,
    compat: st.unbundledCompat,
    classComponents: st.paths.config?.classComponents ?? true,
  });
}

/**
 * Scan the routes (once per generation), registering plugins first so route-synthesizer
 * plugins are in place — a re-scan after an edit re-applies as a no-op. Typed modules
 * (`.denext/routes.ts` + `.denext/api.ts`) are re-emitted FIRE-AND-FORGET: generating
 * api.ts spawns a `deno doc` per API route, which must not block the request that
 * triggered the rescan; guarded so it runs once per new manifest.
 */
async function scanManifest(st: DevState): Promise<RouteManifest> {
  await applyPlugins({
    projectRoot: st.paths.projectDir,
    appDir: st.paths.appDir,
    config: st.paths.config ?? {},
    mode: "dev",
    load: st.load,
  });
  const manifest = await scanRoutes(st.paths.appDir);
  if (manifest !== st.lastEmittedManifest) {
    st.lastEmittedManifest = manifest;
    void emitTypedModules(manifest, { outDir: st.paths.outDir, configPath: st.paths.configPath })
      .catch(() => {});
  }
  return manifest;
}

/**
 * Resolve whether the unbundled dev loop applies now that compat detection has settled.
 * Works for BOTH native App Router and next-compat (the latter serves react/npm from a
 * pre-bundled runtime + on-demand npm bundle — see createUnbundledDev `compat`). Gated
 * only when a build-time module rewrite is active: the auto-memo compiler and the
 * resumability qrl-handler extraction redirect specific module URLs to transformed
 * builds via the bundled client import map, which the unbundled per-module serve does
 * not apply — so those keep the bundled path (correctness over speed).
 */
async function resolveUnbundledMode(st: DevState): Promise<void> {
  st.unbundledCompat = await isCompat(st);
  const transformMaps = await getTransformMaps(st);
  st.unbundledActive = st.unbundledOptIn && Object.keys(transformMaps).length === 0;
}

/** The current route manifest, with the boundary, CSS and dev-loop mode brought up to date. */
export async function getManifest(st: DevState): Promise<RouteManifest> {
  st.manifest ??= await scanManifest(st);
  await refreshBoundary(st, st.manifest);
  await getCss(st); // ensure cssAssets is current before styleHrefsFor is read
  await resolveUnbundledMode(st);
  return st.manifest;
}

/**
 * The boundary manifest is built unconditionally (not only when a client island exists)
 * so "use server" modules are discovered — and registered up front — even for pure
 * progressive-enhancement pages: a `<form action={fn}>` with no client island is never a
 * "flight" route yet must still render a working action URL and dispatch.
 */
async function scanBoundary(st: DevState, m: RouteManifest): Promise<BoundaryManifest> {
  return await buildBoundaryManifest(st.paths.appDir, [
    ...new Set(m.pages.flatMap(routeEntryFiles)),
  ], { exportsOf: importFunctionExports });
}

/** Recompute the Flight boundary for this generation (routes, client refs, server refs). */
async function refreshBoundary(st: DevState, m: RouteManifest): Promise<void> {
  if (st.boundaryGen === st.generation) return;
  const routes = await computeBoundaryRoutes(st.paths.appDir, m.pages);
  st.flightRoutes.clear();
  for (const r of routes) st.flightRoutes.add(r);
  st.flightClients.clear();
  st.flightServers.clear();
  const boundary = await scanBoundary(st, m);
  for (const [id, ref] of boundary.client) st.flightClients.set(id, ref);
  for (const [id, ref] of boundary.server) st.flightServers.set(id, ref);
  await tagServerModules(boundary.server);
  st.flightBundle = null;
  st.compatBoundary = boundary;
  if (await isCompat(st)) {
    // Build the react→denext compat bundles (routes + islands + actions) and the compat
    // flight client bundle NOW, then redirect the boundary refs to the shared-chunk
    // instances — so the render that follows tags the SAME islands the page bundle
    // references. Done here (before any render's tagging) so identity holds.
    await ensureCompatBuilt(st, m);
    redirectBoundaryToCompat(boundary, st.compatModuleMap);
  }
  st.boundaryGen = st.generation;
}
