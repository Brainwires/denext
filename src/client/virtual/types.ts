/**
 * Public types of `VirtualList` / `useVirtualList`.
 *
 * @module
 */

import type { Ref } from "../../runtime/hooks.ts";
import type { Component, VNode, VNodeChild } from "../../jsx/types.ts";
import type { TextEstimateOptions } from "./text-estimate.ts";
import type {
  ViewabilityConfig,
  ViewabilityConfigCallbackPair,
  ViewableItemsChanged,
} from "./viewability.ts";
import type { VirtualListScrollEvent } from "./scroll-events.ts";
import type { ItemLayoutAnimationOptions } from "./animate.ts";
import type { ScrollSnapOptions } from "./snap.ts";

export type { TextEstimateOptions } from "./text-estimate.ts";
export type {
  ViewabilityConfig,
  ViewabilityConfigCallbackPair,
  ViewableItemsChanged,
  ViewToken,
} from "./viewability.ts";
export type {
  ScrollNativeEvent,
  ScrollPoint,
  ScrollSize,
  VirtualListScrollEvent,
} from "./scroll-events.ts";
export type { ItemLayoutAnimationOptions } from "./animate.ts";

/** A row's stable identity. */
export type VirtualListKey = string | number;

/** Where a row lands in the viewport when scrolled to (`"auto"`: the least movement). */
export type VirtualListAlign = "start" | "center" | "end" | "auto";

/**
 * What scrolls the list: its own element (`"self"`, the default), the page (`"window"`), or
 * an ancestor element (an `Element` or a ref to one) the list sits inside.
 */
export type VirtualListScrollElement =
  | "self"
  | "window"
  | Element
  | { readonly current: Element | null };

/** An inclusive row range (`last < first` when empty). */
export interface VirtualListRange {
  /** First row. */
  readonly first: number;
  /** Last row (inclusive). */
  readonly last: number;
}

/** Blank space at each end of the viewport that no rendered row covers (diagnostics). */
export interface VirtualListBlankArea {
  /** Blank px at the leading edge. */
  readonly before: number;
  /** Blank px at the trailing edge. */
  readonly after: number;
}

/** Options for {@linkcode VirtualListHandle.scrollToIndex}. */
export interface ScrollToIndexOptions {
  /** Alignment of the row in the viewport. Default `"start"`. */
  readonly align?: VirtualListAlign;
  /** `"smooth"` animates (then lands exactly); default instant. */
  readonly behavior?: ScrollBehavior;
  /** Extra px between the row and the aligned viewport edge. */
  readonly viewOffset?: number;
}

/** The imperative handle of a `VirtualList` (its `ref`) and of `useVirtualList`. */
export interface VirtualListHandle {
  /**
   * Scroll row `index` into view. Lands exactly even when the row and every row above it
   * were never measured: the list scrolls to the estimate, measures, and corrects until the
   * row sits at its aligned position.
   */
  scrollToIndex(index: number, options?: ScrollToIndexOptions): void;
  /** Scroll to a list offset in px (0 = the first row's leading edge). */
  scrollToOffset(offset: number, options?: { readonly behavior?: ScrollBehavior }): void;
  /** Scroll to the very end; with `anchor: "end"` the list then stays pinned there. */
  scrollToEnd(options?: { readonly behavior?: ScrollBehavior }): void;
  /** The rows currently intersecting the viewport. */
  getRange(): VirtualListRange;
  /** Whether the view is at the end (within 4 px). */
  isAtEnd(): boolean;
  /** The current list offset in px (the value `scrollToOffset` takes). */
  getScrollOffset(): number;
  /**
   * The row (item, in a grid) under a viewport point (`clientX` / `clientY`), or −1 outside
   * the rows — including rows not rendered. What drag-and-drop uses to find a drop target.
   */
  indexAtPoint(clientX: number, clientY: number): number;
  /** Row `index`'s key (`undefined` out of range). */
  keyAt(index: number): VirtualListKey | undefined;
  /**
   * Count as a user interaction for `viewabilityConfig.waitForInteraction` (React Native's
   * `recordInteraction`), and re-check viewability now.
   */
  recordInteraction(): void;
  /**
   * The element that scrolls the list (the list's own scroller, or the `scrollElement`
   * ancestor); null before mount and with `scrollElement: "window"`. React Native's
   * `getScrollableNode`.
   */
  getScrollableNode(): Element | null;
  /**
   * Row `index`'s list offset and size in px (its line's, in a grid): measured, else
   * estimated (`measured` says which; an exact `getItemSize` counts as measured); `undefined`
   * out of range. What React Native's `getLayout` / `getState` read.
   */
  getItemLayout(
    index: number,
  ): { readonly offset: number; readonly size: number; readonly measured: boolean } | undefined;
  /** The scroll position and extent, in list offsets (the value `scrollToOffset` takes). */
  getScrollMetrics(): VirtualListScrollMetrics;
}

