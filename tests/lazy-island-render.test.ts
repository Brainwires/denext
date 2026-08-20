// Server emission for client:* islands: the dual renderer carves a lazy island
// into a <dnx-island> wrapper (HTML), a foreign host (page Flight), and a separate
// island Flight in the returned islands[] payload.

// deno-lint-ignore-file no-explicit-any -- tests poke Flight node internals.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { FOREIGN_PROP, ISLAND_MARKER_ATTR, ISLAND_TAG } from "../src/runtime/lazy-directive.ts";
import { useId } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";

function Counter(): VNode {
  return h("button", { class: "c" }, useId());
}
const counterMod = { Counter };
tagClientExports(counterMod as Record<string, unknown>, "c_counter");

Deno.test("a client:visible island is carved into a foreign island wrapper", async () => {
  const tree = h("main", null, h("h1", null, "T"), h(Counter, { "client:visible": true }));
  const { html, flight, islands } = await renderToHtmlFlight(tree);

  // HTML: the island's server output is nested in a layout-neutral wrapper — a plain
  // <div data-dnx-island …>, not a custom element.
  assertStringIncludes(
    html,
    `<${ISLAND_TAG} ${ISLAND_MARKER_ATTR} data-dnx-id="0" data-dnx-strategy="visible"`,
  );
  assertStringIncludes(html, "display:contents");
  assertStringIncludes(html, `<button class="c">:d0_0:</button>`);

  // Page Flight: the island is a foreign host with no children.
  const kids = (flight as any).c;
  assertEquals(kids[1].$, "h");
  assertEquals(kids[1].t, ISLAND_TAG);
  assertEquals(kids[1].p[FOREIGN_PROP], true);
  assertEquals(kids[1].p["data-dnx-id"], "0");
  assertEquals(kids[1].c, []);

  // islands[]: the island's own Flight, keyed by its tree-path id.
  assertEquals(islands.length, 1);
  assertEquals(islands[0].id, "0");
  assertEquals(islands[0].strategy, "visible");
  assertEquals((islands[0].flight as any).$, "c");
  assertEquals((islands[0].flight as any).i, "c_counter#Counter");
  assertEquals((islands[0].flight as any).p.__dnxIdPath, "0");
  // The client:* marker never reaches the island's serialized props.
  assert(!("client:visible" in (islands[0].flight as any).p));
});

Deno.test("an island with no directive stays eager (inline ref, no islands[])", async () => {
  const tree = h("main", null, h(Counter, {}));
  const { html, flight, islands } = await renderToHtmlFlight(tree);
  assert(!html.includes(ISLAND_MARKER_ATTR));
  assertEquals(islands.length, 0);
  assertEquals((flight as any).c[0].$, "c"); // inline client ref, as before
});

Deno.test("an invalid strategy falls back to eager", async () => {
  const tree = h("main", null, h(Counter, { "client:whenever": true }));
  const { html, islands } = await renderToHtmlFlight(tree);
  assert(!html.includes(ISLAND_MARKER_ATTR));
  assertEquals(islands.length, 0);
});
