/**
 * The React Native list APIs React Native mode runs on denext's `VirtualList`: the props and
 * ref methods of `FlatList`, `SectionList` and `VirtualizedList` (as react-native-web 0.21 and
 * React Native 0.86 declare them), as the adapters accept them. A prop listed here is honoured,
 * or accepted and documented as a no-op on the web; one React Native declares that is missing
 * here is a known gap (`scripts/parity/native` lists them). Type-only.
 *
 * @module
 */

import type { VNode, VNodeChild, VNodeType } from "../../jsx/types.ts";
import type { Ref } from "../../runtime/hooks.ts";
import type {
  ViewabilityConfig,
  ViewToken,
  VirtualListScrollEvent,
} from "../../client/virtual/types.ts";

export type { ViewabilityConfig, ViewToken } from "../../client/virtual/types.ts";

/** A React Native style: an object, a `StyleSheet.create` entry, an array of them, or falsy. */
export type RNStyle = unknown;

/** A component (called with no props) or an element. */
export type RNSlot = VNodeType | VNode | null | undefined;

/** react-native-web's `StyleSheet`: callable as `StyleSheet(styles)` → `[className, inline]`. */
export interface RNStyleSheet {
  (styles: unknown, options?: unknown): unknown;
}

/**
 * The react-native-web primitives an adapter renders with: React Native mode passes the app's
 * own `View`, `StyleSheet` and (denext's) `RefreshControl`, so styles resolve exactly as the
 * rest of the app's do.
 */
export interface ListPrimitives {
  /** react-native-web's `View` (wrappers for styled headers, footers and grid rows). */
  readonly View: VNodeType;
  /** react-native-web's `StyleSheet` (resolves React Native styles to a class + inline style). */
  readonly StyleSheet?: RNStyleSheet;
  /** The `RefreshControl` used when `onRefresh` is given without a `refreshControl`. */
  readonly RefreshControl?: VNodeType;
}

/** The `separators` a `renderItem` receives (React Native's). */
export interface Separators {
  /** Highlight the separators around this item (`highlighted: true`). */
  highlight(): void;
  /** Undo `highlight()`. */
  unhighlight(): void;
  /** Merge props into the separator before (`"leading"`) or after (`"trailing"`) this item. */
  updateProps(select: "leading" | "trailing", newProps: Record<string, unknown>): void;
}

/** What `renderItem` receives. */
export interface ListRenderItemInfo<T> {
  /** The item. */
  readonly item: T;
  /** Its index in the data. */
  readonly index: number;
  /** Its separators. */
  readonly separators: Separators;
}

/** What `onViewableItemsChanged` receives. */
export interface ViewableItemsInfo<T> {
  /** Every viewable item, in index order. */
  readonly viewableItems: ViewToken<T>[];
  /** The items whose viewability changed. */
  readonly changed: ViewToken<T>[];
}

/** A `viewabilityConfigCallbackPairs` entry. */
export interface ViewabilityPair<T> {
  /** When items count as viewable. */
  readonly viewabilityConfig: ViewabilityConfig;
  /** Called when that set changes. */
  readonly onViewableItemsChanged: ((info: ViewableItemsInfo<T>) => void) | null;
}

/** `getItemLayout`'s result: the item's `length` along the scroll axis (and its `offset`). */
export interface ItemLayout {
  /** Size along the scroll axis, separator included. */
  readonly length: number;
  /** Offset from the first item (not read: offsets are summed from `length`s). */
  readonly offset: number;
  /** The index. */
  readonly index: number;
}

/** `maintainVisibleContentPosition` (React Native's `ScrollView` form). */
export interface MaintainVisibleContentPosition {
  /** Items above this index are not used as anchors (read as: keep the view anchored). */
  readonly minIndexForVisible: number;
  /** When the view is within this many px of the start as items are added there, scroll to it. */
  readonly autoscrollToTopThreshold?: number | null;
}

/** What `onLayout` receives (React Native's `LayoutChangeEvent`). */
export interface LayoutEvent {
  /** The frame, in px relative to the offset parent. */
  readonly nativeEvent: {
    readonly layout: { x: number; y: number; width: number; height: number };
  };
}

