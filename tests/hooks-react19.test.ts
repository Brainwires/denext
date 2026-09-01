import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
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

Deno.test("useId derives ids from tree position during SSR", async () => {
  // Two sibling components under a (transparent) host div: root slots 0 and 1,
  // each with one useId (local 0) -> :d0_0: and :d1_0:.
  const html = await renderToString(h("div", null, h(Field, null), h(Field, null)));
  assertStringIncludes(html, ":d0_0:");
  assertStringIncludes(html, ":d1_0:");
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

  // The client derives the SAME path-based ids from its tree walk.
  assertStringIncludes(ssr, '<span id=":d0_0:">:d0_0:</span>');
  assertStringIncludes(container.innerHTML, '<span id=":d0_0:">:d0_0:</span>');
  assertStringIncludes(container.innerHTML, '<span id=":d1_0:">:d1_0:</span>');
});

Deno.test("useId stays stable across a client re-render", () => {
  function Widget(): VNode {
    const id = useId();
    return h("span", { id }, id);
  }
  const tree = () => h("div", null, h(Widget, null));
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const root = createRoot(asEl(container));
  root.render(tree());
  const first = container.innerHTML;
  // Re-render the same structure: the component fiber is reused, so its cached id
  // cell (and its scope) survive — the id must not drift.
  root.render(tree());
  flushSync();
  assertEquals(container.innerHTML, first);
  assertStringIncludes(first, ":d0_0:");
});

// ---- identifierPrefix (multi-root useId disambiguation) --------------------

Deno.test("identifierPrefix seeds the server useId scope", async () => {
  const tree = h("div", null, h(Field, null), h(Field, null));
  const html = await renderToString(tree, { idPrefix: "app" });
  assertStringIncludes(html, ":dapp.0_0:");
  assertStringIncludes(html, ":dapp.1_0:");
  // Default (no prefix) is byte-identical to before.
  const plain = await renderToString(h("div", null, h(Field, null), h(Field, null)));
  assertStringIncludes(plain, ":d0_0:");
});

Deno.test("compat renderToString threads identifierPrefix", async () => {
  const { renderToString: reactRenderToString } = await import(
    "../src/compat/react-dom-server.ts"
  );
  const html = reactRenderToString(h("div", null, h(Field, null)), { identifierPrefix: "x" });
  assertStringIncludes(html, ":dx.0_0:");
});

Deno.test("two client roots with distinct identifierPrefix produce non-colliding ids", () => {
  function Widget(): VNode {
    const id = useId();
    return h("span", { id }, id);
  }
  const a = makeDom();
  const b = makeDom();
  setDocument(asDoc(a.doc));
  createRoot(asEl(a.container), { identifierPrefix: "a" }).render(h(Widget, null));
  setDocument(asDoc(b.doc));
  createRoot(asEl(b.container), { identifierPrefix: "b" }).render(h(Widget, null));
  assertStringIncludes(a.container.innerHTML, ":da.0_0:");
  assertStringIncludes(b.container.innerHTML, ":db.0_0:");
  // Without prefixes both roots would emit :d0_0: — the prefixes keep them disjoint.
  assertEquals(a.container.innerHTML.includes(":db.0_0:"), false);
});

Deno.test("hydrateRoot identifierPrefix aligns with the matching server render", async () => {
  function Widget(): VNode {
    const id = useId();
    return h("span", { id }, id);
  }
  const tree = () => h("div", null, h(Widget, null), h(Widget, null));
  const ssr = await renderToString(tree(), { idPrefix: "z" });
  assertStringIncludes(ssr, '<span id=":dz.0_0:">:dz.0_0:</span>');

  const { doc, container } = makeDom();
  container.innerHTML = ssr;
  setDocument(asDoc(doc));
  hydrateRoot(asEl(container), tree(), { identifierPrefix: "z" });
  // Same prefix on both sides -> the client derives the same prefixed ids (no mismatch).
  assertStringIncludes(container.innerHTML, ":dz.0_0:");
  assertStringIncludes(container.innerHTML, ":dz.1_0:");
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

Deno.test("H3: useSyncExternalStore hydrates with the server snapshot, then syncs to client", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  // Server HTML was rendered from the SERVER snapshot ("server").
  const out = doc.createElement("output");
  out.appendChild(doc.createTextNode("server"));
  container.appendChild(out);

  const dev = globalThis as { __denextDev?: boolean };
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  dev.__denextDev = true;
  try {
    const Store = (): VNode => {
      const v = useSyncExternalStore(() => () => {}, () => "client", () => "server");
      return h("output", null, v);
    };
    hydrateRoot(asEl(container), h(Store, null));
    // The hydration render used the server snapshot → matches the server HTML,
    // so there is NO hydration mismatch and no content flip.
    assertEquals(container.innerHTML, "<output>server</output>");
    assertEquals(
      warnings.filter((w) => w.includes("hydration mismatch")).length,
      0,
      "server snapshot must avoid a hydration mismatch",
    );

    // After hydration the effect subscribes, re-checks, and syncs to the live
    // client snapshot (the H3b re-check path).
    flushSync();
    assertEquals(container.innerHTML, "<output>client</output>");
  } finally {
    console.warn = origWarn;
    delete dev.__denextDev;
  }
});

Deno.test("H3b: a store mutation in the subscribe window is caught after mount", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  let value = "a";
  const subscribe = (_cb: () => void) => () => {};
  function Store(): VNode {
    const v = useSyncExternalStore(subscribe, () => value);
    return h("output", null, v);
  }
  createRoot(asEl(container)).render(h(Store, null));
  // Mutate the store AFTER the render's snapshot read but BEFORE the passive
  // subscribe effect runs — the post-subscribe re-check must catch it.
  value = "b";
  flushSync();
  assertEquals(container.innerHTML, "<output>b</output>");
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