/** What {@linkcode VirtualListHandle.getScrollMetrics} returns (px, list offsets). */
export interface VirtualListScrollMetrics {
  /** The current offset (`getScrollOffset()`). */
  readonly offset: number;
  /** The viewport's size along the scroll axis. */
  readonly viewport: number;
  /** The smallest offset: minus the header's size (0 without one). */
  readonly min: number;
  /** The largest offset: the end of the footer at the viewport's end. */
  readonly max: number;
  /** The rows' total size (measured, else estimated). */
  readonly rows: number;
}

/** A component or an element: `ListHeaderComponent={Header}` or `={<Header />}`. */
export type VirtualListSlot = Component<Record<string, never>> | VNode | null | undefined;

/** Options shared by `VirtualList` and `useVirtualList`. */
export interface VirtualListOptions<T> {
  /** The rows. Treat as immutable: pass a new array when rows change. */
  readonly data?: readonly T[];
  /** Row count, for lazy or huge sources read with `getItem` (instead of `data`). */
  readonly count?: number;
  /** Row `index` of a `count`-sized source. Pass a new function when rows move. */
  readonly getItem?: (index: number) => T;
  /**
   * A row's stable key. Default: `item.key`, else `item.id`, else the index (as RN's
   * FlatList). Keys keep rows mounted across data changes and anchor the view by identity.
   */
  readonly keyExtractor?: (item: T, index: number) => VirtualListKey;
  /** Size (px along the scroll axis) assumed for rows not yet measured. Default 48. */
  readonly estimatedItemSize?: number;
  /** A per-row estimate for rows not yet measured (only a hint: rows are still measured). */
  readonly getEstimatedItemSize?: (item: T, index: number) => number;
  /**
   * A row's exact size: rows with a known size need no measurement. Also what the
   * deterministic test mode uses (see `VirtualList`).
   */
  readonly getItemSize?: (item: T, index: number) => number;
  /** Predict text rows' sizes from font metrics before they render (canvas `measureText`). */
  readonly estimateText?: TextEstimateOptions<T>;
  /** A row's type: `renderItem` receives it, and recycling reuses cells only within a type. */
  readonly getItemType?: (item: T, index: number) => string | number;
  /**
   * Reuse rendered cells for new rows of the same type instead of unmounting and mounting
   * (FlashList-style). Default `false`: a recycled cell keeps its component state, so use it
   * only for rows that derive everything from props.
   */
  readonly recycle?: boolean;
  /** Scroll horizontally. */
  readonly horizontal?: boolean;
  /**
   * `"end"` for chat: start at the end, align short content to the end, and stay pinned to
   * the end while the view is there (appends, a growing last row, streaming). Default
   * `"start"`.
   */
  readonly anchor?: "start" | "end";
  /**
   * Keep the visible rows in place when rows are added or removed above them (anchored by
   * key). Default `true`. With `false`, a data change above the view shifts what is visible
   * (React Native's default: a view at the very top shows new first rows). Size refinements —
   * a row measured taller or shorter than its estimate, a resize — never move the visible rows
   * either way, and a pending `scrollToIndex` holds its target either way.
   */
  readonly maintainVisibleContentPosition?: boolean;
  /**
   * Px rendered beyond the viewport on each side (default: one viewport). The side in the
   * direction of travel grows with scroll speed.
   */
  readonly overscan?: number;
  /**
   * When set, the first commit renders at most this many rows (the viewport's, no overscan)
   * and the rest of the window after the first paint, like React Native's
   * `initialNumToRender`. Unset: one commit renders the whole window — a faster time-to-ready.
   * (A list with no size information renders at most 10 rows until its first measurement
   * either way.)
   */
  readonly initialNumToRender?: number;
  /** Row to show first (server-rendered at that position, no flash of row 0). */
  readonly initialScrollIndex?: number;
  /** Alignment of `initialScrollIndex`. Default `"start"`. */
  readonly initialScrollAlign?: "start" | "center" | "end";
  /**
   * Called when the view nears the end: on movement toward it within
   * `onEndReachedThreshold` viewports, or when the content is shorter than the viewport.
   * Never on mount otherwise; at most once per data change.
   */
  readonly onEndReached?: () => void;
  /** Distance from the end, in viewports, that fires `onEndReached`. Default 0.5. */
  readonly onEndReachedThreshold?: number;
  /** Like `onEndReached`, at the start (older history in a chat). */
  readonly onStartReached?: () => void;
  /** Distance from the start, in viewports, that fires `onStartReached`. Default 0.5. */
  readonly onStartReachedThreshold?: number;
  /** Called with the first and last visible rows whenever they change. */
  readonly onRangeChange?: (first: number, last: number) => void;
  /**
   * Called when a measurement is applied to a row: its first one, and every later one that
   * changes its size along the scroll axis. `size` is the measured size and `previous` the one
   * the list used before (an estimate, or an earlier measurement); `index` is the row's first
   * item (a grid reports each line once). Rows with an exact `getItemSize` are not measured.
   */
  readonly onItemMeasured?: (
    info: { readonly index: number; readonly size: number; readonly previous: number },
  ) => void;
  /** What scrolls the list. Default `"self"`. */
  readonly scrollElement?: VirtualListScrollElement;
  /**
   * Viewport size (px) assumed where there is no layout: server rendering, the first client
   * render, and tests. Default 800.
   */
  readonly viewportSize?: number;
  /**
   * Development-only diagnostic: called after each scroll frame that shows blank space (no
   * rendered row) inside the viewport. Never called in production builds.
   */
  readonly onBlankArea?: (blank: VirtualListBlankArea) => void;
  /**
   * Keys of rows that stay mounted while scrolled out of the window (a playing video, a
   * half-filled form, a dragged row). The focused row and a text selection's first and last
   * rows are always kept; this adds more. Keep the list short: each key is a mounted row.
   */
  readonly keepMounted?: readonly VirtualListKey[];
  /**
   * Save the view (the anchor row's key, its offset, nearby sizes) when the list unmounts or
   * the page is hidden, and restore it when the list mounts again for the same history entry
   * — back / forward navigation (denext's router, bfcache-less reloads) or a remount on the
   * same page. A new navigation to the page starts fresh. Unique per list on a page. Not needed
   * for development: in dev, a list without one lands back on the same row when a hot update
   * remounts it or the page reloads.
   */
  readonly restoreKey?: string;
  /** When rows count as viewable for `onViewableItemsChanged` (React Native's). */
  readonly viewabilityConfig?: ViewabilityConfig;
  /**
   * Called with every viewable row and the rows whose viewability changed, on scroll and on
   * data changes. The latest function is always the one called (it may change every render).
   */
  readonly onViewableItemsChanged?: ((info: ViewableItemsChanged<T>) => void) | null;
  /** Several configs, each with its own callback (React Native's). */
  readonly viewabilityConfigCallbackPairs?: readonly ViewabilityConfigCallbackPair<T>[];
  /**
   * Called on scroll with React Native's event shape (`nativeEvent.contentOffset`,
   * `contentSize`, `layoutMeasurement`) plus `programmatic` (the list's own write).
   */
  readonly onScroll?: (e: VirtualListScrollEvent) => void;
  /** Least ms between two `onScroll` calls; 0 (default) calls it on every scroll frame. */
  readonly scrollEventThrottle?: number;
  /** A touch started scrolling the list (web: best effort, from touch events). */
  readonly onScrollBeginDrag?: (e: VirtualListScrollEvent) => void;
  /** The finger that was scrolling the list lifted. */
  readonly onScrollEndDrag?: (e: VirtualListScrollEvent) => void;
  /**
   * A scroll not driven by a finger began: a fling after a touch, or a wheel, keyboard,
   * scrollbar or programmatic (`scrollTo*`) scroll.
   */
  readonly onMomentumScrollBegin?: (e: VirtualListScrollEvent) => void;
  /** That scroll came to rest (`scrollend`, or a short quiet period where it is missing). */
  readonly onMomentumScrollEnd?: (e: VirtualListScrollEvent) => void;
  /** Receives the {@linkcode VirtualListHandle}. */
  readonly ref?: Ref<VirtualListHandle>;
}

