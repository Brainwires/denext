/**
 * `@legendapp/list` for React Native mode: `LegendList` on denext's `VirtualList`, with its
 * hooks. React Native mode resolves `@legendapp/list` and `@legendapp/list/react-native` to a
 * module that builds `LegendList` from the app's react-native-web primitives with
 * {@linkcode createLegendList} and re-exports the hooks (unless
 * `reactNative: { lists: "library" }`); `@legendapp/list/react` (the DOM build) resolves to
 * `src/lists/legend-list.ts` (the same component over DOM primitives) only with the top-level
 * `lists: "denext"`. A prebuilt runtime entry (`denext/react-native/legend-list`); not a public
 * entrypoint.
 *
 * Differences, all deliberate: `recycleItems` maps to the engine's cell reuse (off by default,
 * as in LegendList); `getFixedItemSize` / `getEstimatedItemSize` / `estimatedItemSize` are
 * estimates the engine confirms by measuring; `waitForInitialLayout` and `itemsAreEqual` have no
 * effect (the first window renders at once; items re-render on their props); the state's
 * `listen` reports `totalSize`, `headerSize`, `footerSize`, `anchoredEndSpaceSize`,
 * `isAtEnd` / `isAtStart` / `isNearEnd` / `isNearStart`,
 * `isWithinMaintainScrollAtEndThreshold`, `lastItemKeys`, `numContainers`, `otherAxisSize`,
 * `readyToRender` and `activeStickyIndex` (after each commit, scroll frame and measurement,
 * when the value changed); any other type never calls back.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeType } from "../jsx/types.ts";
import { createContext } from "../runtime/context.ts";
import {
  type Context,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "../runtime/hooks.ts";
import type { ViewToken, VirtualListScrollEvent } from "../client/virtual/types.ts";
import { type CoreHandle, CoreList, type EngineOptions } from "./lists/virtualized.ts";
import { expandPackedTokens, packedRowRender, type Packing, rowOfItem } from "./lists/grid.ts";
import {
  afterFrames,
  layoutOf,
  type OverrideItemLayout,
  packedCoreProps,
  stickyTracker,
  useKeyOf,
  usePacking,
} from "./lists/kit.ts";
import {
  type AnchoredEndSpaceConfig,
  anchorRows,
  type LegendListMetrics,
  useAnchoredEndSpace,
  useSlotMetrics,
} from "./lists/legend-extras.ts";
import type {
  ListPrimitives,
  ListRenderItemInfo as CoreRenderInfo,
  ListScrollProps,
  RNSlot,
  RNStyle,
  ScrollComponentProps,
  ScrollResponder,
  ViewabilityConfig,
  ViewabilityPair,
  VirtualizedListProps,
} from "./lists/types.ts";

export type {
  AnchoredEndSpaceConfig,
  AnchoredEndSpaceReadyInfo,
  LegendListMetrics,
} from "./lists/legend-extras.ts";

/** What LegendList's `renderItem` receives. */
export interface LegendListRenderItemProps<T> {
  readonly item: T;
  readonly index: number;
  readonly type: string | number | undefined;
  readonly data: readonly T[];
  readonly extraData: unknown;
}

/** LegendList's `onViewableItemsChanged` info (the React Native form plus the ranges). */
export interface OnViewableItemsChangedInfo<T> {
  readonly viewableItems: ViewToken<T>[];
  readonly changed: ViewToken<T>[];
  readonly start: number;
  readonly end: number;
  readonly startBuffered: number;
  readonly endBuffered: number;
}

/** `maintainScrollAtEnd`'s options. */
export interface MaintainScrollAtEndOptions {
  /** Animate the scroll to the end. */
  readonly animated?: boolean;
  /**
   * Which changes keep a list at its end pinned there: new data (`dataChange`), an item's size
   * (`itemLayout`), the list's size (`layout`) and the footer's (`footerLayout`). Omitted, all
   * do; given, only the keys set to `true` (LegendList's rule), and any other change keeps the
   * visible items in place (`footerLayout: false`: a chat's composer growing leaves the messages
   * where they are).
   */
  readonly on?: {
    readonly dataChange?: boolean;
    readonly itemLayout?: boolean;
    readonly layout?: boolean;
    readonly footerLayout?: boolean;
  };
}

/**
 * `maintainScrollAtEnd` as the engine's `pinEndOn`: undefined (every change pins) for `true` or
 * an object without `on`; with `on`, only its `true` keys; with `false` or no
 * `maintainScrollAtEnd`, nothing pins (the list opens at the end with `initialScrollAtEnd` and
 * is not followed after, as LegendList's).
 */
function pinTriggers(
  atEnd: LegendListProps<unknown>["maintainScrollAtEnd"],
): EngineOptions["pinEndOn"] {
  if (!atEnd) return { data: false, items: false, layout: false, footer: false };
  if (typeof atEnd !== "object" || !("on" in atEnd)) return undefined;
  const on = atEnd.on ?? {};
  return {
    data: on.dataChange === true,
    items: on.itemLayout === true,
    layout: on.layout === true,
    footer: on.footerLayout === true,
  };
}

