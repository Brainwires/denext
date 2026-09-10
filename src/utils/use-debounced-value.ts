/**
 * `useDebouncedValue` — a value that trails its input, updating only after it
 * has been still for `delayMs`. The canonical use is a search box: debounce the
 * query before firing a request. SSR-safe (the timer only runs client-side).
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";

/**
 * Return a debounced copy of `value`. Each change restarts a `delayMs` timer;
 * the returned value updates only once the input stops changing for that long.
 *
 * @param value The rapidly-changing source value.
 * @param delayMs The quiet period, in milliseconds, before the value settles.
 * @returns The debounced value.
 * @example
 * ```tsx
 * "use client";
 * import { useDebouncedValue } from "denext";
 *
 * export function Search() {
 *   const [query, setQuery] = useState("");
 *   const debounced = useDebouncedValue(query, 300);
 *   useEffect(() => { if (debounced) search(debounced); }, [debounced]);
 *   return <input value={query} onChange={(e) => setQuery(e.target.value)} />;
 * }
 * ```
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
