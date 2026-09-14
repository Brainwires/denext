// DevTools panel: the shared context every pane module renders against, plus the small
// helpers the data tabs (Network, Cache, Routes) share.

import type { DenextDevtoolsApi, InspectNode } from "../devtools-inspect.ts";
import { devFetch, type DevFetchFailure } from "./dev-api.ts";
import { el, type PanelStyles } from "./styles.ts";

/** The panel's six tabs (see `TABS` in `./shell.ts` for their order and labels). */
export type TabId = "components" | "render" | "profiler" | "network" | "cache" | "routes";

/**
 * One data tab's last dev-endpoint read. The shared 1 s poller (Network/Cache) and the
 * one-shot refresh (Routes) write it; the tab renders from it, so a poll that fails
 * leaves the last good payload on screen.
 */
export interface DevTabCache<T> {
  /** The last successful payload, or null before the first successful read. */
  data: T | null;
  /** Why the last read failed, or null when it succeeded. */
  error: DevFetchFailure | null;
  /** Whether a read has completed at least once (drives the "loading…" placeholder). */
  loaded: boolean;
}

/** A fresh, empty {@link DevTabCache}. */
export function emptyTabCache<T>(): DevTabCache<T> {
  return { data: null, error: null, loaded: false };
}

/** The Network tab's two toolbar controls, as the tab reads them back. */
export interface NetworkFilter {
  /** Lowercased substring the path must contain; empty shows everything. */
  text: string;
  /** Whether only responses with status >= 400 are shown. */
  errorsOnly: boolean;
}

/**
 * The Network tab's live DOM + filter, kept across renders in {@link PanelState}.
 *
 * The toolbar is built once and re-appended (rather than rebuilt) on every render so that
 * typing in the filter box doesn't destroy the element being typed into.
 */
export interface NetworkUi {
  /** The toolbar's current filter state. */
  filter: NetworkFilter;
  /** The toolbar element, re-appended on every render. */
  toolbar: HTMLElement;
  /** The path-filter input. */
  box: HTMLInputElement;
  /** The errors-only toggle. */
  errBtn: HTMLElement;
  /** The "n of m requests" counter. */
  count: HTMLElement;
  /** Whether the filter box held focus when the panel last re-rendered underneath it. */
  focused: boolean;
}

export interface PanelState {
  open: boolean;
  tab: TabId;
  selected: number | null;
  /** Element-picker mode: pointer over the page highlights + selects a component. */
  picking: boolean;
  /** Component-name filter (lowercased); empty shows everything. */
  search: string;
  /** Collapsed node ids (their subtree is hidden in the tree). */
  collapsed: Set<number>;
  /** Whether host/text nodes get their own tree rows (off by default). */
  showHost: boolean;
  /** Expanded deep-value path keys in the detail pane (reset when the selection changes). */
  expanded: Set<string>;
  /** The commit index selected in the Profiler tab's step-through, or null for the latest. */
  profilerCommit: number | null;
  /** Whether re-rendered components flash on the page (the ✨ highlight-updates toggle). */
  highlight: boolean;
  /** Last `/_denext/dev-state?kind=request` read (the Network tab). */
  network: DevTabCache<unknown>;
  /** Last `/_denext/dev-cache` read (the Cache tab). */
  cache: DevTabCache<unknown>;
  /** Last `/_denext/dev-routes` read (the Routes tab). */
  routes: DevTabCache<unknown>;
  /** The Network tab's toolbar + filter, created on its first render. */
  networkUi?: NetworkUi;
  /**
   * Set once any dev endpoint answered "unavailable" — SPA dev serves none of them, so
   * the editor link falls back to a `vscode://` URL and the data tabs say so.
   */
  dataUnavailable?: boolean;
}

