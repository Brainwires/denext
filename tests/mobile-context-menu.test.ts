// denext/mobile showContextMenu: the web/desktop in-DOM popover (the primary supported path,
// which must render EVERY item), and the native `ContextMenu` plugin path inside a faked
// Capacitor shell. The web path is driven against the reconciler test DOM installed as
// `globalThis.document` (showContextMenu is an imperative function on the global document, so
// it is exercised directly rather than through `render()`). Every global a test installs is
// restored.

import { assert, assertEquals } from "@std/assert";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";
import { showContextMenu } from "../src/mobile/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

/** Install `values` on globalThis for the duration of `fn`, then restore the originals. */
async function withGlobals(
  values: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, { configurable: true, writable: true, value });
  }
  try {
    await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(g, key, desc);
      else delete g[key];
    }
  }
}

/** A native iOS shell whose `Plugins` are `plugins`. */
function shell(plugins: Record<string, unknown>) {
  return { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: plugins };
}

/** A recorder: `calls` collects `[method, arg]`; each method resolves `results[method]`. */
function recorder(methods: string[], results: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const plugin: Record<string, (arg?: unknown) => Promise<unknown>> = {};
  for (const m of methods) {
    plugin[m] = (arg?: unknown) => {
      calls.push([m, arg]);
      return Promise.resolve(results[m]);
    };
  }
  return { plugin, calls };
}

/** Let queued microtasks and timers run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Every element under `root`, depth-first. */
function walk(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (n: Any) => {
    if (n?.nodeType === 1) out.push(n as FakeElement);
    for (const c of n?.childNodes ?? []) visit(c);
  };
  visit(root);
  return out;
}

/** The rendered menu container, or undefined. */
function menuOf(doc: FakeDocument): FakeElement | undefined {
  return walk(doc.body).find((el) => el.getAttribute("role") === "menu");
}

/** Every `role="menuitem"` under the body. */
function menuItems(doc: FakeDocument): FakeElement[] {
  return walk(doc.body).filter((el) => el.getAttribute("role") === "menuitem");
}

/** The menu item whose text contains `label`. */
function itemByText(doc: FakeDocument, label: string): FakeElement | undefined {
  return menuItems(doc).find((el) => el.textContent.includes(label));
}

const SAMPLE = [
  { id: "open", label: "Open" },
  { id: "rename", label: "Rename" },
  // A would-be "native-only" destructive action: the web fallback must still render it.
  { id: "delete", label: "Delete", destructive: true },
] as const;

// ---- web fallback: rendering ----------------------------------------------

Deno.test("showContextMenu web: renders EVERY item as an accessible menu", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const p = showContextMenu(SAMPLE, { x: 12, y: 34, title: "Actions" });
    const menu = menuOf(doc)!;
    assert(menu, "a role=menu popover is mounted");
    assertEquals(menu.getAttribute("role"), "menu");
    // All three items render, including the destructive "native-only" Delete (#3848 fix).
    const items = menuItems(doc);
    assertEquals(items.map((el) => el.textContent), ["Open", "Rename", "Delete"]);
    assertEquals(itemByText(doc, "Delete")!.getAttribute("data-destructive"), "true");
    // Positioned where asked, and labelled by its title.
    assertEquals(menu.style.getPropertyValue("left"), "12px");
    assertEquals(menu.style.getPropertyValue("top"), "34px");
    assert(menu.getAttribute("aria-labelledby"));
    // Dismiss to settle the pending promise, and confirm cleanup.
    menu.dispatch("keydown", { key: "Escape" });
    assertEquals(await p, null);
    assertEquals(menuOf(doc), undefined, "menu removed on resolve");
  });
});

// ---- web fallback: selection ----------------------------------------------

Deno.test("showContextMenu web: clicking an item resolves its id", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const p = showContextMenu(SAMPLE, {});
    itemByText(doc, "Rename")!.dispatch("click");
    assertEquals(await p, "rename");
    assertEquals(menuOf(doc), undefined);
  });
});

