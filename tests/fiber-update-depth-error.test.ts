// "Maximum update depth exceeded" names the looping component (React's error does). The
// render-phase guard (a component calling its own setter unconditionally while it renders)
// used to name nothing; in dev it also lists the components above it, React's component stack.

import { assert, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useLayoutEffect, useState } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";
import { updateDepthError } from "../src/client/fiber/fiber-utils.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

function Looper(): VNode {
  const [n, setN] = useState(0);
  setN(n + 1); // unconditional: never converges
  return h("i", null, String(n));
}
function Panel(): VNode {
  return h("section", null, h(Looper, null));
}

/** Render `node` and return the error the root reports (thrown or handed to onUncaughtError). */
function renderError(node: VNode): Error {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  let caught: unknown;
  try {
    createRoot(asEl(container), { onUncaughtError: (e: unknown) => (caught ??= e) }).render(node);
    flushSync();
  } catch (e) {
    caught ??= e;
  }
  assert(caught instanceof Error, `expected an Error, got ${String(caught)}`);
  return caught;
}

function withDev<T>(on: boolean, fn: () => T): T {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  g.__denextDev = on;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete g.__denextDev;
    else g.__denextDev = prev;
  }
}

Deno.test("render-phase update loop: the error names the component", () => {
  const err = withDev(false, () => renderError(h(Panel, null)));
  assertStringIncludes(err.message, "Maximum update depth exceeded");
  assertStringIncludes(err.message, "<Looper>");
  assert(!err.message.includes("\n    in "), "no component stack outside dev");
});

Deno.test("render-phase update loop: in dev the error lists the components above it", () => {
  const err = withDev(true, () => renderError(h(Panel, null)));
  assertStringIncludes(err.message, "<Looper>");
  assertStringIncludes(err.message, "\n    in Looper\n    in Panel");
});

Deno.test("work-loop update loop: the error names the last updater", () => {
  function Bouncer(): VNode {
    const [n, setN] = useState(0);
    useLayoutEffect(() => setN(n + 1)); // every commit schedules the next
    return h("b", null, String(n));
  }
  const err = withDev(false, () => renderError(h(Bouncer, null)));
  assertStringIncludes(err.message, "Maximum update depth exceeded");
  assertStringIncludes(err.message, "<Bouncer>");
});

Deno.test("updateDepthError: names the given component; a missing fiber adds no stack", () => {
  assertStringIncludes(updateDepthError("Memo(Row)").message, "<Memo(Row)>");
  assertStringIncludes(updateDepthError("unknown", null).message, "<unknown>");
});
