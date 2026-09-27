/**
 * Helpers the FlashList and LegendList adapters share: an item's layout from the engine, and the
 * stuck-sticky-item tracker behind FlashList's `onChangeStickyIndex` / LegendList's
 * `onStickyHeaderChange`. Internal to the adapters.
 *
 * @module
 */

import type { VNodeChild } from "../../jsx/types.ts";
import { useCallback, useMemo, useRef } from "../../runtime/hooks.ts";
import type { VirtualListScrollEvent } from "../../client/virtual/types.ts";
import type { CoreHandle } from "./virtualized.ts";
import type { ListRenderItemInfo, RNSlot, VirtualizedListProps } from "./types.ts";
import { type Packing, packItems, rowOfItem } from "./grid.ts";
import { defaultRNKey } from "./virtualized.ts";

/** An item's box in the list (px; `y` from the first item). */
export interface ItemBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The scroll element's cross size. */
function crossSize(core: CoreHandle): number {
  const el = core.getScrollableNode() as { clientWidth?: number } | null;
  return el?.clientWidth ?? 0;
}

/**
 * Item `index`'s box: its row's offset and size from the engine (measured, else estimated), and
 * its column's share of the width.
 *
 * @param core The core handle.
 * @param p The packing.
 * @param index The item.
 */
export function layoutOf(core: CoreHandle | null, p: Packing, index: number): ItemBox | undefined {
  if (!core || index < 0 || index >= p.starts[p.rows]) return undefined;
  const row = rowOfItem(p, index);
  const l = core.engine()?.getItemLayout(core.visual(row));
  if (!l) return undefined;
  const unit = crossSize(core) / p.cols;
  let col = 0;
  for (let i = p.starts[row]; i < index; i++) col += p.spans ? p.spans[i] : 1;
  const span = p.spans ? p.spans[index] : 1;
  return { x: col * unit, y: l.offset, width: span * unit, height: l.size };
}

/** The first visible item (data index), or −1. */
function firstVisibleItem(core: CoreHandle, p: Packing): number {
  const r = core.engine()?.getRange();
  if (!r || r.last < r.first) return -1;
  return p.starts[Math.min(core.visual(r.first), core.visual(r.last))];
}

/**
 * A scroll-frame listener calling `onChange(current, previous)` when the stuck sticky item (the
 * last sticky index at or before the first visible item; −1 for none) changes, or undefined
 * without sticky items or a callback.
 *
 * @param core The core handle's ref.
 * @param p The packing.
 * @param indices The sticky item indices.
 * @param onChange The callback.
 */
export function stickyTracker(
  core: { current: CoreHandle | null },
  p: Packing,
  indices: readonly number[] | undefined,
  onChange: ((current: number, previous: number) => void) | undefined,
): ((e: VirtualListScrollEvent) => void) | undefined {
  if (!onChange || !indices || indices.length === 0) return undefined;
  const sorted = [...indices].sort((a, b) => a - b);
  let previous = -1;
  return () => {
    const c = core.current;
    if (!c) return;
    const first = firstVisibleItem(c, p);
    let current = -1;
    for (const s of sorted) if (s <= first) current = s;
    if (current === previous) return;
    const was = previous;
    previous = current;
    onChange(current, was);
  };
}

/** What {@linkcode packedCoreProps} reads from an adapter's props. */
interface PackedSource {
  readonly data?: ArrayLike<unknown> | null;
  readonly ListHeaderComponent?: RNSlot;
  readonly stickyHeaderIndices?: readonly number[];
}

/**
 * The core's data props for packed rows: row access and keys (an item per row when
 * `numColumns` is 1), sticky items and the initial item as rows, and the adapter's own
 * separator (the core's is off).
 *
 * @param props The adapter's props.
 * @param initialIndex The initial item, if any.
 * @param p The packing.
 * @param render Renders a row.
 * @param keyOf An item's key.
 */
export function packedCoreProps(
  props: PackedSource,
  initialIndex: number | null | undefined,
  p: Packing,
  render: (info: ListRenderItemInfo<unknown>) => VNodeChild,
  keyOf: (item: unknown, i: number) => string,
): Partial<VirtualizedListProps<unknown>> {
  const header = props.ListHeaderComponent ? 1 : 0;
  const single = p.cols === 1;
  return {
    ref: undefined,
    ItemSeparatorComponent: undefined,
    data: props.data ?? [],
    getItem: (data, row) => {
      const d = data as ArrayLike<unknown>;
      return single ? d[row] : Array.prototype.slice.call(d, p.starts[row], p.starts[row + 1]);
    },
    getItemCount: () => p.rows,
    keyExtractor: (item, row) =>
      single
        ? keyOf(item, row)
        : (item as unknown[]).map((it, k) => keyOf(it, p.starts[row] + k)).join(":"),
    renderItem: render as VirtualizedListProps<unknown>["renderItem"],
    stickyHeaderIndices: props.stickyHeaderIndices?.map((i) => rowOfItem(p, i) + header),
    initialScrollIndex: initialIndex === null || initialIndex === undefined
      ? undefined
      : rowOfItem(p, initialIndex),
  };
}

/** `overrideItemLayout`: set `layout.span` for a grid item. */
export type OverrideItemLayout = (
  layout: { span?: number },
  item: never,
  index: number,
  maxColumns: number,
  extraData?: unknown,
) => void;

/**
 * Hook: the data packed into rows of `numColumns` (spans from `overrideItemLayout`).
 *
 * @param data The items.
 * @param numColumns Columns (default 1).
 * @param overrideItemLayout Sets an item's span.
 * @param extraData Passed to `overrideItemLayout`.
 */
export function usePacking(
  data: readonly unknown[],
  numColumns: number | undefined,
  overrideItemLayout: OverrideItemLayout | undefined,
  extraData: unknown,
): Packing {
  const cols = Math.max(1, Math.floor(numColumns ?? 1));
  return useMemo(() => {
    const spanOf = overrideItemLayout
      ? (i: number) => {
        const layout: { span?: number } = {};
        overrideItemLayout(layout, data[i] as never, i, cols, extraData);
        return layout.span ?? 1;
      }
      : undefined;
    return packItems(data.length, cols, spanOf);
  }, [data, cols, overrideItemLayout, extraData]);
}

/**
 * Hook: a stable key function reading the latest `keyExtractor` (React Native's default rule
 * without one).
 *
 * @param keyExtractor The app's key extractor.
 */
export function useKeyOf(
  keyExtractor: ((item: never, index: number) => string) | undefined,
): (item: unknown, index: number) => string {
  const keys = useRef(keyExtractor);
  keys.current = keyExtractor;
  return useCallback((item: unknown, i: number): string => {
    const k = keys.current;
    return k ? String(k(item as never, i)) : defaultRNKey(item, i);
  }, []);
}

/** A promise resolving after two animation frames (a `scrollTo*` has landed). */
export function afterFrames(): Promise<void> {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  if (typeof raf !== "function") return Promise.resolve();
  return new Promise((resolve) => raf(() => raf(() => resolve())));
}
