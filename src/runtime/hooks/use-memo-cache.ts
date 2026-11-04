// The public `useMemoCache`: the installed dispatcher's own (the server's), else the client fiber
// dispatcher's, which lives in src/client/fiber/hooks/use-memo-cache.ts so a bundle carries it only when
// the app calls `useMemoCache` (see src/client/fiber/hooks-dispatcher.ts).

import type { ClientHookHost } from "../../client/fiber/hooks-dispatcher.ts";
import { activeDispatcher } from "../hooks.ts";
import { clientUseMemoCache } from "../../client/fiber/hooks/use-memo-cache.ts";

/**
 * Return a stable, per-component array of `size` cache slots. This is the
 * primitive the build-time auto-memo compiler emits into: generated code reads
 * and writes these slots to memoize expensive expressions and keep JSX/props
 * referentially stable so the reconciler can bail out of unchanged subtrees. You
 * can use it by hand too, but it is intended for generated code.
 *
 * Slots are initialized to `MEMO_CACHE_SENTINEL`; treat a slot still equal
 * to the sentinel as "not yet computed".
 *
 * @param size The number of cache slots.
 * @returns The component's slots.
 */
export function useMemoCache(size: number): unknown[] {
  const d = activeDispatcher();
  return d.useMemoCache ? d.useMemoCache(size) : clientUseMemoCache(d as ClientHookHost, size);
}
