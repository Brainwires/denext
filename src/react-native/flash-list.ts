/**
 * `@shopify/flash-list` (v2) for React Native mode: `FlashList` on denext's `VirtualList`
 * (`masonry` on `VirtualMasonry`), plus v2's hooks. React Native mode resolves
 * `@shopify/flash-list` to a module that builds `FlashList` from the app's react-native-web
 * primitives with {@linkcode createFlashList} and re-exports the rest of this module (unless
 * `reactNative: { lists: "library" }`). A prebuilt runtime entry (`denext/react-native/flash-list`)
 * sharing the app's one denext instance; not a public entrypoint.
 *
 * Differences from FlashList v2, all deliberate:
 * - no recycling unless the app opts in with `recycleItems` (a denext extra): cells mount per
 *   item, so item state never leaks between items; `useRecyclingState` still resets on `deps`;
 * - `estimatedItemSize` is accepted and ignored, as in v2 (items are measured);
 * - `inverted` is a logical reversal (no transform), `onBlankArea` reports in development only;
 * - `stickyHeaderConfig`'s `backdropComponent`, `hideRelatedCell` and `useNativeDriver`,
 *   `overrideProps`, `maxItemsInRecyclePool` and `optimizeItemArrangement` are accepted and
 *   have no effect.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeType } from "../jsx/types.ts";
import {
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "../runtime/hooks.ts";
import { VirtualMasonry, type VirtualMasonryHandle } from "../client/virtual/virtual-masonry.ts";
import type { VirtualListBlankArea } from "../client/virtual/types.ts";
import { type CoreHandle, CoreList, type EngineOptions, slotElement } from "./lists/virtualized.ts";
import { expandPackedTokens, packedRowRender, type Packing, rowOfItem } from "./lists/grid.ts";
import { resolveStyle } from "./lists/style.ts";
import {
  afterFrames,
  layoutOf,
  packedCoreProps,
  stickyTracker,
  useKeyOf,
  usePacking,
} from "./lists/kit.ts";
import type { OverrideItemLayout } from "./lists/kit.ts";
import type {
  ListPrimitives,
  ListRenderItemInfo as CoreRenderInfo,
  ListScrollProps,
  RNSlot,
  RNStyle,
  ScrollResponder,
  ViewabilityConfig,
  ViewabilityPair,
  ViewableItemsInfo,
  VirtualizedListProps,
} from "./lists/types.ts";

/** No items. */
const EMPTY: readonly never[] = [];

/** Where an item renders (FlashList v2's `RenderTarget`). */
export type RenderTarget = "Cell" | "StickyHeader" | "Measurement";

/** The render targets by name. */
export const RenderTargetOptions: Readonly<Record<string, RenderTarget>> = {
  Cell: "Cell",
  StickyHeader: "StickyHeader",
  Measurement: "Measurement",
};

/** What `renderItem` receives. */
export interface FlashListRenderItemInfo<T> {
  /** The item. */
  readonly item: T;
  /** Its index. */
  readonly index: number;
  /** Always `"Cell"` (sticky items are the real cells). */
  readonly target: RenderTarget;
  /** The list's `extraData`. */
  readonly extraData?: unknown;
}

/** FlashList v2's `renderItem`. */
export type ListRenderItem<T> = (info: FlashListRenderItemInfo<T>) => VNodeChild;

/** FlashList v2's `maintainVisibleContentPosition` (on by default). */
export interface FlashListMaintainVisibleContentPosition {
  /** Turn it off. */
  readonly disabled?: boolean;
  /** Within this many px of the start when items are added there: scroll to the start. */
  readonly autoscrollToTopThreshold?: number;
  /** Within this many px of the end when items are added: scroll to the end (chat). */
  readonly autoscrollToBottomThreshold?: number;
  /** Animate that scroll to the end. */
  readonly animateAutoScrollToBottom?: boolean;
  /** Start at the bottom, bottom-aligning short content. */
  readonly startRenderingFromBottom?: boolean;
}

/** A FlashList v1 blank-area report (development only). */
export interface BlankAreaEvent {
  /** Blank px at the leading edge. */
  readonly offsetStart: number;
  /** Blank px at the trailing edge. */
  readonly offsetEnd: number;
  /** The larger of the two. */
  readonly blankArea: number;
}

