// Coverage for the component-testing harness itself: src/testing/render.ts (the
// Testing-Library-style `render`, queries, `fireEvent`, `userEvent`, `waitFor`)
// and src/testing/dom.ts (the tiny in-memory DOM it mounts into).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { useState } from "denext";
import { h } from "denext/jsx-runtime";
import { fireEvent, render, userEvent, waitFor } from "denext/testing";
import { DomDocument, DomEl, DomText, fireEventOn, walkElements } from "../src/testing/dom.ts";

// ---- render.ts: queries + miss/ambiguity error branches --------------------

Deno.test("getByRole filters by accessible name and errors on 0 / >1 matches", async () => {
  const screen = await render(
    h(
      "div",
      null,
      h("button", { type: "button" }, "Save"),
      h("button", { type: "button" }, "Cancel"),
    ),
  );
  try {
    // name filter narrows to exactly one of the two buttons.
    assertEquals(screen.getByRole("button", { name: "Save" }).textContent, "Save");
    // 0 matches -> "Unable to find".
    assertThrows(
      () => screen.getByRole("button", { name: "Nope" }),
      Error,
      "Unable to find",
    );
    // >1 match (no name filter) -> "Found 2 elements (expected 1)".
    assertThrows(() => screen.getByRole("button"), Error, "expected 1");
    // getAllByRole returns both.
    assertEquals(screen.getAllByRole("button").length, 2);
    // queryByRole returns the first (non-throwing) and null on a miss.
    assertEquals(screen.queryByRole("button")?.textContent, "Save");
    assertEquals(screen.queryByRole("dialog"), null);
  } finally {
    await screen.unmount();
  }
});

Deno.test("getByText: exact vs substring, all/query, and miss error", async () => {
  const screen = await render(
    h(
      "div",
      null,
      h("p", null, "hello world"),
      h("p", null, "hello there"),
    ),
  );
  try {
    // Exact (default) matches nothing that only contains the substring.
    assertEquals(screen.queryByText("hello"), null);
    // exact:false does substring matching -> both paragraphs match.
    assertEquals(screen.getAllByText("hello", { exact: false }).length, 2);
    // Regex match.
    assertEquals(screen.getByText(/world$/).textContent, "hello world");
    // getByText miss throws.
    assertThrows(() => screen.getByText("absent"), Error, "Unable to find");
    // Ambiguous getByText throws expected-1.
    assertThrows(() => screen.getByText("hello", { exact: false }), Error, "expected 1");
  } finally {
    await screen.unmount();
  }
});

Deno.test("getByLabelText resolves via for= and via nesting; miss + query branches", async () => {
  const screen = await render(
    h(
      "form",
      null,
      h("label", { for: "email" }, "Email"),
      h("input", { id: "email", value: "a@b.c" }),
      h("label", null, "Password", h("input", { id: "pw" })),
    ),
  );
  try {
    // for= association.
    assertEquals(screen.getByLabelText("Email").getAttribute("id"), "email");
    // nested-control association (label with no for=).
    assertEquals(screen.getByLabelText("Password").getAttribute("id"), "pw");
    // miss -> throws "for label"; query -> null.
    assertThrows(() => screen.getByLabelText("Nope"), Error, "for label");
    assertEquals(screen.queryByLabelText("Nope"), null);
  } finally {
    await screen.unmount();
  }
});

Deno.test("getByTestId + getByPlaceholderText: hits, misses, query branches", async () => {
  const screen = await render(
    h(
      "div",
      null,
      h("span", { "data-testid": "tag" }, "x"),
      h("input", { placeholder: "Search…" }),
    ),
  );
  try {
    assertEquals(screen.getByTestId("tag").textContent, "x");
    assertEquals(screen.queryByTestId("tag")?.tagName, "SPAN");
    assertEquals(screen.queryByTestId("missing"), null);
    assertThrows(() => screen.getByTestId("missing"), Error, 'data-testid "missing"');
    assertEquals(screen.getByPlaceholderText("Search…").tagName, "INPUT");
    assertEquals(screen.getByPlaceholderText(/Search/).tagName, "INPUT");
    assertThrows(() => screen.getByPlaceholderText("other"), Error, "with placeholder");
  } finally {
    await screen.unmount();
  }
});

