// Flight Suspense-hole primitives shared by the streaming and PPR Flight renderers
// and the document assembler. Kept as a dependency-free leaf module — importing it
// must NEVER pull in a server-only renderer (and, through it, `node:async_hooks` via
// the prerender scope), because the client's navigation module imports the document
// assembler, which needs `fillFlightHoles`. A value edge from the client bundle into
// `render-to-ppr-flight.ts` would drag `new AsyncLocalStorage()` into the browser.

import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";

/** A Suspense hole in a Flight tree, filled once its boundary resolves. */
interface FlightHole {
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

/**
 * A **value hole**: the placeholder a deferred promise prop (a Remix `defer()` field) leaves
 * in a streamed Flight tree. Its id is a `dnxv<n>` key into the resolved-values map.
 */
interface FlightValueHole {
  /** Discriminant: deferred value hole. */
  $: "vh";
  /** Value-hole id. */
  r: string;
}

/** Serialized-leaf discriminants that carry no nested value holes to substitute. */
const LEAF_FLIGHT_TAGS = new Set(["a", "D", "e", "n", "N", "U", "ch"]);

/** Resolve a `{$:"vh",r}` placeholder to its deferred value, or leave a look-alike as data. */
function fillValueHole(value: FlightValue, resolved: Map<string, FlightValue>): FlightValue {
  const r = (value as unknown as FlightValueHole).r;
  const filled = typeof r === "string" && r.startsWith("dnxv") ? resolved.get(r) : undefined;
  return filled === undefined ? value : substituteValueHoles(filled, resolved);
}

/**
 * Substitute resolved deferred values (`resolveValueHoles`) into a Flight tree,
 * replacing every `{$:"vh",r}` placeholder — in node children AND in props (where
 * a `defer()` field lives, e.g. the `loaderData` prop of a migrated Remix route).
 * A placeholder whose id isn't a resolved `dnxv` key is left as data (so a user
 * object shaped like a value hole is never corrupted).
 */
export function substituteValueHoles(
  value: FlightValue,
  resolved: Map<string, FlightValue>,
): FlightValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => substituteValueHoles(v, resolved));
  const tag = (value as { $?: string }).$;
  if (tag === "vh") return fillValueHole(value, resolved);
  if (tag && LEAF_FLIGHT_TAGS.has(tag)) return value;
  if (tag === "M" || tag === "S") {
    // A Map / Set prop: its entries may hold deferred values (a `defer()` field in a Set).
    const v = (value as { v: FlightValue[] }).v;
    return { $: tag, v: v.map((item) => substituteValueHoles(item, resolved)) } as FlightValue;
  }
  if (tag === "h" || tag === "c") {
    const n = value as unknown as { p: FlightProps; c: FlightNode[] };
    const c = n.c.map((child) =>
      substituteValueHoles(child as FlightValue, resolved) as FlightNode
    );
    return { ...value, p: substitutePropsValueHoles(n.p, resolved), c } as unknown as FlightValue;
  }
  // A plain (data) object nested in a prop: recurse its values.
  return substitutePropsValueHoles(value as FlightProps, resolved);
}

/** Substitute value holes across a serialized props/object map. */
function substitutePropsValueHoles(
  props: FlightProps,
  resolved: Map<string, FlightValue>,
): FlightProps {
  const out: FlightProps = {};
  for (const [k, v] of Object.entries(props)) out[k] = substituteValueHoles(v, resolved);
  return out;
}

/**
 * The complete Flight tree of a streamed document: its shell tree with each Suspense hole's
 * subtree and each deferred value — streamed one by one as `<script type="application/json"
 * data-dnx-f|data-dnx-v>` chunks as they resolved — put back in place.
 *
 * @param shell The shell tree (`#__denext_flight`), holes unfilled.
 * @param holes Each streamed Suspense hole's subtree, by boundary id.
 * @param values Each streamed deferred value, by value-hole id.
 * @returns The complete tree.
 */
export function assembleStreamedFlight(
  shell: FlightNode,
  holes: Map<string, FlightNode>,
  values: Map<string, FlightValue>,
): FlightNode {
  const filled = fillFlightHoles(shell, holes);
  return values.size > 0 ? substituteValueHoles(filled, values) as FlightNode : filled;
}
