// The React-surface additions: Profiler, act, useDebugValue, useFormState (alias),
// SuspenseList (pass-through), and the react-dom resource-preload APIs.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
import {
  preconnect,
  prefetchDNS,
  preinit,
  preload,
  setSsrHintSink,
} from "../src/compat/react-dom-preload.ts";
import {
  addResourceHint,
  createRequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
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

Deno.test("Context.Consumer with a bare-string render-prop hydrates on the client", () => {
  // Regression: a render prop returning a bare string must not crash client mount
  // (a raw string/array return would hit mount() as an undefined-type element).
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const Ctx = createContext("hi");
  createRoot(container as Any).render(
    h(
      Ctx.Provider as Any,
      { value: "dark" },
      h(Ctx.Consumer as Any, { children: (v: string) => v } as Any),
    ),
  );
  assertStringIncludes(container.innerHTML, "dark");
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
  // No globalThis.document and no sink installed in this test → they must not throw.
  setSsrHintSink(null);
  preload("/a.js", { as: "script" });
  preinit("/b.css", { as: "style" });
  preconnect("https://cdn.example.com", { crossOrigin: "anonymous" });
  prefetchDNS("https://api.example.com");
  assert(true);
});

Deno.test("resource-preload APIs emit <link>/<script> hints during SSR (into the request head)", () => {
  setSsrHintSink(addResourceHint);
  try {
    const ctx = createRequestContext(new Request("https://x.test/"));
    runWithContext(ctx, () => {
      preload("/a.js", { as: "script", fetchPriority: "high" });
      preinit("/b.css", { as: "style" });
      preinit("/c.js", { as: "script", crossOrigin: "anonymous" });
      preconnect("https://cdn.example.com", { crossOrigin: "anonymous" });
      prefetchDNS("https://api.example.com");
      preload("/a.js", { as: "script", fetchPriority: "high" }); // duplicate → deduped
    });
    const hints = ctx.resourceHints ?? [];
    const joined = hints.join("");
    assertStringIncludes(
      joined,
      `<link rel="preload" href="/a.js" as="script" fetchpriority="high">`,
    );
    assertStringIncludes(joined, `<link rel="stylesheet" href="/b.css">`);
    assertStringIncludes(joined, `<script src="/c.js" async crossorigin="anonymous"></script>`);
    assertStringIncludes(
      joined,
      `<link rel="preconnect" href="https://cdn.example.com" crossorigin="anonymous">`,
    );
    assertStringIncludes(joined, `<link rel="dns-prefetch" href="https://api.example.com">`);
    // The exact-duplicate preload is deduped.
    assertEquals(hints.filter((t) => t.includes(`href="/a.js"`)).length, 1);
  } finally {
    setSsrHintSink(null);
  }
});
