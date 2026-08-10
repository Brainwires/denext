// Time-slicing: a transition-lane render checks a frame budget between units of
// work and yields (via MessageChannel), resuming on later slices — so a heavy
// transition never blocks the frame. The tree is built off-DOM and committed
// only when the render drains, so the DOM never shows a partially-rendered tree.
// The `__setYieldEveryForTests` seam forces a yield after every unit so the
// multi-slice behavior is deterministic on tiny trees.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { startTransition, useState } from "../mod.ts";
import {
  __setYieldEveryForTests,
  createRoot,
  setDocument,
} from "../src/client/fiber/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = () => new Promise((r) => setTimeout(r, 1));

Deno.test("transition renders across multiple slices, committing atomically", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let setItems: (v: number[]) => void = () => {};
  function List(): VNode {
    const [items, set] = useState<number[]>([1]);
    setItems = (v) => set(() => v);
    return h("ul", null, ...items.map((i) => h("li", { key: i }, String(i))));
  }

  createRoot(container as Any).render(h(List, null));
  const OLD = "<ul><li>1</li></ul>";
  const NEW = "<ul><li>1</li><li>2</li><li>3</li><li>4</li><li>5</li></ul>";
  assertEquals(container.innerHTML, OLD);

  __setYieldEveryForTests(1); // force a yield after every unit of work
  try {
    const seen = new Set<string>();
    seen.add(container.innerHTML);
    startTransition(() => setItems([1, 2, 3, 4, 5]));

    // Drive macrotasks (setTimeout kick + MessageChannel continuations), sampling
    // the DOM after each so we would catch any partially-committed tree.
    for (let i = 0; i < 60 && container.innerHTML !== NEW; i++) {
      await tick();
      seen.add(container.innerHTML);
    }

    assertEquals(container.innerHTML, NEW, "the transition eventually commits");
    // Atomicity: every observed state was either fully old or fully new — never a
    // partially-rendered list (e.g. 3 of 5 items), despite yielding every unit.
    for (const s of seen) {
      assert(s === OLD || s === NEW, `partial DOM observed during slicing: ${s}`);
    }
  } finally {
    __setYieldEveryForTests(0);
  }
});
