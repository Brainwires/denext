// The on-demand class runtime, second tier: a class component that reaches the CLIENT
// reconciler before the runtime is installed (nothing on the page was server-rendered as a
// class, so the entry had no marker to preload on — a soft navigation onto a class page, a
// client-only island). The reconciler must load the runtime itself and re-render, not throw.
// This file deliberately does NOT import tests/helpers/class-runtime.ts: the seam starts empty.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Component } from "../src/compat/react.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { getClassSupport, setClassSupport } from "../src/client/fiber/class-support.ts";
import { loadClassRuntime } from "../src/client/class-loader.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

class Hello extends Component<{ who: string }> {
  override render() {
    return h("b", null, `hi ${this.props.who}`);
  }
}

Deno.test("a class rendered client-side before the runtime is installed loads it and re-renders", async () => {
  setClassSupport(null);
  assertEquals(getClassSupport(), null, "the seam starts empty");
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(h("div", null, h(Hello as Any, { who: "later" })));
  // First pass: no boundary above → the class fiber keeps nothing for this pass and the
  // runtime load is in flight. No throw, no crash.
  assertEquals(container.innerHTML, "<div></div>");
  await loadClassRuntime(); // the same coalesced load the reconciler started
  assert(getClassSupport() !== null, "the load installed the runtime");
  flushSync(); // the fiber was scheduled for a re-render when the load landed
  assertStringIncludes(container.innerHTML, "<b>hi later</b>");
  root.unmount();
});

Deno.test("inside a Suspense boundary the runtime load suspends: fallback, then the class", async () => {
  setClassSupport(null);
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(
    h(Suspense, { fallback: h("p", null, "loading") } as Any, h(Hello as Any, { who: "soon" })),
  );
  assertStringIncludes(container.innerHTML, "<p>loading</p>");
  await loadClassRuntime();
  flushSync();
  assertStringIncludes(container.innerHTML, "<b>hi soon</b>");
  assert(!container.innerHTML.includes("loading"), "the fallback is gone");
  root.unmount();
});

Deno.test("once installed, a class renders synchronously on first mount (no blank pass)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(h(Hello as Any, { who: "now" }));
  assertEquals(container.innerHTML, "<b>hi now</b>");
  root.unmount();
});