/** What the tree / detail / render-modes / profiler / data panes need from the mounted panel. */
export interface PanelCtx {
  readonly doc: Document;
  readonly api: DenextDevtoolsApi;
  readonly S: PanelStyles["S"];
  readonly S_BADGE: string;
  readonly state: PanelState;
  readonly treePane: HTMLElement;
  readonly detailPane: HTMLElement;
  /** Re-render the whole panel from the current state. */
  render(): void;
  /** Select a component (clears the expanded-value set when the selection changes). */
  selectNode(id: number): void;
  /** Show the hover/pick highlight over a page element (with an optional label). */
  highlight(node: Element | null, label?: string): void;
  hideHighlight(): void;
}

export function findNode(nodes: InspectNode[], id: number): InspectNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** A detail-pane section heading. */
export function h4(ctx: PanelCtx, first: boolean, text: string): HTMLElement {
  return el(ctx.doc, "h4", first ? ctx.S.h4First : ctx.S.h4, text);
}

/** How wide (px) the longest bar of a proportional set is drawn. */
const BAR_WIDTH = 70;

/**
 * A bar whose width is `value`'s share of `max`.
 *
 * Shared by the waterfalls (./render-modes.ts) and the Network tab's duration column, so
 * every proportional bar in the panel uses one scale: {@link BAR_WIDTH} px at `max`, a
 * 3 px floor so a near-zero measurement is still visible, and the `S.rankBar` fill.
 *
 * @param ctx The mounted panel context.
 * @param value This row's measurement.
 * @param max The largest measurement in the visible set (0 means "nothing measured yet").
 * @param extra Extra inline style appended to the bar (e.g. inline placement in a cell).
 * @returns The bar element.
 */
export function proportionalBar(
  ctx: PanelCtx,
  value: number,
  max: number,
  extra = "",
): HTMLElement {
  const bar = el(ctx.doc, "div", extra ? `${ctx.S.rankBar};${extra}` : ctx.S.rankBar);
  bar.style.width = `${Math.max(3, Math.round((value / (max || 0.0001)) * BAR_WIDTH))}px`;
  return bar;
}

/**
 * Read a dev endpoint into a tab's cache and re-render the panel.
 *
 * Shared by all three data tabs so they report an unreachable endpoint identically (and
 * exactly once per read). Never throws — a failure becomes `cache.error`.
 *
 * @param ctx The mounted panel context.
 * @param cache The tab's slot in {@link PanelState}.
 * @param path The dev-endpoint path to read.
 * @param params Optional query parameters.
 */
export async function refreshDataTab<T>(
  ctx: PanelCtx,
  cache: DevTabCache<T>,
  path: string,
  params?: Record<string, string>,
): Promise<void> {
  const res = await devFetch<T>(path, params);
  cache.loaded = true;
  if (res.ok) {
    cache.data = res.data;
    cache.error = null;
  } else {
    cache.error = res.reason;
    if (res.reason === "unavailable") ctx.state.dataUnavailable = true;
  }
  ctx.render();
}

/**
 * Render a data tab's non-data state, when there is one.
 *
 * @param ctx The mounted panel context.
 * @param label The tab's name, used in the "App Router only" line.
 * @param cache The tab's slot in {@link PanelState}.
 * @returns Whether a placeholder was rendered (i.e. the tab has nothing to draw).
 */
export function renderDataPlaceholder(
  ctx: PanelCtx,
  label: string,
  cache: DevTabCache<unknown>,
): boolean {
  const { doc, S, detailPane } = ctx;
  if (!cache.loaded && cache.data === null) {
    detailPane.append(el(doc, "div", S.empty, "loading…"));
    return true;
  }
  if (cache.error === "unavailable" && cache.data === null) {
    detailPane.append(
      el(doc, "div", S.empty, `${label} is not available in SPA dev (App Router only)`),
    );
    return true;
  }
  if (cache.error === "error" && cache.data === null) {
    detailPane.append(el(doc, "div", S.empty, `${label} could not be read from the dev server`));
    return true;
  }
  return false;
}