/** `LegendList`'s props (3.x, plus the v1 names still in use). */
export interface LegendListProps<T>
  extends Omit<ListScrollProps, "maintainVisibleContentPosition"> {
  /** The items (or `children`). */
  readonly data?: readonly T[];
  /** Render one item. */
  readonly renderItem?: (props: LegendListRenderItemProps<T>) => VNodeChild;
  /** Children mode: each child is an item. */
  readonly children?: VNodeChild | VNodeChild[];
  /** Bottom-align short content (a chat). */
  readonly alignItemsAtEnd?: boolean;
  /**
   * Keep item `anchorIndex` at the viewport's start (plus `anchorOffset`) by adding room after
   * the last item while the items from the anchor on are shorter than the viewport: a sent chat
   * message stays at the top while the reply streams in below it. The room is the viewport
   * minus the anchor's and the following items' sizes (the anchor's capped at
   * `anchorMaxSize`), the footer and the content's end padding; `onSizeChanged` reports it and
   * `onReady` fires once every item from the anchor on has a known size. Those items stay
   * rendered. One column only, as in LegendList.
   */
  readonly anchoredEndSpace?: AnchoredEndSpaceConfig;
  /** Items kept rendered while scrolled away. */
  readonly alwaysRender?: {
    top?: number;
    bottom?: number;
    indices?: number[];
    keys?: string[];
  };
  /** Grid gaps. */
  readonly columnWrapperStyle?: { rowGap?: number; gap?: number; columnGap?: number };
  /** Re-render the items when this changes. */
  readonly dataKey?: string | number;
  /** Re-render the items when this changes. */
  readonly dataVersion?: string | number;
  /** Px rendered beyond the viewport (default 250, LegendList's own). */
  readonly drawDistance?: number;
  /** One size estimate. */
  readonly estimatedItemSize?: number;
  /** Px of room after the last item on top of the content's own end padding (the web build's). */
  readonly contentInsetEndAdjustment?: number;
  /**
   * The content's insets: the end one (`bottom`, or `right` when horizontal) is room after the
   * last item, as `contentInsetEndAdjustment` is; the start ones are accepted, no effect.
   */
  readonly contentInset?: { top?: number; left?: number; bottom?: number; right?: number };
  /** The viewport's size before layout. */
  readonly estimatedListSize?: { height: number; width: number };
  /** Re-render the items when this changes. */
  readonly extraData?: unknown;
  /** Known item sizes (read as estimates; items are measured). */
  readonly getFixedItemSize?: (
    item: T,
    index: number,
    type: string | undefined,
  ) => number | undefined;
  /** v1: a per-item estimate. */
  readonly getEstimatedItemSize?: (index: number, item: T) => number;
  /** An item's type (cells are reused within a type with `recycleItems`). */
  readonly getItemType?: (item: T, index: number) => string | undefined;
  /** Rendered between items; receives `leadingItem`. */
  readonly ItemSeparatorComponent?: VNodeType | null;
  /** Start at the end. */
  readonly initialScrollAtEnd?: boolean;
  /** Show this item first. */
  readonly initialScrollIndex?: number | {
    index: number;
    viewOffset?: number;
    viewPosition?: number;
  };
  /** Start at this offset. */
  readonly initialScrollOffset?: number;
  /** Accepted, no effect. */
  readonly itemsAreEqual?: (a: T, b: T, index: number, data: readonly T[]) => boolean;
  /** An item's key. */
  readonly keyExtractor?: (item: T, index: number) => string;
  /** Rendered when there are no items. */
  readonly ListEmptyComponent?: RNSlot;
  /** Rendered after the items. */
  readonly ListFooterComponent?: RNSlot;
  /** The footer's wrapper style. */
  readonly ListFooterComponentStyle?: RNStyle;
  /** Rendered before the items. */
  readonly ListHeaderComponent?: RNSlot;
  /** The header's wrapper style. */
  readonly ListHeaderComponentStyle?: RNStyle;
  /** Accepted: the header is measured. */
  readonly estimatedHeaderSize?: number;
  /** Stay at the end while there (data changes, resizes). */
  readonly maintainScrollAtEnd?: boolean | MaintainScrollAtEndOptions;
  /** "At the end" within this share of the viewport. Default 0.1. */
  readonly maintainScrollAtEndThreshold?: number;
  /** Keep the visible items in place on changes above them. Default `true`. */
  readonly maintainVisibleContentPosition?: boolean | Record<string, unknown>;
  /** Grid columns. */
  readonly numColumns?: number;
  /** Accepted: direction follows the document. */
  readonly rtl?: boolean;
  /** Called near the end. */
  readonly onEndReached?: ((info: { distanceFromEnd: number }) => void) | null;
  /** Share of the viewport from the end that fires `onEndReached`. Default 0.5. */
  readonly onEndReachedThreshold?: number | null;
  /**
   * Called when an item's measured size changes (its first measurement included, when it
   * differs from the estimate): the new `size`, the `previous` one, and the item. In a grid an
   * item reports its row's size.
   */
  readonly onItemSizeChanged?: (info: {
    size: number;
    previous: number;
    index: number;
    itemKey: string;
    itemData: T;
  }) => void;
  /** Called once the first items rendered. */
  readonly onLoad?: (info: { elapsedTimeInMs: number }) => void;
  /** Called with the header's and footer's sizes on mount and whenever one changes. */
  readonly onMetricsChange?: (metrics: LegendListMetrics) => void;
  /** Called once the list is laid out. */
  readonly onReady?: () => void;
  /** Called when the first visible item changes. */
  readonly onFirstVisibleItemChanged?: (info: { index: number; item: T; key: string }) => void;
  /** Pull-to-refresh. */
  readonly onRefresh?: () => void;
  /** Called near the start. */
  readonly onStartReached?: ((info: { distanceFromStart: number }) => void) | null;
  /** Share of the viewport from the start that fires `onStartReached`. */
  readonly onStartReachedThreshold?: number | null;
  /** Called when the stuck sticky item changes. */
  readonly onStickyHeaderChange?: (info: { index: number; item: unknown }) => void;
  /** Called with the viewable items when they change. */
  readonly onViewableItemsChanged?: ((info: OnViewableItemsChangedInfo<T>) => void) | null;
  /** Widen a grid item: set `layout.span`. */
  readonly overrideItemLayout?: (
    layout: { span?: number },
    item: T,
    index: number,
    maxColumns: number,
    extraData?: unknown,
  ) => void;
  /** Where the refresh spinner rests. */
  readonly progressViewOffset?: number;
  /** Reuse cells within a type. */
  readonly recycleItems?: boolean;
  /** Receives the scroll view (a `ScrollView`-like object over the scroll element). */
  readonly refScrollView?: Ref<ScrollResponder>;
  /** Whether a refresh is running. */
  readonly refreshing?: boolean;
  /**
   * Render the scroll view yourself: called with the scroll-view props (with the `ref` and the
   * items as `children`); see `VirtualizedList`'s `renderScrollComponent`.
   */
  readonly renderScrollComponent?: (props: ScrollComponentProps) => VNode | null;
  /**
   * Items that are snap points: a fling comes to rest with one of them at the viewport's start
   * (CSS scroll snap on the items, as LegendList turns them into `snapToOffsets`). The content's
   * start and end snap too unless `snapToStart` / `snapToEnd` is `false`.
   */
  readonly snapToIndices?: number[];
  /** When items count as viewable. */
  readonly viewabilityConfig?: ViewabilityConfig;
  /** Several configs, each with its own callback. */
  readonly viewabilityConfigCallbackPairs?: readonly ViewabilityPair<T>[];
  /** Accepted; `offset` and `backdropComponent` have no effect. */
  readonly stickyHeaderConfig?: { offset?: number; backdropComponent?: RNSlot };
  /** Scroll the page instead of the list's own element. */
  readonly useWindowScroll?: boolean;
  /** v1: accepted, no effect (the first window renders at once). */
  readonly waitForInitialLayout?: boolean;
  /** Receives the ref methods. */
  readonly ref?: Ref<LegendListRef>;
}

/** What `getState()` returns. */
export interface LegendListState {
  readonly activeStickyIndex: number;
  readonly contentLength: number;
  readonly data: readonly unknown[];
  readonly elementAtIndex: (index: number) => Element | null | undefined;
  readonly end: number;
  readonly endBuffered: number;
  readonly isAtEnd: boolean;
  readonly isAtStart: boolean;
  readonly isNearEnd: boolean;
  readonly isNearStart: boolean;
  readonly isEndReached: boolean;
  readonly isStartReached: boolean;
  readonly isWithinMaintainScrollAtEndThreshold: boolean;
  readonly getAverageItemSizes: () => Record<string, { average: number; count: number }>;
  readonly indexByKey: (key: string) => number | undefined;
  readonly listen: (type: string, callback: (value: unknown) => void) => () => void;
  readonly listenToPosition: (key: string, callback: (value: number) => void) => () => void;
  readonly positionAtIndex: (index: number) => number;
  readonly positionByKey: (key: string) => number | undefined;
  readonly scroll: number;
  readonly scrollLength: number;
  readonly scrollVelocity: number;
  readonly sizeAtIndex: (index: number) => number;
  readonly sizes: Map<string, number>;
  readonly start: number;
  readonly startBuffered: number;
}

/** One `listen` type's subscribers and the value they last heard. */
interface Listening<V> {
  readonly cbs: Set<(value: V) => void>;
  last: V;
}

