// The render/commit path allocates less per render without changing behaviour: an element keeps
// the props object JSX passed it (copied only to write a key or defaultProps), useCallback keeps
// `fn` itself, a provider links one ContextScope instead of copying its parent's map, pass 2 of
// child reconciliation tracks reuse by position (no Set, no index map), children that need no
// flattening are reconciled from the array they came in, and a queued hook effect is one object.
// Each test pins the behaviour the cheaper path must keep.

import { assert, assertEquals, assertNotStrictEquals, assertStrictEquals } from "@std/assert";
import "./helpers/activity-runtime.ts";
import { Fragment, h, jsx } from "../src/jsx/jsx-runtime.ts";
import { Activity } from "../src/runtime/react-extras.ts";
import { createContext } from "../src/runtime/context.ts";
import { memo, shallowEqualProps } from "../src/runtime/memo.ts";
import { useCallback, useContext, useEffect, useState } from "../src/runtime/hooks.ts";
import { renderToStringSync } from "../src/jsx/render-to-string.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { ContextScope } from "../src/client/context-map.ts";
import { childScopes, normalizeChildrenScoped } from "../src/client/vnode-utils.ts";
import { render } from "../src/testing/mod.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ---- Elements -----------------------------------------------------------------------------

Deno.test("jsx keeps the props object it is given when nothing must be written into it", () => {
  const props = { className: "a", children: "x" };
  const el = jsx("div", props);
  assertStrictEquals(el.props, props);
  assertEquals(el.key, null);
  // A key inside the props is still the element's key.
  const keyed = { key: "k", id: "b" };
  assertEquals(jsx("div", keyed).key, "k");
});

Deno.test("jsx copies the props before writing a separately passed key", () => {
  const props = { id: "a" };
  const el = jsx("li", props, "row-1");
  assertNotStrictEquals(el.props, props);
  assertEquals(el.key, "row-1");
  assertEquals((el.props as Record<string, unknown>).key, "row-1");
  assertEquals(props, { id: "a" }, "the caller's object is never written");
});

Deno.test("jsx copies the props before applying defaultProps (also through memo)", () => {
  function Button(p: { size?: string; label: string }): VNode {
    return h("button", null, `${p.label}:${p.size}`);
  }
  Button.defaultProps = { size: "md" };
  const props = { label: "go" };
  const el = jsx(Button as Any, props);
  assertNotStrictEquals(el.props, props);
  assertEquals((el.props as Record<string, unknown>).size, "md");
  assertEquals(props, { label: "go" });
  const viaMemo = jsx(memo(Button) as Any, { label: "m" });
  assertEquals((viaMemo.props as Record<string, unknown>).size, "md");
});

Deno.test("h builds one props object of its own and keeps its key", () => {
  const props = { key: 3, id: "x" };
  const el = h("p", props, "a", "b");
  assertNotStrictEquals(el.props, props);
  assertEquals(el.key, 3);
  assertEquals((el.props as Record<string, unknown>).children, ["a", "b"]);
  assertEquals(props, { key: 3, id: "x" });
});

// ---- Children normalization ---------------------------------------------------------------

Deno.test("a flat element list is reconciled from the array it came in", () => {
  const list = [h("a", null), h("b", null)];
  assertStrictEquals(normalizeChildrenScoped(list), list);
  assertEquals(childScopes, null);
  const mixed = [h("a", null), "text", [h("b", { key: 1 })], null];
  const nodes = normalizeChildrenScoped(mixed as Any);
  assertEquals(nodes.length, 3);
  assertEquals(childScopes, [undefined, undefined, "2"]);
  assertEquals(normalizeChildrenScoped(null), []);
  assertEquals(childScopes, null);
});

// ---- useCallback --------------------------------------------------------------------------

