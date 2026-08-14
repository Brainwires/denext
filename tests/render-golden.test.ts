// Golden-output test: one comprehensive tree whose exact serialized HTML is
// pinned here. renderToString's output is what client hydration diffs against, so
// any byte-level drift — attribute order, whitespace, escaping, void-element
// handling — must be a deliberate, reviewed change to THIS string, not an
// accident of a renderer refactor. Exercises, in one render:
//   className→class, a style object (kebab-case + px default + unitless), a
//   boolean attribute, HTML escaping, a context provider (transparent),
//   a keyed list, a sync function component, an async function component,
//   a void element, and a dropped `javascript:` URL.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { createContext } from "../src/runtime/context.ts";

const Ctx = createContext("default");
const Sync = (p: { label: string }) => h("span", { class: "sync" }, p.label);
const Async = async (p: { n: number }) => {
  await Promise.resolve();
  return h("em", null, `n=${p.n}`);
};

Deno.test("golden: comprehensive tree serializes byte-for-byte", async () => {
  const tree = h(
    "div",
    { className: "app", style: { marginTop: 4, opacity: 1 }, hidden: true },
    h("h1", null, 'Tom & Jerry <"quotes">'),
    h(
      Ctx.Provider,
      { value: "ctx-val" },
      h(
        "ul",
        null,
        ["a", "b"].map((x, i) => h("li", { key: i, "data-x": x }, h(Sync, { label: x }))),
      ),
    ),
    h(Async, { n: 7 }),
    h("img", { src: "/logo.png", alt: "logo" }),
    h("a", { href: "javascript:alert(1)" }, "bad link"),
  );

  const html = await renderToString(tree as never);

  assertEquals(
    html,
    '<div class="app" style="margin-top:4px;opacity:1;" hidden>' +
      "<h1>Tom &amp; Jerry &lt;&quot;quotes&quot;&gt;</h1>" +
      '<ul><li data-x="a"><span class="sync">a</span></li>' +
      '<li data-x="b"><span class="sync">b</span></li></ul>' +
      "<em>n=7</em>" +
      '<img src="/logo.png" alt="logo">' +
      "<a>bad link</a>" +
      "</div>",
  );
});
