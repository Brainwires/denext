// DevTools panel: the shared context every pane module renders against.

import type { DenextDevtoolsApi, InspectNode } from "../devtools-inspect.ts";
import { el, type PanelStyles } from "./styles.ts";

export interface PanelState {
  open: boolean;
  tab: "components" | "render" | "profiler";
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
}

/** What the tree / detail / render-modes / profiler panes need from the mounted panel. */
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
