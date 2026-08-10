// Render-phase useDeferredValue: an urgent update commits immediately with the
// PREVIOUS deferred value, and the deferred value catches up on a later,
// interruptible transition render (React-accurate — no extra effect tick).

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useDeferredValue, useState } from "../mod.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("useDeferredValue: urgent update shows old value, transition catches up", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let setVal: (v: string) => void = () => {};
  function View(): VNode {
    const [val, set] = useState("a");
    setVal = (v) => set(() => v);
    const deferred = useDeferredValue(val);
    return h("div", null, h("b", null, val), h("i", null, deferred));
  }

  createRoot(container as Any).render(h(View, null));
  assertEquals(container.innerHTML, "<div><b>a</b><i>a</i></div>");

  setVal("b");
  // Urgent (sync) flush: the live value updates but the deferred value lags.
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(
    container.innerHTML,
    "<div><b>b</b><i>a</i></div>",
    "urgent value committed; deferred value still previous",
  );

  // Transition flush: the deferred value catches up.
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(container.innerHTML, "<div><b>b</b><i>b</i></div>");
});

Deno.test("useDeferredValue: initialValue shows first, then transitions to value", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  function View(): VNode {
    const deferred = useDeferredValue("final", "initial");
    return h("i", null, deferred);
  }

  createRoot(container as Any).render(h(View, null));
  assertEquals(container.innerHTML, "<i>initial</i>", "first render shows initialValue");

  await new Promise((r) => setTimeout(r, 5));
  assertEquals(container.innerHTML, "<i>final</i>", "transitions to value");
});

Deno.test("useDeferredValue: returns the value directly during SSR", async () => {
  function View(): VNode {
    return h("i", null, useDeferredValue("x"));
  }
  assertEquals(await renderToString(h(View, null)), "<i>x</i>");
});

Deno.test("useDeferredValue: SSR returns initialValue when provided", async () => {
  function View(): VNode {
    return h("i", null, useDeferredValue("final", "initial"));
  }
  assertEquals(await renderToString(h(View, null)), "<i>initial</i>");
});
