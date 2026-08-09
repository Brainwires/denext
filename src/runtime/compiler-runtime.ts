/**
 * The tiny, stable runtime surface the auto-memo compiler's output imports.
 *
 * Generated modules pull `c` (the memo-cache primitive) from `denext/compiler-
 * runtime` rather than reaching into internal paths, so the transform stays
 * decoupled from the framework's internals. Kept intentionally minimal.
 *
 * @module
 */

import { MEMO_CACHE_SENTINEL, useMemoCache } from "./hooks.ts";

export { MEMO_CACHE_SENTINEL, useMemoCache };

/**
 * Short alias for {@link useMemoCache} used in generated code (mirrors the React
 * Compiler's `_c`): `const $ = c(4);`.
 */
export const c: (size: number) => unknown[] = useMemoCache;

/**
 * Memoize a value in a {@link useMemoCache} array. Generated code calls this for
 * each JSX element it lifts out: `factory()` is (re)invoked only when one of
 * `deps` changes (by `Object.is`), so an unchanged element keeps the *same*
 * reference across renders — which lets the reconciler bail out of that subtree.
 *
 * Layout: slot `slot` holds the value; slots `slot+1 … slot+deps.length` hold the
 * dependencies from the last computation. Slots are assigned at compile time, so
 * each call site owns a fixed, non-overlapping range.
 *
 * @param cache The per-component cache array from {@link useMemoCache}.
 * @param slot Base slot index owned by this call site.
 * @param factory Recomputes the value when a dependency changed.
 * @param deps The reactive dependencies guarding the value.
 * @returns The memoized (or freshly computed) value.
 */
export function memoValue<T>(
  cache: unknown[],
  slot: number,
  factory: () => T,
  deps: readonly unknown[],
): T {
  let changed = cache[slot] === MEMO_CACHE_SENTINEL;
  const base = slot + 1;
  if (!changed) {
    for (let i = 0; i < deps.length; i++) {
      if (!Object.is(cache[base + i], deps[i])) {
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    for (let i = 0; i < deps.length; i++) cache[base + i] = deps[i];
    cache[slot] = factory();
  }
  return cache[slot] as T;
}
