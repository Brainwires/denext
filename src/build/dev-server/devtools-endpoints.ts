// The two DevTools data endpoints the panel's Cache and Routes tabs read.
//
// Both are served from inside `gatedDevEndpoint` (./handler.ts), so they inherit the gate
// EVERY `/_denext/*` endpoint passes first — a cross-origin page, or a foreign Host, gets
// a 403 before this module is reached (cf. CVE-2025-48068). They are dev-only by
// construction: `createDevHandler` is the only thing that mounts them, so a production
// server exposes neither the cache counters nor the app's file layout.
//
// The third endpoint here is the DevTools → MCP bridge: the in-page inspector POSTs its
// component tree to `/_denext/dev-inspect` and the MCP tools GET it back. It is the one
// dev endpoint that STORES browser-supplied structured data, so it is method-, type- and
// size-checked, and what it keeps is REBUILT from coerced, clamped fields
// (./devtools-snapshot.ts) rather than stored as posted. It keeps at most one snapshot per
// page URL across an 8-URL LRU, for at most `INSPECT_TTL_MS`, and a read from a page (one
// with a `Referer`) sees only that page's own snapshot.
//
// The read side also carries the sink's arming switch: a page walks its fiber tree only
// once a real read has happened here, and asks with a cheap `?probe=1` GET.
//
// Neither read endpoint does any scanning of its own: the cache snapshot is the same public
// `getCacheStats()` a monitoring hook would read, and the route map is matched against the
// dev server's ALREADY-CACHED manifest (`getManifest`), which the watcher invalidates on a
// file add/remove. So polling either one costs nothing but the JSON.

import { getCacheStats } from "../../server/cache.ts";
import { routeMapData } from "../../mcp/inspect.ts";
import { getManifest } from "./manifest.ts";
import {
  type DevState,
  INSPECT_TTL_MS,
  type InspectSnapshotEntry,
  MAX_INSPECT_URLS,
} from "./state.ts";
import { parseSnapshot } from "./devtools-snapshot.ts";
import type { InspectSnapshot } from "../../client/devtools-inspect-sink.ts";

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

// ---- The MCP bridge: the in-page inspector's snapshot sink + read ----------------------

/**
 * The largest snapshot body accepted (matching the cap the page's sink posts under).
 * Anything larger is refused with a 413 rather than buffered.
 */
const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** A JSON body read, capped: the text, or null when it ran past `max` bytes. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The media type of a `content-type` header — lower-cased, without its parameters.
 * Matched EXACTLY against `application/json`: a substring test would accept
 * `text/html; x=application/json`, and this endpoint stores what it is given.
 *
 * @param header The raw header value (or null when absent).
 * @returns The bare media type, e.g. `application/json`.
 */
function mediaType(header: string | null): string {
  return (header ?? "").split(";")[0].trim().toLowerCase();
}

/** Store `snapshot` as its URL's latest, evicting the oldest URL past the LRU's size. */
function storeSnapshot(st: DevState, snapshot: InspectSnapshot): void {
  st.devInspect.delete(snapshot.url); // re-insert so Map order stays write-recency order
  st.devInspect.set(snapshot.url, { snapshot, receivedAt: Date.now() });
  while (st.devInspect.size > MAX_INSPECT_URLS) {
    const oldest = st.devInspect.keys().next().value;
    if (oldest === undefined) break;
    st.devInspect.delete(oldest);
  }
}

/**
 * `POST /_denext/dev-inspect` — the in-page DevTools sink: record this page's latest
 * component tree so the MCP bridge can read it out-of-process.
 *
 * POST + exactly `application/json` only (405/415 otherwise), body capped at 256 KB (413),
 * and a body that does not parse as a snapshot is DROPPED with a 204 — a dev page must
 * never be taught to log server errors by posting junk. What IS stored is rebuilt field by
 * field by {@link parseSnapshot}, never the posted object.
 *
 * @param st The dev-server state (its {@link DevState.devInspect} LRU is written).
 * @param request The POST request.
 * @returns 204 on accept-or-drop, 415/413 when the request itself is refused.
 */