/**
 * The `getState().listen` / `listenToPosition` subscribers of one list, told about changes after
 * each commit, scroll frame and measurement (see {@linkcode notifyListeners}).
 */
interface ListenHub {
  readonly types: Map<string, Listening<unknown>>;
  readonly positions: Map<string, Listening<number | undefined>>;
  /** A notify is queued (measurements coalesce into one microtask). */
  queued: boolean;
}

/** A new, empty hub. */
function listenHub(): ListenHub {
  return { types: new Map(), positions: new Map(), queued: false };
}

/** Scroll params. */
interface ScrollIndexParams {
  readonly animated?: boolean;
  readonly index: number;
  readonly viewOffset?: number;
  readonly viewPosition?: number;
}

/** LegendList's ref (the DOM build's scroll-view getters return the scroll element). */
export interface LegendListRef {
  /** Does nothing (sizes are measured on every change). */
  clearCaches(options?: { mode?: "sizes" | "full" }): void;
  /** Does nothing on the web. */
  flashScrollIndicators(): void;
  /** A `ScrollView`-like object over the scroll element. */
  getNativeScrollRef(): ScrollResponder | null;
  /** Same. */
  getAnimatableRef(): ScrollResponder | null;
  /** The scroll element. */
  getScrollableNode(): Element | null;
  /** Same as `getNativeScrollRef()`. */
  getScrollResponder(): ScrollResponder | null;
  /** The list's state now. */
  getState(): LegendListState;
  /** Does nothing. */
  reportContentInset(inset?: Record<string, number> | null): void;
  /** Scroll item `index` into view with the least movement. */
  scrollIndexIntoView(params: { animated?: boolean; index: number }): Promise<void>;
  /** Scroll an item into view with the least movement. */
  scrollItemIntoView(params: { animated?: boolean; item: unknown }): Promise<void>;
  /** Scroll to the end. */
  scrollToEnd(options?: { animated?: boolean; viewOffset?: number }): Promise<void>;
  /** Scroll item `index` into place, exactly. */
  scrollToIndex(params: ScrollIndexParams): Promise<void>;
  /** Scroll to an item. */
  scrollToItem(params: Omit<ScrollIndexParams, "index"> & { item: unknown }): Promise<void>;
  /** Scroll to a content offset. */
  scrollToOffset(params: { offset: number; animated?: boolean }): Promise<void>;
  /** Does nothing (items are measured). */
  setItemSize(itemKey: string, size: { height: number; width: number }): void;
  /** Does nothing. */
  setScrollProcessingEnabled(enabled: boolean): void;
  /** Does nothing. */
  setVisibleContentAnchorOffset(value: number | ((value: number) => number)): void;
}

/** A viewability token as `useViewability` receives it. */
export interface LegendViewToken<T = unknown> extends ViewToken<T> {
  /** The cell (its index). */
  readonly containerId: number;
}

/** `useViewabilityAmount`'s token. */
export interface ViewAmountToken<T = unknown> extends LegendViewToken<T> {
  readonly percentOfScroller: number;
  readonly percentVisible: number;
  readonly scrollSize: number;
  readonly size: number;
  readonly sizeVisible: number;
}

/** A recycled cell's state (`useRecyclingState` / `useRecyclingEffect`). */
export interface LegendListRecyclingState<T> {
  readonly index: number;
  readonly item: T;
  readonly prevIndex: number | undefined;
  readonly prevItem: T | undefined;
}

/** The per-list bus the cells' hooks subscribe to. */
interface Bus {
  readonly core: { current: CoreHandle | null };
  readonly view: Map<string, Set<(t: LegendViewToken) => void>>;
  readonly amount: Map<
    string,
    Set<{ index: () => number; item: () => unknown; cb: (t: ViewAmountToken) => void }>
  >;
  /** Re-render the list so it starts reporting viewability (the first subscriber). */
  want: () => void;
}

/** A cell's context. */
interface CellInfo {
  readonly bus: Bus | null;
  readonly index: number;
  readonly item: unknown;
  readonly key: string;
  readonly count: number;
}

let cellContext: Context<CellInfo> | undefined;

/** The cell context (created on first use). */
function cellCtx(): Context<CellInfo> {
  return cellContext ??= createContext<CellInfo>({
    bus: null,
    index: -1,
    item: undefined,
    key: "",
    count: 0,
  });
}

/** The children of children mode, as items. */
function childItems(children: LegendListProps<unknown>["children"]): unknown[] {
  if (children === undefined || children === null || children === false) return [];
  return (Array.isArray(children) ? children : [children]).flat(Infinity as 1);
}

/** The initial index (either form). */
function initialIndexOf(props: LegendListProps<unknown>): number | undefined {
  const i = props.initialScrollIndex;
  return typeof i === "object" && i !== null ? i.index : i;
}

/** The first-commit scroll LegendList's props ask for beyond an index. */
function legendMount(
  props: LegendListProps<unknown>,
  p: Packing,
  dom: boolean,
): EngineOptions["onMount"] {
  const i = props.initialScrollIndex;
  const offset = props.initialScrollOffset;
  const ref = props.refScrollView as Ref<unknown> | undefined;
  return (h) => {
    if (ref) assignRef(ref, scrollViewOf(h, dom));
    if (typeof i === "object" && i !== null && (i.viewOffset || i.viewPosition)) {
      h.scrollToIndex({ ...i, index: rowOfItem(p, i.index), animated: false });
    } else if (offset !== undefined && i === undefined) {
      h.scrollToOffset({ offset, animated: false });
    }
    props.onReady?.();
  };
}

/** What `refScrollView` receives: the scroll element (the DOM build), else a `ScrollView`. */
function scrollViewOf(h: CoreHandle, dom: boolean): unknown {
  return dom ? h.getScrollableNode() : h.getScrollResponder();
}

