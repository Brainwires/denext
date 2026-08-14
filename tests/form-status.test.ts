// Form-scoped useFormStatus: pending is tracked per <form>, so two concurrent
// forms report independent status (React 19 parity — not a single global flag).

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useFormStatus } from "../src/runtime/actions.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function Status(): VNode {
  const { pending } = useFormStatus();
  return h("span", null, pending ? "P" : "-");
}

Deno.test("useFormStatus is scoped to the nearest form", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const d1 = deferred();
  const d2 = deferred();
  function App(): VNode {
    return h("div", null, [
      h("form", { action: () => d1.promise }, h(Status, null)),
      h("form", { action: () => d2.promise }, h(Status, null)),
    ]);
  }

  createRoot(container as Any).render(h(App, null));
  flushSync(); // activate the useSyncExternalStore subscriptions
  assertEquals(
    container.innerHTML,
    "<div><form><span>-</span></form><form><span>-</span></form></div>",
    "both forms idle initially",
  );

  const div = container.childNodes[0] as FakeElement;
  const form1 = div.childNodes[0] as FakeElement;

  // Submit only form 1 — only its status should go pending.
  form1.dispatch("submit");
  flushSync();
  assertEquals(
    container.innerHTML,
    "<div><form><span>P</span></form><form><span>-</span></form></div>",
    "form 1 pending, form 2 still idle",
  );

  // Resolve form 1's action — it returns to idle.
  d1.resolve();
  await tick();
  flushSync();
  assertEquals(
    container.innerHTML,
    "<div><form><span>-</span></form><form><span>-</span></form></div>",
    "form 1 idle after its action settles",
  );

  // Clean up the still-pending second deferred (no assertion needed).
  d2.resolve();
  await tick();
});

Deno.test("useFormStatus outside any form is never pending", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(h("div", null, h(Status, null)));
  flushSync();
  assertEquals(container.innerHTML, "<div><span>-</span></div>");
});
