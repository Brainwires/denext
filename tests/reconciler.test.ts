import { assertEquals, assertStrictEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { useContext, useEffect, useState } from "../src/runtime/hooks.ts";
import { createContext } from "../src/runtime/context.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// The reconciler is DOM-agnostic; feed it the in-memory shim.
// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

function Counter(): VNode {
  const [n, setN] = useState(0);
  return h("button", { onClick: () => setN(n + 1) }, String(n));
}

Deno.test("createRoot renders and updates on state change", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const root = createRoot(asEl(container));
  root.render(h(Counter, null));

  assertEquals(container.innerHTML, "<button>0</button>");

  (container.childNodes[0] as FakeElement).dispatch("click");
  flushSync();

  assertEquals(container.innerHTML, "<button>1</button>");
  root.unmount();
});

Deno.test("hydrateRoot adopts existing DOM nodes and binds events", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  // Pre-existing "server-rendered" markup: <button>0</button>
  const button = doc.createElement("button");
  button.appendChild(doc.createTextNode("0"));
  container.appendChild(button);
  const original = container.childNodes[0];

  hydrateRoot(asEl(container), h(Counter, null));

  // The same node was adopted, not replaced.
  assertStrictEquals(container.childNodes[0], original);

  (original as FakeElement).dispatch("click");
  flushSync();
  assertEquals(container.innerHTML, "<button>1</button>");
});

Deno.test("keyed list reordering preserves element identity", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function List(props: { items: string[] }): VNode {
    return h("ul", null, props.items.map((it) => h("li", { key: it }, it)));
  }
  const root = createRoot(asEl(container));
  root.render(h(List, { items: ["a", "b", "c"] }));

  const ul = container.childNodes[0] as FakeElement;
  const liA = ul.childNodes[0]; // <li>a</li>
  assertEquals(ul.childNodes.length, 3);

  root.render(h(List, { items: ["c", "a", "b"] }));

  // "a" moved to index 1 but is the same element instance.
  assertStrictEquals(ul.childNodes[1], liA);
  assertEquals(ul.textContent, "cab");
});

Deno.test("useEffect runs on mount and cleans up on unmount", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const log: string[] = [];

  function Fx(): VNode {
    useEffect(() => {
      log.push("mount");
      return () => log.push("cleanup");
    }, []);
    return h("span", null, "x");
  }
  function Wrap(props: { show: boolean }): VNode {
    return props.show ? h(Fx, null) : h("span", null, "gone");
  }

  const root = createRoot(asEl(container));
  root.render(h(Wrap, { show: true }));
  flushSync(); // passive effects (useEffect) run on a flush, as in React
  assertEquals(log, ["mount"]);

  root.render(h(Wrap, { show: false }));
  assertEquals(log, ["mount", "cleanup"]);
  assertEquals(container.innerHTML, "<span>gone</span>");
});

Deno.test("context provides values to nested consumers", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const Theme = createContext("light");

  function Consumer(): VNode {
    return h("em", null, useContext(Theme));
  }
  const root = createRoot(asEl(container));
  root.render(h(Theme.Provider, { value: "dark", children: h(Consumer, null) }));
  assertEquals(container.innerHTML, "<em>dark</em>");
});

Deno.test("effects re-run when dependencies change", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const log: string[] = [];

  function Effy(): VNode {
    const [v, setV] = useState(0);
    useEffect(() => {
      log.push(`eff:${v}`);
    }, [v]);
    return h("button", { onClick: () => setV(v + 1) }, String(v));
  }
  const root = createRoot(asEl(container));
  root.render(h(Effy, null));
  flushSync(); // passive effects (useEffect) run on a flush, as in React
  assertEquals(log, ["eff:0"]);

  (container.childNodes[0] as FakeElement).dispatch("click");
  flushSync();
  assertEquals(log, ["eff:0", "eff:1"]);
});