/** `FlashList`'s props (v2). */
export interface FlashListProps<T> extends Omit<ListScrollProps, "maintainVisibleContentPosition"> {
  /** Render one item. */
  readonly renderItem: ListRenderItem<T> | null | undefined;
  /** The items. */
  readonly data: readonly T[] | null | undefined;
  /** Wraps each item (receives `cellKey`, `index`, `item`, `children`). */
  readonly CellRendererComponent?: VNodeType;
  /** Rendered between items; receives `leadingItem` and `trailingItem`. */
  readonly ItemSeparatorComponent?: VNodeType | null;
  /** Rendered when there are no items (fills the viewport). */
  readonly ListEmptyComponent?: RNSlot;
  /** The empty state's wrapper style. */
  readonly ListEmptyComponentStyle?: RNStyle;
  /** Rendered after the items. */
  readonly ListFooterComponent?: RNSlot;
  /** The footer's wrapper style. */
  readonly ListFooterComponentStyle?: RNStyle;
  /** Rendered before the items. */
  readonly ListHeaderComponent?: RNSlot;
  /** The header's wrapper style. */
  readonly ListHeaderComponentStyle?: RNStyle;
  /** Px rendered beyond the viewport. */
  readonly drawDistance?: number;
  /** Re-render the items when this changes. */
  readonly extraData?: unknown;
  /** A logical reversal: item 0 at the bottom (no transform). */
  readonly inverted?: boolean | null;
  /** Show this item first. */
  readonly initialScrollIndex?: number | null;
  /** `initialScrollIndex`'s offset. */
  readonly initialScrollIndexParams?: { viewOffset?: number } | null;
  /** An item's key. */
  readonly keyExtractor?: (item: T, index: number) => string;
  /** Columns of a grid. */
  readonly numColumns?: number;
  /** Called near the end. */
  readonly onEndReached?: (() => void) | null;
  /** Distance from the end, in viewports, that fires `onEndReached`. Default 0.5. */
  readonly onEndReachedThreshold?: number | null;
  /** Called once the first items have rendered. */
  readonly onLoad?: (info: { elapsedTimeInMs: number }) => void;
  /** Called with the viewable items when they change. */
  readonly onViewableItemsChanged?: ((info: ViewableItemsInfo<T>) => void) | null;
  /** Pull-to-refresh. */
  readonly onRefresh?: (() => void) | null;
  /** An item's type (cells are reused within a type when `recycleItems` is on). */
  readonly getItemType?: (
    item: T,
    index: number,
    extraData?: unknown,
  ) => string | number | undefined;
  /** Widen a grid item: set `layout.span`. */
  readonly overrideItemLayout?: (
    layout: { span?: number },
    item: T,
    index: number,
    maxColumns: number,
    extraData?: unknown,
  ) => void;
  /** Accepted, no effect. */
  readonly overrideProps?: Record<string, unknown>;
  /** Where the refresh spinner rests. */
  readonly progressViewOffset?: number;
  /** Whether a refresh is running. */
  readonly refreshing?: boolean | null;
  /** When items count as viewable. */
  readonly viewabilityConfig?: ViewabilityConfig | null;
  /** Several configs, each with its own callback. */
  readonly viewabilityConfigCallbackPairs?: readonly ViewabilityPair<T>[];
  /** Accepted, no effect (no recycle pool unless `recycleItems`). */
  readonly maxItemsInRecyclePool?: number;
  /** A masonry layout (`VirtualMasonry`: each item goes to the shortest column). */
  readonly masonry?: boolean;
  /** Accepted: masonry always fills the shortest column. */
  readonly optimizeItemArrangement?: boolean;
  /** Called near the start. */
  readonly onStartReached?: (() => void) | null;
  /** Distance from the start, in viewports, that fires `onStartReached`. */
  readonly onStartReachedThreshold?: number | null;
  /** v2's object form; on by default. */
  readonly maintainVisibleContentPosition?: FlashListMaintainVisibleContentPosition;
  /** Called in a layout effect after each commit. */
  readonly onCommitLayoutEffect?: () => void;
  /** Called when the stuck sticky item changes (`-1`: none). */
  readonly onChangeStickyIndex?: (current: number, previous: number) => void;
  /** Accepted; see the module doc for what applies. */
  readonly stickyHeaderConfig?: {
    useNativeDriver?: boolean;
    offset?: number;
    backdropComponent?: RNSlot;
    zIndex?: number;
    hideRelatedCell?: boolean;
  };
  /** Accepted and ignored, as in v2. */
  readonly estimatedItemSize?: number;
  /** Development only: blank space the viewport showed after a scroll frame. */
  readonly onBlankArea?: (event: BlankAreaEvent) => void;
  /** denext extra: reuse cells within a type (off by default). */
  readonly recycleItems?: boolean;
  /** Receives the ref methods. */
  readonly ref?: Ref<FlashListRef<T>>;
}

