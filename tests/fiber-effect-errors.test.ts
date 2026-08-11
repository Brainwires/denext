// CLI-H2: errors thrown by effects and unmount cleanups are handled — a layout
// effect error routes to the nearest boundary; a throwing cleanup doesn't strand
// the rest of the unmount (sibling cleanups + DOM removal still happen).

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { ErrorBoundary } from "../src/runtime/error-boundary.ts";
import { useLayoutEffect } from "../src/runtime/hooks.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

function Fallback(props: { error: Error }): VNode {
  return h("p", null, `fallback: ${props.error.message}`);
}

Deno.test("a throwing layout effect routes to the error boundary", async () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function Boom(): VNode {
    useLayoutEffect(() => {
      throw new Error("effect boom");
    }, []);
    return h("span", null, "ok");
  }
  const root = createRoot(asEl(container));
  root.render(h(ErrorBoundary, { fallback: Fallback, children: h(Boom, null) }));

  // The effect throws during commit; routing is deferred to a microtask so it
  // doesn't re-enter the commit. After it runs, the boundary shows the fallback.
  await Promise.resolve();
  flushSync();
  assertEquals(container.innerHTML, "<p>fallback: effect boom</p>");
  root.unmount();
});

Deno.test("a throwing unmount cleanup doesn't strand sibling cleanups or DOM", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  const cleaned: string[] = [];
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);

  function A(): VNode {
    useLayoutEffect(() => () => {
      throw new Error("A cleanup boom");
    }, []);
    return h("span", null, "A");
  }
  function B(): VNode {
    useLayoutEffect(() => () => {
      cleaned.push("B");
    }, []);
    return h("span", null, "B");
  }

  const root = createRoot(asEl(container));
  root.render(h("div", null, h(A, null), h(B, null)));
  assertEquals(container.innerHTML, "<div><span>A</span><span>B</span></div>");

  try {
    root.unmount(); // runs A's (throwing) cleanup then B's
  } finally {
    console.error = origError;
  }

  assert(cleaned.includes("B"), "the sibling cleanup still ran");
  assertEquals(container.innerHTML, "", "the DOM was still removed");
  assertEquals(errors.length, 1, "the cleanup error was reported, not swallowed silently");
});
