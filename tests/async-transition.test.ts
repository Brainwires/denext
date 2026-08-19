// Async startTransition / useTransition: `startTransition(async () => { await x;
// setState() })` keeps the transition active across the await — `isPending` stays
// true until the promise settles and its flush lands, and the post-await update is
// scheduled at TRANSITION priority (flushed on the transition macrotask, not the
// urgent microtask). denext can't instrument the user's await, so while any async
// transition is pending its window entangles updates at transition priority.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState, useTransition } from "../mod.ts";
import { startTransition } from "../src/runtime/hooks.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = () => new Promise((r) => setTimeout(r, 5));
const micro = () => Promise.resolve();

Deno.test("useTransition: isPending is held across an awaited callback, then clears", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let resolveGate: () => void = () => {};
  const gate = new Promise<void>((r) => (resolveGate = r));

  let go: () => void = () => {};

  function App(): VNode {
    const [isPending, start] = useTransition();
    const [n, setN] = useState(0);
    go = () =>
      start(async () => {
        await gate;
        setN((x) => x + 1);
      });
    return h(
      "div",
      null,
      h("i", null, isPending ? "P" : "-"),
      h("span", null, String(n)),
    );
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();
  assertEquals(container.innerHTML, "<div><i>-</i><span>0</span></div>", "initial");

  // Start the async transition. isPending must go true immediately (urgent), while
  // the awaited body has NOT yet run — n stays 0.
  go();
  await micro();
  await micro();
  assertEquals(
    container.innerHTML,
    "<div><i>P</i><span>0</span></div>",
    "isPending held true across the await; the update has not landed",
  );

  // Resolve the gate. The post-await setState runs now — at TRANSITION priority, so
  // draining only microtasks must NOT apply it (a sync update would apply here).
  resolveGate();
  await micro();
  await micro();
  assertEquals(
    container.innerHTML,
    "<div><i>P</i><span>0</span></div>",
    "post-await update is a transition: not flushed on the urgent microtask",
  );

  // The transition macrotask flush lands the update and clears isPending.
  await tick();
  await tick();
  assertEquals(
    container.innerHTML,
    "<div><i>-</i><span>1</span></div>",
    "the settled async transition applies the update and clears isPending",
  );
});

Deno.test("standalone startTransition entangles a post-await update at transition priority", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let resolveGate: () => void = () => {};
  const gate = new Promise<void>((r) => (resolveGate = r));
  let go: () => void = () => {};

  function App(): VNode {
    const [n, setN] = useState(0);
    go = () =>
      startTransition(async () => {
        await gate;
        setN((x) => x + 1);
      });
    return h("span", null, String(n));
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();
  assertEquals(container.innerHTML, "<span>0</span>");

  go();
  resolveGate();
  await micro();
  await micro();
  // Not applied on the microtask → it's a transition, not a sync update.
  assertEquals(container.innerHTML, "<span>0</span>", "deferred to the transition flush");

  await tick();
  await tick();
  assertEquals(container.innerHTML, "<span>1</span>", "transition flush applies the update");
});

Deno.test("an urgent update still wins after an async transition settles", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let resolveGate: () => void = () => {};
  const gate = new Promise<void>((r) => (resolveGate = r));
  let startAsync: () => void = () => {};
  let urgent: () => void = () => {};

  function App(): VNode {
    const [, start] = useTransition();
    const [n, setN] = useState(0);
    startAsync = () =>
      start(async () => {
        await gate;
        setN((x) => x + 10);
      });
    urgent = () => setN((x) => x + 1);
    return h("span", null, String(n));
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();

  startAsync();
  resolveGate();
  await tick();
  await tick();
  // The async transition applied +10.
  assertEquals(container.innerHTML, "<span>10</span>");

  // After it settles, a plain setState is urgent again (flushes synchronously).
  urgent();
  flushSync();
  assertEquals(
    container.innerHTML,
    "<span>11</span>",
    "urgent updates are sync once the window closes",
  );
  assert(true);
});
