// Production server, stage 1: the build manifest, the Flight boundary, and the
// complete-build check.

import { join } from "@std/path";
import { defaultLoader } from "../../server/mod.ts";
import { timed } from "../../runtime/timing.ts";
import {
  boundaryRefLoader,
  compatModuleMapFromManifest,
  createNextCompatServerLoader,
} from "../next-compat-loader.ts";
import { setSelfHostedFonts } from "../../compat/next/font/registry.ts";
import type { RouteManifest } from "../../router/manifest.ts";
import { tagClientModules } from "../../runtime/client-reference.ts";
import { tagServerModules } from "../../runtime/server-action.ts";
import { FLIGHT_BUNDLE_FILE } from "../build-pipeline/context.ts";
import {
  type BoundaryManifest,
  computeBoundaryRoutes,
  deserializeBoundary,
  type SerializedBoundary,
} from "../module-graph.ts";
import { type ProjectPaths, routeId } from "../paths.ts";
import { appBoundaryManifest } from "../pipeline-shared.ts";

/** What `denext start` reads from `manifest.json` (absent/old fields fall back). */
export interface BuildInfo {
  /**
   * Routes the build determined are static (no client JS): they have no bundle on disk
   * by design, get no hydration <script>, and are skipped by the missing-bundle check.
   */
  staticRoutes: Set<string>;
  /**
   * next-compat: the build rewrote route modules to denext's single React; the
   * source→server-bundle map redirects the SSR loader. The Flight boundary is preserved
   * in compat too (Stage 4b).
   */
  nextCompat: boolean;
  compatModuleMap: Map<string, string>;
  /** Public-env vars to embed: build-detected ∪ config allowlist. Undefined ⇒ ship all. */
  publicEnvKeys: string[] | undefined;
  /** The build's Flight boundary (routes + module manifest), when the manifest recorded it. */
  boundary?: { routes: Set<string>; manifest: BoundaryManifest };
}

/** Read the build manifest; a missing/invalid one means "nothing static, no compat". */
export async function readBuildInfo(paths: ProjectPaths): Promise<BuildInfo> {
  const info: BuildInfo = {
    staticRoutes: new Set(),
    nextCompat: false,
    compatModuleMap: new Map(),
    publicEnvKeys: undefined,
  };
  try {
    const bm = JSON.parse(await Deno.readTextFile(join(paths.outDir, "manifest.json")));
    if (Array.isArray(bm.staticRoutes)) info.staticRoutes = new Set<string>(bm.staticRoutes);
    if (Array.isArray(bm.publicEnvKeys)) {
      info.publicEnvKeys = [...new Set([...bm.publicEnvKeys, ...(paths.config?.publicEnv ?? [])])];
    }
    // Install build-self-hosted Google fonts so renderFontStyles emits local CSS.
    if (bm.fonts && typeof bm.fonts === "object") setSelfHostedFonts(bm.fonts);
    info.nextCompat = bm.nextCompat === true;
    if (bm.boundary && typeof bm.boundary === "object" && Array.isArray(bm.boundaryRoutes)) {
      info.boundary = {
        routes: new Set<string>(bm.boundaryRoutes),
        manifest: deserializeBoundary(bm.boundary as SerializedBoundary, paths.projectDir),
      };
    }
    if (bm.compatServerModules && typeof bm.compatServerModules === "object") {
      info.compatModuleMap = compatModuleMapFromManifest(
        paths.projectDir,
        paths.outDir,
        bm.compatServerModules as Record<string, string>,
      );
    }
  } catch { /* no/invalid build manifest → treat none as static */ }
  return info;
}

/** The Flight boundary computed once at startup. */
export interface FlightBoundary {
  /** Routes that reach a client island. */
  flightRoutes: Set<string>;
  boundary: BoundaryManifest;
}

/**
 * Which routes reach a client island, and the client modules to tag — via the
 * import-graph crawl. The boundary manifest is built unconditionally (not only when a
 * client island exists) so its "use server" modules are discovered even for pure
 * progressive-enhancement pages — routes with a `<form action={serverActionFn}>` but no
 * client island, which are never "flight" routes yet still must render a working action
 * URL. Every discovered "use server" module is registered up front so its exports
 * serialize as action references and dispatch on ANY route.
 *
 * next-compat: the SSR renderer must tag (and render for first paint) the SAME
 * island/action instances the page's react→denext server bundle references — the ones
 * in the shared runtime chunk, NOT the raw npm-React source — so each boundary ref's URL
 * is redirected to its compat server bundle before tagging.
 */
export async function resolveFlightBoundary(
  paths: ProjectPaths,
  manifest: RouteManifest,
  info: BuildInfo,
): Promise<FlightBoundary> {
  // The build already crawled the import graph; reuse its answer when the manifest has it
  // (a large app's crawl is 30 s of startup), else compute it (no/old build manifest).
  const flightRoutes = info.boundary?.routes ?? await timed(
    "computeBoundaryRoutes",
    () => computeBoundaryRoutes(paths.appDir, manifest.pages),
  );
  const boundary = info.boundary?.manifest ?? await timed(
    "appBoundaryManifest",
    () => appBoundaryManifest(paths.appDir, manifest.pages),
  );
  // Tag through the app's loader: in compat mode that resolves each ref to its module inside
  // the single keyed server bundle — the same instances the page bundles reference — so the
  // whole app's islands cost one module load, not one import per island.
  const load = boundaryRefLoader(
    info.nextCompat && info.compatModuleMap.size > 0
      ? createNextCompatServerLoader(defaultLoader, { moduleMap: info.compatModuleMap })
      : defaultLoader,
  );
  await timed("tagServerModules", () => tagServerModules(boundary.server, load));
  // Import + tag the islands now, before the server listens, so the FIRST request doesn't
  // pay for it.
  if (flightRoutes.size > 0) {
    await timed("tagClientModules", () => tagClientModules(boundary.client, load));
  }
  return { flightRoutes, boundary };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail fast on a partial/incomplete build: every non-Flight, non-static page route must
 * have its client entry on disk. Otherwise the page would SSR but silently never hydrate
 * (the browser 404s the missing entry, and the loader swallows it). Flight routes share
 * the app-wide flight.js, checked once.
 */
export async function assertBuildComplete(
  clientDir: string,
  manifest: RouteManifest,
  flightRoutes: Set<string>,
  staticRoutes: Set<string>,
): Promise<void> {
  const missing: string[] = [];
  for (const page of manifest.pages) {
    if (flightRoutes.has(page.routePath) || staticRoutes.has(page.routePath)) continue;
    const entry = join(clientDir, `${routeId(page.routePath)}.js`);
    if (!(await exists(entry))) missing.push(`${page.routePath} -> ${entry}`);
  }
  const flightFile = join(clientDir, FLIGHT_BUNDLE_FILE);
  if (flightRoutes.size > 0 && !(await exists(flightFile))) {
    missing.push(`(flight) -> ${flightFile}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Incomplete build: ${missing.length} client entry file(s) missing. Re-run ` +
        `\`denext build\`.\n  ${missing.join("\n  ")}`,
    );
  }
}
