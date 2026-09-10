/**
 * `useIntersectionObserver` — observe when an element enters or leaves the
 * viewport (lazy-loading, infinite scroll, reveal-on-scroll, impression
 * tracking). Returns a callback ref to attach to the element. Client-only; a
 * no-op where `IntersectionObserver` is unavailable (`isSupported` reports it).
 *
 * @module
 */

import { useCallback, useRef, useState } from "../runtime/hooks.ts";
import type { RefCallback } from "../compat/react-types.ts";

/** Options for {@linkcode useIntersectionObserver} (a superset of `IntersectionObserverInit`). */
export interface UseIntersectionObserverOptions {
  /** The viewport element to test visibility against (default: the browser viewport). */
  root?: Element | Document | null;
  /** Margin around the root, CSS-style (e.g. `"200px 0px"`). */
  rootMargin?: string;
  /** Visibility ratio(s) at which the callback fires. */
  threshold?: number | number[];
  /** Stop observing after the element first becomes visible (one-shot reveal). */
  once?: boolean;
}

/** The result of {@linkcode useIntersectionObserver}. */
export interface UseIntersectionObserverResult<T extends Element> {
  /** Callback ref to attach to the element you want to observe. */
  ref: RefCallback<T>;
  /** The most recent intersection entry, or `null` before the first callback. */
  entry: IntersectionObserverEntry | null;
  /** Whether the element is currently intersecting the root. */
  isIntersecting: boolean;
  /** Whether the `IntersectionObserver` API is available here. */
  isSupported: boolean;
}

/**
 * Observe an element's intersection with the viewport (or a `root`). Attach the
 * returned `ref` to the element; `entry`/`isIntersecting` update as it crosses
 * the configured `threshold`.
 *
 * @param options {@linkcode UseIntersectionObserverOptions}.
 * @returns {@linkcode UseIntersectionObserverResult}.
 * @example Reveal on scroll:
 * ```tsx
 * "use client";
 * import { useIntersectionObserver } from "denext";
 *
 * export function Reveal({ children }) {
 *   const { ref, isIntersecting } = useIntersectionObserver({ once: true });
 *   return <div ref={ref} data-shown={isIntersecting}>{children}</div>;
 * }
 * ```
 */
export function useIntersectionObserver<T extends Element = Element>(
  options: UseIntersectionObserverOptions = {},
): UseIntersectionObserverResult<T> {
  const { root = null, rootMargin, threshold, once } = options;
  const [entry, setEntry] = useState<IntersectionObserverEntry | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const isSupported = typeof globalThis.IntersectionObserver === "function";

  // A callback ref (re)creates the observer for the attached node and, when
  // React calls it with `null` on unmount / detach, disconnects the old one.
  const ref = useCallback<RefCallback<T>>((node) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || !isSupported) return;
    const observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      setEntry(latest);
      if (once && latest.isIntersecting) {
        observer.disconnect();
        observerRef.current = null;
      }
    }, { root: root ?? null, rootMargin, threshold });
    observer.observe(node);
    observerRef.current = observer;
  }, [root, rootMargin, JSON.stringify(threshold), once, isSupported]);

  return { ref, entry, isIntersecting: entry?.isIntersecting ?? false, isSupported };
}
