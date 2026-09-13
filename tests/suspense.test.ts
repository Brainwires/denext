import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { renderToReadableStream, streamToString } from "../src/jsx/render-to-stream.ts";
import { createResource, Suspense, use } from "../src/runtime/suspense.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";
import { useLayoutEffect, useState, useSyncExternalStore } from "../src/runtime/hooks.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

Deno.test("renderToString fully resolves Suspense children (no fallback)", async () => {
  const read = createResource(async () => {
    await Promise.resolve();
    return "resolved data";
  });
  function AsyncChild(): VNode {
    return h("span", null, read());
  }
  const html = await renderToString(
    h(Suspense, { fallback: h("p", null, "loading"), children: h(AsyncChild, null) }),
  );
  assertEquals(html, "<span>resolved data</span>");
});

Deno.test("streaming emits fallback first, then swaps in real content", async () => {
  let resolveData: (v: string) => void = () => {};
  const dataPromise = new Promise<string>((r) => (resolveData = r));
  const read = createResource(() => dataPromise);

  function Slow(): VNode {
    return h("strong", null, read());
  }
  const stream = renderToReadableStream(
    h(
      "div",
      null,
      h(Suspense, {
        fallback: h("p", null, "Loading…"),
        children: h(Slow, null),
      }),
    ),
  );

  // Resolve the data shortly after streaming begins.
  queueMicrotask(() => resolveData("hi there"));

  const html = await streamToString(stream);
  // Shell contains the fallback placeholder...
  assertStringIncludes(html, 'data-dnx-b="dnx0"');
  assertStringIncludes(html, "Loading…");
  // ...and later the streamed real content as a template (one swap runtime reveals it).
  assertStringIncludes(html, '<template data-dnx-r="dnx0">');
  assertStringIncludes(html, "<strong>hi there</strong>");
  assert(!html.includes("__dnxSwap"), "no per-hole swap script");
  // Fallback appears before the resolved content in stream order.
  assertEquals(html.indexOf("Loading") < html.indexOf("hi there"), true);
});

Deno.test("client Suspense shows fallback then real content when promise resolves", async () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  let resolve: (v: string) => void = () => {};
  const p = new Promise<string>((r) => (resolve = r));

  function Child(): VNode {
    const value = use(p);
    return h("span", null, value);
  }
  const root = createRoot(asEl(container));
  root.render(
    h(Suspense, { fallback: h("p", null, "wait"), children: h(Child, null) }),
  );

  // Initially suspended -> fallback rendered.
  assertEquals(container.innerHTML, "<p>wait</p>");

  resolve("done!");
  await p; // let the resolution microtasks run
  await Promise.resolve();
  flushSync();

  assertEquals(container.innerHTML, "<span>done!</span>");
});

Deno.test("streaming handles multiple independent boundaries", async () => {
  const readA = createResource(async () => {
    await Promise.resolve();
    return "A";
  });
  const readB = createResource(async () => {
    await Promise.resolve();
    return "B";
  });
  function CA(): VNode {
    return h("i", null, readA());
  }
  function CB(): VNode {
    return h("b", null, readB());
  }
  const stream = renderToReadableStream(
    h("main", null, [
      h(Suspense, { fallback: h("span", null, "la"), children: h(CA, null) }),
      h(Suspense, { fallback: h("span", null, "lb"), children: h(CB, null) }),
    ]),
  );
  const html = await streamToString(stream);
  assertStringIncludes(html, "<i>A</i>");
  assertStringIncludes(html, "<b>B</b>");
  assertStringIncludes(html, '<template data-dnx-r="dnx0">');
  assertStringIncludes(html, '<template data-dnx-r="dnx1">');
  assert(!html.includes("__dnxSwap"), "no per-hole swap script");
  // One shared swap runtime for both boundaries.
  assertEquals(html.split("MutationObserver").length - 1, 1);
});

Deno.test("a throwing streamed boundary is skipped, not fatal (document completes)", async () => {
  // One boundary rejects; its sibling and the document tail must still stream. The
  // failing hole leaves its shell fallback (no template) instead of truncating.
  const readGood = createResource(async () => {
    await Promise.resolve();
    return "ok";
  });
  const readBad = createResource(async () => {
    await Promise.resolve();
    throw new Error("boom");
  });
  function Good(): VNode {
    return h("i", null, readGood());
  }
  function Bad(): VNode {
    return h("i", null, readBad());
  }
  const errs: unknown[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => void errs.push(a);
  let html: string;
  try {
    const stream = renderToReadableStream(
      h("main", null, [
        h(Suspense, { fallback: h("span", null, "lb"), children: h(Bad, null) }),
        h(Suspense, { fallback: h("span", null, "lg"), children: h(Good, null) }),
      ]),
      { shellSuffix: "<!--end-->" },
    );
    html = await streamToString(stream);
  } finally {
    console.error = origErr;
  }
  // The good boundary streamed its content; the bad one left its fallback (no template).
  assertStringIncludes(html, "<i>ok</i>");
  assert(!html.includes("<i>boom</i>"));
  assertStringIncludes(html, "lb"); // the failed hole's shell fallback stays
  // The document still completed (tail present) — the failure did not truncate it.
  assertStringIncludes(html, "<!--end-->");
  assert(errs.some((a) => String(a).includes("failed to resolve")), "the failure was logged");
});

Deno.test("a boundary that suspended on mount still reveals after its parent re-rendered in the pending window", async () => {
  // TanStack Router's shape: RouterProvider mounts <Matches>, whose child subtree suspends
  // (a lazy chunk), and a sibling's layout effect immediately calls a parent setState and
  // updates the store the suspended subtree reads. The parent re-render swaps the boundary's
  // fiber buffers while the promise is pending; the retry must clear `showingFallback` on
  // the committed buffer too, or the fallback stays up forever (a blank app).
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  let resolve: (v: string) => void = () => {};
  const p = new Promise<string>((r) => (resolve = r));
  let storeValue = 0;
  const listeners = new Set<() => void>();
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };

  function Leaf(): VNode {
    return h("b", null, use(p));
  }
  function Inner(): VNode {
    const v = useSyncExternalStore(subscribe, () => storeValue);
    return h("output", null, String(v), h(Leaf, null));
  }
  function Sibling({ bump }: { bump: (x: unknown) => void }): VNode {
    useLayoutEffect(() => {
      bump({}); // a parent setState while the boundary is showing its fallback
      storeValue = 1; // and a store change the (uncommitted) consumer has not subscribed to yet
      for (const cb of listeners) cb();
    }, []);
    return h("span", null);
  }
  function Parent(): VNode {
    const [, bump] = useState<unknown>(undefined);
    return h(
      "div",
      null,
      h(Sibling, { bump }),
      h(Suspense, { fallback: h("i", null, "wait"), children: h(Inner, null) }),
    );
  }
  createRoot(asEl(container)).render(h(Parent, null));
  assertEquals(container.innerHTML, "<div><span></span><i>wait</i></div>");

  resolve("leaf");
  await p;
  await Promise.resolve();
  flushSync();
  assertEquals(container.innerHTML, "<div><span></span><output>1<b>leaf</b></output></div>");
});
