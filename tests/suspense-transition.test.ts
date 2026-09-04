// Transition-aware Suspense: when a `startTransition` update re-suspends an
// ALREADY-REVEALED boundary, denext keeps the current content on screen (no
// fallback flash) and commits the new content once the promise settles — React's
// recommended pattern. An URGENT (non-transition) re-suspend still shows the
// fallback (that path is unchanged). Because the revealed subtree is never
// unmounted during a transition re-suspend, its local state is preserved.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useEffect, useState, useTransition } from "../mod.ts";
import { Suspense, use } from "../src/runtime/suspense.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = () => new Promise((r) => setTimeout(r, 5));

/** Per-key data sources. "a" is already resolved; "b" stays pending until we let it. */
type Pending = {
  resolveB: (v: string) => void;
  pB: Promise<string>;
  resources: Record<string, Promise<string>>;
};
function pendingResources(): Pending {
  let resolveB: (v: string) => void = () => {};
  const pB = new Promise<string>((r) => (resolveB = r));
  return { resolveB, pB, resources: { a: Promise.resolve("A"), b: pB } };
}

/** Mount `tree` and drive the initial mount past its first suspend so the boundary is REVEALED. */
async function mountRevealed(tree: VNode, p: Pending) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(tree);
  await p.resources.a;
  await Promise.resolve();
  flushSync();
  return container;
}

/** Resolve "b" and let the retry settle (callers then flushSync() or tick()). */
async function settleB(p: Pending) {
  p.resolveB("B");
  await p.pB;
  await Promise.resolve();
}

/** A sibling holding local state, independent of the suspending data. */
function makeCounter() {
  const api = { bump: () => {}, Counter };
  function Counter(): VNode {
    const [n, set] = useState(0);
    api.bump = () => set((x) => x + 1);
    return h("b", null, String(n));
  }
  return api;
}

/** A reader keyed by its own state; `setId` switches it inside a transition. */
function makeTransitionReader(resources: Record<string, Promise<string>>) {
  const api = { setId: (_v: string) => {}, Data };
  function Data(): VNode {
    const [id, set] = useState("a");
    api.setId = (v) => set(() => v);
    return h("span", null, use(resources[id]));
  }
  return api;
}

/** A reader of `resources[key]` (external key) with an urgent re-read trigger. */
function makeUrgentReader(resources: Record<string, Promise<string>>) {
  const api = { key: "a", reread: () => {}, Data };
  function Data(): VNode {
    const [, set] = useState(0);
    api.reread = () => set((x) => x + 1); // urgent update that re-reads the resource
    return h("span", null, use(resources[api.key]));
  }
  return api;
}

/**
 * A "ticking" side effect standing in for a timer/subscription: registered on
 * setup, removed on cleanup. `drive()` bumps every registered ticker — so while
 * the subtree is hidden (effect disconnected) it must be a no-op.
 */
function makeTicker() {
  const log: string[] = [];
  const subscribers = new Set<() => void>();
  const drive = () => {
    for (const cb of [...subscribers]) cb();
  };
  function Ticker(): VNode {
    const [n, setN] = useState(0);
    useEffect(() => {
      log.push("setup");
      const cb = () => setN((x) => x + 1);
      subscribers.add(cb);
      return () => {
        log.push("cleanup");
        subscribers.delete(cb);
      };
    }, []);
    return h("b", null, String(n));
  }
  return { log, drive, Ticker };
}

Deno.test("Suspense: a transition re-suspend keeps the old content (no fallback flash)", async () => {
  const p = pendingResources();
  const reader = makeTransitionReader(p.resources);
  let startFn: (cb: () => void) => void = () => {};

  function Parent(): VNode {
    const [pending, start] = useTransition();
    startFn = start;
    return h(
      "div",
      null,
      h("i", null, pending ? "P" : "-"),
      h(Suspense, { fallback: h("p", null, "wait"), children: h(reader.Data, null) }),
    );
  }

  const container = await mountRevealed(h(Parent, null), p);
  assertEquals(
    container.innerHTML,
    "<div><i>-</i><span>A</span></div>",
    "boundary is revealed with content A",
  );

  // Transition to "b" (still pending): keep showing A, and isPending is true —
  // NOT the fallback.
  startFn(() => reader.setId("b"));
  await tick();
  assertEquals(
    container.innerHTML,
    "<div><i>P</i><span>A</span></div>",
    "transition re-suspend keeps old content A and shows isPending (no fallback)",
  );

  // Resolve "b": the pending transition retries and commits B; isPending clears.
  await settleB(p);
  await tick();
  assertEquals(
    container.innerHTML,
    "<div><i>-</i><span>B</span></div>",
    "the settled transition reveals B and clears isPending",
  );
});

