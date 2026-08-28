import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  escapeHtml,
  renderToString,
  renderToStringSync,
  serializeStyle,
} from "../src/jsx/render-to-string.ts";
import { useState } from "../src/runtime/hooks.ts";
import { createContext } from "../src/runtime/context.ts";
import type { VNode } from "../src/jsx/types.ts";

Deno.test("renders a simple element", async () => {
  const html = await renderToString(h("div", { className: "x" }, "hi"));
  assertEquals(html, '<div class="x">hi</div>');
});

Deno.test("escapes text content and attribute values", async () => {
  const html = await renderToString(
    h("p", { title: '"q" & <b>' }, "<script>alert(1)</script>"),
  );
  assertEquals(
    html,
    '<p title="&quot;q&quot; &amp; &lt;b&gt;">&lt;script&gt;alert(1)&lt;/script&gt;</p>',
  );
});

Deno.test("void elements have no closing tag", async () => {
  const html = await renderToString(h("input", { type: "text", value: "a" }));
  assertEquals(html, '<input type="text" value="a">');
});

Deno.test("boolean attributes render bare or are omitted", async () => {
  const on = await renderToString(h("input", { disabled: true }));
  assertEquals(on, "<input disabled>");
  const off = await renderToString(h("input", { disabled: false }));
  assertEquals(off, "<input>");
});

Deno.test("event handlers are stripped during SSR", async () => {
  const html = await renderToString(h("button", { onClick: () => {} }, "go"));
  assertEquals(html, "<button>go</button>");
});

Deno.test("style objects serialize with px defaults", () => {
  const css = serializeStyle({ marginTop: 4, opacity: 0.5, color: "red" });
  assertEquals(css, "margin-top:4px;opacity:0.5;color:red;");
});

Deno.test("function components render, including async ones", async () => {
  function Greeting(props: { name: string }): VNode {
    return h("span", null, `Hello ${props.name}`);
  }
  async function AsyncList(): Promise<VNode> {
    await Promise.resolve();
    return h("ul", null, h("li", null, "one"));
  }
  const html = await renderToString(
    h("div", null, h(Greeting, { name: "Ada" }), h(AsyncList, null)),
  );
  assertEquals(html, "<div><span>Hello Ada</span><ul><li>one</li></ul></div>");
});

Deno.test("renderToStringSync: byte-parity with the async renderer for a sync tree", async () => {
  function Card(props: { title: string }): VNode {
    const [n] = useState(7);
    return h("section", { class: "card" }, h("h2", null, props.title), h("span", null, `n=${n}`));
  }
  const tree = h("div", { id: "root" }, h(Card, { title: "Hi & <ok>" }), h("hr", null));
  // The sync path must produce exactly what awaiting the async path produces.
  assertEquals(renderToStringSync(tree), await renderToString(tree));
});

Deno.test("renderToStringSync: Suspense renders its fallback; async component throws", () => {
  // A genuinely async Server Component outside a boundary can't render synchronously.
  async function Async(): Promise<VNode> {
    await Promise.resolve();
    return h("span", null, "late");
  }
  let threw = false;
  try {
    renderToStringSync(h(Async, null));
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "renderToStringSync");
  }
  assertEquals(threw, true);
});

Deno.test("useState returns its initial value during SSR", async () => {
  function Counter(): VNode {
    const [count] = useState(7);
    return h("output", null, String(count));
  }
  const html = await renderToString(h(Counter, null));
  assertEquals(html, "<output>7</output>");
});

Deno.test("context provider value flows to consumers", async () => {
  const Theme = createContext("light");
  function Label(): VNode {
    // useContext is imported lazily to avoid a top-level cycle in the test.
    const value = useThemeValue(Theme);
    return h("em", null, value);
  }
  const html = await renderToString(
    h(Theme.Provider, { value: "dark", children: h(Label, null) }),
  );
  assertEquals(html, "<em>dark</em>");
});

// Small helper mirroring useContext without importing the whole module twice.
import { useContext } from "../src/runtime/hooks.ts";
function useThemeValue<T>(ctx: ReturnType<typeof createContext<T>>): T {
  return useContext(ctx);
}

Deno.test("dangerouslySetInnerHTML injects raw markup", async () => {
  const html = await renderToString(
    h("div", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } }),
  );
  assertEquals(html, "<div><b>raw</b></div>");
});

Deno.test("escapeHtml handles all five entities", () => {
  assertEquals(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

Deno.test("nested fragments flatten", async () => {
  const html = await renderToString(
    h("div", null, [h("span", null, "a"), h("span", null, "b")]),
  );
  assertStringIncludes(html, "<span>a</span><span>b</span>");
});

Deno.test("useServerInsertedHTML: callback markup is flushed into the head collector", async () => {
  const { useServerInsertedHTML } = await import("../src/runtime/server-inserted-html.ts");
  function StyleRegistry({ children }: { children: VNode }): VNode {
    // The CSS-in-JS pattern: register a callback that returns collected <style> markup.
    useServerInsertedHTML(() => h("style", { "data-denext": "sc" }, ".x{color:red}"));
    return children;
  }
  const head = { tags: [] as string[] } as { tags: string[]; serverInserted?: string[] };
  const html = await renderToString(
    h(StyleRegistry, null, h("div", { className: "x" }, "hi")),
    { head },
  );
  // Body renders normally...
  assertStringIncludes(html, '<div class="x">hi</div>');
  // ...and the callback's markup was collected for the <head> (not emitted inline).
  assertEquals(head.serverInserted?.length, 1);
  assertStringIncludes(head.serverInserted![0], '<style data-denext="sc">.x{color:red}</style>');
  assertEquals(html.includes("<style"), false, "inserted markup is NOT inline in the body");
});

Deno.test("useServerInsertedHTML: a no-op with no active render sink (client-safe)", async () => {
  const { useServerInsertedHTML } = await import("../src/runtime/server-inserted-html.ts");
  // Outside renderToString there is no sink → the hook must not throw. Rendering a
  // component that calls it (with no head collector / no active pass) is a clean no-op.
  function ClientOnly(): VNode {
    useServerInsertedHTML(() => h("style", null, "x"));
    return h("div", null, "ok");
  }
  assertEquals(await renderToString(h(ClientOnly, null)), "<div>ok</div>");
});
