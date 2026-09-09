// Inline styles are patched PER PROPERTY (diffed against the previous style object),
// never by rewriting the whole `style` attribute. This preserves inline properties set
// imperatively outside the render — the load-bearing case is floating-ui writing CSS
// vars like `--available-height` directly on a popup element; a wholesale rewrite each
// commit wiped them, resized the element, fired its ResizeObserver, and drove an
// infinite reposition loop (a Base UI dropdown flickering open-then-hidden).
import { assert, assertEquals } from "@std/assert";
import { applyProps, patchStyle } from "../src/client/dom-props.ts";
import { makeDom } from "./helpers/dom.ts";
// deno-lint-ignore no-explicit-any
type Any = any;
const noop = () => {};

Deno.test("applyProps preserves foreign inline props across a style update", () => {
  const { doc } = makeDom();
  const el = doc.createElement("div") as Any;
  // Initial render: denext sets a couple of style props.
  applyProps(el, {}, {}, { style: { position: "absolute", top: "10px" } }, noop);
  assertEquals(el.style.getPropertyValue("position"), "absolute");
  assertEquals(el.style.getPropertyValue("top"), "10px");

  // floating-ui writes a CSS var directly (outside denext).
  el.style.setProperty("--available-height", "320px");

  // Next render: the position object is a fresh reference with a new transform; denext
  // must patch only its own keys and leave --available-height intact.
  applyProps(
    el,
    {},
    { style: { position: "absolute", top: "10px" } },
    { style: { position: "absolute", top: "12px", transform: "translateY(4px)" } },
    noop,
  );
  assertEquals(el.style.getPropertyValue("top"), "12px", "changed key updated");
  assertEquals(el.style.getPropertyValue("transform"), "translateY(4px)", "new key added");
  assertEquals(
    el.style.getPropertyValue("--available-height"),
    "320px",
    "foreign inline var MUST survive the style update (else floating-ui loops)",
  );
});

Deno.test("dropping a style key removes only that property, not foreign ones", () => {
  const { doc } = makeDom();
  const el = doc.createElement("div") as Any;
  applyProps(el, {}, {}, { style: { top: "10px", left: "5px" } }, noop);
  el.style.setProperty("--anchor-width", "200px");
  // New style omits `left`.
  applyProps(el, {}, { style: { top: "10px", left: "5px" } }, { style: { top: "10px" } }, noop);
  assertEquals(el.style.getPropertyValue("left"), "", "dropped key removed");
  assertEquals(el.style.getPropertyValue("top"), "10px", "kept key stays");
  assertEquals(el.style.getPropertyValue("--anchor-width"), "200px", "foreign var stays");
});

Deno.test("removing the style prop entirely keeps foreign inline props", () => {
  const { doc } = makeDom();
  const el = doc.createElement("div") as Any;
  applyProps(el, {}, {}, { style: { top: "10px" } }, noop);
  el.style.setProperty("--x", "1px");
  applyProps(el, {}, { style: { top: "10px" } }, {}, noop); // style prop gone
  assertEquals(el.style.getPropertyValue("top"), "", "denext's key removed");
  assertEquals(el.style.getPropertyValue("--x"), "1px", "foreign var survives prop removal");
});

Deno.test("patchStyle hyphenates camelCase and passes custom props through", () => {
  const { doc } = makeDom();
  const el = doc.createElement("div") as Any;
  patchStyle(el, undefined, { maxHeight: "5px", "--my-var": "9px" });
  assertEquals(el.style.getPropertyValue("max-height"), "5px");
  assertEquals(el.style.getPropertyValue("--my-var"), "9px");
  assert(el.getAttribute("style")!.includes("max-height:5px"));
});

Deno.test("applyProps appends px to non-zero numeric style values (react-dom parity)", () => {
  // Regression: a client re-render passing raw numbers (e.g. LegendList's `top: <number>`
  // for absolutely-positioned virtualized rows) must become `top: 410px`, not the invalid
  // unitless `top: 410` the browser silently drops (which collapsed every row onto one line).
  const { doc } = makeDom();
  const el = doc.createElement("div") as Any;
  applyProps(el, {}, {}, {
    style: {
      position: "absolute",
      top: 410, // number → px
      width: 200, // number → px
      marginTop: 12, // number → px
      left: 0, // zero stays unitless
      opacity: 0.5, // unitless property → no px
      zIndex: 3, // unitless property → no px
      lineHeight: 1.5, // unitless property → no px
      "--gap": 8, // custom property → no px
    },
  }, noop);
  assertEquals(el.style.getPropertyValue("top"), "410px");
  assertEquals(el.style.getPropertyValue("width"), "200px");
  assertEquals(el.style.getPropertyValue("margin-top"), "12px");
  assertEquals(el.style.getPropertyValue("left"), "0", "zero is unitless");
  assertEquals(el.style.getPropertyValue("opacity"), "0.5", "opacity is unitless");
  assertEquals(el.style.getPropertyValue("z-index"), "3", "z-index is unitless");
  assertEquals(el.style.getPropertyValue("line-height"), "1.5", "line-height is unitless");
  assertEquals(el.style.getPropertyValue("--gap"), "8", "custom properties keep the raw value");

  // A numeric value updated on re-render is re-applied with px (the LegendList reposition).
  applyProps(
    el,
    {},
    { style: { position: "absolute", top: 410 } },
    { style: { position: "absolute", top: 42 } },
    noop,
  );
  assertEquals(el.style.getPropertyValue("top"), "42px", "updated numeric top re-applies with px");
});
