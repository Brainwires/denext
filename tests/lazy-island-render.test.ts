// Server emission for client:* islands: the dual renderer carves a lazy island
// into a <dnx-island> wrapper (HTML), a foreign host (page Flight), and a separate
// island Flight in the returned islands[] payload.

// deno-lint-ignore-file no-explicit-any -- tests poke Flight node internals.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { clientRefOf, tagClientExports } from "../src/runtime/client-reference.ts";
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

// A module that declares `export const hydrate = "visible"` — its exports carry
// the per-component default onto their client-reference info.
function Widget(): VNode {
  return h("button", { class: "w" }, useId());
}
const widgetMod = { Widget, hydrate: "visible" };
tagClientExports(widgetMod as Record<string, unknown>, "c_widget");

Deno.test("tagClientExports captures a module `hydrate` export as moduleHydrate", () => {
  assertEquals(clientRefOf(Widget)?.moduleHydrate, "visible");
  // A module without the export leaves it undefined.
  assertEquals(clientRefOf(Counter)?.moduleHydrate, undefined);
});

Deno.test("a module `hydrate` default carves the island (no usage-site directive)", async () => {
  const tree = h("main", null, h(Widget, {}));
  const { html, islands } = await renderToHtmlFlight(tree);
  assertStringIncludes(html, `${ISLAND_MARKER_ATTR} data-dnx-id="0" data-dnx-strategy="visible"`);
  assertEquals(islands.length, 1);
  assertEquals(islands[0].strategy, "visible");
});

Deno.test("a usage-site client:* overrides the module `hydrate` default", async () => {
  const tree = h("main", null, h(Widget, { "client:interaction": true }));
  const { html, islands } = await renderToHtmlFlight(tree);
  assertStringIncludes(html, `data-dnx-strategy="interaction"`);
  assertEquals(islands.length, 1);
  assertEquals(islands[0].strategy, "interaction");
});

Deno.test("client:media carves the island and stamps the query on the wrapper", async () => {
  const tree = h("main", null, h(Counter, { "client:media": "(min-width:800px)" }));
  const { html, flight, islands } = await renderToHtmlFlight(tree);
  assertStringIncludes(html, `data-dnx-strategy="media"`);
  assertStringIncludes(html, `data-dnx-strategy-param="(min-width:800px)"`);
  // Still SSRs its content for first paint.
  assertStringIncludes(html, `<button class="c">`);
  assertEquals(islands.length, 1);
  assertEquals(islands[0].strategy, "media");
  assertEquals(islands[0].param, "(min-width:800px)");
  // The param rides along on the page-Flight foreign host too (soft-nav fidelity).
  assertEquals((flight as any).c[0].p["data-dnx-strategy-param"], "(min-width:800px)");
});

// A parent client island that renders its children.
function Parent(props: { children?: unknown }): VNode {
  return h("div", { class: "parent" }, props.children as never);
}
const parentMod = { Parent };
tagClientExports(parentMod as Record<string, unknown>, "c_parent");

Deno.test("a client:* island nested inside another island renders eager (gated, no wrapper)", async () => {
  const tree = h(
    "main",
    null,
    h(Parent, {
      "client:idle": true,
      children: h(Counter, { "client:visible": true }),
    } as never),
  );
  const { html, islands } = await renderToHtmlFlight(tree);
  // Only the PARENT is a carved island; the nested Counter is inlined into it.
  assertEquals(islands.length, 1);
  assertEquals(islands[0].id, "0");
  assertEquals(islands[0].strategy, "idle");
  // The nested Counter has NO wrapper of its own — its button sits directly in the
  // parent's server DOM, so the parent's hydrateRoot structure matches.
  assertEquals((html.match(/data-dnx-island/g) ?? []).length, 1);
  assertStringIncludes(html, `<div class="parent"><button class="c">`);
  // The nested directive marker never leaks into the parent's serialized children.
  assert(!JSON.stringify(islands[0].flight).includes("client:visible"));
  // The nested island survives as a plain client ref in the parent's children Flight.
  assertEquals((islands[0].flight as any).c[0].$, "c");
  assertEquals((islands[0].flight as any).c[0].i, "c_counter#Counter");
});

Deno.test("client:only carves an EMPTY wrapper (no SSR) but keeps the island Flight", async () => {
  const tree = h("main", null, h(Counter, { "client:only": true }));
  const { html, islands } = await renderToHtmlFlight(tree);
  assertStringIncludes(html, `data-dnx-strategy="only"`);
  // No server DOM for the island body — the wrapper is empty.
  assert(!html.includes(`<button class="c">`), "client:only must not SSR the island body");
  assertStringIncludes(html, `style="display:contents"></${ISLAND_TAG}>`);
  assertEquals(islands.length, 1);
  assertEquals(islands[0].strategy, "only");
  // The island's own Flight is still present for the client createRoot.
  assertEquals((islands[0].flight as any).$, "c");
  assertEquals((islands[0].flight as any).i, "c_counter#Counter");
});
