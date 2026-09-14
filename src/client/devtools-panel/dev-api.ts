// DevTools panel: the dev-server data contract the data tabs (Network, Cache, Routes)
// and the editor link are built on.
//
// Every read is a same-origin GET against a `/_denext/*` dev endpoint, which the dev
// server gates on `devOriginAllowed()` — so a cross-origin page gets a 403, and a server
// that doesn't implement the endpoint (SPA dev serves none of them) gets a 404. Both,
// plus an outright network failure, are reported as the SAME `"unavailable"` reason so a
// tab can render one honest "App Router dev only" state instead of an error.
//
// The path constants are copies of `src/build/dev-server/state.ts` VALUES on purpose:
// this module is client code and must never import from `src/build/`. A test asserts the
// two stay equal.

/** The dev black box: recent server + browser events (`?kind=&limit=`). */
export const DEV_STATE_PATH = "/_denext/dev-state";
/** The page/data cache inspector feed (`getCacheStats()`). */
export const DEV_CACHE_PATH = "/_denext/dev-cache";
/** The app's route map (pages + API routes). */
export const DEV_ROUTES_PATH = "/_denext/dev-routes";
/** Open a source file in the developer's editor (`?file=&line=&column=`). */
export const OPEN_IN_EDITOR_PATH = "/_denext/open-in-editor";

/** Why a {@link devFetch} failed: the endpoint isn't there/allowed, or it errored. */
export type DevFetchFailure = "unavailable" | "error";

/** The result of a dev-endpoint read: the parsed payload, or why it couldn't be read. */
export type DevFetch<T> = { ok: true; data: T } | { ok: false; reason: DevFetchFailure };

/** How long a dev-endpoint read may take before it is abandoned (ms). */
const DEV_FETCH_TIMEOUT_MS = 3000;

/** `path` plus a query string when `params` is non-empty. */
function withQuery(path: string, params?: Record<string, string>): string {
  if (!params) return path;
  const qs = new URLSearchParams(params).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Read a dev endpoint as JSON, same-origin, with a hard timeout.
 *
 * 403 (cross-origin gate), 404 (endpoint absent — e.g. SPA dev) and a network failure all
 * map to `{ ok: false, reason: "unavailable" }`; any other non-2xx, or an unparseable
 * body, maps to `"error"`. Never throws.
 *
 * @param path One of the `DEV_*_PATH` constants in this module.
 * @param params Optional query parameters.
 * @returns The parsed payload, or the reason it could not be read.
 */
export async function devFetch<T>(
  path: string,
  params?: Record<string, string>,
): Promise<DevFetch<T>> {
  let res: Response;
  try {
    res = await fetch(withQuery(path, params), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DEV_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unavailable" }; // offline dev server / blocked request
  }
  if (res.status === 403 || res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, reason: "unavailable" };
  }
  try {
    if (!res.ok) throw new Error(String(res.status));
    return { ok: true, data: await res.json() as T };
  } catch {
    await res.body?.cancel().catch(() => {});
    return { ok: false, reason: "error" };
  }
}

/**
 * Ask the dev server to open `file` in the developer's editor (fire-and-forget).
 *
 * Routed through `/_denext/open-in-editor`, which resolves the path inside the project
 * and shapes the editor's args — so it honours `DENEXT_EDITOR`/`VISUAL`/`EDITOR` instead
 * of hard-coding one editor's URL scheme. Silent when the dev server isn't reachable.
 *
 * @param file Absolute path (or `file://` URL) of the source file.
 * @param line 1-based line to put the cursor on.
 * @param column 1-based column to put the cursor on.
 */
export function openInEditor(file: string, line = 1, column = 1): void {
  const url = withQuery(OPEN_IN_EDITOR_PATH, {
    file,
    line: String(line),
    column: String(column),
  });
  try {
    fetch(url, { signal: AbortSignal.timeout(DEV_FETCH_TIMEOUT_MS) })
      .then((res) => res.body?.cancel())
      .catch(() => {});
  } catch {
    // A relative URL with no document base (tests) — nothing to open.
  }
}