/** An item's layout (`getLayout`). */
export interface RVLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Scroll params. */
interface ScrollToParams {
  readonly animated?: boolean;
  readonly viewPosition?: number;
  readonly viewOffset?: number;
}

/** FlashList v2's ref. */
export interface FlashListRef<T> {
  /** The latest props. */
  readonly props: FlashListProps<T>;
  /** Scroll to a content offset. */
  scrollToOffset(params: ScrollToParams & { offset: number; skipFirstItemOffset?: boolean }): void;
  /** Does nothing on the web. */
  flashScrollIndicators(): void;
  /** A `ScrollView`-like object over the scroll element. */
  getNativeScrollRef(): ScrollResponder | null;
  /** Same. */
  getScrollResponder(): ScrollResponder | null;
  /** The scroll element. */
  getScrollableNode(): Element | null;
  /** Scroll to the end. */
  scrollToEnd(params?: { animated?: boolean }): void;
  /** Scroll to the start. */
  scrollToTop(params?: { animated?: boolean }): void;
  /** Scroll item `index` into place, exactly. */
  scrollToIndex(params: ScrollToParams & { index: number }): Promise<void>;
  /** Scroll to an item. */
  scrollToItem(params: ScrollToParams & { item: T }): void;
  /** The header's size (the first item's offset). */
  getFirstItemOffset(): number;
  /** The viewport's size. */
  getWindowSize(): { width: number; height: number };
  /** Item `index`'s layout (measured, else estimated). */
  getLayout(index: number): RVLayout | undefined;
  /** The current content offset. */
  getAbsoluteLastScrollOffset(): number;
  /** The items' extent. */
  getChildContainerDimensions(): { width: number; height: number };
  /** Count as an interaction for `waitForInteraction`. */
  recordInteraction(): void;
  /** The visible items. */
  computeVisibleIndices(): { startIndex: number; endIndex: number };
  /** The first visible item. */
  getFirstVisibleIndex(): number;
  /** Re-report viewability now. */
  recomputeViewableItems(): void;
  /** Does nothing (items animate with the app's own layout animation). */
  prepareForLayoutAnimationRender(): void;
  /** Does nothing (sizes are measured on every change). */
  clearLayoutCacheOnUpdate(): void;
}

/** FlashList's item render, from the core's `{ item, index }`. */
function itemRenderer<T>(props: FlashListProps<T>): (item: unknown, index: number) => VNodeChild {
  const { renderItem, extraData } = props;
  return (item, index) =>
    renderItem ? renderItem({ item: item as T, index, target: "Cell", extraData }) : null;
}

/** The separator after (before, inverted) item row `row`: FlashList's `leadingItem` / `trailingItem`. */
function flashSeparator<T>(
  Separator: VNodeType | null | undefined,
  p: Packing,
  data: readonly T[],
): EngineOptions["separator"] {
  if (!Separator) return undefined;
  return (row, _items, extra) => {
    if (row >= p.rows - 1) return null;
    const last = p.starts[row + 1] - 1;
    return h(Separator, { leadingItem: data[last], trailingItem: data[last + 1], ...extra });
  };
}