Deno.test("useCallback returns fn itself and keeps it until deps change", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const seen: Array<() => number> = [];
  let set: (n: number) => void = () => {};
  let bump: () => void = () => {};
  function App(): VNode {
    const [dep, setDep] = useState(0);
    const [, setTick] = useState(0);
    set = setDep;
    bump = () => setTick((t) => t + 1);
    const fn = () => dep;
    const cb = useCallback(fn, [dep]);
    seen.push(cb);
    assert(seen.length > 1 || cb === fn, "the first render returns the very function given");
    return h("i", null, String(cb()));
  }
  const root = createRoot(container as Any);
  root.render(h(App, null));
  flushSync();
  bump();
  flushSync();
  assertStrictEquals(seen[1], seen[0], "unchanged deps keep the first callback");
  set(1);
  flushSync();
  assertNotStrictEquals(seen[2], seen[0], "changed deps take the new callback");
  assertEquals((container as FakeElement).textContent, "1");
  root.unmount();
});

Deno.test("useCallback renders on the server (a dispatcher without its own useCallback)", () => {
  function App(): VNode {
    const cb = useCallback(() => "ok", []);
    return h("b", null, cb());
  }
  assertEquals(renderToStringSync(h(App, null)), "<b>ok</b>");
});

// ---- Context scopes -----------------------------------------------------------------------

Deno.test("ContextScope reads the nearest provider of an id and falls back to its base", () => {
  const a = Symbol("a");
  const b = Symbol("b");
  const base = new Map<symbol, unknown>([[a, "base-a"]]);
  const outer = new ContextScope(base, b, "outer-b");
  const inner = new ContextScope(outer, b, undefined);
  assertEquals(inner.get(a), "base-a");
  assert(inner.has(b), "a provider of undefined still provides");
  assertEquals(inner.get(b), undefined);
  assertEquals(outer.get(b), "outer-b");
  assert(!outer.has(Symbol("c")));
});

Deno.test("nested providers shadow, siblings stay apart, and a changed value reaches its consumers", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const Theme = createContext("none");
  const Size = createContext(0);
  const renders: string[] = [];
  const Leaf = memo(function Leaf(p: { id: string }): VNode {
    renders.push(p.id);
    return h("i", null, `${p.id}:${useContext(Theme)}/${useContext(Size)}`);
  });
  let setTheme: (t: string) => void = () => {};
  function App(): VNode {
    const [theme, set] = useState("dark");
    setTheme = set;
    return h(
      Fragment,
      null,
      h(
        Theme.Provider,
        { value: theme },
        h(Size.Provider, { value: 2 }, h(Leaf, { id: "a" })),
        h(Theme.Provider, { value: "inner" }, h(Leaf, { id: "b" })),
      ),
      h(Leaf, { id: "c" }),
    );
  }
  const root = createRoot(container as Any);
  root.render(h(App, null));
  flushSync();
  assertEquals((container as FakeElement).textContent, "a:dark/2b:inner/0c:none/0");
  renders.length = 0;
  setTheme("light");
  flushSync();
  assertEquals((container as FakeElement).textContent, "a:light/2b:inner/0c:none/0");
  assert(renders.includes("a"), "the consumer whose context value changed re-rendered");
  assert(!renders.includes("b"), "the shadowed consumer's value did not change: it bailed");
  root.unmount();
});

// ---- Pass 2 of child reconciliation: reuse tracked by position, short and long lists -------

/**
 * Render `before`, then `after`, as the children of one `<ul>`, each child an `<li>` (or a
 * `<p>` for a `p:` id) with an optional key; returns which `after` children kept the element
 * the same position… of `before` had (by before-index, -1 for a new one).
 */
function reuseMap(
  before: Array<{ key?: unknown; tag?: string }>,
  after: Array<{ key?: unknown; tag?: string }>,
  nested = false,
): number[] {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const kids = (list: Array<{ key?: unknown; tag?: string }>) => {
    const els = list.map((c, i) => h(c.tag ?? "li", { key: c.key as Any, "data-i": i }));
    return (nested ? [els] : els) as Any;
  };
  const root = createRoot(container as Any);
  root.render(h("ul", null, kids(before)));
  flushSync();
  const ul = (container as FakeElement).childNodes[0] as FakeElement;
  const first = [...ul.childNodes];
  root.render(h("ul", null, kids(after)));
  flushSync();
  const out = [...ul.childNodes].map((n) => first.indexOf(n));
  root.unmount();
  return out;
}

/** `n` unkeyed `<li>` children. */
function filler(n: number): Array<{ key?: unknown; tag?: string }> {
  return Array.from({ length: n }, () => ({}));
}

