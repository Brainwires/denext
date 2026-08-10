// StrictMode dev double-invoke: under a <StrictMode> subtree in development the
// reconciler renders components twice and mounts effects setup→cleanup→setup, to
// surface impure renders and missing cleanup. In production (no __denextDev) it is
// a transparent Fragment.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useEffect, useState } from "../mod.ts";
import { StrictMode } from "../src/runtime/strict-mode.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("StrictMode double-invokes render and mount effects in dev", () => {
  (globalThis as Any).__denextDev = true;
  try {
    const { doc, container } = makeDom();
    setDocument(doc as Any);

    let renders = 0;
    let setups = 0;
    let cleanups = 0;
    const Widget = (): VNode => {
      renders++;
      useEffect(() => {
        setups++;
        return () => {
          cleanups++;
        };
      }, []);
      return h("span", null, "x");
    };

    createRoot(container as Any).render(h(StrictMode, null, h(Widget, null)));
    flushSync(); // flush passive effects

    assertEquals(renders, 2, "render double-invoked");
    assertEquals(setups, 2, "effect setup ran on mount and remount");
    assertEquals(cleanups, 1, "effect cleaned up once between mount and remount");
    assertEquals(container.innerHTML, "<span>x</span>", "output unaffected");
  } finally {
    delete (globalThis as Any).__denextDev;
  }
});

Deno.test("StrictMode does not double-invoke on later updates, only on mount", () => {
  (globalThis as Any).__denextDev = true;
  try {
    const { doc, container } = makeDom();
    setDocument(doc as Any);

    let setups = 0;
    let setVal: (v: number) => void = () => {};
    const Widget = (): VNode => {
      const [n, set] = useState(0);
      setVal = (v) => set(() => v);
      useEffect(() => {
        setups++;
      }, [n]);
      return h("span", null, String(n));
    };

    createRoot(container as Any).render(h(StrictMode, null, h(Widget, null)));
    flushSync();
    assertEquals(setups, 2, "mount: setup ran twice (strict remount)");

    setVal(1);
    flushSync();
    assertEquals(setups, 3, "update: setup ran once (no strict remount after mount)");
  } finally {
    delete (globalThis as Any).__denextDev;
  }
});

Deno.test("StrictMode is a transparent Fragment without the dev flag", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let renders = 0;
  let setups = 0;
  const Widget = (): VNode => {
    renders++;
    useEffect(() => {
      setups++;
    }, []);
    return h("span", null, "x");
  };

  createRoot(container as Any).render(h(StrictMode, null, h(Widget, null)));
  flushSync();

  assertEquals(renders, 1, "single render in production");
  assertEquals(setups, 1, "single effect mount in production");
  assertEquals(container.innerHTML, "<span>x</span>");
});
