// Context propagation: when a provider's value changes, mark every consumer in its
// committed subtree so the memo bailout can't leave one stale.

import { readsContext, reprovidesContext } from "./fiber-utils.ts";
import type { Fiber } from "./fiber.ts";

/**
 * Mark a consumer for re-render on `lane` and thread `childLanes` from it up to (and
 * including) the provider, so bailing ancestors still descend to reach it. Both buffers
 * are marked so the update survives whichever one the next render starts from.
 */
function markConsumer(node: Fiber, provider: Fiber, lane: number): void {
  node.lanes |= lane;
  if (node.alternate) node.alternate.lanes |= lane;
  while (node !== provider) {
    node = node.return!;
    node.childLanes |= lane;
    if (node.alternate) node.alternate.childLanes |= lane;
  }
}

/** The nearest of `node` and its ancestors that has a sibling, or the provider. */
function climb(node: Fiber, provider: Fiber): Fiber {
  while (node !== provider && node.sibling === null) node = node.return!;
  return node;
}

/**
 * Depth-first walk of the provider's subtree, marking every consumer of `contextId`. Each
 * step re-points the fiber it moves to at the fiber it came from (`return`), as React's walk
 * does: a child shared from the other buffer (a bailed parent re-links nothing) still points
 * at that buffer's parent, and following such a pointer climbed past the provider — the walk
 * then marked consumers outside its subtree. A nested provider of the same context shadows
 * the value below it.
 */
export function propagateContextChange(provider: Fiber, contextId: symbol, lane: number): void {
  for (let node = provider, next = provider.child;;) {
    if (next === null) {
      if ((next = climb(node, provider)) === provider) return;
      node = next.return!;
      next = next.sibling!;
    }
    next.return = node;
    node = next;
    next = node.child;
    if (readsContext(node, contextId)) markConsumer(node, provider, lane);
    else if (node.tag === "fragment" && reprovidesContext(node, contextId)) next = null;
  }
}
