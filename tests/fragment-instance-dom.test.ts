// FragmentInstance's DOM methods — focus, blur, dispatchEvent, getClientRects, getRootNode,
// compareDocumentPosition, scrollIntoView — over the in-memory DOM with the members those calls
// need (./helpers/fake-dom-extras.ts). Cases follow React's ReactDOMFragmentRefs-test.js (React
// 19.3.1, MIT, Copyright (c) Meta Platforms, Inc. and affiliates); the same cases run against real
// layout and focus in headless Chromium in tests/e2e/fragment-refs.e2e.test.ts.

import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import "./helpers/fragment-ref-runtime.ts";
import { installFakeDomExtras } from "./helpers/fake-dom-extras.ts";
import { Fragment, h } from "../src/jsx/jsx-runtime.ts";
import type { FragmentInstance } from "../src/runtime/react-extras.ts";
import { createRef } from "../src/runtime/react-core.ts";
import {
  createPortal,
  createRoot,
  flushSync,
  setDocument,
} from "../src/client/fiber/reconciler.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

installFakeDomExtras();

function mount(vnode: VNode, attach = true) {
  const { doc, container } = makeDom();
  if (attach) doc.body.appendChild(container);
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  flushSync(() => root.render(vnode as Any));
  return {
    doc: doc as Any,
    container,
    render(next: VNode | null) {
      flushSync(() => root.render(next as Any));
    },
  };
}

const frag = (props: Record<string, unknown>, ...children: unknown[]): VNode =>
  h(Fragment, props, ...(children as Any[]));

function byId(root: FakeElement, id: string): FakeElement {
  const find = (n: FakeElement): FakeElement | null => {
    if (n.getAttribute?.("id") === id) return n;
    for (const c of n.childNodes) {
      const hit = c.nodeType === 1 ? find(c as FakeElement) : null;
      if (hit) return hit;
    }
    return null;
  };
  const el = find(root);
  assert(el, `#${id}`);
  return el;
}

const P = 2, F = 4, C = 8, B = 16, D = 1, I = 32;

Deno.test("FragmentInstance.focus: the first focusable descendant, depth first; a focused one stays", () => {
  const ref = createRef<FragmentInstance>();
  const { doc, container } = mount(
    frag(
      { ref },
      h(
        "div",
        { id: "child-a" },
        h("div", { id: "grand", tabIndex: 0 }, h("a", { href: "/", id: "great" })),
      ),
      h("a", { id: "child-b", href: "/" }),
    ),
  );
  ref.current!.focus();
  assertEquals(doc.activeElement.getAttribute("id"), "grand");
  byId(container, "child-b").focus();
  ref.current!.focus();
  assertEquals(doc.activeElement.getAttribute("id"), "grand", "focus() moves to the first again");
  byId(container, "grand").focus();
  ref.current!.focus();
  assertEquals(doc.activeElement.getAttribute("id"), "grand", "an already-focused first stays");
});

Deno.test("FragmentInstance.focusLast: the last focusable descendant; text children are skipped", () => {
  const ref = createRef<FragmentInstance>();
  const { doc } = mount(
    frag(
      { ref },
      h("a", { id: "a", href: "/" }),
      h(function Wrapper() {
        return h("a", { id: "c", href: "/" });
      }, {}),
      "text",
      h("div", { id: "d" }),
    ),
  );
  ref.current!.focusLast();
  assertEquals(doc.activeElement.getAttribute("id"), "c");
  const textOnly = createRef<FragmentInstance>();
  const t = mount(frag({ ref: textOnly }, "only text"));
  textOnly.current!.focus();
  textOnly.current!.focusLast();
  assertStrictEquals(t.doc.activeElement, t.doc.body, "nothing to focus");
});

Deno.test("FragmentInstance.blur: blurs a focused child or descendant, never one outside", () => {
  const outer = createRef<FragmentInstance>();
  const inner = createRef<FragmentInstance>();
  const { doc, container } = mount(
    frag(
      { ref: outer },
      h("a", { id: "a", href: "/" }),
      h("div", null, h("input", { id: "nested" })),
      frag({ ref: inner }, h("a", { id: "b", href: "/" })),
    ),
  );
  byId(container, "a").focus();
  inner.current!.blur();
  assertEquals(doc.activeElement.getAttribute("id"), "a", "a sibling fragment leaves it");
  outer.current!.blur();
  assertStrictEquals(doc.activeElement, doc.body);
  byId(container, "nested").focus();
  outer.current!.blur();
  assertStrictEquals(doc.activeElement, doc.body, "a nested element is blurred too");
});

