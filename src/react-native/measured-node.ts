/**
 * A wrapper component's view of the DOM element react-native-web draws: a ref that also feeds
 * the app's own ref, and a measurement run after every commit and whenever the element is
 * resized. Shared by React Native mode's `Text` wrappers (`adjustsFontSizeToFit`,
 * `ellipsizeMode`, `onTextLayout`) and `ScrollView`'s.
 *
 * @module
 */

import { useCallback, useLayoutEffect, useRef } from "../runtime/hooks.ts";
import { setRef } from "./internal.ts";

/** The `ResizeObserver` constructor, where the page has one. */
function resizeObserver(): typeof ResizeObserver | undefined {
  return (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
}

/**
 * Track the element a ref receives and call `measure(el)` after every commit and on every
 * resize, while `enabled`.
 *
 * @param enabled Whether to measure at all.
 * @param userRef The app's ref, which still receives the element.
 * @param measure Called with the element (the latest function is used).
 * @returns The ref to pass down, and the element's holder.
 */
export function useMeasuredNode<T>(
  enabled: boolean,
  userRef: unknown,
  measure: (el: T) => void,
): { ref: (el: T | null) => void; node: { current: T | null } } {
  const node = useRef<T | null>(null);
  const latest = useRef(measure);
  latest.current = measure;
  const ref = useCallback((el: T | null) => {
    node.current = el;
    setRef(userRef, el);
  }, [userRef]);
  useLayoutEffect(() => {
    if (enabled && node.current) latest.current(node.current);
  });
  useLayoutEffect(() => {
    const RO = resizeObserver();
    const el = node.current;
    if (!enabled || !RO || !el) return;
    const ro = new RO(() => node.current && latest.current(node.current));
    ro.observe(el as unknown as Element);
    return () => ro.disconnect();
  }, [enabled]);
  return { ref, node };
}
