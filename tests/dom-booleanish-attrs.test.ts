// Booleanish attributes (React parity): a boolean value for `aria-*`, `data-*`, `draggable`,
// `spellCheck`, `contentEditable` (and the rest of React 19's booleanish-string props) is
// written as the string "true"/"false" — never dropped on `false` nor written as `""` on
// `true`, which is how every other attribute is treated. react-native-web relies on it:
// `<input spellCheck={false}>` must turn browser spellcheck OFF.
import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { applyProps } from "../src/client/dom-props.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { makeDom } from "./helpers/dom.ts";
// deno-lint-ignore no-explicit-any
type Any = any;
const noop = () => {};

function repro() {
  return h(
    "div",
    null,
    h("img", { draggable: false }),
    h("input", { spellCheck: false }),
    h("div", { contentEditable: false }),
    h("div", { "aria-hidden": false }),
    h("img", { draggable: true }),
    h("div", { "aria-expanded": true, "aria-checked": false }),
  );
}

// React 19.2.3's client output for `repro()` (a real browser lowercases HTML attribute names;
// the test DOM keeps the spelling it was given, so the comparison lowercases).
const REACT_CLIENT_HTML = '<div><img draggable="false"></img><input spellcheck="false"></input>' +
  '<div contenteditable="false"></div><div aria-hidden="false"></div>' +
  '<img draggable="true"></img><div aria-expanded="true" aria-checked="false"></div></div>';

Deno.test("client render writes booleanish booleans as strings (React 19 repro)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(repro());
  flushSync();
  assertEquals((container as Any).innerHTML.toLowerCase(), REACT_CLIENT_HTML);
});

Deno.test("SSR and the client agree on booleanish booleans", async () => {
  const html = await renderToString(repro());
  for (
    const attr of [
      'draggable="false"',
      'spellCheck="false"',
      'contentEditable="false"',
      'aria-hidden="false"',
      'draggable="true"',
      'aria-expanded="true"',
      'aria-checked="false"',
    ]
  ) assertEquals(html.includes(attr), true, `SSR emits ${attr}: ${html}`);
});

Deno.test("booleanish updates: true → false → undefined", () => {
  const { doc } = makeDom();
  const el = doc.createElement("div") as Any;
  applyProps(el, {}, {}, { "aria-expanded": true, draggable: true }, noop);
  assertEquals(el.getAttribute("aria-expanded"), "true");
  assertEquals(el.getAttribute("draggable"), "true");
  applyProps(
    el,
    {},
    { "aria-expanded": true, draggable: true },
    { "aria-expanded": false, draggable: false },
    noop,
  );
  assertEquals(el.getAttribute("aria-expanded"), "false");
  assertEquals(el.getAttribute("draggable"), "false");
  applyProps(
    el,
    {},
    { "aria-expanded": false, draggable: false },
    { "aria-expanded": undefined },
    noop,
  );
  assertEquals(el.getAttribute("aria-expanded"), null, "undefined removes the attribute");
  assertEquals(el.getAttribute("draggable"), null, "a dropped prop removes the attribute");
  applyProps(el, {}, {}, { spellCheck: null }, noop);
  assertEquals(el.getAttribute("spellCheck"), null, "null removes the attribute");
});

Deno.test("data-* booleans are stringified", () => {
  const { doc } = makeDom();
  const el = doc.createElement("div") as Any;
  applyProps(el, {}, {}, { "data-foo": false, "data-bar": true }, noop);
  assertEquals(el.getAttribute("data-foo"), "false");
  assertEquals(el.getAttribute("data-bar"), "true");
});

Deno.test("non-booleanish boolean attributes still toggle presence", () => {
  const { doc } = makeDom();
  const el = doc.createElement("button") as Any;
  applyProps(el, {}, {}, { hidden: true, disabled: true }, noop);
  assertEquals(el.getAttribute("hidden"), "");
  assertEquals(el.getAttribute("disabled"), "");
  applyProps(el, {}, { hidden: true, disabled: true }, { hidden: false, disabled: false }, noop);
  assertEquals(el.getAttribute("hidden"), null);
  assertEquals(el.getAttribute("disabled"), null);
});

Deno.test("SVG aria-* booleans are stringified (not kebab-cased away)", () => {
  const { doc } = makeDom();
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg") as Any;
  applyProps(svg, {}, {}, { "aria-hidden": true, focusable: false }, noop);
  assertEquals(svg.getAttribute("aria-hidden"), "true");
  assertEquals(svg.getAttribute("focusable"), "false");
  applyProps(svg, {}, { "aria-hidden": true }, { "aria-hidden": false }, noop);
  assertEquals(svg.getAttribute("aria-hidden"), "false");
});
