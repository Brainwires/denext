/**
 * Grid rows for the FlashList and LegendList adapters: items packed into rows of `numColumns`
 * cells, honouring `overrideItemLayout`'s `span` (FlashList v2's and LegendList's grid rule: an
 * item that does not fit the row's remaining columns starts the next row). Public APIs keep
 * item indices; the engine virtualizes rows. Internal to the adapters.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNodeChild, VNodeType } from "../../jsx/types.ts";
import type { ViewToken } from "../../client/virtual/types.ts";
import type { ListRenderItemInfo, Separators } from "./types.ts";

/** Items packed into rows. */
export interface Packing {
  /** Columns per row. */
  readonly cols: number;
  /** Row count. */
  readonly rows: number;
  /** Row `r`'s first item is `starts[r]`; `starts[rows]` is the item count. */
  readonly starts: Int32Array;
  /** Each item's span (null when every span is 1). */
  readonly spans: Uint8Array | null;
}

/**
 * Pack `n` items into rows of `cols` columns; `spanOf(i)` (1 … cols) widens an item.
 *
 * @param n Item count.
 * @param cols Columns (≥ 1).
 * @param spanOf An item's span, when items may span columns.
 */
export function packItems(n: number, cols: number, spanOf?: (i: number) => number): Packing {
  if (!spanOf || cols === 1) {
    const rows = Math.ceil(n / cols);
    const starts = new Int32Array(rows + 1);
    for (let r = 0; r <= rows; r++) starts[r] = Math.min(n, r * cols);
    return { cols, rows, starts, spans: null };
  }
  const spans = new Uint8Array(n);
  const starts: number[] = [0];
  let used = 0;
  for (let i = 0; i < n; i++) {
    const span = Math.max(1, Math.min(cols, Math.floor(spanOf(i) || 1)));
    spans[i] = span;
    if (used > 0 && used + span > cols) {
      starts.push(i);
      used = 0;
    }
    used += span;
  }
  if (n > 0) starts.push(n);
  return { cols, rows: Math.max(0, starts.length - 1), starts: Int32Array.from(starts), spans };
}

/** The row holding item `i` (binary search). */
export function rowOfItem(p: Packing, i: number): number {
  let lo = 0;
  let hi = p.rows - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.starts[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** One viewability token per item of each row token (row indices → item indices). */
export function expandPackedTokens(
  p: Packing,
  keyOf: (item: unknown, index: number) => string,
): (tokens: ViewToken<unknown>[]) => ViewToken<unknown>[] {
  return (tokens) => {
    const out: ViewToken<unknown>[] = [];
    for (const t of tokens) {
      const first = p.starts[t.index as number];
      (t.item as unknown[]).forEach((item, k) => {
        const index = first + k;
        out.push({ ...t, item, key: keyOf(item, index), index });
      });
    }
    return out;
  };
}

/** Gaps inside a grid (LegendList's `columnWrapperStyle`). */
export interface GridGaps {
  /** Between columns, px. */
  readonly column?: number;
  /** Between rows, px. */
  readonly row?: number;
}

/** A cell's width: its share of the row minus the column gaps. */
function cellWidth(span: number, cols: number, gap: number): string {
  if (gap <= 0) return `${(100 * span) / cols}%`;
  return `calc((100% - ${(cols - 1) * gap}px) * ${span / cols} + ${(span - 1) * gap}px)`;
}

/**
 * The renderer of one grid row: a `flexDirection: "row"` `View` of fixed-width cells.
 *
 * @param View react-native-web's `View`.
 * @param p The packing.
 * @param render Renders item `index` (with the row's separators).
 * @param gaps Column / row gaps.
 */
export function packedRowRender(
  View: VNodeType,
  p: Packing,
  render: (item: unknown, index: number, separators: Separators) => VNodeChild,
  gaps: GridGaps = {},
): (info: ListRenderItemInfo<unknown>) => VNodeChild {
  const column = Math.max(0, gaps.column ?? 0);
  const rowGap = Math.max(0, gaps.row ?? 0);
  return (info) => {
    const row = info.index;
    const first = p.starts[row];
    const style: Record<string, string | number> = { flexDirection: "row" };
    if (column > 0) style.columnGap = column;
    if (rowGap > 0 && row < p.rows - 1) style.paddingBottom = rowGap;
    return h(
      View,
      { style },
      (info.item as unknown[]).map((item, k) => {
        const index = first + k;
        const span = p.spans ? p.spans[index] : 1;
        return h(
          View,
          { key: k, style: { width: cellWidth(span, p.cols, column) } },
          render(
            item,
            index,
            info.separators,
          ),
        );
      }),
    );
  };
}
