// `denext/preact/compat`'s Preact-only helpers (`createFactory`, `findDOMNode`, `isFragment`,
// `isMemo`, `unmountComponentAtNode`, the callback of `render` / `hydrate` and `flushSync`'s
// argument) and `denext/preact/jsx-runtime`'s precompiled-JSX helpers (`jsxTemplate`, `jsxAttr`,
// `jsxEscape`), which Deno's `"jsx": "precompile"` transform calls.

import "./helpers/class-runtime.ts";
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { setDocument } from "../src/client/reconciler.ts";
import { DomDocument, type TestElement } from "../src/testing/dom.ts";
import { act } from "../src/client/mod.ts";
import PreactCompat, {
  Component,
  createFactory,
  findDOMNode,
  flushSync,
  Fragment,
  hydrate,
  isFragment,
  isMemo,
  memo,
  render,
  unmountComponentAtNode,
  useState,
} from "../src/compat/preact/compat.ts";
import { h } from "../src/compat/preact/mod.ts";
import { jsx, jsxAttr, jsxEscape, jsxTemplate } from "../src/compat/preact/jsx-runtime.ts";
import { options } from "../src/compat/preact/options.ts";
import { renderToString } from "../src/compat/preact/render-to-string.ts";

/** A detached container in a fresh in-memory document. */
function container(): Element {
  const doc = new DomDocument();
  setDocument(doc as unknown as Parameters<typeof setDocument>[0]);
  return doc.createElement("div") as unknown as Element;
}

// ── preact/compat ───────────────────────────────────────────────────────────────────

Deno.test("preact/compat render: the callback runs after the DOM is updated; a second call re-renders", async () => {
  const el = container();
  const seen: string[] = [];
  await act(() => {
    render(h("p", null, "one"), el, () => seen.push(el.innerHTML));
  });
  assertEquals(seen, ["<p>one</p>"]);
  await act(() => {
    render(h("p", null, "two"), el, () => seen.push(el.innerHTML));
  });
  assertEquals(seen, ["<p>one</p>", "<p>two</p>"]);
  assertEquals(el.innerHTML, "<p>two</p>");
  await act(() => {
    assertStrictEquals(unmountComponentAtNode(el), true);
  });
  assertEquals(el.innerHTML, "");
  assertStrictEquals(unmountComponentAtNode(el), false);
});

Deno.test("preact/compat hydrate: the callback runs after hydration; unmountComponentAtNode removes it", async () => {
  const el = container();
  el.innerHTML = "<b>x</b>";
  let called = 0;
  await act(() => {
    hydrate(h("b", null, "x"), el, () => called++);
  });
  assertEquals(called, 1);
  assertEquals(el.innerHTML, "<b>x</b>");
  await act(() => {
    assert(unmountComponentAtNode(el));
  });
  assertEquals(el.innerHTML, "");
});

Deno.test("preact/compat flushSync passes its second argument to the callback and flushes", async () => {
  const el = container();
  let bump: (n: number) => void = () => {};
  function Counter() {
    const [n, setN] = useState(0);
    bump = setN;
    return h("i", null, n);
  }
  await act(() => {
    render(h(Counter, null), el);
  });
  const out = flushSync((n: number) => {
    bump(n);
    return "done";
  }, 7);
  assertEquals(out, "done");
  assertEquals(el.innerHTML, "<i>7</i>");
  assertEquals(flushSync(() => 3), 3);
  await act(() => {
    unmountComponentAtNode(el);
  });
});

Deno.test("preact/compat createFactory, isFragment and isMemo follow Preact", () => {
  const li = createFactory("li");
  const item = li({ id: "a" }, "text");
  assertEquals(item.type, "li");
  assertEquals((item.props as { id: string; children: unknown }).id, "a");
  assertEquals(renderToString(item), '<li id="a">text</li>');

  assert(isFragment(h(Fragment, null, "x")));
  assert(!isFragment(h("div", null)));
  assert(!isFragment(Fragment));
  assert(!isFragment(null));

  const Plain = () => h("b", null);
  assert(isMemo(memo(Plain)));
  assert(!isMemo(Plain));
  assert(!isMemo(h(Plain, null)));
  assert(!isMemo(null));
  assert(isMemo({ displayName: "Memo(Thing)" }));

  for (
    const name of [
      "createFactory",
      "findDOMNode",
      "flushSync",
      "hydrate",
      "isFragment",
      "isMemo",
      "render",
      "unmountComponentAtNode",
    ]
  ) {
    assertEquals(typeof (PreactCompat as unknown as Record<string, unknown>)[name], "function");
  }
});

