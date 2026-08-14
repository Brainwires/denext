// Transition-aware Suspense: when a `startTransition` update re-suspends an
// ALREADY-REVEALED boundary, denext keeps the current content on screen (no
// fallback flash) and commits the new content once the promise settles — React's
// recommended pattern. An URGENT (non-transition) re-suspend still shows the
// fallback (that path is unchanged). Because the revealed subtree is never
// unmounted during a transition re-suspend, its local state is preserved.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState, useTransition } from "../mod.ts";
import { Suspense, use } from "../src/runtime/suspense.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = () => new Promise((r) => setTimeout(r, 5));

Deno.test("Suspense: a transition re-suspend keeps the old content (no fallback flash)", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let resolveB: (v: string) => void = () => {};
  const pB = new Promise<string>((r) => (resolveB = r));
  // Per-key data sources. "a" is already resolved; "b" stays pending until we let it.
  const resources: Record<string, Promise<string>> = {
    a: Promise.resolve("A"),
    b: pB,
  };

  let setId: (v: string) => void = () => {};
  let startFn: (cb: () => void) => void = () => {};

  function Child(): VNode {
    const [id, set] = useState("a");
    setId = (v) => set(() => v);
    return h("span", null, use(resources[id]));
  }
  function Parent(): VNode {
    const [pending, start] = useTransition();
    startFn = start;
    return h(
      "div",
      null,
      h("i", null, pending ? "P" : "-"),
      h(Suspense, { fallback: h("p", null, "wait"), children: h(Child, null) }),
    );
  }

  createRoot(container as Any).render(h(Parent, null));

  // Drive the initial mount past its first suspend so the boundary is REVEALED.
  await resources.a;
  await Promise.resolve();
  flushSync();
  assertEquals(
    container.innerHTML,
    "<div><i>-</i><span>A</span></div>",
    "boundary is revealed with content A",
  );

  // Transition to "b" (still pending): keep showing A, and isPending is true —
  // NOT the fallback.
  startFn(() => setId("b"));
  await tick();
  assertEquals(
    container.innerHTML,
    "<div><i>P</i><span>A</span></div>",
    "transition re-suspend keeps old content A and shows isPending (no fallback)",
  );

  // Resolve "b": the pending transition retries and commits B; isPending clears.
  resolveB("B");
  await pB;
  await Promise.resolve();
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
    `<span hidden="">A</span><p>wait</p>`,
    "urgent re-suspend: fallback shown, primary kept mounted-hidden (not unmounted)",
  );

  // On resolve, the SAME primary is revealed (un-hidden) with the new data.
  resolveB("B");
  await pB;
  await Promise.resolve();
  flushSync();
  assertEquals(container.innerHTML, "<span>B</span>", "then reveals B (primary un-hidden)");
});

Deno.test("Suspense: an URGENT re-suspend preserves the primary subtree's local state (Offscreen)", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let resolveB: (v: string) => void = () => {};
  const pB = new Promise<string>((r) => (resolveB = r));
  const resources: Record<string, Promise<string>> = {
    a: Promise.resolve("A"),
    b: pB,
  };
  let key = "a";
  let bump: () => void = () => {};
  let reread: () => void = () => {};

  // A sibling holding local state, independent of the suspending data.
  function Counter(): VNode {
    const [n, set] = useState(0);
    bump = () => set((x) => x + 1);
    return h("b", null, String(n));
  }
  function Data(): VNode {
    const [, set] = useState(0);
    reread = () => set((x) => x + 1); // urgent update that re-reads the resource
    return h("span", null, use(resources[key]));
  }
  function Content(): VNode {
    return h("div", null, h(Counter, null), h(Data, null));
  }

  createRoot(container as Any).render(
    h(Suspense, { fallback: h("p", null, "wait"), children: h(Content, null) }),
  );
  await resources.a;
  await Promise.resolve();
  flushSync();

  // Give the counter local state.
  bump();
  bump();
  flushSync();
  assertEquals(container.innerHTML, "<div><b>2</b><span>A</span></div>");

  // Urgent re-suspend on the data: the whole subtree (incl. the counter) is kept
  // mounted-hidden, so the counter's state survives.
  key = "b";
  reread();
  flushSync();
  assertEquals(
    container.innerHTML,
    `<div hidden=""><b>2</b><span>A</span></div><p>wait</p>`,
    "primary kept mounted-hidden with its state intact; fallback shown",
  );

  // On resolve, the SAME instances are revealed — the counter still reads 2.
  resolveB("B");
  await pB;
  await Promise.resolve();
  flushSync();
  assertEquals(
    container.innerHTML,
    "<div><b>2</b><span>B</span></div>",
    "revealed: counter state (2) preserved, data updated to B — no remount",
  );
});

Deno.test("Suspense: transition re-suspend preserves the revealed subtree's local state", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let resolveB: (v: string) => void = () => {};
  const pB = new Promise<string>((r) => (resolveB = r));
  const resources: Record<string, Promise<string>> = {
    a: Promise.resolve("A"),
    b: pB,
  };

  let setId: (v: string) => void = () => {};
  let startFn: (cb: () => void) => void = () => {};
  let bump: () => void = () => {};

  // A sibling inside the boundary that holds local state independent of the data.
  function Counter(): VNode {
    const [n, set] = useState(0);
    bump = () => set((x) => x + 1);
    return h("b", null, String(n));
  }
  function Data(): VNode {
    const [id, set] = useState("a");
    setId = (v) => set(() => v);
    return h("span", null, use(resources[id]));
  }
  function Content(): VNode {
    return h("div", null, h(Counter, null), h(Data, null));
  }
  function Parent(): VNode {
    const [, start] = useTransition();
    startFn = start;
    return h(Suspense, { fallback: h("p", null, "wait"), children: h(Content, null) });
  }

  createRoot(container as Any).render(h(Parent, null));
  await resources.a;
  await Promise.resolve();
  flushSync();

  // Give the counter some local state.
  bump();
  bump();
  flushSync();
  assertEquals(container.innerHTML, "<div><b>2</b><span>A</span></div>");

  // Transition-suspend on the data: the whole subtree (incl. the counter) is kept
  // mounted, so its state survives.
  startFn(() => setId("b"));
  await tick();
  assertEquals(
    container.innerHTML,
    "<div><b>2</b><span>A</span></div>",
    "counter state (2) is preserved — the subtree was never unmounted",
  );

  resolveB("B");
  await pB;
  await Promise.resolve();
  await tick();
  assertEquals(
    container.innerHTML,
    "<div><b>2</b><span>B</span></div>",
    "data updates to B while the counter keeps its preserved state",
  );
});
