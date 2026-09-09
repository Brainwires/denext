// Regression guard for the flags-guided commit optimization: the commit-phase effect
// collectors (collectInsertionEffects / collectEffects) and the walk-based mutation
// phases now PRUNE clean subtrees by `subtreeFlags`, descending only where the relevant
// flag bubbled. These tests prove the pruning never SKIPS work it should do — an effect
// nested under effect-less ancestors must still be found (its `HasEffect` bit has to
// bubble all the way up), on both mount and a later update, and a useSyncExternalStore
// subscription (a second, dispatcher-bypassing `HasEffect` site) must still fire.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useInsertionEffect, useLayoutEffect, useState, useSyncExternalStore } from "../mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { flushPassiveEffects } from "../src/client/fiber/commit.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("commit pruning still reaches a deep effect under effect-less ancestors (mount)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const log: string[] = [];

  // A leaf with an insertion AND a layout effect, buried under several component + host
  // layers that queue NO effects of their own. If HasEffect failed to bubble through the
  // clean ancestors, the pruned collectors would never descend to the leaf.
  function Leaf(): VNode {
    useInsertionEffect(() => void log.push("insertion"));
    useLayoutEffect(() => void log.push("layout"));
    return h("span", null, "x");
  }
  const W3 = (): VNode => h("p", null, h(Leaf, null));
  const W2 = (): VNode => h("section", null, h(W3, null));
  const W1 = (): VNode => h("div", null, h(W2, null));
  const App = (): VNode => h("main", null, h(W1, null));

  createRoot(container as Any).render(h(App, null));
  flushSync();

  // Insertion runs in its pre-mutation phase (collected before clearCommittedFlags), layout
  // in commitLayoutEffects (collected before the flag reset, run after) — both must fire.
  assertEquals(log, ["insertion", "layout"]);
});

Deno.test("commit pruning still re-runs a deep layout effect on a later update", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const log: string[] = [];

  let bump: () => void = () => {};
  function Leaf({ n }: { n: number }): VNode {
    useLayoutEffect(() => void log.push(`leaf:${n}`), [n]);
    return h("span", null, String(n));
  }
  const W3 = ({ n }: { n: number }): VNode => h("p", null, h(Leaf, { n }));
  const W2 = ({ n }: { n: number }): VNode => h("section", null, h(W3, { n }));
  const W1 = ({ n }: { n: number }): VNode => h("div", null, h(W2, { n }));
  function App(): VNode {
    const [n, setN] = useState(0);
    bump = () => setN((x) => x + 1);
    return h("main", null, h(W1, { n }));
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();
  bump(); // n → 1: the deep leaf re-renders, re-earns HasEffect, which must bubble again
  flushSync();

  assertEquals(log, ["leaf:0", "leaf:1"]);
});

Deno.test("commit pruning still fires a deep useSyncExternalStore subscription", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let subscribed = false;

  function Store(): VNode {
    const v = useSyncExternalStore(
      (_cb: () => void) => {
        subscribed = true;
        return () => {};
      },
      () => "v",
    );
    return h("span", null, v);
  }
  const Wrap = (): VNode => h("div", null, h("section", null, h(Store, null)));

  createRoot(container as Any).render(h(Wrap, null));
  flushSync();
  // The subscription runs as a passive effect (a dispatcher-bypassing HasEffect site).
  flushPassiveEffects();

  assertEquals(subscribed, true);
});
