// React 19.3's Fragment refs: `<Fragment ref={r}>` puts a `FragmentInstance` in `r.current`,
// set and cleared at commit like any ref, whose listeners / observers follow the fragment's host
// children as they mount and unmount. Cases ported from React's ReactDOMFragmentRefs-test.js
// (React 19.3.1, MIT, Copyright (c) Meta Platforms, Inc. and affiliates) where the in-memory DOM
// can carry them; the layout, focus and document-position cases run in a real browser
// (tests/e2e/fragment-refs.e2e.test.ts). The runtime is loaded on first use — the gate itself is
// covered by tests/fragment-refs-load.test.ts — so these tests install it up front.

import { assert, assertEquals, assertStrictEquals, assertStringIncludes } from "@std/assert";
import "./helpers/fragment-ref-runtime.ts";
import "./helpers/activity-runtime.ts";
import { Fragment, h } from "../src/jsx/jsx-runtime.ts";
import { Activity, type FragmentInstance } from "../src/runtime/react-extras.ts";
import { createRef } from "../src/runtime/react-core.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "../src/runtime/hooks.ts";
import { renderToStringSync } from "../src/jsx/render-to-string.ts";
import {
  createPortal,
  createRoot,
  flushSync,
  hydrateRoot,
  setDocument,
} from "../src/client/fiber/reconciler.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import type { FragmentProps, VNode } from "../src/jsx/types.ts";
import { HiddenBit, HoistedBit, OffscreenBit } from "../src/client/fiber/fiber.ts";
import { HIDDEN_BIT, HOISTED_BIT, OFFSCREEN_BIT } from "../src/client/fiber/fragment-instance.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** A fresh document + mounted root; `render` commits synchronously. */
function mount() {
  const { doc, container } = makeDom();
  doc.body.appendChild(container);
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  return {
    doc,
    container,
    render(vnode: VNode | null) {
      flushSync(() => root.render(vnode as Any));
    },
  };
}

const frag = (props: Record<string, unknown>, ...children: unknown[]): VNode =>
  h(Fragment as Any, props, ...(children as Any[]));

/** The listeners `el` carries for `type` in the bubble (or capture) phase. */
function listenersOf(el: FakeElement, type: string, capture = false): Set<unknown> {
  return (capture ? el.captureListeners : el.listeners).get(type) ?? new Set();
}

function byId(container: FakeElement, id: string): FakeElement {
  const find = (n: FakeElement): FakeElement | null => {
    if (n.getAttribute("id") === id) return n;
    for (const c of n.childNodes) {
      if ((c as FakeElement).nodeType !== 1) continue;
      const hit = find(c as FakeElement);
      if (hit) return hit;
    }
    return null;
  };
  const el = find(container);
  assert(el, `#${id} is rendered`);
  return el;
}

/** A recording IntersectionObserver / ResizeObserver stand-in. */
function fakeObserver(kind: "intersection" | "resize") {
  const observed = new Set<unknown>();
  const log: string[] = [];
  const observer = {
    ...(kind === "intersection" ? { rootMargin: "0px" } : {}),
    observe(el: FakeElement) {
      observed.add(el);
      log.push(`observe ${el.getAttribute("id")}`);
    },
    unobserve(el: FakeElement) {
      observed.delete(el);
      log.push(`unobserve ${el.getAttribute("id")}`);
    },
  };
  return { observer: observer as unknown as IntersectionObserver, observed, log };
}

Deno.test("Fragment ref: the runtime's fiber bits match fiber.ts (it imports no shared module)", () => {
  assertEquals([HIDDEN_BIT, HOISTED_BIT, OFFSCREEN_BIT], [HiddenBit, HoistedBit, OffscreenBit]);
});

Deno.test("Fragment ref: `Fragment` is typed as a component taking React's FragmentProps", () => {
  // `<Fragment key ref>` type-checks as a JSX tag: `Fragment` is callable for TypeScript.
  const props: Parameters<typeof Fragment>[0] = { ref: createRef<FragmentInstance>() };
  const viaCallback: FragmentProps = { ref: (i: FragmentInstance | null) => void i };
  // @ts-expect-error a ref for another instance type is rejected
  const wrong: FragmentProps = { ref: createRef<HTMLDivElement>() };
  assert(props.ref && viaCallback.ref && wrong);
  assertStrictEquals(Fragment as unknown, Symbol.for("denext.fragment"), "the runtime marker");
});

Deno.test("Fragment ref: attaches a FragmentInstance, with no wrapper element in the DOM", () => {
  const { container, render } = mount();
  const ref = createRef<FragmentInstance>();
  render(h("div", { id: "parent" }, frag({ ref }, h("div", { id: "child" }, "Hi"))));
  assertEquals(container.innerHTML, '<div id="parent"><div id="child">Hi</div></div>');
  assert(ref.current !== null, "the ref holds the fragment's instance");
  assert(typeof ref.current.addEventListener === "function");
  assert((ref.current as Any)._fragmentFiber, "the instance points at its fiber");
  render(null);
  assertEquals(ref.current, null, "unmount clears an object ref");
});

