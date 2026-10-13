/**
 * React Native's `ScrollView` props for React Native mode that react-native-web drops, on top of
 * the snap props ({@linkcode withScrollSnap}):
 *
 * - `bounces={false}` (iOS) and `overScrollMode="never"` (Android) turn the overscroll effect off
 *   on the scroll axis: iOS's rubber band and Android's stretch / glow, as CSS
 *   `overscroll-behavior: none`. On the web that also stops a scroll reaching the end from
 *   scrolling the page behind it (scroll chaining), which a React Native scroll view never does.
 * - `contentOffset` (`{ x, y }`) is the starting scroll position, applied once on mount, before
 *   the first paint.
 * - `maintainVisibleContentPosition` (`{ minIndexForVisible, autoscrollToTopThreshold }`): when
 *   content above the view changes size (rows prepended, an image loading), the first child at
 *   or after `minIndexForVisible` that is in view stays where it was; when the view was within
 *   `autoscrollToTopThreshold` of the start, it scrolls to the start instead (animated). The
 *   browser's own scroll anchoring is turned off for the scroll view, so nothing is adjusted
 *   twice.
 * - `contentInset` (`{ top, left, bottom, right }`): extra scrollable space before and after the
 *   content on the scroll axis (the cross axis is left alone, as it does not scroll).
 * - `automaticallyAdjustKeyboardInsets`: while the keyboard covers the bottom of a vertical
 *   scroll view, the covered height is added after the content, so its end can be scrolled
 *   above the keyboard (the same covered height `KeyboardAvoidingView` uses: none where the
 *   WebView already resizes).
 *
 * React Native mode's build wraps react-native-web's `ScrollView` with
 * {@linkcode withScrollViewProps}.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType } from "../jsx/types.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "../runtime/hooks.ts";
import { useOverlap } from "../mobile/keyboard-views.ts";
import { useMeasuredNode } from "./measured-node.ts";
import { flattenStyle } from "./font-scaling.ts";
import { withScrollSnap } from "./scroll-snap.ts";

/** React Native's `maintainVisibleContentPosition`. */
interface MaintainVisibleContentPosition {
  /** The first child index that may be the anchor. */
  readonly minIndexForVisible?: number;
  /** Within this many px of the start, scroll to the start instead. */
  readonly autoscrollToTopThreshold?: number | null;
}

/** React Native's `contentInset`. */
interface ContentInset {
  readonly top?: number;
  readonly left?: number;
  readonly bottom?: number;
  readonly right?: number;
}

/** The props the wrapper reads (the rest go on). */
interface ScrollViewProps {
  readonly horizontal?: boolean | null;
  readonly bounces?: boolean;
  readonly overScrollMode?: "auto" | "always" | "never";
  readonly contentOffset?: { readonly x?: number; readonly y?: number } | null;
  readonly maintainVisibleContentPosition?: MaintainVisibleContentPosition | null;
  readonly contentInset?: ContentInset | null;
  readonly automaticallyAdjustKeyboardInsets?: boolean;
  readonly contentContainerStyle?: unknown;
  readonly style?: unknown;
  readonly ref?: unknown;
  readonly [prop: string]: unknown;
}

/** A box, as `getBoundingClientRect` gives it. */
interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A child of the content container. */
export interface AnchorElement {
  readonly isConnected: boolean;
  getBoundingClientRect(): Rect;
}

/** react-native-web's scroll node (what its ref holds): the element plus its methods. */
export interface ScrollNode {
  scrollTop: number;
  scrollLeft: number;
  scrollTo(options: { x?: number; y?: number; animated?: boolean }): void;
  getBoundingClientRect(): Rect;
  getInnerViewNode?(): { readonly children: ArrayLike<AnchorElement> } | null;
  addEventListener?(type: "scroll", fn: () => void, options?: unknown): void;
  removeEventListener?(type: "scroll", fn: () => void): void;
}

/** The props React Native has and react-native-web does not take. */
const RN_ONLY_PROPS = [
  "bounces",
  "overScrollMode",
  "contentOffset",
  "maintainVisibleContentPosition",
  "contentInset",
  "automaticallyAdjustKeyboardInsets",
] as const;

/**
 * The style that turns the overscroll effect off on the scroll axis, or `null` when the props
 * keep it (React Native's default).
 *
 * @param props The scroll view's props.
 * @returns The style, or `null`.
 */
