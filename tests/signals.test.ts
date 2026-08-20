// Signals: useSignal / useStore reactive state, driven through a real reconciler
// mount over the in-memory DOM shim.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { type Signal, useSignal, useStore } from "../src/runtime/signals.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function makeDomEnv() {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  return { doc, container };
}

Deno.test("useSignal re-renders the owner when its value changes", () => {
  const { doc, container } = makeDomEnv();
  let sig!: Signal<number>;
  function Counter() {
    sig = useSignal(0);
    return h("button", { onClick: () => (sig.value += 1) }, `count:${sig.value}`);
  }
  const root = createRoot(container as Any);
  root.render(h(Counter as Any, null));
  flushSync();

  const button = container.childNodes[0] as Any;
  assertEquals(button.textContent, "count:0");
  button.dispatch("click");
  flushSync();
  assertEquals(button.textContent, "count:1");
  void doc;
});

Deno.test("the Signal object is stable across renders", () => {
  const { container } = makeDomEnv();
  const seen: Array<Signal<number>> = [];
  function C() {
    const s = useSignal(0);
    seen.push(s);
    return h("button", { onClick: () => (s.value += 1) }, String(s.value));
  }
  const root = createRoot(container as Any);
  root.render(h(C as Any, null));
  flushSync();
  (container.childNodes[0] as Any).dispatch("click");
  flushSync();
  assert(seen.length >= 2, "expected at least two renders");
  assert(seen[0] === seen[1], "the Signal identity must be stable across renders");
});

Deno.test("assigning the same value does not re-render", () => {
  const { container } = makeDomEnv();
  let renders = 0;
  let sig!: Signal<number>;
  function C() {
    renders++;
    sig = useSignal(5);
    return h("button", { onClick: () => (sig.value = 5) }, String(sig.value));
  }
  const root = createRoot(container as Any);
  root.render(h(C as Any, null));
  flushSync();
  const before = renders;
  (container.childNodes[0] as Any).dispatch("click");
  flushSync();
  assertEquals(renders, before, "an idempotent assignment must not re-render");
});

Deno.test("useStore re-renders on a top-level property write", () => {
  const { container } = makeDomEnv();
  let store!: { n: number };
  function C() {
    store = useStore({ n: 0 });
    return h("button", { onClick: () => store.n++ }, `n:${store.n}`);
  }
  const root = createRoot(container as Any);
  root.render(h(C as Any, null));
  flushSync();
  const button = container.childNodes[0] as Any;
  assertEquals(button.textContent, "n:0");
  button.dispatch("click");
  flushSync();
  assertEquals(button.textContent, "n:1");
});

Deno.test("peek reads the value", () => {
  const { container } = makeDomEnv();
  let sig!: Signal<string>;
  function C() {
    sig = useSignal("hi");
    return h("span", null, sig.peek());
  }
  const root = createRoot(container as Any);
  root.render(h(C as Any, null));
  flushSync();
  assertEquals(sig.peek(), "hi");
});