Deno.test("Suspense: an URGENT re-suspend shows the fallback but keeps the primary mounted-hidden (Offscreen)", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let resolveB: (v: string) => void = () => {};
  const pB = new Promise<string>((r) => (resolveB = r));
  const resources: Record<string, Promise<string>> = {
    a: Promise.resolve("A"),
    b: pB,
  };
  // The key is external so the read tracks the urgent update deterministically.
  let key = "a";
  let rerender: () => void = () => {};

  function Child(): VNode {
    const [, set] = useState(0);
    rerender = () => set((x) => x + 1);
    return h("span", null, use(resources[key]));
  }

  createRoot(container as Any).render(
    h(Suspense, { fallback: h("p", null, "wait"), children: h(Child, null) }),
  );

  await resources.a;
  await Promise.resolve();
  flushSync();
  assertEquals(container.innerHTML, "<span>A</span>", "revealed with A");

  // A plain (urgent, non-transition) update that re-suspends shows the fallback, but
  // the previously-revealed primary stays mounted-but-hidden alongside it (Offscreen).
  key = "b";
  rerender();
  flushSync();
  assertEquals(
    container.innerHTML,
    `<span style="display:none !important">A</span><p>wait</p>`,
    "urgent re-suspend: fallback shown, primary kept mounted-hidden (not unmounted)",
  );

  // On resolve, the SAME primary is revealed (un-hidden) with the new data.
  resolveB("B");
  await pB;
  await Promise.resolve();
  flushSync();
  assertEquals(container.innerHTML, "<span>B</span>", "then reveals B (primary un-hidden)");
});

Deno.test("Suspense: Offscreen hide preserves an element's own inline style on reveal", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let resolveB: (v: string) => void = () => {};
  const pB = new Promise<string>((r) => (resolveB = r));
  const resources: Record<string, Promise<string>> = { a: Promise.resolve("A"), b: pB };
  let key = "a";
  let rerender: () => void = () => {};

  function Child(): VNode {
    const [, set] = useState(0);
    rerender = () => set((x) => x + 1);
    // The host element carries its own inline style that must survive hide→reveal.
    return h("span", { style: { color: "red" } }, use(resources[key]));
  }

  createRoot(container as Any).render(
    h(Suspense, { fallback: h("p", null, "wait"), children: h(Child, null) }),
  );
  await resources.a;
  await Promise.resolve();
  flushSync();
  assertEquals(container.innerHTML, `<span style="color:red;">A</span>`, "revealed with its style");

  // Urgent re-suspend: display:none !important is appended, the prior style is kept.
  key = "b";
  rerender();
  flushSync();
  assertEquals(
    container.innerHTML,
    `<span style="color:red;display:none !important">A</span><p>wait</p>`,
    "hidden: own style retained, display forced off",
  );

  // Reveal restores exactly the element's original inline style (no leftover display).
  resolveB("B");
  await pB;
  await Promise.resolve();
  flushSync();
  assertEquals(
    container.innerHTML,
    `<span style="color:red;">B</span>`,
    "revealed: original inline style restored, no residual display:none",
  );
});

