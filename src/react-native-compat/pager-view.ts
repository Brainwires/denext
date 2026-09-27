/**
 * `react-native-pager-view` for denext's React Native mode: `PagerView` as a CSS scroll-snap
 * pager.
 *
 * React Native mode resolves `import PagerView from "react-native-pager-view"` here (unless
 * `reactNative: { aliases: { "react-native-pager-view": false } }`); the real package is a
 * native component that renders nothing on the web. Each child is one full-size page in a
 * scroll container with mandatory snap points, so a swipe (touch, trackpad or wheel) settles on
 * a page the way the native pager does:
 *
 * - `initialPage`, `scrollEnabled`, `orientation` (`"horizontal"` / `"vertical"`),
 *   `pageMargin` (a gap between pages), `layoutDirection` (`"rtl"`), and
 *   `keyboardDismissMode="on-drag"` (a drag blurs the focused field);
 * - `onPageScroll` (`{ position, offset }` as the pages move), `onPageSelected`
 *   (`{ position }` once a page settles) and `onPageScrollStateChanged`
 *   (`"dragging"` → `"settling"` → `"idle"`), each as `{ nativeEvent }`;
 * - the ref's `setPage` (smooth, unless the user prefers reduced motion),
 *   `setPageWithoutAnimation` and `setScrollEnabled`;
 * - `usePagerView`, the package's state helper.
 *
 * `overdrag` and `offscreenPageLimit` are accepted and ignored: every page stays mounted.
 *
 * @example
 * ```ts
 * import PagerView from "react-native-pager-view"; // React Native mode → this module
 * import { h } from "denext/jsx-runtime";
 *
 * h(PagerView, {
 *   style: { flex: 1 },
 *   initialPage: 0,
 *   onPageSelected: (e: { nativeEvent: { position: number } }) => console.log(e.nativeEvent),
 * }, h("div", { key: "1" }, "First"), h("div", { key: "2" }, "Second"));
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VNodeType } from "../jsx/types.ts";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "../runtime/hooks.ts";
import { hostView, viewStyle } from "../expo/internal/common.ts";
import { prefersReducedMotion } from "../navigation/animation.ts";
import * as RN from "./internal/react-native.ts";

/** `onPageScroll`'s event data. */
export interface PagerViewOnPageScrollEventData {
  /** The page at the leading edge (the lower index of the two visible pages). */
  position: number;
  /** How far past `position` the pages are, 0 (on it) … 1. */
  offset: number;
}

/** `onPageSelected`'s event data. */
export interface PagerViewOnPageSelectedEventData {
  /** The page that settled. */
  position: number;
}

/** `onPageScrollStateChanged`'s event data. */
export interface PageScrollStateChangedNativeEventData {
  /** The scroll state. */
  pageScrollState: "idle" | "dragging" | "settling";
}

/** A pager event: the package's `{ nativeEvent }` wrapper. */
export interface PagerViewEvent<T> {
  /** The event data. */
  nativeEvent: T;
}

/** `onPageScroll`'s event. */
export type PagerViewOnPageScrollEvent = PagerViewEvent<PagerViewOnPageScrollEventData>;
/** `onPageSelected`'s event. */
export type PagerViewOnPageSelectedEvent = PagerViewEvent<PagerViewOnPageSelectedEventData>;
/** `onPageScrollStateChanged`'s event. */
export type PageScrollStateChangedNativeEvent = PagerViewEvent<
  PageScrollStateChangedNativeEventData
>;

/** `PagerView` props. */
export interface PagerViewProps {
  /** The page shown first (default 0). */
  initialPage?: number;
  /** `false` stops the user from paging (the ref's `setPage` still works). Default `true`. */
  scrollEnabled?: boolean;
  /** The paging axis (default `"horizontal"`). */
  orientation?: "horizontal" | "vertical";
  /** A gap between pages, in px. */
  pageMargin?: number;
  /** `"rtl"` pages right to left; `"ltr"` / `"locale"` left to right. */
  layoutDirection?: "ltr" | "rtl" | "locale";
  /** `"on-drag"` blurs the focused field when a drag starts. */
  keyboardDismissMode?: "none" | "on-drag";
  /** Ignored (the rubber band is the browser's). */
  overdrag?: boolean;
  /** Ignored (every page stays mounted). */
  offscreenPageLimit?: number;
  /** Pages move. */
  onPageScroll?: (event: PagerViewOnPageScrollEvent) => void;
  /** A page settled. */
  onPageSelected?: (event: PagerViewOnPageSelectedEvent) => void;
  /** The scroll state changed. */
  onPageScrollStateChanged?: (event: PageScrollStateChangedNativeEvent) => void;
  /** The pager's style. */
  style?: unknown;
  /** The pages: one child per page. */
  children?: VNodeChildren;
  /** Test id. */
  testID?: string;
  /** The ref handle ({@linkcode PagerViewHandle}). */
  ref?: unknown;
  /** Other view props (ignored). */
  [prop: string]: unknown;
}

