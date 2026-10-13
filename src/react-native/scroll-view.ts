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
 *
 * React Native mode's build wraps react-native-web's `ScrollView` with
 * {@linkcode withScrollViewProps}.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType } from "../jsx/types.ts";
import { useCallback, useLayoutEffect, useRef } from "../runtime/hooks.ts";
import { setRef } from "./internal.ts";
import { withScrollSnap } from "./scroll-snap.ts";

/** The props the wrapper reads (the rest go on). */
interface ScrollViewProps {
  readonly horizontal?: boolean | null;
  readonly bounces?: boolean;
  readonly overScrollMode?: "auto" | "always" | "never";
  readonly contentOffset?: { readonly x?: number; readonly y?: number } | null;
  readonly style?: unknown;
  readonly ref?: unknown;
  readonly [prop: string]: unknown;
}

/** react-native-web's `ScrollView` instance (what its ref holds). */
interface ScrollViewInstance {
  scrollTo(options: { x?: number; y?: number; animated?: boolean }): void;
}

/** The props React Native has and react-native-web does not take. */
const RN_ONLY_PROPS = ["bounces", "overScrollMode", "contentOffset"] as const;

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
 * @param view The scroll view instance.
 * @param offset The `contentOffset` prop.
 */
export function scrollToStart(
  view: ScrollViewInstance | null,
  offset: ScrollViewProps["contentOffset"],
): void {
  const x = offset?.x ?? 0;
  const y = offset?.y ?? 0;
  if (x === 0 && y === 0) return;
  view?.scrollTo({ x, y, animated: false });
}

/**
 * react-native-web's `ScrollView` with React Native's `bounces`, `overScrollMode` and
 * `contentOffset` and the snap props (see the module docs). A scroll view without them renders
 * exactly as {@linkcode withScrollSnap}'s.
 *
 * @param ScrollView react-native-web's `ScrollView` (React Native mode passes it in).
 * @returns The wrapped `ScrollView`.
 */
export function withScrollViewProps(ScrollView: VNodeType): VNodeType {
  const Snapping = withScrollSnap(ScrollView);
  function RNScrollView(props: ScrollViewProps): VNode {
    const instance = useRef<ScrollViewInstance | null>(null);
    const userRef = props.ref;
    const ref = useCallback((node: ScrollViewInstance | null) => {
      instance.current = node;
      setRef(userRef, node);
    }, [userRef]);
    const offset = props.contentOffset;
    // The starting position only, as React Native's: a later contentOffset does not scroll.
    useLayoutEffect(() => scrollToStart(instance.current, offset), []);
    const overscroll = overscrollStyle(props);
    const rest: Record<string, unknown> = { ...props };
    for (const key of RN_ONLY_PROPS) delete rest[key];
    if (overscroll) rest.style = [props.style, overscroll];
    if (offset) rest.ref = ref;
    return h(Snapping, rest);
  }
  return Object.assign(RNScrollView, { displayName: "ScrollView" }) as unknown as VNodeType;
}
