// A component's effect queues (insertion / layout / passive) are allocated only when it
// schedules an effect, and released once they run: a component with no effects holds no
// arrays, and none are allocated for it on each render.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useEffect, useLayoutEffect, useState } from "../src/runtime/hooks.ts";
import { currentFiber } from "../src/client/fiber/hooks-dispatcher.ts";
import type { Fiber } from "../src/client/fiber/fiber.ts";
import { flushPassiveEffects } from "../src/client/fiber/commit.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const queues = (f: Fiber) => [f.insertionEffects, f.pendingEffects, f.passiveEffects];

Deno.test("effect queues are allocated on first use and released after they run", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const fibers: Record<string, Fiber> = {};
  const ran: string[] = [];
  let bump: () => void = () => {};

  function Plain(): VNode {
    fibers.plain = currentFiber!;
    return h("span", null, "plain");
  }
  function WithEffects({ n }: { n: number }): VNode {
    fibers.effects = currentFiber!;
    useLayoutEffect(() => {
      ran.push(`layout ${n}`);
    }, [n]);
    useEffect(() => {
      ran.push(`passive ${n}`);
    }, [n]);
    return h("span", null, String(n));
  }
  function App(): VNode {
    const [n, setN] = useState(0);
    bump = () => setN((x) => x + 1);
    return h("div", null, h(Plain, null), h(WithEffects, { n }));
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();
  flushPassiveEffects();
  assertEquals(ran, ["layout 0", "passive 0"]);
  assertEquals(queues(fibers.plain), [undefined, undefined, undefined], "no effects, no arrays");
  assertEquals(queues(fibers.effects), [undefined, undefined, undefined], "released after running");

  bump();
  flushSync();
  flushPassiveEffects();
  assertEquals(
    ran,
    ["layout 0", "passive 0", "layout 1", "passive 1"],
    "effects re-run on new deps",
  );
  assert(fibers.plain !== undefined);
  assertEquals(queues(fibers.plain), [undefined, undefined, undefined]);
  assertEquals(queues(fibers.effects), [undefined, undefined, undefined]);
});
