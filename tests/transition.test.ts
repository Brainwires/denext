// Cooperative transition scheduling: an update made inside startTransition is
// deprioritized — the urgent `isPending` update paints first (yielding to the
// browser), and the transition's own update commits on a later macrotask. This is
// scheduling only; rendering is not interrupted mid-tree (that needs a fiber renderer).

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState, useTransition } from "../mod.ts";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("useTransition: urgent isPending paints before the deferred transition update", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let startFn: (cb: () => void) => void = () => {};
  let setChild: (v: string) => void = () => {};

  function Child(): VNode {
    const [text, set] = useState("a");
    setChild = (v) => set(() => v);
    return h("span", null, text);
  }
  function Parent(): VNode {
    const [pending, start] = useTransition();
    startFn = start;
    return h("div", null, h("i", null, pending ? "P" : "-"), h(Child, null));
  }

  createRoot(container as Any).render(h(Parent, null));
  assertEquals(container.innerHTML, "<div><i>-</i><span>a</span></div>");

  // Transition updates Child; isPending lives on Parent.
  startFn(() => setChild("b"));

  // Urgent microtask: isPending shows, but the transition (Child) update is deferred.
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(
    container.innerHTML,
    "<div><i>P</i><span>a</span></div>",
    "isPending committed urgently; transition value still deferred",
  );

  // Later macrotask: the transition commits (Child updates) and isPending clears.
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(container.innerHTML, "<div><i>-</i><span>b</span></div>");
});
