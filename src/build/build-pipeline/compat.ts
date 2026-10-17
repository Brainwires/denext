// Production build, stage 3 (next-compat only): react→denext-rewritten SSR bundles for
// every route module, plus the compat Flight and client-route bundles. One prebuilt
// runtime is shared across server + client.

import { relative } from "@std/path";
import { generateRouteEntry } from "../bundle.ts";
import {
  buildNextCompatClientEntries,
  buildNextCompatFlightEntry,
  buildNextCompatModules,
} from "../next-compat-build.ts";
import { stopNextCompat } from "../next-compat.ts";
import { routeId } from "../paths.ts";
import {
  compatBuildOptions,
  compatGlobalErrorEntry,
  compatModuleList,
  finishCompatGlobalErrorEntry,
} from "../pipeline-shared.ts";
import { writeFlightBoot } from "../flight-boot.ts";
import { assertNoReservedRouteIds, type BuildContext, FLIGHT_BUNDLE_FILE, log } from "./context.ts";

/** The options every compat bundling call shares. */
function compatOptions(ctx: BuildContext) {
  return compatBuildOptions(ctx.projectDir, ctx.paths, ctx.css?.importMap, ctx.clientDir);
}

/**
 * Bundle the route server modules (page/layout/…) AND every boundary island +
 * server-action module (an app with no island has its action modules too) as separate
 * entries in ONE code-split pass. As entries they
 * become their own chunks (never inlined into the page bundle), so a page's reference to
 * an island resolves — through the shared runtime chunk — to the SAME module instance
 * the SSR loader tags as a client reference. That shared identity is what lets the
 * Flight boundary hold across react→denext rewriting.
 */
async function compatServerBundles(ctx: BuildContext): Promise<void> {
  const { projectDir, paths } = ctx;
  // The crawl's boundary when no route reaches a client island: its `"use server"` modules
  // must still be entries, or a page inlines its own copy of the action module and the copy
  // the server tags (loaded from source) is another instance: `<form action={fn}>` then
  // renders with no action URL, and a module importing `next/*` fails to load at startup.
  const modules = compatModuleList(
    ctx.manifest.pages,
    ctx.boundary ?? ctx.crawledBoundary,
    ctx.manifest.api,
    paths.middlewarePath,
    ctx.manifest.rootGlobalError,
  );
  log(`next-compat: bundling ${modules.length} server module(s) -> server/`);
  const moduleMap = await buildNextCompatModules({ ...compatOptions(ctx), modules });
  for (const [absSrc, absBundle] of moduleMap) {
    ctx.compatServerModules[relative(projectDir, absSrc)] = relative(paths.outDir, absBundle);
  }
}

/**
 * Compat Flight bundle: react→denext-rewritten `"use client"` islands, keyed by the same
 * client ids the server tags — so boundary routes hydrate only their islands.
 */
async function compatFlight(ctx: BuildContext): Promise<void> {
  if (!ctx.boundary) return;
  log(`next-compat: bundling Flight islands -> client/${FLIGHT_BUNDLE_FILE}`);
  await buildNextCompatFlightEntry({
    ...compatOptions(ctx),
    clientDir: ctx.clientDir,
    boundary: ctx.boundary,
    flightFile: FLIGHT_BUNDLE_FILE,
    usesLive: ctx.usesLive,
    usesLiveView: ctx.usesLiveView,
    classRuntime: ctx.classRuntime,
    usesActivity: ctx.usesActivity,
    usesViewTransition: ctx.usesViewTransition,
    usesSingletons: ctx.usesSingletons,
    instrumentationClient: ctx.paths.instrumentationClientPath,
  });
  // The deferred boot a page of deferred islands loads instead (build/flight-boot.ts).
  await writeFlightBoot(ctx.clientDir, ctx.paths.instrumentationClientPath);
}

/**
 * Compat client bundles for the interactive (hydrated) routes, plus the `global-error.tsx`
 * hydration entry in the SAME pass (so it shares the runtime chunk), as the native build does.
 */
async function compatClientEntries(ctx: BuildContext): Promise<void> {
  const { clientRoutes } = ctx;
  const globalError = ctx.manifest.rootGlobalError;
  if (clientRoutes.length === 0 && !globalError) return;
  log(
    `next-compat: bundling ${clientRoutes.length} client route(s)${
      globalError ? " + global-error" : ""
    } -> client/`,
  );
  assertNoReservedRouteIds(clientRoutes.map((r) => r.routePath), routeId);
  const entries = clientRoutes.map((route) => ({
    id: routeId(route.routePath),
    source: generateRouteEntry(route, {
      instrumentationClient: ctx.paths.instrumentationClientPath,
      classRuntime: ctx.classRuntime,
      usesActivity: ctx.usesActivity,
      usesViewTransition: ctx.usesViewTransition,
      usesIsoIslands: ctx.usesIsoIslands,
      usesSingletons: ctx.usesSingletons,
    }),
  }));
  if (globalError) {
    entries.push(compatGlobalErrorEntry(globalError, ctx.paths.instrumentationClientPath));
  }
  await buildNextCompatClientEntries({
    ...compatOptions(ctx),
    clientDir: ctx.clientDir,
    // A hydrated route's own imports of an action get its stub, as the Flight bundle's do.
    server: ctx.serverModules,
    entries,
  });
  if (globalError) await finishCompatGlobalErrorEntry(ctx.clientDir);
  for (const route of clientRoutes) {
    ctx.routes.push({ routePath: route.routePath, bundle: `${routeId(route.routePath)}.js` });
  }
}

/** The whole next-compat build (no-op outside compat mode). */
export async function buildCompat(ctx: BuildContext): Promise<void> {
  if (!ctx.compat) return;
  await compatServerBundles(ctx);
  await compatFlight(ctx);
  await compatClientEntries(ctx);
  await stopNextCompat();
}
