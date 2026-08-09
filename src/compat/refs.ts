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

/** Assign `node` to a single ref (object or callback). */
function setRef<T>(ref: PossibleRef<T>, node: T | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref != null) ref.current = node;
}

/**
 * Compose multiple refs into one callback ref. The returned ref writes the
 * mounted node to every input ref, and writes `null` to all of them on detach.
 *
 * @param refs The refs to combine (nullish entries are ignored).
 * @returns A callback ref that fans out to all of them.
 */
export function composeRefs<T>(...refs: PossibleRef<T>[]): (node: T | null) => void {
  return (node: T | null) => {
    for (const ref of refs) setRef(ref, node);
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