Deno.test("preact/compat findDOMNode: a class instance's first node, an element as itself", async () => {
  const el = container();
  let instance: object | null = null;
  class Box extends Component<{ label: string }> {
    constructor(props: { label: string }) {
      super(props);
      instance = this;
    }
    override render() {
      return h("section", { id: "box" }, this.props.label);
    }
  }
  class Empty extends Component {
    override render() {
      return null;
    }
  }
  let empty: object | null = null;
  await act(() => {
    render(
      h(
        "div",
        null,
        h(Box as never, { label: "a" }),
        h(Empty as never, {
          ref: (c: object | null) => {
            empty = c ?? empty;
          },
        }),
      ),
      el,
    );
  });
  const node = findDOMNode(instance) as Element;
  assertEquals(node.tagName.toLowerCase(), "section");
  assertEquals(node.textContent, "a");
  await act(() => {
    render(h("div", null, h(Box as never, { label: "b" }), h(Empty as never, null)), el);
  });
  assertEquals((findDOMNode(instance) as Element).textContent, "b");
  assertStrictEquals(findDOMNode(node), node);
  assertStrictEquals(findDOMNode(empty), null);
  assertStrictEquals(findDOMNode(null), null);
  assertStrictEquals(findDOMNode({}), null);
  await act(() => {
    unmountComponentAtNode(el);
  });
});

// ── precompiled JSX ─────────────────────────────────────────────────────────────────

Deno.test("jsxAttr serializes as Preact's: bare booleans, dropped values, style objects, escaping", () => {
  assertEquals(jsxAttr("id", 'a"<&>'), 'id="a&quot;&lt;&amp;>"');
  assertEquals(jsxAttr("disabled", true), "disabled");
  assertEquals(jsxAttr("tabindex", 0), 'tabindex="0"');
  for (const v of [null, undefined, false, () => {}, { a: 1 }]) assertEquals(jsxAttr("x", v), "");
  assertEquals(jsxAttr("key", "k"), "");
  assertEquals(jsxAttr("ref", "r"), "");
  assertEquals(
    jsxAttr("style", { color: "red", fontSize: 12, opacity: 0.5, "--v": 1, empty: "", gap: null }),
    'style="color:red;font-size:12px;opacity:0.5;--v:1;"',
  );
  // A value with `valueOf` (a signal) is read.
  assertEquals(jsxAttr("value", { valueOf: () => "sig" }), 'value="sig"');
  options.attr = (name) => (name === "data-x" ? 'data-x="hooked"' : undefined);
  try {
    assertEquals(jsxAttr("data-x", 1), 'data-x="hooked"');
    assertEquals(jsxAttr("data-y", 1), 'data-y="1"');
  } finally {
    delete options.attr;
  }
});

Deno.test("jsxEscape escapes text, keeps elements and drops null / booleans / functions", () => {
  assertEquals(jsxEscape('<a href="x">&'), "&lt;a href=&quot;x&quot;>&amp;");
  assertEquals(jsxEscape(3), "3");
  assertStrictEquals(jsxEscape(null), null);
  assertStrictEquals(jsxEscape(undefined), null);
  assertStrictEquals(jsxEscape(true), null);
  assertStrictEquals(jsxEscape(() => 1), null);
  const el = jsx("b", null);
  assertStrictEquals(jsxEscape(el), el);
  const list: unknown[] = ["<", el, false];
  assertStrictEquals(jsxEscape(list), list);
  assertEquals(list, ["&lt;", el, null]);
});

