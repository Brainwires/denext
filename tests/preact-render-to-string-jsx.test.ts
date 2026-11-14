// `denext/preact/render-to-string/jsx` and `/stream-node`: preact-render-to-string's pretty JSX
// renderer and its pipeable Node stream. Each expected string is what preact-render-to-string
// 6.6.5 (`npm:preact-render-to-string/jsx`, `/stream-node`) writes for the same tree with Preact
// 10.27, recorded once from the real package.

import "./helpers/class-runtime.ts";
import { assertEquals } from "@std/assert";
import { Writable } from "node:stream";
import { createContext, h } from "../src/compat/preact/mod.ts";
import { useContext, useState } from "../src/compat/preact/hooks.ts";
import render, { shallowRender } from "../src/compat/preact/render-to-string-jsx.ts";
import { renderToPipeableStream } from "../src/compat/preact/render-to-string-stream-node.ts";

const Ctx = createContext("none");
function Child({ label }: { label: string }) {
  const v = useContext(Ctx);
  const [n] = useState(2);
  return h("span", { class: "c" }, label, ":", v, ":", n);
}
function Card(props: { title: string; items: string[] }) {
  return h(
    "div",
    { class: "card", "data-x": 3 },
    h("h1", null, props.title),
    h("ul", null, props.items.map((i) => h("li", { key: i }, i))),
  );
}
// deno-lint-ignore no-explicit-any
const C = (_: any) => null as unknown as ReturnType<typeof h>;

const CASES: [string, unknown, string][] = [
  [
    "simple",
    h("div", { id: "a", class: "b" }, "hello"),
    '<div\n  id="a"\n  class="b"\n>\n  hello\n</div>',
  ],
  [
    "nested component",
    h(Card, { title: "T", items: ["one", "two"] }),
    '<div\n  class="card"\n  data-x="3"\n>\n  <h1>T</h1>\n  <ul>\n    <li>one</li>\n    <li>two</li>\n  </ul>\n</div>',
  ],
  [
    "attributes",
    h("input", {
      type: "checkbox",
      checked: true,
      disabled: false,
      value: "x",
      onClick: function onClick() {},
      style: { color: "red", marginTop: 4 },
    }),
    '<input\n  type="checkbox"\n  checked={true}\n  value="x"\n  onClick={[Function onClick]}\n  style="color:red;margin-top:4px;"\n />',
  ],
  ["hooks", h(Child, { label: "L" }), '<span class="c">L:none:2</span>'],
  [
    "context",
    h(Ctx.Provider, { value: "yes" }, h(Child, { label: "P" })),
    '<span class="c">P:yes:2</span>',
  ],
  [
    "long text",
    h("p", null, "This is a long text node that goes over forty characters for sure"),
    "<p>\n  This is a long text node that goes over forty characters for sure\n</p>",
  ],
  [
    "data object",
    h("div", { "data-obj": { a: 1 } }, "x"),
    '<div data-obj="[object Object]">x</div>',
  ],
  [
    "function attr",
    h("div", { render: function named() {} }),
    "<div render={[Function named]}></div>",
  ],
  [
    "fragment",
    h("div", null, [h("b", null, "1"), h("i", null, "2")]).props.children,
    "<b>1</b>\n<i>2</i>",
  ],
  [
    "svg",
    h("svg", { viewBox: "0 0 1 1" }, h("path", { strokeWidth: 2, d: "M0" })),
    '<svg viewBox="0 0 1 1">\n  <path\n    stroke-width={2}\n    d="M0"\n  >\n  </path>\n</svg>',
  ],
  ["textarea", h("textarea", { value: "abc" }), '<textarea value="abc"></textarea>'],
  [
    "entities",
    h("p", { title: 'a"b<c&' }, "x<y & z"),
    '<p title="a&quot;b&lt;c&amp;">x&lt;y &amp; z</p>',
  ],
  ["empty", h("div", null), "<div></div>"],
  ["void", h("br", null), "<br />"],
  [
    "text merge",
    h("p", null, "a", "b", h("b", null, "c"), "d"),
    "<p>\n  ab\n  <b>c</b>\n  d\n</p>",
  ],
  ["pre", h("pre", null, "  keep\n  this"), "<pre>  keep\n  this</pre>"],
  [
    "raw html",
    h("div", {
      dangerouslySetInnerHTML: { __html: "<b>raw html that is quite long indeed yes</b>" },
    }),
    "<div>\n  <b>raw html that is quite long indeed yes</b>\n</div>",
  ],
  [
    "select",
    h("select", { value: "b" }, h("option", { value: "a" }, "A"), h("option", { value: "b" }, "B")),
    '<select value="b">\n  <option value="a">A</option>\n  <option value="b">B</option>\n</select>',
  ],
  [
    "renamed attributes",
    h("div", { className: "x", htmlFor: "y", tabIndex: 1, "aria-hidden": true }),
    '<div\n  class="x"\n  for="y"\n  tabindex={1}\n  aria-hidden="true"\n>\n</div>',
  ],
];

for (const [name, tree, expected] of CASES) {
  Deno.test(`preact-render-to-string/jsx: ${name}`, () => {
    assertEquals(render(tree), expected);
  });
}

