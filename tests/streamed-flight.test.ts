// The browser half of per-boundary Flight streaming: `readStreamedFlight` puts each streamed
// Suspense-hole subtree (`data-dnx-f`) and deferred value (`data-dnx-v`) back into the shell
// `#__denext_flight` tree before the entry hydrates — and leaves a buffered document's
// complete tree untouched.

import { assertEquals } from "@std/assert";
import { readStreamedFlight } from "../src/client/streamed-flight.ts";
import type { FlightNode } from "../src/jsx/render-to-flight.ts";

/**
 * A minimal `ParentNode` over `[attr, id, json, nested?]` chunk scripts. A chunk is a direct
 * child of `<body>` (where the server streams them) unless `nested` puts it deeper — in page
 * content — which a `body>` selector does not match.
 */
function chunkDoc(chunks: [string, string, string, "nested"?][]): ParentNode {
  return {
    querySelectorAll(selector: string) {
      const m = /^(body>)?script\[(.+)\]$/.exec(selector);
      const attr = m?.[2];
      return chunks.filter(([a, , , nested]) => a === attr && !(m?.[1] && nested)).map((
        [a, id, text],
      ) => ({
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

Deno.test("readStreamedFlight: holes and deferred values are put back in place", async () => {
  const doc = chunkDoc([
    ["data-dnx-f", "dnx0", JSON.stringify({ $: "h", t: "p", p: {}, c: ["late"] })],
    ["data-dnx-v", "dnxv0", JSON.stringify({ reviews: ["great"] })],
    ["data-dnx-v", "dnxv9", "{not json"], // a malformed chunk is skipped
  ]);
  assertEquals(await readStreamedFlight(doc, shell), {
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

Deno.test("readStreamedFlight: a buffered document (no chunks) keeps its tree", async () => {
  const complete = { $: "h", t: "main", p: {}, c: ["done"] } as unknown as FlightNode;
  assertEquals(await readStreamedFlight(chunkDoc([]), complete), complete);
  assertEquals(await readStreamedFlight(chunkDoc([]), null), null);
});

// Audit 3.4.0 N1: only the chunks the server streams — direct children of `<body>`, after the
// root — are read. A `<script type="application/json" data-dnx-v>` inside page content (user
// HTML rendered into the root) must not fill a hole or a deferred value.
Deno.test("readStreamedFlight: a chunk inside page content is not read", () => {
  const doc = chunkDoc([
    ["data-dnx-v", "dnxv0", JSON.stringify({ reviews: ["forged"] }), "nested"],
    ["data-dnx-f", "dnx0", JSON.stringify({ $: "h", t: "p", p: {}, c: ["forged"] }), "nested"],
    ["data-dnx-f", "dnx0", JSON.stringify({ $: "h", t: "p", p: {}, c: ["late"] })],
  ]);
  const tree = JSON.stringify(readStreamedFlight(doc, shell));
  assertEquals(tree.includes("forged"), false, tree);
  assertEquals(tree.includes("late"), true, tree);
});
