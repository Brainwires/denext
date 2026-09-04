// Context propagation: when a provider's value changes, mark every consumer in its
// committed subtree so the memo bailout can't leave one stale.

import { readsContext, reprovidesContext } from "./fiber-utils.ts";
import type { Fiber } from "./fiber.ts";

/**
 * Mark a consumer for re-render on `lane` and thread `childLanes` from it up to (and
 * including) the provider, so bailing ancestors still descend to reach it. Both buffers
 * are marked so the update survives whichever one the next render starts from.
 */
function markConsumerDirty(node: Fiber, provider: Fiber, lane: number): void {
  node.lanes |= lane;
  if (node.alternate) node.alternate.lanes |= lane;
  for (let p: Fiber | null = node.return; p !== null; p = p.return) {
    p.childLanes |= lane;
    if (p.alternate) p.alternate.childLanes |= lane;
    if (p === provider) return;
  }
}

/** Depth-first advance bounded to the provider's subtree; null once it is exhausted. */
function nextInSubtree(node: Fiber, provider: Fiber, descend: boolean): Fiber | null {
  if (descend && node.child !== null) return node.child;
  while (node.sibling === null) {
    if (node.return === null || node.return === provider) return null;
    node = node.return;
  }
  return node.sibling;
}

export function propagateContextChange(provider: Fiber, contextId: symbol, lane: number): void {
  let node: Fiber | null = provider.child;
  while (node !== null) {
    let descend = true;
    if (readsContext(node, contextId)) {
      markConsumerDirty(node, provider, lane);
    } else if (node.tag === "fragment" && reprovidesContext(node, contextId)) {
      descend = false; // a nested same-context provider shadows the value below
    }
    node = nextInSubtree(node, provider, descend);
  }
}
