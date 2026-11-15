// denext/testing's in-memory DOM gives a `<select>` its `options`, `selectedOptions`,
// `selectedIndex` and a `value` that follows the selected option (and an `<option>` its
// `selected` and text-defaulted `value`), so a controlled or uncontrolled `<select>` mounts,
// updates and reports a change under `render()` as it does in a browser.

import { assertEquals } from "@std/assert";
import { useState } from "denext";
import { h } from "denext/jsx-runtime";
import { fireEvent, render, userEvent } from "denext/testing";
import { DomDocument, type DomEl } from "../src/testing/dom.ts";

const opt = (value: string, label = value.toUpperCase()) => h("option", { value }, label);

Deno.test("render(): a controlled <select> mounts (the card's repro)", async () => {
  const screen = await render(h("select", { value: "a" }, h("option", { value: "a" })));
  const select = screen.getByRole("combobox") as DomEl;
  assertEquals(select.value, "a");
  assertEquals(select.selectedIndex, 0);
});

Deno.test("render(): a controlled <select> selects its value and follows state", async () => {
  let seen = "";
  function Picker() {
    const [v, setV] = useState("b");
    return h(
      "select",
      {
        value: v,
        onChange: (e: { target: { value: string } }) => {
          seen = e.target.value;
          setV(e.target.value);
        },
      },
      opt("a"),
      opt("b"),
      opt("c"),
    );
  }
  const screen = await render(h(Picker, null));
  const select = screen.getByRole("combobox") as DomEl;
  assertEquals(select.value, "b");
  assertEquals(select.options.map((o) => o.selected), [false, true, false]);
  await fireEvent.change(select, { target: { value: "c" } });
  assertEquals(seen, "c");
  assertEquals(select.value, "c");
  assertEquals(select.selectedIndex, 2);
  await userEvent.selectOptions(select, "a");
  assertEquals([seen, select.value], ["a", "a"]);
});

Deno.test("render(): rerendering a controlled <select> with a new value moves the selection", async () => {
  const ui = (v: string) => h("select", { value: v }, opt("a"), opt("b"));
  const screen = await render(ui("a"));
  const select = screen.getByRole("combobox") as DomEl;
  await screen.rerender(ui("b"));
  assertEquals(select.value, "b");
  assertEquals(select.selectedOptions.map((o) => o.value), ["b"]);
});

Deno.test("render(): defaultValue, optgroups and a multiple <select>", async () => {
  const one = await render(
    h("select", { defaultValue: "y" }, h("optgroup", { label: "g" }, opt("x"), opt("y"))),
  );
  assertEquals((one.getByRole("combobox") as DomEl).value, "y");
  const many = await render(
    h("select", { multiple: true, value: ["a", "c"] }, opt("a"), opt("b"), opt("c")),
  );
  const list = many.getByRole("listbox") as DomEl;
  assertEquals(list.selectedOptions.map((o) => o.value), ["a", "c"]);
  assertEquals(list.value, "a");
});

Deno.test("test DOM: a <select> without a chosen option shows its first enabled one", () => {
  const doc = new DomDocument();
  const select = doc.createElement("select");
  const off = doc.createElement("option");
  off.setAttribute("disabled", "");
  const label = doc.createElement("option");
  label.appendChild(doc.createTextNode("  Two \n words "));
  select.appendChild(off);
  select.appendChild(label);
  assertEquals(label.value, "Two words");
  assertEquals(select.value, "Two words");
  select.value = "missing";
  assertEquals([select.value, select.selectedIndex], ["", -1]);
  select.selectedIndex = 0;
  assertEquals([off.selected, label.selected], [true, false]);
  label.selected = true;
  assertEquals([off.selected, select.selectedIndex], [false, 1]);
});
