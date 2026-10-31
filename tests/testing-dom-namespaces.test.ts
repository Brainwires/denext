// denext/testing's in-memory DOM keeps SVG and MathML in their own namespaces, as a browser
// does: components that render SVG mount, query, serialize and take events under `render()`.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { useState } from "denext";
import { h } from "denext/jsx-runtime";
import { fireEvent, render } from "denext/testing";
import { DomDocument, type DomEl, walkElements } from "../src/testing/dom.ts";

const SVG = "http://www.w3.org/2000/svg";
const MATHML = "http://www.w3.org/1998/Math/MathML";
const HTML = "http://www.w3.org/1999/xhtml";
const XLINK = "http://www.w3.org/1999/xlink";

function Icon({ onPick }: { onPick: (id: string) => void }) {
  const [on, setOn] = useState(false);
  return h(
    "svg",
    { viewBox: "0 0 24 24", role: "img", "aria-label": "Loop", "data-testid": "icon" },
    h(
      "defs",
      null,
      h(
        "linearGradient",
        { id: "g" },
        h("stop", { offset: "0", stopColor: "red" }),
      ),
    ),
    h("circle", {
      "data-testid": "dot",
      cx: 12,
      cy: 12,
      r: on ? 8 : 4,
      strokeWidth: 2,
      onClick: () => {
        setOn(!on);
        onPick("dot");
      },
    }),
    h("foreignObject", { width: 10, height: 10 }, h("p", null, "inside")),
    h("text", { x: 1, y: 2 }, on ? "on" : "off"),
  );
}

Deno.test("render() mounts an SVG subtree in the SVG namespace, case-preserved", async () => {
  const picked: string[] = [];
  const screen = await render(h(Icon, { onPick: (id: string) => picked.push(id) }));
  const svg = screen.getByTestId("icon") as unknown as DomEl;
  assertEquals(svg.namespaceURI, SVG);
  assertEquals(svg.tagName, "svg");
  assertEquals(svg.localName, "svg");
  assertEquals(screen.getByRole("img", { name: "Loop" }), svg);
  const els = walkElements(svg);
  const gradient = els.find((el) => el.localName === "linearGradient")!;
  assertEquals(gradient.tagName, "linearGradient");
  assertEquals(gradient.namespaceURI, SVG);
  const fo = els.find((el) => el.localName === "foreignObject")!;
  assertEquals(fo.namespaceURI, SVG);
  // A <foreignObject>'s content is HTML again.
  const p = screen.getByText("inside") as unknown as DomEl;
  assertEquals(p.namespaceURI, HTML);
  assertEquals(p.tagName, "P");
  // camelCase presentation props are written hyphenated, as on an SVG element in a browser.
  const dot = screen.getByTestId("dot");
  assertEquals(dot.getAttribute("stroke-width"), "2");
  assertEquals(svg.getAttribute("viewBox"), "0 0 24 24");
  assert(screen.html().includes('<linearGradient id="g"><stop'));
  assert(screen.html().includes("<foreignObject"));
  assertEquals(screen.getByText("off").tagName, "text");

  // Events on SVG elements reach their handlers (delegated from the root).
  await screen.fireEvent.click(dot);
  assertEquals(picked, ["dot"]);
  assertEquals(screen.getByTestId("dot").getAttribute("r"), "8");
  assertEquals(screen.getByText("on").tagName, "text");
  await fireEvent.click(screen.getByTestId("dot"));
  assertEquals(screen.getByTestId("dot").getAttribute("r"), "4");
});

Deno.test("render() mounts MathML in the MathML namespace", async () => {
  const screen = await render(h("math", { "data-testid": "m" }, h("mi", null, "x")));
  const math = screen.getByTestId("m");
  assertEquals(math.namespaceURI, MATHML);
  assertEquals(math.tagName, "math");
  assertEquals(screen.getByText("x").namespaceURI, MATHML);
  assertEquals(screen.getByText("x").localName, "mi");
  assertEquals(screen.html(), '<math data-testid="m"><mi>x</mi></math>');
});

