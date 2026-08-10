// Profiler actual-vs-base durations: actualDuration counts only the components that
// re-rendered this commit; baseDuration counts the whole subtree's most-recent
// render time. So a commit where a memoized child bails has actual < base.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { memo, Profiler, useState } from "../mod.ts";
import type { ProfilerPhase } from "../src/runtime/profiler.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// Do enough work that the render time is measurably non-zero.
function busy(): number {
  let x = 0;
  for (let i = 0; i < 500_000; i++) x += i;
  return x;
}

const Child = memo(function Child(): VNode {
  busy();
  return h("span", null, "child");
});

Deno.test("Profiler reports actual vs base durations and mount/update phases", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const calls: Array<{ id: string; phase: ProfilerPhase; actual: number; base: number }> = [];
  let setN: (n: number) => void = () => {};

  function App(): VNode {
    const [, set] = useState(0);
    setN = (n) => set(() => n);
    busy();
    return h(Child, null); // Child is memoized → bails on App's re-render
  }

  createRoot(container as Any).render(
    h(
      Profiler,
      {
        id: "app",
        onRender: (
          id: string,
          phase: ProfilerPhase,
          actual: number,
          base: number,
        ) => calls.push({ id, phase, actual, base }),
      },
      h(App, null),
    ),
  );
  flushSync();

  assertEquals(calls.length, 1, "onRender fired once on mount");
  assertEquals(calls[0].id, "app");
  assertEquals(calls[0].phase, "mount");
  // On mount nothing bailed, so actual and base cover the same work.
  assert(calls[0].actual > 0, "mount actual > 0");
  assert(calls[0].base >= calls[0].actual, "base ≥ actual");

  // Update App only; Child (memoized) bails out.
  setN(1);
  flushSync();

  assertEquals(calls.length, 2, "onRender fired again on update");
  assertEquals(calls[1].phase, "update");
  assert(
    calls[1].actual < calls[1].base,
    `memoized update: actual (${calls[1].actual}) < base (${
      calls[1].base
    }) — Child excluded from actual`,
  );
});

Deno.test("Profiler adds no DOM and is transparent", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(
    h(Profiler, { id: "x" }, h("p", null, "hi")),
  );
  flushSync();
  assertEquals(container.innerHTML, "<p>hi</p>");
});
