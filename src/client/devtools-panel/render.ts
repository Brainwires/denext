// DevTools panel: the render pass — one dispatch table from the active tab to the module
// that draws it, plus the chrome sync (tab selection, left pane, title) that runs first.
//
// A table rather than an if-chain so adding a tab costs one row instead of another branch
// in an ever-growing function (the fallow complexity gate is the forcing function, and the
// keyboard map in ./interactions.ts is built the same way).

import { renderDetail } from "./detail.ts";
import { renderProfilerTab } from "./profiler.ts";
import { renderRenderModes } from "./render-modes.ts";
import { refreshCacheTab, renderCacheTab } from "./cache.ts";
import { refreshNetworkTab, renderNetworkTab } from "./network.ts";
import { refreshRoutesTab, renderRoutesTab } from "./routes.ts";
import type { PanelCtx, TabId } from "./ctx.ts";
import { type Shell, syncTitle, TABS } from "./shell.ts";
import { el } from "./styles.ts";
import { computeVisible, renderTree } from "./tree.ts";

/** How a tab draws itself into the panel's panes. */
type TabRenderer = (ctx: PanelCtx) => void;

/** The Components tab: the searchable tree on the left, the selected node's detail right. */
function renderComponentsTab(ctx: PanelCtx): void {
  const { api, doc, S, state, treePane } = ctx;
  const tree = api.getInspectorTree();
  if (tree.length === 0) treePane.append(el(doc, "div", S.empty, "nothing mounted"));
  else renderTree(ctx, tree, 0, computeVisible(state.search, tree));
  renderDetail(ctx, tree);
}

/** Tab id → the module that draws it. */
const TAB_RENDERERS: Record<TabId, TabRenderer> = {
  components: renderComponentsTab,
  render: renderRenderModes,
  profiler: renderProfilerTab,
  network: renderNetworkTab,
  cache: renderCacheTab,
  routes: renderRoutesTab,
};

/** Tab id → its dev-server read, for the tabs that have one. */
const TAB_REFRESHERS: Partial<Record<TabId, TabRenderer>> = {
  network: refreshNetworkTab,
  cache: refreshCacheTab,
  routes: refreshRoutesTab,
};

/**
 * Kick off the active tab's dev-server read, if it has one. Called when a tab is selected
 * and, for the polled tabs, once a second while they are open.
 *
 * @param ctx The mounted panel context.
 */
export function refreshTab(ctx: PanelCtx): void {
  TAB_REFRESHERS[ctx.state.tab]?.(ctx);
}

/** Mark the selected tab, show the tree only for Components, and fit the header title. */
function syncChrome(ctx: PanelCtx, shell: Shell): void {
  const { S, state } = ctx;
  for (const { id } of TABS) {
    const on = state.tab === id;
    const btn = shell.tabs[id];
    btn.style.cssText = on ? S.tabItemOn : S.tabItem;
    btn.setAttribute("aria-selected", on ? "true" : "false");
    btn.setAttribute("tabindex", on ? "0" : "-1");
  }
  shell.leftPane.style.display = state.tab === "components" ? "" : "none";
  syncTitle(shell);
}

/**
 * Re-render the whole panel from the current state — the panes' own tiny update loop,
 * deliberately not the reconciler, so inspecting never re-enters the tree it inspects.
 *
 * @param ctx The mounted panel context.
 * @param shell The panel's DOM shell.
 */
export function renderPanel(ctx: PanelCtx, shell: Shell): void {
  syncChrome(ctx, shell);
  ctx.treePane.replaceChildren();
  ctx.detailPane.replaceChildren();
  TAB_RENDERERS[ctx.state.tab](ctx);
}