/** Set a ref. */
function assignRef<T>(ref: Ref<T>, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/** `alwaysRender` as the engine rows' keys. */
function keptRows(
  props: LegendListProps<unknown>,
  data: readonly unknown[],
  p: Packing,
  rowKey: (row: number) => string,
): string[] | undefined {
  const a = props.alwaysRender ?? (props.anchoredEndSpace ? {} : undefined);
  if (!a) return undefined;
  const rows = new Set<number>(anchorRows(props.anchoredEndSpace, data.length, p));
  for (let i = 0; i < Math.min(a.top ?? 0, data.length); i++) rows.add(rowOfItem(p, i));
  for (let i = Math.max(0, data.length - (a.bottom ?? 0)); i < data.length; i++) {
    rows.add(rowOfItem(p, i));
  }
  for (const i of a.indices ?? []) if (i >= 0 && i < data.length) rows.add(rowOfItem(p, i));
  return [...rows].map(rowKey).concat(a.keys ?? []);
}

/**
 * LegendList's default `drawDistance`: px rendered beyond the viewport. The engine's own default
 * is a whole viewport each side, which renders a chat opened at the end with half again as many
 * rows as LegendList does.
 */
const DRAW_DISTANCE = 250;

/** The engine extras for LegendList's props. */
function legendEngine(
  props: LegendListProps<unknown>,
  data: readonly unknown[],
  p: Packing,
  keyOf: (item: unknown, i: number) => string,
  wrapCell: EngineOptions["wrapCell"],
  onScrollFrame: EngineOptions["onScrollFrame"],
  dom = false,
): EngineOptions {
  const atEnd = props.maintainScrollAtEnd;
  const threshold = props.maintainScrollAtEndThreshold ?? 0.1;
  const pinEndOn = pinTriggers(atEnd);
  const fixed = props.getFixedItemSize;
  const est = props.getEstimatedItemSize;
  const typeOf = props.getItemType;
  const Separator = props.ItemSeparatorComponent;
  return {
    separator: Separator
      ? (row, _i, extra) =>
        row < p.rows - 1
          ? h(Separator, { leadingItem: data[p.starts[row + 1] - 1], ...extra })
          : null
      : undefined,
    convertTokens: p.cols > 1 ? expandPackedTokens(p, keyOf) : undefined,
    typeOf: typeOf ? (row) => typeOf(data[p.starts[row]], p.starts[row]) ?? 0 : undefined,
    estimatedSize: fixed || est
      ? (row) => {
        const i = p.starts[row];
        const type = typeOf?.(data[i], i);
        return fixed?.(data[i], i, type) ?? est?.(i, data[i]) ?? props.estimatedItemSize ?? 48;
      }
      : undefined,
    estimatedItemSize: props.estimatedItemSize,
    recycle: props.recycleItems === true,
    overscan: props.drawDistance ?? DRAW_DISTANCE,
    mvcp: props.maintainVisibleContentPosition !== false,
    anchorEnd: props.alignItemsAtEnd === true || props.initialScrollAtEnd === true,
    // New data scrolls to the end unless `on` leaves `dataChange` out.
    autoscrollEnd: atEnd && pinEndOn?.data !== false
      ? (viewport: number) => threshold * viewport
      : undefined,
    autoscrollSmooth: typeof atEnd === "object" && atEnd.animated === true,
    pinEndOn,
    threshold: 0.5,
    wrapCell,
    onScrollFrame,
    onMount: legendMount(props, p, dom),
    keepMounted: keptRows(
      props,
      data,
      p,
      (row) =>
        p.cols === 1
          ? keyOf(data[row], row)
          : data.slice(p.starts[row], p.starts[row + 1]).map((it, k) =>
            keyOf(it, p.starts[row] + k)
          )
            .join(":"),
    ),
    viewportSize: props.estimatedListSize
      ? props.horizontal ? props.estimatedListSize.width : props.estimatedListSize.height
      : undefined,
    windowScroll: props.useWindowScroll === true,
  };
}

/** A cell providing its index, item and the list's bus to the hooks inside it. */
function LegendCell(
  props: {
    bus: Bus;
    index: number;
    item: unknown;
    itemKey: string;
    count: number;
    children?: VNodeChild;
  },
): VNode {
  const Ctx = cellCtx();
  const value = useMemo(
    (): CellInfo => ({
      bus: props.bus,
      index: props.index,
      item: props.item,
      key: props.itemKey,
      count: props.count,
    }),
    [props.bus, props.index, props.item, props.itemKey, props.count],
  );
  return h(Ctx, { value }, props.children);
}

/** A viewability token for LegendList's hooks. */
function viewToken(t: ViewToken<unknown>): LegendViewToken {
  return { ...t, containerId: t.index ?? -1 };
}

/** Dispatch viewability changes to the cells' `useViewability` subscribers. */
function dispatchViewability(bus: Bus, changed: ViewToken<unknown>[]): void {
  for (const t of changed) {
    for (const cb of bus.view.get(t.key) ?? []) cb(viewToken(t));
  }
}

/** Report every `useViewabilityAmount` subscriber's visible share. */
function dispatchAmounts(bus: Bus, p: Packing): void {
  const core = bus.core.current;
  const m = core?.engine()?.getScrollMetrics();
  if (!core || !m) return;
  for (const [key, subs] of bus.amount) {
    for (const sub of subs) {
      const box = layoutOf(core, p, sub.index());
      if (!box) continue;
      const visible = Math.max(
        0,
        Math.min(box.y + box.height, m.offset + m.viewport) - Math.max(box.y, m.offset),
      );
      sub.cb({
        ...viewToken({ item: sub.item(), key, index: sub.index(), isViewable: visible > 0 }),
        percentOfScroller: m.viewport > 0 ? (100 * visible) / m.viewport : 0,
        percentVisible: box.height > 0 ? (100 * visible) / box.height : 0,
        scrollSize: m.viewport,
        size: box.height,
        sizeVisible: visible,
      });
    }
  }
}

/** What a `listen` value is read from. */
interface ListenCtx {
  readonly state: LegendListState;
  readonly core: CoreHandle | null;
  readonly endSpace: number;
  readonly horizontal: boolean;
  readonly keyOf: (item: unknown, i: number) => string;
}

/** The scroll element (with the sizes the listeners read). */
function scrollNodeOf(
  c: ListenCtx,
): (Element & { clientWidth?: number; clientHeight?: number }) | null {
  return c.core?.getScrollableNode() ?? null;
}

/** The size along the scroll axis of the list's `[attr]` slot (its footer), 0 without one. */
function slotSize(c: ListenCtx, attr: string): number {
  const el = scrollNodeOf(c)?.querySelector?.(`[${attr}]`) as
    | { offsetHeight?: number; offsetWidth?: number }
    | null
    | undefined;
  return (c.horizontal ? el?.offsetWidth : el?.offsetHeight) ?? 0;
}

/** The value each `listen` type reports (a type not listed never calls back). */
const LISTEN_VALUES: Readonly<Record<string, (c: ListenCtx) => unknown>> = {
  totalSize: (c) => c.core?.engine()?.getScrollMetrics().rows ?? 0,
  headerSize: (c) => Math.max(0, -(c.core?.engine()?.getScrollMetrics().min ?? 0)),
  footerSize: (c) => slotSize(c, "data-vl-footer"),
  anchoredEndSpaceSize: (c) => c.endSpace,
  isAtEnd: (c) => c.state.isAtEnd,
  isAtStart: (c) => c.state.isAtStart,
  isNearEnd: (c) => c.state.isNearEnd,
  isNearStart: (c) => c.state.isNearStart,
  isWithinMaintainScrollAtEndThreshold: (c) => c.state.isWithinMaintainScrollAtEndThreshold,
  activeStickyIndex: (c) => c.state.activeStickyIndex,
  lastItemKeys: (c) => {
    const n = c.state.data.length;
    return n > 0 ? [c.keyOf(c.state.data[n - 1], n - 1)] : [];
  },
  numContainers: (c) => c.state.end < c.state.start ? 0 : c.state.end - c.state.start + 1,
  otherAxisSize: (c) =>
    (c.horizontal ? scrollNodeOf(c)?.clientHeight : scrollNodeOf(c)?.clientWidth) ?? 0,
  readyToRender: (c) => c.core !== null,
};

/** Whether two `listen` values are the same (arrays by their items). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  }
  return Object.is(a, b);
}

/** Subscribe `cb` to `key`'s entry of `map`, seeding it with `initial()`; returns the remover. */
function subscribe<V>(
  map: Map<string, Listening<V>>,
  key: string,
  cb: (value: V) => void,
  initial: () => V,
): () => void {
  let l = map.get(key);
  if (!l) {
    l = { cbs: new Set(), last: initial() };
    map.set(key, l);
  }
  const entry = l;
  entry.cbs.add(cb);
  return () => {
    entry.cbs.delete(cb);
    if (entry.cbs.size === 0 && map.get(key) === entry) map.delete(key);
  };
}

/** Tell each subscriber whose value changed (`read` builds the context only when needed). */
function notifyListeners(hub: ListenHub, read: () => ListenCtx): void {
  if (hub.types.size === 0 && hub.positions.size === 0) return;
  const c = read();
  const tell = <V>(l: Listening<V>, value: V): void => {
    if (sameValue(value, l.last)) return;
    l.last = value;
    for (const cb of [...l.cbs]) cb(value);
  };
  for (const [type, l] of hub.types) tell(l, LISTEN_VALUES[type]?.(c));
  for (const [key, l] of hub.positions) tell(l, c.state.positionByKey(key));
}

/**
 * The scroll content's length, as LegendList reports it: the header, the items, the footer and
 * the room after them (the scroll element's scroll size; the header and the items before the
 * element is laid out).
 */
function contentLengthOf(
  core: CoreHandle | null,
  m: { min: number; rows: number },
  horizontal: boolean,
): number {
  const node = core?.getScrollableNode() as
    | { scrollHeight?: number; scrollWidth?: number }
    | null
    | undefined;
  const laidOut = horizontal ? node?.scrollWidth : node?.scrollHeight;
  return laidOut && laidOut > 0 ? laidOut : m.rows - m.min;
}

/** The state `getState()` reports. */
function legendState(
  core: CoreHandle | null,
  data: readonly unknown[],
  p: Packing,
  keyOf: (item: unknown, i: number) => string,
  threshold: number,
  listening?: { hub: ListenHub; endSpace: number; horizontal: boolean },
): LegendListState {
  const engine = core?.engine() ?? null;
  const m = engine?.getScrollMetrics() ?? { offset: 0, viewport: 0, min: 0, max: 0, rows: 0 };
  const range = engine?.getRange() ?? { first: 0, last: -1 };
  const toItem = (row: number) => core ? p.starts[core.visual(row)] ?? -1 : -1;
  const start = range.last < range.first ? -1 : Math.min(toItem(range.first), toItem(range.last));
  const end = range.last < range.first ? -1 : Math.max(toItem(range.first), toItem(range.last));
  const indexByKey = (key: string) => {
    const i = data.findIndex((item, k) => keyOf(item, k) === key);
    return i < 0 ? undefined : i;
  };
  const fromEnd = m.max - m.offset;
  const fromStart = m.offset - m.min;
  const positionAtIndex = (i: number) => layoutOf(core, p, i)?.y ?? 0;
  const ctx = (): ListenCtx => ({
    state,
    core,
    keyOf,
    endSpace: listening?.endSpace ?? 0,
    horizontal: listening?.horizontal ?? false,
  });
  const state: LegendListState = {
    activeStickyIndex: -1,
    contentLength: contentLengthOf(core, m, listening?.horizontal ?? false),
    data,
    elementAtIndex: (i) =>
      core?.getScrollableNode()?.querySelector?.(`[data-index="${core.visual(rowOfItem(p, i))}"]`),
    end,
    endBuffered: end,
    isAtEnd: fromEnd <= 4,
    isAtStart: fromStart <= 4,
    isNearEnd: fromEnd <= m.viewport * 0.5,
    isNearStart: fromStart <= m.viewport * 0.5,
    isEndReached: fromEnd <= 4,
    isStartReached: fromStart <= 4,
    isWithinMaintainScrollAtEndThreshold: fromEnd <= threshold * m.viewport,
    getAverageItemSizes: () => ({
      "": { average: data.length > 0 ? m.rows / p.rows : 0, count: data.length },
    }),
    indexByKey,
    listen: (type, cb) => {
      if (!listening) return () => {};
      return subscribe(listening.hub.types, type, cb, () => LISTEN_VALUES[type]?.(ctx()));
    },
    listenToPosition: (key, cb) => {
      if (!listening) return () => {};
      const heard = cb as (value: number | undefined) => void;
      return subscribe(listening.hub.positions, key, heard, () => state.positionByKey(key));
    },
    positionAtIndex,
    positionByKey: (key) => {
      const i = indexByKey(key);
      return i === undefined ? undefined : positionAtIndex(i);
    },
    scroll: m.offset - m.min,
    scrollLength: m.viewport,
    scrollVelocity: 0,
    sizeAtIndex: (i) => layoutOf(core, p, i)?.height ?? 0,
    sizes: new Map(),
    start,
    startBuffered: start,
  };
  return state;
}

/** The state `getState()` reports now, with the list's `listen` hub. */
function currentState(
  core: { current: CoreHandle | null },
  latest: LegendLatest,
  keyOf: (item: unknown, i: number) => string,
  hub: ListenHub,
): LegendListState {
  const { data, packing, props, endSpace } = latest.current;
  return legendState(
    core.current,
    data,
    packing,
    keyOf,
    props.maintainScrollAtEndThreshold ?? 0.1,
    {
      hub,
      endSpace: endSpace ?? 0,
      horizontal: !!props.horizontal,
    },
  );
}

/** The LegendList ref over the core (the DOM build's scroll-view getters return the element). */
function legendHandle(
  core: { current: CoreHandle | null },
  latest: LegendLatest,
  keyOf: (item: unknown, i: number) => string,
  hub: ListenHub,
  dom: boolean,
): LegendListRef {
  const c = () => core.current;
  const responder = (): ScrollResponder | null =>
    dom
      ? c()?.getScrollableNode() as unknown as ScrollResponder ?? null
      : c()?.getScrollResponder() ?? null;
  const rowOf = (i: number) => rowOfItem(latest.current.packing, i);
  const toIndex = (params: ScrollIndexParams): Promise<void> => {
    c()?.scrollToIndex({ ...params, index: rowOf(params.index) });
    return afterFrames();
  };
  const intoView = (index: number, animated?: boolean): Promise<void> => {
    const handle = c();
    const engine = handle?.engine();
    if (handle && engine && index >= 0) {
      engine.scrollToIndex(handle.visual(rowOf(index)), {
        align: "auto",
        behavior: animated === false ? undefined : "smooth",
      });
    }
    return afterFrames();
  };
  return {
    clearCaches() {},
    flashScrollIndicators() {},
    getNativeScrollRef: responder,
    getAnimatableRef: responder,
    getScrollableNode: () => c()?.getScrollableNode() ?? null,
    getScrollResponder: responder,
    getState: () => currentState(core, latest, keyOf, hub),
    reportContentInset() {},
    scrollIndexIntoView: (params) => intoView(params.index, params.animated),
    scrollItemIntoView: (params) =>
      intoView(latest.current.data.indexOf(params.item), params.animated),
    scrollToEnd(options) {
      c()?.scrollToEnd(options);
      return afterFrames();
    },
    scrollToIndex: toIndex,
    scrollToItem(params) {
      const i = latest.current.data.indexOf(params.item);
      return i < 0 ? Promise.resolve() : toIndex({ ...params, index: i });
    },
    scrollToOffset(params) {
      c()?.scrollToOffset(params);
      return afterFrames();
    },
    setItemSize() {},
    setScrollProcessingEnabled() {},
    setVisibleContentAnchorOffset() {},
  };
}

/** A scroll-frame listener for `onFirstVisibleItemChanged` (or undefined). */
function firstVisibleTracker(
  core: { current: CoreHandle | null },
  data: readonly unknown[],
  p: Packing,
  keyOf: (item: unknown, i: number) => string,
  onChange: LegendListProps<unknown>["onFirstVisibleItemChanged"],
): ((e: VirtualListScrollEvent) => void) | undefined {
  if (!onChange) return undefined;
  let last = -2;
  return () => {
    const c = core.current;
    const r = c?.engine()?.getRange();
    if (!c || !r || r.last < r.first) return;
    const index = p.starts[Math.min(c.visual(r.first), c.visual(r.last))];
    if (index === last) return;
    last = index;
    onChange({ index, item: data[index], key: keyOf(data[index], index) });
  };
}

/**
 * Hook: the scroll-frame listeners (sticky change, first visible, viewability amounts, the
 * state's `listen` subscribers).
 */
function useScrollFrame(
  props: LegendListProps<unknown>,
  core: { current: CoreHandle | null },
  bus: Bus,
  data: readonly unknown[],
  p: Packing,
  keyOf: (item: unknown, i: number) => string,
  notify: () => void,
): EngineOptions["onScrollFrame"] {
  const onSticky = props.onStickyHeaderChange;
  return useMemo(() => {
    const sticky = stickyTracker(
      core,
      p,
      props.stickyHeaderIndices,
      onSticky ? (index) => onSticky({ index, item: data[index] }) : undefined,
    );
    const first = firstVisibleTracker(core, data, p, keyOf, props.onFirstVisibleItemChanged);
    return (e: VirtualListScrollEvent) => {
      sticky?.(e);
      first?.(e);
      if (bus.amount.size > 0) dispatchAmounts(bus, p);
      notify();
    };
  }, [
    core,
    notify,
    bus,
    data,
    p,
    keyOf,
    props.stickyHeaderIndices,
    onSticky,
    props.onFirstVisibleItemChanged,
  ]);
}

/** LegendList's viewability callbacks, with the ranges, plus the cells' `useViewability`. */
function legendViewability(
  props: LegendListProps<unknown>,
  bus: Bus,
  wanted: boolean,
  core: { current: CoreHandle | null },
  p: Packing,
): Partial<VirtualizedListProps<unknown>> {
  const user = props.onViewableItemsChanged;
  const ranges = () => {
    const c = core.current;
    const r = c?.engine()?.getRange();
    if (!c || !r || r.last < r.first) {
      return { start: -1, end: -1, startBuffered: -1, endBuffered: -1 };
    }
    const a = c.visual(r.first);
    const b = c.visual(r.last);
    const start = p.starts[Math.min(a, b)];
    const end = p.starts[Math.max(a, b) + 1] - 1;
    return { start, end, startBuffered: start, endBuffered: end };
  };
  if (!user && !wanted) return {};
  return {
    onViewableItemsChanged: (info) => {
      if (wanted) dispatchViewability(bus, info.changed);
      user?.({ ...info, ...ranges() });
    },
  };
}

/**
 * LegendList on denext's `VirtualList`, rendering with react-native-web's primitives.
 *
 * @param prim react-native-web's primitives (React Native mode passes the app's own).
 * @returns The `LegendList` component.
 */
export function createLegendList(prim: ListPrimitives): (props: LegendListProps<unknown>) => VNode {
  const dom = prim.dom === true;
  function LegendList(props: LegendListProps<unknown>): VNode {
    const core = useRef<CoreHandle | null>(null);
    const childData = useMemo(() => childItems(props.children), [props.children]);
    const data = props.data ?? childData;
    const packing = usePacking(
      data,
      props.numColumns,
      props.overrideItemLayout as OverrideItemLayout | undefined,
      props.extraData,
    );
    const latest: LegendLatest = useRef<LegendLatest["current"]>({ data, packing, props });
    latest.current = { data, packing, props };
    const keyOf = useKeyOf(props.keyExtractor);
    const [bus, wanted] = useBus(core);
    const { hub, notify, queue } = useListenHub(core, latest, keyOf);
    useImperativeHandle(props.ref, () => legendHandle(core, latest, keyOf, hub, dom), [keyOf]);
    useLegendLoad(props);
    const onScrollFrame = useScrollFrame(props, core, bus, data, packing, keyOf, notify);
    const render = useLegendRender(props, data, packing, prim);
    const wrapCell = useWrapCell(bus, keyOf, data.length);
    const extras = useLegendExtras(props, prim, core, latest, keyOf, queue);
    latest.current.endSpace = extras.engine.endSpace;
    const engine: EngineOptions = {
      ...legendEngine(
        props,
        data,
        packing,
        keyOf,
        singleColumn(packing, wrapCell),
        onScrollFrame,
        dom,
      ),
      ...extras.engine,
      ...domEngine(props, dom),
    };
    const extra = useMemo(() => ({}), [props.extraData, props.dataVersion, props.dataKey]);
    const list: VirtualizedListProps<unknown> = {
      ...(props as unknown as VirtualizedListProps<unknown>),
      ...packedCoreProps({ ...props, data }, initialIndexOf(props), packing, render, keyOf),
      ...extras.list,
      extraData: extra,
      onViewableItemsChanged: undefined,
      ...legendViewability(props, bus, wanted, core, packing),
    };
    return h(CoreList, { list, prim, engine, coreRef: core });
  }
  return LegendList;
}

/** The cell wrapper for a one-column list (a grid's rows hold several items: none). */
function singleColumn(
  p: Packing,
  wrapCell: NonNullable<EngineOptions["wrapCell"]>,
): EngineOptions["wrapCell"] {
  return p.cols === 1 ? wrapCell : undefined;
}

/** The latest render's inputs, as the list's ref and reports read them. */
type LegendLatest = {
  current: {
    data: readonly unknown[];
    packing: Packing;
    props: LegendListProps<unknown>;
    /** The room after the last item (`anchoredEndSpace` + `contentInsetEndAdjustment`). */
    endSpace?: number;
  };
};

/** The `listen` context over the latest render. */
function listenCtx(
  core: { current: CoreHandle | null },
  latest: LegendLatest,
  keyOf: (item: unknown, i: number) => string,
  hub: ListenHub,
): ListenCtx {
  return {
    state: currentState(core, latest, keyOf, hub),
    core: core.current,
    keyOf,
    endSpace: latest.current.endSpace ?? 0,
    horizontal: !!latest.current.props.horizontal,
  };
}

/**
 * Hook: the list's `listen` hub, its `notify` (run after every commit here, and on scroll
 * frames by the caller) and `queue` (one coalesced notify for a batch of measurements).
 */
function useListenHub(
  core: { current: CoreHandle | null },
  latest: LegendLatest,
  keyOf: (item: unknown, i: number) => string,
): { hub: ListenHub; notify: () => void; queue: () => void } {
  const hub = useMemo(listenHub, []);
  const out = useMemo(() => {
    const notify = () => notifyListeners(hub, () => listenCtx(core, latest, keyOf, hub));
    return { hub, notify, queue: () => queueNotify(hub, notify) };
  }, [hub, keyOf]);
  // After every commit: the sizes and edges the state's `listen` subscribers watch.
  useLayoutEffect(out.notify);
  return out;
}

/** Run `notify` once in a microtask (a batch of measurements notifies once). */
function queueNotify(hub: ListenHub, notify: () => void): void {
  if (hub.queued || (hub.types.size === 0 && hub.positions.size === 0)) return;
  hub.queued = true;
  queueMicrotask(() => {
    hub.queued = false;
    notify();
  });
}

/** LegendList's own callback props, never forwarded to the DOM build's scroll element. */
const LEGEND_CALLBACKS: ReadonlySet<string> = new Set([
  "onContentSizeChange",
  "onEndReached",
  "onEndReachedThreshold",
  "onFirstVisibleItemChanged",
  "onItemSizeChanged",
  "onLayout",
  "onLoad",
  "onMetricsChange",
  "onMomentumScrollBegin",
  "onMomentumScrollEnd",
  "onReady",
  "onRefresh",
  "onScroll",
  "onScrollBeginDrag",
  "onScrollEndDrag",
  "onStartReached",
  "onStartReachedThreshold",
  "onStickyHeaderChange",
  "onViewableItemsChanged",
]);

/** The DOM attributes LegendList's DOM build passes to its scroll element. */
const DOM_ATTRIBUTES: ReadonlySet<string> = new Set([
  "id",
  "role",
  "tabIndex",
  "title",
  "dir",
  "lang",
  "hidden",
  "inert",
  "translate",
  "draggable",
  "spellCheck",
  "contentEditable",
  "autoFocus",
  "slot",
]);

/**
 * Whether a prop of the DOM build is an attribute of its scroll element: `id`, `data-*`,
 * `aria-*`, the global attributes above, and DOM event handlers (`on*` that is not one of
 * LegendList's own callbacks).
 */
export function isScrollerAttribute(name: string): boolean {
  if (DOM_ATTRIBUTES.has(name) || name.startsWith("data-") || name.startsWith("aria-")) {
    return true;
  }
  return /^on[A-Z]/.test(name) && !LEGEND_CALLBACKS.has(name);
}

/** The DOM build's engine extras: the classes and the scroll element's other attributes. */
function domEngine(props: LegendListProps<unknown>, dom: boolean): EngineOptions {
  if (!dom) return {};
  const own = props as unknown as Record<string, unknown>;
  const attrs: Record<string, unknown> = {};
  let any = false;
  for (const name in own) {
    if (own[name] !== undefined && isScrollerAttribute(name)) {
      attrs[name] = own[name];
      any = true;
    }
  }
  return {
    className: typeof own.className === "string" ? own.className : undefined,
    contentContainerClassName: typeof own.contentContainerClassName === "string"
      ? own.contentContainerClassName
      : undefined,
    scrollerProps: any ? attrs : undefined,
  };
}

/**
 * Hook: LegendList's layout reports and snap points (`onMetricsChange`, `anchoredEndSpace`,
 * `contentInsetEndAdjustment`, `onItemSizeChanged`, `snapToIndices`) as engine options and list
 * props. `measured` hears every measurement (the `listen` subscribers).
 */
function useLegendExtras(
  props: LegendListProps<unknown>,
  prim: ListPrimitives,
  core: { current: CoreHandle | null },
  latest: LegendLatest,
  keyOf: (item: unknown, i: number) => string,
  measured: () => void,
): { engine: EngineOptions; list: Partial<VirtualizedListProps<unknown>> } {
  const { data, packing } = latest.current;
  const { metrics, slots } = useSlotMetrics(props, prim.View);
  const anchor = useAnchoredEndSpace(core, {
    props,
    data,
    packing,
    keyOf,
    footerSize: metrics.footerSize,
  });
  const snapRows = useMemo(
    () => snapRowsOf(props.snapToIndices, data.length, packing),
    [props.snapToIndices, data.length, packing],
  );
  const reports = props.onItemSizeChanged || props.anchoredEndSpace;
  const report = reports ? itemReporter(latest, keyOf, anchor.schedule) : undefined;
  return {
    engine: {
      endSpace: anchor.size + endInset(props),
      snapRows,
      onItemMeasured: (info) => {
        report?.(info);
        measured();
      },
    },
    list: {
      ...snapProps(props),
      ...slots,
      onLayout: props.anchoredEndSpace ? relayout(props.onLayout, anchor.update) : props.onLayout,
    },
  };
}

/** The room `contentInset`'s end and `contentInsetEndAdjustment` add after the last item. */
function endInset(props: LegendListProps<unknown>): number {
  const inset = props.contentInset;
  const end = (props.horizontal ? inset?.right : inset?.bottom) ?? 0;
  return Math.max(0, end) + Math.max(0, props.contentInsetEndAdjustment ?? 0);
}

/** `snapToIndices` as the engine rows whose cells snap (`undefined` when there are none). */
function snapRowsOf(
  indices: readonly number[] | undefined,
  count: number,
  p: Packing,
): ReadonlySet<number> | undefined {
  if (!indices || indices.length === 0) return undefined;
  const rows = new Set<number>();
  for (const i of indices) if (i >= 0 && i < count) rows.add(rowOfItem(p, Math.floor(i)));
  return rows.size > 0 ? rows : undefined;
}

/**
 * With `snapToIndices`, LegendList hands the scroll view `snapToOffsets` (the items' offsets),
 * which replace `snapToOffsets` / `snapToInterval`; the items snap through their cells here, and
 * the content's start (`snapToStart`) and end (`snapToEnd`) through the engine's snap points: an
 * offset of 0, or one past any content when only the end applies.
 */
function snapProps(props: LegendListProps<unknown>): Partial<VirtualizedListProps<unknown>> {
  if (!props.snapToIndices || props.snapToIndices.length === 0) return {};
  return {
    snapToInterval: undefined,
    snapToOffsets: props.snapToStart === false ? [Number.MAX_SAFE_INTEGER] : [0],
  };
}

/** `onLayout` that also re-runs `update` (the viewport changed). */
function relayout(
  onLayout: LegendListProps<unknown>["onLayout"],
  update: () => void,
): NonNullable<LegendListProps<unknown>["onLayout"]> {
  return (e) => {
    onLayout?.(e);
    update();
  };
}

/**
 * The engine's measurement reports: `anchoredEndSpace` recomputes (once per batch: `update` is
 * the coalescing `schedule`), and `onItemSizeChanged` hears each item whose size changed (every
 * item of a grid row).
 */
function itemReporter(
  latest: LegendLatest,
  keyOf: (item: unknown, i: number) => string,
  update: () => void,
): EngineOptions["onItemMeasured"] {
  return (info) => {
    update();
    const { props, data, packing } = latest.current;
    const cb = props.onItemSizeChanged;
    if (!cb || info.size === info.previous || info.index >= packing.rows) return;
    for (let i = packing.starts[info.index]; i < packing.starts[info.index + 1]; i++) {
      cb({
        size: info.size,
        previous: info.previous,
        index: i,
        itemKey: keyOf(data[i], i),
        itemData: data[i],
      });
    }
  };
}

/** Hook: the list's bus, and whether a cell asked for viewability (then reported). */
function useBus(core: { current: CoreHandle | null }): [Bus, boolean] {
  const [wanted, setWanted] = useState(false);
  const bus = useMemo(
    (): Bus => ({ core, view: new Map(), amount: new Map(), want: () => {} }),
    [],
  );
  bus.want = () => setWanted(true);
  return [bus, wanted];
}

/** Hook: the cell wrapper giving LegendList's hooks their item. */
function useWrapCell(
  bus: Bus,
  keyOf: (item: unknown, i: number) => string,
  count: number,
): NonNullable<EngineOptions["wrapCell"]> {
  return useCallback(
    (index: number, item: unknown, content: VNodeChild) =>
      h(LegendCell, { bus, index, item, itemKey: keyOf(item, index), count }, content),
    [bus, keyOf, count],
  );
}

/** Hook: `onLoad` once after the first commit. */
function useLegendLoad(props: LegendListProps<unknown>): void {
  const start = useRef(typeof performance === "undefined" ? 0 : performance.now());
  const done = useRef(false);
  useLayoutEffect(() => {
    if (done.current || !props.onLoad) return;
    done.current = true;
    const now = typeof performance === "undefined" ? 0 : performance.now();
    props.onLoad({ elapsedTimeInMs: now - start.current });
  });
}

/** Hook: the row renderer (grid rows with the column gaps, or one item per row). */
function useLegendRender(
  props: LegendListProps<unknown>,
  data: readonly unknown[],
  p: Packing,
  prim: ListPrimitives,
): (info: CoreRenderInfo<unknown>) => VNodeChild {
  const { renderItem, getItemType, extraData, columnWrapperStyle } = props;
  return useMemo(() => {
    const one = (item: unknown, index: number): VNodeChild => {
      if (!renderItem) return props.children === undefined ? null : item as VNodeChild;
      return renderItem({ item, index, type: getItemType?.(item, index), data, extraData });
    };
    if (p.cols === 1) return (info: CoreRenderInfo<unknown>) => one(info.item, info.index);
    const gap = columnWrapperStyle?.gap;
    return packedRowRender(prim.View, p, one, {
      column: columnWrapperStyle?.columnGap ?? gap,
      row: columnWrapperStyle?.rowGap ?? gap,
    });
  }, [renderItem, getItemType, extraData, columnWrapperStyle, data, p]);
}

/** The cell this hook runs in. */
function useCell(): CellInfo {
  return useContext(cellCtx());
}

/**
 * State that resets when the cell shows another item (LegendList's recycling hook); a function
 * initial value receives `{ index, item, prevIndex, prevItem }`.
 *
 * @param valueOrFun The initial value, or a function of the recycling state.
 * @returns The value and its setter.
 */
export function useRecyclingState<T>(
  valueOrFun: T | ((info: LegendListRecyclingState<unknown>) => T),
): readonly [T, (value: T | ((prev: T) => T)) => void] {
  const cell = useCell();
  const box = useRef<{ item: unknown; index: number; value: T } | null>(null);
  const [, setTick] = useState(0);
  const prev = box.current;
  if (prev === null || prev.item !== cell.item) {
    const value = typeof valueOrFun === "function"
      ? (valueOrFun as (info: LegendListRecyclingState<unknown>) => T)({
        index: cell.index,
        item: cell.item,
        prevIndex: prev?.index,
        prevItem: prev?.item,
      })
      : valueOrFun;
    box.current = { item: cell.item, index: cell.index, value };
  }
  const set = useCallback((next: T | ((prev: T) => T)) => {
    const b = box.current!;
    b.value = typeof next === "function" ? (next as (p: T) => T)(b.value) : next;
    setTick((n) => n + 1);
  }, []);
  return [box.current!.value, set] as const;
}

/**
 * An effect that re-runs when the cell shows another item (LegendList's `useRecyclingEffect`).
 *
 * @param effect Receives the recycling state; may return a cleanup.
 */
export function useRecyclingEffect(
  effect: (info: LegendListRecyclingState<unknown>) => void | (() => void),
): void {
  const cell = useCell();
  const prev = useRef<{ index: number; item: unknown } | undefined>(undefined);
  useEffect(() => {
    const was = prev.current;
    prev.current = { index: cell.index, item: cell.item };
    return effect({
      index: cell.index,
      item: cell.item,
      prevIndex: was?.index,
      prevItem: was?.item,
    });
  }, [cell.item, cell.index]);
}

/**
 * Called when this cell's item becomes viewable or stops being viewable.
 *
 * @param callback Receives the item's token.
 * @param _configId Accepted: the list's main `viewabilityConfig` applies.
 */
export function useViewability(
  callback: (token: LegendViewToken) => void,
  _configId?: string,
): void {
  const cell = useCell();
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    const bus = cell.bus;
    if (!bus) return;
    const fn = (t: LegendViewToken) => latest.current(t);
    const set = bus.view.get(cell.key) ?? new Set();
    set.add(fn);
    bus.view.set(cell.key, set);
    bus.want();
    return () => {
      set.delete(fn);
      if (set.size === 0) bus.view.delete(cell.key);
    };
  }, [cell.bus, cell.key]);
}

