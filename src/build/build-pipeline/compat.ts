// Production build, stage 3 (next-compat only): react→denext-rewritten SSR bundles for
// every route module, plus the compat Flight and client-route bundles. One prebuilt
// runtime is shared across server + client.

import { fromFileUrl, relative } from "@std/path";
import { nodeResolveEnabled } from "../../server/config.ts";
import { generateRouteEntry, routeServerModules } from "../bundle.ts";
import {
  buildNextCompatClientEntries,
  buildNextCompatFlightEntry,
  buildNextCompatModules,
} from "../next-compat-build.ts";
import { stopNextCompat } from "../next-compat.ts";
import { routeId } from "../paths.ts";
import { type BuildContext, FLIGHT_BUNDLE_FILE, log } from "./context.ts";

/** The options every compat bundling call shares. */
function compatOptions(ctx: BuildContext) {
  const { paths } = ctx;
  return {
    projectDir: ctx.projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify: true as const,
    classComponents: paths.config?.classComponents ?? true,
    resolveAllNodeModules: nodeResolveEnabled(paths.config),
    mdxOptions: paths.config?.mdx,
    cssImportMap: ctx.css?.importMap,
  };
}

/**
 * Bundle the route server modules (page/layout/…) AND every boundary island +
 * server-action module as separate entries in ONE code-split pass. As entries they
 * become their own chunks (never inlined into the page bundle), so a page's reference to
 * an island resolves — through the shared runtime chunk — to the SAME module instance
 * the SSR loader tags as a client reference. That shared identity is what lets the
 * Flight boundary hold across react→denext rewriting.
 */
async function compatServerBundles(ctx: BuildContext): Promise<void> {
  const { boundary, projectDir, paths } = ctx;
  const islandModules = boundary
    ? [...boundary.client.values()].map((r) => fromFileUrl(r.url))
    : [];
  const serverModules = boundary
    ? [...boundary.server.values()].map((r) => fromFileUrl(r.url))
    : [];
  const modules = [
    ...new Set([
      ...ctx.manifest.pages.flatMap(routeServerModules),
      ...islandModules,
      ...serverModules,
    ]),
  ];
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
  });
}

/** Compat client bundles for the interactive (hydrated) routes. */
async function compatClientEntries(ctx: BuildContext): Promise<void> {
  const { clientRoutes } = ctx;
  if (clientRoutes.length === 0) return;
  log(`next-compat: bundling ${clientRoutes.length} client route(s) -> client/`);
  await buildNextCompatClientEntries({
    ...compatOptions(ctx),
    clientDir: ctx.clientDir,
    entries: clientRoutes.map((route) => ({
      id: routeId(route.routePath),
      source: generateRouteEntry(route),
    })),
  });
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
