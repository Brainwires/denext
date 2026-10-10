// Production server, stage 2: the client asset URLs a rendered page references.

import { join } from "@std/path";
import type { PageRoute, RouteManifest } from "../../router/manifest.ts";
import { FLIGHT_BUNDLE_FILE, GLOBAL_ERROR_BUNDLE_FILE } from "../build-pipeline/context.ts";
import { type ProjectPaths, routeId } from "../paths.ts";
import { FLIGHT_BOOT_FILE, hasFlightBoot } from "../flight-boot.ts";

export const CLIENT_PREFIX = "/_denext/client/";

/** How the prod server maps a route to its client entry + stylesheet URLs. */
export interface AssetResolvers {
  /** `basePath` (no trailing slash) — client assets may be requested under it. */
  basePath: string;
  clientEntryFor: (route: PageRoute) => string | undefined;
  styleHrefsFor: (route: PageRoute) => string[] | undefined;
  /** The `global-error.tsx` hydration bundle URL, when the build emitted one. */
  globalErrorEntry?: string;
  /** The Flight entry's deferred boot URL, when the build emitted one (build/flight-boot.ts). */
  flightBootEntry?: string;
}

/** Whether `denext build` wrote the global-error hydration bundle. */
async function hasGlobalErrorBundle(clientDir: string): Promise<boolean> {
  try {
    await Deno.stat(join(clientDir, GLOBAL_ERROR_BUNDLE_FILE));
    return true;
  } catch {
    return false;
  }
}

/** Routes with an extracted stylesheet on disk (written by `denext build`). */
async function cssRoutesOf(clientDir: string, manifest: RouteManifest): Promise<Set<string>> {
  const cssRoutes = new Set<string>();
  for (const route of manifest.pages) {
    try {
      await Deno.stat(join(clientDir, `${routeId(route.routePath)}.css`));
      cssRoutes.add(route.routePath);
    } catch { /* no stylesheet for this route */ }
  }
  return cssRoutes;
}

/**
 * The app's `basePath` and the prefix its client asset URLs carry: the `assetPrefix` (a CDN
 * origin) when set, else the `basePath`. Both without a trailing slash, `""` when unset. Shared
 * by the production server and `denext export`, so the two reference assets alike.
 *
 * @param config The app's `denext.config` (or none).
 * @returns `basePath` and `assetBase`.
 */
export function assetUrlBase(
  config: { basePath?: string; assetPrefix?: string } | null | undefined,
): { basePath: string; assetBase: string } {
  const basePath = config?.basePath?.replace(/\/$/, "") || "";
  return { basePath, assetBase: config?.assetPrefix?.replace(/\/$/, "") || basePath };
}

/**
 * Asset URLs carry the assetPrefix (CDN origin) or basePath so the browser requests them
 * at the right place; `assetPrefix` wins when both are set. A static route gets no client
 * entry; a Flight route shares the app-wide flight bundle.
 */
export async function assetResolvers(
  paths: ProjectPaths,
  clientDir: string,
  manifest: RouteManifest,
  flightRoutes: Set<string>,
  staticRoutes: Set<string>,
): Promise<AssetResolvers> {
  const { basePath, assetBase } = assetUrlBase(paths.config);
  const asset = (path: string): string => `${assetBase}${path}`;
  const cssRoutes = await cssRoutesOf(clientDir, manifest);
  const globalErrorEntry = (await hasGlobalErrorBundle(clientDir))
    ? asset(`${CLIENT_PREFIX}${GLOBAL_ERROR_BUNDLE_FILE}`)
    : undefined;
  return {
    basePath,
    globalErrorEntry,
    flightBootEntry: flightRoutes.size > 0 && await hasFlightBoot(clientDir)
      ? asset(`${CLIENT_PREFIX}${FLIGHT_BOOT_FILE}`)
      : undefined,
    clientEntryFor: (route) =>
      staticRoutes.has(route.routePath) ? undefined : asset(
        flightRoutes.has(route.routePath)
          ? `${CLIENT_PREFIX}${FLIGHT_BUNDLE_FILE}`
          : `${CLIENT_PREFIX}${routeId(route.routePath)}.js`,
      ),
    styleHrefsFor: (route) =>
      cssRoutes.has(route.routePath)
        ? [asset(`${CLIENT_PREFIX}${routeId(route.routePath)}.css`)]
        : undefined,
  };
}
