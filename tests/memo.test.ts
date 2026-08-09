// Memoization foundation: the reconciler's component bailout, memo(), and
// useMemoCache — verified with render-count spies against the in-memory DOM shim.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { MEMO_CACHE_SENTINEL, useContext, useMemoCache, useState } from "../src/runtime/hooks.ts";
import { memo, shallowEqualProps } from "../src/runtime/memo.ts";
import { createContext } from "../src/runtime/context.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

/** Depth-first find the first descendant element with the given tag. */
function find(root: FakeElement, tag: string): FakeElement {
  const up = tag.toUpperCase();
  // deno-lint-ignore no-explicit-any
  const stack: any[] = [...root.childNodes];
  while (stack.length) {
    const n = stack.shift();
    if (n && n.tagName === up) return n as FakeElement;
    if (n && n.childNodes) stack.unshift(...n.childNodes);
  }
  throw new Error(`no <${tag}> found`);
}

Deno.test("shallowEqualProps compares keys and values", () => {
  assert(shallowEqualProps({ a: 1, b: "x" }, { a: 1, b: "x" }));
  assert(!shallowEqualProps({ a: 1 }, { a: 2 }));
  assert(!shallowEqualProps({ a: 1 }, { a: 1, b: 2 }));
  const obj = {};
  assert(shallowEqualProps({ a: obj }, { a: obj }));
  assert(!shallowEqualProps({ a: {} }, { a: {} }), "distinct object refs differ");
});

Deno.test("auto-bailout: a component with stable props is not re-rendered on a parent update", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  let childRenders = 0;

  function Child(props: { label: string }): VNode {
    childRenders++;
    return h("span", null, props.label);
  }
  function Parent(): VNode {
    const [n, setN] = useState(0);
    return h(
      "div",
      null,
      h("button", { onClick: () => setN(n + 1) }, String(n)),
      h(Child, { label: "static" }),
    );
  }

  const root = createRoot(asEl(container));
  root.render(h(Parent, null));
  assertEquals(childRenders, 1);

  // Bump the parent's state a few times; Child's props never change.
  for (let i = 0; i < 3; i++) {
    (find(container, "button") as FakeElement).dispatch("click");
    flushSync();
  }
  assertEquals(childRenders, 1, "Child should not re-render when its props are stable");
  root.unmount();
});

Deno.test("auto-bailout releases when props actually change", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  let childRenders = 0;

  function Child(props: { n: number }): VNode {
    childRenders++;
    return h("span", null, String(props.n));
  }
  function Parent(): VNode {
    const [n, setN] = useState(0);
    return h(
      "div",
      null,
      h("button", { onClick: () => setN(n + 1) }, "+"),
      h(Child, { n }),
    );
  }

  const root = createRoot(asEl(container));
  root.render(h(Parent, null));
  assertEquals(childRenders, 1);

  (find(container, "button") as FakeElement).dispatch("click");
  flushSync();
  assertEquals(childRenders, 2, "changed prop re-renders the child");
  assertEquals(find(container, "span")!.innerHTML, "1");
  root.unmount();
});

Deno.test("memo() with a custom comparator controls re-render", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  let childRenders = 0;

  // Only re-render when `id` changes; ignore `version`.
  const Child = memo(
    function Child(props: { id: number; version: number }): VNode {
      childRenders++;
      return h("span", null, `${props.id}:${props.version}`);
    },
    (prev, next) => prev.id === next.id,
  );

  function Parent(): VNode {
    const [version, setVersion] = useState(0);
    return h(
      "div",
      null,
      h("button", { onClick: () => setVersion(version + 1) }, "+"),
      h(Child, { id: 1, version }),
    );
  }

  const root = createRoot(asEl(container));
  root.render(h(Parent, null));
  assertEquals(childRenders, 1);

  // version changes, but the comparator says "equal" → no re-render.
  (find(container, "button") as FakeElement).dispatch("click");
  flushSync();
  assertEquals(childRenders, 1, "custom comparator suppressed the re-render");
  root.unmount();
});

Deno.test("a context change still reaches a deep consumer past a bailed intermediate", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const Ctx = createContext("a");
  let middleRenders = 0;

  function Consumer(): VNode {
    const v = useContext(Ctx);
    return h("span", null, v);
  }
  // Middle takes no props and does NOT read the context; without correct
  // context-aware bailout it would wrongly skip re-rendering when the value
  // changes, stranding Consumer on the old value.
  const Middle = memo(function Middle(): VNode {
    middleRenders++;
    return h(Consumer, null);
  });

  function App(): VNode {
    const [v, setV] = useState("a");
    return h(
      "div",
      null,
      h("button", { onClick: () => setV(v === "a" ? "b" : "a") }, "toggle"),
      h(Ctx.Provider, { value: v }, h(Middle, null)),
    );
  }

  const root = createRoot(asEl(container));
  root.render(h(App, null));
  assertEquals(find(container, "span")!.innerHTML, "a");
  assertEquals(middleRenders, 1);

  // Change the context value: Middle must re-render so Consumer reads "b".
  (find(container, "button") as FakeElement).dispatch("click");
  flushSync();
  assertEquals(find(container, "span")!.innerHTML, "b", "consumer saw the new value");
  assertEquals(middleRenders, 2, "the intermediate re-rendered to propagate the context change");
  root.unmount();
});

Deno.test("an unchanged context does not force a memoized intermediate to re-render", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const Ctx = createContext("const");
  let middleRenders = 0;

  function Consumer(): VNode {
    return h("span", null, useContext(Ctx));
  }
  const Middle = memo(function Middle(): VNode {
    middleRenders++;
    return h(Consumer, null);
  });

  function App(): VNode {
    const [n, setN] = useState(0);
    // The provider value is a constant; only unrelated state changes.
    return h(
      "div",
      null,
      h("button", { onClick: () => setN(n + 1) }, String(n)),
      h(Ctx.Provider, { value: "const" }, h(Middle, null)),
    );
  }

  const root = createRoot(asEl(container));
  root.render(h(App, null));
  assertEquals(middleRenders, 1);

  for (let i = 0; i < 3; i++) {
    (find(container, "button") as FakeElement).dispatch("click");
    flushSync();
  }
  assertEquals(middleRenders, 1, "stable context + stable props → the memoized subtree is skipped");
  root.unmount();
});

Deno.test("useMemoCache returns a stable, sentinel-initialized array", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const seen: unknown[][] = [];
  let sentinelAtFirst = false;

  function Comp(): VNode {
    const [n, setN] = useState(0);
    const cache = useMemoCache(3);
    if (n === 0) sentinelAtFirst = cache.every((s) => s === MEMO_CACHE_SENTINEL);
    seen.push(cache);
    return h("button", { onClick: () => setN(n + 1) }, String(n));
  }

  const root = createRoot(asEl(container));
  root.render(h(Comp, null));
  assert(sentinelAtFirst, "slots start as the sentinel");

  (find(container, "button") as FakeElement).dispatch("click");
  flushSync();
  assertEquals(seen.length, 2);
  assertStrictEquals(seen[0], seen[1], "the same cache array persists across renders");
  root.unmount();
});
