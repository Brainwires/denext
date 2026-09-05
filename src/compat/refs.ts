/**
 * Ref-composition helpers, matching the `@radix-ui/react-compose-refs` surface
 * (`composeRefs` / `useComposedRefs`). Merge several refs — object refs and
 * callback refs — into a single callback ref that writes the node to all of
 * them (and clears them on detach). Used by {@link "./slot.ts"} and by any
 * component that needs to forward a ref while also keeping its own.
 *
 * @module
 */

import { useMemo } from "../../mod.ts";

/** A ref that can be composed: an object ref, a callback ref, or nothing. */
export type PossibleRef<T> =
  | { current: T | null }
  | ((node: T | null) => void)
  | null
  | undefined;

/**
 * Assign `node` to a single ref (object or callback). A callback ref may return a cleanup
 * (React 19); it is returned so the composer can run it on detach instead of calling the
 * ref again with `null`.
 */
function setRef<T>(ref: PossibleRef<T>, node: T | null): (() => void) | void {
  if (typeof ref === "function") {
    const out = (ref as (n: T | null) => unknown)(node);
    return typeof out === "function" ? (out as () => void) : undefined;
  }
  if (ref != null) ref.current = node;
}

/**
 * Compose multiple refs into one callback ref. The returned ref writes the mounted node to
 * every input ref; on detach it runs each callback ref's returned cleanup (React 19) or,
 * for refs that returned none, writes `null`.
 *
 * @param refs The refs to combine (nullish entries are ignored).
 * @returns A callback ref that fans out to all of them (and returns a combined cleanup).
 */
export function composeRefs<T>(...refs: PossibleRef<T>[]): (node: T | null) => () => void {
  return (node: T | null) => {
    const cleanups = refs.map((ref) => setRef(ref, node));
    return () => {
      refs.forEach((ref, i) => {
        const cleanup = cleanups[i];
        if (cleanup) cleanup();
        else setRef(ref, null);
      });
    };
  };
}

/**
 * Hook form of {@link composeRefs}: memoizes the composed callback ref by the
 * given refs so it stays stable across renders.
 *
 * @param refs The refs to combine.
 * @returns A stable composed callback ref.
 */
export function useComposedRefs<T>(...refs: PossibleRef<T>[]): (node: T | null) => void {
  return useMemo(() => composeRefs(...refs), refs);
}