Deno.test("Suspense: an URGENT re-suspend preserves the primary subtree's local state (Offscreen)", async () => {
  const p = pendingResources();
  const counter = makeCounter();
  const reader = makeUrgentReader(p.resources);
  function Content(): VNode {
    return h("div", null, h(counter.Counter, null), h(reader.Data, null));
  }

  const container = await mountRevealed(
    h(Suspense, { fallback: h("p", null, "wait"), children: h(Content, null) }),
    p,
  );

  // Give the counter local state.
  counter.bump();
  counter.bump();
  flushSync();
  assertEquals(container.innerHTML, "<div><b>2</b><span>A</span></div>");

  // Urgent re-suspend on the data: the whole subtree (incl. the counter) is kept
  // mounted-hidden, so the counter's state survives.
  reader.key = "b";
  reader.reread();
  flushSync();
  assertEquals(
    container.innerHTML,
    `<div style="display:none !important"><b>2</b><span>A</span></div><p>wait</p>`,
    "primary kept mounted-hidden with its state intact; fallback shown",
  );

  // On resolve, the SAME instances are revealed — the counter still reads 2.
  await settleB(p);
  flushSync();
  assertEquals(
    container.innerHTML,
    "<div><b>2</b><span>B</span></div>",
    "revealed: counter state (2) preserved, data updated to B — no remount",
  );
});

Deno.test("Suspense: Offscreen hide tears down subtree effects; reveal reconnects them (SEC-M3)", async () => {
  const p = pendingResources();
  const reader = makeUrgentReader(p.resources);
  const { log, drive, Ticker } = makeTicker();
  function Content(): VNode {
    return h("div", null, h(Ticker, null), h(reader.Data, null));
  }

  const container = await mountRevealed(
    h(Suspense, { fallback: h("p", null, "wait"), children: h(Content, null) }),
    p,
  );
  assertEquals(log, ["setup"], "effect set up once on mount");

  // The ticker is live: drive() bumps its state.
  drive();
  flushSync();
  assertEquals(container.innerHTML, "<div><b>1</b><span>A</span></div>");

  // Urgent re-suspend → the primary goes Offscreen: its effect is torn down.
  reader.key = "b";
  reader.reread();
  flushSync();
  assertEquals(log, ["setup", "cleanup"], "hidden subtree's effect cleaned up");
  assertEquals(
    container.innerHTML,
    `<div style="display:none !important"><b>1</b><span>A</span></div><p>wait</p>`,
  );

  // While hidden, the ticker is disconnected: drive() no longer touches its state.
  drive();
  drive();
  flushSync();
  assertEquals(
    container.innerHTML,
    `<div style="display:none !important"><b>1</b><span>A</span></div><p>wait</p>`,
    "disconnected effect does not fire while offscreen (state frozen at 1)",
  );

  // Reveal: the effect reconnects (setup re-runs) and state (1) is preserved.
  await settleB(p);
  flushSync();
  assertEquals(log, ["setup", "cleanup", "setup"], "effect reconnected on reveal");
  assertEquals(
    container.innerHTML,
    "<div><b>1</b><span>B</span></div>",
    "revealed: ticker state (1) preserved, data updated to B",
  );

  // The reconnected ticker is live again.
  drive();
  flushSync();
  assertEquals(container.innerHTML, "<div><b>2</b><span>B</span></div>");
});

Deno.test("Suspense: transition re-suspend preserves the revealed subtree's local state", async () => {
  const p = pendingResources();
  let startFn: (cb: () => void) => void = () => {};
  // A sibling inside the boundary that holds local state independent of the data.
  const counter = makeCounter();
  const reader = makeTransitionReader(p.resources);
  function Content(): VNode {
    return h("div", null, h(counter.Counter, null), h(reader.Data, null));
  }
  function Parent(): VNode {
    const [, start] = useTransition();
    startFn = start;
    return h(Suspense, { fallback: h("p", null, "wait"), children: h(Content, null) });
  }

  const container = await mountRevealed(h(Parent, null), p);

  // Give the counter some local state.
  counter.bump();
  counter.bump();
  flushSync();
  assertEquals(container.innerHTML, "<div><b>2</b><span>A</span></div>");

  // Transition-suspend on the data: the whole subtree (incl. the counter) is kept
  // mounted, so its state survives.
  startFn(() => reader.setId("b"));
  await tick();
  assertEquals(
    container.innerHTML,
    "<div><b>2</b><span>A</span></div>",
    "counter state (2) is preserved — the subtree was never unmounted",
  );

  await settleB(p);
  await tick();
  assertEquals(
    container.innerHTML,
    "<div><b>2</b><span>B</span></div>",
    "data updates to B while the counter keeps its preserved state",
  );
});