Deno.test("Fragment ref: a component returning a ref'd Fragment keeps the Fragment (not unwrapped)", () => {
  const { render } = mount();
  const ref = createRef<FragmentInstance>();
  const List = () => frag({ ref }, h("li", { id: "a" }), h("li", { id: "b" }));
  render(h("ul", null, h(List, {})));
  assert(ref.current !== null);
});

Deno.test("Fragment ref: is available in layout and passive effects", async () => {
  const { render } = mount();
  const seen: string[] = [];
  function Test() {
    const ref = useRef<FragmentInstance | null>(null);
    useLayoutEffect(() => void seen.push(`layout:${ref.current !== null}`));
    useEffect(() => void seen.push(`passive:${ref.current !== null}`));
    return frag({ ref }, h("div", null));
  }
  render(h(Test, {}));
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(seen, ["layout:true", "passive:true"]);
});

Deno.test("Fragment ref: runs the cleanup when an inline ref callback changes identity", () => {
  const { render } = mount();
  const log: string[] = [];
  const instances: unknown[] = [];
  let rerender = () => {};
  function Test() {
    const [step, setStep] = useState(0);
    rerender = () => setStep((p) => p + 1);
    return frag(
      {
        ref: (inst: unknown) => {
          instances.push(inst);
          log.push(`fragment attach ${step}`);
          return () => log.push(`fragment cleanup ${step}`);
        },
      },
      h("div", { id: "child" }),
    );
  }
  render(h(Test, {}));
  assertEquals(log.splice(0), ["fragment attach 0"]);
  flushSync(() => rerender());
  assertEquals(log.splice(0), ["fragment cleanup 0", "fragment attach 1"]);
  render(null);
  assertEquals(log.splice(0), ["fragment cleanup 1"]);
  // The same instance is handed to every attach.
  assertEquals(instances.length, 2);
  assertStrictEquals(instances[0], instances[1]);
});

Deno.test("Fragment ref: removing the ref from a mounted Fragment runs its cleanup", () => {
  const { render } = mount();
  const log: string[] = [];
  const attach = () => {
    log.push("attach");
    return () => log.push("cleanup");
  };
  const Test = ({ withRef }: { withRef: boolean }) =>
    frag({ ref: withRef ? attach : null }, h("div", { id: "child" }));
  render(h(Test, { withRef: true }));
  assertEquals(log.splice(0), ["attach"]);
  render(h(Test, { withRef: false }));
  assertEquals(log.splice(0), ["cleanup"]);
  render(null);
  assertEquals(log.splice(0), [], "nothing is left to clean up when the Fragment is deleted");
});

Deno.test("Fragment ref: a callback ref without a cleanup is called with null on unmount", () => {
  const { render } = mount();
  const calls: unknown[] = [];
  render(frag({ ref: (i: unknown) => void calls.push(i) }, h("div", null)));
  render(null);
  assertEquals(calls.length, 2);
  assert(calls[0] !== null);
  assertEquals(calls[1], null);
});

Deno.test("Fragment ref: attaches fragment handles to its children (nested fragments)", () => {
  const { container, render } = mount();
  const outer = createRef<FragmentInstance>();
  const inner = createRef<FragmentInstance>();
  const Test = ({ show }: { show: boolean }) =>
    frag(
      { ref: outer },
      frag({ ref: inner }, h("div", { id: "childA" }), h("div", { id: "childB" })),
      h("div", { id: "childC" }),
      show && h("div", { id: "childD" }),
    );
  render(h(Test, { show: false }));
  const handles = (id: string) => (byId(container, id) as Any).reactFragments as Set<unknown>;
  assert(handles("childA").has(inner.current));
  assert(handles("childB").has(inner.current));
  assert(!handles("childC").has(inner.current));
  assert(handles("childA").has(outer.current));
  assert(handles("childC").has(outer.current));
  render(h(Test, { show: true }));
  assert(!handles("childD").has(inner.current));
  assert(handles("childD").has(outer.current));
});

