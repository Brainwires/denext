// The two DevTools data endpoints the panel's Cache and Routes tabs read.
//
// Both are served from inside `gatedDevEndpoint` (./handler.ts), so they inherit the gate
// EVERY `/_denext/*` endpoint passes first — a cross-origin page, or a foreign Host, gets
// a 403 before this module is reached (cf. CVE-2025-48068). They are dev-only by
// construction: `createDevHandler` is the only thing that mounts them, so a production
// server exposes neither the cache counters nor the app's file layout.
//
// Neither endpoint does any scanning of its own: the cache snapshot is the same public
// `getCacheStats()` a monitoring hook would read, and the route map is matched against the
// dev server's ALREADY-CACHED manifest (`getManifest`), which the watcher invalidates on a
// file add/remove. So polling either one costs nothing but the JSON.

import { getCacheStats } from "../../server/cache.ts";
import { routeMapData } from "../../mcp/inspect.ts";
import { getManifest } from "./manifest.ts";
import type { DevState } from "./state.ts";

/** Both payloads are live snapshots — never let a proxy or the browser keep one. */
const NO_STORE = { "cache-control": "no-store" };

/**
 * The longest `?path=` the route map will probe. Matching is linear in the number of path
 * segments, so a pathological query is clamped rather than walked.
 */
const MAX_PROBE_PATH = 1024;

/**
 * The Cache tab's feed: page-cache hit/miss/set counters plus the recent
 * `revalidateTag`/`revalidatePath` invalidations, exactly as `getCacheStats()` reports them.
 *
 * @param _st The dev-server state (unused — the counters are process-global; the parameter
 * keeps every gated endpoint callable the same way from the handler's switch).
 * @returns A JSON `CacheStats` snapshot.
 */
export function devCacheResponse(_st: DevState): Response {
  return Response.json(getCacheStats(), { headers: NO_STORE });
}

/**
 * Normalize the `?path=` query into a route path to probe: defaults to `/`, is forced to
 * start with a `/`, and is length-clamped.
 *
 * @param url The request URL.
 * @returns The path to map.
 */
function probePath(url: URL): string {
  const raw = (url.searchParams.get("path") ?? "").slice(0, MAX_PROBE_PATH);
  if (raw === "") return "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/**
 * The Routes tab's read: everything that renders at `?path=` — the matched page, its
 * layout/template chains with each module's server/client boundary, its loading/error/…
 * boundaries, its parallel slots, and any API route at the same path.
 *
 * A path that matches nothing is `{ matched: false }` with a 200: "nothing renders here"
 * is an answer, not a failure, and a 404 would be indistinguishable (to the panel's
 * `devFetch`) from a dev server that has no such endpoint at all.
 *
 * @param st The dev-server state (its cached route manifest is what gets matched).
 * @param url The request URL, whose `path` parameter selects what to map.
 * @returns A JSON `RouteMapData`.
 */
export async function devRoutesResponse(st: DevState, url: URL): Promise<Response> {
  const manifest = await getManifest(st);
  const data = routeMapData(manifest, st.paths.appDir, probePath(url));
  return Response.json(data, { headers: NO_STORE });
}
