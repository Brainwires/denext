// DevTools panel: the component tree pane (search filter, collapse, hover-highlight).

import type { InspectNode } from "../devtools-inspect.ts";
import type { PanelCtx } from "./ctx.ts";
import { el } from "./styles.ts";

/**
 * The ids to show for `search`: a node is visible if it (or a descendant) matches. Returns
 * null when there is no filter (show everything).
 */
export function computeVisible(search: string, nodes: InspectNode[]): Set<number> | null {
  if (!search) return null;
  const out = new Set<number>();
  const walk = (list: InspectNode[]): boolean => {
    let any = false;
    for (const n of list) {
      const childHit = walk(n.children);
      if (childHit || n.name.toLowerCase().includes(search)) {
        out.add(n.id);
        any = true;
      }
    }
    return any;
  };
  walk(nodes);
  return out;
}

/** The collapse/expand twisty — blank when there are no (visible) children. */
function twisty(ctx: PanelCtx, n: InspectNode): HTMLElement {
  const { doc, S, state } = ctx;
  const hasKids = n.children.length > 0;
  const collapsed = state.collapsed.has(n.id);
  const twist = el(doc, "span", S.twist, hasKids ? (collapsed ? "▶" : "▼") : "");
  if (hasKids) {
    twist.addEventListener("click", (e) => {
      e.stopPropagation();
      if (collapsed) state.collapsed.delete(n.id);
      else state.collapsed.add(n.id);
      ctx.render();
    });
  }
  return twist;
}

/** One tree row: twisty, name, key, badges; click selects, hover highlights on the page. */
function treeRow(ctx: PanelCtx, n: InspectNode, depth: number): HTMLElement {
  const { doc, S, S_BADGE, state, api } = ctx;
  const row = el(doc, "div", n.id === state.selected ? S.rowSel : S.row);
  row.style.paddingLeft = 6 + depth * 12 + "px";
  row.append(twisty(ctx, n));
  row.append(el(doc, "span", n.kind === "component" ? S.comp : S.hostName, n.name));
  if (n.key !== null) row.append(el(doc, "span", S.key, ` key=${n.key}`));
  for (const b of n.badges ?? []) row.append(el(doc, "span", S_BADGE, b));
  row.addEventListener("click", () => ctx.selectNode(n.id));
  row.addEventListener("mouseenter", () => {
    if (!state.picking) ctx.highlight(api.getHostNode(n.id), n.name);
  });
  row.addEventListener("mouseleave", () => {
    if (!state.picking) ctx.hideHighlight();
  });
  return row;
}

export function renderTree(
  ctx: PanelCtx,
  nodes: InspectNode[],
  depth: number,
  visible: Set<number> | null,
): void {
  const { state, treePane } = ctx;
  for (const n of nodes) {
    if (visible && !visible.has(n.id)) continue;
    if (n.kind !== "component" && !state.showHost) {
      renderTree(ctx, n.children, depth, visible);
      continue;
    }
    treePane.append(treeRow(ctx, n, depth));
    if (!state.collapsed.has(n.id)) renderTree(ctx, n.children, depth + 1, visible);
  }
}
