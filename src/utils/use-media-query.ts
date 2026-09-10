/**
 * `useMediaQuery` — evaluate a CSS media query and re-render when it changes.
 * Client-only; during SSR, or where `matchMedia` is unavailable, it returns
 * `serverFallback` (default `false`). Next.js ships no such hook.
 *
 * @module
 */

import { useCallback, useSyncExternalStore } from "../runtime/hooks.ts";

/** `matchMedia`, bound to `globalThis`, if the API exists here. */
function matchMediaApi(): ((query: string) => MediaQueryList) | undefined {
  return typeof globalThis !== "undefined" && typeof globalThis.matchMedia === "function"
    ? globalThis.matchMedia.bind(globalThis)
    : undefined;
}

/**
 * Subscribe to a CSS media query. Re-renders whenever the match state flips.
 *
 * @param query A media query string, e.g. `"(min-width: 768px)"` or
 * `"(prefers-color-scheme: dark)"`.
 * @param serverFallback The value returned during SSR and where `matchMedia`
 * is unavailable (default `false`).
 * @returns `true` while the query currently matches, else `false`.
 * @example
 * ```tsx
 * "use client";
 * import { useMediaQuery } from "denext";
 *
 * export function Layout() {
 *   const isWide = useMediaQuery("(min-width: 768px)");
 *   return isWide ? <TwoColumn /> : <Stacked />;
 * }
 * ```
 */
export function useMediaQuery(query: string, serverFallback = false): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mm = matchMediaApi();
    if (!mm) return () => {};
    const mql = mm(query);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    // Safari < 14 fallback: the deprecated MediaQueryList listener API.
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  const getSnapshot = () => {
    const mm = matchMediaApi();
    return mm ? mm(query).matches : serverFallback;
  };

  return useSyncExternalStore(subscribe, getSnapshot, () => serverFallback);
}