Deno.test("Fragment ref: adds and removes event listeners on its children, not deeper", () => {
  const { container, render } = mount();
  const ref = createRef<FragmentInstance>();
  render(
    h(
      "div",
      { id: "parent" },
      frag(
        { ref },
        h("div", { id: "childA" }, h("span", { id: "grandchild" })),
        h(function Wrapper() {
          return h("div", { id: "childB" });
        }, {}),
      ),
    ),
  );
  const onClick = () => {};
  ref.current!.addEventListener("click", onClick);
  assert(listenersOf(byId(container, "childA"), "click").has(onClick));
  assert(listenersOf(byId(container, "childB"), "click").has(onClick), "through a component");
  assert(!listenersOf(byId(container, "grandchild"), "click").has(onClick), "not inside a host");
  assert(!listenersOf(byId(container, "parent"), "click").has(onClick), "not on the parent");
  ref.current!.removeEventListener("click", onClick);
  assert(!listenersOf(byId(container, "childA"), "click").has(onClick));
  assert(!listenersOf(byId(container, "childB"), "click").has(onClick));
});

Deno.test("Fragment ref: listeners follow children as they mount and unmount", () => {
  const { container, render } = mount();
  const ref = createRef<FragmentInstance>();
  const Test = ({ ids }: { ids: string[] }) =>
    frag({ ref }, ...ids.map((id) => h("div", { id, key: id })));
  render(h(Test, { ids: ["a"] }));
  const onKey = () => {};
  ref.current!.addEventListener("keydown", onKey, { capture: true });
  const a = byId(container, "a");
  assert(listenersOf(a, "keydown", true).has(onKey));
  render(h(Test, { ids: ["a", "b"] }));
  assert(listenersOf(byId(container, "b"), "keydown", true).has(onKey), "a new child gets it");
  render(h(Test, { ids: ["b"] }));
  assert(!listenersOf(a, "keydown", true).has(onKey), "a removed child loses it");
  ref.current!.removeEventListener("keydown", onKey, true);
  render(h(Test, { ids: ["b", "c"] }));
  assert(
    !listenersOf(byId(container, "c"), "keydown", true).has(onKey),
    "a removed listener is not re-applied",
  );
});

Deno.test("Fragment ref: matches listeners by type, listener and capture flag", () => {
  const { container, render } = mount();
  const ref = createRef<FragmentInstance>();
  render(frag({ ref }, h("div", { id: "a" })));
  const a = byId(container, "a");
  const fn = () => {};
  ref.current!.addEventListener("click", fn, true);
  ref.current!.addEventListener("click", fn, { capture: true, passive: true }); // the same one
  ref.current!.removeEventListener("click", fn); // a bubble listener: not registered
  assert(listenersOf(a, "click", true).has(fn), "removing an unregistered one leaves it");
  ref.current!.removeEventListener("click", fn, { capture: true });
  assertEquals(listenersOf(a, "click", true).size, 0);
});

Deno.test("Fragment ref: a once listener fires once across the children", () => {
  const { container, render } = mount();
  const ref = createRef<FragmentInstance>();
  render(frag({ ref }, h("div", { id: "a" }), h("div", { id: "b" })));
  let calls = 0;
  ref.current!.addEventListener("custom", () => void calls++, { once: true });
  byId(container, "a").dispatch("custom");
  byId(container, "b").dispatch("custom");
  assertEquals(calls, 1);
});

Deno.test("Fragment ref: an aborted signal removes the listener (and one aborted up front never adds)", () => {
  const { container, render } = mount();
  const ref = createRef<FragmentInstance>();
  render(frag({ ref }, h("div", { id: "a" })));
  const a = byId(container, "a");
  const before = new AbortController();
  before.abort();
  ref.current!.addEventListener("click", () => {}, { signal: before.signal });
  assertEquals(listenersOf(a, "click").size, 0);
  const ac = new AbortController();
  ref.current!.addEventListener("click", () => {}, { signal: ac.signal });
  assertEquals(listenersOf(a, "click").size, 1);
  ac.abort();
  assertEquals(listenersOf(a, "click").size, 0);
});

Deno.test("Fragment ref: listeners and the ref skip a hidden <Activity>, and return on reveal", () => {
  const { container, render } = mount();
  const ref = createRef<FragmentInstance>();
  const inner = createRef<FragmentInstance>();
  const Test = ({ mode }: { mode: "visible" | "hidden" }) =>
    frag(
      { ref },
      h("div", { id: "shown" }),
      h(Activity, { mode, children: frag({ ref: inner }, h("div", { id: "hideable" })) }),
    );
  render(h(Test, { mode: "visible" }));
  const fn = () => {};
  ref.current!.addEventListener("click", fn);
  assert(listenersOf(byId(container, "hideable"), "click").has(fn));
  assert(inner.current !== null);
  render(h(Test, { mode: "hidden" }));
  assert(!listenersOf(byId(container, "hideable"), "click").has(fn), "hidden: released");
  assertEquals(inner.current, null, "a Fragment inside the hidden tree detaches its ref");
  render(h(Test, { mode: "visible" }));
  assert(listenersOf(byId(container, "hideable"), "click").has(fn), "revealed: applied again");
  assert(inner.current !== null, "and reattaches it");
});