Deno.test("preact-render-to-string/jsx: shallowRender writes nested components with pretty-format props", () => {
  assertEquals(
    shallowRender(h("div", null, h(Card, { title: "T", items: ["a"] }))),
    '<div>\n  <Card\n    title="T"\n    items={\n      Array [\n        "a"\n      ]\n    }\n  >\n  </Card>\n</div>',
  );
  assertEquals(
    shallowRender(
      h(
        "div",
        null,
        h(C, { o: { a: 1, b: "x", n: null, u: undefined, arr: [1, "two"], nested: { z: true } } }),
      ),
    ),
    '<div>\n  <C\n    o={\n      Object {\n        "a": 1,\n        "arr": Array [\n          1,\n          "two"\n        ],\n        "b": "x",\n        "n": null,\n        "nested": Object {\n          "z": true\n        },\n        "u": undefined\n      }\n    }\n  >\n  </C>\n</div>',
  );
  assertEquals(
    shallowRender(h("div", null, h(C, { o: {}, a: [] }))),
    "<div>\n  <C\n    o={Object {}}\n    a={Array []}\n  >\n  </C>\n</div>",
  );
  assertEquals(
    shallowRender(h("div", null, h(C, { el: h("b", null, "hi") }))),
    "<div>\n  <C el={<b>hi</b>}></C>\n</div>",
  );
  assertEquals(
    shallowRender(h("div", null, h(C, { s: "q&quot", n: 5, b: false }))),
    '<div>\n  <C\n    s="q&amp;quot"\n    n={5}\n    b={false}\n  >\n  </C>\n</div>',
  );
  const X = (() => () => h("i", null))();
  assertEquals(
    shallowRender(h("div", null, h(X, null))),
    "<div>\n  <UnnamedComponent0></UnnamedComponent0>\n</div>",
  );
});

Deno.test("preact-render-to-string/jsx: pretty, xml and jsx options", () => {
  const tree = h("div", null, h("b", null, "x"), h("i", null, "y"));
  assertEquals(render(tree, {}, { pretty: false }), "<div><b>x</b><i>y</i></div>");
  assertEquals(
    render(h("div", null, h("span", null)), {}, { xml: true }),
    "<div>\n  <span />\n</div>",
  );
  assertEquals(
    render(h("div", null, h("b", null, "x")), {}, { jsx: false }),
    "<div>\n  <b>x</b>\n</div>",
  );
});

Deno.test("preact-render-to-string/stream-node: pipes the document; onShellReady before onAllReady", async () => {
  const chunks: string[] = [];
  const events: string[] = [];
  await new Promise<void>((resolve) => {
    const s = renderToPipeableStream(h("div", null, h("b", null, "streamed")), {
      onShellReady() {
        events.push("shell");
        s.pipe(
          new Writable({
            write(c, _e, cb) {
              chunks.push(new TextDecoder().decode(c));
              cb();
            },
            final(cb) {
              cb();
              resolve();
            },
          }),
        );
      },
      onAllReady() {
        events.push("all");
      },
    });
  });
  assertEquals(chunks.join(""), "<div><b>streamed</b></div>");
  assertEquals(events, ["shell", "all"]);
});

Deno.test("preact-render-to-string/stream-node: abort() reports the reason and ends the stream", async () => {
  const errors: unknown[] = [];
  const s = renderToPipeableStream(h("p", null, "x"), { onError: (e) => errors.push(e) });
  s.abort(new Error("stop"));
  s.abort(new Error("again"));
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(errors.map((e) => (e as Error).message), ["stop"]);
});

Deno.test("preact-render-to-string/jsx: HTML attributes (jsx: false), sorting, function and tab options", () => {
  const html = { jsx: false };
  assertEquals(
    render(
      h(
        "select",
        { value: "b" },
        h("option", { value: "a" }, "A"),
        h("option", { value: "b" }, "B"),
      ),
      {},
      html,
    ),
    '<select>\n  <option value="a">A</option>\n  <option selected value="b">B</option>\n</select>',
  );
  assertEquals(
    render(
      h("input", {
        disabled: true,
        checked: false,
        value: "",
        onClick: () => {},
        "data-n": 0,
        title: "",
      }),
      {},
      html,
    ),
    '<input disabled value data-n="0" title />',
  );
  assertEquals(
    render(h("input", { disabled: true, value: "" }), {}, { jsx: false, xml: true }),
    '<input disabled="disabled" value="value" />',
  );
  assertEquals(render(h("textarea", { value: "abc" }), {}, html), "<textarea>abc</textarea>");
  assertEquals(
    render(h("div", { dangerouslySetInnerHTML: { __html: "<i>x</i>" } }), {}, html),
    "<div>\n  <i>x</i>\n</div>",
  );
  assertEquals(
    render(h("div", { b: "2", a: "1" }), {}, { sortAttributes: true }),
    '<div\n  a="1"\n  b="2"\n>\n</div>',
  );
  assertEquals(render(h("div", { f: () => {} }), {}, { functions: false }), "<div></div>");
  assertEquals(
    render(h("div", { f: function named() {} }), {}, { functionNames: false }),
    "<div f={Function}></div>",
  );
  assertEquals(
    render(h("svg", null, h("use", { xlinkHref: "#a" })), {}, html),
    '<svg>\n  <use xlink:href="#a"></use>\n</svg>',
  );
  assertEquals(
    render(h("div", null, h("b", null, "x that is long enough to be large for sure here")), {}, {
      pretty: true,
    }),
    "<div>\n\t<b>\n\t\tx that is long enough to be large for sure here\n\t</b>\n</div>",
  );
});