export function overscrollStyle(props: ScrollViewProps): Record<string, string> | null {
  if (props.bounces !== false && props.overScrollMode !== "never") return null;
  return props.horizontal ? { overscrollBehaviorX: "none" } : { overscrollBehaviorY: "none" };
}

/**
 * Scroll a scroll view to its `contentOffset` without animating (nothing for none, or 0, 0).
 *
 * @param view The scroll node.
 * @param offset The `contentOffset` prop.
 */
export function scrollToStart(
  view: Pick<ScrollNode, "scrollTo"> | null,
  offset: ScrollViewProps["contentOffset"],
): void {
  const x = offset?.x ?? 0;
  const y = offset?.y ?? 0;
  if (x === 0 && y === 0) return;
  view?.scrollTo({ x, y, animated: false });
}

/** The anchor child and where it was: px from the view's start edge, and the scroll then. */
export interface ContentAnchor {
  readonly el: AnchorElement;
  readonly offset: number;
  readonly scroll: number;
}

/** A box's start and end on the axis. */
function span(r: Rect, horizontal: boolean): [number, number] {
  return horizontal ? [r.left, r.right] : [r.top, r.bottom];
}

/**
 * The anchor: the first child at or after `minIndex` that reaches into the view.
 *
 * @param node The scroll node.
 * @param minIndex `minIndexForVisible`.
 * @param horizontal Whether it scrolls horizontally.
 * @returns The anchor, or `null` (no such child).
 */
export function captureAnchor(
  node: ScrollNode,
  minIndex: number,
  horizontal: boolean,
): ContentAnchor | null {
  const kids = node.getInnerViewNode?.()?.children;
  if (!kids) return null;
  const [start] = span(node.getBoundingClientRect(), horizontal);
  for (let i = Math.max(0, minIndex); i < kids.length; i++) {
    const [from, to] = span(kids[i].getBoundingClientRect(), horizontal);
    if (to > start) {
      return {
        el: kids[i],
        offset: from - start,
        scroll: horizontal ? node.scrollLeft : node.scrollTop,
      };
    }
  }
  return null;
}

/**
 * Put the anchor back where it was: scroll by how far it moved, or to the start when the view
 * was within `threshold` of it. Nothing when it did not move or is gone.
 *
 * @param node The scroll node.
 * @param anchor The anchor {@linkcode captureAnchor} took.
 * @param horizontal Whether it scrolls horizontally.
 * @param threshold `autoscrollToTopThreshold`.
 */
export function restoreAnchor(
  node: ScrollNode,
  anchor: ContentAnchor | null,
  horizontal: boolean,
  threshold?: number | null,
): void {
  if (!anchor?.el.isConnected) return;
  const [start] = span(node.getBoundingClientRect(), horizontal);
  const delta = span(anchor.el.getBoundingClientRect(), horizontal)[0] - start - anchor.offset;
  if (Math.abs(delta) < 0.5) return;
  if (typeof threshold === "number" && anchor.scroll <= threshold) {
    node.scrollTo({ x: 0, y: 0, animated: true });
  } else if (horizontal) node.scrollLeft += delta;
  else node.scrollTop += delta;
}

/**
 * The content container's extra margins: `contentInset` on the scroll axis plus the keyboard's
 * covered height after the content (added to the container's own margins).
 *
 * @param props The scroll view's props.
 * @param keyboardPx The covered height to add at the end.
 * @returns The style, or `null` for none.
 */
export function insetStyle(
  props: ScrollViewProps,
  keyboardPx: number,
): Record<string, number> | null {
  const inset = props.contentInset ?? {};
  const [before, after] = props.horizontal
    ? ["marginLeft", "marginRight"] as const
    : ["marginTop", "marginBottom"] as const;
  const lead = (props.horizontal ? inset.left : inset.top) ?? 0;
  const trail = ((props.horizontal ? inset.right : inset.bottom) ?? 0) + keyboardPx;
  if (lead === 0 && trail === 0) return null;
  const own = flattenStyle(props.contentContainerStyle);
  const base = (key: string) => (typeof own[key] === "number" ? own[key] as number : 0);
  return { [before]: base(before) + lead, [after]: base(after) + trail };
}

