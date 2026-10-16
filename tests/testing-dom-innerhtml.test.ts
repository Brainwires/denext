// denext/testing's in-memory DOM parses an `innerHTML` assignment into child nodes, as a browser
// does (src/testing/dom.ts's parseHtmlInto, shared with tests/helpers/dom.ts). A component test
// therefore sees injected markup as real nodes: queries find its text and elements, and a
// reconciler that prunes or re-creates the nodes is caught.

import { assert, assertEquals } from "@std/assert";
import { useState } from "denext";
import { h } from "denext/jsx-runtime";
import { render } from "denext/testing";
import { DomDocument, type DomEl, type DomText } from "../src/testing/dom.ts";

function el(html: string): DomEl {
  const div = new DomDocument().createElement("div");
  div.innerHTML = html;
  return div;
}

Deno.test("innerHTML builds elements, attributes and text nodes", () => {
  const div = el(`<p class="a" data-x='1' hidden>hi <b id=b>there</b></p>tail`);
  assertEquals(div.childNodes.length, 2);
  const p = div.children[0];
  assertEquals(p.tagName, "P");
  assertEquals(p.getAttribute("class"), "a");
  assertEquals(p.getAttribute("data-x"), "1");
  assertEquals(p.getAttribute("hidden"), "");
  assertEquals(p.children[0].getAttribute("id"), "b");
  assertEquals(p.textContent, "hi there");
  assertEquals((div.childNodes[1] as DomText).nodeValue, "tail");
  assertEquals(div.innerHTML, `<p class="a" data-x="1" hidden="">hi <b id="b">there</b></p>tail`);
  assert(p.ownerDocument !== null, "parsed elements belong to the element's document");
});

Deno.test("innerHTML: void elements, character references, raw text, comments, stray tags", () => {
  const div = el(
    `<br/><input value="a &amp; b">x &lt;y&gt; &#38; &#x26; &bogus;<!-- c -->` +
      `<script>if (a < b) "</b>"</script><textarea>&lt;t&gt;</textarea></i>a < b<span>z`,
  );
  const tags = div.children.map((c) => c.tagName);
  assertEquals(tags, ["BR", "INPUT", "SCRIPT", "TEXTAREA", "SPAN"]);
  assertEquals(div.children[0].childNodes.length, 0, "a void element takes no children");
  assertEquals(div.children[1].getAttribute("value"), "a & b");
  assertEquals(div.children[2].textContent, `if (a < b) "</b>"`, "script text is not parsed");
  assertEquals(div.children[3].textContent, "<t>", "textarea text decodes references");
  assertEquals(div.children[4].textContent, "z", "an unclosed element takes the rest");
  assertEquals(div.textContent, `x <y> & & &bogus;if (a < b) "</b>"<t>a < bz`);
  div.innerHTML = "";
  assertEquals(div.childNodes.length, 0);
});

Deno.test("render: dangerouslySetInnerHTML markup is queryable, and kept across re-renders", async () => {
  let bump: () => void = () => {};
  function Article() {
    const [n, setN] = useState(0);
    bump = () => setN((v) => v + 1);
    return h(
      "article",
      { title: String(n), dangerouslySetInnerHTML: { __html: "<h2>Title</h2><p>Body</p>" } },
    );
  }
  const screen = await render(h(Article, null));
  const heading = screen.getByText("Title");
  assertEquals(heading.tagName, "H2");
  assertEquals(screen.getByRole("heading").textContent, "Title");
  assertEquals(screen.html(), '<article title="0"><h2>Title</h2><p>Body</p></article>');
  await screen.act(() => bump());
  assert(screen.getByText("Title") === heading, "the injected nodes are not re-created");
  assertEquals(screen.html(), '<article title="1"><h2>Title</h2><p>Body</p></article>');
});