Deno.test("FragmentInstance.dispatchEvent: from the fragment's place — its listeners, then the parent", () => {
  const ref = createRef<FragmentInstance>();
  const log: string[] = [];
  const { container, render } = mount(
    h("div", { id: "parent" }, frag({ ref }, h("span", { id: "child" }))),
  );
  const parent = byId(container, "parent");
  parent.addEventListener("ping", (e: Any) => void log.push(`parent:${e.target?.nodeType}`));
  // No fragment listeners and a bubbling event: dispatched on the parent itself.
  assertEquals(ref.current!.dispatchEvent({ type: "ping", bubbles: true } as Any), true);
  assertEquals(log.splice(0), ["parent:1"]);
  // With a fragment listener, a temporary node stands in for the fragment, then is removed.
  ref.current!.addEventListener("ping", (e: Any) => {
    log.push(`fragment:${e.target?.nodeType}`);
    e.preventDefault();
  });
  assertEquals(ref.current!.dispatchEvent({ type: "ping", bubbles: true } as Any), false);
  assertEquals(log.splice(0), ["fragment:3", "parent:3"]);
  assertEquals(parent.childNodes.length, 1, "the stand-in node is gone");
  // Not bubbling: only the fragment's own listeners.
  ref.current!.dispatchEvent({ type: "ping", bubbles: false } as Any);
  assertEquals(log.splice(0), ["fragment:3"]);
  const handle = ref.current!;
  render(h("div", { id: "parent" }));
  assertEquals(handle.dispatchEvent({ type: "ping", bubbles: true } as Any), true);
  assertEquals(log, [], "an unmounted fragment dispatches nothing");
});

Deno.test("FragmentInstance.getClientRects: every child's rects, a text child's through a Range", () => {
  const ref = createRef<FragmentInstance>();
  mount(
    frag(
      { ref },
      h("div", { style: { width: "30px", height: "40px" } }),
      "abc",
      h("div", { style: { width: "11px", height: "12px" } }),
    ),
  );
  const rects = ref.current!.getClientRects();
  assertEquals(rects.map((r) => [r.width, r.height]), [[30, 40], [21, 0], [11, 12]]);
});

Deno.test("FragmentInstance.getRootNode: the parent's root, or itself once unmounted", () => {
  const ref = createRef<FragmentInstance>();
  const { doc, render } = mount(h("div", null, frag({ ref }, h("div", null))));
  assertStrictEquals(ref.current!.getRootNode(), doc);
  const handle = ref.current!;
  render(h("div", null));
  assertStrictEquals(handle.getRootNode(), handle);
  const detached = createRef<FragmentInstance>();
  const d = mount(frag({ ref: detached }, h("p", null)), false);
  assertStrictEquals(detached.current!.getRootNode(), d.container, "a detached tree's top node");
});

Deno.test("FragmentInstance.compareDocumentPosition: nodes before, after, around and inside it", () => {
  const ref = createRef<FragmentInstance>();
  const { doc, container } = mount(
    h(
      "div",
      { id: "container" },
      h("div", { id: "before" }),
      frag(
        { ref },
        h("div", { id: "first" }, h("i", { id: "inside" })),
        h("div", { id: "middle" }),
        "text",
        h("div", { id: "last" }),
      ),
      h("div", { id: "after" }),
    ),
  );
  const cmp = (id: string) => ref.current!.compareDocumentPosition(byId(container, id) as Any);
  assertEquals(cmp("before"), P);
  assertEquals(cmp("after"), F);
  assertEquals(cmp("first"), B);
  assertEquals(cmp("middle"), B);
  assertEquals(cmp("last"), B);
  assertEquals(cmp("inside"), B, "inside a child");
  assertEquals(cmp("container"), P | C);
  assertEquals(ref.current!.compareDocumentPosition(doc.body), P | C, "the body (no fiber)");
  const textChild = byId(container, "middle").parentNode!.childNodes[3];
  assertEquals(ref.current!.compareDocumentPosition(textChild as Any), B, "a text child");
  const loose = doc.createElement("div");
  assertEquals(ref.current!.compareDocumentPosition(loose) & D, D, "disconnected");
  // A node injected between the children by hand is not the fragment's.
  const foreign = doc.createElement("div");
  byId(container, "last").parentNode!.insertBefore(foreign, byId(container, "last"));
  assertEquals(ref.current!.compareDocumentPosition(foreign), I);
});

Deno.test("FragmentInstance.compareDocumentPosition: nodes in other branches are ordered by the tree", () => {
  const ref = createRef<FragmentInstance>();
  const { container } = mount(
    h(
      "section",
      null,
      h("div", null, h("span", { id: "early" })),
      h("div", null, frag({ ref }, h("b", { id: "one" }))),
      h("div", null, h("span", { id: "late" })),
    ),
  );
  assertEquals(ref.current!.compareDocumentPosition(byId(container, "early") as Any), P);
  assertEquals(ref.current!.compareDocumentPosition(byId(container, "late") as Any), F);
});

