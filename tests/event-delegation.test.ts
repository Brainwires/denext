// Root event delegation (React 17+): bubbling handlers are dispatched from the root container
// (and each portal target), never registered on the element; propagation, capture order,
// portals, focus, enter/leave and error routing follow React.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createPortal, createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { ErrorBoundary } from "../src/runtime/error-boundary.ts";
import { useState } from "../src/runtime/hooks.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function mount(vnode: VNode): { container: FakeElement; doc: Any; root: Any } {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(vnode);
  flushSync();
  return { container, doc, root };
}

const el = (container: FakeElement, ...path: number[]): FakeElement => {
  let n: Any = container;
  for (const i of path) n = n.childNodes[i];
  return n;
};

Deno.test("a handler registers nothing on its element; the root dispatches it", () => {
  let clicks = 0;
  const { container } = mount(h("button", { onClick: () => clicks++ }, "x") as VNode);
  const button = el(container, 0);
  assertEquals(button.listeners.size + button.captureListeners.size, 0);
  assert(container.listeners.has("click") && container.captureListeners.has("click"));
  button.dispatch("click");
  assertEquals(clicks, 1);
});

Deno.test("capture runs root → target, then bubble target → root", () => {
  const order: string[] = [];
  const log = (s: string) => () => order.push(s);
  const { container } = mount(
    h(
      "div",
      { onClick: log("outer bubble"), onClickCapture: log("outer capture") },
      h("button", { onClick: log("inner bubble"), onClickCapture: log("inner capture") }, "x"),
    ) as VNode,
  );
  el(container, 0, 0).dispatch("click");
  assertEquals(order, ["outer capture", "inner capture", "inner bubble", "outer bubble"]);
});

Deno.test("stopPropagation stops the bubble at the element that called it", () => {
  const order: string[] = [];
  const { container } = mount(
    h(
      "div",
      { onClick: () => order.push("outer") },
      h("span", {
        onClick: (e: Event) => {
          order.push("middle");
          e.stopPropagation();
        },
      }, h("button", { onClick: () => order.push("inner") }, "x")),
    ) as VNode,
  );
  el(container, 0, 0, 0).dispatch("click");
  assertEquals(order, ["inner", "middle"]);
});

Deno.test("a capture handler's stopPropagation keeps the event from the target", () => {
  const order: string[] = [];
  const { container } = mount(
    h("div", {
      onClickCapture: (e: Event) => {
        order.push("outer capture");
        e.stopPropagation();
      },
    }, h("button", { onClick: () => order.push("inner") }, "x")) as VNode,
  );
  el(container, 0, 0).dispatch("click");
  assertEquals(order, ["outer capture"]);
});

Deno.test("currentTarget is the handler's element during the call, the native one after", () => {
  const seen: unknown[] = [];
  let ev: Any = null;
  const { container } = mount(
    h(
      "div",
      { onClick: (e: Event) => seen.push(e.currentTarget) },
      h("button", {
        onClick: (e: Event) => {
          ev = e;
          seen.push(e.currentTarget);
        },
      }, "x"),
    ) as VNode,
  );
  const button = el(container, 0, 0);
  button.dispatch("click");
  assertEquals(seen, [button, el(container, 0)]);
  assertEquals(ev.currentTarget, container, "restored to the listener's own target");
});

Deno.test("an event in a portal bubbles to the components that rendered it", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const target = doc.createElement("div");
  const order: string[] = [];
  createRoot(container as Any).render(
    h(
      "section",
      { onClick: () => order.push("section") },
      createPortal(
        h("button", { onClick: () => order.push("button") }, "x") as Any,
        target as Any,
      ) as Any,
    ),
  );
  flushSync();
  assert(target.listeners.has("click"), "the portal target listens");
  el(target, 0).dispatch("click");
  assertEquals(order, ["button", "section"]);
});

Deno.test("a portal inside the root's own DOM is dispatched once, by its target", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const slot = doc.createElement("div");
  container.appendChild(slot);
  let clicks = 0;
  createRoot(container as Any).render(
    createPortal(h("button", { onClick: () => clicks++ }, "x") as Any, slot as Any) as Any,
  );
  flushSync();
  el(slot, 0).dispatch("click");
  assertEquals(clicks, 1);
});

Deno.test("onFocus / onBlur listen to the bubbling focusin / focusout (React 17+)", () => {
  const seen: string[] = [];
  const { container } = mount(
    h(
      "form",
      {
        onFocus: (e: Event) => seen.push(`form ${e.type}`),
        onBlur: (e: Event) => seen.push(`form ${e.type}`),
      },
      h("input", { onFocus: (e: Event) => seen.push(`input ${e.type}`) }),
    ) as VNode,
  );
  const input = el(container, 0, 0);
  input.dispatch("focus"); // the non-bubbling event: no handler
  assertEquals(seen, []);
  input.dispatch("focusin");
  input.dispatch("focusout");
  assertEquals(seen, ["input focus", "form focus", "form blur"], "type reads focus / blur");
});

