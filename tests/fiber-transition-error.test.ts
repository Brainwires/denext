// CLI-H1: an error thrown during a transition render with no enclosing error
// boundary must surface AND leave the concurrent scheduler clean — a later
// transition must still commit (before the fix, the scheduler wedged and
// isPending stuck true forever).

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState, useTransition } from "../mod.ts";
import {
  __pumpForTests,
  __setManualSlicingForTests,
  createRoot,
  setDocument,
} from "../src/client/fiber/reconciler.ts";
import { flushSync } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("an unboundaried transition-render error doesn't wedge the scheduler", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let throwAt = -1;
  let setN: (v: number) => void = () => {};
  function Child(): VNode {
    const [n, set] = useState(0);
    setN = (v) => set(() => v);
    if (n === throwAt) throw new Error("boom during transition render");
    return h("span", null, String(n));
  }
  let start: (cb: () => void) => void = () => {};
  function Parent(): VNode {
    const [, s] = useTransition();
    start = s;
    return h("div", null, h(Child, null));
  }

  createRoot(container as Any).render(h(Parent, null));
  assertEquals(container.innerHTML, "<div><span>0</span></div>");

  // First transition renders Child at n=1, which throws with no boundary.
  __setManualSlicingForTests(true);
  let threw = false;
  try {
    throwAt = 1;
    start(() => setN(1));
    while (__pumpForTests()) { /* drive the transition render to the throw */ }
  } catch {
    threw = true; // the error surfaced (React-parity uncaught render error)
  }
  assert(threw, "the unboundaried transition error surfaced");

  // The scheduler must have recovered: a fresh transition still commits.
  throwAt = -1;
  start(() => setN(2));
  while (__pumpForTests()) { /* drive the recovery transition */ }
  __setManualSlicingForTests(false);
  flushSync();

  assertEquals(container.innerHTML, "<div><span>2</span></div>", "later transition committed");
});
