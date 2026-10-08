/**
 * The core of React Native mode's list adapters: React Native's `VirtualizedList` API over
 * denext's `VirtualList`. `FlatList`, `SectionList`, FlashList and LegendList are thin layers
 * over {@linkcode CoreList}, as react-native-web's are over its `VirtualizedList`.
 *
 * What the mapping does:
 * - `inverted` is a LOGICAL reversal: the engine renders data index `n − 1 − v` at visual row
 *   `v` with `anchor="end"` (start at the bottom, stay pinned there), so the wheel, keys, the
 *   scrollbar, selection and copy order are natural — never `scaleY(-1)` (RNW #995, #1790,
 *   #1807, #2500). Header and footer swap ends, the edge callbacks swap, and scroll offsets,
 *   `scrollToOffset` and `scrollToIndex`'s `viewPosition` are mirrored so the app sees React
 *   Native's inverted coordinates.
 * - separators render inside each cell (trailing; leading when inverted) with React Native's
 *   `highlighted` / `leadingItem` props and the `separators` API of `renderItem`;
 * - `getItemLayout`'s `length` is the exact size (never measured), `onEndReached` /
 *   `onStartReached` get `distanceFromEnd` / `distanceFromStart`, viewability tokens carry data
 *   indices, and styles resolve through the app's react-native-web `StyleSheet`.
 *
 * @module
 */

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeType } from "../../jsx/types.ts";
import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "../../runtime/hooks.ts";
import { VirtualList } from "../../client/virtual/virtual-list.ts";
import { snapOptionsFromProps } from "../../client/virtual/snap.ts";
import type {
  ViewableItemsChanged,
  ViewToken,
  VirtualListBlankArea,
  VirtualListHandle,
  VirtualListProps,
  VirtualListScrollEvent,
} from "../../client/virtual/types.ts";
import { cloneElement } from "../../runtime/react-core.ts";
import { useOverlap } from "../../mobile/keyboard-views.ts";
import { Keyboard } from "../keyboard.ts";
import { ensureHiddenScrollbarRule, HIDE_SCROLLBAR_CLASS, resolveStyle } from "./style.ts";
import type {
  ListPrimitives,
  ListRenderItemInfo,
  RNSlot,
  ScrollComponentProps,
  ScrollResponder,
  ScrollToIndexParams,
  Separators,
  VirtualizedListProps,
  VirtualizedListRef,
} from "./types.ts";

/** React Native's default `onEndReachedThreshold` / `onStartReachedThreshold`. */
const RN_THRESHOLD = 2;

/** A tokens converter (grid rows → items, flattened rows → sections). */
type TokenConverter = (tokens: ViewToken<unknown>[]) => ViewToken<unknown>[];

/**
 * What the higher-level adapters add on top of `VirtualizedList`'s props (internal; not
 * React Native API).
 */
export interface EngineOptions {
  /** Exact size of data index `i` (instead of `getItemLayout`). */
  readonly exactSize?: (index: number) => number;
  /** Estimated size of data index `i` (rows are still measured). */
  readonly estimatedSize?: (index: number) => number;
  /** One estimate for every row. */
  readonly estimatedItemSize?: number;
  /** A row's type (recycling reuses cells within a type). */
  readonly typeOf?: (index: number) => string | number;
  /** Reuse cells (off unless an adapter's app opts in). */
  readonly recycle?: boolean;
  /** Px rendered beyond the viewport (`drawDistance`). */
  readonly overscan?: number;
  /** Keep the visible items in place on changes above them (default: only with RN's prop). */
  readonly mvcp?: boolean;
  /** Start at the (visual) end and bottom-align short content, as a chat does. */
  readonly anchorEnd?: boolean;
  /** Px from the data start within which an insertion there scrolls to it. */
  readonly autoscrollStart?: number;
  /** Px from the data end (or a function of the viewport) within which a change scrolls to it. */
  readonly autoscrollEnd?: number | ((viewport: number) => number);
  /** Animate those autoscrolls. */
  readonly autoscrollSmooth?: boolean;
  /** Replaces the item-separator rule: the node after (before, inverted) data index `i`. */
  readonly separator?: (index: number, item: unknown, extra: Record<string, unknown>) => VNodeChild;
  /** Converts viewability tokens (data indices) before the app sees them. */
  readonly convertTokens?: TokenConverter;
  /** The default edge thresholds (React Native's 2 viewports otherwise). */
  readonly threshold?: number;
  /** Development-only blank-area report. */
  readonly onBlankArea?: (blank: VirtualListBlankArea) => void;
  /** Wraps each cell's content (a per-item context). */
  readonly wrapCell?: (index: number, item: unknown, content: VNodeChild) => VNodeChild;
  /** The empty state's wrapper style (FlashList's `ListEmptyComponentStyle`). */
  readonly emptyStyle?: unknown;
  /** Called with every scroll event, before the app's `onScroll`. */
  readonly onScrollFrame?: (e: VirtualListScrollEvent) => void;
  /** Called once after the first commit (initial offsets the engine cannot express). */
  readonly onMount?: (handle: CoreHandle) => void;
  /** Keys of items kept mounted while scrolled away (LegendList's `alwaysRender`). */
  readonly keepMounted?: readonly string[];
  /** Viewport size assumed before layout (LegendList's `estimatedListSize`). */
  readonly viewportSize?: number;
  /** Scroll the page instead of the list's own element (LegendList's `useWindowScroll`). */
  readonly windowScroll?: boolean;
  /**
   * Renders the scroll view (FlashList's component form); without it, the list's own
   * `renderScrollComponent` does.
   */
  readonly scrollComponent?: (props: ScrollComponentProps) => VNode | null;
  /** Data rows whose cells are snap points, aligned to the start (LegendList's `snapToIndices`). */
  readonly snapRows?: ReadonlySet<number>;
  /** Px of room after the last item (LegendList's `anchoredEndSpace`). */
  readonly endSpace?: number;
  /** A data row was measured: its first measurement, or a new size (the engine's report). */
  readonly onItemMeasured?: (info: { index: number; size: number; previous: number }) => void;
  /** The scroller's class (the DOM build's `className`), ahead of the style's. */
  readonly className?: string;
  /** The content container's class (the DOM build's `contentContainerClassName`). */
  readonly contentContainerClassName?: string;
  /** More attributes of the scroller (the DOM build's `id`, `data-*`, event handlers, …). */
  readonly scrollerProps?: Readonly<Record<string, unknown>>;
}