/**
 * How much of a vertical scroll view the keyboard covers: the covered height of the layout
 * viewport less the room below the view.
 *
 * @param node The scroll node.
 * @param coveredPx The keyboard's covered height.
 * @returns px (0 when it covers none of the view).
 */
export function keyboardCover(
  node: Pick<ScrollNode, "getBoundingClientRect">,
  coveredPx: number,
): number {
  if (coveredPx <= 0) return 0;
  const height = (globalThis as { innerHeight?: number }).innerHeight ?? 0;
  return Math.max(0, Math.round(coveredPx - (height - node.getBoundingClientRect().bottom)));
}

/** `maintainVisibleContentPosition` on a mounted scroll node: capture on scroll and resize. */
function useAnchoring(
  node: { current: ScrollNode | null },
  mvcp: MaintainVisibleContentPosition | null,
  horizontal: boolean,
): (view: ScrollNode) => void {
  const anchor = useRef<ContentAnchor | null>(null);
  const settle = (view: ScrollNode) => {
    if (!mvcp) return;
    restoreAnchor(view, anchor.current, horizontal, mvcp.autoscrollToTopThreshold);
    anchor.current = captureAnchor(view, mvcp.minIndexForVisible ?? 0, horizontal);
  };
  const latest = useRef(settle);
  latest.current = settle;
  const on = !!mvcp;
  useEffect(() => {
    const view = node.current;
    if (!on || !view) return;
    const capture = () => {
      anchor.current = captureAnchor(view, mvcp?.minIndexForVisible ?? 0, horizontal);
    };
    view.addEventListener?.("scroll", capture, { passive: true });
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const inner = view.getInnerViewNode?.();
    const ro = RO && inner ? new RO(() => latest.current(view)) : null;
    ro?.observe(inner as unknown as Element);
    return () => {
      view.removeEventListener?.("scroll", capture);
      ro?.disconnect();
    };
  }, [on, horizontal]);
  return settle;
}

/** The props react-native-web's `ScrollView` gets: the extra styles, without React Native's. */
function scrollViewRest(
  props: ScrollViewProps,
  inset: Record<string, number> | null,
): Record<string, unknown> {
  const extra = [
    overscrollStyle(props),
    props.maintainVisibleContentPosition ? { overflowAnchor: "none" } : null,
  ].filter((s) => s !== null);
  const rest: Record<string, unknown> = { ...props };
  for (const key of RN_ONLY_PROPS) delete rest[key];
  if (extra.length > 0) rest.style = [props.style, ...extra];
  if (inset) rest.contentContainerStyle = [props.contentContainerStyle, inset];
  return rest;
}

/**
 * react-native-web's `ScrollView` with React Native's `bounces`, `overScrollMode`,
 * `contentOffset`, `maintainVisibleContentPosition`, `contentInset` and
 * `automaticallyAdjustKeyboardInsets`, and the snap props (see the module docs). A scroll view
 * without them renders exactly as {@linkcode withScrollSnap}'s.
 *
 * @param ScrollView react-native-web's `ScrollView` (React Native mode passes it in).
 * @returns The wrapped `ScrollView`.
 */
export function withScrollViewProps(ScrollView: VNodeType): VNodeType {
  const Snapping = withScrollSnap(ScrollView);
  function RNScrollView(props: ScrollViewProps): VNode {
    const horizontal = !!props.horizontal;
    const mvcp = props.maintainVisibleContentPosition ?? null;
    const keyboard = props.automaticallyAdjustKeyboardInsets === true && !horizontal;
    const overlap = useOverlap(keyboard);
    const [covered, setCovered] = useState(0);
    const watch = !!props.contentOffset || !!mvcp || keyboard;
    let settle: (view: ScrollNode) => void = () => {};
    const { ref, node } = useMeasuredNode<ScrollNode>(watch, props.ref, (view) => {
      settle(view);
      if (keyboard) setCovered(keyboardCover(view, overlap.px));
    });
    settle = useAnchoring(node, mvcp, horizontal);
    // The starting position only, as React Native's: a later contentOffset does not scroll.
    useLayoutEffect(() => scrollToStart(node.current, props.contentOffset), []);
    const rest = scrollViewRest(props, insetStyle(props, keyboard ? covered : 0));
    if (watch) rest.ref = ref;
    return h(Snapping, rest);
  }
  return Object.assign(RNScrollView, { displayName: "ScrollView" }) as unknown as VNodeType;
}