Deno.test("showContextMenu web: keyboard Down + Enter selects, roving focus", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const p = showContextMenu(SAMPLE, {});
    const menu = menuOf(doc)!;
    const items = menuItems(doc);
    assertEquals(items[0].getAttribute("tabindex"), "0", "first item is active");
    assertEquals(items[1].getAttribute("tabindex"), "-1");
    menu.dispatch("keydown", { key: "ArrowDown" });
    assertEquals(items[0].getAttribute("tabindex"), "-1");
    assertEquals(items[1].getAttribute("tabindex"), "0", "roving focus moved");
    menu.dispatch("keydown", { key: "Enter" });
    assertEquals(await p, "rename");
  });
});

// ---- web fallback: dismissal -----------------------------------------------

Deno.test("showContextMenu web: Escape resolves null", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const p = showContextMenu(SAMPLE, {});
    menuOf(doc)!.dispatch("keydown", { key: "Escape" });
    assertEquals(await p, null);
  });
});

Deno.test("showContextMenu web: an outside pointer press resolves null", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const p = showContextMenu(SAMPLE, { anchor: { left: 5, bottom: 9 } as DOMRect });
    // Anchor drives placement when x/y are omitted.
    assertEquals(menuOf(doc)!.style.getPropertyValue("left"), "5px");
    assertEquals(menuOf(doc)!.style.getPropertyValue("top"), "9px");
    await tick(); // let the deferred outside-dismiss listeners attach
    const outside = doc.createElement("div");
    doc.body.appendChild(outside);
    doc.dispatch("pointerdown", { target: outside });
    assertEquals(await p, null);
    assertEquals(menuOf(doc), undefined);
  });
});

// ---- web fallback: disabled ------------------------------------------------

Deno.test("showContextMenu web: a disabled item renders but is not selectable", async () => {
  const { doc } = makeDom();
  const items = [
    { id: "copy", label: "Copy" },
    { id: "paste", label: "Paste", disabled: true },
  ];
  await withGlobals({ document: doc }, async () => {
    const p = showContextMenu(items, {});
    const paste = itemByText(doc, "Paste")!;
    assertEquals(paste.getAttribute("aria-disabled"), "true");
    paste.dispatch("click"); // no click handler on a disabled item: nothing happens
    await tick();
    assert(menuOf(doc), "still open after clicking a disabled item");
    itemByText(doc, "Copy")!.dispatch("click");
    assertEquals(await p, "copy");
  });
});

// ---- non-DOM / empty -------------------------------------------------------

Deno.test("showContextMenu: null in a non-DOM context, and for no items", async () => {
  await withGlobals({ document: undefined }, async () => {
    assertEquals(await showContextMenu(SAMPLE, { x: 1, y: 2 }), null);
  });
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    assertEquals(await showContextMenu([], {}), null);
    assertEquals(menuOf(doc), undefined, "nothing mounted");
  });
});

// ---- native ContextMenu plugin ---------------------------------------------

Deno.test("showContextMenu native: every item is handed to the plugin; selectedId resolves", async () => {
  const { plugin, calls } = recorder(["show"], { show: { selectedId: "delete" } });
  await withGlobals({ Capacitor: shell({ DenextContextMenu: plugin }) }, async () => {
    assertEquals(await showContextMenu(SAMPLE, { title: "Actions", x: 5, y: 6 }), "delete");
  });
  assertEquals(calls[0][0], "show");
  const arg = calls[0][1] as {
    items: Array<{ id: string; destructive?: boolean }>;
    title?: string;
    x?: number;
    y?: number;
  };
  assertEquals(arg.items.map((i) => i.id), ["open", "rename", "delete"]);
  assertEquals(arg.items[2].destructive, true, "the native-only action is not dropped");
  assertEquals([arg.title, arg.x, arg.y], ["Actions", 5, 6]);
});

Deno.test("showContextMenu native: a dismissed menu resolves null", async () => {
  for (const result of [{ selectedId: null }, null]) {
    const { plugin } = recorder(["show"], { show: result });
    await withGlobals({ Capacitor: shell({ DenextContextMenu: plugin }) }, async () => {
      assertEquals(await showContextMenu(SAMPLE, {}), null);
    });
  }
});