/** The engine extras for FlashList's props. */
function flashEngine<T>(
  props: FlashListProps<T>,
  p: Packing,
  keyOf: (item: unknown, i: number) => string,
  onScrollFrame: EngineOptions["onScrollFrame"],
): EngineOptions {
  const mvcp = props.maintainVisibleContentPosition ?? {};
  const data = props.data ?? [];
  const typeOf = props.getItemType;
  const blank = props.onBlankArea;
  return {
    separator: flashSeparator(props.ItemSeparatorComponent, p, data),
    convertTokens: p.cols > 1 ? expandPackedTokens(p, keyOf) : undefined,
    typeOf: typeOf
      ? (row) => typeOf(data[p.starts[row]], p.starts[row], props.extraData) ?? 0
      : undefined,
    recycle: props.recycleItems === true,
    overscan: props.drawDistance,
    mvcp: mvcp.disabled !== true,
    anchorEnd: mvcp.startRenderingFromBottom === true,
    autoscrollStart: mvcp.disabled ? undefined : mvcp.autoscrollToTopThreshold,
    autoscrollEnd: mvcp.disabled ? undefined : mvcp.autoscrollToBottomThreshold,
    autoscrollSmooth: mvcp.animateAutoScrollToBottom,
    threshold: 0.5,
    emptyStyle: props.ListEmptyComponentStyle,
    onBlankArea: blank
      ? (b: VirtualListBlankArea) =>
        blank({ offsetStart: b.before, offsetEnd: b.after, blankArea: Math.max(b.before, b.after) })
      : undefined,
    onScrollFrame,
    onMount: initialOffset(props, p),
  };
}

/** `initialScrollIndexParams.viewOffset`, applied after the first commit. */
function initialOffset<T>(props: FlashListProps<T>, p: Packing): EngineOptions["onMount"] {
  const index = props.initialScrollIndex;
  const viewOffset = props.initialScrollIndexParams?.viewOffset;
  if (index === null || index === undefined || !viewOffset) return undefined;
  return (h) => h.scrollToIndex({ index: rowOfItem(p, index), viewOffset, animated: false });
}

/** The core props for FlashList's props. */
function coreListProps<T>(
  props: FlashListProps<T>,
  p: Packing,
  render: (info: CoreRenderInfo<unknown>) => VNodeChild,
  keyOf: (item: unknown, i: number) => string,
): VirtualizedListProps<unknown> {
  return {
    ...(props as unknown as VirtualizedListProps<unknown>),
    ...packedCoreProps(props, props.initialScrollIndex, p, render, keyOf),
    viewabilityConfig: props.viewabilityConfig ?? undefined,
  };
}

/** The FlashList ref over the core. */
function flashHandle<T>(
  core: { current: CoreHandle | null },
  latest: { current: { props: FlashListProps<T>; packing: Packing } },
): FlashListRef<T> {
  const c = () => core.current;
  const engine = () => c()?.engine() ?? null;
  const rowOf = (i: number) => rowOfItem(latest.current.packing, i);
  const firstVisible = (): number => {
    const r = engine()?.getRange();
    if (!r || r.last < r.first || !c()) return -1;
    const rows = [c()!.visual(r.first), c()!.visual(r.last)];
    return latest.current.packing.starts[Math.min(...rows)];
  };
  return {
    get props() {
      return latest.current.props;
    },
    scrollToOffset: (params) => c()?.scrollToOffset(params),
    flashScrollIndicators() {},
    getNativeScrollRef: () => c()?.getScrollResponder() ?? null,
    getScrollResponder: () => c()?.getScrollResponder() ?? null,
    getScrollableNode: () => c()?.getScrollableNode() ?? null,
    scrollToEnd: (params) => c()?.scrollToEnd(params),
    scrollToTop: (params) => c()?.scrollToOffset({ offset: 0, animated: params?.animated }),
    scrollToIndex(params) {
      c()?.scrollToIndex({ ...params, index: rowOf(params.index) });
      return afterFrames();
    },
    scrollToItem(params) {
      const i = (latest.current.props.data ?? []).indexOf(params.item);
      if (i >= 0) c()?.scrollToIndex({ ...params, index: rowOf(i) });
    },
    getFirstItemOffset: () => -(engine()?.getScrollMetrics().min ?? 0),
    getWindowSize: () => windowSize(c()?.getScrollableNode() ?? null),
    getLayout: (index) => layoutOf(c(), latest.current.packing, index),
    getAbsoluteLastScrollOffset: () => {
      const m = engine()?.getScrollMetrics();
      return m ? m.offset - m.min : 0;
    },
    getChildContainerDimensions: () => ({
      width: windowSize(c()?.getScrollableNode() ?? null).width,
      height: engine()?.getScrollMetrics().rows ?? 0,
    }),
    recordInteraction: () => c()?.recordInteraction(),
    computeVisibleIndices: () => visibleItems(c(), latest.current.packing),
    getFirstVisibleIndex: firstVisible,
    recomputeViewableItems: () => c()?.recordInteraction(),
    prepareForLayoutAnimationRender() {},
    clearLayoutCacheOnUpdate() {},
  };
}