export async function devInspectSink(st: DevState, request: Request): Promise<Response> {
  if (mediaType(request.headers.get("content-type")) !== "application/json") {
    return new Response("expected application/json", { status: 415, headers: NO_STORE });
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SNAPSHOT_BYTES) {
    return new Response("snapshot too large", { status: 413, headers: NO_STORE });
  }
  const body = await readCapped(request, MAX_SNAPSHOT_BYTES);
  if (body === null) {
    return new Response("snapshot too large", { status: 413, headers: NO_STORE });
  }
  const snapshot = parseSnapshot(body);
  if (snapshot) storeSnapshot(st, snapshot);
  return new Response(null, { status: 204, headers: NO_STORE });
}

/** Drop every snapshot older than the TTL — a dev page's state is not kept forever. */
function evictStale(st: DevState, now: number): void {
  for (const [url, entry] of [...st.devInspect]) {
    if (now - entry.receivedAt > INSPECT_TTL_MS) st.devInspect.delete(url);
  }
}

/** The stored entry for `want` (exact URL, else the newest with that path), or the newest. */
function pickEntry(st: DevState, want: string | null): InspectSnapshotEntry | undefined {
  evictStale(st, Date.now());
  if (want === null) {
    let newest: InspectSnapshotEntry | undefined;
    for (const entry of st.devInspect.values()) newest = entry; // insertion = write recency
    return newest;
  }
  const exact = st.devInspect.get(want);
  if (exact) return exact;
  let byPath: InspectSnapshotEntry | undefined;
  for (const [url, entry] of st.devInspect) {
    if (url.split("?")[0] === want) byPath = entry;
  }
  return byPath;
}

/**
 * Which page's snapshot this GET may see.
 *
 * An explicit `?url=` selects one (the MCP bridge always passes it). WITHOUT it, a caller
 * that is a PAGE — it carries a `Referer` — is scoped to its own path: a dev page must not
 * be able to read the hook state of another route the developer happens to have open, so
 * `/blog/<untrusted>` cannot read `/login`'s tree. A caller with no `Referer` is an
 * out-of-process reader (the MCP bridge, curl) and gets the most recent snapshot.
 *
 * @param url The request URL.
 * @param request The request (read for `Referer`), when the caller has one.
 * @returns The page URL to select, or null for "the most recent".
 */
function readScope(url: URL, request?: Request): string | null {
  const want = url.searchParams.get("url");
  if (want !== null) return want;
  const referer = request?.headers.get("referer");
  if (!referer) return null;
  try {
    const ref = new URL(referer);
    return ref.pathname + ref.search;
  } catch {
    return ""; // an unparseable Referer selects nothing (and matches nothing)
  }
}

/**
 * `GET /_denext/dev-inspect` — read back the latest snapshot the page posted, for the MCP
 * component/why-render/hook tools.
 *
 * `?probe=1` is the page's lazy-arming probe: it answers `{ armed }` and reads nothing.
 * Any OTHER GET is a real read, and arms the sink for the dev server's lifetime — that is
 * what tells pages to start walking their fiber trees at all (see `installInspectSink`).
 *
 * Selection is {@link readScope}'s; `ageMs` is measured on the SERVER clock, so a skewed
 * page clock cannot make a stale tree look fresh, and a snapshot older than
 * {@link INSPECT_TTL_MS} is gone.
 *
 * @param st The dev-server state.
 * @param url The request URL (its `url` / `probe` parameters).
 * @param request The request, when the caller has one (read for `Referer` scoping).
 * @returns `{ snapshot, ageMs }`, `{ armed }` for a probe, or a 404 `{ reason: "no_snapshot" }`.
 */
export function devInspectRead(st: DevState, url: URL, request?: Request): Response {
  if (url.searchParams.has("probe")) {
    return Response.json({ armed: st.devInspectArmed }, { headers: NO_STORE });
  }
  st.devInspectArmed = true; // a reader exists: pages may start snapshotting
  const entry = pickEntry(st, readScope(url, request));
  if (!entry) {
    return Response.json({ reason: "no_snapshot" }, { status: 404, headers: NO_STORE });
  }
  return Response.json({
    snapshot: entry.snapshot,
    ageMs: Math.max(0, Date.now() - entry.receivedAt),
  }, { headers: NO_STORE });
}
