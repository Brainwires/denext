// denext/navigation's `<Sheet>` grabber focus ring: the sheet installs a rule that hides the
// ring for pointer focus and keeps it for keyboard focus (`:focus-visible`). Its own module so
// the navigation stylesheet (cached per module instance) is created against this test's document.

import "./helpers/activity-runtime.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Sheet, sheetCss } from "../src/navigation/sheet.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("Sheet: the grabber's focus ring shows for keyboard focus only", async () => {
  assertEquals(sheetCss(), "[data-dnx-sheet-grabber]:focus:not(:focus-visible){outline:none}");
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const g = globalThis as Any;
  const saved = Object.getOwnPropertyDescriptor(g, "document");
  Object.defineProperty(g, "document", { configurable: true, writable: true, value: doc });
  try {
    const root = createRoot(container as Any);
    root.render(h(Sheet, { open: true, portal: false, "aria-label": "S" }, "x"));
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      flushSync();
    }
    const css = (doc.head.childNodes as FakeElement[])
      .filter((n) => n.getAttribute?.("data-dnx-navigation") !== null)
      .map((n) => n.textContent).join("");
    assertStringIncludes(css, sheetCss(), "the sheet installs its stylesheet");
    root.unmount();
  } finally {
    if (saved) Object.defineProperty(g, "document", saved);
    else delete g.document;
  }
});
