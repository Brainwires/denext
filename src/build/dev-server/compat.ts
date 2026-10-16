// next-compat (drop-in) mode in dev: detect it once, and per generation rebuild the
// react→denext SSR bundles (for the loader) + client entries (into the bundle caches),
// coalesced so a burst of requests in one generation builds once. Each target whose platform
// files resolve unlike web's (a shell's `?__denext_platform=ios` session) gets a build of its
// own, kept beside web's.

import { FLIGHT_BUNDLE_FILE } from "../build-pipeline/context.ts";
import { type Platform, platformResolution } from "../platform-extensions.ts";
import { fromFileUrl, join } from "@std/path";
import { resolveCacheComponents } from "../../server/config.ts";
import { ensureDir } from "@std/fs";
import type { PageRoute, RouteManifest } from "../../router/manifest.ts";
import type { BoundaryManifest } from "../module-graph.ts";
import {
  domListsEnabled,
  momentumSafeScrollEnabled,
  nodeResolveEnabled,
} from "../../server/config.ts";
import { generateRouteEntry, routeServerModules } from "../bundle.ts";
import {
  buildNextCompatClientEntries,
  buildNextCompatFlightEntry,
  buildNextCompatModules,
} from "../next-compat-build.ts";
import { createNextCompatServerLoader } from "../next-compat-loader.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import { routeNeedsHydration } from "../hydration.ts";
import { routeId } from "../paths.ts";
import { getCss } from "./assets.ts";
import { baseLoaderFor } from "./loaders.ts";
import { bundleKey, type CompatBuild, type DevState, FLIGHT_KEY } from "./state.ts";
import { compatAssets } from "../pipeline-shared.ts";
import { reactNativeCompatOptions } from "../react-native-app-router.ts";
import {
  autoOptimizePackageImports,
  optimizePackageImportsList,
} from "../optimize-package-imports.ts";

/** Whether this project runs as a next-compat drop-in (detected once). */
export function isCompat(st: DevState): Promise<boolean> {
  return st.compatP ??= detectNextCompat(st.paths);
}

/** The shared options every compat esbuild pass takes this generation. */
function compatBuildOptions(
  st: DevState,
  outDir: string,
  platform: Platform,
  cssImportMap?: Record<string, string>,
) {
  return {
    projectDir: st.paths.projectDir,
    configPath: st.paths.configPath,
    outDir,
    classComponents: st.paths.config?.classComponents ?? true,
    resolveAllNodeModules: nodeResolveEnabled(st.paths.config),
    momentumSafeScroll: momentumSafeScrollEnabled(st.paths.config),
    mdxOptions: st.paths.config?.mdx,
    optimizePackageImports: optimizePackageImportsList(st.paths.config),
    autoOptimizePackageImports: autoOptimizePackageImports(st.paths.config),
    domLists: domListsEnabled(st.paths.config),
    useCache: resolveCacheComponents(st.paths.config),
    cssImportMap,
    // The target's platform files (`.web.tsx`, `.ios.tsx`, …), server and client bundles alike.
    appPlatform: platformResolution(st.paths.config, platform),
    // `platform` (denext/platform) folded to the request's target, server and client bundles.
    buildTarget: platform,
    resolveAlias: st.paths.config?.resolveAlias,
    assets: compatAssets(st.paths.projectDir, join(outDir, "client")),
    // React Native mode's resolvers in every compat bundle (none without `reactNative`).
    reactNative: reactNativeCompatOptions(st.paths.config, st.paths.projectDir, true),
  };
}

/**
 * Route server modules + boundary islands + action modules — bundled as separate entries
 * in one code-split pass (islands become chunks, never inlined → the page bundle and the
 * tagged island resolve to one shared instance).
 */
function compatModules(st: DevState, m: RouteManifest, boundary: BoundaryManifest | null) {
  const islands = boundary ? [...boundary.client.values()].map((r) => fromFileUrl(r.url)) : [];
  const servers = boundary ? [...boundary.server.values()].map((r) => fromFileUrl(r.url)) : [];
  const api = m.api.map((r) => r.filePath);
  // middleware.ts too (see compatModuleList): its npm imports need the compat bundle.
  const middleware = st.paths.middlewarePath ? [st.paths.middlewarePath] : [];
  return [
    ...new Set([
      ...m.pages.flatMap(routeServerModules),
      ...api,
      ...islands,
      ...servers,
      ...middleware,
    ]),
  ];
}

/**
 * Non-flight routes that still need interactivity → full-tree hydration entries.
 * Boundary (Flight) routes hydrate only their islands via flight.js.
 */
async function hydratingRoutes(
  m: RouteManifest,
  flightRoutes: ReadonlySet<string>,
): Promise<PageRoute[]> {
  const out: PageRoute[] = [];
  for (const r of m.pages) {
    if (flightRoutes.has(r.routePath)) continue;
    if (await routeNeedsHydration(r)) out.push(r);
  }
  return out;
}

/**
 * Load a target's client outputs into the dev caches: `flight.js` → its Flight bundle, route
 * entries → its route bundles (keyed by target), everything else → shared chunks (named by
 * their content, so two targets' chunks never collide).
 */
async function loadCompatOutputs(
  st: DevState,
  clientOut: string,
  clientRoutes: PageRoute[],
  platform: Platform,
): Promise<void> {
  const idToRoute = new Map(clientRoutes.map((r) => [routeId(r.routePath), r.routePath]));
  for await (const e of Deno.readDir(clientOut)) {
    if (!e.isFile || !e.name.endsWith(".js")) continue;
    const code = await Deno.readTextFile(join(clientOut, e.name));
    storeCompatOutput(st, idToRoute, e.name, code, platform);
  }
}