Deno.test("enter/leave fire for the elements entered and left, derived from over/out", () => {
  const seen: string[] = [];
  const on = (name: string) => ({
    onMouseEnter: (e: Any) => seen.push(`enter ${name} ${e.type}`),
    onMouseLeave: (e: Any) => seen.push(`leave ${name} ${e.type}`),
  });
  const { container } = mount(
    h(
      "div",
      on("outer"),
      h("p", on("a"), h("span", on("a-inner"), "a")),
      h("p", on("b"), "b"),
    ) as VNode,
  );
  const outer = el(container, 0);
  const aInner = el(container, 0, 0, 0);
  const b = el(container, 0, 1);
  // From outside the document into a-inner: enter outermost first.
  aInner.dispatch("mouseover", { relatedTarget: null });
  assertEquals(seen.splice(0), [
    "enter outer mouseenter",
    "enter a mouseenter",
    "enter a-inner mouseenter",
  ]);
  // a-inner → b: leave innermost first up to the shared <div>, then enter b. The over that
  // follows the out is ignored (its related element is rendered here).
  aInner.dispatch("mouseout", { relatedTarget: b });
  b.dispatch("mouseover", { relatedTarget: aInner });
  assertEquals(seen.splice(0), [
    "leave a-inner mouseleave",
    "leave a mouseleave",
    "enter b mouseenter",
  ]);
  // Out of the document.
  b.dispatch("mouseout", { relatedTarget: null });
  assertEquals(seen.splice(0), ["leave b mouseleave", "leave outer mouseleave"]);
  assertEquals(outer.listeners.has("mouseenter"), false, "nothing on the elements");
});

Deno.test("enter/leave events carry target, relatedTarget and the pointer fields", () => {
  let got: Any = null;
  const { container } = mount(
    h(
      "div",
      null,
      h("button", { onPointerEnter: (e: Any) => got = e }, "x"),
      h("i", null),
    ) as VNode,
  );
  const button = el(container, 0, 0);
  const other = el(container, 0, 1);
  button.dispatch("pointerover", { relatedTarget: other, clientX: 3, pointerType: "mouse" });
  assertEquals(got, null, "an over from a rendered element waits for its out");
  other.dispatch("pointerout", { relatedTarget: button, clientX: 3, pointerType: "mouse" });
  assertEquals(got.type, "pointerenter");
  assertEquals(got.target, button);
  assertEquals(got.relatedTarget, other);
  assertEquals(got.clientX, 3);
  assertEquals(got.pointerType, "mouse");
  assertEquals(got.isPropagationStopped(), false);
});

Deno.test("a non-bubbling event (scroll, load) keeps its own element listener", () => {
  let scrolled = 0;
  const { container } = mount(h("div", { onScroll: () => scrolled++ }, "x") as VNode);
  const div = el(container, 0);
  assert(div.listeners.has("scroll"));
  div.dispatch("scroll");
  assertEquals(scrolled, 1);
});

Deno.test("a changed handler is read from the committed props, without re-registering", () => {
  const seen: number[] = [];
  let set: (n: number) => void = () => {};
  function App(): VNode {
    const [n, setN] = useState(1);
    set = setN;
    return h("button", { onClick: () => seen.push(n) }, "x") as VNode;
  }
  const { container } = mount(h(App, null) as VNode);
  const button = el(container, 0);
  button.dispatch("click");
  set(2);
  flushSync();
  button.dispatch("click");
  set(3);
  flushSync();
  button.dispatch("click");
  assertEquals(seen, [1, 2, 3]);
  assertEquals(button.listeners.size, 0);
});

Deno.test("a removed handler no longer fires", () => {
  let clicks = 0;
  let set: (on: boolean) => void = () => {};
  function App(): VNode {
    const [on, setOn] = useState(true);
    set = setOn;
    return h("button", on ? { onClick: () => clicks++ } : {}, "x") as VNode;
  }
  const { container } = mount(h(App, null) as VNode);
  const button = el(container, 0);
  set(false);
  flushSync();
  button.dispatch("click");
  assertEquals(clicks, 0);
});

Deno.test("a throwing handler reaches its error boundary; the rest of the path still runs", () => {
  let outer = 0;
  function Boom(): VNode {
    return h("button", {
      onClick: () => {
        throw new Error("click boom");
      },
    }, "x") as VNode;
  }
  const { container } = mount(
    h(
      "div",
      { onClick: () => outer++ },
      h(ErrorBoundary, {
        fallback: (p: { error: Error }) => h("p", null, `caught ${p.error.message}`),
        children: h(Boom, null),
      }),
    ) as VNode,
  );
  el(container, 0, 0).dispatch("click");
  flushSync();
  assertEquals(outer, 1);
  assertEquals(container.innerHTML, "<div><p>caught click boom</p></div>");
});

Deno.test("a nested root's events reach the outer root's handlers after its own", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const order: string[] = [];
  createRoot(container as Any).render(
    h("main", { onClick: () => order.push("outer main") }, h("div", { id: "island" })),
  );
  flushSync();
  const islandHost = el(container, 0, 0);
  createRoot(islandHost as Any).render(h("button", { onClick: () => order.push("inner") }, "x"));
  flushSync();
  el(islandHost, 0).dispatch("click");
  assertEquals(order, ["inner", "outer main"]);
});
