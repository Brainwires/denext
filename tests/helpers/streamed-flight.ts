// What the browser entry hydrates from a document: its `#__denext_flight` tree with the
// Suspense-hole (`data-dnx-f`) and deferred-value (`data-dnx-v`) chunks a streamed document
// sent put back — the server-side mirror of the entry's `readStreamedFlight`.

import { fillFlightHoles } from "../../src/jsx/flight-holes.ts";
import { substituteValueHoles } from "../../src/jsx/flight-value-holes.ts";
import type { FlightNode, FlightValue } from "../../src/jsx/render-to-flight.ts";

/** The JSON chunks a streamed document sent under `attr`, by id. */
export function streamedChunks<T>(html: string, attr: string): Map<string, T> {
  const re = new RegExp(
    `<script type="application/json" ${attr}="([^"]+)">([\\s\\S]*?)</script>`,
    "g",
  );
  return new Map([...html.matchAll(re)].map((m) => [m[1], JSON.parse(m[2]) as T]));
}

/**
 * The Flight tree the browser hydrates from `html` (a buffered document's tree unchanged).
 *
 * @param html The document.
 * @returns The assembled tree.
 * @throws When the document has no `#__denext_flight`.
 */
export function hydratedFlight(html: string): FlightNode {
  const m = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("no #__denext_flight in the document");
  const filled = fillFlightHoles(JSON.parse(m[1]), streamedChunks<FlightNode>(html, "data-dnx-f"));
  const values = streamedChunks<FlightValue>(html, "data-dnx-v");
  return values.size > 0 ? substituteValueHoles(filled, values) as FlightNode : filled;
}
