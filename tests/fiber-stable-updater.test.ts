// useState/useReducer must return a REFERENTIALLY STABLE setter/dispatch across renders
// (React's guarantee). Libraries put the setter in effect/memo dependency arrays; a fresh
// closure each render re-fires those effects and, when the effect writes back through the
// setter (Base UI's label/id registration: a provider memoizes its context value on the
// setter, a consumer's layout effect depends on it and calls it), it becomes an infinite
// commit→effect→re-render loop that trips the max-update-depth guard. Regression for that.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import {
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
} from "../src/runtime/hooks.ts";
import { createContext } from "../src/runtime/context.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

Deno.test("useState setter has a stable identity across re-renders", () => {
  const setters = new Set<unknown>();
  let bump: ((n: number) => void) | null = null;
  function C(): VNode {
    const [n, setN] = useState(0);
    setters.add(setN);
    bump = setN;
    return h("i", { "data-n": String(n) });
  }
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(h(C, null));
  flushSync();
  bump!(1);
  flushSync();
  bump!(2);
  flushSync();
  assertEquals(setters.size, 1, "setter identity changed across renders");
});

Deno.test("useReducer dispatch has a stable identity and uses the latest reducer", () => {
  const dispatches = new Set<unknown>();
  let dispatch: ((a: number) => void) | null = null;
  let readN = -1;
  let factor = 1;
  function C(): VNode {
    const [n, d] = useReducer((s: number, a: number) => s + a * factor, 0);
    dispatches.add(d);
    dispatch = d;
    readN = n;
    return h("i", { "data-n": String(n) });
  }
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(h(C, null));
  flushSync();
  dispatch!(5); // +5*1
  flushSync();
  assertEquals(readN, 5);
  factor = 10; // the component re-renders (state changed above), refreshing the cell's reducer
  dispatch!(2); // +2*10 with the latest reducer
  flushSync();
  assertEquals(readN, 25, "dispatch used the latest reducer");
  assertEquals(dispatches.size, 1, "dispatch identity changed across renders");
});

Deno.test("provider-memo + consumer-effect on a setter settles (no update-depth loop)", () => {
  // The Base UI label-registration shape: a provider memoizes its context value on
  // [value, setter]; a consumer's layout effect depends on [id, setter] and writes back
  // through the setter. With a stable setter this fires once and settles.
  const Ctx = createContext<{ setLabelId: (v: string | undefined) => void } | null>(null);
  let effectRuns = 0;

  function Provider({ children }: { children: VNode }): VNode {
    const [labelId, setLabelId] = useState<string | undefined>(undefined);
    const value = useMemo(() => ({ labelId, setLabelId }), [labelId, setLabelId]);
    return h(Ctx.Provider, { value }, children);
  }
  function Label(): VNode {
    const ctx = useContext(Ctx)!;
    const id = "label-1";
    useLayoutEffect(() => {
      effectRuns++;
      ctx.setLabelId(id);
      return () => ctx.setLabelId(undefined);
    }, [id, ctx.setLabelId]);
    return h("span", null);
  }

  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(h(Provider, null, h(Label, null)));
  flushSync();
  assert(effectRuns <= 3, `label-registration effect looped ${effectRuns}× (setter not stable)`);
});