/** The core's ref: `VirtualizedList`'s methods plus what the adapters build on. */
export interface CoreHandle extends VirtualizedListRef {
  /** The engine's handle (null before mount). */
  engine(): VirtualListHandle | null;
  /** Visual row of data index `i` (the same mapping in reverse). */
  visual(i: number): number;
  /** The number of items. */
  count(): number;
  /** Whether the list is inverted. */
  inverted(): boolean;
}

/** Props of {@linkcode CoreList}. */
export interface CoreListProps {
  /** React Native's `VirtualizedList` props. */
  readonly list: VirtualizedListProps<unknown>;
  /** react-native-web's primitives. */
  readonly prim: ListPrimitives;
  /** The adapter's extras. */
  readonly engine?: EngineOptions;
  /** Receives the {@linkcode CoreHandle}. */
  readonly coreRef?: Ref<CoreHandle>;
}

/** Data access in data indices and visual rows. */
interface Model {
  readonly count: number;
  readonly inverted: boolean;
  /** Visual row `v` ↔ data index (an involution). */
  readonly flip: (v: number) => number;
  /** Item at data index `i`. */
  readonly itemAt: (i: number) => unknown;
  /** Item at visual row `v` (the engine's `getItem`). */
  readonly rowItem: (v: number) => unknown;
  /** Key of the item at data index `i`. */
  readonly keyAt: (item: unknown, i: number) => string;
}

/** React Native's default key: `item.key`, else `item.id`, else the index. */
export function defaultRNKey(item: unknown, index: number): string {
  if (item !== null && typeof item === "object") {
    const o = item as { key?: unknown; id?: unknown };
    if (typeof o.key === "string" || typeof o.key === "number") return String(o.key);
    if (typeof o.id === "string" || typeof o.id === "number") return String(o.id);
  }
  return String(index);
}

