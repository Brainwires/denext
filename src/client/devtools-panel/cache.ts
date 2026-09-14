// DevTools panel: the Cache tab — `getCacheStats()` over the dev server's cache endpoint
// (hits/misses/sets per key, plus invalidations). App Router dev only: SPA dev runs no
// server cache, so the shared placeholder says so instead of showing an empty table.

import { type PanelCtx, refreshDataTab, renderDataPlaceholder } from "./ctx.ts";
import { DEV_CACHE_PATH } from "./dev-api.ts";

/**
 * Draw the Cache tab from the last poll.
 *
 * @param ctx The mounted panel context.
 */
export function renderCacheTab(ctx: PanelCtx): void {
  if (renderDataPlaceholder(ctx, "Cache", ctx.state.cache)) return;
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
