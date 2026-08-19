// A reverse index from a committed host DOM node to the fiber that renders it.
//
// The reconciler only ever walks fiber → `stateNode` (a fiber knows its DOM node,
// never the reverse). Resumability needs the opposite: a single delegated root
// listener receives an event on some deep DOM node and must resolve it back to the
// owning fiber — and thence its island / handlers — WITHOUT re-running the tree to
// rebuild that mapping. This module is that reverse map.
//
// Keying is safe across double-buffering: `createWorkInProgress` shares one
// `stateNode` object between a fiber's two buffers (fiber.ts), and host `listeners`
// are shared too (reconciler.ts), so whichever buffer last stamped a node, reads
// off it see the live listeners. A `WeakMap` keeps entries only as long as the DOM
// node itself is reachable, so removed nodes are collected with no explicit cleanup.

import type { Fiber } from "./fiber/fiber.ts";

const nodeToFiber = new WeakMap<object, Fiber>();

/**
 * Record that `node` is rendered by `fiber`. Called from `completeWork` for every
 * host node (fresh mount, hydration-adopted, or update), so the map always points
 * at the most-recently-rendered buffer — which becomes `current` on the next commit.
 */
export function stampFiber(node: Element | Text | null, fiber: Fiber): void {
  if (node !== null) nodeToFiber.set(node as unknown as object, fiber);
}

/** The fiber rendering `node`, or `undefined` if it was never stamped. */
export function fiberForNode(node: unknown): Fiber | undefined {
  return node == null ? undefined : nodeToFiber.get(node as object);
}
