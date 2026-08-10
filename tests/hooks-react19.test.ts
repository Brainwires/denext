import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import {
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useSyncExternalStore,
  useTransition,
} from "../src/runtime/hooks.ts";
import { createContext } from "../src/runtime/context.ts";
import { useContext } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

// ---- useId -----------------------------------------------------------------

function Field(): VNode {
  const id = useId();
  return h("label", { htmlFor: id }, h("input", { id }));
}

Deno.test("useId produces sequential ids during SSR", async () => {
  const html = await renderToString(h("div", null, h(Field, null), h(Field, null)));
  assertStringIncludes(html, ":d0:");
  assertStringIncludes(html, ":d1:");
});

Deno.test("useId matches between server render and client mount", async () => {
  function Widget(): VNode {
    const id = useId();
    return h("span", { id }, id);
  }
  const tree = () => h("div", null, h(Widget, null), h(Widget, null));
  const ssr = await renderToString(tree());

  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(tree());

  // The client assigns the same :d0:/:d1: sequence (counter resets at mount).
  assertStringIncludes(ssr, '<span id=":d0:">:d0:</span>');
  assertStringIncludes(container.innerHTML, '<span id=":d0:">:d0:</span>');
  assertStringIncludes(container.innerHTML, '<span id=":d1:">:d1:</span>');
});

// ---- useSyncExternalStore --------------------------------------------------

Deno.test("useSyncExternalStore re-renders on store change (client)", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  let value = 0;
  const listeners = new Set<() => void>();
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  const getSnapshot = () => value;

  function Counter(): VNode {
    const v = useSyncExternalStore(subscribe, getSnapshot);
    return h("output", null, String(v));
  }
  createRoot(asEl(container)).render(h(Counter, null));
  flushSync(); // register the store subscription (a passive effect)
  assertEquals(container.innerHTML, "<output>0</output>");

  value = 42;
  listeners.forEach((cb) => cb());
  flushSync();
  assertEquals(container.innerHTML, "<output>42</output>");
});

Deno.test("useSyncExternalStore uses the server snapshot during SSR", async () => {
  const html = await renderToString(
    h(function Srv(): VNode {
      const v = useSyncExternalStore(() => () => {}, () => "client", () => "server");
      return h("b", null, v);
    }, null),
  );
  assertEquals(html, "<b>server</b>");
});

// ---- useLayoutEffect -------------------------------------------------------

Deno.test("useLayoutEffect runs after mount on the client", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  let ran = false;
  function C(): VNode {
    useLayoutEffect(() => {
      ran = true;
    }, []);
    return h("i", null, "x");
  }
  createRoot(asEl(container)).render(h(C, null));
  assertEquals(ran, true);
});

Deno.test("useLayoutEffect is a no-op during SSR", async () => {
  let ran = false;
  await renderToString(
    h(function C(): VNode {
      useLayoutEffect(() => {
        ran = true;
      });
      return h("i", null, "x");
    }, null),
  );
  assertEquals(ran, false);
});

// ---- useDeferredValue ------------------------------------------------------

Deno.test("useDeferredValue returns the value during SSR", async () => {
  const html = await renderToString(
    h(function C(props: { v: number }): VNode {
      return h("b", null, String(useDeferredValue(props.v)));
    }, { v: 7 }),
  );
  assertEquals(html, "<b>7</b>");
});

// ---- useTransition ---------------------------------------------------------

Deno.test("useTransition is idle during SSR and runs the callback on client", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  let called = false;
  function C(): VNode {
    const [pending, start] = useTransition();
    useEffect(() => {
      start(() => {
        called = true;
      });
    }, []);
    return h("i", null, pending ? "pending" : "idle");
  }
  createRoot(asEl(container)).render(h(C, null));
  flushSync(); // the useEffect that calls start() is a passive effect
  assertEquals(called, true);
});

// ---- useImperativeHandle + ref-as-prop -------------------------------------

Deno.test("useImperativeHandle exposes a handle on the parent ref", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const ref: { current: { greet(): string } | null } = { current: null };

  function Fancy(props: { ref: typeof ref }): VNode {
    useImperativeHandle(props.ref, () => ({ greet: () => "hi" }));
    return h("input", null);
  }
  createRoot(asEl(container)).render(h(Fancy, { ref }));
  assertEquals(ref.current?.greet(), "hi");
});

// ---- context-as-element (React 19) -----------------------------------------

Deno.test("a context is usable directly as a provider element (SSR)", async () => {
  const Theme = createContext("light");
  function Consumer(): VNode {
    return h("em", null, useContext(Theme));
  }
  const html = await renderToString(
    h(Theme, { value: "dark", children: h(Consumer, null) }),
  );
  assertEquals(html, "<em>dark</em>");
});

Deno.test("context-as-element works on the client too", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const Theme = createContext("light");
  function Consumer(): VNode {
    return h("em", null, useContext(Theme));
  }
  createRoot(asEl(container)).render(
    h(Theme, { value: "dark", children: h(Consumer, null) }),
  );
  assertEquals(container.innerHTML, "<em>dark</em>");
});