/** The scroll element's size. */
function windowSize(node: Element | null): { width: number; height: number } {
  const el = node as { clientWidth?: number; clientHeight?: number } | null;
  return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 };
}

/** The visible items (data indices). */
function visibleItems(
  core: CoreHandle | null,
  p: Packing,
): { startIndex: number; endIndex: number } {
  const r = core?.engine()?.getRange();
  if (!core || !r || r.last < r.first) return { startIndex: -1, endIndex: -1 };
  const a = core.visual(r.first);
  const b = core.visual(r.last);
  return { startIndex: p.starts[Math.min(a, b)], endIndex: p.starts[Math.max(a, b) + 1] - 1 };
}

/** Hook: `onLoad` once, `onCommitLayoutEffect` after every commit. */
function useCommitCallbacks<T>(props: FlashListProps<T>): void {
  const start = useRef(typeof performance === "undefined" ? 0 : performance.now());
  const loaded = useRef(false);
  useLayoutEffect(() => {
    props.onCommitLayoutEffect?.();
    if (loaded.current || !props.onLoad) return;
    loaded.current = true;
    const now = typeof performance === "undefined" ? 0 : performance.now();
    props.onLoad({ elapsedTimeInMs: now - start.current });
  });
}

/** FlashList's `masonry` layout on `VirtualMasonry`. */
function renderMasonry<T>(
  props: FlashListProps<T>,
  prim: ListPrimitives,
  masonryRef: Ref<VirtualMasonryHandle>,
): VNode {
  const style = resolveStyle(prim.StyleSheet, props.style);
  const render = itemRenderer(props);
  return h(VirtualMasonry as unknown as VNodeType, {
    ref: masonryRef,
    data: props.data ?? [],
    numColumns: Math.max(1, Math.floor(props.numColumns ?? 1)),
    renderItem: render,
    keyExtractor: props.keyExtractor,
    overscan: props.drawDistance,
    onEndReached: props.onEndReached ?? undefined,
    onEndReachedThreshold: props.onEndReachedThreshold ?? undefined,
    ListHeaderComponent: slotElement(props.ListHeaderComponent),
    ListFooterComponent: slotElement(props.ListFooterComponent),
    ListEmptyComponent: slotElement(props.ListEmptyComponent),
    class: style.class,
    style: { flexGrow: 1, flexShrink: 1, minHeight: 0, ...style.style },
  });
}

/** The masonry ref: the FlashList methods `VirtualMasonry` can back. */
function masonryHandle<T>(
  m: { current: VirtualMasonryHandle | null },
  latest: { current: { props: FlashListProps<T> } },
): Partial<FlashListRef<T>> {
  return {
    get props() {
      return latest.current.props;
    },
    scrollToIndex(params) {
      m.current?.scrollToIndex(params.index, {
        behavior: params.animated === false ? undefined : "smooth",
      });
      return afterFrames();
    },
    scrollToOffset: (params) =>
      m.current?.scrollToOffset(params.offset, {
        behavior: params.animated === false ? undefined : "smooth",
      }),
    scrollToTop: () => m.current?.scrollToOffset(0),
    flashScrollIndicators() {},
    recordInteraction() {},
  };
}

/**
 * FlashList v2 on denext's `VirtualList`, rendering with react-native-web's primitives.
 *
 * @param prim react-native-web's primitives (React Native mode passes the app's own).
 * @returns The `FlashList` component.
 */
