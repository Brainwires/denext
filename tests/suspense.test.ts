import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { renderToReadableStream, streamToString } from "../src/jsx/render-to-stream.ts";
import { createResource, Suspense, use } from "../src/runtime/suspense.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

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
  // ...and later the streamed real content + swap script.
  assertStringIncludes(html, 'data-dnx-r="dnx0"');
  assertStringIncludes(html, "<strong>hi there</strong>");
  assertStringIncludes(html, "__dnxSwap('dnx0')");
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
  assertStringIncludes(html, "__dnxSwap('dnx0')");
  assertStringIncludes(html, "__dnxSwap('dnx1')");
});
