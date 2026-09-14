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
// dev endpoint that STORES browser-supplied structured data, so it is method-, type-,
// size- and shape-checked before anything is kept, and keeps at most one snapshot per
// page URL across an 8-URL LRU.
//
// Neither read endpoint does any scanning of its own: the cache snapshot is the same public
// `getCacheStats()` a monitoring hook would read, and the route map is matched against the
// dev server's ALREADY-CACHED manifest (`getManifest`), which the watcher invalidates on a
// file add/remove. So polling either one costs nothing but the JSON.

import { getCacheStats } from "../../server/cache.ts";
import { routeMapData } from "../../mcp/inspect.ts";
import { getManifest } from "./manifest.ts";
import { type DevState, type InspectSnapshotEntry, MAX_INSPECT_URLS } from "./state.ts";
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

/** Server-side re-check of the page's own caps (this is browser-supplied data). */
const MAX_SNAPSHOT_NODES = 4000;

/** Server-side re-check of the page's depth cap. */
const MAX_SNAPSHOT_DEPTH = 60;

/** Longest page URL a snapshot may be keyed by. */
const MAX_SNAPSHOT_URL = 2048;

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

/** One snapshot node, shape-checked (and counted/depth-limited) before it is stored. */
function validNode(node: unknown, depth: number, count: { n: number }): boolean {
  if (depth > MAX_SNAPSHOT_DEPTH || ++count.n > MAX_SNAPSHOT_NODES) return false;
  if (node === null || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (typeof n.id !== "number" || typeof n.name !== "string") return false;
  if (n.props === null || typeof n.props !== "object") return false;
  if (!Array.isArray(n.hooks) || !Array.isArray(n.contexts) || !Array.isArray(n.children)) {
    return false;
  }
  return n.children.every((c) => validNode(c, depth + 1, count));
}

/**
 * Parse and shape-check a posted snapshot. A body that is not a well-formed snapshot is
 * rejected (the caller drops it silently, as the dev-log sink does) rather than stored:
 * the MCP tools render this straight into an agent's context.
 *
 * @param body The raw request body.
 * @returns The snapshot, or null when the body is malformed or over the server's caps.
 */
function parseSnapshot(body: string): InspectSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.url !== "string" || !Array.isArray(s.nodes)) return null;
  const count = { n: 0 };
  if (!s.nodes.every((n) => validNode(n, 0, count))) return null;
  return {
    url: s.url.slice(0, MAX_SNAPSHOT_URL),
    at: typeof s.at === "number" ? s.at : Date.now(),
    truncated: s.truncated === true,
    nodes: s.nodes as InspectSnapshot["nodes"],
  };
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
 * POST + `application/json` only (405/415 otherwise), body capped at 256 KB (413), and a
 * body that does not parse as a snapshot is DROPPED with a 204 — a dev page must never be
 * taught to log server errors by posting junk.
 *
 * @param st The dev-server state (its {@link DevState.devInspect} LRU is written).
 * @param request The POST request.
 * @returns 204 on accept-or-drop, 415/413 when the request itself is refused.
 */
export async function devInspectSink(st: DevState, request: Request): Promise<Response> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("application/json")) {
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

/** The stored entry for `want` (exact URL, else the newest with that path), or the newest. */
function pickEntry(st: DevState, want: string | null): InspectSnapshotEntry | undefined {
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
 * `GET /_denext/dev-inspect` — read back the latest snapshot the page posted, for the MCP
 * component/why-render/hook tools.
 *
 * `?url=` selects a page (exact match, else the newest snapshot with that path); without
 * it the most recently posted snapshot is returned. `ageMs` is measured on the SERVER
 * clock, so a skewed page clock cannot make a stale tree look fresh.
 *
 * @param st The dev-server state.
 * @param url The request URL (its `url` parameter selects the page).
 * @returns `{ snapshot, ageMs }`, or a 404 `{ reason: "no_snapshot" }`.
 */
export function devInspectRead(st: DevState, url: URL): Response {
  const entry = pickEntry(st, url.searchParams.get("url"));
  if (!entry) {
    return Response.json({ reason: "no_snapshot" }, { status: 404, headers: NO_STORE });
  }
  return Response.json({
    snapshot: entry.snapshot,
    ageMs: Math.max(0, Date.now() - entry.receivedAt),
  }, { headers: NO_STORE });
}
