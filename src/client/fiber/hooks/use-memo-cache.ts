// useMemoCache (the auto-memo compiler's target) on the client fiber dispatcher, in its own
// module so an app no compiler output reaches ships none of it (see ../hooks-dispatcher.ts).
// Linked by the public hook, src/runtime/hooks/use-memo-cache.ts.
// It imports nothing of the reconciler: what it needs is the client dispatcher's
// {@linkcode ClientHookHost} members, which the public hook hands it.

import { MEMO_CACHE_SENTINEL } from "../../../runtime/hooks.ts";
import { HK_MEMOCACHE } from "../hook-kinds.ts";
import type { ClientHookHost } from "../hooks-dispatcher.ts";

/**
 * `useMemoCache` for the component the client reconciler is rendering.
 *
 * @param host The client dispatcher.
 * @param size The number of cache slots.
 * @returns The component's slots, kept across renders.
 */
export function clientUseMemoCache(host: ClientHookHost, size: number): unknown[] {
  const cell = host.cell(HK_MEMOCACHE);
  if (!cell.inited) {
    cell.value = new Array(size).fill(MEMO_CACHE_SENTINEL);
    cell.inited = true;
  }
  return cell.value as unknown[];
}
