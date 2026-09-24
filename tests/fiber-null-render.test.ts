// A component that renders `null` / `undefined` / a boolean creates NO host node, as in
// React. denext used to substitute an empty text vnode, so rendering `() => null` into a
// container whose document has no `createTextNode` threw, every such component left a
// stray `""` text node in the DOM, and hydration let that placeholder claim the NEXT
// server text node (a spurious mismatch). The reconciler also read `globalThis.document`
// once at module load; it now creates nodes in the container's `ownerDocument`.
//
// The placement cases below pin sibling order through null ↔ element transitions, lists
// with null items, conditional children and Suspense fallback toggling, so a component
// with no host node can never mis-place its neighbours.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, hydrateRoot } from "../src/client/reconciler.ts";
import { act } from "../src/compat/react.ts";
import { createRoot as compatCreateRoot } from "../src/compat/react-dom-client.ts";
import { Fragment } from "../src/jsx/jsx-runtime.ts";
import { Suspense, use } from "../src/runtime/suspense.ts";
import { useState } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeElement, type FakeNode, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

/** The number of DOM children of `el` — an empty placeholder text node would count. */
function count(el: FakeNode): number {
  return el.childNodes.length;
}

/** Type a component that may render nothing (`h()` types components as returning a VNode). */
function nullable<P>(fn: (props: P) => VNode | null | undefined | boolean): (props: P) => VNode {
  return fn as (props: P) => VNode;
}

const Null = nullable(() => null);

Deno.test("() => null renders into a stub container whose document cannot create nodes", async () => {
  // The reported repro: no createTextNode / createElement / childNodes anywhere.
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  for (const rendered of [null, undefined, false, true]) {
    // deno-lint-ignore no-explicit-any
    await act(() => compatCreateRoot(container as any).render(h(nullable(() => rendered), null)));
  }
});

Deno.test("nodes are created in the container's ownerDocument, not a module-load global", () => {
  // No setDocument: the only route to `doc` is the container's ownerDocument.
  const { doc, container } = makeDom();
  const created: string[] = [];
  const createElement = doc.createElement.bind(doc);
  doc.createElement = (tag: string) => {
    created.push(tag);
    return createElement(tag);
  };
  createRoot(asEl(container)).render(h("section", null, h("b", null, "x")));
  assertEquals(container.innerHTML, "<section><b>x</b></section>");
  assertEquals(created.sort(), ["b", "section"]);
});

Deno.test("a null-rendering component leaves no DOM node beside its siblings", () => {
  const { container } = makeDom();
  createRoot(asEl(container)).render(
    h("div", null, h("b", null), h(Null, null), h(nullable(() => undefined), null), h("i", null)),
  );
  const div = container.childNodes[0];
  assertEquals(container.innerHTML, "<div><b></b><i></i></div>");
  assertEquals(count(div), 2);
  // A root whose whole tree is null is an empty container.
  const other = makeDom();
  createRoot(asEl(other.container)).render(h(Null, null));
  assertEquals(count(other.container), 0);
});

Deno.test("null → element → null between siblings keeps order and leaves nothing behind", () => {
  const { container } = makeDom();
  let set: (v: number) => void = () => {};
  function ToggleImpl(): VNode | null {
    const [n, s] = useState(0);
    set = s;
    if (n === 1) return h("span", null, "mid");
    if (n === 2) return h(Fragment, null, h("u", null), "t", h("s", null));
    return null;
  }
  const Toggle = nullable(ToggleImpl);
  createRoot(asEl(container)).render(h("div", null, h("b", null), h(Toggle, null), h("i", null)));
  const div = container.childNodes[0];
  const b = div.childNodes[0];
  const i = div.childNodes[1];
  assertEquals(count(div), 2);

  flushSync(() => set(1));
  assertEquals(container.innerHTML, "<div><b></b><span>mid</span><i></i></div>");
  assertStrictEquals(div.childNodes[0], b);
  assertStrictEquals(div.childNodes[2], i);

  flushSync(() => set(0));
  assertEquals(container.innerHTML, "<div><b></b><i></i></div>");
  assertEquals(count(div), 2);

  flushSync(() => set(2));
  assertEquals(container.innerHTML, "<div><b></b><u></u>t<s></s><i></i></div>");
  flushSync(() => set(0));
  assertEquals(count(div), 2);
  assertStrictEquals(div.childNodes[0], b);
  assertStrictEquals(div.childNodes[1], i);
});

