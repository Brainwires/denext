// React-compat entrypoints: `import ... from "react"` / "react-dom" resolving to
// denext. Exercises the compat surface (createElement, hooks, Children,
// cloneElement, forwardRef, isValidElement, class-component guard, react-dom).

import { assert, assertEquals, assertThrows } from "@std/assert";
import React, {
  Children,
  cloneElement,
  Component,
  createElement,
  forwardRef,
  Fragment,
  isValidElement,
  lazy,
  useState,
  version,
} from "../src/compat/react.ts";
import ReactDOM, { createRoot, hydrateRoot, render } from "../src/compat/react-dom.ts";
import { createRoot as clientCreateRoot } from "../src/compat/react-dom-client.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { dynamic } from "../src/runtime/dynamic.ts";
import { useState as denextUseState } from "../src/runtime/hooks.ts";
import { setDocument } from "../src/client/reconciler.ts";
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
  assertEquals(lazy, dynamic);
  assertEquals(version, "19.0.0");
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

Deno.test("react: cloneElement merges props and replaces children", () => {
  const el = h("button", { type: "button", class: "a" }, "old");
  const cloned = cloneElement(el, { class: "b" }, "new");
  assertEquals((cloned.props as Any).type, "button"); // kept
  assertEquals((cloned.props as Any).class, "b"); // overridden
  assertEquals((cloned.props as Any).children, "new"); // replaced
  assertEquals((el.props as Any).class, "a"); // original untouched
});

Deno.test("react: isValidElement distinguishes elements from other values", () => {
  assert(isValidElement(h("div", null)));
  assert(!isValidElement("string"));
  assert(!isValidElement(null));
  assert(!isValidElement({ foo: 1 }));
});

Deno.test("react: forwardRef passes ref through props", () => {
  let seenRef: unknown = "unset";
  const C = forwardRef<{ ref?: unknown; label: string }>((props, ref) => {
    seenRef = ref;
    return h("span", null, props.label);
  });
  const ref = { current: null };
  C({ ref, label: "x" });
  assertEquals(seenRef, ref);
});

Deno.test("react: class components are guarded (construct throws)", () => {
  assertThrows(() => new (Component as Any)(), Error, "no class components");
});

Deno.test("react-dom: exposes the client + legacy API", () => {
  for (const fn of [createRoot, hydrateRoot, render]) assertEquals(typeof fn, "function");
  assertEquals(typeof ReactDOM.flushSync, "function");
  assertEquals(clientCreateRoot, createRoot);
  assertEquals(ReactDOM.version, "19.0.0");
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
