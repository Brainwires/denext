// A new fiber shares one empty context map instead of allocating two `Map`s that reconcile
// replaces before the fiber renders. Context maps are never mutated in place, so sharing is
// safe; context values still reach their consumers.

import { assertEquals, assertStrictEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createFiber } from "../src/client/fiber/fiber.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { createContext } from "../src/runtime/context.ts";
import { useContext } from "../src/runtime/hooks.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("new fibers share one empty context map", () => {
  const a = createFiber("component", h("div", null) as VNode);
  const b = createFiber("host", h("span", null) as VNode);
  assertStrictEquals(a.inherited, b.inherited);
  assertStrictEquals(a.contexts, a.inherited);
  assertEquals(a.inherited.size, 0);
});

Deno.test("providers still reach consumers, and the shared map stays empty", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const Theme = createContext("light");
  function Leaf(): VNode {
    return h("span", null, useContext(Theme));
  }
  createRoot(container as Any).render(
    h("div", null, h(Theme.Provider, { value: "dark" }, h(Leaf, null)), h(Leaf, null)),
  );
  flushSync();
  assertEquals(container.textContent, "darklight");
  assertEquals(createFiber("host", h("i", null) as VNode).inherited.size, 0);
});
