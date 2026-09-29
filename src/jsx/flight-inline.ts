// Which Flight tree a full HTML document inlines as `#__denext_flight`.
//
// The browser entry hydrates the page root from the inlined tree. That is only worth doing when
// the root has something to wire up: a client component that is NOT a carved `client:*` island,
// or a host prop that is live on the client (a Server Action, a resumable handler, a channel).
// A page whose client parts are all carved islands — each hydrates on its own wrapper, from its
// own Flight in `#__denext_islands` — would hydrate a root of pure static host elements: a copy
// of the page's HTML as JSON (about 3x its size), parsed, kept and reconciled for nothing.
// Such a page inlines `null` instead, and the entry boots it root-less: navigation, the islands
// and the delegated handlers only. A soft navigation away fetches the next route's Flight on
// demand (the `x-denext-nav` JSON payload) and mounts it fresh, so nothing needs the old tree.

import type { FlightNode, FlightValue } from "./render-to-flight.ts";

/** Value tags that are live on the client: a component, a host element, an action, a handler. */
const LIVE_VALUE_TAGS = new Set(["a", "b", "c", "ch", "e", "h"]);

/**
 * Whether a serialized prop value holds something only a hydrated root can make live. Codec
 * tags (`D`, `n`, `M`, …) and plain objects (whose own `$` keys are escaped to `$$`) are data;
 * their contents are checked in turn, since a Map or an object may carry an action reference.
 */
function valueIsLive(value: FlightValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(valueIsLive);
  const tag = (value as { $?: unknown }).$;
  if (typeof tag === "string" && LIVE_VALUE_TAGS.has(tag)) return true;
  return Object.values(value as Record<string, FlightValue>).some(valueIsLive);
}

/**
 * Whether hydrating the page root from `node` would do anything. Host elements and text are
 * static (the server HTML already is them); a carved island's wrapper is a foreign host the root
 * only adopts. A client error boundary (`b`) around static children is transparent: it catches
 * a render throw of the root's own client components, and there are none — the islands render
 * in their own roots. A client reference (`c`), or any node shape this walk does not know,
 * needs the root.
 */
export function flightNeedsRootHydration(node: FlightNode): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(flightNeedsRootHydration);
  switch (node.$) {
    case "h":
      return Object.values(node.p ?? {}).some(valueIsLive) ||
        node.c.some(flightNeedsRootHydration);
    case "b":
      return node.c.some(flightNeedsRootHydration);
    default:
      return true;
  }
}

/**
 * The Flight tree an HTML document inlines for its root: `flight` when the root must hydrate,
 * else `null` (a root-less islands page; see the module comment). The soft-navigation payload
 * always carries the full tree — this applies to the inlined document copy only.
 *
 * @param flight The page's complete Flight tree (holes filled).
 * @returns The tree to serialize into `#__denext_flight`.
 */
export function inlinedRootFlight(flight: FlightNode): FlightNode {
  return flightNeedsRootHydration(flight) ? flight : null;
}
