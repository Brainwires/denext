// A provider's value change re-renders only the consumers INSIDE that provider's subtree.
// The propagation walk follows `return` pointers back up to the provider; a child shared
// from the other buffer (a bailed parent re-links nothing) still points at that buffer's
// parent, so the walk used to climb past the provider and mark consumers elsewhere — a memo
// consumer beside the provider, or under another provider of the same context, re-rendered
// on every change. The walk now re-points each fiber's `return` as it goes, as React's does.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createPortal, createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { createContext } from "../src/runtime/context.ts";
import { memo } from "../src/runtime/memo.ts";
import { useContext, useState } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function mount(app: VNode): FakeElement {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(app);
  flushSync();
  return container;
}

Deno.test("consumers outside a changed provider stay put across many commits", () => {
  const Theme = createContext("default");
  const renders: string[] = [];
  const Reader = memo(function Reader(p: { id: string }): VNode {
    renders.push(p.id);
    return h("i", null, `${p.id}=${useContext(Theme)};`);
  });
  const Plain = memo(function Plain(p: { children?: VNode }): VNode {
    return h("div", null, p.children); // reads nothing: bails between provider and consumer
  });
  let setTheme: (t: string) => void = () => {};
  function App(): VNode {
    const [theme, set] = useState("t0");
    setTheme = set;
    return h(
      "main",
      null,
      h(Theme.Provider, { value: theme }, h(Plain, null, h(Reader, { id: "a" }))),
      h(Reader, { id: "c" }), // the default value
      h(Theme.Provider, { value: "fixed" }, h(Plain, null, h(Reader, { id: "d" }))),
    );
  }
  const container = mount(h(App, null));
  assertEquals(container.textContent, "a=t0;c=default;d=fixed;");
  // Several commits, so the walk runs from both buffers of every fiber.
  for (let i = 1; i <= 6; i++) {
    renders.length = 0;
    setTheme(`t${i}`);
    flushSync();
    assertEquals(renders, ["a"], `commit ${i}`);
    assertEquals(container.textContent, `a=t${i};c=default;d=fixed;`);
  }
});

Deno.test("a nested provider of the same context shadows the outer one, both ways", () => {
  const Ctx = createContext(0);
  const renders: string[] = [];
  const Reader = memo(function Reader(p: { id: string }): VNode {
    renders.push(p.id);
    return h("i", null, `${p.id}=${useContext(Ctx)};`);
  });
  let setOuter: (n: number) => void = () => {};
  let setInner: (n: number) => void = () => {};
  function Inner(): VNode {
    const [n, set] = useState(100);
    setInner = set;
    return h(Ctx.Provider, { value: n }, h("p", null, h(Reader, { id: "in" })));
  }
  const MemoInner = memo(Inner);
  function App(): VNode {
    const [n, set] = useState(1);
    setOuter = set;
    return h(
      Ctx.Provider,
      { value: n },
      h(Reader, { id: "out1" }),
      h(MemoInner, null),
      h(Reader, { id: "out2" }),
    );
  }
  const container = mount(h(App, null));
  for (let i = 2; i <= 5; i++) {
    renders.length = 0;
    setOuter(i);
    flushSync();
    assertEquals(renders, ["out1", "out2"], `outer change ${i}`);
    renders.length = 0;
    setInner(100 + i);
    flushSync();
    assertEquals(renders, ["in"], `inner change ${i}`);
    assertEquals(container.textContent, `out1=${i};in=${100 + i};out2=${i};`);
  }
});

Deno.test("a consumer in a portal inside the provider re-renders; one outside does not", () => {
  const Ctx = createContext("none");
  const renders: string[] = [];
  const Reader = memo(function Reader(p: { id: string }): VNode {
    renders.push(p.id);
    return h("i", null, `${p.id}=${useContext(Ctx)};`);
  });
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const slot = doc.createElement("aside");
  let setV: (v: string) => void = () => {};
  function App(): VNode {
    const [v, set] = useState("v0");
    setV = set;
    return h(
      "div",
      null,
      h(Ctx.Provider, { value: v }, createPortal(h(Reader, { id: "portal" }) as Any, slot as Any)),
      createPortal(h(Reader, { id: "outside" }) as Any, slot as Any),
    );
  }
  createRoot(container as Any).render(h(App, null));
  flushSync();
  for (let i = 1; i <= 4; i++) {
    renders.length = 0;
    setV(`v${i}`);
    flushSync();
    assertEquals(renders, ["portal"], `commit ${i}`);
    assertEquals(slot.textContent, `portal=v${i};outside=none;`);
  }
});

Deno.test("200 memo rows, half outside the provider: only the inside half re-renders", () => {
  const Router = createContext("/");
  let renders = 0;
  const Row = memo(function Row(p: { i: number }): VNode {
    renders++;
    return h("li", null, `${p.i}${useContext(Router)}`);
  });
  const rows = (from: number): VNode[] =>
    Array.from({ length: 100 }, (_, k) => h(Row, { key: from + k, i: from + k }));
  const Rows = memo(function Rows(p: { from: number }): VNode {
    return h("ul", null, rows(p.from));
  });
  let navigate: (path: string) => void = () => {};
  function App(): VNode {
    const [path, set] = useState("/a");
    navigate = set;
    return h(
      "div",
      null,
      h(Router.Provider, { value: path }, h(Rows, { from: 0 })),
      h(Rows, { from: 100 }),
    );
  }
  mount(h(App, null));
  const counts: number[] = [];
  for (const path of ["/b", "/c", "/d", "/e"]) {
    renders = 0;
    navigate(path);
    flushSync();
    counts.push(renders);
  }
  assertEquals(counts, [100, 100, 100, 100]);
});
