// Production build, stage 2: per-route stylesheets, the static/interactive partition, and
// the native (non-compat) route + Flight client bundles.

import { join } from "@std/path";
import { crawlLocalModules, routeEntryFiles } from "../module-graph.ts";
import {
  appImportsLive,
  bundleFlightEntry,
  bundleRoutes,
  generateGlobalErrorEntry,
  generateRouteEntry,
  routeSourceFiles,
  writeBundleOutput,
} from "../bundle.ts";
import { extractRouteCss, primeCssGraph } from "../css.ts";
import { routeNeedsHydration } from "../hydration.ts";
import { routeId } from "../paths.ts";
import { appBoundaryManifest } from "../pipeline-shared.ts";
import { type BuildContext, FLIGHT_BUNDLE_FILE, GLOBAL_ERROR_BUNDLE_FILE, log } from "./context.ts";

/** Bundle key for the global-error entry — namespaced so it can't collide with any routeId. */
const GLOBAL_ERROR_KEY = "__denext_global_error__";

/** Extract, write, and record every route's stylesheet (flight or not). */
export async function emitRouteCss(ctx: BuildContext): Promise<void> {
  const { css, clientDir } = ctx;
  if (!css) return;
  const pages = ctx.manifest.pages;
  await primeCssGraph([...new Set(pages.flatMap(routeSourceFiles))], css.appConfigPath);
  for (const route of pages) {
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
  if (ctx.compat) return;
  // global-error.tsx gets its own entry (it hydrates the whole document); bundle it in the
  // SAME pass so it shares the hoisted client-runtime chunk. It can exist with no interactive
  // routes, so the pass runs when either is present.
  const globalError = ctx.manifest.rootGlobalError;
  if (clientRoutes.length === 0 && !globalError) return;
  log(
    `bundling ${clientRoutes.length} route(s)${
      globalError ? " + global-error" : ""
    } -> client/ (shared runtime chunk)`,
  );
  const entries = clientRoutes.map((route) => ({
    key: routeId(route.routePath),
    source: generateRouteEntry(
      route,
      false,
      false,
      paths.instrumentationClientPath,
      ctx.usesClassComponents,
    ),
  }));
  if (globalError) {
    entries.push({
      key: GLOBAL_ERROR_KEY,
      source: generateGlobalErrorEntry(globalError, paths.instrumentationClientPath),
    });
  }
  const out = await bundleRoutes(entries, {
    configPath: paths.configPath,
    minify: true,
    importMap: ctx.cssImportMap,
  });
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
  if (globalError) {
    await Deno.writeTextFile(
      join(clientDir, GLOBAL_ERROR_BUNDLE_FILE),
      out.files.get(out.entries.get(GLOBAL_ERROR_KEY)!)!,
    );
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
  ctx.boundary = await appBoundaryManifest(ctx.paths.appDir, ctx.manifest.pages);
  ctx.usesLive = await appImportsLive(ctx.projectDir, await modulesOutsideProject(ctx));
}

/**
 * Local modules the routes reach that live OUTSIDE `projectDir` (a sibling workspace
 * package), so the Live scan sees a `<Live>` component imported from there. Empty when
 * the graph can't be crawled (the scan then covers the project directory alone).
 */
async function modulesOutsideProject(ctx: BuildContext): Promise<string[]> {
  const entries = [...new Set(ctx.manifest.pages.flatMap(routeEntryFiles))];
  try {
    const local = await crawlLocalModules(entries);
    const root = ctx.projectDir.endsWith("/") ? ctx.projectDir : ctx.projectDir + "/";
    return local.filter((f) => !f.startsWith(root));
  } catch {
    return [];
  }
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
    usesClassComponents: ctx.usesClassComponents,
    instrumentationClient: ctx.paths.instrumentationClientPath,
  });
  await writeBundleOutput(ctx.clientDir, flightBundle, FLIGHT_BUNDLE_FILE);
}
