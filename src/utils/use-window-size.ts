/**
 * `useWindowSize` — the viewport dimensions, updated on resize. Client-only;
 * returns `{ width: 0, height: 0 }` during SSR (branch on it to avoid a
 * hydration mismatch). Next.js ships no such hook.
 *
 * @module
 */

import { useCallback, useSyncExternalStore } from "../runtime/hooks.ts";

/** The viewport dimensions in CSS pixels. */
export interface WindowSize {
  /** `window.innerWidth`, or `0` on the server. */
  width: number;
  /** `window.innerHeight`, or `0` on the server. */
  height: number;
}

const SERVER_SIZE: WindowSize = { width: 0, height: 0 };

// A module-level cache keeps the snapshot referentially stable between resizes,
// which `useSyncExternalStore` requires (a fresh object each read would loop).
let cached: WindowSize = SERVER_SIZE;

/** The current viewport size, reusing the cached object when unchanged. */
function currentSize(): WindowSize {
  const width = typeof globalThis.innerWidth === "number" ? globalThis.innerWidth : 0;
  const height = typeof globalThis.innerHeight === "number" ? globalThis.innerHeight : 0;
  if (width !== cached.width || height !== cached.height) cached = { width, height };
  return cached;
}

/**
 * Track the viewport size, re-rendering on `resize`.
 *
 * @returns {@linkcode WindowSize} — `{ width, height }`.
 * @example
 * ```tsx
 * "use client";
 * import { useWindowSize } from "denext";
 * const { width } = useWindowSize();
 * return <span>{width === 0 ? "…" : `${width}px`}</span>;
 * ```
 */
export function useWindowSize(): WindowSize {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof globalThis.addEventListener !== "function") return () => {};
    globalThis.addEventListener("resize", onChange);
    return () => globalThis.removeEventListener("resize", onChange);
  }, []);
  return useSyncExternalStore(subscribe, currentSize, () => SERVER_SIZE);
}