/** The ref handle of a {@linkcode PagerView}. */
export interface PagerViewHandle {
  /** Scroll to `page` (animated unless the user prefers reduced motion). */
  setPage(page: number): void;
  /** Jump to `page`. */
  setPageWithoutAnimation(page: number): void;
  /** Turn user paging on or off. */
  setScrollEnabled(enabled: boolean): void;
}

/** How long without a scroll event counts as settled, in ms (where `scrollend` is missing). */
const SETTLE_MS = 120;

/** The pages of `children`: a flat list of the non-empty children. */
function pagesOf(children: VNodeChildren): unknown[] {
  const list = Array.isArray(children) ? children.flat(Infinity as 1) : [children];
  return list.filter((c) => c !== null && c !== undefined && c !== false && c !== true);
}

/** A scroll state, as `onPageScrollStateChanged` reports it. */
type ScrollState = PageScrollStateChangedNativeEventData["pageScrollState"];

/** The pager's scroll bookkeeping. */
interface Tracking {
  selected: number;
  state: ScrollState;
  dragging: boolean;
  timer: number | ReturnType<typeof setTimeout>;
}

/** Blur the focused element (`keyboardDismissMode: "on-drag"`). */
function blurActive(): void {
  const active = (globalThis as { document?: { activeElement?: { blur?: () => void } } })
    .document?.activeElement;
  active?.blur?.();
}

/** Scroll `el` to `offset` along the pager's axis. */
function scrollAlong(el: HTMLElement, vertical: boolean, offset: number, smooth: boolean): void {
  const behavior = smooth ? "smooth" : "auto";
  if (typeof el.scrollTo === "function") {
    el.scrollTo(vertical ? { top: offset, behavior } : { left: offset, behavior });
  } else if (vertical) el.scrollTop = offset;
  else el.scrollLeft = offset;
}

/**
 * The pager's scroll machinery: the page events, `setPage`, and the scroll / drag handlers.
 *
 * @param props The pager's props (read through `latest`, so the handlers stay stable).
 * @param latest The latest props.
 * @param scrollerRef The scrolling element.
 */
function usePagerScroll(
  props: PagerViewProps,
  latest: { current: PagerViewProps },
  scrollerRef: { current: HTMLElement | null },
) {
  const { initialPage = 0, pageMargin = 0 } = props;
  const vertical = props.orientation === "vertical";
  const rtl = props.layoutDirection === "rtl";
  const tracking = useRef<Tracking>({
    selected: initialPage,
    state: "idle",
    dragging: false,
    timer: 0,
  });

  /** The page stride (a page plus the margin) and the current scroll position along it. */
  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return { stride: 0, pos: 0 };
    const size = vertical ? el.clientHeight : el.clientWidth;
    const pos = Math.abs(vertical ? el.scrollTop : el.scrollLeft);
    return { stride: size + pageMargin, pos };
  }, [vertical, pageMargin]);

  const setState = useCallback((next: ScrollState) => {
    const t = tracking.current;
    if (t.state === next) return;
    t.state = next;
    latest.current.onPageScrollStateChanged?.({ nativeEvent: { pageScrollState: next } });
  }, []);

  const select = useCallback((position: number) => {
    const t = tracking.current;
    if (t.selected === position) return;
    t.selected = position;
    latest.current.onPageSelected?.({ nativeEvent: { position } });
  }, []);

  const scrollTo = useCallback((page: number, animated: boolean) => {
    const el = scrollerRef.current;
    if (!el) return;
    const offset = page * measure().stride * (rtl && !vertical ? -1 : 1);
    scrollAlong(el, vertical, offset, animated && !prefersReducedMotion());
    if (!animated) select(page);
  }, [measure, rtl, vertical, select]);

  // The first page, before paint.
  useLayoutEffect(() => {
    tracking.current.selected = initialPage;
    if (initialPage > 0) scrollTo(initialPage, false);
  }, []);

  const settle = useCallback(() => {
    const { stride, pos } = measure();
    tracking.current.dragging = false;
    if (stride > 0) select(Math.round(pos / stride));
    setState("idle");
  }, [measure, select, setState]);

  const onScroll = () => {
    const t = tracking.current;
    const { stride, pos } = measure();
    if (stride > 0) {
      const exact = pos / stride;
      const position = Math.floor(exact + 1e-6);
      latest.current.onPageScroll?.({
        nativeEvent: { position, offset: Math.max(0, exact - position) },
      });
    }
    if (!t.dragging) setState("settling");
    clearTimeout(t.timer as number);
    t.timer = setTimeout(settle, SETTLE_MS);
  };
  const onDragStart = () => {
    tracking.current.dragging = true;
    setState("dragging");
    if (latest.current.keyboardDismissMode === "on-drag") blurActive();
  };
  const onDragEnd = () => {
    tracking.current.dragging = false;
    if (tracking.current.state === "dragging") setState("settling");
  };
  useEffect(() => () => clearTimeout(tracking.current.timer as number), []);
  return { scrollTo, settle, onScroll, onDragStart, onDragEnd };
}