/**
 * Called on every scroll frame with how much of this cell's item is visible.
 *
 * @param callback Receives the item's visible size and shares.
 */
export function useViewabilityAmount(callback: (token: ViewAmountToken) => void): void {
  const cell = useCell();
  const latest = useRef({ callback, cell });
  latest.current = { callback, cell };
  useEffect(() => {
    const bus = cell.bus;
    if (!bus) return;
    const sub = {
      index: () => latest.current.cell.index,
      item: () => latest.current.cell.item,
      cb: (t: ViewAmountToken) => latest.current.callback(t),
    };
    const set = bus.amount.get(cell.key) ?? new Set();
    set.add(sub);
    bus.amount.set(cell.key, set);
    return () => {
      set.delete(sub);
      if (set.size === 0) bus.amount.delete(cell.key);
    };
  }, [cell.bus, cell.key]);
}

/**
 * Whether this cell shows the last item.
 *
 * @returns `true` in the last item's cell.
 */
export function useIsLastItem(): boolean {
  const cell = useCell();
  return cell.index >= 0 && cell.index === cell.count - 1;
}

/**
 * The list's scroll element size, updated when it resizes.
 *
 * @returns `{ width, height }`.
 */
export function useListScrollSize(): { width: number; height: number } {
  const cell = useCell();
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = cell.bus?.core.current?.getScrollableNode() as
      | { clientWidth?: number; clientHeight?: number }
      | null
      | undefined;
    if (!node) return;
    const read = () => {
      const next = { width: node.clientWidth ?? 0, height: node.clientHeight ?? 0 };
      setSize((s) => s.width === next.width && s.height === next.height ? s : next);
    };
    read();
    const RO = (globalThis as { ResizeObserver?: new (cb: () => void) => ResizeObserver })
      .ResizeObserver;
    if (!RO) return;
    const ro = new RO(read);
    ro.observe(node as unknown as Element);
    return () => ro.disconnect();
  }, [cell.bus]);
  return size;
}

/**
 * A function that asks the list to lay out synchronously; denext's lists measure on every size
 * change, so it does nothing.
 *
 * @returns A no-op.
 */
export function useSyncLayout(): () => void {
  return useCallback(() => {}, []);
}

/**
 * LegendList's adaptive rendering mode: always `"normal"` (denext renders full items).
 *
 * @returns `"normal"`.
 */
export function useAdaptiveRender(): "normal" | "light" {
  return "normal";
}

/**
 * Called when the adaptive rendering mode changes: never (it is always `"normal"`).
 *
 * @param _callback Accepted.
 */
export function useAdaptiveRenderChange(_callback: (mode: "normal" | "light") => void): void {}
