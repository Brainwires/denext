// react-is compat: classify denext's elements and branded components the way
// Radix UI / react-hook-form / emotion expect from `react-is`.

import { assert, assertEquals } from "@std/assert";
import * as ReactIs from "../src/compat/react-is.ts";
import { createContext, forwardRef, Fragment, memo, StrictMode } from "../src/compat/react.ts";
import { Profiler } from "../src/runtime/profiler.ts";
import { createPortal } from "../src/compat/react-dom.ts";
import { dynamic } from "../src/runtime/dynamic.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("react-is: isElement / isValidElement", () => {
  assert(ReactIs.isElement(h("div", null)));
  assert(ReactIs.isValidElement(h("div", null)));
  assert(!ReactIs.isElement("div"));
  assert(!ReactIs.isElement(null));
  assert(!ReactIs.isElement(42));
  // An UNBRANDED { type, props } object (config/data that merely shares the shape) is
  // NOT an element — matching React's react-is and React.isValidElement (a library that
  // routes on react-is must not mistake it for a renderable element).
  assert(!ReactIs.isElement({ type: "div", props: {} }));
});

Deno.test("react-is: isFragment", () => {
  assert(ReactIs.isFragment(h(Fragment, null)));
  assert(!ReactIs.isFragment(h("div", null)));
  assert(ReactIs.isFragment(Fragment)); // bare marker too
});

Deno.test("react-is: isForwardRef recognizes a branded forwardRef", () => {
  const C = forwardRef<unknown, { ref?: unknown }>((_p, r) => h("span", { ref: r }));
  assert(ReactIs.isForwardRef(C), "on the type");
  assert(ReactIs.isForwardRef(h(C as Any, null)), "on an element of it");
  assert(!ReactIs.isForwardRef(() => h("span", null)));
});

Deno.test("react-is: isMemo recognizes a branded memo", () => {
  const M = memo((_p: Record<string, unknown>) => h("span", null));
  assert(ReactIs.isMemo(M));
  assert(ReactIs.isMemo(h(M as Any, null)));
  assert(!ReactIs.isMemo(() => h("span", null)));
});

Deno.test("react-is: isLazy recognizes dynamic()", () => {
  const L = dynamic(() => Promise.resolve(() => h("span", null)));
  assert(ReactIs.isLazy(L));
});

Deno.test("react-is: isPortal", () => {
  const { doc } = makeDom();
  const target = doc.createElement("div");
  const p = createPortal(h("span", null, "x"), target as Any);
  assert(ReactIs.isPortal(p));
  assert(!ReactIs.isPortal(h("div", null)));
});

Deno.test("react-is: isSuspense", () => {
  assert(ReactIs.isSuspense(h(Suspense as Any, { fallback: null })));
  assert(!ReactIs.isSuspense(h("div", null)));
});

Deno.test("react-is: typeOf returns the classifying symbol", () => {
  assertEquals(ReactIs.typeOf(h(Fragment, null)), ReactIs.Fragment);
  const M = memo((_p: Record<string, unknown>) => h("span", null));
  assertEquals(ReactIs.typeOf(h(M as Any, null)), ReactIs.Memo);
  // Any other element is a plain element (React returns `Element`, not undefined).
  assertEquals(ReactIs.typeOf(h("div", null)), ReactIs.Element);
  assertEquals(ReactIs.typeOf("not an element"), undefined);
});

Deno.test("react-is: typeOf classifies provider/consumer/profiler/strictmode", () => {
  const Ctx = createContext("default");
  // A denext context IS its provider; its `.Consumer` is the consumer.
  assertEquals(ReactIs.typeOf(Ctx), ReactIs.ContextProvider);
  assertEquals(ReactIs.typeOf(h(Ctx as Any, { value: "x" })), ReactIs.ContextProvider);
  assertEquals(ReactIs.typeOf((Ctx as Any).Consumer), ReactIs.ContextConsumer);
  // StrictMode / Profiler elements classify to their symbols (not undefined).
  assertEquals(ReactIs.typeOf(h(StrictMode, null)), ReactIs.StrictMode);
  assertEquals(
    ReactIs.typeOf(h(Profiler, { id: "p", onRender: () => {} } as Any)),
    ReactIs.Profiler,
  );
});

Deno.test("react-is: isContextProvider recognizes a denext context (L1)", () => {
  const Ctx = createContext("default");
  assert(ReactIs.isContextProvider(Ctx), "on the context/provider");
  assert(ReactIs.isContextProvider(h(Ctx as Any, { value: "x" })), "on a provider element");
  assert(!ReactIs.isContextProvider(() => h("div", null)));
  assert(!ReactIs.isContextConsumer(Ctx), "denext has no consumer element");
});

Deno.test("react-is: isValidElementType", () => {
  assert(ReactIs.isValidElementType("div"));
  assert(ReactIs.isValidElementType(() => h("span", null)));
  assert(ReactIs.isValidElementType(Fragment));
  assert(ReactIs.isValidElementType(memo((_p: Record<string, unknown>) => h("i", null))));
  assert(!ReactIs.isValidElementType(42));
  assert(!ReactIs.isValidElementType(null));
});
