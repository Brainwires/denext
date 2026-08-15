// M8: within a single commit, React runs ALL effect cleanups before ANY effect
// setup — so a resource handed from a later sibling to an earlier one is released
// (in the later sibling's cleanup) before it is re-acquired (in the earlier
// sibling's setup). Before the fix each fiber ran its own cleanup+setup as one
// bundle, so the earlier sibling's setup could execute while the later sibling
// still held the resource.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useEffect, useLayoutEffect, useState } from "../mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// A single exclusive resource: exactly one owner at a time. The active sibling
// acquires it in setup (asserting it is free) and releases it in cleanup.
function makeHandoffApp(useEffectHook: typeof useEffect) {
  const log: string[] = [];
  const state = { owner: null as string | null };
  let setGen: (v: number) => void = () => {};

  function Child({ id, active }: { id: string; active: boolean }): VNode {
    useEffectHook(() => {
      if (active) {
        assert(
          state.owner === null,
          `${id} acquired while ${state.owner} still held the resource`,
        );
        state.owner = id;
        log.push(`${id}:setup`);
      }
      return () => {
        if (active) {
          state.owner = null;
          log.push(`${id}:cleanup`);
        }
      };
    }, [active]);
    return h("span", null, id);
  }

  function App(): VNode {
    const [gen, set] = useState(0);
    setGen = (v) => set(() => v);
    // A is the FIRST sibling, B the SECOND. The holder alternates so that on the
    // update the earlier sibling (A) acquires exactly what the later sibling (B)
    // frees — the case the per-fiber bundling got wrong.
    return h(
      "div",
      null,
      h(Child, { id: "A", active: gen === 1 }),
      h(Child, { id: "B", active: gen === 0 }),
    );
  }

  return { App, log, state, setGen: (v: number) => setGen(v) };
}

Deno.test("M8: passive-effect cleanups all run before setups (sibling handoff)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const { App, log, state, setGen } = makeHandoffApp(useEffect);
  createRoot(container as Any).render(h(App, null));
  flushSync();
  assertEquals(state.owner, "B", "on mount the active sibling (B) holds the resource");
  assertEquals(log, ["B:setup"]);

  log.length = 0;
  setGen(1);
  flushSync();
  // Fixed order: B releases (cleanup) BEFORE A acquires (setup).
  assertEquals(log, ["B:cleanup", "A:setup"]);
  assertEquals(state.owner, "A", "resource handed off to A");
});

Deno.test("M8: layout-effect cleanups all run before setups (sibling handoff)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const { App, log, state, setGen } = makeHandoffApp(useLayoutEffect);
  createRoot(container as Any).render(h(App, null));
  flushSync();
  assertEquals(state.owner, "B");
  assertEquals(log, ["B:setup"]);

  log.length = 0;
  setGen(1);
  flushSync();
  assertEquals(log, ["B:cleanup", "A:setup"]);
  assertEquals(state.owner, "A");
});
