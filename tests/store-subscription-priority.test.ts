// Regression: a `useSyncExternalStore` change must re-render every subscriber in ONE
// synchronous pass. Splitting subscribers across lanes (some sync, some transition)
// lets a child render against store state its parent has not caught up with — the
// classic tearing failure that TanStack Router's `matchStores` invariant reports as
// "Invariant failed" from inside `useSyncExternalStoreWithSelector`.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { startTransition, useSyncExternalStore } from "../src/runtime/hooks.ts";
import { ErrorBoundary } from "../src/runtime/error-boundary.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

/** A minimal external store: a listener set plus a manual notify. */
function makeStore() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    notify: () => {
      for (const cb of [...listeners]) cb();
    },
  };
}

/** Let queued microtasks (the sync flush) run, without letting a macrotask through. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

Deno.test("a store removal re-renders parent and child in one pass (no torn child render)", async () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  // Two stores, as TanStack Router has: one for the match LIST, one per match.
  const listStore = makeStore();
  const itemStore = makeStore();
  let ids = ["a", "b"];
  const items = new Map([["a", "A"], ["b", "B"]]);

  const thrown: unknown[] = [];

  function Row({ id }: { id: string }): VNode {
    // TanStack's useMatch: a selector over the per-match store that INVARIANTS when
    // the match it names is gone.
    const v = useSyncExternalStore(itemStore.subscribe, () => {
      const item = items.get(id);
      if (item === undefined) throw new Error("Invariant failed");
      return item;
    });
    return h("li", null, v);
  }

  function List(): VNode {
    const list = useSyncExternalStore(listStore.subscribe, () => ids);
    return h("ul", null, list.map((id) => h(Row, { key: id, id })));
  }

  // The boundary turns the (otherwise uncaught, microtask-borne) render throw into an
  // observable fallback — the app symptom: the subtree dies and its content vanishes.
  const tree = () =>
    h(ErrorBoundary, {
      fallback: ({ error }: { error: Error }) => {
        thrown.push(error);
        return h("p", null, "boom");
      },
    }, h(List, null));

  createRoot(asEl(container)).render(tree());
  flushSync();
  assertEquals(container.innerHTML, "<ul><li>A</li><li>B</li></ul>");

  // Remove "b" from both stores, then notify.
  items.delete("b");
  ids = ["a"];
  // The match-list write lands inside a transition (TanStack Router's Transitioner
  // wraps navigation state updates in startTransition) …
  startTransition(() => listStore.notify());
  // … while the per-match store notifies at ordinary (sync) priority.
  itemStore.notify();
  await microtasks();

  assertEquals(
    thrown.map((e) => (e as Error).message),
    [],
    "the removed row must never render against the store state that dropped it",
  );
  assertEquals(container.innerHTML, "<ul><li>A</li></ul>");
});

Deno.test("a store change inside startTransition still re-renders at sync priority", async () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  const store = makeStore();
  let value = "a";

  function Store(): VNode {
    return h("output", null, useSyncExternalStore(store.subscribe, () => value));
  }

  createRoot(asEl(container)).render(h(Store, null));
  flushSync();
  assertEquals(container.innerHTML, "<output>a</output>");

  // React's `forceStoreRerender` hard-codes SyncLane, so an external store change is
  // never time-sliced onto the transition lane — it lands in the sync microtask flush,
  // not the transition macrotask. Subscribers of one mutation must not be split apart.
  value = "b";
  startTransition(() => store.notify());
  await microtasks();
  assertEquals(container.innerHTML, "<output>b</output>");
});
