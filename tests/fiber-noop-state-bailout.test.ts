// React's state bailout: a re-render scheduled only by state setters whose values ended up
// unchanged is skipped. radix's DismissableLayer recreates its callback ref every render;
// each commit detaches/attaches it (`setNode(null)`, `setNode(node)`), so without the bailout
// every commit schedules the next — shadcn/ui's ⌘K dialog threw "Maximum update depth
// exceeded" on close. A setter that DOES change state still re-renders.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useEffect, useState } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

Deno.test("a callback ref recreated every render does not loop (no-op state updates bail out)", () => {
  let renders = 0;
  let effects = 0;
  function Layer(): VNode {
    renders++;
    const [node, setNode] = useState<unknown>(null);
    useEffect(() => {
      effects++;
    }, [node]);
    // New function every render — the DismissableLayer shape.
    return h("div", { ref: (n: unknown) => setNode(n), "data-has-node": node ? "1" : "0" });
  }
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const root = createRoot(asEl(container));
  root.render(h(Layer, null));
  flushSync();
  // Mount → ref attaches → setNode(node) → one real re-render → ref swap → null/node → bail.
  assert(renders <= 3, `renders: ${renders}`);
  assert(effects <= 2, `effects: ${effects}`);
  assert(container.innerHTML.includes('data-has-node="1"'), container.innerHTML);
});

Deno.test("a state change to a NEW value still re-renders", () => {
  let renders = 0;
  let bump: () => void = () => {};
  function Counter(): VNode {
    renders++;
    const [n, setN] = useState(0);
    bump = () => setN((v) => v + 1);
    return h("span", null, String(n));
  }
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const root = createRoot(asEl(container));
  root.render(h(Counter, null));
  flushSync();
  const before = renders;
  bump();
  flushSync();
  assertEquals(renders, before + 1);
  assert(container.innerHTML.includes("1"), container.innerHTML);
  bump();
  bump();
  flushSync();
  assert(container.innerHTML.includes("3"), container.innerHTML);
});
