// A bare DevTools panel context over the in-memory DOM, for testing one pane module at a time
// without mounting the whole panel (tests/devtools-panel.test.ts mounts it).

import { FakeDocument, type FakeElement } from "./dom.ts";
import { initialState } from "../../src/client/devtools-panel.ts";
import type { DevTabCache, PanelCtx } from "../../src/client/devtools-panel/ctx.ts";
import { buildStyles } from "../../src/client/devtools-panel/styles.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

/** What the context's callbacks were asked to do. */
export interface PanelCalls {
  /** How many times `render()` ran. */
  renders: number;
  /** Every `selectNode(id)`. */
  selected: number[];
  /** Every `highlight(node, label)`. */
  highlighted: Array<[unknown, string | undefined]>;
  /** How many times `hideHighlight()` ran. */
  hidden: number;
}

/** A panel context, its document and panes, and a record of its callbacks. */
export interface TestPanel {
  readonly ctx: PanelCtx;
  readonly doc: FakeDocument;
  readonly treePane: FakeElement;
  readonly detailPane: FakeElement;
  readonly calls: PanelCalls;
}

/**
 * A panel context whose inspector API is `api` (only what the pane under test calls), with the
 * panel's initial state.
 *
 * @param api The `DenextDevtoolsApi` members the pane reads.
 * @returns The context, its document and panes, and the callback record.
 */
export function panelCtx(api: Record<string, unknown> = {}): TestPanel {
  const doc = new FakeDocument();
  const { S, S_BADGE } = buildStyles();
  const treePane = doc.createElement("div");
  const detailPane = doc.createElement("div");
  const calls: PanelCalls = { renders: 0, selected: [], highlighted: [], hidden: 0 };
  const ctx: PanelCtx = {
    doc: asAny(doc),
    api: asAny(api),
    S,
    S_BADGE,
    state: initialState(),
    treePane: asAny(treePane),
    detailPane: asAny(detailPane),
    render: () => void calls.renders++,
    selectNode: (id) => void calls.selected.push(id),
    highlight: (node, label) => void calls.highlighted.push([node, label]),
    hideHighlight: () => void calls.hidden++,
  };
  return { ctx, doc, treePane, detailPane, calls };
}

/** A data tab's cache after a successful read of `data`. */
export function loadedTab<T>(data: T): DevTabCache<T> {
  return { data, error: null, loaded: true };
}
