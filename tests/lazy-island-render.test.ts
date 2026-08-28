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

Deno.test("a nested client:* island carves independently (its own wrapper + strategy)", async () => {
  const tree = h(
    "main",
    null,
    h(Parent, {
      "client:idle": true,
      children: h(Counter, { "client:visible": true }),
    } as never),
  );
  const { html, islands } = await renderToHtmlFlight(tree);
  // BOTH the parent (idle) and the nested Counter (visible) are carved islands, each
  // deferring on its own directive.
  assertEquals(islands.length, 2);
  const byStrategy = Object.fromEntries(islands.map((i) => [i.strategy, i]));
  assert(byStrategy.idle, "parent carves with its own idle strategy");
  assert(byStrategy.visible, "nested island carves with its own visible strategy");
  assertEquals(byStrategy.idle.id, "0"); // the parent

  // The nested Counter now has its OWN wrapper nested inside the parent's server DOM.
  assertEquals((html.match(/data-dnx-island/g) ?? []).length, 2);
  assertStringIncludes(
    html,
    `<div class="parent"><${ISLAND_TAG} ${ISLAND_MARKER_ATTR} data-dnx-id="${byStrategy.visible.id}" data-dnx-strategy="visible"`,
  );
  // The nested directive marker never leaks into any serialized Flight.
  assert(!JSON.stringify(islands).includes("client:visible"));

  // In the PARENT's children Flight, the nested island is a FOREIGN HOST (not a
  // client ref) whose id matches its wrapper — so the parent's per-island hydrate
  // adopts the child wrapper without reconciling into it.
  const nestedInParent = (byStrategy.idle.flight as any).c[0];
  assertEquals(nestedInParent.$, "h");
  assertEquals(nestedInParent.t, ISLAND_TAG);
  assertEquals(nestedInParent.p[FOREIGN_PROP], true);
  assertEquals(nestedInParent.p["data-dnx-id"], byStrategy.visible.id);
  assertEquals(nestedInParent.c, []);

  // The nested island's OWN Flight (for its independent hydrateRoot) is the client ref.
  assertEquals((byStrategy.visible.flight as any).$, "c");
  assertEquals((byStrategy.visible.flight as any).i, "c_counter#Counter");
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

// ---- Dev warning: SEO content trapped in a client:only island -------------

/** Run `fn` with __denextDev toggled, capturing console.warn lines. */
async function captureWarnings(dev: boolean, fn: () => Promise<void>): Promise<string[]> {
  const g = globalThis as { __denextDev?: boolean };
  const prevDev = g.__denextDev;
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  g.__denextDev = dev;
  try {
    await fn();
  } finally {
    console.warn = origWarn;
    if (prevDev === undefined) delete g.__denextDev;
    else g.__denextDev = prevDev;
  }
  return warnings;
}

Deno.test("client:only with SEO children warns in dev (heading not server-rendered)", async () => {
  const warnings = await captureWarnings(true, async () => {
    const tree = h(
      "main",
      null,
      h(Counter, { "client:only": true }, h("h1", null, "Important Title")),
    );
    await renderToHtmlFlight(tree);
  });
  assert(
    warnings.some((w) => w.includes("client:only") && w.includes("SEO-relevant")),
    "expected a dev warning about SEO content in a client:only island",
  );
});

Deno.test("client:only warning is silent in prod, and absent for non-SEO children", async () => {
  // Prod: never warns, even with SEO children.
  const prod = await captureWarnings(false, async () => {
    const tree = h("main", null, h(Counter, { "client:only": true }, h("h1", null, "Title")));
    await renderToHtmlFlight(tree);
  });
  assertEquals(prod.length, 0);

  // Dev but the island carries no SEO-significant content: no warning.
  const benign = await captureWarnings(true, async () => {
    const tree = h("main", null, h(Counter, { "client:only": true }, h("span", null, "ok")));
    await renderToHtmlFlight(tree);
  });
  assertEquals(benign.length, 0);
});

Deno.test("client:media renders server HTML, so it never warns", async () => {
  const warnings = await captureWarnings(true, async () => {
    const tree = h(
      "main",
      null,
      h(Counter, { "client:media": "(min-width: 800px)" }, h("h1", null, "Title")),
    );
    const { html } = await renderToHtmlFlight(tree);
    // client:media DOES server-render its body (crawlable) — the button is present.
    assertStringIncludes(html, `<button class="c">`);
  });
  assertEquals(warnings.length, 0);
});