Deno.test("roleOf covers the implicit-role mapping across many elements", async () => {
  const screen = await render(
    h(
      "div",
      null,
      h("input", { type: "checkbox", "aria-label": "c" }),
      h("input", { type: "radio", "aria-label": "r" }),
      h("input", { type: "range", "aria-label": "sl" }),
      h("input", { type: "number", "aria-label": "sp" }),
      h("input", { type: "submit", value: "Go" }),
      h("a", { href: "/x" }, "link"),
      h("a", null, "no-href"),
      h("img", { alt: "pic" }),
      h("progress", null),
      h("hr", null),
      h("dialog", null, "d"),
      h("select", null, h("option", null, "o")),
      h("select", { multiple: "true" }, h("option", null, "o2")),
      h("nav", null, "n"),
      h("aside", null, "a"),
      h("section", null, "s"),
      h("figure", null, "f"),
      h("fieldset", null, "g"),
      h("div", { role: "alert" }, "explicit"),
    ),
  );
  try {
    assertEquals(screen.getByRole("checkbox").getAttribute("type"), "checkbox");
    assertEquals(screen.getByRole("radio").getAttribute("type"), "radio");
    assertEquals(screen.getByRole("slider").getAttribute("type"), "range");
    assertEquals(screen.getByRole("spinbutton").getAttribute("type"), "number");
    // input[type=submit] -> button (the only button-role element here).
    assertEquals(screen.getByRole("button").getAttribute("type"), "submit");
    assertEquals(screen.getByRole("link").textContent, "link");
    // an <a> without href has no role -> not found.
    assertEquals(screen.queryByRole("link", { name: "no-href" }), null);
    assertEquals(screen.getByRole("img").getAttribute("alt"), "pic");
    assertEquals(screen.getByRole("progressbar").tagName, "PROGRESS");
    assertEquals(screen.getByRole("separator").tagName, "HR");
    assertEquals(screen.getByRole("dialog").tagName, "DIALOG");
    assertEquals(screen.getByRole("combobox").tagName, "SELECT");
    assertEquals(screen.getByRole("listbox").tagName, "SELECT");
    assertEquals(screen.getByRole("navigation").tagName, "NAV");
    assertEquals(screen.getByRole("complementary").tagName, "ASIDE");
    assertEquals(screen.getByRole("region").tagName, "SECTION");
    assertEquals(screen.getByRole("figure").tagName, "FIGURE");
    assertEquals(screen.getByRole("group").tagName, "FIELDSET");
    assertEquals(screen.getByRole("alert").textContent, "explicit");
  } finally {
    await screen.unmount();
  }
});

// ---- render.ts: fireEvent wiring -------------------------------------------

Deno.test("fireEvent.change wires to onChange; fireEvent.click wires to onClick", async () => {
  function Widget() {
    const [v, setV] = useState("");
    const [clicks, setClicks] = useState(0);
    return h(
      "div",
      null,
      h("input", {
        "aria-label": "field",
        value: v,
        onChange: (e: { target: { value: string } }) => setV(e.target.value),
      }),
      h("button", { type: "button", onClick: () => setClicks(clicks + 1) }, `n=${clicks}`),
      h("p", { "data-testid": "echo" }, v),
    );
  }
  const screen = await render(h(Widget, null));
  try {
    await screen.fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ada" } });
    assertEquals(screen.getByTestId("echo").textContent, "Ada");
    assertEquals(screen.getByRole("textbox").value, "Ada");
    await screen.fireEvent.click(screen.getByRole("button"));
    assertEquals(screen.getByRole("button").textContent, "n=1");
  } finally {
    await screen.unmount();
  }
});

Deno.test("fireEvent callable form, submit, input, and keyDown all dispatch", async () => {
  const seen: string[] = [];
  function Form() {
    return h(
      "form",
      {
        onSubmit: (e: { preventDefault(): void }) => {
          e.preventDefault();
          seen.push("submit");
        },
      },
      h("input", {
        "aria-label": "f",
        onInput: () => seen.push("input"),
        onKeyDown: (e: { key: string }) => seen.push(`key:${e.key}`),
        onFocus: () => seen.push("focus"),
      }),
    );
  }
  const screen = await render(h(Form, null));
  try {
    const input = screen.getByRole("textbox");
    // The callable form dispatches an arbitrary event type.
    await fireEvent(input, "focus");
    await screen.fireEvent.input(input, { target: { value: "z" } });
    await screen.fireEvent.keyDown(input, { key: "Enter" });
    await screen.fireEvent.submit(screen.container.children[0]);
    assertEquals(seen, ["focus", "input", "key:Enter", "submit"]);
  } finally {
    await screen.unmount();
  }
});

// ---- render.ts: userEvent --------------------------------------------------

