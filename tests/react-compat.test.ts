// React-compat entrypoints: `import ... from "react"` / "react-dom" resolving to
// denext. Exercises the compat surface (createElement, hooks, Children,
// cloneElement, forwardRef, isValidElement, class-component guard, react-dom).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import React, {
  cache,
  Children,
  cloneElement,
  Component,
  createContext,
  createElement,
  forwardRef,
  Fragment,
  isValidElement,
  lazy,
  PureComponent,
  useContext,
  useReducer,
  useState,
  version,
} from "../src/compat/react.ts";
import ReactDOM, {
  createPortal,
  createRoot,
  hydrateRoot,
  render,
} from "../src/compat/react-dom.ts";
import { useEffectEvent } from "../src/runtime/hooks.ts";
import { createRoot as clientCreateRoot } from "../src/compat/react-dom-client.ts";
import ReactDOMClient from "../src/compat/react-dom-client.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../src/jsx/types.ts";
import { lazy as denextLazy } from "../src/runtime/dynamic.ts";
import { useState as denextUseState } from "../src/runtime/hooks.ts";
import { flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("react: createElement is denext's h and produces a VNode", () => {
  assertEquals(createElement, h);
  const el = createElement("div", { class: "x" }, "hi");
  assert(isValidElement(el));
  assertEquals(el.type, "div");
});

Deno.test("react: hooks are the real denext hooks (same identity)", () => {
  assertEquals(useState, denextUseState);
  assertEquals(lazy, denextLazy); // React.lazy is the real suspending lazy (not dynamic)
  assertEquals(version, "19.2.0");
});

Deno.test("react: default export exposes the React namespace", () => {
  for (const k of ["createElement", "Fragment", "useState", "useEffect", "memo", "createContext"]) {
    assert(k in React, `React.${k} missing`);
  }
  assertEquals(React.createElement, createElement);
  assertEquals(React.Fragment, Fragment);
});

Deno.test("react: Children utilities flatten and count", () => {
  const kids = ["a", ["b", null, "c"], false, "d"];
  assertEquals(Children.count(kids as Any), 4);
  assertEquals(Children.toArray(kids as Any), ["a", "b", "c", "d"]);
  assertEquals(Children.map(kids as Any, (c) => `${c}!`), ["a!", "b!", "c!", "d!"]);
  assertEquals(Children.only(["solo"] as Any), "solo");
  assertThrows(() => Children.only(["a", "b"] as Any));
});

// React's `mapChildren` key scheme (React 18/19 `getElementKey` + `escapeUserProvidedKey`):
// `.` + (escaped user key `$k` | base-36 index), `:` between nested-array levels.
Deno.test("react: Children.toArray re-keys elements by position like React", () => {
  const a = h("a", null), b = h("b", null), c = h("c", null);
  const out = Children.toArray([a, [b, c]] as Any) as VNode[];
  assertEquals(out.map((e) => e.key), [".0", ".1:0", ".1:1"]);
  assertEquals(out.map((e) => e.type), ["a", "b", "c"]);
  // Output elements are branded clones; the caller's vnodes keep their authored key.
  assert(out.every(isValidElement));
  assert(out[0] !== a && out[1] !== b);
  assertEquals([a.key, b.key, c.key], [null, null, null]);
  // Strings/numbers pass through untouched; holes are dropped (as before).
  assertEquals(Children.toArray(["s", 3, null, false] as Any), ["s", 3]);
  // A lone child is named as if wrapped in an array; indexes are base 36.
  assertEquals((Children.toArray(h("a", null)) as VNode[])[0].key, ".0");
  const many = Children.toArray(Array.from({ length: 11 }, () => h("i", null))) as VNode[];
  assertEquals(many[10].key, ".a");
  // Positional derivation is deterministic: the same tree always yields the same keys.
  assertEquals(
    (Children.toArray([a, [b, c]] as Any) as VNode[]).map((e) => e.key),
    out.map((e) => e.key),
  );
});

Deno.test("react: Children.toArray escapes user keys like React", () => {
  const out = Children.toArray(
    [h("a", { key: "x" }), [h("b", { key: "a:b=c" }), h("c", { key: 7 })]] as Any,
  ) as VNode[];
  assertEquals(out.map((e) => e.key), [".$x", ".1:$a=2b=0c", ".1:$7"]);
});

Deno.test("react: Children.map re-keys returned elements with React's combined `/` form", () => {
  const kids = [h("a", { key: "x" }), h("a", null), "s"];
  // Callback returns the input (or an element with the same key): positional key only.
  const same = Children.map(kids as Any, (c) => c) as VNodeChild[];
  assertEquals(same.map((e) => isValidElement(e) ? e.key : e), [".$x", ".1", "s"]);
  // Returns a differently-keyed element: `<mappedKey>/` + positional name.
  const mapped = Children.map(kids as Any, (_c, i) => h("b", { key: `m${i}` })) as VNode[];
  assertEquals(mapped.map((e) => e.key), ["m0/.$x", "m1/.1", "m2/.2"]);
  // Returns an unkeyed element for a keyed input: positional (escaped user) key only.
  const unkeyed = Children.map([h("a", { key: "x" })] as Any, () => h("b", null)) as VNode[];
  assertEquals(unkeyed[0].key, ".$x");
  // A `/` in the mapped key is escaped by doubling so it cannot read as the separator.
  const slash = Children.map([h("a", null)] as Any, () => h("b", { key: "p/q" })) as VNode[];
  assertEquals(slash[0].key, "p//q/.0");
  // Returning an array nests its elements under `<childKey>/`.
  const arr = Children.map(
    [h("a", null)] as Any,
    () => [h("b", null), h("c", null)],
  ) as unknown as VNode[];
  assertEquals(arr.map((e) => e.key), [".0/.0", ".0/.1"]);
  // Null/undefined results are dropped; the callback index counts leaves.
  assertEquals(Children.map(kids as Any, () => null), []);
  const seen: number[] = [];
  Children.map([["a"], null, "b"] as Any, (_c, i) => void seen.push(i));
  assertEquals(seen, [0, 1]);
  // Inputs are never mutated.
  assertEquals((kids[0] as VNode).key, "x");
  assertEquals((kids[1] as VNode).key, null);
});

Deno.test("react: Children.forEach/count/only hand back the authored vnodes (no clones)", () => {
  const a = h("a", { key: "k" });
  const seen: VNodeChild[] = [];
  Children.forEach([a, null, ["s", false]] as Any, (c) => void seen.push(c));
  assertEquals(seen.length, 2);
  assert(seen[0] === a);
  assertEquals(Children.count([a, [null, "s", false], undefined] as Any), 2);
  assert(Children.only([a] as Any) === a);
  assertEquals(a.key, "k");
});

Deno.test("react: cloneElement merges props and replaces children", () => {
  const el = h("button", { type: "button", class: "a" }, "old");
  const cloned = cloneElement(el, { class: "b" }, "new");
  assertEquals((cloned.props as Any).type, "button"); // kept
  assertEquals((cloned.props as Any).class, "b"); // overridden
  assertEquals((cloned.props as Any).children, "new"); // replaced
  assertEquals((el.props as Any).class, "a"); // original untouched
  assert(isValidElement(cloned)); // clone carries the element brand
});

Deno.test("react: cloneElement special-cases key and ref like React", () => {
  const el = h("div", { key: "orig", class: "a" }, "x");
  // No key/ref in config → original key preserved, key not leaked into props.
  const a = cloneElement(el, { class: "b" });
  assertEquals(a.key, "orig");
  assertEquals((a.props as Any).key, undefined);
  // key/ref in config → override; ref threads through props.ref, key stays top-level only.
  const ref = { current: null };
  const b = cloneElement(el, { key: "next", ref });
  assertEquals(b.key, "next");
  assertEquals((b.props as Any).key, undefined);
  assertEquals((b.props as Any).ref, ref);
});

Deno.test("react: isValidElement requires the element brand, not just shape", () => {
  assert(isValidElement(h("div", null)));
  assert(!isValidElement("string"));
  assert(!isValidElement(null));
  assert(!isValidElement({ foo: 1 }));
  // A plain object with an element's shape but no `$$typeof` brand is NOT an element.
  assert(!isValidElement({ type: "div", props: {} }));
});

Deno.test("react: forwardRef is a non-callable element object that threads ref through props", () => {
  let seenRef: unknown = "unset";
  const C = forwardRef<unknown, { ref?: unknown; label: string }>((props, ref) => {
    seenRef = ref;
    return h("span", null, props.label);
  });
  // React's forwardRef result is a non-callable element OBJECT ({ $$typeof, render }),
  // not a function — it is used only as a JSX element type.
  assertEquals(typeof C, "object");
  // Rendering it threads `ref` (from props) into the render fn's second argument.
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const ref = { current: null };
  createRoot(container as Any).render(h(C as Any, { ref, label: "x" }));
  flushSync();
  assertEquals(container.innerHTML, "<span>x</span>");
  assertEquals(seenRef, ref);
});

Deno.test("react: Component/PureComponent are the real base classes (classComponents on)", () => {
  // Un-bundled (tests), the class runtime defaults on, so these are real classes.
  const c = new (Component as Any)({});
  assertEquals(typeof c.setState, "function");
  assertEquals(typeof c.forceUpdate, "function");
  assertThrows(() => c.render(), Error, "render()"); // base render() throws until overridden
  assert(new (PureComponent as Any)({}) instanceof Component);
});

Deno.test("react-dom: exposes the client + legacy API", () => {
  for (const fn of [createRoot, hydrateRoot, render]) assertEquals(typeof fn, "function");
  assertEquals(typeof ReactDOM.flushSync, "function");
  assertEquals(clientCreateRoot, createRoot);
  assertEquals(ReactDOM.version, "19.2.0");
  // `react-dom/client` also exposes a namespace default (CJS-interop parity), so
  // `import ReactDOM from "react-dom/client"; ReactDOM.createRoot(…)` works.
  assertEquals(ReactDOMClient.createRoot, clientCreateRoot);
  assertEquals(typeof ReactDOMClient.hydrateRoot, "function");
});

Deno.test("react-dom: render() mounts via createRoot", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any); // reconciler is DOM-agnostic; point it at the shim
  function App() {
    const [n] = useState(7);
    return h("p", null, String(n));
  }
  render(h(App, null), container as Any);
  assertEquals(container.innerHTML, "<p>7</p>");
});