/** File one compat client output: the Flight entry, a route bundle, or a shared chunk. */
function storeCompatOutput(
  st: DevState,
  idToRoute: Map<string, string>,
  name: string,
  code: string,
  platform: Platform,
): void {
  const base = name.slice(0, -3);
  if (name === FLIGHT_BUNDLE_FILE) {
    if (platform === "web") st.flightBundle = code;
    else st.bundleCache.set(bundleKey(FLIGHT_KEY, platform), code);
    return;
  }
  const rp = idToRoute.get(base);
  if (rp) st.bundleCache.set(bundleKey(rp, platform), code);
  else st.chunkCache.set(name, code);
}

/** What a target's compat build bundles: its Flight boundary this generation. */
export interface CompatBoundary {
  /** The boundary manifest (islands and actions), or null before the first crawl. */
  readonly manifest: BoundaryManifest | null;
  /** The routes that render through Flight (the others hydrate as a whole). */
  readonly routes: ReadonlySet<string>;
}

/**
 * `platform`'s compat build record (created empty on first use).
 *
 * @param st The dev state.
 * @param platform The target (`devBuildTarget`'s in ./platform.ts, so equal targets share one).
 */
export function compatBuildOf(st: DevState, platform: Platform): CompatBuild {
  let build = st.compatBuilds.get(platform);
  if (!build) {
    build = { gen: -1, building: null, load: null, clientDir: null };
    st.compatBuilds.set(platform, build);
  }
  return build;
}

/** A target's build dir for a generation: `<gen>` for web, `<gen>-<target>` for another. */
function compatGenDir(st: DevState, gen: number, platform: Platform): string {
  const name = platform === "web" ? String(gen) : `${gen}-${platform}`;
  return join(st.paths.outDir, "dev-compat", name);
}

/** One generation's compat build for a target: server bundles, client entries, the Flight entry. */
async function buildCompat(
  st: DevState,
  m: RouteManifest,
  platform: Platform,
  boundary: CompatBoundary,
): Promise<void> {
  const build = compatBuildOf(st, platform);
  const prevGen = build.gen;
  const gen = st.generation;
  const outDir = compatGenDir(st, gen, platform);
  const clientOut = join(outDir, "client");
  await ensureDir(clientOut);
  // `build.clientDir` is assigned only once this generation is COMPLETE (below): an asset
  // request racing the rebuild must keep serving the previous generation, never a half-written
  // directory (that was a 404 window for every `/_denext/client/assets/*` during a rebuild).
  // CSS shim map so stylesheet imports (incl. sibling-package `.scss`) redirect to
  // their shims in the esbuild compat bundle. getCss() is current for this generation.
  const opts = compatBuildOptions(st, outDir, platform, (await getCss(st))?.importMap);
  const moduleMap = await buildNextCompatModules({
    ...opts,
    modules: compatModules(st, m, boundary.manifest),
  });
  const clientRoutes = await hydratingRoutes(m, boundary.routes);
  await buildNextCompatClientEntries({
    ...opts,
    clientDir: clientOut,
    server: boundary.manifest?.server,
    entries: clientRoutes.map((r) => ({
      id: routeId(r.routePath),
      source: generateRouteEntry(r, {
        dev: true,
        instrumentationClient: st.paths.instrumentationClientPath,
        classRuntime: "eager",
        usesActivity: true,
        usesViewTransition: true,
        usesIsoIslands: true,
      }),
    })),
  });
  // Compat Flight client bundle (react→denext islands, keyed by client id).
  if (boundary.manifest) {
    await buildNextCompatFlightEntry({
      ...opts,
      clientDir: clientOut,
      boundary: boundary.manifest,
      flightFile: FLIGHT_BUNDLE_FILE,
      dev: true,
      instrumentationClient: st.paths.instrumentationClientPath,
    });
  }
  await loadCompatOutputs(st, clientOut, clientRoutes, platform);
  build.load = createNextCompatServerLoader(baseLoaderFor(st), { moduleMap });
  build.clientDir = clientOut;
  build.gen = gen;
  // The target's previous generation is no longer referenced by anything we serve: reclaim it
  // (best-effort — a browser still holding an old asset URL gets a 404, exactly as before).
  // Another target's builds are its own, and stay.
  if (prevGen !== gen && prevGen !== -1) {
    await Deno.remove(compatGenDir(st, prevGen, platform), { recursive: true }).catch(() => {});
  }
}

/**
 * Per-generation next-compat build for a target, coalesced: a burst of requests in one
 * generation builds once, and one target's build never invalidates another's. Takes the
 * manifest (no `getManifest` re-entry) and the target's boundary.
 *
 * @param st The dev state.
 * @param m This generation's route manifest.
 * @param platform The target (`devBuildTarget`'s in ./platform.ts).
 * @param boundary The target's Flight boundary (web's: `st.compatBoundary` / `st.flightRoutes`).
 */
export function ensureCompatBuilt(
  st: DevState,
  m: RouteManifest,
  platform: Platform = "web",
  boundary: CompatBoundary = { manifest: st.compatBoundary, routes: st.flightRoutes },
): Promise<void> {
  const build = compatBuildOf(st, platform);
  if (build.gen === st.generation && build.load) return Promise.resolve();
  if (build.building) return build.building;
  build.building = buildCompat(st, m, platform, boundary).finally(() => {
    build.building = null;
  });
  return build.building;
}
