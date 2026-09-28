// denext/navigation's route announcer (src/navigation/announcer.ts): a push, a pop or a tab
// switch reads the new screen's title into one aria-live region; the first screen is not
// announced, `announceRouteChanges: false` turns it off, and the document title stands in for
// a missing `title`.

import "./helpers/activity-runtime.ts";
import { assertEquals } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";
import { StackView } from "../src/navigation/stack-view.ts";
import { TabsView } from "../src/navigation/tabs.ts";
import { announceRoute } from "../src/navigation/announcer.ts";
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

/** A fresh document installed as the global one. */
function dom() {
  const { doc, container } = makeDom();
  (doc as Any).title = "";
  setDocument(doc as Any);
  const g = globalThis as Any;
  const prev = g.document;
  g.document = doc;
  const region = () =>
    (doc.body.childNodes as Any[]).find((n) =>
      n.getAttribute?.("data-dnx-route-announcer") !== null
    );
  return { doc, container, region, restore: () => (g.document = prev) };
}

const entry = (id: string, title?: string): StackViewEntry => ({
  id,
  element: h("p", null, id) as never,
  options: title ? { title } : {},
});

Deno.test("announcer: a push and a pop announce the top screen; the first screen does not", async () => {
  const { container, region, doc, restore } = dom();
  try {
    const root = createRoot(container as Any);
    const show = (entries: StackViewEntry[]) => {
      root.render(h(StackView, { entries, onPop: () => {}, platform: "ios" }));
      flushSync();
    };
    show([entry("home", "Home")]);
    await settle();
    assertEquals(region(), undefined, "nothing on the first screen");
    show([entry("home", "Home"), entry("detail", "Order #12")]);
    await settle();
    assertEquals(region()?.textContent, "Order #12");
    assertEquals(region()?.getAttribute("aria-live"), "assertive");
    show([entry("home", "Home")]);
    await settle();
    assertEquals(region()?.textContent, "Home");
    (doc as Any).title = "Settings · App";
    show([entry("home", "Home"), entry("settings")]);
    await settle();
    assertEquals(region()?.textContent, "Settings · App", "the document title stands in");
    root.unmount();
  } finally {
    restore();
  }
});

Deno.test("announcer: a tab switch announces the tab; announceRouteChanges: false is silent", async () => {
  const { container, region, restore } = dom();
  try {
    const root = createRoot(container as Any);
    const tabs = [
      { name: "home", href: "/", title: "Home" },
      { name: "inbox", href: "/inbox", title: "Inbox" },
    ];
    const show = (active: string, announce = true) => {
      root.render(h(TabsView, {
        tabs,
        active,
        panels: new Map([["home", "h"], ["inbox", "i"]]),
        onTabPress: () => {},
        platform: "ios",
        announceRouteChanges: announce,
      }));
      flushSync();
    };
    show("home");
    await settle();
    show("inbox");
    await settle();
    assertEquals(region()?.textContent, "Inbox");
    show("home", false);
    await settle();
    assertEquals(region()?.textContent, "Inbox", "not announced");
    root.unmount();
  } finally {
    restore();
  }
});

Deno.test("announcer: announceRoute re-announces the same text, ignores empty, needs a document", async () => {
  const { region, restore } = dom();
  try {
    announceRoute("Saved");
    assertEquals(region()?.textContent, "Saved");
    announceRoute("Saved");
    assertEquals(region()?.textContent, "", "cleared, then set again");
    await settle();
    assertEquals(region()?.textContent, "Saved");
    announceRoute("   ");
    assertEquals(region()?.textContent, "Saved");
  } finally {
    restore();
  }
  const g = globalThis as Any;
  const prev = g.document;
  g.document = undefined;
  announceRoute("no document");
  g.document = prev;
});
