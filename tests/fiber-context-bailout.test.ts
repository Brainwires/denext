// Context-aware memo bailout: when a provider's value changes, denext re-renders only
// the components that actually READ that context (React semantics) — not every descendant
// under the provider. Previously the bailout compared the whole inherited-context Map by
// identity, so any provider re-render cascaded a fresh Map to the entire subtree and no
// descendant could bail — which let one context/store update storm a large tree. The fix
// tracks each fiber's read-context set and propagates a changed context straight to its
// consumers (so a consumer behind a bailed non-consumer is neither stranded nor stale).

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useContext, useState } from "../src/runtime/hooks.ts";
import { createContext } from "../src/runtime/context.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

Deno.test("a changed provider re-renders only its consumers; non-consumers bail", () => {
  const Outer = createContext(0);
  const Inner = createContext("i0");
  let consumerRenders = 0, nonConsumerRenders = 0, innerConsumerRenders = 0;
  let consumerValue = -1, innerValue = "";

  const Consumer = (): VNode => {
    consumerRenders++;
    consumerValue = useContext(Outer);
    return h("i", null);
  };
  const NonConsumer = (): VNode => {
    nonConsumerRenders++; // reads no context
    return h("b", null);
  };
  const InnerConsumer = (): VNode => {
    innerConsumerRenders++;
    innerValue = useContext(Inner);
    return h("u", null);
  };

  let setOuter: ((n: number) => void) | null = null;
  function App(): VNode {
    const [o, so] = useState(0);
    setOuter = so;
    return h(
      Outer.Provider,
      { value: o },
      h(NonConsumer, null),
      h(Consumer, null),
      // Inner provider value is constant; its consumer must bail despite the Outer cascade.
      h(Inner.Provider, { value: "i0" }, h(InnerConsumer, null)),
    );
  }

  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(h(App, null));
  flushSync();
  const base = { c: consumerRenders, n: nonConsumerRenders, i: innerConsumerRenders };

  setOuter!(1);
  flushSync();

  assertEquals(consumerRenders - base.c, 1, "Outer consumer re-renders");
  assertEquals(consumerValue, 1, "consumer sees the new value (not stale)");
  assertEquals(nonConsumerRenders - base.n, 0, "non-consumer bails");
  assertEquals(innerConsumerRenders - base.i, 0, "consumer of an unchanged inner context bails");
  assertEquals(innerValue, "i0", "inner consumer value intact");
});

Deno.test("a context change reaches a deep consumer past a bailed non-consumer (not stale)", () => {
  const Ctx = createContext(0);
  let leafRenders = 0, midRenders = 0, seen = -1;

  const Leaf = (): VNode => {
    leafRenders++;
    seen = useContext(Ctx);
    return h("i", null);
  };
  const Mid = (): VNode => {
    midRenders++; // does NOT read Ctx
    return h("div", null, h(Leaf, null));
  };

  let setV: ((n: number) => void) | null = null;
  function App(): VNode {
    const [v, s] = useState(5);
    setV = s;
    return h(Ctx.Provider, { value: v }, h(Mid, null));
  }

  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(h(App, null));
  flushSync();
  const midBase = midRenders, leafBase = leafRenders;

  setV!(9);
  flushSync();

  assertEquals(seen, 9, "deep consumer read the new value");
  assertEquals(leafRenders - leafBase, 1, "deep consumer re-rendered");
  assertEquals(midRenders - midBase, 0, "the non-consumer middle bailed");
});

Deno.test("a stable provider value does not re-render its subtree", () => {
  const Ctx = createContext("const");
  let consumerRenders = 0;
  const Consumer = (): VNode => {
    consumerRenders++;
    return h("i", null, useContext(Ctx));
  };
  let bump: ((n: number) => void) | null = null;
  function App(): VNode {
    const [n, s] = useState(0);
    bump = s;
    // Provider value is constant; only unrelated App state changes.
    return h(
      "div",
      { "data-n": String(n) },
      h(Ctx.Provider, { value: "const" }, h(Consumer, null)),
    );
  }
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(h(App, null));
  flushSync();
  const base = consumerRenders;
  bump!(1);
  flushSync();
  assertEquals(
    consumerRenders - base,
    0,
    "consumer of an unchanged context bails on unrelated updates",
  );
});
