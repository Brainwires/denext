// Reassembling a streamed Flight document's tree in the browser. A streamed Flight page sends
// each Suspense hole's subtree (`<script type="application/json" data-dnx-f="<id>">`) and each
// deferred value — a Remix `defer()` field — (`data-dnx-v="<id>"`) as its own chunk the moment
// it resolves, and its trailing `#__denext_flight` carries the shell tree with those holes left
// in place. The entry puts them back before hydrating.

import { assembleStreamedFlight } from "../jsx/flight-holes.ts";
import type { FlightNode, FlightValue } from "../jsx/render-to-flight.ts";

/** Parse every `script[<attr>]` chunk of `doc` into a map keyed by the attribute's value. */
function readChunks<T>(doc: ParentNode, attr: string): Map<string, T> {
  const out = new Map<string, T>();
  for (const el of doc.querySelectorAll(`script[${attr}]`)) {
    const id = el.getAttribute(attr);
    if (!id) continue;
    try {
      out.set(id, JSON.parse(el.textContent || "null") as T);
    } catch { /* a malformed chunk leaves its hole unfilled */ }
  }
  return out;
}

/**
 * The page's complete Flight tree: `shell` (the parsed `#__denext_flight`) with the streamed
 * hole and deferred-value chunks of `doc` put back. A buffered document has no chunks and
 * gets `shell` back unchanged.
 *
 * @param doc The document (or fragment) holding the streamed chunks.
 * @param shell The parsed `#__denext_flight` tree.
 * @returns The tree to hydrate.
 */
export function readStreamedFlight(doc: ParentNode, shell: FlightNode): FlightNode {
  const holes = readChunks<FlightNode>(doc, "data-dnx-f");
  const values = readChunks<FlightValue>(doc, "data-dnx-v");
  if (holes.size === 0 && values.size === 0) return shell;
  return assembleStreamedFlight(shell, holes, values);
}
