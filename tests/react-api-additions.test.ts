// The React-surface additions: Profiler, act, useDebugValue, useFormState (alias),
// SuspenseList (pass-through), and the react-dom resource-preload APIs.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  createContext,
  Profiler,
  SuspenseList,
  useDebugValue,
  useInsertionEffect,
  useState,
} from "../mod.ts";
import { useActionState, useFormState } from "../src/runtime/actions.ts";
import { act, createRoot, setDocument } from "../src/client/reconciler.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { preconnect, prefetchDNS, preinit, preload } from "../src/compat/react-dom-preload.ts";
import { makeDom } from "./helpers/dom.ts";
import type { ProfilerPhase } from "../src/runtime/profiler.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("useFormState is the useActionState alias", () => {
  assert(useFormState === useActionState, "useFormState should alias useActionState");
});

Deno.test("SuspenseList renders its children", async () => {
  const html = await renderToString(
    h(
      SuspenseList as Any,
      { revealOrder: "forwards" },
      h("p", null, "a"),
      h("p", null, "b"),
    ) as never,
  );
  assertEquals(html, "<p>a</p><p>b</p>");
});

Deno.test("useDebugValue is a no-op (renders fine)", async () => {
  function C(): VNode {
    useDebugValue("label");
    return h("i", null, "ok");
  }
  const html = await renderToString(h(C, null));
  assertEquals(html, "<i>ok</i>");
});

Deno.test("Profiler fires onRender on mount", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const calls: Array<{ id: string; phase: ProfilerPhase }> = [];
  createRoot(container as Any).render(
    h(
      Profiler as Any,
      {
        id: "demo",
        onRender: (id: string, phase: ProfilerPhase) => calls.push({ id, phase }),
      },
      h("p", null, "content"),
    ),
  );
  assertEquals(container.innerHTML, "<p>content</p>");
  assert(calls.length >= 1, "onRender fired");
  assertEquals(calls[0].id, "demo");
  assertEquals(calls[0].phase, "mount");
});

Deno.test("act flushes a pending state update", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let bump = () => {};
  function C(): VNode {
    const [n, set] = useState(0);
    bump = () => set((v) => v + 1);
    return h("p", null, String(n));
  }
  createRoot(container as Any).render(h(C, null));
  assertEquals(container.innerHTML, "<p>0</p>");
  await act(() => {
    bump();
  });
  assertEquals(container.innerHTML, "<p>1</p>");
});

Deno.test("Context.Consumer renders children with the provided value", async () => {
  const Ctx = createContext("default");
  const html = await renderToString(
    h(
      Ctx.Provider as Any,
      { value: "hi" },
      h(Ctx.Consumer as Any, { children: (v: string) => h("p", null, v) } as Any),
    ) as never,
  );
  assertEquals(html, "<p>hi</p>");
});

Deno.test("Context.Consumer falls back to the default value", async () => {
  const Ctx = createContext("fallback");
  const html = await renderToString(
    h(Ctx.Consumer as Any, { children: (v: string) => h("p", null, v) } as Any) as never,
  );
  assertEquals(html, "<p>fallback</p>");
});

Deno.test("useInsertionEffect runs at commit on the client", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let ran = false;
  function C(): VNode {
    useInsertionEffect(() => {
      ran = true;
    }, []);
    return h("p", null, "x");
  }
  createRoot(container as Any).render(h(C, null));
  assert(ran, "insertion effect ran on mount");
});

Deno.test("resource-preload APIs are safe no-ops without a document (SSR)", () => {
  // No globalThis.document in this test → they must not throw.
  preload("/a.js", { as: "script" });
  preinit("/b.css", { as: "style" });
  preconnect("https://cdn.example.com", { crossOrigin: "anonymous" });
  prefetchDNS("https://api.example.com");
  assert(true);
});
