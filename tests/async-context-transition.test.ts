// Async transitions scoped by IDENTITY (experimental.asyncContext) — the fix for
// KNOWN-LIMITATIONS' async-`startTransition` time-window gap.
//
// The build transform isn't run in unit tests, so each async callback is hand-
// desugared exactly as src/build/async-context-transform.ts emits it:
//   async () => { const $ = __asyncScope();
//                 try { …await X → await __asyncAwait($, X)… }
//                 finally { __asyncScopeEnd($); } }
// That routes the transition identity (set by the scheduler's transitionVar.run)
// across the `await`, so a post-await setState is attributed to the transition while
// an unrelated urgent update in the pending window is NOT. `__setAsyncContextScoping`
// stands in for the build seed that flips the reconciler into scoping mode.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState, useTransition } from "../mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { __setAsyncContextScoping } from "../src/client/fiber/reconciler.ts";
import { __asyncAwait, __asyncScope, __asyncScopeEnd } from "../src/runtime/async-context.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = () => new Promise((r) => setTimeout(r, 5));
const micro = () => Promise.resolve();

Deno.test("scoping mode: an urgent update in the pending window stays URGENT (the fix)", async () => {
  __setAsyncContextScoping(true);
  try {
    const { doc, container } = makeDom();
    setDocument(doc as Any);

    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => (resolveGate = r));
    let startAsync: () => void = () => {};
    let urgent: () => void = () => {};

    const App = (): VNode => {
      const [, start] = useTransition();
      const [n, setN] = useState(0);
      startAsync = () =>
        start(async () => {
          // desugared `await gate; setN(+10)`
          const $ = __asyncScope();
          try {
            await __asyncAwait($, gate);
            setN((x) => x + 10);
          } finally {
            __asyncScopeEnd($);
          }
        });
      urgent = () => setN((x) => x + 1);
      return h("span", null, String(n));
    };

    createRoot(container as Any).render(h(App, null));
    flushSync();
    assertEquals(container.innerHTML, "<span>0</span>");

    // Begin the async transition; its post-await work is gated (not run yet).
    startAsync();
    await micro();

    // An unrelated urgent update fires WHILE the async transition is pending. Under
    // identity scoping it is NOT inside the transition's context, so it stays on the
    // sync lane and flushSync applies it immediately. (In window mode it would have
    // been demoted to TransitionLane and flushSync would leave it at 0 — the bug.)
    urgent();
    flushSync();
    assertEquals(
      container.innerHTML,
      "<span>1</span>",
      "urgent update in the window is sync, not demoted",
    );

    // The gated transition then applies its +10 on the transition flush.
    resolveGate();
    await tick();
    await tick();
    assertEquals(container.innerHTML, "<span>11</span>", "transition update lands on top");
  } finally {
    __setAsyncContextScoping(false);
  }
});

Deno.test("scoping mode: a post-await update IS still a transition (identity works)", async () => {
  __setAsyncContextScoping(true);
  try {
    const { doc, container } = makeDom();
    setDocument(doc as Any);

    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => (resolveGate = r));
    let go: () => void = () => {};

    const App = (): VNode => {
      const [, start] = useTransition();
      const [n, setN] = useState(0);
      go = () =>
        start(async () => {
          const $ = __asyncScope();
          try {
            await __asyncAwait($, gate);
            setN((x) => x + 1); // runs post-await, inside the transition context
          } finally {
            __asyncScopeEnd($);
          }
        });
      return h("span", null, String(n));
    };

    createRoot(container as Any).render(h(App, null));
    flushSync();
    assertEquals(container.innerHTML, "<span>0</span>");

    go();
    resolveGate();
    await micro();
    await micro();
    // The post-await setState is a transition: not applied on the urgent microtask.
    assertEquals(container.innerHTML, "<span>0</span>", "deferred to the transition flush");

    await tick();
    await tick();
    assertEquals(container.innerHTML, "<span>1</span>", "transition flush applies it");
  } finally {
    __setAsyncContextScoping(false);
  }
});

Deno.test("scoping mode: no trailing leak — an urgent update after settle is sync", async () => {
  __setAsyncContextScoping(true);
  try {
    const { doc, container } = makeDom();
    setDocument(doc as Any);

    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => (resolveGate = r));
    let startAsync: () => void = () => {};
    let urgent: () => void = () => {};

    const App = (): VNode => {
      const [, start] = useTransition();
      const [n, setN] = useState(0);
      startAsync = () =>
        start(async () => {
          const $ = __asyncScope();
          try {
            await __asyncAwait($, gate);
            setN((x) => x + 10);
          } finally {
            __asyncScopeEnd($);
          }
        });
      urgent = () => setN((x) => x + 1);
      return h("span", null, String(n));
    };

    createRoot(container as Any).render(h(App, null));
    flushSync();

    startAsync();
    resolveGate();
    await tick();
    await tick();
    assertEquals(container.innerHTML, "<span>10</span>", "async transition applied +10");

    // If the settled transition had leaked its context globally, this plain setState
    // would read the transition id and be demoted. It must be sync.
    urgent();
    flushSync();
    assertEquals(
      container.innerHTML,
      "<span>11</span>",
      "urgent is sync once the transition settled",
    );
  } finally {
    __setAsyncContextScoping(false);
  }
});