/** The item count `getItemCount` reports (0 for a missing or invalid source). */
function countOf(list: VirtualizedListProps<unknown>): number {
  if (list.data === null || list.data === undefined || !list.getItemCount) return 0;
  const n = list.getItemCount(list.data);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** The latest `keyExtractor` (read at call time, so an inline one keeps the model stable). */
type KeyExtractorRef = { current: VirtualizedListProps<unknown>["keyExtractor"] };

/** The data model for the current props. */
function makeModel(
  list: VirtualizedListProps<unknown>,
  count: number,
  inverted: boolean,
  keys: KeyExtractorRef,
): Model {
  const data = list.data;
  const getItem = list.getItem;
  const itemAt = (i: number): unknown => getItem ? getItem(data, i) : undefined;
  const flip = inverted ? (v: number) => count - 1 - v : (v: number) => v;
  return {
    count,
    inverted,
    flip,
    itemAt,
    rowItem: inverted ? (v) => itemAt(count - 1 - v) : itemAt,
    keyAt: (item, i) => {
      const keyExtractor = keys.current;
      return keyExtractor ? String(keyExtractor(item, i)) : defaultRNKey(item, i);
    },
  };
}

/** Per-list cell rendering: what every cell reads. */
interface CellCtx {
  readonly model: Model;
  readonly render: (info: ListRenderItemInfo<unknown>) => VNodeChild;
  readonly separator:
    | ((index: number, item: unknown, extra: Record<string, unknown>) => VNodeChild)
    | null;
  readonly Wrapper: VNodeType | null;
  readonly snap: string | null;
  /** Data rows that snap to the start (besides `snap`, which applies to every cell). */
  readonly snapRows: ReadonlySet<number> | undefined;
  readonly wrap: EngineOptions["wrapCell"];
  /** Cell key → its separator-props setter (for `separators.highlight()` on a neighbour). */
  readonly registry: Map<
    string,
    (update: (s: Record<string, unknown>) => Record<string, unknown>) => void
  >;
}

const NO_PROPS: Record<string, unknown> = {};

/** Merge `props` into the separator after data index `index - 1` (this item's leading one). */
function updatePrevious(ctx: CellCtx, index: number, props: Record<string, unknown>): void {
  if (index <= 0) return;
  const prev = index - 1;
  const set = ctx.registry.get(ctx.model.keyAt(ctx.model.itemAt(prev), prev));
  set?.((s) => ({ ...s, ...props }));
}

/** The `separators` object a cell's `renderItem` receives. */
function cellSeparators(
  ctx: CellCtx,
  index: number,
  setOwn: (update: (s: Record<string, unknown>) => Record<string, unknown>) => void,
): Separators {
  const both = (props: Record<string, unknown>): void => {
    setOwn((s) => ({ ...s, ...props }));
    updatePrevious(ctx, index, props);
  };
  return {
    highlight: () => both({ highlighted: true }),
    unhighlight: () => both({ highlighted: false }),
    updateProps: (select, newProps) =>
      select === "leading"
        ? updatePrevious(ctx, index, newProps)
        : setOwn((s) => ({ ...s, ...newProps })),
  };
}

/** Props of one {@linkcode Cell}. */
interface CellProps {
  readonly ctx: CellCtx;
  readonly item: unknown;
  readonly index: number;
}

/**
 * One item with its separator (after it; before it when inverted, which is the same place in
 * React Native's flipped layout). It re-renders only when its item, index or the list's
 * render inputs (`renderItem`, `extraData`, the count) change.
 */
function Cell(props: CellProps): VNode {
  const { ctx, item, index } = props;
  const [extra, setExtra] = useState<Record<string, unknown>>(NO_PROPS);
  const key = ctx.model.keyAt(item, index);
  const registry = ctx.separator ? ctx.registry : null;
  useLayoutEffect(() => {
    if (!registry) return;
    registry.set(key, setExtra);
    return () => {
      if (registry.get(key) === setExtra) registry.delete(key);
    };
  }, [registry, key]);
  const separators = useMemo(() => cellSeparators(ctx, index, setExtra), [ctx, index]);
  const content = ctx.render({ item, index, separators });
  const sep = ctx.separator ? ctx.separator(index, item, extra) : null;
  const parts: VNodeChild[] = ctx.model.inverted ? [sep, content] : [content, sep];
  let node: VNodeChild = ctx.Wrapper
    ? h(ctx.Wrapper, { cellKey: key, index, item }, ...parts)
    : h(Fragment, null, ...parts);
  const snap = ctx.snap ?? (ctx.snapRows?.has(index) ? "start" : null);
  if (snap) node = h("div", { style: { scrollSnapAlign: snap } }, node);
  if (ctx.wrap) node = ctx.wrap(index, item, node);
  return node as VNode;
}

/** A slot as an element: an element as is, a component rendered with no props. */
export function slotElement(slot: RNSlot): VNode | null {
  if (slot === null || slot === undefined) return null;
  if (typeof slot === "object" && "props" in slot && "type" in slot) return slot as VNode;
  return h(slot as VNodeType, null);
}

/** A slot wrapped in a `View` with `style` (as React Native's lists wrap header and footer). */
function styledSlot(prim: ListPrimitives, slot: RNSlot, style: unknown): VNode | null {
  const el = slotElement(slot);
  if (!el || style === undefined || style === null) return el;
  return h(prim.View, { style }, el);
}

/** The render function the engine calls per visual row (stable per cell context). */
function rowRenderer(ctx: CellCtx): VirtualListProps<unknown>["renderItem"] {
  return (item, v) => h(Cell, { ctx, item, index: ctx.model.flip(v) });
}

/** React Native's item separator: after every item but the last. */
function defaultSeparator(
  Separator: VNodeType | null | undefined,
  count: number,
): CellCtx["separator"] {
  if (!Separator) return null;
  return (index, item, extra) =>
    index < count - 1 ? h(Separator, { highlighted: false, leadingItem: item, ...extra }) : null;
}

/** Hook: the cell context, rebuilt when a render input changes (so rows re-render). */
function useCellCtx(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions,
  model: Model,
): CellCtx {
  const registry =
    useRef(new Map<string, (u: (s: Record<string, unknown>) => Record<string, unknown>) => void>())
      .current;
  const { renderItem, ListItemComponent, ItemSeparatorComponent, CellRendererComponent } = list;
  const snap = list.pagingEnabled ? list.snapToAlignment ?? "start" : null;
  return useMemo((): CellCtx => ({
    model,
    render: ListItemComponent
      ? (info) => h(ListItemComponent, info as unknown as Record<string, unknown>)
      : (info) => renderItem ? renderItem(info) : null,
    separator: engine.separator ?? defaultSeparator(ItemSeparatorComponent, model.count),
    Wrapper: CellRendererComponent ?? null,
    snap,
    snapRows: engine.snapRows,
    wrap: engine.wrapCell,
    registry,
  }), [
    model,
    renderItem,
    ListItemComponent,
    ItemSeparatorComponent,
    CellRendererComponent,
    engine.separator,
    engine.wrapCell,
    engine.snapRows,
    snap,
    list.extraData,
    registry,
  ]);
}

/** Viewability callbacks with data indices (sorted), converted by the adapter. */
function viewabilityProps(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions,
  model: Model,
): Partial<VirtualListProps<unknown>> {
  const convert = (tokens: ViewToken<unknown>[]): ViewToken<unknown>[] => {
    const mapped = model.inverted
      ? tokens.map((t) => ({ ...t, index: model.flip(t.index as number) }))
        .sort((a, b) => (a.index as number) - (b.index as number))
      : tokens;
    return engine.convertTokens ? engine.convertTokens(mapped) : mapped;
  };
  const wrap = (cb: ((info: ViewableItemsChanged<unknown>) => void) | null | undefined) =>
    cb
      ? (info: ViewableItemsChanged<unknown>) =>
        cb({ viewableItems: convert(info.viewableItems), changed: convert(info.changed) })
      : null;
  const pairs = list.viewabilityConfigCallbackPairs;
  return {
    viewabilityConfig: list.viewabilityConfig,
    onViewableItemsChanged: wrap(list.onViewableItemsChanged),
    viewabilityConfigCallbackPairs: pairs?.map((p) => ({
      viewabilityConfig: p.viewabilityConfig,
      onViewableItemsChanged: wrap(p.onViewableItemsChanged),
    })),
  };
}

/** The distance (px) from the visual end or start, from the engine's metrics. */
function distance(vl: VirtualListHandle | null, toward: "end" | "start"): number {
  const m = vl?.getScrollMetrics();
  if (!m) return 0;
  return Math.max(0, toward === "end" ? m.max - m.offset : m.offset - m.min);
}

/** The edge callbacks, swapped when inverted (RN's end is the visual start then). */
function edgeProps(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions,
  inverted: boolean,
  vl: { current: VirtualListHandle | null },
): Partial<VirtualListProps<unknown>> {
  const fallback = engine.threshold ?? RN_THRESHOLD;
  const onEnd = list.onEndReached;
  const onStart = list.onStartReached;
  const end = onEnd
    ? (toward: "end" | "start") => onEnd({ distanceFromEnd: distance(vl.current, toward) })
    : null;
  const start = onStart
    ? (toward: "end" | "start") => onStart({ distanceFromStart: distance(vl.current, toward) })
    : null;
  const endThreshold = list.onEndReachedThreshold ?? fallback;
  const startThreshold = list.onStartReachedThreshold ?? fallback;
  const visualEnd = inverted ? start : end;
  const visualStart = inverted ? end : start;
  return {
    onEndReached: visualEnd ? () => visualEnd("end") : undefined,
    onEndReachedThreshold: inverted ? startThreshold : endThreshold,
    onStartReached: visualStart ? () => visualStart("start") : undefined,
    onStartReachedThreshold: inverted ? endThreshold : startThreshold,
  };
}

/** A scroll event in React Native's inverted coordinates (offset measured from the bottom). */
function flipEvent(e: VirtualListScrollEvent, horizontal: boolean): VirtualListScrollEvent {
  const n = e.nativeEvent;
  const dim = horizontal ? "width" : "height";
  const along = horizontal ? n.contentOffset.x : n.contentOffset.y;
  const flipped = Math.max(0, n.contentSize[dim] - n.layoutMeasurement[dim] - along);
  return {
    ...e,
    nativeEvent: {
      ...n,
      contentOffset: horizontal ? { x: flipped, y: 0 } : { x: 0, y: flipped },
    },
  };
}

/** The scroll callbacks: mirrored when inverted; a drag dismisses the keyboard on request. */
function scrollProps(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions,
  inverted: boolean,
): Partial<VirtualListProps<unknown>> {
  const horizontal = !!list.horizontal;
  const map = (cb: ((e: VirtualListScrollEvent) => void) | undefined) =>
    cb ? (e: VirtualListScrollEvent) => cb(inverted ? flipEvent(e, horizontal) : e) : undefined;
  const dismiss = list.keyboardDismissMode === "on-drag" ||
    list.keyboardDismissMode === "interactive";
  const beginDrag = map(list.onScrollBeginDrag);
  const onScroll = map(list.onScroll);
  const frame = engine.onScrollFrame;
  return {
    onScroll: frame || onScroll
      ? (e) => {
        frame?.(e);
        onScroll?.(e);
      }
      : undefined,
    scrollEventThrottle: frame ? 0 : list.scrollEventThrottle,
    onScrollBeginDrag: dismiss || beginDrag
      ? (e) => {
        if (dismiss) Keyboard.dismiss();
        beginDrag?.(e);
      }
      : undefined,
    onScrollEndDrag: map(list.onScrollEndDrag),
    onMomentumScrollBegin: map(list.onMomentumScrollBegin),
    onMomentumScrollEnd: map(list.onMomentumScrollEnd),
  };
}

/** `stickyHeaderIndices` (the header is child 0 when present, as in RN) as visual rows. */
function stickyRows(list: VirtualizedListProps<unknown>, model: Model): number[] | undefined {
  const indices = list.stickyHeaderIndices;
  if (!indices || indices.length === 0) return undefined;
  const shift = list.ListHeaderComponent ? 1 : 0;
  const rows: number[] = [];
  for (const s of indices) {
    const i = s - shift;
    if (i >= 0 && i < model.count) rows.push(model.flip(i));
  }
  return rows.sort((a, b) => a - b);
}

/** Header, footer (swapped when inverted) and the empty state. */
function slotProps(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions,
  prim: ListPrimitives,
  inverted: boolean,
): Partial<VirtualListProps<unknown>> {
  const header = styledSlot(prim, list.ListHeaderComponent, list.ListHeaderComponentStyle);
  const footer = styledSlot(prim, list.ListFooterComponent, list.ListFooterComponentStyle);
  return {
    ListHeaderComponent: inverted ? footer : header,
    ListFooterComponent: inverted ? header : footer,
    ListEmptyComponent: styledSlot(prim, list.ListEmptyComponent, engine.emptyStyle),
  };
}

/** Join class names. */
function classes(...names: (string | undefined | false)[]): string | undefined {
  const out = names.filter(Boolean).join(" ");
  return out === "" ? undefined : out;
}

/** The scroller's own style: flex, `scrollEnabled`, hidden scrollbars, cell snapping. */
function scrollerStyle(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions,
): { own: Record<string, string | number>; hide: boolean } {
  const horizontal = !!list.horizontal;
  const own: Record<string, string | number> = {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    minWidth: 0,
  };
  if (list.scrollEnabled === false) own[horizontal ? "overflowX" : "overflowY"] = "hidden";
  const hide = horizontal
    ? list.showsHorizontalScrollIndicator === false
    : list.showsVerticalScrollIndicator === false;
  if (hide) own.scrollbarWidth = "none";
  if (list.pagingEnabled || (engine.snapRows?.size ?? 0) > 0) {
    own.scrollSnapType = `${horizontal ? "x" : "y"} mandatory`;
  }
  return { own, hide };
}

/** The scroller's class and style (and the content container's), from React Native styles. */
function containerProps(
  list: VirtualizedListProps<unknown>,
  prim: ListPrimitives,
  wrapped: boolean,
  engine: EngineOptions,
): Partial<VirtualListProps<unknown>> {
  const { own, hide } = scrollerStyle(list, engine);
  const user = wrapped ? {} : resolveStyle(prim.StyleSheet, list.style);
  const content = resolveStyle(prim.StyleSheet, list.contentContainerStyle);
  const contentClass = classes(engine.contentContainerClassName, content.class);
  const snap = list.pagingEnabled ? null : snapOptionsFromProps(list);
  return {
    class: classes(engine.className, user.class, hide && HIDE_SCROLLBAR_CLASS),
    style: { ...own, ...user.style },
    ...(snap ? { scrollSnap: snap } : {}),
    ...(engine.scrollerProps ? { scrollerProps: engine.scrollerProps } : {}),
    contentContainerStyle: content.style ?? (contentClass ? {} : undefined),
    contentContainerClass: contentClass,
  };
}

/** The pull-to-refresh control: the app's element, or denext's for a bare `onRefresh`. */
function refreshElement(list: VirtualizedListProps<unknown>, prim: ListPrimitives): VNode | null {
  if (list.refreshControl) return list.refreshControl;
  if (!list.onRefresh || !prim.RefreshControl) return null;
  return h(prim.RefreshControl, {
    refreshing: list.refreshing === true,
    onRefresh: list.onRefresh,
    progressViewOffset: list.progressViewOffset,
  });
}

/** React Native's scroll view base style around a wrapped scroller. */
const WRAPPER_STYLE = { flexGrow: 1, flexShrink: 1, flexDirection: "column" };

/** `control` rendered around `scroller`, with the list's style (as RN's ScrollView does). */
function withRefresh(control: VNode, list: VirtualizedListProps<unknown>, scroller: VNode): VNode {
  const own = control.props as Record<string, unknown>;
  return h(control.type, {
    ...own,
    key: control.key ?? undefined,
    style: own.style ?? [WRAPPER_STYLE, list.style],
    children: undefined,
  }, scroller);
}

/** Which end an insertion should scroll to (`autoscroll*`), from the pre-change position. */
function autoscrollTarget(
  engine: EngineOptions,
  inverted: boolean,
  vl: VirtualListHandle | null,
): "start" | "end" | null {
  if (!vl || (engine.autoscrollStart === undefined && engine.autoscrollEnd === undefined)) {
    return null;
  }
  const m = vl.getScrollMetrics();
  const fromVisualStart = m.offset - m.min;
  const fromVisualEnd = m.max - m.offset;
  const fromStart = inverted ? fromVisualEnd : fromVisualStart;
  const fromEnd = inverted ? fromVisualStart : fromVisualEnd;
  if (engine.autoscrollStart !== undefined && fromStart <= engine.autoscrollStart) return "start";
  const endPx = typeof engine.autoscrollEnd === "function"
    ? engine.autoscrollEnd(m.viewport)
    : engine.autoscrollEnd;
  if (endPx !== undefined && fromEnd <= endPx) return "end";
  return null;
}

/** Scroll to the data start or end (mirrored when inverted). */
function scrollToDataEdge(
  vl: VirtualListHandle,
  edge: "start" | "end",
  inverted: boolean,
  smooth: boolean,
): void {
  const behavior: ScrollBehavior | undefined = smooth ? "smooth" : undefined;
  const visualEnd = (edge === "end") !== inverted;
  if (visualEnd) vl.scrollToEnd({ behavior });
  else vl.scrollToOffset(vl.getScrollMetrics().min, { behavior });
}

/**
 * Hook: when the data changes while the view is near an edge the adapter watches
 * (`autoscrollToTopThreshold`, FlashList's `autoscrollToBottomThreshold`, LegendList's
 * `maintainScrollAtEnd`), scroll to that edge after the commit.
 */
function useAutoscroll(
  data: unknown,
  count: number,
  engine: EngineOptions,
  inverted: boolean,
  vl: { current: VirtualListHandle | null },
): void {
  const last = useRef<{ data: unknown; count: number } | null>(null);
  const pending = useRef<"start" | "end" | null>(null);
  const prev = last.current;
  if (prev && (prev.data !== data || prev.count !== count)) {
    pending.current = autoscrollTarget(engine, inverted, vl.current);
  }
  last.current = { data, count };
  useLayoutEffect(() => {
    const edge = pending.current;
    pending.current = null;
    if (edge && vl.current) scrollToDataEdge(vl.current, edge, inverted, !!engine.autoscrollSmooth);
  });
}

/** Mutable state the handle reads (the latest props and engine handle). */
interface HandleState {
  list: VirtualizedListProps<unknown>;
  model: Model;
  vl: VirtualListHandle | null;
}

/** RN's `animated` (default true) as a scroll behavior. */
function behaviorOf(animated: boolean | null | undefined): ScrollBehavior | undefined {
  return animated === false ? undefined : "smooth";
}

/** Throw React Native's out-of-range error for `scrollToIndex`. */
function checkIndex(index: number, count: number): void {
  if (index >= 0 && index < count) return;
  throw new Error(
    `scrollToIndex out of range: requested index ${index} but ${
      index < 0 ? "minimum is 0" : `maximum is ${count - 1}`
    }`,
  );
}

/**
 * Scroll visual row `v` to React Native's `viewPosition` / `viewOffset` (mirrored when
 * inverted). 0, 1 and an unshifted 0.5 use the engine's exact align-and-correct path; any other
 * position is computed from the row's current layout.
 */
function scrollRowTo(
  vl: VirtualListHandle,
  v: number,
  params: Omit<ScrollToIndexParams, "index">,
  inverted: boolean,
): void {
  const behavior = behaviorOf(params.animated);
  const raw = params.viewPosition ?? 0;
  const position = inverted ? 1 - raw : raw;
  const offset = inverted ? -(params.viewOffset ?? 0) : params.viewOffset ?? 0;
  if (position === 0) return vl.scrollToIndex(v, { align: "start", viewOffset: offset, behavior });
  if (position === 1) return vl.scrollToIndex(v, { align: "end", viewOffset: -offset, behavior });
  if (position === 0.5 && offset === 0) return vl.scrollToIndex(v, { align: "center", behavior });
  const layout = vl.getItemLayout(v);
  if (!layout) return;
  const m = vl.getScrollMetrics();
  vl.scrollToOffset(layout.offset - position * (m.viewport - layout.size) - offset, { behavior });
}

/** A `ScrollView`-like object over the scroll element. */
function scrollResponder(
  state: { current: HandleState },
  scrollToEnd: (o?: { animated?: boolean }) => void,
): ScrollResponder {
  const node = (): Element | null => state.current.vl?.getScrollableNode() ?? null;
  const self: ScrollResponder = {
    scrollTo(options, x, animated) {
      const el = node() as { scrollTo?: (o: ScrollToOptions) => void } | null;
      const o = typeof options === "number" ? { y: options, x, animated } : options ?? {};
      el?.scrollTo?.({ top: o.y, left: o.x, behavior: o.animated === false ? "auto" : "smooth" });
    },
    scrollToEnd,
    flashScrollIndicators() {},
    getScrollableNode: node,
    getInnerViewNode: () =>
      node()?.querySelector?.("[data-vl-content]") ?? node()?.querySelector?.("[data-vl-inner]") ??
        null,
    getNativeScrollRef: node,
    getScrollResponder: () => self,
  };
  return self;
}

/** Build the core handle over `state` (stable; reads the latest state). */
function createCoreHandle(state: { current: HandleState }): CoreHandle {
  const vl = () => state.current.vl;
  const model = () => state.current.model;
  const scrollToEnd = (params?: { animated?: boolean | null }): void => {
    const h = vl();
    if (!h) return;
    const behavior = behaviorOf(params?.animated);
    if (model().inverted) h.scrollToOffset(h.getScrollMetrics().min, { behavior });
    else h.scrollToEnd({ behavior });
  };
  const scrollToIndex = (params: ScrollToIndexParams): void => {
    const m = model();
    checkIndex(params.index, m.count);
    const h = vl();
    if (h) scrollRowTo(h, m.flip(params.index), params, m.inverted);
  };
  const responder = scrollResponder(state, scrollToEnd);
  return {
    scrollToEnd,
    scrollToIndex,
    scrollToItem(params) {
      const m = model();
      for (let i = 0; i < m.count; i++) {
        if (m.itemAt(i) === params.item) return scrollToIndex({ ...params, index: i });
      }
    },
    scrollToOffset(params) {
      const h = vl();
      if (!h) return;
      const metrics = h.getScrollMetrics();
      const target = model().inverted ? metrics.max - params.offset : metrics.min + params.offset;
      h.scrollToOffset(target, { behavior: behaviorOf(params.animated) });
    },
    recordInteraction: () => vl()?.recordInteraction(),
    flashScrollIndicators() {},
    getScrollResponder: () => responder,
    getScrollRef: () => responder,
    getScrollableNode: () => vl()?.getScrollableNode() ?? null,
    hasMore: () => {
      const r = vl()?.getRange();
      return !!r && r.last < model().count - 1;
    },
    measureLayoutRelativeToContainingList() {},
    setupWebWheelHandler() {},
    teardownWebWheelHandler() {},
    setNativeProps() {},
    engine: vl,
    visual: (i) => model().flip(i),
    count: () => model().count,
    inverted: () => model().inverted,
  };
}

/** Engine sizing: exact (`getItemLayout` / the adapter's), estimated, and types. */
function sizingProps(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions,
  model: Model,
): Partial<VirtualListProps<unknown>> {
  const layout = list.getItemLayout;
  const data = list.data;
  const exact = layout ? (i: number) => layout(data, i).length : engine.exactSize;
  const est = engine.estimatedSize;
  const type = engine.typeOf;
  return {
    getItemSize: exact ? (_item, v) => exact(model.flip(v)) : undefined,
    getEstimatedItemSize: est ? (_item, v) => est(model.flip(v)) : undefined,
    estimatedItemSize: engine.estimatedItemSize,
    getItemType: type ? (_item, v) => type(model.flip(v)) : undefined,
  };
}

/**
 * React Native's `VirtualizedList` over denext's `VirtualList` (see the module doc). The
 * adapters render this with their extras in `engine`.
 *
 * @param props The list props, react-native-web's primitives and the adapter's extras.
 * @returns The list.
 */
export function CoreList(props: CoreListProps): VNode {
  const { list, prim } = props;
  const engine = withRNMvcp(list, props.engine);
  const model = useModel(list);
  const vl = useRef<VirtualListHandle | null>(null);
  const state = useRef<HandleState>({ list, model, vl: null });
  state.current.list = list;
  state.current.model = model;
  const handle = useMemo(() => createCoreHandle(state), []);
  useImperativeHandle(props.coreRef, () => handle, [handle]);
  const ctx = useCellCtx(list, engine, model);
  const renderRow = useMemo(() => rowRenderer(ctx), [ctx]);
  useAutoscroll(list.data, model.count, engine, model.inverted, vl);
  useHiddenScrollbarRule(list);
  useMountCallback(engine, handle);
  useOnLayout(list, handle);
  useContentSizeChange(list, handle);
  const host = useMemo(scrollHost, []);
  const room = useEndRoom(list, engine, handle);
  const control = refreshElement(list, prim);
  const renderScroll = scrollRenderer(list, engine);
  const engineRef = (h: VirtualListHandle | null): void => {
    vl.current = h;
    state.current.vl = h;
  };
  const scroller = h(VirtualList as unknown as VNodeType, {
    ref: engineRef,
    count: model.count,
    getItem: model.rowItem,
    keyExtractor: (item: unknown, v: number) => model.keyAt(item, model.flip(v)),
    renderItem: renderRow,
    ...sizingProps(list, engine, model),
    ...layoutProps(list, engine, model),
    ...edgeProps(list, engine, model.inverted, vl),
    ...viewabilityProps(list, engine, model),
    ...scrollProps(list, engine, model.inverted),
    ...slotProps(list, engine, prim, model.inverted),
    ...chromeProps(list, prim, engine, renderScroll, host, control),
    keyboardInset: room,
  });
  return outerList(renderScroll, list, control, host, scroller);
}

/** The app's scroll view renderer: the adapter's (FlashList's forms), else the list's prop. */
function scrollRenderer(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions,
): ((props: ScrollComponentProps) => VNode | null) | null {
  return engine.scrollComponent ?? list.renderScrollComponent ?? null;
}

/** Hook: the room after the last item — the keyboard's overlap plus the adapter's end space. */
function useEndRoom(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions,
  handle: CoreHandle,
): number {
  return useKeyboardRoom(list, handle) + Math.max(0, engine.endSpace ?? 0);
}

/** The scroller's styling: the app's scroll view's (hosted), else the list's own. */
function chromeProps(
  list: VirtualizedListProps<unknown>,
  prim: ListPrimitives,
  engine: EngineOptions,
  render: unknown,
  host: ScrollHost,
  control: VNode | null,
): Partial<VirtualListProps<unknown>> {
  return render
    ? hostedProps(list, prim, host)
    : containerProps(list, prim, control !== null, engine);
}

/** What wraps the scroller: the app's scroll view, a refresh control, or nothing. */
function outerList(
  render: ((props: ScrollComponentProps) => VNode | null) | null,
  list: VirtualizedListProps<unknown>,
  control: VNode | null,
  host: ScrollHost,
  scroller: VNode,
): VNode {
  if (render) return h(ScrollViewHost, { render, list, control, host, scroller });
  return control ? withRefresh(control, list, scroller) : scroller;
}

/** The custom scroll view's instance (its `ref`), and its scroll node as the engine reads it. */
interface ScrollHost {
  instance: unknown;
  readonly ref: (instance: unknown) => void;
  readonly current: Element | null;
}

/** A scroll host: `current` resolves the scroll node of whatever the ref received. */
function scrollHost(): ScrollHost {
  const host: ScrollHost = {
    instance: null,
    ref: (instance) => {
      host.instance = instance;
    },
    get current() {
      return scrollNodeOf(host.instance);
    },
  };
  return host;
}

/**
 * The scroll node of a scroll view instance: a `ScrollView`'s `getScrollableNode()` (React
 * Native's and react-native-web's), or the element itself (react-native-web's ref is the node).
 */
function scrollNodeOf(instance: unknown): Element | null {
  if (instance === null || typeof instance !== "object") return null;
  const v = instance as { getScrollableNode?: () => unknown; nodeType?: unknown };
  if (typeof v.getScrollableNode === "function") {
    const node = v.getScrollableNode();
    if (node && node !== instance) return scrollNodeOf(node);
  }
  return v.nodeType === 1 ? instance as Element : null;
}

/** Set a ref (a function or an object). */
function setRef(ref: unknown, value: unknown): void {
  if (typeof ref === "function") ref(value);
  else if (ref && typeof ref === "object" && "current" in ref) {
    (ref as { current: unknown }).current = value;
  }
}

/**
 * The list's props a custom scroll view receives: the list's own minus what the list handles
 * itself (the scroll callbacks, `onLayout`, `onContentSizeChange`, sticky indices, the content
 * container's style, the ref), plus the refresh element.
 */
function scrollViewProps(
  list: VirtualizedListProps<unknown>,
  control: VNode | null,
  host: ScrollHost,
  children: VNodeChild,
): ScrollComponentProps {
  const {
    onScroll: _onScroll,
    onScrollBeginDrag: _beginDrag,
    onScrollEndDrag: _endDrag,
    onMomentumScrollBegin: _momentumBegin,
    onMomentumScrollEnd: _momentumEnd,
    onLayout: _onLayout,
    onContentSizeChange: _onContentSize,
    stickyHeaderIndices: _sticky,
    contentContainerStyle: _content,
    renderScrollComponent: _render,
    ref: _ref,
    ...rest
  } = list;
  return { ...rest, refreshControl: control, ref: host.ref, children };
}

/** Props of {@linkcode ScrollViewHost}. */
interface ScrollViewHostProps {
  readonly render: (props: ScrollComponentProps) => VNode | null;
  readonly list: VirtualizedListProps<unknown>;
  readonly control: VNode | null;
  readonly host: ScrollHost;
  readonly scroller: VNode;
}

/**
 * The list inside the app's scroll view (`renderScrollComponent`): the element it returns gets
 * the list's ref (merged with its own) and the items as children, as React Native's
 * `VirtualizedList` clones it. A component of its own, so a render function that uses hooks
 * keeps them in one place (as LegendList's and FlashList's wrappers do).
 */
function ScrollViewHost(props: ScrollViewHostProps): VNode {
  const { render, list, control, host, scroller } = props;
  const el = render(scrollViewProps(list, control, host, scroller));
  if (!el) return h(Fragment, null, scroller) as VNode;
  const own = (el.props as { ref?: unknown }).ref;
  const ref = own === host.ref || own === undefined ? host.ref : (instance: unknown) => {
    setRef(own, instance);
    host.ref(instance);
  };
  return cloneElement(el, { ref }, scroller);
}

/** The engine's props inside a custom scroll view: that view's node scrolls, it styles itself. */
function hostedProps(
  list: VirtualizedListProps<unknown>,
  prim: ListPrimitives,
  host: ScrollHost,
): Partial<VirtualListProps<unknown>> {
  const content = resolveStyle(prim.StyleSheet, list.contentContainerStyle);
  return {
    scrollElement: host,
    contentContainerStyle: content.style ?? (content.class ? {} : undefined),
    contentContainerClass: content.class,
  };
}

/**
 * Hook: `automaticallyAdjustKeyboardInsets` — the px of the list's frame the on-screen keyboard
 * covers (React Native's inset: the keyboard frame's overlap with the scroll view's), 0 when off,
 * horizontal or uncovered.
 */
function useKeyboardRoom(list: VirtualizedListProps<unknown>, handle: CoreHandle): number {
  const wanted = list.automaticallyAdjustKeyboardInsets === true && !list.horizontal;
  const covered = useOverlap(wanted).px;
  if (!wanted || covered <= 0) return 0;
  return frameOverlap(handle.getScrollableNode(), covered);
}

/** How much of `node`'s frame a keyboard covering the bottom `covered` px overlaps. */
function frameOverlap(node: Element | null, covered: number): number {
  const rect = (node as { getBoundingClientRect?: () => DOMRect } | null)
    ?.getBoundingClientRect?.();
  const height = (globalThis as { innerHeight?: number }).innerHeight ?? 0;
  if (!rect || !(rect.height > 0) || !(height > 0)) return covered;
  return Math.max(0, Math.min(covered, Math.round(rect.bottom - (height - covered))));
}

/** Hook: the data model, rebuilt when the data, `getItem`, the count or `inverted` change. */
function useModel(list: VirtualizedListProps<unknown>): Model {
  const count = countOf(list);
  const inverted = !!list.inverted;
  const keys = useRef<VirtualizedListProps<unknown>["keyExtractor"]>(list.keyExtractor);
  keys.current = list.keyExtractor;
  return useMemo(
    () => makeModel(list, count, inverted, keys),
    [list.data, list.getItem, count, inverted],
  );
}

/** The slice of an element `onLayout` reads. */
interface LayoutBox {
  offsetLeft?: number;
  offsetTop?: number;
  offsetWidth?: number;
  offsetHeight?: number;
  clientWidth?: number;
  clientHeight?: number;
}

/** React Native's layout event. */
export interface LayoutEventLike {
  readonly nativeEvent: {
    readonly layout: { x: number; y: number; width: number; height: number };
  };
}

/**
 * Report `node`'s layout (its border box with `outer`, else its client box) to `cb` now and
 * whenever it resizes; returns the disconnect.
 */
export function observeLayout(
  node: Element,
  outer: boolean,
  cb: (e: LayoutEventLike) => void,
): () => void {
  const box = node as Element & LayoutBox;
  const report = (): void =>
    cb({
      nativeEvent: {
        layout: {
          x: box.offsetLeft ?? 0,
          y: box.offsetTop ?? 0,
          width: (outer ? box.offsetWidth : box.clientWidth) ?? 0,
          height: (outer ? box.offsetHeight : box.clientHeight) ?? 0,
        },
      },
    });
  report();
  const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (!RO) return () => {};
  const ro = new RO(report);
  ro.observe(node);
  return () => ro.disconnect();
}

/** Hook: React Native's `onLayout`, from a `ResizeObserver` on the scroll element. */
function useOnLayout(list: VirtualizedListProps<unknown>, handle: CoreHandle): void {
  const latest = useRef(list.onLayout);
  latest.current = list.onLayout;
  const wanted = !!list.onLayout;
  useLayoutEffect(() => {
    const node = handle.getScrollableNode();
    if (!wanted || !node) return;
    return observeLayout(node, false, (e) => latest.current?.(e));
  }, [wanted, handle]);
}

/** The scroll element's content size, as `onContentSizeChange` reports it. */
interface ContentBox {
  scrollWidth?: number;
  scrollHeight?: number;
  children?: ArrayLike<Element>;
}

/**
 * Hook: React Native's `onContentSizeChange`, from the scroll element's content size after each
 * commit and whenever one of its children resizes (a row measured, the header or footer
 * changed), reported only when it differs from the last report.
 */
function useContentSizeChange(list: VirtualizedListProps<unknown>, handle: CoreHandle): void {
  const latest = useRef(list.onContentSizeChange);
  latest.current = list.onContentSizeChange;
  const wanted = !!list.onContentSizeChange;
  const state = useRef<{ last: string; ro: ResizeObserver | null; report: () => void }>({
    last: "",
    ro: null,
    report: () => {},
  });
  useLayoutEffect(() => {
    const node = handle.getScrollableNode() as (ContentBox & Element) | null;
    if (!wanted || !node) return;
    const s = state.current;
    s.report = () => {
      const width = node.scrollWidth ?? 0;
      const height = node.scrollHeight ?? 0;
      const key = `${width}x${height}`;
      if (key === s.last) return;
      s.last = key;
      latest.current?.(width, height);
    };
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    s.ro = RO ? new RO(() => s.report()) : null;
    return () => {
      s.ro?.disconnect();
      s.ro = null;
      s.last = "";
    };
  }, [wanted, handle]);
  // After every commit: observe the current children (observing one twice is a no-op), report.
  useLayoutEffect(() => {
    const s = state.current;
    if (!wanted) return;
    const node = handle.getScrollableNode() as (ContentBox & Element) | null;
    for (const child of Array.from(node?.children ?? [])) s.ro?.observe(child);
    s.report();
  });
}

/** Hook: the adapter's `onMount`, once, after the engine's first commit. */
function useMountCallback(engine: EngineOptions, handle: CoreHandle): void {
  const done = useRef(false);
  useLayoutEffect(() => {
    if (done.current) return;
    done.current = true;
    engine.onMount?.(handle);
  });
}

/** Hook: install the hidden-scrollbar rule when a list hides its scrollbar. */
function useHiddenScrollbarRule(list: VirtualizedListProps<unknown>): void {
  const hide = list.showsVerticalScrollIndicator === false ||
    list.showsHorizontalScrollIndicator === false;
  useEffect(() => {
    if (hide) ensureHiddenScrollbarRule();
  }, [hide]);
}

/** The engine's layout: axis, anchoring, window, initial row and sticky rows. */
function layoutProps(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions,
  model: Model,
): Partial<VirtualListProps<unknown>> {
  const initial = list.initialScrollIndex ?? -1;
  return {
    horizontal: !!list.horizontal,
    anchor: model.inverted || engine.anchorEnd ? "end" : "start",
    maintainVisibleContentPosition: engine.mvcp ?? !!list.maintainVisibleContentPosition,
    overscan: list.disableVirtualization ? 1e9 : engine.overscan,
    // React Native's first batch, only when the app sets it (the rest renders after the first
    // paint); unset, one commit renders the whole window (a faster time-to-ready).
    initialNumToRender: list.disableVirtualization || list.initialNumToRender === undefined
      ? undefined
      : Math.max(1, Math.floor(list.initialNumToRender)),
    recycle: engine.recycle === true,
    initialScrollIndex: initial >= 0 && initial < model.count ? model.flip(initial) : undefined,
    initialScrollAlign: model.inverted ? "end" : "start",
    stickyIndices: stickyRows(list, model),
    onBlankArea: engine.onBlankArea,
    keepMounted: engine.keepMounted,
    viewportSize: engine.viewportSize,
    scrollElement: engine.windowScroll ? "window" : undefined,
    onItemMeasured: sizeReporter(engine, model),
  };
}

/** The engine's measurement reports in data rows (`EngineOptions.onItemMeasured`). */
function sizeReporter(
  engine: EngineOptions,
  model: Model,
): VirtualListProps<unknown>["onItemMeasured"] {
  const cb = engine.onItemMeasured;
  if (!cb) return undefined;
  return (info) => cb({ index: model.flip(info.index), size: info.size, previous: info.previous });
}

const NO_ENGINE: EngineOptions = {};

/**
 * React Native's `maintainVisibleContentPosition` on the engine. Without the prop (React
 * Native's default) a data change above the view shifts what is visible, and a view at the very
 * top shows new first items; with it, the visible items stay put, and a view within
 * `autoscrollToTopThreshold` of the start scrolls to new first items. Measurements never move
 * the view either way (the engine anchors size refinements always), so scrolling up into
 * unmeasured items does not jump. An adapter's own `mvcp` / `autoscrollStart` win.
 */
function withRNMvcp(
  list: VirtualizedListProps<unknown>,
  engine: EngineOptions = NO_ENGINE,
): EngineOptions {
  if (engine.mvcp !== undefined) return engine;
  const mvcp = list.maintainVisibleContentPosition;
  const threshold = mvcp ? mvcp.autoscrollToTopThreshold ?? undefined : undefined;
  return { ...engine, mvcp: !!mvcp, autoscrollStart: engine.autoscrollStart ?? threshold };
}

/**
 * React Native's `VirtualizedList` on denext's `VirtualList`, rendering with react-native-web's
 * `View` / `StyleSheet` / `RefreshControl`.
 *
 * @param prim react-native-web's primitives (React Native mode passes the app's own).
 * @returns The component.
 */
export function createVirtualizedList(
  prim: ListPrimitives,
): (props: VirtualizedListProps<unknown>) => VNode {
  function VirtualizedList(props: VirtualizedListProps<unknown>): VNode {
    return h(CoreList, { list: props, prim, coreRef: props.ref as Ref<CoreHandle> });
  }
  return VirtualizedList;
}