Deno.test("userEvent.setup/click/dblClick/type/clear/keyboard/selectOptions", async () => {
  const log: string[] = [];
  function App() {
    const [v, setV] = useState("");
    return h(
      "div",
      null,
      h("button", {
        type: "button",
        onClick: () => log.push("click"),
        onDoubleClick: () => log.push("dbl"),
      }, "b"),
      h("input", {
        "aria-label": "typed",
        value: v,
        onKeyDown: (e: { key: string }) => log.push(`down:${e.key}`),
        onChange: (e: { target: { value: string } }) => setV(e.target.value),
      }),
      h(
        "select",
        {
          "aria-label": "sel",
          onChange: (e: { target: { value: string } }) => log.push(`sel:${e.target.value}`),
        },
        h("option", { value: "a" }, "a"),
        h("option", { value: "b" }, "b"),
      ),
    );
  }
  const ue = userEvent.setup();
  assertEquals(ue, userEvent);
  const screen = await render(h(App, null));
  try {
    const btn = screen.getByRole("button");
    await ue.click(btn);
    await ue.dblClick(btn);
    assert(log.includes("click"));
    assert(log.includes("dbl"));

    const input = screen.getByRole("textbox");
    await ue.type(input, "hi");
    assertEquals(input.value, "hi");
    assert(log.includes("down:h") && log.includes("down:i"));
    await ue.type(input, "X", { skipClick: true });
    assertEquals(input.value, "hiX");
    await ue.clear(input);
    assertEquals(input.value, "");
    await ue.keyboard(input, "ab");
    assert(log.includes("down:a"));

    await ue.selectOptions(screen.getByRole("combobox"), ["b"]);
    assert(log.includes("sel:b"));
  } finally {
    await screen.unmount();
  }
});

// ---- render.ts: waitFor + result helpers -----------------------------------

Deno.test("waitFor resolves once the callback stops throwing", async () => {
  let tries = 0;
  const value = await waitFor(() => {
    tries++;
    if (tries < 3) throw new Error("not yet");
    return "done";
  }, { timeout: 500, interval: 5 });
  assertEquals(value, "done");
  assert(tries >= 3);
});

Deno.test("waitFor rejects with the last error after the timeout", async () => {
  await assertRejects(
    () =>
      waitFor(() => {
        throw new Error("still failing");
      }, { timeout: 30, interval: 5 }),
    Error,
    "still failing",
  );
  // A non-Error throw is wrapped into an Error on timeout.
  await assertRejects(
    () =>
      waitFor(() => {
        throw "stringy";
      }, { timeout: 30, interval: 5 }),
    Error,
    "stringy",
  );
});

Deno.test("RenderResult exposes container, html, act, and rerender", async () => {
  const Greeting = ({ name }: { name: string }) => h("p", null, `Hi ${name}`);
  const screen = await render(h(Greeting, { name: "Ada" }));
  try {
    assertEquals(screen.container.tagName, "DIV");
    assert(screen.html().includes("Hi Ada"));
    let ran = false;
    await screen.act(() => {
      ran = true;
    });
    assert(ran);
    await screen.rerender(h(Greeting, { name: "Bob" }));
    assert(screen.html().includes("Hi Bob"));
    assertEquals(screen.queryByText("Hi Ada"), null);
  } finally {
    await screen.unmount();
  }
});

// ---- dom.ts: the in-memory DOM primitives ----------------------------------

Deno.test("DomEl attributes: value/checked reflection and removal", () => {
  const el = new DomEl("input");
  assertEquals(el.getAttribute("missing"), null);
  assertEquals(el.hasAttribute("missing"), false);
  el.setAttribute("value", "hello");
  assertEquals(el.value, "hello");
  el.setAttribute("checked", "");
  assertEquals(el.checked, true);
  el.removeAttribute("checked");
  assertEquals(el.checked, false);
  assertEquals(el.hasAttribute("value"), true);
});

