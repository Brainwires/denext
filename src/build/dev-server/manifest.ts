// The route manifest and the Flight boundary, refreshed per generation, plus the
// lazily-created unbundled dev loop.

import { type Platform, platformResolution } from "../platform-extensions.ts";
import { devPlatformImports, devPlatformRedirects } from "./platform.ts";
import { type RouteManifest, scanRoutes } from "../../router/manifest.ts";
import { featureFlags, momentumSafeScrollEnabled } from "../../server/config.ts";
import { applyPlugins } from "../../plugin/mod.ts";
import { tagServerModules } from "../../runtime/server-action.ts";
import { emitTypedModules } from "../emit-typed-modules.ts";
import { withBuildDirLock } from "../project-locks.ts";
import {
  type BoundaryManifest,
  buildBoundaryManifest,
  computeBoundaryRoutes,
  type GraphImportMap,
  importFunctionExports,
  routeEntryFiles,
  withModuleGraphRedirects,
} from "../module-graph.ts";
import { boundaryRefLoader } from "../next-compat-loader.ts";
import { createUnbundledDev, type UnbundledDev } from "../dev-unbundled.ts";
import { getCss, getTransformMaps } from "./assets.ts";
import { ensureCompatBuilt, isCompat } from "./compat.ts";
import { baseLoaderFor } from "./loaders.ts";
import type { DevBoundary, DevState } from "./state.ts";
import { npmBoundaryByImporter } from "../npm-boundary.ts";
import type { NpmBoundaryFinder } from "../module-graph.ts";
import { broadcast } from "./reload.ts";

/** The unbundled dev loop, created on first use (after compat detection settled). */
export function getUnbundled(st: DevState): UnbundledDev {
  return st.unbundled ??= createUnbundledDev({
    projectDir: st.paths.projectDir,
    appDir: st.paths.appDir,
    configPath: st.paths.configPath,
    outDir: st.paths.outDir,
    compat: st.unbundledCompat,
    classComponents: st.paths.config?.classComponents ?? true,
    features: featureFlags(st.paths.config),
    momentumSafeScroll: momentumSafeScrollEnabled(st.paths.config),
    instrumentationClient: st.paths.instrumentationClientPath,
    // Each target's platform files for the app's own modules (`web` unless the page names one).
    // A next-compat app serves every shell the web target: its server render in dev is the
    // per-generation esbuild bundle, built for web, and its islands must match it.
    resolvePlatform: (platform) =>
      platformResolution(st.paths.config, st.unbundledCompat ? "web" : platform),
    // compat: the npm dependency bundle was rebuilt under a live page (its chunks renamed).
    onDepsRebuilt: () => broadcast(st, "reload"),
  });
}

/**
 * Scan the routes (once per generation), registering plugins first so route-synthesizer
 * plugins are in place — a re-scan after an edit re-applies as a no-op. Typed modules
 * (`.denext/routes.ts` + `.denext/api.ts`) are re-emitted FIRE-AND-FORGET: the writes are
 * I/O that must not block the request that triggered the rescan; guarded so it runs once
 * per new manifest.
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
    // Per-rebuild build-dir lock (Cargo's watch model): a concurrent `denext build` writing the
    // same typed modules is waited out, not interleaved.
    void withBuildDirLock(
      st.paths.projectDir,
      () =>
        emitTypedModules(manifest, { outDir: st.paths.outDir, configPath: st.paths.configPath }),
    ).catch((err) => console.warn(`denext: typed modules not refreshed — ${err}`));
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
  // Single-flight: `st.manifest ??= await scan()` reads and writes around the await, so N
  // requests arriving after a rebuild each ran their own scan (and typed-module emit). The
  // `??=` on the PROMISE is atomic.
  let manifest = st.manifest;
  if (!manifest) {
    manifest = st.manifest = await (st.manifestInFlight ??= scanManifest(st).finally(() => {
      st.manifestInFlight = null;
    }));
  }
  await refreshBoundary(st, manifest);
  await getCss(st); // ensure cssAssets is current before styleHrefsFor is read
  await resolveUnbundledMode(st);
  // The scan this request used: a file event during the awaits above clears `st.manifest`
  // for the NEXT request, and must not hand this one null.
  return manifest;
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
  ], { exportsOf: importFunctionExports, npm: await compatNpmFinder(st) });
}

/** In compat mode, the finder for `"use client"` / `"use server"` files inside npm packages. */
async function compatNpmFinder(st: DevState): Promise<NpmBoundaryFinder | undefined> {
  return await isCompat(st) ? npmBoundaryByImporter : undefined;
}