Deno.test("react-dom: createPortal renders children into a separate container", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const target = doc.createElement("div"); // a node outside the app tree
  function App() {
    return h(
      Fragment,
      null,
      h("i", null, "in place"),
      createPortal(h("span", null, "portaled"), target as Any),
    );
  }
  const root = createRoot(container as Any);
  root.render(h(App, null));
  // Content routed to the target, not rendered where the portal sits.
  assert(!container.innerHTML.includes("portaled"), "portal content must not render in place");
  assert((target as Any).innerHTML.includes("portaled"), "portal content must be in the target");
  assert(container.innerHTML.includes("in place"), "sibling content still renders in place");
  root.unmount();
});

Deno.test("react-dom: createPortal preserves context across the portal boundary", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const target = doc.createElement("div");
  const Ctx = createContext("default");

  function Consumer() {
    const value = useContext(Ctx);
    return h("span", null, value);
  }
  function App() {
    // The portal is declared *inside* the provider, so the portaled Consumer
    // must read the provided value — not the context default (the old sub-root
    // portal lost this).
    return h(
      Ctx.Provider as Any,
      { value: "from-provider" },
      createPortal(h(Consumer, null), target as Any),
    );
  }
  const root = createRoot(container as Any);
  root.render(h(App, null));
  assert(
    (target as Any).innerHTML.includes("from-provider"),
    `portal should see provider context, got: ${(target as Any).innerHTML}`,
  );
  root.unmount();
  assert(
    !(target as Any).innerHTML.includes("from-provider"),
    "unmount should remove portal content from the target",
  );
});