/** One page's style. */
const PAGE_STYLE: Readonly<Record<string, string>> = {
  flex: "0 0 100%",
  width: "100%",
  height: "100%",
  scrollSnapAlign: "start",
  scrollSnapStop: "always",
  overflow: "hidden",
  position: "relative",
  display: "flex",
  flexDirection: "column",
};

/** The scrolling element's style. */
function scrollerStyle(vertical: boolean, enabled: boolean, pageMargin: number) {
  const overflow = enabled ? "auto" : "hidden";
  return {
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    bottom: "0",
    display: "flex",
    flexDirection: vertical ? "column" : "row",
    gap: pageMargin ? `${pageMargin}px` : undefined,
    overflowX: vertical ? "hidden" : overflow,
    overflowY: vertical ? overflow : "hidden",
    scrollSnapType: `${vertical ? "y" : "x"} mandatory`,
    overscrollBehavior: "contain",
    scrollbarWidth: "none",
    WebkitOverflowScrolling: "touch",
  };
}

/** Each child in a snap page. */
function pageViews(children: VNodeChildren): VNode[] {
  return pagesOf(children).map((child, i) =>
    h(
      "div",
      {
        key: (child as { key?: unknown })?.key as string ?? String(i),
        "data-denext-page": String(i),
        style: PAGE_STYLE,
      },
      child as VNodeChildren,
    )
  );
}

/**
 * `react-native-pager-view`'s `PagerView`: one child per page, paged with CSS scroll snapping.
 *
 * @param props The package's props.
 * @returns The pager.
 */
export function PagerView(props: PagerViewProps): VNode {
  const { scrollEnabled = true, pageMargin = 0, style, children, testID } = props;
  const vertical = props.orientation === "vertical";
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [enabled, setEnabled] = useState(scrollEnabled);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => setEnabled(scrollEnabled), [scrollEnabled]);
  const pager = usePagerScroll(props, latest, scrollerRef);

  useImperativeHandle(props.ref as never, (): PagerViewHandle => ({
    setPage: (page: number) => pager.scrollTo(page, true),
    setPageWithoutAnimation: (page: number) => pager.scrollTo(page, false),
    setScrollEnabled: (on: boolean) => setEnabled(on),
  }), [pager.scrollTo]);

  return h(
    hostView(),
    { style: viewStyle(style, { overflow: "hidden" }), "data-testid": testID },
    h(
      "div",
      {
        ref: scrollerRef,
        dir: props.layoutDirection === "rtl" ? "rtl" : undefined,
        "data-denext-pager": "",
        onScroll: pager.onScroll,
        onScrollEnd: pager.settle,
        onPointerDown: pager.onDragStart,
        onTouchStart: pager.onDragStart,
        onPointerUp: pager.onDragEnd,
        onTouchEnd: pager.onDragEnd,
        style: scrollerStyle(vertical, enabled, pageMargin),
      },
      ...pageViews(children),
    ),
  );
}

export default PagerView;

/** `Animated.createAnimatedComponent(PagerView)`, made once, when `Animated` has it. */
let animatedPagerView: VNodeType | undefined;

/** The animated pager (React Native mode), else the plain one. */
function getAnimatedPagerView(): VNodeType {
  if (animatedPagerView) return animatedPagerView;
  const create =
    (RN.Animated as { createAnimatedComponent?: (c: VNodeType) => VNodeType } | undefined)
      ?.createAnimatedComponent;
  animatedPagerView = create ? create(PagerView as VNodeType) : PagerView as VNodeType;
  return animatedPagerView;
}

/** `usePagerView`'s options. */
export interface UsePagerViewOptions {
  /** How many pages to start with. */
  pagesAmount: number;
}

