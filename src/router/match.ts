// Match a request pathname against a scanned manifest.

import type { ApiRoute, PageRoute, RouteManifest } from "./manifest.ts";
import { matchSegments, type RouteParams } from "./segments.ts";

export interface PageMatch {
  route: PageRoute;
  params: RouteParams;
}

export interface ApiMatch {
  route: ApiRoute;
  params: RouteParams;
}

/** Find the most-specific page route matching `pathname` (manifest is pre-sorted). */
export function matchPage(
  manifest: RouteManifest,
  pathname: string,
): PageMatch | null {
  for (const route of manifest.pages) {
    const params = matchSegments(route.pattern, pathname);
    if (params) return { route, params };
  }
  return null;
}

/** Find the most-specific API route matching `pathname`. */
export function matchApi(
  manifest: RouteManifest,
  pathname: string,
): ApiMatch | null {
  for (const route of manifest.api) {
    const params = matchSegments(route.pattern, pathname);
    if (params) return { route, params };
  }
  return null;
}