/** The scroll-view props every list adapter honours (React Native's `ScrollView` subset). */
export interface ListScrollProps {
  /** Scroll horizontally. */
  readonly horizontal?: boolean | null;
  /** The list's style (the scroll view's). */
  readonly style?: RNStyle;
  /** The content container's style (around the header, the items and the footer). */
  readonly contentContainerStyle?: RNStyle;
  /** React Native's scroll event, throttled by `scrollEventThrottle`. */
  readonly onScroll?: (e: VirtualListScrollEvent) => void;
  /** Least ms between two `onScroll` calls. */
  readonly scrollEventThrottle?: number;
  /** A touch started scrolling (web: from touch events). */
  readonly onScrollBeginDrag?: (e: VirtualListScrollEvent) => void;
  /** The finger lifted. */
  readonly onScrollEndDrag?: (e: VirtualListScrollEvent) => void;
  /** A scroll not driven by a finger began (fling, wheel, keys, `scrollTo*`). */
  readonly onMomentumScrollBegin?: (e: VirtualListScrollEvent) => void;
  /** That scroll came to rest. */
  readonly onMomentumScrollEnd?: (e: VirtualListScrollEvent) => void;
  /** `false`: the user cannot scroll (programmatic scrolls still work). */
  readonly scrollEnabled?: boolean;
  /** `false` hides the vertical scrollbar (CSS). */
  readonly showsVerticalScrollIndicator?: boolean;
  /** `false` hides the horizontal scrollbar (CSS). */
  readonly showsHorizontalScrollIndicator?: boolean;
  /**
   * Accepted. On the web, a tap on a focusable control keeps the keyboard up and a tap
   * elsewhere may blur the input, whatever the value (best effort: the browser decides).
   */
  readonly keyboardShouldPersistTaps?: boolean | "always" | "never" | "handled";
  /** `"on-drag"` (and `"interactive"`) dismiss the keyboard when a drag starts. */
  readonly keyboardDismissMode?: "none" | "on-drag" | "interactive";
  /** A pull-to-refresh control element (e.g. `<RefreshControl />`); wraps the scroller. */
  readonly refreshControl?: VNode | null;
  /** Items that stick to the top (the header counts as index 0 when present, as in RN). */
  readonly stickyHeaderIndices?: readonly number[];
  /** Accepted: sticky items always stick to the visible top (also when `inverted`). */
  readonly invertStickyHeaders?: boolean;
  /**
   * Keep the visible items in place when items are added or removed above them (without it,
   * as in React Native, such a change shifts the view and a view at the very top shows the new
   * first items). With it, `autoscrollToTopThreshold` scrolls to new first items from within
   * that distance of the start. Items measured taller or shorter than estimated never move the
   * view either way.
   */
  readonly maintainVisibleContentPosition?: MaintainVisibleContentPosition | null;
  /** Snap each item to the viewport's start (CSS scroll snap). */
  readonly pagingEnabled?: boolean;
  /** Where items snap with `pagingEnabled`. Default `"start"`. */
  readonly snapToAlignment?: "start" | "center" | "end";
  /** Accepted: nested scrolling works on the web without it (Android-only in RN). */
  readonly nestedScrollEnabled?: boolean;
  /** Called with the list's frame on mount and whenever it resizes. */
  readonly onLayout?: (event: LayoutEvent) => void;
}

