// Hydrating over a Suspense boundary the server rendered as its fallback (`<!--$!-->…<!--/$-->`):
// react-dom/server's synchronous `renderToString` writes one when its content suspended. As in
// React, the client renders that boundary itself: its content mounts fresh (no mismatch is
// reported) and the server's fallback is pruned when its parent syncs. denext's own renderers
// never write such a boundary, so this ships only with the compat `react-dom/client` /
// `react-dom` modules, which install it.

import type { Cursor, Fiber } from "./fiber.ts";
import { setSuspenseHydration } from "./hydration.ts";

/** Suspense fibers hydrating client-side, each with the cursor to resume after it. */
const clientRendered = new WeakMap<Fiber, Cursor>();

/** The index of the `<!--/$-->` closing the boundary that opens at `start` (nesting counted). */
function closingMarker(parent: Node, start: number): number {
  let depth = 0;
  const nodes = parent.childNodes;
  for (let i = start; i < nodes.length; i++) {
    if (nodes[i].nodeType !== 8) continue;
    const data = nodes[i].nodeValue ?? "";
    if (data === "/$" && --depth === 0) return i;
    if (data[0] === "$") depth++;
  }
  return nodes.length - 1;
}

/**
 * Entering a Suspense fiber at a `<!--$!-->` boundary: skip past it and stop hydrating below it.
 * Completing one: resume after it. Any other boundary keeps the cursor.
 */
function step(wip: Fiber, cursor: Cursor | null, entering: boolean): Cursor | null {
  if (!entering) {
    const resume = clientRendered.get(wip);
    if (resume === undefined) return cursor;
    clientRendered.delete(wip);
    return resume;
  }
  if (!cursor) return null;
  const node = cursor.parent.childNodes[cursor.index];
  if (node?.nodeType !== 8 || node.nodeValue !== "$!") return cursor;
  cursor.index = closingMarker(cursor.parent, cursor.index) + 1;
  clientRendered.set(wip, cursor);
  return null;
}

/** Hydrate `<!--$!-->` boundaries client-side (the compat `react-dom` modules call this). */
export function installSuspenseHydration(): void {
  setSuspenseHydration(step);
}
