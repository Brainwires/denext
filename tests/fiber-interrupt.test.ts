// Lane-based interruption: an urgent (sync) update that arrives while a transition
// render is in flight abandons the transition's off-DOM work-in-progress (nothing
// committed, so nothing to roll back), commits the urgent update immediately, and
// restarts the transition from the freshly-committed state. Manual slicing seams
// make the mid-flight interruption deterministic.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { startTransition, useState } from "../mod.ts";
import {
  __pumpForTests,
  __setManualSlicingForTests,
  __setYieldEveryForTests,
  createRoot,
  setDocument,
} from "../src/client/fiber/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const microtasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Two independent stateful siblings; `aRenders` counts A's renders. */
function makeApp() {
  const api = { aRenders: 0, setA: (_v: string) => {}, setB: (_v: string) => {}, App };
  function A(): VNode {
    const [v, set] = useState("a0");
    api.setA = (x) => set(() => x);
    api.aRenders++;
    return h("span", { id: "a" }, v);
  }
  function B(): VNode {
    const [v, set] = useState("b0");
    api.setB = (x) => set(() => x);
    return h("span", { id: "b" }, v);
  }
  function App(): VNode {
    return h("div", null, h(A, null), h(B, null));
  }
  return api;
}

Deno.test("a sync update interrupts an in-flight transition and restarts it", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const app = makeApp();

  createRoot(container as Any).render(h(app.App, null));
  assertStringIncludes(container.innerHTML, "a0");
  assertStringIncludes(container.innerHTML, "b0");
  const rendersAfterMount = app.aRenders;

  __setYieldEveryForTests(1);
  __setManualSlicingForTests(true);
  try {
    // Begin a transition that updates A; drive a couple of slices so it is
    // genuinely in flight but not yet committed.
    startTransition(() => app.setA("a1"));
    __pumpForTests(); // slice 1 (root)
    __pumpForTests(); // slice 2
    assertStringIncludes(container.innerHTML, "a0"); // transition not committed yet
    const rendersDuringTransition = app.aRenders;

    // Urgent sync update on B while the transition is paused mid-flight.
    app.setB("b1");
    await microtasks(); // sync microtask: abandon the transition, commit B urgently

    assertStringIncludes(container.innerHTML, "b1"); // urgent update committed
    assertStringIncludes(container.innerHTML, "a0"); // transition was abandoned

    // The interruption rescheduled the transition (as a manual pending kick);
    // pump it to completion.
    for (let i = 0; i < 200 && !container.innerHTML.includes("a1"); i++) {
      if (!__pumpForTests()) break;
    }

    assertStringIncludes(container.innerHTML, "a1"); // transition finally commits
    assertStringIncludes(container.innerHTML, "b1"); // and the urgent value survives
    assert(
      app.aRenders > rendersDuringTransition,
      "A re-rendered when the interrupted transition restarted",
    );
    assert(rendersDuringTransition >= rendersAfterMount);
  } finally {
    __setYieldEveryForTests(0);
    __setManualSlicingForTests(false);
  }
});

Deno.test("flushSync completes an in-flight transition synchronously", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let setV: (v: string) => void = () => {};
  function C(): VNode {
    const [v, set] = useState("v0");
    setV = (x) => set(() => x);
    return h("p", null, v);
  }

  createRoot(container as Any).render(h(C, null));
  assertEquals(container.innerHTML, "<p>v0</p>");

  const { flushSync } = await import("../src/client/reconciler.ts");
  __setYieldEveryForTests(1);
  __setManualSlicingForTests(true);
  try {
    startTransition(() => setV("v1"));
    __pumpForTests(); // start slicing the transition
    assertEquals(container.innerHTML, "<p>v0</p>"); // not committed yet
    flushSync(); // must finish the transition synchronously
    assertEquals(container.innerHTML, "<p>v1</p>");
  } finally {
    __setYieldEveryForTests(0);
    __setManualSlicingForTests(false);
  }
});
