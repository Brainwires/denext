// Match a request pathname against a scanned manifest.

import type { ApiRoute, PageRoute, RouteManifest } from "./manifest.ts";
import { matchSegments, type RouteParams } from "./segments.ts";

/** A page route matched against a pathname, with its extracted params. */
export interface PageMatch {
  /** The matched page route from the manifest. */
  route: PageRoute;
  /** Dynamic parameters extracted from the pathname. */
  params: RouteParams;
}

/** An API route matched against a pathname, with its extracted params. */
export interface ApiMatch {
  /** The matched API route from the manifest. */
  route: ApiRoute;
  /** Dynamic parameters extracted from the pathname. */
  params: RouteParams;
}

/** Options controlling how {@linkcode matchPage} treats intercepting routes. */
export interface MatchOptions {
  /**
   * True for a soft (client) navigation. Intercepting routes (`(.)`/`(..)`/
   * `(...)`) are eligible only on soft navigation; a hard load skips them and
   * matches the real route at the same path.
   */
  soft?: boolean;
}

/** Find the most-specific page route matching `pathname` (manifest is pre-sorted). */
export function matchPage(
  manifest: RouteManifest,
  pathname: string,
  options: MatchOptions = {},
): PageMatch | null {
  // On soft navigation, intercepting routes take precedence at the same path.
  if (options.soft) {
    for (const route of manifest.pages) {
      if (!route.intercept) continue;
      const params = matchSegments(route.pattern, pathname);
      if (params) return { route, params };
    }
  }
  for (const route of manifest.pages) {
    if (route.intercept) continue; // intercepts handled above (soft) or skipped (hard)
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
