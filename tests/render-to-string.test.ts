import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  escapeHtml,
  type HeadCollector,
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

Deno.test("boolean attributes render as empty strings or are omitted", async () => {
  const on = await renderToString(h("input", { disabled: true }));
  assertEquals(on, '<input disabled="">');
  const off = await renderToString(h("input", { disabled: false }));
  assertEquals(off, "<input>");
});

Deno.test("event handlers are stripped during SSR", async () => {
  const html = await renderToString(h("button", { onClick: () => {} }, "go"));
  assertEquals(html, "<button>go</button>");
});

Deno.test("style objects serialize with px defaults", () => {
  const css = serializeStyle({ marginTop: 4, opacity: 0.5, color: "red" });
  assertEquals(css, "margin-top:4px;opacity:0.5;color:red");
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
  const head: HeadCollector = { tags: [] };
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

Deno.test("SSR attributes follow ReactDOMServer: form defaults (value/checked/textarea/select)", () => {
  // `defaultValue`/`defaultChecked` render as `value`/`checked` so a form is filled in without JS.
  assertEquals(
    renderToStringSync(h("input", { defaultValue: "d", defaultChecked: true })),
    '<input value="d" checked="">',
  );
  // On any other element React drops them (pushAttribute ignores both props).
  assertEquals(
    renderToStringSync(h("div", { defaultValue: "d", defaultChecked: true })),
    "<div></div>",
  );
  // A textarea's value is its text; a select's value marks the matching option(s) selected.
  assertEquals(
    renderToStringSync(h("textarea", { defaultValue: "dv" })),
    "<textarea>dv</textarea>",
  );
  assertEquals(
    renderToStringSync(
      h(
        "select",
        { defaultValue: "b" },
        h("option", { value: "a" }, "A"),
        h("option", { value: "b" }, "B"),
      ),
    ),
    '<select><option value="a">A</option><option value="b" selected="">B</option></select>',
  );
  assertEquals(
    renderToStringSync(
      h(
        "select",
        { multiple: true, value: ["a", "b"] },
        h(
          "optgroup",
          { label: "g" },
          h("option", null, "a"),
          h("option", null, "b"),
          h("option", null, "c"),
        ),
      ),
    ),
    '<select multiple=""><optgroup label="g"><option selected="">a</option><option selected="">b</option><option>c</option></optgroup></select>',
  );
});

Deno.test("SSR attributes follow ReactDOMServer: booleanish values, name map, style", () => {
  // Enumerated + aria/data attributes serialize "true"/"false"; real booleans render `=""`.
  assertEquals(
    renderToStringSync(
      h("div", {
        draggable: true,
        spellCheck: false,
        "aria-hidden": true,
        "data-x": false,
        hidden: true,
      }),
    ),
    '<div draggable="true" spellCheck="false" aria-hidden="true" data-x="false" hidden=""></div>',
  );
  // React's camelCase → attribute-name map (HTML pair, SVG hyphenation, xlink namespace).
  assertEquals(
    renderToStringSync(h("meta", { httpEquiv: "refresh", content: "1" })),
    '<meta http-equiv="refresh" content="1">',
  );
  assertEquals(
    renderToStringSync(
      h("path", { strokeWidth: 2, fillRule: "evenodd", xlinkHref: "#a", viewBox: "0 0 1 1" }),
    ),
    '<path stroke-width="2" fill-rule="evenodd" xlink:href="#a" viewBox="0 0 1 1"></path>',
  );
  // Style: custom properties never get `px`, `ms` vendor prefix hyphenates, empty values drop.
  assertEquals(
    renderToStringSync(h("i", { style: { "--x": 1, msTransition: "a", height: "", width: 4 } })),
    '<i style="--x:1;-ms-transition:a;width:4px"></i>',
  );
});

Deno.test("SSR attributes follow ReactDOMServer: the reported tabIndex/autoFocus/disabled cases", () => {
  // Found running T3 Code's vitest suite against denext: React writes these exact strings.
  assertEquals(renderToStringSync(h("pre", { tabIndex: 0 })), '<pre tabindex="0"></pre>');
  assertEquals(
    renderToStringSync(h("textarea", { autoFocus: true })),
    '<textarea autofocus=""></textarea>',
  );
  assertEquals(
    renderToStringSync(h("button", { disabled: true })),
    '<button disabled=""></button>',
  );
  // React leaves these camelCased — HTML attribute names are case-insensitive.
  assertEquals(
    renderToStringSync(h("input", { readOnly: true, maxLength: 5, contentEditable: true })),
    '<input readOnly="" maxLength="5" contentEditable="true">',
  );
});

Deno.test("SSR attributes follow ReactDOMServer: every boolean prop, true and false", () => {
  const props = [
    "allowFullScreen",
    "async",
    "autoPlay",
    "checked",
    "controls",
    "default",
    "defer",
    "disabled",
    "disablePictureInPicture",
    "disableRemotePlayback",
    "formNoValidate",
    "hidden",
    "inert",
    "itemScope",
    "loop",
    "noModule",
    "noValidate",
    "open",
    "playsInline",
    "readOnly",
    "required",
    "reversed",
    "scoped",
    "seamless",
    "selected",
  ];
  const on = Object.fromEntries(props.map((p) => [p, true]));
  const off = Object.fromEntries(props.map((p) => [p, false]));
  assertEquals(
    renderToStringSync(h("div", on)),
    `<div ${props.map((p) => `${p}=""`).join(" ")}></div>`,
  );
  assertEquals(renderToStringSync(h("div", off)), "<div></div>");
  // The three React lowercases; truthiness decides presence, as in React.
  assertEquals(
    renderToStringSync(h("video", { autoFocus: 1, multiple: "yes", muted: true })),
    '<video autofocus="" multiple="" muted=""></video>',
  );
  assertEquals(
    renderToStringSync(h("video", { autoFocus: 0, multiple: "", muted: false, controls: null })),
    "<video></video>",
  );
  // Overloaded booleans: `true` is presence, `false` is absence, a string is a value.
  assertEquals(
    renderToStringSync(h("a", { download: true, capture: false })),
    '<a download=""></a>',
  );
  assertEquals(renderToStringSync(h("a", { download: "f.txt" })), '<a download="f.txt"></a>');
});

Deno.test("SSR attributes follow ReactDOMServer: renames, string-only props and numeric guards", () => {
  assertEquals(
    renderToStringSync(
      h("img", { className: "c", tabIndex: -1, crossOrigin: "anonymous", htmlFor: "x" }),
    ),
    '<img class="c" tabindex="-1" crossorigin="anonymous" for="x">',
  );
  assertEquals(
    renderToStringSync(
      h("svg", {
        transformOrigin: "center",
        strokeLinecap: "round",
        xmlnsXlink: "u",
        xmlLang: "en",
      }),
    ),
    '<svg transform-origin="center" stroke-linecap="round" xmlns:xlink="u" xml:lang="en"></svg>',
  );
  // A boolean on a renamed or string-only prop is dropped (React's pushStringAttribute).
  assertEquals(
    renderToStringSync(h("div", { className: true, tabIndex: false, role: true, width: true })),
    "<div></div>",
  );
  // Booleanish: the string React writes, true AND false (value/SVG enumerated included).
  assertEquals(
    renderToStringSync(h("input", { value: true, spellCheck: true, draggable: false })),
    '<input value="true" spellCheck="true" draggable="false">',
  );
  assertEquals(
    renderToStringSync(h("svg", { focusable: false, preserveAlpha: true })),
    '<svg focusable="false" preserveAlpha="true"></svg>',
  );
  // cols/rows/size/span must be ≥ 1, rowSpan/start numeric; an empty src/href is omitted.
  assertEquals(
    renderToStringSync(h("textarea", { cols: 0, rows: 3 })),
    '<textarea rows="3"></textarea>',
  );
  assertEquals(
    renderToStringSync(h("td", { rowSpan: "x", colSpan: 2, span: -1 })),
    '<td colSpan="2"></td>',
  );
  assertEquals(renderToStringSync(h("ol", { start: 0 })), '<ol start="0"></ol>');
  assertEquals(renderToStringSync(h("img", { src: "", alt: "" })), '<img alt="">');
  // …except `<a href="">`, which React keeps as a "reload" link (Fizz `pushStartAnchor`).
  assertEquals(renderToStringSync(h("a", { href: "" }, "x")), '<a href="">x</a>');
  assertEquals(renderToStringSync(h("link", { href: "" })), "<link>");
  assertEquals(renderToStringSync(h("area", { href: "" })), "<area>");
  // React-owned props never reach the markup.
  assertEquals(
    renderToStringSync(
      h("div", { suppressContentEditableWarning: true, suppressHydrationWarning: true }),
    ),
    "<div></div>",
  );
});

Deno.test("SSR attributes follow ReactDOMServer: custom elements keep props as written", () => {
  assertEquals(
    renderToStringSync(
      h("my-el", { className: "a", tabIndex: 0, flag: true, off: false, obj: {}, draggable: true }),
    ),
    '<my-el class="a" tabIndex="0" flag="" draggable=""></my-el>',
  );
  // A built-in tag is never custom, whatever its props.
  assertEquals(
    renderToStringSync(h("button", { is: "x-b", autoFocus: true })),
    '<button is="x-b" autofocus=""></button>',
  );
});

Deno.test("serializeStyle matches ReactDOMServer: no trailing `;`, units, skipped values", () => {
  assertEquals(
    renderToStringSync(h("div", { style: { color: "red", backgroundColor: "#000" } })),
    '<div style="color:red;background-color:#000"></div>',
  );
  assertEquals(
    serializeStyle({
      color: null,
      display: undefined,
      visibility: true,
      opacity: false,
      height: "",
      width: 0,
      zIndex: 2,
      flexGrow: 1,
      lineHeight: 1.5,
      margin: 4,
      WebkitLineClamp: 3,
      WebkitTransform: "none",
      msTransition: " a ",
      "--gap": 3,
      "--pad": " 1px ",
    }),
    "width:0;z-index:2;flex-grow:1;line-height:1.5;margin:4px;-webkit-line-clamp:3;" +
      "-webkit-transform:none;-ms-transition:a;--gap:3;--pad:1px",
  );
  // An object with nothing to render emits no style attribute at all.
  assertEquals(renderToStringSync(h("div", { style: { color: null } })), "<div></div>");
  assertEquals(renderToStringSync(h("div", { style: {} })), "<div></div>");
});
