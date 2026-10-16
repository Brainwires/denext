// denext/navigation's focus move (src/navigation/focus.ts): a push focuses the new screen's
// heading (its header title), a pop gives focus back to the element that had it when the screen
// was left, the first screen and focus outside the stack are left alone, `focusOnNavigation:
// false` turns it off, and the route announcer stays quiet when the focused heading already says
// the title.

import "./helpers/activity-runtime.ts";
import { assert, assertEquals } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { FakeElement, makeDom } from "./helpers/dom.ts";
import { StackView } from "../src/navigation/stack-view.ts";
import { focusScreen, mayMoveFocus } from "../src/navigation/focus.ts";
import type { StackViewEntry } from "../src/navigation/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Let effects and the announcer's timer run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 60));
    flushSync();
  }
}

/** A fresh global document whose `focus()` moves `activeElement`. */
function dom() {
  const { doc, container } = makeDom();
  (doc as Any).title = "";
  (doc as Any).activeElement = doc.body;
  setDocument(doc as Any);
  const g = globalThis as Any;
  const prev = g.document;
  g.document = doc;
  const focus = FakeElement.prototype.focus;
  FakeElement.prototype.focus = function (this: FakeElement) {
    (doc as Any).activeElement = this;
  };
  const region = () =>
    (doc.body.childNodes as Any[]).find((n) =>
      n.getAttribute?.("data-dnx-route-announcer") !== null
    );
  return {
    doc,
    container,
    region,
    restore: () => {
      g.document = prev;
      FakeElement.prototype.focus = focus;
    },
  };
}

const entry = (id: string, title?: string, button = false): StackViewEntry => ({
  id,
  element: (button ? h("button", { id: `${id}-button` }, "Open") : h("p", null, id)) as never,
  options: title ? { title, headerShown: true } : {},
});

/** The element with attribute `name` = `value` under `root`. */
function find(root: Any, name: string, value: string): Any {
  if (root.getAttribute?.(name) === value) return root;
  for (const c of root.childNodes ?? []) {
    const found = find(c, name, value);
    if (found) return found;
  }
  return null;
}

Deno.test("focus: a push focuses the new screen's heading; a pop restores the opener", async () => {
  const { container, doc, region, restore } = dom();
  try {
    const root = createRoot(container as Any);
    const show = (entries: StackViewEntry[], focusOnNavigation?: boolean) => {
      root.render(h(StackView, { entries, onPop: () => {}, platform: "ios", focusOnNavigation }));
      flushSync();
    };
    show([entry("home", "Home", true)]);
    await settle();
    assertEquals((doc as Any).activeElement, doc.body, "the first screen takes no focus");
    const opener = find(container, "id", "home-button");
    opener.focus();
    show([entry("home", "Home", true), entry("detail", "Order #12")]);
    await settle();
    const active = (doc as Any).activeElement;
    assertEquals(active.getAttribute("role"), "heading");
    assertEquals(active.textContent, "Order #12");
    assertEquals(active.getAttribute("tabindex"), "-1", "made focusable");
    assertEquals(region()?.textContent ?? "", "", "the focused heading already says it");
    show([entry("home", "Home", true)]);
    await settle();
    assertEquals((doc as Any).activeElement, opener, "back to the button that opened it");
    show([entry("home", "Home", true), entry("other", "Other")], false);
    await settle();
    assertEquals((doc as Any).activeElement, opener, "focusOnNavigation: false leaves it");
    assertEquals(region()?.textContent, "Other", "and the announcer speaks");
    root.unmount();
  } finally {
    restore();
  }
});

Deno.test("focus: focus outside the stack stays; a screen without a heading is focused itself", async () => {
  const { container, doc, restore } = dom();
  try {
    const outside = doc.createElement("input");
    doc.body.appendChild(outside);
    const root = createRoot(container as Any);
    const show = (entries: StackViewEntry[]) => {
      root.render(h(StackView, { entries, onPop: () => {}, platform: "ios" }));
      flushSync();
    };
    show([entry("home")]);
    await settle();
    outside.focus();
    show([entry("home"), entry("next")]);
    await settle();
    assertEquals((doc as Any).activeElement, outside, "not stolen from a field beside the stack");
    (doc as Any).activeElement = doc.body;
    show([entry("home"), entry("next"), entry("last")]);
    await settle();
    const active = (doc as Any).activeElement;
    assertEquals(active.getAttribute("data-dnx-screen"), "last", "the screen section itself");
    assertEquals(active.getAttribute("tabindex"), "-1");
    root.unmount();
  } finally {
    restore();
  }
});

Deno.test("focusScreen / mayMoveFocus: heading first, a kept restore target, outside focus", () => {
  const { doc, restore } = dom();
  try {
    const screen = doc.createElement("section");
    const header = doc.createElement("div");
    const h2 = doc.createElement("h2");
    h2.textContent = "Title";
    header.appendChild(h2);
    screen.appendChild(header);
    doc.body.appendChild(screen);
    assertEquals(focusScreen(screen as Any), h2);
    const button = doc.createElement("button");
    screen.appendChild(button);
    assertEquals(focusScreen(screen as Any, button as Any), button);
    assert(!button.hasAttribute("tabindex"), "a restored element is not changed");
    const gone = doc.createElement("button");
    assertEquals(focusScreen(screen as Any, gone as Any), h2, "a detached target is skipped");
    assert(mayMoveFocus(screen as Any));
    const elsewhere = doc.createElement("input");
    doc.body.appendChild(elsewhere);
    elsewhere.focus();
    assert(!mayMoveFocus(screen as Any));
  } finally {
    restore();
  }
});
