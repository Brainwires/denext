// Keys through Flight: a keyed element's `key` travels as `k` (host, client reference, a keyed
// server component's single element), `parseFlight` hands it back to the reconciler, and a
// live-view patch of a reordered list moves the DOM nodes — their identity and an input's
// typed state survive — instead of rewriting each row in place.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { type FlightNode, renderToFlight } from "../src/jsx/render-to-flight.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { type ClientRegistry, parseFlight } from "../src/client/flight-client.ts";
import { applyFlightOps, diffFlight } from "../src/runtime/flight-patch.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

const registry = new Map() as unknown as ClientRegistry;

/** A server component: its key is the row's identity (React's Flight keeps it too). */
const Row = ({ id }: { id: string }): VNode => h("li", { "data-id": id }, h("input", null), id);

const list = (ids: string[]) => h("ul", null, ...ids.map((id) => h(Row as never, { key: id, id })));

const inputs = (container: FakeElement): FakeElement[] => {
  const ul = container.childNodes[0] as FakeElement;
  return ul.childNodes.map((li) => (li as FakeElement).childNodes[0] as FakeElement);
};

Deno.test("Flight carries keys: host, keyed server component and the dual render", async () => {
  const flight = await renderToFlight(
    h("ul", null, h("li", { key: 7 }, "x"), h(Row as never, { key: "r", id: "r" })),
  );
  const ul = flight as { c: Array<{ k?: string }> };
  assertEquals(ul.c.map((n) => n.k), ["7", "r"]);
  const unkeyed = await renderToFlight(h("p", null, "y"));
  assert(!("k" in (unkeyed as object)), "no key, no field");
  // The route's dual render (`<Live>` patches and soft navigation) carries them as well.
  const dual = await renderToHtmlFlight(list(["a", "b"]));
  assertEquals((dual.flight as { c: Array<{ k?: string }> }).c.map((n) => n.k), ["a", "b"]);
  assertEquals(dual.html.includes("key"), false, "a key never reaches the HTML");
});

Deno.test("a live-view patch reorders a keyed list: DOM identity and input state survive", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as never);
  const root = createRoot(container as never);
  const show = (tree: FlightNode[]) => {
    root.render(parseFlight(tree as FlightNode, registry) as never);
    flushSync();
  };
  const before = [await renderToFlight(list(["a", "b", "c"]))];
  show(before);
  const [a, b, c] = inputs(container);
  (b as unknown as { value: string }).value = "typed into b";

  const after = [await renderToFlight(list(["c", "a", "b"]))];
  const ops = diffFlight(before, after);
  assertEquals(ops[0][0], "m", "a reorder is a move, not a rewrite");
  show(applyFlightOps(before, ops));

  const moved = inputs(container);
  assert(moved[0] === c && moved[1] === a && moved[2] === b, "each row kept its DOM node");
  assertEquals((moved[2] as unknown as { value: string }).value, "typed into b");
  const ids = (container.childNodes[0] as FakeElement).childNodes.map((li) =>
    (li as FakeElement).getAttribute("data-id")
  );
  assertEquals(ids, ["c", "a", "b"]);
});
