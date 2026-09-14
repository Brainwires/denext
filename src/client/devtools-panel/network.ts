// DevTools panel: the Network tab — the dev server's completed-request log.
//
// The data already exists: the dev black box records `kind:"request"` events, so this tab
// is a read of `/_denext/dev-state`. SPA dev serves no dev-state endpoint, hence the
// "App Router only" state the shared placeholder renders.

import { type PanelCtx, refreshDataTab, renderDataPlaceholder } from "./ctx.ts";
import { DEV_STATE_PATH } from "./dev-api.ts";

/** How many recent requests the tab asks for. */
const REQUEST_LIMIT = "200";

/**
 * Draw the Network tab from the last poll.
 *
 * @param ctx The mounted panel context.
 */
export function renderNetworkTab(ctx: PanelCtx): void {
  if (renderDataPlaceholder(ctx, "Network", ctx.state.network)) return;
}

/**
 * Re-read the request log into {@link PanelCtx.state}. Called by the shared 1 s poller
 * while the tab is open.
 *
 * @param ctx The mounted panel context.
 */
export function refreshNetworkTab(ctx: PanelCtx): void {
  const params = { kind: "request", limit: REQUEST_LIMIT };
  void refreshDataTab(ctx, ctx.state.network, DEV_STATE_PATH, params);
}