/** Recompute the Flight boundary for this generation (routes, client refs, server refs). */
async function refreshBoundary(st: DevState, m: RouteManifest): Promise<void> {
  if (st.boundaryGen === st.generation) return;
  // Install this generation's platform-file redirects for the crawls below.
  await devPlatformImports(st);
  const routes = await computeBoundaryRoutes(st.paths.appDir, m.pages, {
    npm: await compatNpmFinder(st),
  });
  st.flightRoutes.clear();
  for (const r of routes) st.flightRoutes.add(r);
  st.flightClients.clear();
  st.flightServers.clear();
  const boundary = await scanBoundary(st, m);
  for (const [id, ref] of boundary.client) st.flightClients.set(id, ref);
  for (const [id, ref] of boundary.server) st.flightServers.set(id, ref);
  st.flightBundle = null;
  st.compatBoundary = boundary;
  if (await isCompat(st)) {
    // Build the react→denext compat bundle (routes + islands + actions) and the compat
    // flight client bundle NOW, so the tagging below and the render that follows resolve the
    // SAME island instances the page bundle references (through the compat loader).
    await ensureCompatBuilt(st, m);
  }
  await tagServerModules(boundary.server, boundaryRefLoader(st.compatLoad ?? baseLoaderFor(st)));
  st.boundaryGen = st.generation;
}

/** Whether two redirect maps resolve the same way. */
function sameRedirects(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** The web target's boundary, as {@linkcode refreshBoundary} left it. */
function webBoundary(st: DevState): DevBoundary {
  return {
    routes: st.flightRoutes,
    clients: st.flightClients,
    servers: st.flightServers,
    manifest: st.compatBoundary ?? { client: new Map(), server: new Map() },
  };
}

/**
 * Crawl `platform`'s Flight boundary through its redirects: which routes reach a
 * `"use client"` module, and which modules those are, when its platform files load.
 */
async function scanPlatformBoundary(
  st: DevState,
  m: RouteManifest,
  imports: GraphImportMap,
): Promise<DevBoundary> {
  return await withModuleGraphRedirects(st.paths.configPath, imports, async () => {
    const routes = await computeBoundaryRoutes(st.paths.appDir, m.pages);
    const manifest = await buildBoundaryManifest(st.paths.appDir, [
      ...new Set(m.pages.flatMap(routeEntryFiles)),
    ], { exportsOf: importFunctionExports });
    await tagServerModules(manifest.server, boundaryRefLoader(baseLoaderFor(st)));
    return { routes, clients: manifest.client, servers: manifest.server, manifest };
  });
}

/**
 * The Flight boundary `platform` renders and hydrates with this generation. A target whose
 * platform files resolve like web's shares web's ({@linkcode refreshBoundary}); another gets its
 * own crawl, since a variant may be a `"use client"` module where the plain file is not, or
 * reach other islands. A next-compat app serves every shell the web target in dev, so its
 * boundary is web's.
 *
 * @param st The dev state.
 * @param platform The rendered request's target.
 */
export async function devBoundaryFor(st: DevState, platform: Platform): Promise<DevBoundary> {
  const m = await getManifest(st);
  if (platform === "web" || await isCompat(st)) return webBoundary(st);
  const redirects = await devPlatformRedirects(st, platform);
  if (sameRedirects(redirects, await devPlatformRedirects(st, "web"))) return webBoundary(st);
  const cached = st.platformBoundaries.get(platform);
  if (cached?.gen === st.generation) return await cached.boundary;
  const entry: { gen: number; boundary: Promise<DevBoundary>; value?: DevBoundary } = {
    gen: st.generation,
    boundary: scanPlatformBoundary(st, m, await devPlatformImports(st, platform)),
  };
  st.platformBoundaries.set(platform, entry);
  entry.boundary.then((value) => entry.value = value, () => st.platformBoundaries.delete(platform));
  return await entry.boundary;
}

/**
 * The routes that render through Flight for `platform`, synchronously: its settled boundary
 * ({@linkcode devBoundaryFor} runs before a render links its client entry), else web's.
 *
 * @param st The dev state.
 * @param platform The rendered request's target.
 */
export function flightRoutesFor(st: DevState, platform: Platform): Set<string> {
  if (platform === "web") return st.flightRoutes;
  const cached = st.platformBoundaries.get(platform);
  return cached?.gen === st.generation && cached.value ? cached.value.routes : st.flightRoutes;
}