/** `VirtualizedList`'s props (React Native's), as the adapter takes them. */
export interface VirtualizedListProps<T> extends ListScrollProps {
  /** The data source, read through `getItem` / `getItemCount`. */
  readonly data?: unknown;
  /** Item `index` of `data`. Keep it stable (a new function means new data). */
  readonly getItem?: (data: unknown, index: number) => T;
  /** How many items `data` holds. */
  readonly getItemCount?: (data: unknown) => number;
  /** Render one item. */
  readonly renderItem?: ((info: ListRenderItemInfo<T>) => VNodeChild) | null;
  /** A component rendered for each item instead of `renderItem` (same props). */
  readonly ListItemComponent?: VNodeType | null;
  /** An item's key. Default: `item.key`, else `item.id`, else the index. */
  readonly keyExtractor?: ((item: T, index: number) => string) | null;
  /** Re-render the items when this changes (they are memoized on their props otherwise). */
  readonly extraData?: unknown;
  /** Exact item sizes: `length` (separator included). Items are then never measured. */
  readonly getItemLayout?: ((data: unknown, index: number) => ItemLayout) | null;
  /** Show this item first (at the start; at the bottom when `inverted`). */
  readonly initialScrollIndex?: number | null;
  /**
   * Reverse the list LOGICALLY: item 0 at the bottom, the view starting (and staying) there,
   * wheel, keys, selection, copy order and the scrollbar all natural (no `scaleY(-1)`).
   * `ListHeaderComponent` renders at the bottom and `ListFooterComponent` at the top, as in RN.
   */
  readonly inverted?: boolean | null;
  /** Rendered between items; receives `highlighted` and `leadingItem`. */
  readonly ItemSeparatorComponent?: VNodeType | null;
  /** Rendered before the items. */
  readonly ListHeaderComponent?: RNSlot;
  /** The header's wrapper style. */
  readonly ListHeaderComponentStyle?: RNStyle;
  /** Rendered after the items. */
  readonly ListFooterComponent?: RNSlot;
  /** The footer's wrapper style. */
  readonly ListFooterComponentStyle?: RNStyle;
  /** Rendered instead of the items when there are none; it fills the viewport. */
  readonly ListEmptyComponent?: RNSlot;
  /** Wraps each item (receives `cellKey`, `index`, `item`, `children`). */
  readonly CellRendererComponent?: VNodeType | null;
  /** Called when the view nears the end (once per data change). */
  readonly onEndReached?: ((info: { distanceFromEnd: number }) => void) | null;
  /** Distance from the end, in viewports, that fires `onEndReached`. Default 2, as in RN. */
  readonly onEndReachedThreshold?: number | null;
  /** Called when the view nears the start (older history). */
  readonly onStartReached?: ((info: { distanceFromStart: number }) => void) | null;
  /** Distance from the start, in viewports, that fires `onStartReached`. Default 2. */
  readonly onStartReachedThreshold?: number | null;
  /** Called with the viewable items when they change. */
  readonly onViewableItemsChanged?: ((info: ViewableItemsInfo<T>) => void) | null;
  /** When items count as viewable. */
  readonly viewabilityConfig?: ViewabilityConfig;
  /** Several configs, each with its own callback. */
  readonly viewabilityConfigCallbackPairs?: readonly ViewabilityPair<T>[];
  /** Whether a refresh is running. */
  readonly refreshing?: boolean | null;
  /** Pull-to-refresh: given without `refreshControl`, denext's `RefreshControl` is used. */
  readonly onRefresh?: (() => void) | null;
  /** Where the refresh spinner rests, in px. */
  readonly progressViewOffset?: number;
  /**
   * Never called: `scrollToIndex` lands exactly on any index in range, measured or not (an
   * index out of range throws, as in React Native).
   */
  readonly onScrollToIndexFailed?: (info: {
    index: number;
    highestMeasuredFrameIndex: number;
    averageItemLength: number;
  }) => void;
  /** Render every item (no virtualization). Use for short lists only. */
  readonly disableVirtualization?: boolean;
  /** Accepted, no effect: denext renders the viewport's items (plus overscan) at once. */
  readonly initialNumToRender?: number;
  /** Accepted, no effect (denext's window follows the viewport and scroll speed). */
  readonly windowSize?: number;
  /** Accepted, no effect. */
  readonly maxToRenderPerBatch?: number;
  /** Accepted, no effect. */
  readonly updateCellsBatchingPeriod?: number;
  /** Accepted, no effect: off-screen items are unmounted, not clipped. */
  readonly removeClippedSubviews?: boolean;
  /** Accepted, no effect. */
  readonly debug?: boolean;
  /** Receives the list's ref methods. */
  readonly ref?: Ref<VirtualizedListRef>;
}