Deno.test("DomNode append/insertBefore/removeChild/remove tree mutations", () => {
  const parent = new DomEl("div");
  const a = new DomEl("a");
  const b = new DomEl("b");
  const c = new DomEl("c");
  parent.appendChild(a);
  parent.appendChild(c);
  // insertBefore existing ref b before c.
  parent.insertBefore(b, c);
  assertEquals(parent.children.map((e) => e.tagName), ["A", "B", "C"]);
  // insertBefore with null ref appends.
  const d = new DomEl("d");
  parent.insertBefore(d, null);
  assertEquals(parent.children.map((e) => e.tagName), ["A", "B", "C", "D"]);
  // insertBefore with a ref not in the parent falls back to append.
  const orphanRef = new DomEl("x");
  const e = new DomEl("e");
  parent.insertBefore(e, orphanRef);
  assertEquals(parent.children[parent.children.length - 1].tagName, "E");
  // appendChild re-parents (removes from old parent).
  const other = new DomEl("div");
  other.appendChild(a);
  assert(!parent.children.includes(a));
  assertEquals(a.parentNode, other);
  // removeChild of a non-child is a no-op.
  parent.removeChild(orphanRef);
  // remove() on a parentless node is safe.
  orphanRef.remove();
  // remove() detaches from the parent.
  b.remove();
  assert(!parent.children.includes(b));
});

Deno.test("DomEl serialization: innerHTML/outerHTML/textContent + HTML escaping", () => {
  const el = new DomEl("div");
  el.setAttribute("id", "root");
  el.appendChild(new DomText("a < b & c > d"));
  const child = new DomEl("span");
  child.appendChild(new DomText("kid"));
  el.appendChild(child);
  assert(el.innerHTML.includes("a &lt; b &amp; c &gt; d"));
  assert(el.innerHTML.includes("<span>kid</span>"));
  assert(el.outerHTML.startsWith('<div id="root">'));
  assertEquals(el.textContent, "a < b & c > dkid");
  // textContent setter replaces children with a single text node.
  el.textContent = "fresh";
  assertEquals(el.textContent, "fresh");
  assertEquals(el.children.length, 0);
  // textContent = "" leaves no child.
  el.textContent = "";
  assertEquals(el.childNodes.length, 0);
  // innerHTML setter stores raw markup and detaches existing children.
  el.appendChild(new DomText("gone"));
  el.innerHTML = "<b>raw</b>";
  assertEquals(el.innerHTML, "<b>raw</b>");
  // innerHTML = "" clears the raw override.
  el.innerHTML = "";
  assertEquals(el.innerHTML, "");
});

Deno.test("DomDocument createElement/createTextNode/register/getElementById", () => {
  const doc = new DomDocument();
  const el = doc.createElement("div");
  assertEquals(el.tagName, "DIV");
  assertEquals(el.ownerDocument, doc);
  const t = doc.createTextNode("hi");
  assert(t instanceof DomText);
  assertEquals(doc.getElementById("nope"), null);
  doc.register("k", el);
  assertEquals(doc.getElementById("k"), el);
});

Deno.test("fireEventOn drives capture-then-bubble, stopPropagation, preventDefault, init merge", () => {
  const root = new DomEl("div");
  const child = new DomEl("button");
  root.appendChild(child);
  const order: string[] = [];
  root.addEventListener("click", () => order.push("root-bubble"));
  root.addEventListener("click", () => order.push("root-capture"), true);
  child.addEventListener("click", (e) => {
    order.push(`child key=${e.key}`);
    e.preventDefault();
  });
  let ev: import("../src/testing/dom.ts").TestEvent | undefined;
  child.addEventListener("click", (e) => {
    ev = e;
  });
  fireEventOn(child, "click", { key: "Z" });
  // capture (root) runs before bubble handlers; child then root bubble.
  assertEquals(order, ["root-capture", "child key=Z", "root-bubble"]);
  assert(ev?.defaultPrevented);
  assertEquals(ev?.type, "click");

  // stopPropagation on the child prevents the root bubble handler.
  const order2: string[] = [];
  const r2 = new DomEl("div");
  const c2 = new DomEl("span");
  r2.appendChild(c2);
  r2.addEventListener("click", () => order2.push("root"));
  c2.addEventListener("click", (e) => {
    order2.push("child");
    e.stopPropagation();
  });
  fireEventOn(c2, "click");
  assertEquals(order2, ["child"]);

  // removeEventListener detaches.
  const el = new DomEl("i");
  let n = 0;
  const fn = () => n++;
  el.addEventListener("x", fn);
  el.removeEventListener("x", fn);
  fireEventOn(el, "x");
  assertEquals(n, 0);
});

Deno.test("walkElements does a depth-first traversal of element nodes only", () => {
  const root = new DomEl("ul");
  const li1 = new DomEl("li");
  const li2 = new DomEl("li");
  li1.appendChild(new DomText("skip-me"));
  const inner = new DomEl("span");
  li1.appendChild(inner);
  root.appendChild(li1);
  root.appendChild(li2);
  const tags = walkElements(root).map((e) => e.tagName);
  assertEquals(tags, ["UL", "LI", "SPAN", "LI"]);
});