Deno.test("createElementNS / setAttributeNS / getAttributeNS", () => {
  const doc = new DomDocument();
  const html = doc.createElement("div");
  assertEquals(html.namespaceURI, HTML);
  assertEquals(html.localName, "div");
  assertEquals(doc.createElementNS(HTML, "SPAN").tagName, "SPAN");
  assertEquals(doc.createElementNS(null, "Thing").tagName, "Thing");
  assertEquals(doc.createElementNS(null, "Thing").namespaceURI, null);

  const use = doc.createElementNS(SVG, "use");
  assertEquals(use.ownerDocument, doc);
  use.setAttributeNS(XLINK, "xlink:href", "#g");
  use.setAttributeNS(null, "x", "1");
  assertEquals(use.getAttributeNS(XLINK, "href"), "#g");
  assertEquals(use.getAttribute("xlink:href"), "#g");
  assertEquals(use.getAttributeNS(null, "x"), "1");
  assertEquals(use.getAttributeNS(SVG, "x"), null);
  assertEquals(use.getAttributeNS(XLINK, "missing"), null);
  assert(use.hasAttributeNS(XLINK, "href"));
  assertEquals(use.outerHTML, '<use xlink:href="#g" x="1"></use>');
  use.removeAttributeNS(XLINK, "href");
  assert(!use.hasAttributeNS(XLINK, "href"));
  assert(!use.hasAttribute("xlink:href"));
  use.removeAttributeNS(XLINK, "href"); // absent: a no-op
  // A plain setAttribute is in no namespace.
  use.setAttribute("xlink:title", "t");
  assertEquals(use.getAttributeNS(XLINK, "title"), null);
  assertEquals(use.getAttributeNS(null, "xlink:title"), "t");
  // Re-setting a namespaced attribute under a new prefix keeps one attribute.
  use.setAttributeNS(XLINK, "xlink:href", "#a");
  use.setAttributeNS(XLINK, "xl:href", "#b");
  assertEquals(use.getAttributeNS(XLINK, "href"), "#b");
  assertEquals(use.getAttribute("xlink:href"), null);
  const err = assertThrows(() => use.setAttributeNS(null, "a:b", "x"), DOMException);
  assertEquals(err.name, "NamespaceError");
});

Deno.test("innerHTML parses <svg> and <math> into their namespaces", () => {
  const doc = new DomDocument();
  const div = doc.createElement("div");
  div.innerHTML = '<svg viewBox="0 0 1 1"><clipPath id="c"><rect/></clipPath>' +
    "<foreignObject><p>hi<br>there</p></foreignObject><path d='M0'/></svg><math><mi>y</mi></math><b>z</b>";
  const [svg, math, b] = div.children;
  assertEquals(svg.namespaceURI, SVG);
  assertEquals(svg.tagName, "svg");
  const [clip, fo, path] = svg.children;
  assertEquals(clip.tagName, "clipPath");
  assertEquals(clip.children[0].tagName, "rect");
  assertEquals(clip.children[0].namespaceURI, SVG);
  assertEquals(fo.tagName, "foreignObject");
  assertEquals(fo.children[0].namespaceURI, HTML);
  assertEquals(fo.children[0].tagName, "P");
  // HTML's void elements are void again inside a <foreignObject>.
  const [br] = fo.children[0].children;
  assertEquals(br.tagName, "BR");
  assertEquals(br.childNodes.length, 0);
  assertEquals(fo.children[0].textContent, "hithere");
  fo.remove();
  // A self-closed SVG element is closed; the next sibling is not its child.
  assertEquals(path.tagName, "path");
  assertEquals(path.childNodes.length, 0);
  assertEquals(math.namespaceURI, MATHML);
  assertEquals(math.children[0].namespaceURI, MATHML);
  assertEquals(b.namespaceURI, HTML);
  assertEquals(
    div.innerHTML,
    '<svg viewBox="0 0 1 1"><clipPath id="c"><rect></rect></clipPath>' +
      '<path d="M0"></path></svg>' +
      "<math><mi>y</mi></math><b>z</b>",
  );
});