export function createFlashList(prim: ListPrimitives): (props: FlashListProps<unknown>) => VNode {
  function FlashList(props: FlashListProps<unknown>): VNode {
    const core = useRef<CoreHandle | null>(null);
    const masonry = useRef<VirtualMasonryHandle | null>(null);
    const packing = usePacking(
      props.data ?? EMPTY,
      props.numColumns,
      props.overrideItemLayout as OverrideItemLayout | undefined,
      props.extraData,
    );
    const latest = useRef({ props, packing });
    latest.current = { props, packing };
    const keyOf = useKeyOf(props.keyExtractor);
    useImperativeHandle(
      props.ref as Ref<unknown>,
      () => props.masonry ? masonryHandle(masonry, latest) : flashHandle(core, latest),
      [props.masonry],
    );
    useCommitCallbacks(props);
    const sticky = useMemo(
      () => stickyTracker(core, packing, props.stickyHeaderIndices, props.onChangeStickyIndex),
      [packing, props.stickyHeaderIndices, props.onChangeStickyIndex],
    );
    const { renderItem, extraData } = props;
    const render = useMemo(() => {
      const one = itemRenderer(props);
      return packing.cols > 1
        ? packedRowRender(prim.View, packing, (item, i) => one(item, i))
        : (info: { item: unknown; index: number }) => one(info.item, info.index);
    }, [renderItem, extraData, packing]);
    if (props.masonry) return renderMasonry(props, prim, masonry);
    const engine = flashEngine(props, packing, keyOf, sticky);
    const list = coreListProps(props, packing, render, keyOf);
    return h(CoreList, { list, prim, engine, coreRef: core });
  }
  return FlashList;
}

/** `useRecyclingState`'s setter. */
type SetState<T> = (value: T | ((prev: T) => T)) => void;

/** Whether two dependency lists hold the same values. */
function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * State that resets to `initialState` when `deps` change (FlashList v2's hook for recycled
 * cells; here cells are not recycled unless `recycleItems` is on, and the reset works either
 * way). `onReset` runs when it resets.
 *
 * @param initialState The initial value, or a function returning it.
 * @param deps Reset when any of these change (usually the item's id).
 * @param onReset Called on a reset.
 * @returns The value and its setter.
 */
export function useFlashRecyclingState<T>(
  initialState: T | (() => T),
  deps: readonly unknown[],
  onReset?: () => void,
): [T, SetState<T>] {
  const box = useRef<{ value: T; deps: readonly unknown[] } | null>(null);
  const [, force] = useReducer((n: number) => n + 1, 0);
  if (box.current === null || !sameDeps(box.current.deps, deps)) {
    const reset = box.current !== null;
    const value = typeof initialState === "function" ? (initialState as () => T)() : initialState;
    box.current = { value, deps };
    if (reset) onReset?.();
  }
  const set = useCallback<SetState<T>>((next) => {
    const b = box.current!;
    const value = typeof next === "function" ? (next as (prev: T) => T)(b.value) : next;
    if (Object.is(value, b.value)) return;
    b.value = value;
    force(0);
  }, []);
  return [box.current.value, set];
}

/**
 * State whose change re-lays the list out in FlashList; here items are measured on every size
 * change, so it is `useState`.
 *
 * @param initialState The initial value, or a function returning it.
 * @returns The value and its setter.
 */
export function useLayoutState<T>(initialState: T | (() => T)): [T, SetState<T>] {
  return useState<T>(initialState);
}

/**
 * FlashList's key helper for `.map()` inside items: the item's key (or the index).
 *
 * @returns `{ getMappingKey }`.
 */
export function useMappingHelper(): {
  getMappingKey: (itemKey: string | number | bigint, index: number) => string | number | bigint;
} {
  return useMemo(() => ({ getMappingKey: (itemKey, index) => itemKey ?? index }), []);
}

/**
 * FlashList's list context for nested lists. denext's lists need no parent coordination, so
 * there is none: always `undefined`.
 *
 * @returns `undefined`.
 */
export function useFlashListContext(): undefined {
  return undefined;
}

/** Props of {@linkcode LayoutCommitObserver}. */
export interface LayoutCommitObserverProps {
  /** Called after the lists inside have committed. */
  readonly onCommitLayoutEffect?: () => void;
  /** The content. */
  readonly children?: VNodeChild;
}

/**
 * Calls `onCommitLayoutEffect` in a layout effect after each commit of its children (FlashList's
 * observer; denext's lists commit synchronously, so this is after their layout).
 *
 * @param props The callback and the children.
 * @returns The children.
 */
export function LayoutCommitObserver(props: LayoutCommitObserverProps): VNode {
  useLayoutEffect(() => {
    props.onCommitLayoutEffect?.();
  });
  return props.children as VNode;
}
