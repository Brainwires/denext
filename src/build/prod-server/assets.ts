// Production server, stage 2: the client asset URLs a rendered page references.

import { join } from "@std/path";
import type { PageRoute, RouteManifest } from "../../router/manifest.ts";
import { FLIGHT_BUNDLE_FILE } from "../build-pipeline/context.ts";
import { type ProjectPaths, routeId } from "../paths.ts";

export const CLIENT_PREFIX = "/_denext/client/";

/** How the prod server maps a route to its client entry + stylesheet URLs. */
export interface AssetResolvers {
  /** `basePath` (no trailing slash) — client assets may be requested under it. */
  basePath: string;
  clientEntryFor: (route: PageRoute) => string | undefined;
  styleHrefsFor: (route: PageRoute) => string[] | undefined;
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
  const basePath = paths.config?.basePath?.replace(/\/$/, "") || "";
  const assetPrefix = paths.config?.assetPrefix?.replace(/\/$/, "") || basePath;
  const asset = (path: string): string => `${assetPrefix}${path}`;
  const cssRoutes = await cssRoutesOf(clientDir, manifest);
  return {
    basePath,
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
