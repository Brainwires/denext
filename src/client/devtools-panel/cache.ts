// DevTools panel: the Cache tab — the page/data cache's counters and the recent
// `revalidateTag`/`revalidatePath` invalidations, read from `/_denext/dev-cache`
// (`getCacheStats()` verbatim). App Router dev only: SPA dev runs no server cache, so the
// shared placeholder says so instead of showing a table of zeroes.
//
// Deliberately NOT here: the island-hydration timeline. It is client-side data the Render
// modes tab already owns, and duplicating it would give two places to keep in sync.
//
// Style note: every colour below is an inline string built inside a function, never a
// module-scope object literal — see ./styles.ts for why (esbuild retains top-level
// literals even when the only code using them is dead, shipping them to production).

import { h4, type PanelCtx, refreshDataTab, renderDataPlaceholder } from "./ctx.ts";
import { DEV_CACHE_PATH } from "./dev-api.ts";
import { el } from "./styles.ts";

/** One `revalidateTag` / `revalidatePath` call, as the endpoint reports it. */
interface Invalidation {
  /** Whether it invalidated by cache tag or by path. */
  kind: string;
  /** The tag or path that was invalidated. */
  value: string;
  /** Epoch milliseconds when it happened, or 0 when the event carried no timestamp. */
  at: number;
}

/** The endpoint payload, after the untrusted JSON has been narrowed. */
interface CacheSnapshot {
  /** Page (ISR) cache hits. */
  hits: number;
  /** Page (ISR) cache misses. */
  misses: number;
  /** Page (ISR) cache writes. */
  sets: number;
  /** Total invalidations recorded since the server started. */
  invalidations: number;
  /** The recent invalidations, NEWEST FIRST (the endpoint reports them newest last). */
  recent: Invalidation[];
}

/**
 * Draw the Cache tab from the last poll.
 *
 * @param ctx The mounted panel context.
 */
export function renderCacheTab(ctx: PanelCtx): void {
  if (renderDataPlaceholder(ctx, "Cache", ctx.state.cache)) return;
  const { doc, S, detailPane } = ctx;
  const snap = cacheSnapshot(ctx.state.cache.data);
  detailPane.append(h4(ctx, true, "Page cache"), statTiles(ctx, snap));
  detailPane.append(h4(ctx, false, "Recent invalidations"));
  if (snap.recent.length === 0) {
    detailPane.append(el(doc, "div", S.empty, "no invalidations yet"));
    return;
  }
  const now = Date.now();
  const list = el(doc, "ul", S.wf);
  for (const event of snap.recent) list.append(invalidationRow(ctx, event, now));
  detailPane.append(list);
}

/**
 * Re-read the cache statistics into {@link PanelCtx.state}. Called by the shared 1 s
 * poller while the tab is open.
 *
 * @param ctx The mounted panel context.
 */
export function refreshCacheTab(ctx: PanelCtx): void {
  void refreshDataTab(ctx, ctx.state.cache, DEV_CACHE_PATH);
}

/**
 * Narrow the endpoint's payload into a snapshot, treating every field as untrusted shape:
 * a missing or non-numeric counter reads as 0 rather than rendering `undefined`.
 *
 * @param data The last successful endpoint read.
 * @returns The counters and the recent invalidations, newest first.
 */
function cacheSnapshot(data: unknown): CacheSnapshot {
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const list = Array.isArray(raw.recentInvalidations) ? raw.recentInvalidations : [];
  const recent: Invalidation[] = [];
  // The endpoint appends, so the newest is last; the tab shows the newest first.
  for (let i = list.length - 1; i >= 0; i--) {
    const event = parseInvalidation(list[i]);
    if (event) recent.push(event);
  }
  return {
    hits: num(raw.pageHits),
    misses: num(raw.pageMisses),
    sets: num(raw.pageSets),
    invalidations: num(raw.invalidations),
    recent,
  };
}

/**
 * A finite non-negative number, or 0.
 *
 * @param value An untrusted JSON value.
 * @returns The number it holds, or 0.
 */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Turn one entry of `recentInvalidations` into a row.
 *
 * @param value One untrusted array entry.
 * @returns The invalidation, or null when it carries no value to show.
 */
function parseInvalidation(value: unknown): Invalidation | null {
  if (typeof value !== "object" || value === null) return null;
  const e = value as { kind?: unknown; value?: unknown; at?: unknown };
  if (typeof e.value !== "string") return null;
  return {
    kind: typeof e.kind === "string" ? e.kind : "tag",
    value: e.value,
    at: num(e.at),
  };
}

/**
 * The four counters plus the derived hit rate, as a row of tiles that wraps on a narrow
 * panel.
 *
 * @param ctx The mounted panel context.
 * @param snap The narrowed endpoint payload.
 * @returns The tile row.
 */
function statTiles(ctx: PanelCtx, snap: CacheSnapshot): HTMLElement {
  const reads = snap.hits + snap.misses;
  const rate = reads === 0 ? "—" : `${Math.round((snap.hits / reads) * 100)}%`;
  return el(
    ctx.doc,
    "div",
    "display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 4px",
    statTile(ctx, "hits", String(snap.hits)),
    statTile(ctx, "misses", String(snap.misses)),
    statTile(ctx, "sets", String(snap.sets)),
    statTile(ctx, "invalidations", String(snap.invalidations)),
    statTile(ctx, "hit rate", rate),
  );
}

/**
 * One stat tile: the figure over its label.
 *
 * @param ctx The mounted panel context.
 * @param label The counter's name.
 * @param value The figure, already formatted.
 * @returns The tile element.
 */
function statTile(ctx: PanelCtx, label: string, value: string): HTMLElement {
  const { doc, S } = ctx;
  const box = `flex:1 1 62px;min-width:58px;padding:5px 7px;border:1px solid #1d2330;` +
    `border-radius:6px;background:#0c0e14`;
  const figure = `font-size:15px;line-height:1.2;color:#8aa2ff`;
  const caption = `${S.dim};font-size:9px;text-transform:uppercase;letter-spacing:.07em`;
  return el(doc, "div", box, el(doc, "div", figure, value), el(doc, "div", caption, label));
}

/**
 * One invalidation row: its kind as a pill, the tag/path, and how long ago it happened.
 *
 * @param ctx The mounted panel context.
 * @param event The invalidation.
 * @param now Epoch milliseconds this render started (shared by every row).
 * @returns The `<li>`.
 */
function invalidationRow(ctx: PanelCtx, event: Invalidation, now: number): HTMLElement {
  const { doc, S } = ctx;
  const pill = `${S.pill};background:${
    event.kind === "path" ? "#8aa2ff" : "#f0b45b"
  };color:#0c0e14`;
  return el(
    doc,
    "li",
    S.wfLi,
    el(doc, "span", pill, event.kind),
    el(doc, "span", S.v, event.value),
    el(doc, "span", S.at, event.at === 0 ? "" : agoLabel(now - event.at)),
  );
}

/**
 * A coarse "how long ago" label.
 *
 * The unit table is built inside the function, not at module scope, for the same reason
 * the style strings are (see the module header).
 *
 * @param deltaMs Milliseconds since the invalidation was recorded.
 * @returns `"2s ago"` / `"3m ago"` / `"1h ago"`.
 */
function agoLabel(deltaMs: number): string {
  const units: [number, string][] = [[3600, "h"], [60, "m"], [1, "s"]];
  const seconds = Math.max(0, Math.round(deltaMs / 1000));
  const [size, suffix] = units.find(([s]) => seconds >= s) ?? units[2];
  return `${Math.floor(seconds / size)}${suffix} ago`;
}
