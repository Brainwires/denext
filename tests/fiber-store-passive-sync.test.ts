// A useSyncExternalStore update commits its effects before the next task, as React's SyncLane
// does (`flushPassiveEffects` at the end of a sync commit). Stores that reclaim an unsubscribed
// entry on a 0 ms task (@effect/atom's registry does) otherwise lose the race: the entry a
// render created is reclaimed before the subscription effect runs, re-subscribing rebuilds it
// with a new value, and a component that derives its store per render (`useAtomValue(atom, f)`
// with an inline `f`) re-renders forever. T3 Code's composer looped ~30-110 times a second.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { useSyncExternalStore } from "../src/runtime/hooks.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** A registry that builds an entry on read and reclaims it on a 0 ms task unless subscribed. */
function makeRegistry() {
  const entries = new Map<object, { value: object; subs: Set<() => void> }>();
  const ensure = (key: object) => {
    let e = entries.get(key);
    if (!e) {
      e = { value: { built: Math.random() }, subs: new Set() };
      entries.set(key, e);
      setTimeout(() => {
        if (entries.get(key)?.subs.size === 0) entries.delete(key);
      }, 0);
    }
    return e;
  };
  return {
    get: (key: object) => ensure(key).value,
    subscribe: (key: object, cb: () => void) => {
      const e = ensure(key);
      e.subs.add(cb);
      return () => {
        e.subs.delete(cb);
        setTimeout(() => {
          if (e.subs.size === 0 && entries.get(key) === e) entries.delete(key);
        }, 0);
      };
    },
  };
}

Deno.test("a store-driven re-render settles when the store reclaims unsubscribed entries", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const registry = makeRegistry();
  const stores = new WeakMap<
    object,
    { subscribe: (cb: () => void) => () => void; get: () => object }
  >();
  const storeFor = (key: object) => {
    let s = stores.get(key);
    if (!s) {
      s = { subscribe: (cb) => registry.subscribe(key, cb), get: () => registry.get(key) };
      stores.set(key, s);
    }
    return s;
  };

  let renders = 0;
  function Derived(): VNode {
    renders++;
    const key = {}; // a derived store per render, as useAtomValue(atom, inlineFn) makes
    const s = storeFor(key);
    useSyncExternalStore(s.subscribe, s.get);
    return h("span", null, "x");
  }

  createRoot(container as Any).render(h(Derived, null));
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  assert(renders <= 3, `re-rendered ${renders} times while idle`);
  const settled = renders;
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
  assertEquals(renders, settled, "still rendering while idle");
});
