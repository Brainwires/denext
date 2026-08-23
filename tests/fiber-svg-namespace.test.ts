// SVG (and MathML) host elements must be created in their own namespace, or their
// vector/markup children render nothing (they occupy layout space but are invisible —
// the classic "icon shifts the text but doesn't show"). A `<foreignObject>` inside SVG
// switches its own children back to HTML. Regression for that.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const SVG = "http://www.w3.org/2000/svg";

Deno.test("svg + descendants get the SVG namespace; foreignObject content is HTML", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(
    h(
      "svg",
      { viewBox: "0 0 24 24" },
      h("path", { d: "M1 1" }),
      h("g", null, h("circle", { r: "2" })),
      h("foreignObject", null, h("div", null, h("span", null, "hi"))),
    ),
  );
  flushSync();
  // deno-lint-ignore no-explicit-any
  const svg = (container as any).childNodes[0];
  assertEquals(svg.namespaceURI, SVG, "<svg> must be in the SVG namespace");
  assertEquals(svg.childNodes[0].namespaceURI, SVG, "<path> must be SVG");
  const g = svg.childNodes[1];
  assertEquals(g.namespaceURI, SVG, "<g> must be SVG");
  assertEquals(g.childNodes[0].namespaceURI, SVG, "<circle> under <g> must be SVG");
  const fo = svg.childNodes[2];
  assertEquals(fo.namespaceURI, SVG, "<foreignObject> itself is SVG");
  const div = fo.childNodes[0];
  assert(div.namespaceURI === null, "HTML content inside <foreignObject> is not SVG");
  assert(div.childNodes[0].namespaceURI === null, "nested HTML stays HTML");
});

Deno.test("SVG camelCase presentation attrs are kebab-cased; structural ones kept", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(
    h("svg", {
      viewBox: "0 0 24 24",
      strokeWidth: 2,
      strokeLinecap: "round",
      fill: "none",
      className: "icon",
    }),
  );
  flushSync();
  // deno-lint-ignore no-explicit-any
  const svg = (container as any).childNodes[0];
  assertEquals(svg.getAttribute("stroke-width"), "2", "strokeWidth → stroke-width");
  assertEquals(svg.getAttribute("stroke-linecap"), "round", "strokeLinecap → stroke-linecap");
  assertEquals(svg.getAttribute("viewBox"), "0 0 24 24", "viewBox stays camelCase");
  assertEquals(svg.getAttribute("fill"), "none");
  assertEquals(svg.getAttribute("class"), "icon", "className → class on SVG too");
  assert(svg.getAttribute("strokeWidth") === null, "camelCase form must not be set");
});

Deno.test("HTML camelCase-ish attrs are NOT kebab-cased (only SVG namespace converts)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(h("div", { tabIndex: 1 }));
  flushSync();
  // deno-lint-ignore no-explicit-any
  const div = (container as any).childNodes[0];
  // tabIndex on an HTML element is left as-is (not "tab-index").
  assert(div.getAttribute("tab-index") === null, "HTML attrs must not be kebab-cased");
});

Deno.test("a plain div tree stays HTML (no namespace)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(h("div", null, h("span", null, "x")));
  flushSync();
  // deno-lint-ignore no-explicit-any
  const div = (container as any).childNodes[0];
  assert(div.namespaceURI === null && div.childNodes[0].namespaceURI === null);
});
