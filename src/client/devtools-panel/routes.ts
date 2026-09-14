// DevTools panel: the Routes tab — the app's route map (pages + API routes) as the dev
// server's cached manifest already knows it. Read once per selection rather than polled:
// the manifest only changes when a file is added or removed, which reloads the page.

import { type PanelCtx, refreshDataTab, renderDataPlaceholder } from "./ctx.ts";
import { DEV_ROUTES_PATH } from "./dev-api.ts";

/**
 * Draw the Routes tab from the last read.
 *
 * @param ctx The mounted panel context.
 */
export function renderRoutesTab(ctx: PanelCtx): void {
  if (renderDataPlaceholder(ctx, "Routes", ctx.state.routes)) return;
}

/**
 * Read the route map into {@link PanelCtx.state}. Called when the tab is selected.
 *
 * @param ctx The mounted panel context.
 */
export function refreshRoutesTab(ctx: PanelCtx): void {
  void refreshDataTab(ctx, ctx.state.routes, DEV_ROUTES_PATH);
}
