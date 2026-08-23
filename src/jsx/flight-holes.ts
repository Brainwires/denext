// Flight Suspense-hole primitives shared by the streaming and PPR Flight renderers
// and the document assembler. Kept as a dependency-free leaf module — importing it
// must NEVER pull in a server-only renderer (and, through it, `node:async_hooks` via
// the prerender scope), because the client's navigation module imports the document
// assembler, which needs `fillFlightHoles`. A value edge from the client bundle into
// `render-to-ppr-flight.ts` would drag `new AsyncLocalStorage()` into the browser.

import type { FlightNode } from "./render-to-flight.ts";

/** A Suspense hole in a Flight tree, filled once its boundary resolves. */
export interface FlightHole {
  /** Discriminant: an unfilled Suspense hole. */
  $: "$";
  /** Boundary id (matches the streamed HTML swap id / the shell `data-dnx-b`). */
  r: string;
}

/** A dynamic hole discovered during a resume pass: its id and (pending) dual output. */
export interface ResumedFlightHole {
  /** The boundary id — matches a `data-dnx-b` placeholder in the cached shell. */
  id: string;
  /** The hole's rendered HTML (a promise while it is still resolving). */
  html: string | Promise<string>;
  /** The hole's Flight subtree (a promise while it is still resolving). */
  flight: FlightNode | Promise<FlightNode>;
}

/**
 * Recursively fill `{$:"$",r}` Suspense holes in a Flight tree with their resolved
 * subtrees. A hole with no resolved subtree collapses to `null` (its shell fallback
 * stays in the HTML). Pure structural work — no re-render.
 */
export function fillFlightHoles(node: FlightNode, holes: Map<string, FlightNode>): FlightNode {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => fillFlightHoles(n, holes));
  const tag = (node as { $?: string }).$;
  if (tag === "$") {
    const filled = holes.get((node as unknown as FlightHole).r);
    return filled === undefined ? null : fillFlightHoles(filled, holes);
  }
  if (tag === "h" || tag === "c") {
    const n = node as { c: FlightNode[] };
    return { ...node, c: n.c.map((c) => fillFlightHoles(c, holes)) } as FlightNode;
  }
  return node;
}