Deno.test("jsxTemplate builds the element tree Deno's precompile transform describes", async () => {
  const Comp = (p: { x: number }) => jsx("em", { children: p.x });
  // What `deno` emits for
  //   <div class="a" id={id} onClick={f} disabled>{text} &amp; t <Comp x={1} /><br/>
  //   <img src="q" /><span style={{ color: "red" }} /></div>
  const tpl = [
    '<div class="a" ',
    " ",
    " disabled>",
    " &amp; t ",
    '<br><img src="q"><span ',
    "></span></div>",
  ];
  const tree = jsxTemplate(
    tpl,
    jsxAttr("id", "a<b"),
    jsxAttr("onclick", () => {}),
    jsxEscape("x<y"),
    jsx(Comp as never, { x: 1 }),
    jsxAttr("style", { color: "red" }),
  );
  assertEquals(tree.type, "div");
  const expected = '<div class="a" id="a&lt;b" disabled>x&lt;y &amp; t <em>1</em><br/>' +
    '<img src="q"/><span style="color:red;"></span></div>';
  assertEquals(renderToString(tree), expected);
  // The same strings array is parsed once and reused.
  assertEquals(
    renderToString(jsxTemplate(tpl, "", "", jsxEscape(["p", null]), null, "")),
    '<div class="a" disabled>p &amp; t <br/><img src="q"/><span></span></div>',
  );
  // Several roots come back in a Fragment; SVG keeps its tag and attribute case.
  const many = jsxTemplate(['<p>1</p><svg viewBox="0 0 1 1"><path d="M0"/></svg>']);
  assert(isFragment(many));
  assertEquals(
    renderToString(many),
    '<p>1</p><svg viewBox="0 0 1 1"><path d="M0"></path></svg>',
  );
  // It mounts in the browser too.
  const el = container();
  await act(() => {
    render(tree, el);
  });
  const div = (el as unknown as TestElement).children[0];
  assertEquals(div.tagName.toLowerCase(), "div");
  assertEquals(div.getAttribute("id"), "a<b");
  assertEquals(div.getAttribute("class"), "a");
  assert(div.hasAttribute("disabled"));
  assertEquals(div.textContent, "x<y & t 1");
  assertEquals(div.children.map((c) => c.localName), ["em", "br", "img", "span"]);
  assertEquals(div.children[2].getAttribute("src"), "q");
  assertEquals(div.children[3].getAttribute("style"), "color:red;");
  await act(() => {
    unmountComponentAtNode(el);
  });
});

Deno.test({
  name: 'jsxImportSource "preact" with "jsx": "precompile" renders through denext',
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_preact_precompile_" });
    try {
      const src = (p: string) => new URL(`../src/compat/preact/${p}`, import.meta.url).href;
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          compilerOptions: { jsx: "precompile", jsxImportSource: "preact" },
          imports: {
            "preact/jsx-runtime": src("jsx-runtime.ts"),
            "preact-render-to-string": src("render-to-string.ts"),
          },
        }),
      );
      await Deno.writeTextFile(
        join(dir, "main.tsx"),
        [
          'import { renderToString } from "preact-render-to-string";',
          "function Item(p: { n: number }) { return <li data-n={p.n}>item {p.n}</li>; }",
          'const label = "a<b";',
          "const page = (",
          '  <main class="m" title={label}>',
          "    <h1>{label} &amp; more</h1>",
          "    <ul>{[1, 2].map((n) => <Item n={n} />)}</ul>",
          "    <input disabled value={label} />",
          "  </main>",
          ");",
          "console.log(renderToString(page));",
        ].join("\n"),
      );
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--quiet",
          "--no-check",
          "-A",
          "--config",
          join(dir, "deno.json"),
          "main.tsx",
        ],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(out.stderr);
      assert(out.success, stderr);
      assertEquals(
        new TextDecoder().decode(out.stdout).trim(),
        '<main class="m" title="a&lt;b"><h1>a&lt;b &amp; more</h1><ul>' +
          '<li data-n="1">item 1</li><li data-n="2">item 2</li></ul>' +
          '<input disabled value="a&lt;b"/></main>',
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
