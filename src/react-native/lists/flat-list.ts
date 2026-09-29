/**
 * React Native's `FlatList` for React Native mode, on denext's `VirtualList` (through the
 * `VirtualizedList` core, as react-native-web builds its `FlatList`). `numColumns` groups items
 * into rows exactly as React Native does (a `flexDirection: "row"` `View` per row with
 * `columnWrapperStyle`; row indices for `scrollToIndex`, `getItemLayout` and
 * `stickyHeaderIndices`; one viewability token per item).
 *
 * @module
 */

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeType } from "../../jsx/types.ts";
import { useImperativeHandle, useMemo, useRef } from "../../runtime/hooks.ts";
import type { ViewToken } from "../../client/virtual/types.ts";
import { type CoreHandle, CoreList, defaultRNKey, type EngineOptions } from "./virtualized.ts";
import type {
  FlatListProps,
  FlatListRef,
  ListPrimitives,
  ListRenderItemInfo,
  VirtualizedListProps,
} from "./types.ts";

/** A grid row's base style. */
const ROW_STYLE = { flexDirection: "row" };

/** Whether `data` has a numeric `length`. */
function isArrayLike(data: unknown): data is ArrayLike<unknown> {
  return data !== null && data !== undefined && typeof Object(data).length === "number";
}

/** Data access for `cols` columns: an item per row, or an array of up to `cols` items. */
function gridAccess(cols: number): {
  getItem: (data: unknown, row: number) => unknown;
  getItemCount: (data: unknown) => number;
} {
  if (cols <= 1) {
    return {
      getItem: (data, i) => (data as ArrayLike<unknown>)[i],
      getItemCount: (data) => isArrayLike(data) ? data.length : 0,
    };
  }
  return {
    getItem: (data, row) => {
      const d = data as ArrayLike<unknown>;
      const out: unknown[] = [];
      for (let k = 0; k < cols; k++) {
        const i = row * cols + k;
        if (i < d.length) out.push(d[i]);
      }
      return out;
    },
    getItemCount: (data) => isArrayLike(data) ? Math.ceil(data.length / cols) : 0,
  };
}

/** One viewability token per item of a grid row (React Native's `_pushMultiColumnViewable`). */
function expandRowTokens(
  cols: number,
  keyOf: (item: unknown, index: number) => string,
): (tokens: ViewToken<unknown>[]) => ViewToken<unknown>[] {
  return (tokens) => {
    const out: ViewToken<unknown>[] = [];
    for (const t of tokens) {
      const items = t.item as unknown[];
      items.forEach((item, k) => {
        const index = (t.index as number) * cols + k;
        out.push({ ...t, item, key: keyOf(item, index), index });
      });
    }
    return out;
  };
}

/** Renders a grid row: the row's items in a `View` with `columnWrapperStyle`. */
function rowRender(
  View: VNodeType,
  render: (info: ListRenderItemInfo<unknown>) => VNodeChild,
  columnWrapperStyle: unknown,
  cols: number,
): (info: ListRenderItemInfo<unknown>) => VNodeChild {
  return (info) =>
    h(
      View,
      { style: [ROW_STYLE, columnWrapperStyle] },
      (info.item as unknown[]).map((item, k) => {
        const el = render({ item, index: info.index * cols + k, separators: info.separators });
        return el === null || el === undefined ? null : h(Fragment, { key: k }, el);
      }),
    );
}

/** The item renderer: `ListItemComponent`, else `renderItem`. */
function itemRender(
  props: FlatListProps<unknown>,
): (info: ListRenderItemInfo<unknown>) => VNodeChild {
  const { ListItemComponent, renderItem } = props;
  if (ListItemComponent) {
    return (info) => h(ListItemComponent, info as unknown as Record<string, unknown>);
  }
  return (info) => renderItem ? renderItem(info) : null;
}

/** The FlatList ref: the core's methods plus `getNativeScrollRef`. */
function flatHandle(core: { current: CoreHandle | null }): FlatListRef<unknown> {
  const c = () => core.current;
  return {
    scrollToEnd: (p) => c()?.scrollToEnd(p),
    scrollToIndex: (p) => c()?.scrollToIndex(p),
    scrollToItem: (p) => c()?.scrollToItem(p),
    scrollToOffset: (p) => c()?.scrollToOffset(p),
    recordInteraction: () => c()?.recordInteraction(),
    flashScrollIndicators() {},
    getScrollResponder: () => c()?.getScrollResponder() ?? null,
    getNativeScrollRef: () => c()?.getScrollResponder() ?? null,
    getScrollableNode: () => c()?.getScrollableNode() ?? null,
    setNativeProps() {},
  };
}

/**
 * React Native's `FlatList` on denext's `VirtualList`, rendering grid rows and wrappers with
 * react-native-web's `View`.
 *
 * @param prim react-native-web's primitives (React Native mode passes the app's own).
 * @returns The component.
 */
export function createFlatList(prim: ListPrimitives): (props: FlatListProps<unknown>) => VNode {
  function FlatList(props: FlatListProps<unknown>): VNode {
    const cols = Math.max(1, Math.floor(props.numColumns ?? 1));
    const core = useRef<CoreHandle | null>(null);
    const keys = useRef(props.keyExtractor);
    keys.current = props.keyExtractor;
    const access = useMemo(() => gridAccess(cols), [cols]);
    const { renderItem, ListItemComponent, columnWrapperStyle } = props;
    const gridRender = useMemo(
      () => cols > 1 ? rowRender(prim.View, itemRender(props), columnWrapperStyle, cols) : null,
      [cols, renderItem, ListItemComponent, columnWrapperStyle],
    );
    const engine = useMemo((): EngineOptions =>
      cols > 1
        ? {
          convertTokens: expandRowTokens(cols, (item, i) => {
            const k = keys.current;
            return k ? String(k(item, i)) : defaultRNKey(item, i);
          }),
        }
        : {}, [cols]);
    useImperativeHandle(props.ref, () => flatHandle(core), []);
    const list: VirtualizedListProps<unknown> = {
      ...props,
      ref: undefined,
      getItem: access.getItem,
      getItemCount: access.getItemCount,
      ...(gridRender
        ? {
          renderItem: gridRender,
          ListItemComponent: null,
          keyExtractor: (items: unknown, row: number) =>
            (items as unknown[]).map((item, k) => {
              const i = row * cols + k;
              const x = keys.current;
              return x ? String(x(item, i)) : defaultRNKey(item, i);
            }).join(":"),
        }
        : {}),
    };
    return h(CoreList, { list, prim, engine, coreRef: core });
  }
  return FlatList;
}
