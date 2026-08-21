// The foreign-subtree primitive: the page-root reconciler adopts a lazy island's
// wrapper element but leaves its server DOM untouched, so a separate per-island
// hydrateRoot can own that subtree. Also guards that framework __dnx* markers never
// leak to the DOM as attributes.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import {
  FOREIGN_PROP,
  ISLAND_ID_ATTR,
  ISLAND_STRATEGY_ATTR,
  ISLAND_TAG,
} from "../src/runtime/lazy-directive.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Build a server-rendered page: <h1>, a foreign island wrapper with pre-existing
 * children, and a trailing <footer>. */
function serverDom() {
  const { doc, container } = makeDom();
  const page = doc.createElement("div");
  container.appendChild(page);

  const h1 = doc.createElement("h1");
  h1.appendChild(doc.createTextNode("Dashboard"));
  page.appendChild(h1);

  const island = doc.createElement(ISLAND_TAG);
  island.setAttribute(ISLAND_ID_ATTR, "0.2.1");
  island.setAttribute(ISLAND_STRATEGY_ATTR, "visible");
  const button = doc.createElement("button");
  button.appendChild(doc.createTextNode("Count: 5"));
  island.appendChild(button);
  page.appendChild(island);

  const footer = doc.createElement("footer");
  footer.appendChild(doc.createTextNode("end"));
  page.appendChild(footer);
  return { doc, container, page, island, button };
}

Deno.test("page hydrate adopts a foreign island wrapper but preserves its children", () => {
  const { doc, container, page, island, button } = serverDom();
  setDocument(doc as Any);

  // The page tree references the island as a foreign host with NO children.
  const tree = h(
    "div",
    null,
    h("h1", null, "Dashboard"),
    h(ISLAND_TAG, {
      [FOREIGN_PROP]: true,
      [ISLAND_ID_ATTR]: "0.2.1",
      [ISLAND_STRATEGY_ATTR]: "visible",
    }),
    h("footer", null, "end"),
  );
  hydrateRoot(container as Any, tree);
  flushSync();

  // The island's server DOM is untouched (not deleted by syncChildren).
  assertEquals(island.childNodes.length, 1);
  assert(island.childNodes[0] === button, "expected the original <button> node preserved");
  assertEquals(island.textContent, "Count: 5");
  // The h1 + island + trailing sibling all hydrated in place under the page div.
  assertEquals(page.childNodes.length, 3);
  assertEquals((page.childNodes[2] as Any).tagName, "FOOTER");
});

Deno.test("the __dnxForeign marker never becomes a DOM attribute", () => {
  const { doc, container, island } = serverDom();
  setDocument(doc as Any);
  hydrateRoot(
    container as Any,
    h(
      "div",
      null,
      h("h1", null, "Dashboard"),
      h(ISLAND_TAG, { [FOREIGN_PROP]: true, [ISLAND_ID_ATTR]: "0.2.1" }),
      h("footer", null, "end"),
    ),
  );
  flushSync();
  assertEquals(island.getAttribute(FOREIGN_PROP), null);
  // The real data-* attributes are still present.
  assertEquals(island.getAttribute(ISLAND_ID_ATTR), "0.2.1");
});

Deno.test("a separate hydrateRoot adopts the preserved island subtree", () => {
  const { doc, container, island, button } = serverDom();
  setDocument(doc as Any);
  hydrateRoot(
    container as Any,
    h(
      "div",
      null,
      h("h1", null, "Dashboard"),
      h(ISLAND_TAG, { [FOREIGN_PROP]: true, [ISLAND_ID_ATTR]: "0.2.1" }),
      h("footer", null, "end"),
    ),
  );
  flushSync();

  // Now hydrate the island itself over its wrapper — it adopts the same <button>.
  hydrateRoot(island as Any, h("button", null, "Count: 5"));
  flushSync();
  assert(island.childNodes[0] === button, "island hydrate must adopt the existing node");
  assertEquals(island.textContent, "Count: 5");
});