Deno.test("FragmentInstance.compareDocumentPosition: an empty fragment sits between its siblings", () => {
  const ref = createRef<FragmentInstance>();
  const lone = createRef<FragmentInstance>();
  const { container } = mount(
    h(
      "div",
      null,
      h("div", { id: "before-container" }),
      h(
        "div",
        { id: "container" },
        h("div", { id: "before" }),
        frag({ ref }),
        h("div", { id: "after" }),
      ),
      h("div", { id: "tail" }, h("div", { id: "only" }), frag({ ref: lone })),
    ),
  );
  const cmp = (id: string) => ref.current!.compareDocumentPosition(byId(container, id) as Any);
  assertEquals(cmp("before"), P | I);
  assertEquals(cmp("before-container"), P | I);
  assertEquals(cmp("after"), F | I);
  assertEquals(cmp("container"), C | I);
  assertEquals(lone.current!.compareDocumentPosition(byId(container, "only") as Any), P | I);
});

Deno.test("FragmentInstance.compareDocumentPosition: disconnected once unmounted; portaled children", () => {
  const ref = createRef<FragmentInstance>();
  const portalRef = createRef<FragmentInstance>();
  const { doc, container, render } = mount(h("div", { id: "c" }, frag({ ref }, h("p", null))));
  const handle = ref.current!;
  assertEquals(handle.compareDocumentPosition(byId(container, "c") as Any), P | C);
  render(h("div", { id: "c" }));
  assertEquals(handle.compareDocumentPosition(byId(container, "c") as Any), D);
  const target = doc.createElement("aside");
  doc.body.appendChild(target);
  render(
    h(
      "div",
      { id: "c" },
      frag({ ref: portalRef }, createPortal(h("p", { id: "far" }), target)),
      frag({}, createPortal(frag({ ref }), target)),
    ),
  );
  // A child portaled out of the fragment's DOM range: inside in the tree, not in the DOM.
  assertEquals(portalRef.current!.compareDocumentPosition(byId(target, "far") as Any), I);
  assertEquals(portalRef.current!.compareDocumentPosition(target), I);
  assertEquals(
    ref.current!.compareDocumentPosition(target),
    C | I,
    "empty: against the portal's target",
  );
});

Deno.test("FragmentInstance.scrollIntoView: children settle on the first (or last); options throw", () => {
  const ref = createRef<FragmentInstance>();
  const { container } = mount(frag({ ref }, h("div", { id: "a" }), h("div", { id: "b" })));
  const a = byId(container, "a") as Any;
  const b = byId(container, "b") as Any;
  const order: string[] = [];
  a.scrollIntoView = () => void order.push("a");
  b.scrollIntoView = () => void order.push("b");
  ref.current!.scrollIntoView();
  assertEquals(order.splice(0), ["b", "a"], "ends on the first");
  ref.current!.scrollIntoView(false);
  assertEquals(order.splice(0), ["a", "b"], "ends on the last");
  assertThrows(
    () => ref.current!.scrollIntoView({ block: "start" } as Any),
    Error,
    "does not support scrollIntoViewOptions",
  );
});

Deno.test("FragmentInstance.scrollIntoView: an empty fragment scrolls a sibling, else its parent", () => {
  const ref = createRef<FragmentInstance>();
  const lone = createRef<FragmentInstance>();
  const { container } = mount(
    h(
      "div",
      null,
      h("div", { id: "before" }),
      h(function Wrapper() {
        return frag({ ref });
      }, {}),
      h("div", { id: "after" }),
      h("div", { id: "parent" }, frag({ ref: lone })),
    ),
  );
  ref.current!.scrollIntoView();
  ref.current!.scrollIntoView(false);
  assertEquals((byId(container, "after") as Any).scrolls, [undefined]);
  assertEquals((byId(container, "before") as Any).scrolls, [false]);
  lone.current!.scrollIntoView();
  assertEquals((byId(container, "parent") as Any).scrolls, [undefined]);
  lone.current!.scrollIntoView(false);
  assertEquals((byId(container, "parent") as Any).scrolls, [undefined], "no sibling: nothing");
});

Deno.test("FragmentInstance.scrollIntoView: a text child scrolls the window to its Range", () => {
  const g = globalThis as Any;
  const saved = ["scrollX", "scrollY", "innerHeight", "scrollTo"].map((k) => [k, g[k]]);
  const calls: number[][] = [];
  Object.assign(g, {
    scrollX: 5,
    scrollY: 100,
    innerHeight: 50,
    scrollTo: (x: number, y: number) => calls.push([x, y]),
  });
  try {
    const ref = createRef<FragmentInstance>();
    const empty = createRef<FragmentInstance>();
    mount(h("div", null, frag({ ref }, "words"), "after", frag({ ref: empty })));
    ref.current!.scrollIntoView();
    ref.current!.scrollIntoView(false);
    empty.current!.scrollIntoView(false);
    assertEquals(calls, [[5, 100], [5, 50], [5, 50]]);
  } finally {
    for (const [k, v] of saved) v === undefined ? delete g[k] : (g[k] = v);
  }
});

Deno.test("FragmentInstance.observeUsing: a text-only fragment reports that observers skip text", () => {
  const ref = createRef<FragmentInstance>();
  mount(frag({ ref }, "just text"));
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    ref.current!.observeUsing({ observe() {}, unobserve() {} } as Any);
  } finally {
    console.error = original;
  }
  assert(errors[0]?.includes("only text children"), errors.join("\n"));
});
