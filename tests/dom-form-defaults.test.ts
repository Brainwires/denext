// `defaultValue` / `defaultChecked` on a client-rendered (mounted, not hydrated) form field follow
// react-dom (ReactDOMInput / ReactDOMTextarea / ReactDOMSelect): an `<input>` seeds its `value` /
// `checked` ATTRIBUTE — what its `defaultValue` / `defaultChecked` properties reflect, which the
// field shows until edited — a `<textarea>` / `<select>` takes its default once, at mount, and
// none of them is ever an attribute of its own. Before, `<input defaultValue="x">` wrote a
// `defaultvalue` attribute and the field stayed empty.
import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { renderToStringSync } from "../src/jsx/render-to-string.ts";
import { makeDom } from "./helpers/dom.ts";
// deno-lint-ignore no-explicit-any
type Any = any;

function mount(vnode: Any) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(vnode);
  flushSync();
  const render = (next: Any) => {
    root.render(next);
    flushSync();
  };
  return { container: container as Any, render };
}

const attrNames = (el: Any) => [...el.attributes.keys()].map((n: string) => n.toLowerCase());

Deno.test("client <input defaultValue> sets the field's value, never a defaultvalue attribute", () => {
  const { container, render } = mount(h("input", { defaultValue: "hello" }));
  const input = container.firstChild;
  assertEquals(input.value, "hello");
  assertEquals(input.getAttribute("value"), "hello");
  assertEquals(attrNames(input).includes("defaultvalue"), false, attrNames(input).join());
  // An update re-seeds the default (react-dom's setDefaultValue), still no attribute of its own.
  render(h("input", { defaultValue: "next" }));
  assertEquals(input.getAttribute("value"), "next");
  assertEquals(attrNames(input).includes("defaultvalue"), false);
});

Deno.test("client defaultChecked checks a checkbox / radio, never a defaultchecked attribute", () => {
  const { container } = mount(
    h(
      "div",
      null,
      h("input", { type: "checkbox", defaultChecked: true }),
      h("input", { type: "radio", name: "r", defaultChecked: true }),
      h("input", { type: "checkbox", defaultChecked: false }),
    ),
  );
  const [box, radio, off] = container.firstChild.childNodes;
  assertEquals(box.getAttribute("checked"), "");
  assertEquals(radio.getAttribute("checked"), "");
  assertEquals(off.getAttribute("checked"), null);
  for (const el of [box, radio, off]) {
    assertEquals(attrNames(el).includes("defaultchecked"), false, attrNames(el).join());
  }
});

Deno.test("client <textarea defaultValue> fills it at mount and never re-applies on update", () => {
  const { container, render } = mount(h("textarea", { defaultValue: "draft" }));
  const area = container.firstChild;
  assertEquals(area.value, "draft");
  assertEquals(attrNames(area).includes("defaultvalue"), false, attrNames(area).join());
  area.value = "typed by the user";
  render(h("textarea", { defaultValue: "other" }));
  assertEquals(area.value, "typed by the user");
});

Deno.test("client <select defaultValue> selects the option at mount (single and multiple)", () => {
  const opts = () => [
    h("option", { value: "a" }, "A"),
    h("option", { value: "b" }, "B"),
    h("option", { value: "c" }, "C"),
  ];
  const single = mount(h("select", { defaultValue: "b" }, ...opts())).container.firstChild;
  assertEquals(single.childNodes.map((o: Any) => !!o.selected), [false, true, false]);
  assertEquals(attrNames(single).includes("defaultvalue"), false, attrNames(single).join());
  const multi =
    mount(h("select", { multiple: true, defaultValue: ["a", "c"] }, ...opts())).container
      .firstChild;
  assertEquals(multi.childNodes.map((o: Any) => !!o.selected), [true, false, true]);
  // A controlled `value` selects its option at mount too (react-dom's postMountWrapper).
  const controlled = mount(h("select", { value: "c", onChange() {} }, ...opts())).container
    .firstChild;
  assertEquals(controlled.childNodes.map((o: Any) => !!o.selected), [false, false, true]);
  // An update of defaultValue does not move the selection.
  const { container, render } = mount(h("select", { defaultValue: "a" }, ...opts()));
  render(h("select", { defaultValue: "c" }, ...opts()));
  assertEquals(container.firstChild.childNodes.map((o: Any) => !!o.selected), [true, false, false]);
});

Deno.test("SSR: a controlled value / checked wins over the default, as ReactDOMServer's pushInput", () => {
  assertEquals(
    renderToStringSync(h("input", { value: "v", defaultValue: "d", readOnly: true })),
    '<input value="v" readOnly="">',
  );
  assertEquals(
    renderToStringSync(h("input", { type: "radio", checked: false, defaultChecked: true })),
    '<input type="radio">',
  );
  assertEquals(
    renderToStringSync(h("input", { type: "checkbox", defaultChecked: true })),
    '<input type="checkbox" checked="">',
  );
});
