// next-compat (drop-in) mode in dev: detect it once, and per generation rebuild the
// react→denext SSR bundles (for the loader) + client entries (into the bundle caches),
// coalesced so a burst of requests in one generation builds once.

import { fromFileUrl, join } from "@std/path";
import { ensureDir } from "@std/fs";
import type { PageRoute, RouteManifest } from "../../router/manifest.ts";
import { nodeResolveEnabled } from "../../server/config.ts";
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
import type { DevState } from "./state.ts";

/** Whether this project runs as a next-compat drop-in (detected once). */
export function isCompat(st: DevState): Promise<boolean> {
  return st.compatP ??= detectNextCompat(st.paths);
}

/** The shared options every compat esbuild pass takes this generation. */
function compatBuildOptions(st: DevState, outDir: string, cssImportMap?: Record<string, string>) {
  return {
    projectDir: st.paths.projectDir,
    configPath: st.paths.configPath,
    outDir,
    classComponents: st.paths.config?.classComponents ?? true,
    resolveAllNodeModules: nodeResolveEnabled(st.paths.config),
    mdxOptions: st.paths.config?.mdx,
    cssImportMap,
  };
}

/**
 * Route server modules + boundary islands + action modules — bundled as separate entries
 * in one code-split pass (islands become chunks, never inlined → the page bundle and the
 * tagged island resolve to one shared instance).
 */
function compatModules(st: DevState, m: RouteManifest): string[] {
  const islands = st.compatBoundary
    ? [...st.compatBoundary.client.values()].map((r) => fromFileUrl(r.url))
    : [];
  const servers = st.compatBoundary
    ? [...st.compatBoundary.server.values()].map((r) => fromFileUrl(r.url))
    : [];
  return [...new Set([...m.pages.flatMap(routeServerModules), ...islands, ...servers])];
}

/**
 * Non-flight routes that still need interactivity → full-tree hydration entries.
 * Boundary (Flight) routes hydrate only their islands via flight.js.
 */
async function hydratingRoutes(st: DevState, m: RouteManifest): Promise<PageRoute[]> {
  const out: PageRoute[] = [];
  for (const r of m.pages) {
    if (st.flightRoutes.has(r.routePath)) continue;
    if (await routeNeedsHydration(r)) out.push(r);
  }
  return out;
}

/**
 * Load the client outputs into the dev caches: `flight.js` → the flight bundle, route
 * entries → their route, everything else → shared chunks.
 */
async function loadCompatOutputs(
  st: DevState,
  clientOut: string,
  clientRoutes: PageRoute[],
): Promise<void> {
  const idToRoute = new Map(clientRoutes.map((r) => [routeId(r.routePath), r.routePath]));
  for await (const e of Deno.readDir(clientOut)) {
    if (!e.isFile || !e.name.endsWith(".js")) continue;
    const code = await Deno.readTextFile(join(clientOut, e.name));
    const base = e.name.slice(0, -3);
    if (base === "flight") {
      st.flightBundle = code;
      continue;
    }
    const rp = idToRoute.get(base);
    if (rp) st.bundleCache.set(rp, code);
    else st.chunkCache.set(e.name, code);
  }
}

/** One generation's compat build: server bundles, client entries, the compat Flight entry. */
async function buildCompat(st: DevState, m: RouteManifest): Promise<void> {
  const outDir = join(st.paths.outDir, "dev-compat", String(st.generation));
  const clientOut = join(outDir, "client");
  await ensureDir(clientOut);
  // CSS shim map so stylesheet imports (incl. sibling-package `.scss`) redirect to
  // their shims in the esbuild compat bundle. getCss() is current for this generation.
  const opts = compatBuildOptions(st, outDir, (await getCss(st))?.importMap);
  const moduleMap = await buildNextCompatModules({ ...opts, modules: compatModules(st, m) });
  st.compatModuleMap = moduleMap;
  const clientRoutes = await hydratingRoutes(st, m);
  await buildNextCompatClientEntries({
    ...opts,
    clientDir: clientOut,
    entries: clientRoutes.map((r) => ({
      id: routeId(r.routePath),
      source: generateRouteEntry(r, true),
    })),
  });
  // Compat Flight client bundle (react→denext islands, keyed by client id).
  if (st.compatBoundary) {
    await buildNextCompatFlightEntry({
      ...opts,
      clientDir: clientOut,
      boundary: st.compatBoundary,
      flightFile: "flight.js",
      dev: true,
    });
  }
  await loadCompatOutputs(st, clientOut, clientRoutes);
  st.compatLoad = createNextCompatServerLoader(baseLoaderFor(st), { moduleMap });
  st.compatBuiltGen = st.generation;
}

/**
 * Per-generation next-compat build, coalesced: a burst of requests in one generation
 * builds once. Takes the manifest (no `getManifest` re-entry).
 */
export function ensureCompatBuilt(st: DevState, m: RouteManifest): Promise<void> {
  if (st.compatBuiltGen === st.generation && st.compatLoad) return Promise.resolve();
  if (st.compatBuilding) return st.compatBuilding;
  st.compatBuilding = buildCompat(st, m).finally(() => {
    st.compatBuilding = null;
  });
  return st.compatBuilding;
}
