// The browser half of per-boundary Flight streaming: `readStreamedFlight` puts each streamed
// Suspense-hole subtree (`data-dnx-f`) and deferred value (`data-dnx-v`) back into the shell
// `#__denext_flight` tree before the entry hydrates — and leaves a buffered document's
// complete tree untouched.

import { assertEquals } from "@std/assert";
import { readStreamedFlight } from "../src/client/streamed-flight.ts";
import type { FlightNode } from "../src/jsx/render-to-flight.ts";

/** A minimal `ParentNode` over `[attr, id, json]` chunk scripts. */
function chunkDoc(chunks: [string, string, string][]): ParentNode {
  return {
    querySelectorAll(selector: string) {
      const attr = /^script\[(.+)\]$/.exec(selector)?.[1];
      return chunks.filter(([a]) => a === attr).map(([a, id, text]) => ({
        getAttribute: (name: string) => (name === a ? id : null),
        textContent: text,
      }));
    },
  } as unknown as ParentNode;
}

const shell = {
  $: "h",
  t: "main",
  p: {},
  c: [
    { $: "c", i: "c_route#Route", p: { loaderData: { fast: { $: "vh", r: "dnxv0" } } }, c: [] },
    { $: "$", r: "dnx0" },
  ],
} as unknown as FlightNode;

Deno.test("readStreamedFlight: holes and deferred values are put back in place", () => {
  const doc = chunkDoc([
    ["data-dnx-f", "dnx0", JSON.stringify({ $: "h", t: "p", p: {}, c: ["late"] })],
    ["data-dnx-v", "dnxv0", JSON.stringify({ reviews: ["great"] })],
    ["data-dnx-v", "dnxv9", "{not json"], // a malformed chunk is skipped
  ]);
  assertEquals(readStreamedFlight(doc, shell), {
    $: "h",
    t: "main",
    p: {},
    c: [
      {
        $: "c",
        i: "c_route#Route",
        p: { loaderData: { fast: { reviews: ["great"] } } },
        c: [],
      },
      { $: "h", t: "p", p: {}, c: ["late"] },
    ],
  });
});

Deno.test("readStreamedFlight: a buffered document (no chunks) keeps its tree", () => {
  const complete = { $: "h", t: "main", p: {}, c: ["done"] } as unknown as FlightNode;
  assertEquals(readStreamedFlight(chunkDoc([]), complete), complete);
  assertEquals(readStreamedFlight(chunkDoc([]), null), null);
});
