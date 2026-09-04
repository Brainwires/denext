// Production build, stage 2: per-route stylesheets, the static/interactive partition, and
// the native (non-compat) route + Flight client bundles.

import { join } from "@std/path";
import type { PageRoute } from "../../router/manifest.ts";
import {
  appImportsLive,
  bundleFlightEntry,
  bundleRoutes,
  generateRouteEntry,
  routeSourceFiles,
  writeBundleOutput,
} from "../bundle.ts";
import { extractRouteCss } from "../css.ts";
import { routeNeedsHydration } from "../hydration.ts";
import { buildBoundaryManifest, importFunctionExports, routeEntryFiles } from "../module-graph.ts";
import { routeId } from "../paths.ts";
import { type BuildContext, FLIGHT_BUNDLE_FILE, log } from "./context.ts";

/** Extract, write, and record every route's stylesheet (flight or not). */
export async function emitRouteCss(ctx: BuildContext): Promise<void> {
  const { css, clientDir } = ctx;
  if (!css) return;
  for (const route of ctx.manifest.pages) {
    const text = await extractRouteCss(routeSourceFiles(route), css);
    if (text.trim().length > 0) {
      await Deno.writeTextFile(join(clientDir, `${routeId(route.routePath)}.css`), text);
    }
  }
}

/**
 * Partition non-Flight routes: a route with no interactivity anywhere in its tree ships
 * ZERO client JavaScript (pure server-rendered HTML); the rest get a hydration bundle.
 * Boundary (Flight) routes are handled by the Flight stages.
 */
export async function partitionRoutes(ctx: BuildContext): Promise<void> {
  for (const route of ctx.manifest.pages) {
    if (ctx.flightRoutes.has(route.routePath)) continue;
    if (await routeNeedsHydration(route)) ctx.clientRoutes.push(route);
    else ctx.staticRoutes.push(route.routePath);
  }
  const n = ctx.staticRoutes.length;
  if (n > 0) log(`${n} static route(s) ship no client JS: ${ctx.staticRoutes.join(", ")}`);
}

/**
 * Bundle all interactive routes in ONE code-split pass so the client runtime (imported
 * by every route entry) is hoisted into a single shared chunk — downloaded once and
 * cached across client navigations — instead of being inlined into each route's entry.
 * Compat builds its own client entries; see `./compat.ts`.
 */
export async function bundleNativeRoutes(ctx: BuildContext): Promise<void> {
  const { clientRoutes, clientDir, paths } = ctx;
  if (ctx.compat || clientRoutes.length === 0) return;
  log(`bundling ${clientRoutes.length} route(s) -> client/ (shared runtime chunk)`);
  const out = await bundleRoutes(
    clientRoutes.map((route) => ({
      key: routeId(route.routePath),
      source: generateRouteEntry(route),
    })),
    { configPath: paths.configPath, minify: true, importMap: ctx.cssImportMap },
  );
  // Write shared + island chunks under their own (content-hashed) basenames; identical
  // chunks across routes collapse to one file.
  const entryBases = new Set(out.entries.values());
  for (const [name, code] of out.files) {
    if (!entryBases.has(name)) await Deno.writeTextFile(join(clientDir, name), code);
  }
  // Write each route's entry as `${id}.js`. Its chunk imports are by basename, so
  // renaming the entry file leaves them resolving correctly.
  for (const route of clientRoutes) {
    const id = routeId(route.routePath);
    const file = `${id}.js`;
    await Deno.writeTextFile(join(clientDir, file), out.files.get(out.entries.get(id)!)!);
    ctx.routes.push({ routePath: route.routePath, bundle: file });
  }
}

/**
 * The app-wide boundary manifest (client islands + server-action modules), computed once
 * and shared by the native Flight bundle AND the compat pipeline. Crawls from every
 * route's full server tree (page + layouts + templates + slots), not just page files, so
 * a client island imported only by a layout is found (H1). Also decides whether the
 * Flight entry bundles the Live WebSocket transport (a build-time `denext/live`
 * specifier scan) — a Flight app that never uses a live feature ships none of it.
 */
export async function computeBoundary(ctx: BuildContext): Promise<void> {
  if (!ctx.hasFlight) return;
  const pages: PageRoute[] = ctx.manifest.pages;
  ctx.boundary = await buildBoundaryManifest(
    ctx.paths.appDir,
    [...new Set(pages.flatMap(routeEntryFiles))],
    { exportsOf: importFunctionExports },
  );
  ctx.usesLive = await appImportsLive(ctx.projectDir);
}

/**
 * Native Flight bundle: only the app's `"use client"` modules, with `"use server"`
 * modules redirected to stubs (server code stripped). Compat builds its own
 * react→denext-rewritten flight bundle (`./compat.ts`).
 */
export async function bundleNativeFlight(ctx: BuildContext): Promise<void> {
  if (!ctx.hasFlight || ctx.compat) return;
  log(`bundling Flight islands -> client/${FLIGHT_BUNDLE_FILE}`);
  const flightBundle = await bundleFlightEntry(ctx.boundary!, {
    configPath: ctx.paths.configPath,
    minify: true,
    importMap: ctx.cssImportMap,
    usesLive: ctx.usesLive,
  });
  await writeBundleOutput(ctx.clientDir, flightBundle, FLIGHT_BUNDLE_FILE);
}