/** `FlatList`'s props. */
export interface FlatListProps<T> extends Omit<VirtualizedListProps<T>, "data" | "ref"> {
  /** The items. */
  readonly data?: ArrayLike<T> | null;
  /** Lay items out in rows of `numColumns` (not with `horizontal`). */
  readonly numColumns?: number;
  /** Each row's style when `numColumns > 1`. */
  readonly columnWrapperStyle?: RNStyle;
  /** Accepted, no effect. */
  readonly legacyImplementation?: boolean;
  /** Accepted, no effect (Android-only). */
  readonly fadingEdgeLength?: number | { start: number; end: number };
  /** Accepted: the list is a pure component either way. */
  readonly strictMode?: boolean;
  /** Receives the list's ref methods. */
  readonly ref?: Ref<FlatListRef<T>>;
}

/** One section of a `SectionList`. */
export interface SectionData<T> {
  /** The section's items. */
  readonly data: readonly T[];
  /** The section's key (default: its index). */
  readonly key?: string;
  /** Renders this section's items instead of the list's `renderItem`. */
  readonly renderItem?: (info: SectionRenderItemInfo<T>) => VNodeChild;
  /** This section's item separator. */
  readonly ItemSeparatorComponent?: VNodeType | null;
  /** This section's key extractor. */
  readonly keyExtractor?: (item: T, index: number) => string;
  /** Anything else the app keeps on a section. */
  readonly [extra: string]: unknown;
}

/** What a `SectionList`'s `renderItem` receives. */
export interface SectionRenderItemInfo<T> extends ListRenderItemInfo<T> {
  /** The item's section. */
  readonly section: SectionData<T>;
}

/** `SectionList`'s props. */
export interface SectionListProps<T>
  extends
    Omit<VirtualizedListProps<T>, "data" | "getItem" | "getItemCount" | "renderItem" | "ref"> {
  /** The sections. */
  readonly sections: readonly SectionData<T>[];
  /** Render one item. */
  readonly renderItem?: (info: SectionRenderItemInfo<T>) => VNodeChild;
  /** Render a section's header (sticky with `stickySectionHeadersEnabled`). */
  readonly renderSectionHeader?: (info: { section: SectionData<T> }) => VNodeChild;
  /** Render a section's footer. */
  readonly renderSectionFooter?: (info: { section: SectionData<T> }) => VNodeChild;
  /** Rendered after each section's header and after its last item. */
  readonly SectionSeparatorComponent?: VNodeType | null;
  /**
   * Section headers stick to the top while their section scrolls. Default: `false` on
   * Android-like platforms (the Android shell, an Android browser), `true` elsewhere.
   */
  readonly stickySectionHeadersEnabled?: boolean;
  /** Accepted, no effect. */
  readonly legacyImplementation?: boolean;
  /** Receives the list's ref methods. */
  readonly ref?: Ref<SectionListRef>;
}

/** Options of the `scrollTo*` methods. */
export interface ScrollToIndexParams {
  /** The index (for `numColumns > 1`, the row, as in React Native). */
  readonly index: number;
  /** Animate. Default `true`. */
  readonly animated?: boolean | null;
  /** 0 = at the start of the viewport, 1 = at the end, 0.5 = centred. */
  readonly viewPosition?: number;
  /** Px added between the item and that position. */
  readonly viewOffset?: number;
}

/** What `getScrollResponder()` / `getNativeScrollRef()` return: a `ScrollView`-like object. */
export interface ScrollResponder {
  /** Scroll the element to raw DOM offsets (`{ x, y, animated }`, or `(y, x, animated)`). */
  scrollTo(
    options?: { x?: number; y?: number; animated?: boolean } | number,
    x?: number,
    animated?: boolean,
  ): void;
  /** Scroll to the end of the list. */
  scrollToEnd(options?: { animated?: boolean }): void;
  /** Does nothing on the web. */
  flashScrollIndicators(): void;
  /** The scroll element. */
  getScrollableNode(): Element | null;
  /** The content container element. */
  getInnerViewNode(): Element | null;
  /** The scroll element. */
  getNativeScrollRef(): Element | null;
  /** This object. */
  getScrollResponder(): ScrollResponder;
}

