// Wiring for client:* islands: the generated Flight entry loads the deferred-
// hydration bootstrap lazily (only when a page has islands), and the document
// emits the #__denext_islands payload.

import { assert, assertStringIncludes } from "@std/assert";
import { generateFlightEntry } from "../src/build/bundle.ts";
import { renderBodyScripts } from "../src/server/document.ts";
import type { BoundaryManifest } from "../src/build/module-graph.ts";
import type { FlightNode } from "../src/jsx/render-to-flight.ts";

Deno.test("generated Flight entry loads denext/lazy only when resumable features are present", () => {
  const boundary: BoundaryManifest = { client: new Map(), server: new Map() };
  const entry = generateFlightEntry(boundary);
  // Gated on the island payload or any data-dnx-h handler, so non-resumable pages
  // never fetch the chunk.
  assertStringIncludes(entry, 'document.getElementById("__denext_islands")');
  assertStringIncludes(entry, "[data-dnx-h]");
  assertStringIncludes(entry, 'import("denext/lazy")');
  assertStringIncludes(entry, "bootResumability(registry)");
  // The resumability runtime is NOT statically imported into the shared graph.
  assert(!entry.includes("registerLazyIsland,"), "lazy runtime must not be a static import");
});

Deno.test("renderBodyScripts emits the #__denext_islands map when islands are present", () => {
  const islandFlight: FlightNode = { $: "c", i: "c_app#Counter", p: { __dnxIdPath: "0" }, c: [] };
  const scripts = renderBodyScripts({
    bodyHtml: "",
    metadata: {},
    hydration: { params: {}, searchParams: "", pathname: "/" },
    clientEntry: "/entry.js",
    flight: { $: "h", t: "main", p: {}, c: [] },
    islands: [{ id: "0", strategy: "visible", flight: islandFlight }],
  });
  assertStringIncludes(scripts, 'id="__denext_islands"');
  assertStringIncludes(scripts, '"0":');
  assertStringIncludes(scripts, "c_app#Counter");
});

Deno.test("renderBodyScripts omits the islands script when there are none", () => {
  const scripts = renderBodyScripts({
    bodyHtml: "",
    metadata: {},
    hydration: { params: {}, searchParams: "", pathname: "/" },
    clientEntry: "/entry.js",
    flight: { $: "h", t: "main", p: {}, c: [] },
  });
  assert(!scripts.includes("__denext_islands"));
});