/**
 * What {@linkcode VirtualListProps.refreshControl} passes a control component: the list's
 * refresh state, its `class` and `style`, and the list's scroller as `children`. Any
 * component that accepts these fits, `RefreshControl` from `denext/mobile` included.
 */
export type RefreshControlSlotProps = {
  /** Whether a refresh is in progress. */
  readonly refreshing: boolean;
  /** Called to refresh. */
  readonly onRefresh?: () => void;
  /** Where the refresh spinner rests, in px. */
  readonly progressViewOffset?: number;
  /** The list's `class` (or `className`). */
  readonly class?: string;
  /** The list's style, with `display: flex; flex-direction: column` in front. */
  readonly style?: Readonly<Record<string, string | number>>;
};

/** Props of `VirtualList`. */
export interface VirtualListProps<T> extends VirtualListOptions<T> {
  /** Render one row. */
  readonly renderItem: (
    item: T,
    index: number,
    info: { readonly type: string | number },
  ) => VNodeChild;
  /**
   * Rows that stick to the top (left when horizontal) while their section scrolls: the real
   * row element (focusable and touchable), not a copy.
   */
  readonly stickyIndices?: readonly number[];
  /** Rendered before the rows. */
  readonly ListHeaderComponent?: VirtualListSlot;
  /** Rendered after the rows. */
  readonly ListFooterComponent?: VirtualListSlot;
  /** Rendered instead of the rows when there are none; it fills the viewport. */
  readonly ListEmptyComponent?: VirtualListSlot;
  /** Rendered between rows. */
  readonly ItemSeparatorComponent?: VirtualListSlot;
  /**
   * Opt-in browser find-in-page (Ctrl/Cmd+F) for rows outside the rendered window: they are
   * rendered as cheap `hidden="until-found"` text stubs, and a match scrolls its row into view
   * (`beforematch`). Feature-detected: a no-op where unsupported. `text` is a row's searchable
   * text (default: `estimateText.text`, or the item itself when it is a string); `limit` caps
   * the stubs around the viewport (default 2000).
   */
  readonly findInPage?:
    | boolean
    | { readonly text?: (item: T, index: number) => string; readonly limit?: number };
  /**
   * Arrow / Page / Home / End keys move focus between rows (into rows not rendered yet),
   * with a roving `tabindex`. Default `true`. In a grid the arrows move by cell.
   */
  readonly keyboardNavigation?: boolean;
  /**
   * Typing a letter on a focused row moves focus to the next row whose text starts with the
   * typed prefix (rows not rendered included). `true` reads the text from `findInPage.text`,
   * `estimateText.text` or a string item; a function supplies it.
   */
  readonly typeahead?: boolean | ((item: T, index: number) => string);
  /**
   * Announce row-count changes politely to screen readers (an `aria-live` region):
   * `true` says "N items"; a function returns the message.
   */
  readonly announceChanges?: boolean | ((count: number, previous: number) => string);
  /**
   * Lay rows out in `numColumns` columns (a grid): the list virtualizes lines of items, each
   * line as tall as its tallest item. Index-based APIs (`scrollToIndex`, `initialScrollIndex`,
   * `getRange`, `onRangeChange`, `stickyIndices`) stay item indices.
   */
  readonly numColumns?: number;
  /** Space between rows (and between columns of a grid), in px (CSS `gap`). */
  readonly gap?: number;
  /** Space between rows in px (overrides `gap` for rows). */
  readonly rowGap?: number;
  /** Space between the columns of a grid in px (overrides `gap` for columns). */
  readonly columnGap?: number;
  /** Style of each grid line (React Native's `columnWrapperStyle`). */
  readonly columnWrapperStyle?: Readonly<Record<string, string | number>>;
  /**
   * Style of the content container (the element around the header, the rows and the footer),
   * e.g. padding or `flexGrow`. React Native's `contentContainerStyle`.
   */
  readonly contentContainerStyle?: Readonly<Record<string, string | number>>;
  /** Class of the content container. */
  readonly contentContainerClass?: string;
  /** React spelling of `contentContainerClass`. */
  readonly contentContainerClassName?: string;
  /** Style of the header's wrapper. */
  readonly ListHeaderComponentStyle?: Readonly<Record<string, string | number>>;
  /** Style of the footer's wrapper. */
  readonly ListFooterComponentStyle?: Readonly<Record<string, string | number>>;
  /**
   * Px of the list's viewport covered by the on-screen keyboard (e.g. `useKeyboard().height`
   * from `denext/mobile` when the keyboard overlays the page). The list adds that much room
   * after the last row, and a list at its end (`anchor="end"`, a chat) stays at its end —
   * the last message above the keyboard, with one adjustment.
   */
  readonly keyboardInset?: number;
  /**
   * Pull-to-refresh, React Native's way: a component (called with `refreshing`, `onRefresh`,
   * `progressViewOffset`) or an element; it is rendered AROUND the list's scroller, with the
   * list's `class` and `style`. `RefreshControl` from `denext/mobile` is one.
   */
  readonly refreshControl?: Component<RefreshControlSlotProps> | VNode | null;
  /** Whether a refresh is in progress (passed to a `refreshControl` component). */
  readonly refreshing?: boolean;
  /** Called to refresh (passed to a `refreshControl` component). */
  readonly onRefresh?: () => void;
  /** Where the refresh spinner rests, in px (passed to a `refreshControl` component). */
  readonly progressViewOffset?: number;
  /**
   * Animate rendered rows when the data changes: moves glide, inserts fade in, removals fade
   * out (FLIP, Web Animations API). Scrolling never animates. Default off (no cost).
   */
  readonly itemLayoutAnimation?: boolean | ItemLayoutAnimationOptions;
  /**
   * Rows entering the window after the first render show `renderPlaceholder` for one frame
   * and render their content in the next task (visible rows first), so a fling over heavy
   * rows never blocks a frame on a whole window of them. Default off.
   */
  readonly progressive?: boolean;
  /** A cheap stand-in for a row whose content has not rendered yet (`progressive`). */
  readonly renderPlaceholder?: (index: number) => VNodeChild;
  /**
   * When the page is printed, the list renders up to this many rows (from the first visible
   * one) in normal flow, so they paginate. Default 1000.
   */
  readonly printLimit?: number;
  /** Class of the list's outer element (the scroller, unless `scrollElement` says otherwise). */
  readonly class?: string;
  /** React spelling of `class`. */
  readonly className?: string;
  /** Inline style of the outer element (give it a height when the list scrolls itself). */
  readonly style?: Readonly<Record<string, string | number>>;
  /**
   * Snap points (CSS scroll snap), React Native's way: every `interval` px (`snapToInterval`,
   * aligned by `align`, `snapToAlignment`) or at `offsets` (`snapToOffsets`), with `stop:
   * "always"` for one snap point per fling (`decelerationRate="fast"`). Offsets are content
   * px from the scroller's start (the header included). Only the markers near the viewport are
   * drawn; ignored while the scroll space is scaled (lists past ~8M px).
   */
  readonly scrollSnap?: ScrollSnapOptions;
  /** Accessible name of the list. */
  readonly "aria-label"?: string;
  /** Id of the element naming the list. */
  readonly "aria-labelledby"?: string;
}

