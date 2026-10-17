// React 19.2's `useEffectEvent` semantics (ported from React's `ReactUseEffectEvent-test`):
// calling an Effect Event during render throws, and its handler is swapped in when the render
// commits — before layout effects — so a render that never commits leaves the old one.

import "./helpers/class-runtime.ts";
import { assertEquals } from "@std/assert";
import { Component, useLayoutEffect } from "../src/compat/react.ts";
import { useEffectEvent, useState } from "../src/runtime/hooks.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("react: useEffectEvent throws when called during render (React 19.2's error)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let thrown: unknown;
  function App() {
    const onEvent = useEffectEvent(() => 1);
    try {
      onEvent();
    } catch (e) {
      thrown = e;
    }
    return h("p", null, "x");
  }
  const root = createRoot(container as Any);
  root.render(h(App, null));
  assertEquals(
    (thrown as Error)?.message,
    "A function wrapped in useEffectEvent can't be called during rendering.",
  );
  root.unmount();
});

Deno.test("react: useEffectEvent swaps its handler at commit — a discarded render leaves the old one", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let bump = () => {};
  let onEvent: () => number = () => -1;
  class Boundary extends Component<{ children?: unknown }, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    override render() {
      return this.state.failed ? h("p", null, "failed") : (this.props.children as Any);
    }
  }
  function Child() {
    const [n, setN] = useState(0);
    bump = () => setN(1);
    const ev = useEffectEvent(() => n);
    if (n === 1) throw new Error("render 1 never commits");
    onEvent = ev;
    return h("p", null, String(n));
  }
  const root = createRoot(container as Any);
  root.render(h(Boundary as Any, null, h(Child, null)));
  assertEquals(onEvent(), 0);
  bump();
  flushSync();
  assertEquals(container.innerHTML, "<p>failed</p>");
  // React keeps the committed handler: the render that saw n = 1 was thrown away.
  assertEquals(onEvent(), 0);
  root.unmount();
});

Deno.test("react: useEffectEvent — a layout effect already sees the handler of its own commit", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const seen: number[] = [];
  let bump = () => {};
  function App() {
    const [n, setN] = useState(0);
    bump = () => setN((x) => x + 1);
    const onCommit = useEffectEvent(() => seen.push(n));
    useLayoutEffect(() => {
      onCommit();
    });
    return h("p", null, String(n));
  }
  const root = createRoot(container as Any);
  root.render(h(App, null));
  bump();
  flushSync();
  assertEquals(seen, [0, 1]);
  root.unmount();
});
