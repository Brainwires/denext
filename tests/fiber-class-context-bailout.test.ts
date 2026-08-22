// The context-aware memo bailout (a provider value change re-renders only the consumers
// that read that context, letting a non-consumer memoized ancestor bail its subtree)
// must treat a legacy `static contextType` class as a consumer. A class reads context via
// `this.context` (resolved from the instance's context map), not the `useContext`
// dispatcher, so it was invisible to propagateContextChange/propsAndContextEqual — and a
// provider value change was silently dropped when a memoized non-consumer ancestor sat
// between the provider and the class. Regression for that.

import { assertEquals } from "@std/assert";
import { Component, createContext, memo } from "../src/compat/react.ts";
import { useState } from "../mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("class contextType consumer behind a memoized ancestor updates on context change", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const Ctx = createContext("c0");
  let classRenders = 0;
  class C extends Component {
    override render() {
      classRenders++;
      return h("i", { "data-v": String(this.context) });
    }
  }
  (C as Any).contextType = Ctx;
  // A memoized intermediate that reads NO context — it bails its subtree on a re-render
  // where its props are unchanged, so only lane-marked descendants reconcile.
  const Intermediate = memo(() => h(C as unknown as (p: unknown) => VNode, null));

  let setV: (v: string) => void = () => {};
  function App(): VNode {
    const [v, set] = useState("c0");
    setV = (x) => set(() => x);
    return h(Ctx.Provider as Any, { value: v }, h(Intermediate as Any, null));
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();
  assertEquals(container.innerHTML, `<i data-v="c0"></i>`);

  setV("c1");
  flushSync();
  assertEquals(
    container.innerHTML,
    `<i data-v="c1"></i>`,
    `class contextType consumer went stale (renders=${classRenders})`,
  );
});