/** What `usePagerView` returns. */
export interface UsePagerViewResult {
  /** The ref to pass to the pager. */
  ref: { current: PagerViewHandle | null };
  /** The selected page. */
  activePage: number;
  /** Whether `setPage` animates. */
  isAnimated: boolean;
  /** The page indices. */
  pages: number[];
  /** The scroll state. */
  scrollState: PageScrollStateChangedNativeEventData["pageScrollState"];
  /** Whether user paging is on. */
  scrollEnabled: boolean;
  /** The latest scroll progress. */
  progress: PagerViewOnPageScrollEventData;
  /** Whether overdrag is on (ignored by the pager). */
  overdrag: boolean;
  /** Go to a page (animated per `isAnimated`). */
  setPage(page: number): void;
  /** Append a page. */
  addPage(): void;
  /** Remove the last page (never the only one). */
  removePage(): void;
  /** Toggle user paging. */
  toggleScroll(): void;
  /** Toggle `setPage` animation. */
  toggleAnimation(): void;
  /** Set the progress. */
  setProgress(progress: PagerViewOnPageScrollEventData): void;
  /** Pass to the pager's `onPageScroll`. */
  onPageScroll(event: PagerViewOnPageScrollEvent): void;
  /** Pass to the pager's `onPageSelected`. */
  onPageSelected(event: PagerViewOnPageSelectedEvent): void;
  /** Pass to the pager's `onPageScrollStateChanged`. */
  onPageScrollStateChanged(event: PageScrollStateChangedNativeEvent): void;
  /** Toggle overdrag. */
  toggleOverdrag(): void;
  /** The animated pager (`Animated.createAnimatedComponent(PagerView)` in React Native mode). */
  AnimatedPagerView: VNodeType;
  /** The pager. */
  PagerView: typeof PagerView;
}

/**
 * The package's `usePagerView`: pager state (pages, active page, progress, scroll state) and
 * the callbacks that keep it current. The scroll callbacks are plain functions (the native
 * driver's `Animated.event` has no web meaning).
 *
 * @param options How many pages to start with.
 * @returns The state, the ref, and the handlers.
 */
export function usePagerView(
  options: UsePagerViewOptions = { pagesAmount: 0 },
): UsePagerViewResult {
  const ref = useRef<PagerViewHandle | null>(null);
  const pages = usePagerPages(options.pagesAmount);
  const toggles = usePagerToggles();
  const events = usePagerEvents();
  const isAnimated = toggles.isAnimated;
  const setPage = useCallback(
    (page: number) =>
      isAnimated ? ref.current?.setPage(page) : ref.current?.setPageWithoutAnimation(page),
    [isAnimated],
  );
  return {
    ref,
    ...pages,
    ...toggles,
    ...events,
    setPage,
    AnimatedPagerView: getAnimatedPagerView(),
    PagerView,
  };
}

/** `usePagerView`'s page list. */
function usePagerPages(amount: number) {
  const [pages, setPages] = useState<number[]>(() => Array.from({ length: amount }, (_v, i) => i));
  return {
    pages,
    addPage: useCallback(() => setPages((p) => [...p, p.length]), []),
    removePage: useCallback(() => setPages((p) => (p.length === 1 ? p : p.slice(0, -1))), []),
  };
}

/** `usePagerView`'s switches. */
function usePagerToggles() {
  const [isAnimated, setIsAnimated] = useState(true);
  const [overdrag, setOverdrag] = useState(false);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  return {
    isAnimated,
    overdrag,
    scrollEnabled,
    toggleScroll: useCallback(() => setScrollEnabled((v) => !v), []),
    toggleAnimation: useCallback(() => setIsAnimated((v) => !v), []),
    toggleOverdrag: useCallback(() => setOverdrag((v) => !v), []),
  };
}

/** `usePagerView`'s page state and the pager callbacks that keep it current. */
function usePagerEvents() {
  const [activePage, setActivePage] = useState(0);
  const [scrollState, setScrollState] = useState<ScrollState>("idle");
  const [progress, setProgress] = useState<PagerViewOnPageScrollEventData>({
    position: 0,
    offset: 0,
  });
  return {
    activePage,
    scrollState,
    progress,
    setProgress,
    onPageScroll: useCallback((e: PagerViewOnPageScrollEvent) => setProgress(e.nativeEvent), []),
    onPageSelected: useCallback(
      (e: PagerViewOnPageSelectedEvent) => setActivePage(e.nativeEvent.position),
      [],
    ),
    onPageScrollStateChanged: useCallback(
      (e: PageScrollStateChangedNativeEvent) => setScrollState(e.nativeEvent.pageScrollState),
      [],
    ),
  };
}