Deno.test("react: useReducer supports the lazy init (3rd arg) — React parity", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function App() {
    // init(initialArg) computes the initial state (5 * 2 = 10).
    const [n] = useReducer((s: number, a: number) => s + a, 5, (arg: number) => arg * 2);
    return h("p", null, String(n));
  }
  createRoot(container as Any).render(h(App, null));
  assertEquals(container.innerHTML, "<p>10</p>");
});

Deno.test("react-dom: flushSync(fn) runs the callback then flushes, returns its value", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const order: string[] = [];
  let bump = () => {};
  function App() {
    const [n, setN] = useState(0);
    bump = () => setN((x) => x + 1);
    order.push("render:" + n);
    return h("p", null, String(n));
  }
  createRoot(container as Any).render(h(App, null));
  order.length = 0;
  // flushSync(fn): the update in fn is committed synchronously before returning.
  const ret = ReactDOM.flushSync(() => {
    bump();
    return "done";
  });
  assertEquals(ret, "done");
  assertEquals(container.innerHTML, "<p>1</p>", "DOM committed synchronously inside flushSync");
  assert(order.includes("render:1"), "component re-rendered during flushSync");
});

Deno.test("react: useEffectEvent — stable identity, always latest state", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const seen: number[] = [];
  const captured: Array<() => void> = [];
  let bump = () => {};
  function App() {
    const [n, setN] = useState(0);
    bump = () => setN((x) => x + 1);
    const onEvent = useEffectEvent(() => seen.push(n));
    captured.push(onEvent);
    return h("p", null, String(n));
  }
  const root = createRoot(container as Any);
  root.render(h(App, null));

  captured[0]();
  assertEquals(seen.at(-1), 0);

  bump();
  flushSync();
  captured.at(-1)!(); // same stable fn, now sees n = 1
  assertEquals(seen.at(-1), 1);
  assertEquals(captured[0], captured.at(-1), "identity is stable across renders");
  root.unmount();
});

Deno.test("React.cache is request-scoped during SSR (no cross-request leak)", async () => {
  let calls = 0;
  const getUser = cache(() => `user-${++calls}`);
  const ctx1 = createRequestContext(new Request("http://x/"));
  const ctx2 = createRequestContext(new Request("http://x/"));
  const a1 = await runWithContext(ctx1, () => getUser());
  const a2 = await runWithContext(ctx1, () => getUser()); // same request → deduped
  const b1 = await runWithContext(ctx2, () => getUser()); // new request → fresh, not leaked
  assertEquals(a1, "user-1");
  assertEquals(a2, "user-1"); // memoized within the request
  assertEquals(b1, "user-2"); // request 2 does NOT see request 1's cached value
  // Off-request: falls back to a persistent memo (still deduped).
  const off = cache(() => `off-${++calls}`);
  assertEquals(off(), off());
});
