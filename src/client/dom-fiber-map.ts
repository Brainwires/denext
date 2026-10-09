// A reverse index from a committed host DOM node to the fiber that renders it.
//
// The reconciler only ever walks fiber → `stateNode` (a fiber knows its DOM node,
// never the reverse). Event delegation (fiber/events.ts) needs the opposite: a root
// container's listener receives an event on some deep DOM node and must resolve it back
// to the owning fiber — and thence the handlers on its ancestors — without re-running
// the tree to rebuild that mapping. This module is that reverse map.
//
// The entry is the buffer whose props were COMMITTED last: a fresh node is recorded when it
// is created (it is only reachable once that render commits), an existing one when an update
// to its props commits — not while a render that may yet be abandoned is in progress, so an
// event never runs an uncommitted handler (a hydrated server node is the exception: it is
// recorded as its hydrating render completes, as its listeners always were). Both buffers of a fiber share one `stateNode`; a buffer
// re-rendered with equal props keeps the older entry, whose handlers are the same. A `WeakMap`
// keeps entries only as long as the DOM node itself is reachable, so removed nodes are
// collected with no explicit cleanup.

import type { Fiber } from "./fiber/fiber.ts";

const nodeToFiber = new WeakMap<object, Fiber>();

/**
 * Record that `node` is rendered by `fiber`, with `fiber`'s props committed: from
 * `completeWork` for a fresh (or hydration-adopted) node, and from the commit for an update.
 */
export function stampFiber(node: Element | Text | null, fiber: Fiber): void {
  if (node !== null) nodeToFiber.set(node as unknown as object, fiber);
}

/** The fiber rendering `node`, or `undefined` if it was never stamped. */
export function fiberForNode(node: unknown): Fiber | undefined {
  return node == null ? undefined : nodeToFiber.get(node as object);
}
