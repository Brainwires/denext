// React's shared internals on denext's `react` (src/compat/react-internals.ts): a
// `react-reconciler` renderer (React Native Skia's <Canvas>, react-three-fiber, react-konva) reads
// `__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE` when it loads (react-reconciler
// 0.31 chains onto its `S` at module init: without the object it throws "Cannot read properties of
// undefined (reading 'S')"), and while it renders a component it installs its hooks dispatcher in
// `H`, so the hooks the component imported from `react` must go to it. Its elements must be
// React's: `<>…</>` is React's fragment brand (react-reconciler threw React error #130, "element
// type is invalid: symbol", on denext's own marker). A context it has no provider for reads
// `_currentValue2`, the default. The real renderer is exercised by
// tests/e2e/react-native-skia.e2e.test.ts.

import { assertEquals, assertStrictEquals } from "@std/assert";
import React, {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as internals,
  createContext,
  Fragment,
  use,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "../src/compat/react.ts";
import { jsx } from "../src/jsx/jsx-runtime.ts";
import { render } from "../src/testing/mod.ts";

/** Install `dispatcher` as a foreign renderer does for the length of `fn`. */
function withDispatcher<T>(dispatcher: Record<string, unknown>, fn: () => T): T {
  const prior = internals.H;
  internals.H = dispatcher as typeof internals.H;
  try {
    return fn();
  } finally {
    internals.H = prior;
  }
}

Deno.test("internals: the shared object a react-reconciler build reads", () => {
  assertEquals(Object.keys(internals).sort(), ["A", "H", "S", "T"]);
  assertEquals(internals.H, null);
  assertStrictEquals(
    (React as Record<string, unknown>)
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    internals,
  );
  // react-reconciler 0.31's module init: chain onto `S`.
  const prev = internals.S;
  internals.S = (t, v) => prev?.(t, v);
  internals.S = prev;
});

Deno.test("internals: hooks go to the foreign renderer's dispatcher while it is installed", () => {
  const calls: string[] = [];
  const dispatcher = {
    useState: (init: unknown) => (calls.push(`useState:${init}`), ["foreign", () => {}]),
    useReducer: (
      _r: unknown,
      init: unknown,
    ) => (calls.push(`useReducer:${init}`), [init, () => {}]),
    useEffect: () => void calls.push("useEffect"),
    useMemo: (fn: () => unknown) => (calls.push("useMemo"), fn()),
    useRef: (v: unknown) => (calls.push("useRef"), { current: v }),
    useContext: (
      ctx: { _currentValue2: unknown },
    ) => (calls.push("useContext"), ctx._currentValue2),
    use: (v: unknown) => (calls.push("use"), v),
  };
  const Ctx = createContext("default");
  /** The hooks a component of the foreign renderer calls. */
  function useForeignHooks() {
    assertEquals(useState(1)[0] as unknown, "foreign");
    assertEquals(useReducer((s: number) => s, 2)[0], 2);
    useEffect(() => {});
    assertEquals(useMemo(() => 3, []), 3);
    assertEquals(useRef(4).current, 4);
    assertEquals(useContext(Ctx), "default");
    assertEquals(use(Ctx) as unknown, Ctx);
  }
  withDispatcher(dispatcher, useForeignHooks);
  assertEquals(calls, [
    "useState:1",
    "useReducer:2",
    "useEffect",
    "useMemo",
    "useRef",
    "useContext",
    "use",
  ]);
});

Deno.test("internals: while denext renders, its hooks are denext's whatever H holds", async () => {
  function Counter() {
    const [n] = useState(5);
    const ref = useRef("r");
    return jsx("p", { children: `n=${n} ${ref.current}` });
  }
  const screen = await render(jsx(Counter, {}));
  screen.getByText("n=5 r");
  await screen.unmount();
  // After its first render a react-reconciler renderer leaves its "context only" dispatcher in
  // H, whose hooks throw (React error #321): denext's next render must not reach it.
  const invalid = () => {
    throw new Error("Minified React error #321");
  };
  const prior = internals.H;
  internals.H = { useState: invalid, useRef: invalid } as typeof internals.H;
  try {
    const again = await render(jsx(Counter, {}));
    again.getByText("n=5 r");
    await again.unmount();
  } finally {
    internals.H = prior;
  }
});

Deno.test("internals: a fragment is React's fragment brand", () => {
  assertStrictEquals(Fragment as unknown, Symbol.for("react.fragment"));
  const el = jsx(Fragment, { children: "x" }) as { $$typeof: symbol; type: unknown };
  assertStrictEquals(el.$$typeof, Symbol.for("react.transitional.element"));
  assertStrictEquals(el.type, Symbol.for("react.fragment"));
});

Deno.test("internals: a context carries its default in React's value fields", () => {
  const Ctx = createContext({ theme: "light" }) as unknown as {
    _currentValue: unknown;
    _currentValue2: unknown;
  };
  assertEquals(Ctx._currentValue, { theme: "light" });
  assertEquals(Ctx._currentValue2, { theme: "light" });
});
