// The React-surface additions: Profiler, act, useDebugValue, useFormState (alias),
// SuspenseList (pass-through), and the react-dom resource-preload APIs.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
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

Deno.test("ViewTransition renders its children (transparent passthrough)", async () => {
  const { ViewTransition } = await import("../src/compat/react.ts");
  const html = await renderToString(
    h(
      ViewTransition as Any,
      { name: "hero", enter: "slide-in" }, // animation props accepted + ignored
      h("span", null, "content"),
    ) as never,
  );
  assertEquals(html, "<span>content</span>");
});

Deno.test("Activity renders its children (transparent passthrough)", async () => {
  const { Activity } = await import("../src/compat/react.ts");
  const html = await renderToString(
    h(Activity as Any, { mode: "hidden" }, h("span", null, "kept")) as never,
  );
  assertEquals(html, "<span>kept</span>");
});

Deno.test("new React 19.2 shims: cacheSignal/captureOwnerStack/addTransitionType/optimisticKey", async () => {
  const React = await import("../src/compat/react.ts");
  assertEquals(React.cacheSignal(), null); // no client cache scope
  assertEquals(React.captureOwnerStack(), null); // owner stacks live in DevTools
  React.addTransitionType("navigation"); // no-op, must not throw
  assertEquals(typeof React.optimisticKey, "symbol");
  // All present on the default namespace (drop-in `import React from "react"`).
  for (const k of ["Activity", "cacheSignal", "captureOwnerStack", "addTransitionType"]) {
    assertEquals(typeof (React.default as Any)[k], "function", `React.${k}`);
  }
});

Deno.test("useState supports the no-arg form (React parity)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function C(): VNode {
    const [v, set] = useState<string>(); // no initial → string | undefined
    if (v === undefined) queueMicrotask(() => set("ready"));
    return h("p", null, v ?? "empty");
  }
  createRoot(container as Any).render(h(C, null));
  assertEquals(container.innerHTML, "<p>empty</p>");
});

Deno.test("useOptimistic single-arg form: the action is the next optimistic value", async () => {
  const { useOptimistic } = await import("../src/runtime/hooks.ts");
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let apply = (_v: string) => {};
  function C(): VNode {
    const [text, add] = useOptimistic<string>("base"); // no reducer
    apply = add;
    return h("p", null, text);
  }
  createRoot(container as Any).render(h(C, null));
  assertEquals(container.innerHTML, "<p>base</p>");
  await act(() => apply("optimistic"));
  assertEquals(container.innerHTML, "<p>optimistic</p>");
});

Deno.test("useActionState accepts the optional permalink arg (arity parity)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function C(): VNode {
    const [state] = useActionState((s: number, _p: FormData) => s + 1, 5, "/submit");
    return h("p", null, String(state));
  }
  createRoot(container as Any).render(h(C, null));
  assertEquals(container.innerHTML, "<p>5</p>");
});

Deno.test("jsxDEV accepts React's dev args (isStaticChildren, source, self)", async () => {
  const { jsxDEV } = await import("../src/jsx/jsx-runtime.ts");
  const el = (jsxDEV as Any)(
    "div",
    { children: "hi" },
    "k",
    false,
    { fileName: "x.tsx", lineNumber: 1 },
    undefined,
  );
  const html = await renderToString(el as never);
  assertEquals(html, "<div>hi</div>");
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

Deno.test("createRoot/hydrateRoot accept an options arg (arity parity)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  // options accepted (onRecoverableError/identifierPrefix) — best-effort, must not throw.
  createRoot(container as Any, { identifierPrefix: "app-", onRecoverableError: () => {} }).render(
    h("p", null, "ok") as Any,
  );
  assertEquals(container.innerHTML, "<p>ok</p>");
});

Deno.test("createPortal accepts an optional key", async () => {
  const { createPortal } = await import("../src/client/reconciler.ts");
  const { doc } = makeDom();
  const target = doc.createElement("div");
  const portal = (createPortal as Any)(h("span", null, "x"), target, "my-key");
  assertEquals(portal.key, "my-key");
});

Deno.test("preloadModule/preinitModule/requestFormReset (react-dom module + form APIs)", () => {
  setSsrHintSink(addResourceHint);
  try {
    const ctx = createRequestContext(new Request("https://x.test/"));
    runWithContext(ctx, () => {
      preloadModule("/m.js", { crossOrigin: "anonymous" });
      preinitModule("/n.js");
    });
    const joined = (ctx.resourceHints ?? []).join("");
    assertStringIncludes(joined, `<link rel="modulepreload" href="/m.js" crossorigin="anonymous">`);
    assertStringIncludes(joined, `<script type="module" src="/n.js"></script>`);
  } finally {
    setSsrHintSink(null);
  }
  // requestFormReset resets a form (best-effort).
  let didReset = false;
  requestFormReset({ reset: () => (didReset = true) } as unknown as HTMLFormElement);
  assert(didReset, "requestFormReset called form.reset()");
});

Deno.test("react-dom/server renderToString accepts options; resume throws a guided error", async () => {
  const server = await import("../src/compat/react-dom-server.ts");
  assertEquals(server.renderToString(h("p", null, "hi") as Any, { identifierPrefix: "x" }), "<p>hi</p>");
  assertEquals(
    server.renderToStaticMarkup(h("b", null, "y") as Any, { identifierPrefix: "x" }),
    "<b>y</b>",
  );
  assertThrows(() => server.resume(h("p", null, "z") as Any, {}), Error, "resume");
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
