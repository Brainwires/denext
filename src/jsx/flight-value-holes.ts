// Deferred-value ("value hole") substitution for Flight trees: a Remix `defer()` field leaves a
// `{$:"vh",r}` placeholder in a streamed tree, filled once the value resolves. Its own leaf
// module, apart from flight-holes.ts, because only migrated Remix routes stream deferred values:
// the browser entry imports it dynamically when the document carries a `data-dnx-v` chunk, so
// every other Flight app ships none of it in the shared runtime.

import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";

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