Deno.test("a keyed list whose items render null places the rest in order through a reorder", () => {
  const { container } = makeDom();
  const Item = nullable(({ id }: { id: number }) =>
    id % 2 === 0 ? null : h("li", null, String(id))
  );
  let setOrder: (v: number[]) => void = () => {};
  function List(): VNode {
    const [order, s] = useState([1, 2, 3, 4, 5]);
    setOrder = s;
    return h("ul", null, order.map((id) => h(Item, { key: id, id })));
  }
  createRoot(asEl(container)).render(h(List, null));
  const ul = container.childNodes[0];
  assertEquals(container.innerHTML, "<ul><li>1</li><li>3</li><li>5</li></ul>");
  const [li1, li3, li5] = ul.childNodes;

  flushSync(() => setOrder([5, 4, 3, 2, 1]));
  assertEquals(container.innerHTML, "<ul><li>5</li><li>3</li><li>1</li></ul>");
  assertStrictEquals(ul.childNodes[0], li5);
  assertStrictEquals(ul.childNodes[1], li3);
  assertStrictEquals(ul.childNodes[2], li1);

  flushSync(() => setOrder([2, 4, 6]));
  assertEquals(container.innerHTML, "<ul></ul>");
  assertEquals(count(ul), 0);

  flushSync(() => setOrder([6, 7, 2, 1]));
  assertEquals(container.innerHTML, "<ul><li>7</li><li>1</li></ul>");
});

Deno.test("conditional children around a null component update adjacent text in place", () => {
  const { container } = makeDom();
  let set: (v: boolean) => void = () => {};
  function App(): VNode {
    const [on, s] = useState(false);
    set = s;
    return h("p", null, "a", h(Null, null), on ? h("em", null, "on") : null, "b", h(Null, null));
  }
  createRoot(asEl(container)).render(h(App, null));
  const p = container.childNodes[0];
  assertEquals(container.innerHTML, "<p>ab</p>");
  assertEquals(count(p), 2);
  flushSync(() => set(true));
  assertEquals(container.innerHTML, "<p>a<em>on</em>b</p>");
  flushSync(() => set(false));
  assertEquals(container.innerHTML, "<p>ab</p>");
  assertEquals(count(p), 2);
});

Deno.test("Suspense fallback ↔ content toggling with null-rendering siblings keeps order", async () => {
  const { container } = makeDom();
  let resolve: (v: string) => void = () => {};
  const p = new Promise<string>((r) => (resolve = r));
  function Child(): VNode {
    return h("span", null, use(p));
  }
  createRoot(asEl(container)).render(
    h(
      "div",
      null,
      h("b", null),
      h(Suspense, {
        fallback: h(Fragment, null, h(Null, null), h("em", null, "wait"), h(Null, null)),
        children: h(Fragment, null, h(Null, null), h(Child, null)),
      }),
      h(Null, null),
      h("i", null),
    ),
  );
  const div = container.childNodes[0];
  assertEquals(container.innerHTML, "<div><b></b><em>wait</em><i></i></div>");
  assertEquals(count(div), 3);

  resolve("done");
  await p;
  await Promise.resolve();
  flushSync();
  assertEquals(container.innerHTML, "<div><b></b><span>done</span><i></i></div>");
  assertEquals(count(div), 3);
});

Deno.test("a Suspense boundary with a null fallback shows nothing, then its content", async () => {
  const { container } = makeDom();
  let resolve: (v: string) => void = () => {};
  const p = new Promise<string>((r) => (resolve = r));
  function Child(): VNode {
    return h("span", null, use(p));
  }
  createRoot(asEl(container)).render(
    h("div", null, h(Suspense, { fallback: null, children: h(Child, null) }), h("i", null)),
  );
  assertEquals(container.innerHTML, "<div><i></i></div>");
  resolve("ok");
  await p;
  await Promise.resolve();
  flushSync();
  assertEquals(container.innerHTML, "<div><span>ok</span><i></i></div>");
});

Deno.test("hydration: a null component does not claim the server text that follows it", () => {
  const { doc, container } = makeDom();
  // Server output of <div><Null/>hello<b/></div> is <div>hello<b></b></div> (null emits nothing).
  const div = doc.createElement("div");
  const text = doc.createTextNode("hello");
  const b = doc.createElement("b");
  div.appendChild(text);
  div.appendChild(b);
  container.appendChild(div);

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  const dev = globalThis as { __denextDev?: boolean };
  dev.__denextDev = true;
  try {
    hydrateRoot(asEl(container), h("div", null, h(Null, null), "hello", h("b", null)));
  } finally {
    console.warn = original;
    delete dev.__denextDev;
  }
  assertEquals(warnings, [], "no hydration mismatch");
  assertStrictEquals(container.childNodes[0], div);
  assertStrictEquals(div.childNodes[0], text, "the server text node is adopted");
  assertStrictEquals(div.childNodes[1], b);
  assertEquals(count(div), 2);
  assert(text.nodeValue === "hello");
});