Deno.test("Fragment ref: observers follow the children; an IntersectionObserver lets go after paint", async () => {
  const { render } = mount();
  const ref = createRef<FragmentInstance>();
  const Test = ({ ids }: { ids: string[] }) =>
    frag({ ref }, ...ids.map((id) => h("div", { id, key: id })));
  render(h(Test, { ids: ["a", "b"] }));
  const io = fakeObserver("intersection");
  const ro = fakeObserver("resize");
  ref.current!.observeUsing(io.observer);
  ref.current!.observeUsing(ro.observer as Any);
  assertEquals(io.log.splice(0), ["observe a", "observe b"]);
  assertEquals(ro.log.splice(0), ["observe a", "observe b"]);
  render(h(Test, { ids: ["b", "c"] }));
  assertEquals(ro.log.splice(0), ["unobserve a", "observe c"], "a ResizeObserver lets go now");
  assertEquals(
    io.log.splice(0),
    ["observe c"],
    "an IntersectionObserver waits for the exit record",
  );
  await new Promise((r) => setTimeout(r, 100));
  assertEquals(io.log.splice(0), ["unobserve a"], "…and lets go after the next paint");
  ref.current!.unobserveUsing(io.observer);
  assertEquals(io.log.splice(0), ["unobserve b", "unobserve c"]);
});

Deno.test("Fragment ref: unobserveUsing with an unknown observer reports it", () => {
  const { render } = mount();
  const ref = createRef<FragmentInstance>();
  render(frag({ ref }, h("div", { id: "a" })));
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    ref.current!.unobserveUsing(fakeObserver("resize").observer as Any);
  } finally {
    console.error = original;
  }
  assertStringIncludes(errors[0] ?? "", "First attach the observer with observeUsing()");
});

Deno.test("Fragment ref: deleting the Fragment releases its children and detaches first", () => {
  const { container, render } = mount();
  const ref = createRef<FragmentInstance>();
  const log: string[] = [];
  render(
    frag(
      {
        ref: (i: FragmentInstance) => {
          ref.current = i;
          log.push("fragment attach");
          return () => log.push("fragment cleanup");
        },
      },
      h("div", {
        id: "a",
        ref: () => {
          log.push("host attach");
          return () => log.push("host cleanup");
        },
      }),
    ),
  );
  const a = byId(container, "a");
  const io = fakeObserver("resize");
  ref.current!.observeUsing(io.observer as Any);
  const fn = () => {};
  ref.current!.addEventListener("click", fn);
  log.length = 0;
  render(null);
  assertEquals(
    log,
    ["fragment cleanup", "host cleanup"],
    "the Fragment detaches ahead of its children",
  );
  assert(!listenersOf(a, "click").has(fn));
  assertEquals(io.log.at(-1), "unobserve a");
  assertStrictEquals(
    ref.current!.getRootNode(),
    ref.current,
    "an unmounted instance is its own root",
  );
});

Deno.test("Fragment ref: works inside a portal", () => {
  const { doc, container, render } = mount();
  const target = doc.createElement("section");
  doc.body.appendChild(target);
  const ref = createRef<FragmentInstance>();
  render(h("div", null, frag({ ref }, createPortal(h("p", { id: "portaled" }), target as Any))));
  const fn = () => {};
  ref.current!.addEventListener("click", fn);
  const p = target.childNodes[0] as FakeElement;
  assert(listenersOf(p, "click").has(fn), "a portaled child is the fragment's child");
  assertEquals(container.innerHTML, "<div></div>");
});

Deno.test("Fragment ref: server rendering ignores the ref", () => {
  const withRef = renderToStringSync(
    h("div", null, frag({ ref: createRef() }, h("span", null, "a"), h("span", null, "b"))),
  );
  const without = renderToStringSync(
    h("div", null, frag({}, h("span", null, "a"), h("span", null, "b"))),
  );
  assertEquals(withRef, without);
  assertEquals(withRef, "<div><span>a</span><span>b</span></div>");
});

Deno.test("Fragment ref: hydration attaches the ref to the server's nodes", () => {
  const { doc, container } = makeDom();
  doc.body.appendChild(container);
  setDocument(doc as Any);
  container.innerHTML = '<div id="parent"><span id="a">a</span><span id="b">b</span></div>';
  const serverA = byId(container, "a");
  const ref = createRef<FragmentInstance>();
  flushSync(() => {
    hydrateRoot(
      container as Any,
      h(
        "div",
        { id: "parent" },
        frag({ ref }, h("span", { id: "a" }, "a"), h("span", { id: "b" }, "b")),
      ),
    );
  });
  assert(ref.current !== null, "the ref is attached once hydration commits");
  assertStrictEquals(byId(container, "a"), serverA, "the server's node was adopted");
  const fn = () => {};
  ref.current.addEventListener("click", fn);
  assert(listenersOf(serverA, "click").has(fn));
});