/** One positioned row of {@linkcode UseVirtualListResult.items}. */
export interface VirtualItem {
  /** Row index. */
  readonly index: number;
  /** Row key (the cell key when recycling). */
  readonly key: VirtualListKey;
  /** Row type (`getItemType`, or 0). */
  readonly type: string | number;
  /** Px from the inner element's leading edge: place the row here. */
  readonly offset: number;
  /** Current size (measured, else estimated). */
  readonly size: number;
  /** Attach to the row's element so it is measured (a stable function per row). */
  readonly measureRef: (el: Element | null) => void;
}

/** What `useVirtualList` returns. */
export interface UseVirtualListResult {
  /** Spread on the scroll container (`ref` and the scroll style); ignore with `scrollElement`. */
  readonly scrollProps: {
    readonly ref: (el: Element | null) => void;
    readonly style: Record<string, string>;
  };
  /** Spread on the element holding the rows (sized to `totalSize`, `position: relative`). */
  readonly innerProps: {
    readonly ref: (el: Element | null) => void;
    readonly style: Record<string, string>;
  };
  /** The inner element's size along the scroll axis, in px. */
  readonly totalSize: number;
  /** The rows to render, each with its offset. */
  readonly items: readonly VirtualItem[];
  /** Imperative scrolling and queries. */
  readonly handle: VirtualListHandle;
}