/** The ref methods of a `VirtualizedList` (react-native-web's instance methods). */
export interface VirtualizedListRef {
  /** Scroll to the end of the data (the top, when `inverted`). */
  scrollToEnd(params?: { animated?: boolean | null }): void;
  /** Scroll item `index` into place: exact, measured or not. Throws out of range, as in RN. */
  scrollToIndex(params: ScrollToIndexParams): void;
  /** Scroll to an item (a linear scan, as in React Native). */
  scrollToItem(params: Omit<ScrollToIndexParams, "index"> & { item: unknown }): void;
  /** Scroll to a content offset (the header included; from the bottom when `inverted`). */
  scrollToOffset(params: { offset: number; animated?: boolean | null }): void;
  /** Count as an interaction for `viewabilityConfig.waitForInteraction`. */
  recordInteraction(): void;
  /** Does nothing on the web. */
  flashScrollIndicators(): void;
  /** A `ScrollView`-like object over the scroll element. */
  getScrollResponder(): ScrollResponder | null;
  /** Same as `getScrollResponder()`. */
  getScrollRef(): ScrollResponder | null;
  /** The scroll element. */
  getScrollableNode(): Element | null;
  /** Whether items beyond the rendered window exist. */
  hasMore(): boolean;
  /** Does nothing (nested-list bookkeeping React Native needs; denext does not). */
  measureLayoutRelativeToContainingList(): void;
  /** Does nothing: react-native-web's inverted-wheel workaround is not needed. */
  setupWebWheelHandler(): void;
  /** Does nothing. */
  teardownWebWheelHandler(): void;
  /** Does nothing. */
  setNativeProps(props: Record<string, unknown>): void;
}

/** The ref methods of a `FlatList`. */
export interface FlatListRef<T = unknown> {
  /** Scroll to the end of the data (the top, when `inverted`). */
  scrollToEnd(params?: { animated?: boolean | null }): void;
  /** Scroll item (row) `index` into place, exactly. Throws out of range, as in RN. */
  scrollToIndex(params: ScrollToIndexParams): void;
  /** Scroll to an item (a linear scan). */
  scrollToItem(params: Omit<ScrollToIndexParams, "index"> & { item: T }): void;
  /** Scroll to a content offset (the header included; from the bottom when `inverted`). */
  scrollToOffset(params: { offset: number; animated?: boolean | null }): void;
  /** Count as an interaction for `viewabilityConfig.waitForInteraction`. */
  recordInteraction(): void;
  /** Does nothing on the web. */
  flashScrollIndicators(): void;
  /** A `ScrollView`-like object over the scroll element. */
  getScrollResponder(): ScrollResponder | null;
  /** A `ScrollView`-like object over the scroll element. */
  getNativeScrollRef(): ScrollResponder | null;
  /** The scroll element. */
  getScrollableNode(): Element | null;
  /** Does nothing. */
  setNativeProps(props: Record<string, unknown>): void;
}

/** `scrollToLocation`'s params. */
export interface SectionListScrollParams {
  /** The section. */
  readonly sectionIndex: number;
  /** The item within it, counted from the header (0 = the header, 1 = the first item: RN's). */
  readonly itemIndex: number;
  /** 0 = at the start of the viewport (under a sticky header), 1 = at the end. */
  readonly viewPosition?: number;
  /** Px added between the item and that position. */
  readonly viewOffset?: number;
  /** Animate. Default `true`. */
  readonly animated?: boolean;
}

/** The ref methods of a `SectionList`. */
export interface SectionListRef {
  /** Scroll to an item of a section, below its sticky header. */
  scrollToLocation(params: SectionListScrollParams): void;
  /** Count as an interaction for `viewabilityConfig.waitForInteraction`. */
  recordInteraction(): void;
  /** Does nothing on the web. */
  flashScrollIndicators(): void;
  /** A `ScrollView`-like object over the scroll element. */
  getScrollResponder(): ScrollResponder | null;
  /** The scroll element. */
  getScrollableNode(): Element | null;
}