for (const pad of [0, 30]) {
  const label = pad === 0 ? "a short list" : "a long list";
  Deno.test(`${label}: a front insert of another type keeps every same-type sibling`, () => {
    const before = [...filler(3), ...filler(pad)];
    const after = [{ tag: "p" }, ...filler(3), ...filler(pad)];
    assertEquals(
      reuseMap(before, after),
      [-1, ...Array.from({ length: 3 + pad }, (_, i) => i)],
    );
  });

  Deno.test(`${label}: a reorder keeps keyed elements and a duplicate key matches its last holder`, () => {
    const before = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "c" }, ...filler(pad)];
    const after = [{ key: "c" }, { key: "a" }, { key: "x" }, { key: "c" }, ...filler(pad)];
    const got = reuseMap(before, after);
    assertEquals(got.slice(0, 4), [3, 0, -1, -1]);
  });

  Deno.test(`${label}: a direct key 1 and "1" differ; in a nested array they collide`, () => {
    const before = [{ key: 1 }, { key: "z" }, ...filler(pad)];
    const after = [{ key: "z" }, { key: "1" }, ...filler(pad)];
    assertEquals(reuseMap(before, after).slice(0, 2), [1, -1]);
    assertEquals(reuseMap(before, after, true).slice(0, 2), [1, 0]);
  });

  Deno.test(`${label}: a removed key is deleted and the rest move`, () => {
    const before = [{ key: "a" }, { key: "b" }, { key: "c" }, ...filler(pad)];
    const after = [{ key: "c" }, { key: "a" }, ...filler(pad)];
    assertEquals(reuseMap(before, after).slice(0, 2), [2, 0]);
  });
}

// ---- Hook effects -------------------------------------------------------------------------

Deno.test("all effect cleanups run before any setup, and the latest effect reconnects after a hide", async () => {
  const log: string[] = [];
  let setMode: (m: "visible" | "hidden") => void = () => {};
  let setDep: (n: number) => void = () => {};
  function Probe(p: { name: string; dep: number }): VNode {
    useEffect(() => {
      log.push(`setup ${p.name}${p.dep}`);
      return () => log.push(`cleanup ${p.name}${p.dep}`);
    }, [p.dep]);
    return h("span", null, p.name);
  }
  function App(): VNode {
    const [mode, setM] = useState<"visible" | "hidden">("visible");
    const [dep, setD] = useState(0);
    setMode = setM;
    setDep = setD;
    return h(
      Activity,
      {
        mode,
        children: [h(Probe, { key: "a", name: "a", dep }), h(Probe, { key: "b", name: "b", dep })],
      },
    );
  }
  const screen = await render(h(App, null));
  assertEquals(log, ["setup a0", "setup b0"]);
  log.length = 0;
  await screen.act(() => setDep(1));
  assertEquals(log, ["cleanup a0", "cleanup b0", "setup a1", "setup b1"]);
  log.length = 0;
  await screen.act(() => setMode("hidden"));
  assertEquals(log.sort(), ["cleanup a1", "cleanup b1"]);
  log.length = 0;
  await screen.act(() => setMode("visible"));
  assertEquals(log.sort(), ["setup a1", "setup b1"], "the reveal re-runs the committed effect");
  await screen.unmount();
});

// ---- The memo bailout comparator ----------------------------------------------------------

Deno.test("shallowEqualProps compares own keys and values, not just their count", () => {
  assert(shallowEqualProps({ a: 1, b: "x" }, { b: "x", a: 1 }));
  assert(!shallowEqualProps({ a: 1, b: 2 }, { a: 1, c: 2 }));
  assert(!shallowEqualProps({ a: 1 }, { a: 1, b: undefined }));
  assert(!shallowEqualProps({ a: 1, b: undefined }, { a: 1 }));
  assert(!shallowEqualProps({ a: NaN, b: 0 }, { a: NaN, b: -0 }));
  assert(shallowEqualProps({ a: NaN }, { a: NaN }));
  const proto = { inherited: 1 };
  assert(shallowEqualProps(Object.assign(Object.create(proto), { a: 1 }), { a: 1 }));
});
