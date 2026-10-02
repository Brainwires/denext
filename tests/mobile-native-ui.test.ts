// denext/mobile's native-feel UI (R3-F): showContextMenu's submenus / SF Symbol names /
// subtitles / haptic on the native plugin and the web popover; useContextMenu /
// attachContextMenu on each path (the iOS shell arming the native UIContextMenuInteraction and
// routing `menuAction` events; Android's long press through the native PopupMenu with its
// haptic; the web's long press and right click through the popover); and <SystemIcon> (the
// Material Symbol on the server and the web, the natively rendered SF Symbol in a faked iOS
// shell, its cache and its fallback). Every global a test installs is restored.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";
import { fakePlugin, inShell, mount, settle, withGlobals } from "./helpers/mobile-fakes.ts";
import { nativeMenuItems, showContextMenu } from "../src/mobile/context-menu.ts";
import { attachContextMenu, useContextMenu } from "../src/mobile/context-menu-target.ts";
import {
  hexColor,
  materialNameFor,
  preloadSystemIcons,
  registerSystemIcons,
  SystemIcon,
} from "../src/mobile/system-icon.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

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

const byRole = (doc: FakeDocument, role: string) =>
  walk(doc.body).filter((el) => el.getAttribute("role") === role);

const MENU = [
  { id: "reply", label: "Reply", systemIcon: "arrowshape.turn.up.left" },
  {
    id: "move",
    label: "Move to",
    children: [
      { id: "inbox", label: "Inbox" },
      { id: "archive", label: "Archive", subtitle: "Keep it" },
    ],
  },
  { id: "delete", label: "Delete", destructive: true, systemIcon: "trash" },
];

/** A pointer/mouse event as the bound element receives it. */
function pointer(extra: Record<string, unknown>) {
  let prevented = false;
  let stopped = false;
  return {
    clientX: 40,
    clientY: 50,
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    preventDefault: () => void (prevented = true),
    stopPropagation: () => void (stopped = true),
    get prevented() {
      return prevented;
    },
    get stopped() {
      return stopped;
    },
    ...extra,
  };
}

/** A bindable fake element: listeners by type, a rect, and an inline style. */
function target(rect = { left: 10, top: 20, width: 200, height: 44 }) {
  const { doc } = makeDom();
  const el = doc.createElement("div") as Any;
  el.getBoundingClientRect = () => rect;
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  el.addEventListener = (type: string, fn: (e: unknown) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  };
  el.removeEventListener = (type: string, fn: (e: unknown) => void) =>
    listeners.get(type)?.delete(fn);
  const fire = (type: string, event: unknown) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
  };
  const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { el, fire, count };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- showContextMenu -------------------------------------------------------------------------

Deno.test("nativeMenuItems keeps only set fields and nests submenus", () => {
  assertEquals(nativeMenuItems(MENU), [
    { id: "reply", label: "Reply", systemIcon: "arrowshape.turn.up.left" },
    {
      id: "move",
      label: "Move to",
      children: [
        { id: "inbox", label: "Inbox" },
        { id: "archive", label: "Archive", subtitle: "Keep it" },
      ],
    },
    { id: "delete", label: "Delete", destructive: true, systemIcon: "trash" },
  ]);
});

Deno.test("showContextMenu native: submenus, SF Symbols, subtitles and the haptic reach the plugin", async () => {
  const menu = fakePlugin(["show"], { show: { selectedId: "archive" } });
  await inShell("ios", { DenextContextMenu: menu.plugin }, async () => {
    const id = await showContextMenu(MENU, { x: 5, y: 6, title: "Message", haptic: true });
    assertEquals(id, "archive");
  });
  const arg = menu.calls[0][1] as Any;
  assertEquals(arg.x, 5);
  assertEquals(arg.y, 6);
  assertEquals(arg.haptic, true);
  assertEquals(arg.title, "Message");
  assertEquals(arg.items[1].children[1], { id: "archive", label: "Archive", subtitle: "Keep it" });
  assertEquals(arg.items[2].systemIcon, "trash");
});

Deno.test("showContextMenu native: an anchor places the menu; an empty menu never calls it", async () => {
  const menu = fakePlugin(["show"], { show: { selectedId: null } });
  await inShell("android", { DenextContextMenu: menu.plugin }, async () => {
    const anchor = { left: 7, bottom: 9 } as DOMRect;
    assertEquals(await showContextMenu([{ id: "a", label: "A" }], { anchor }), null);
    assertEquals(await showContextMenu([], {}), null);
  });
  assertEquals(menu.calls.length, 1);
  assertEquals((menu.calls[0][1] as Any).x, 7);
  assertEquals((menu.calls[0][1] as Any).y, 9);
});

Deno.test("showContextMenu web: a submenu is a labelled group and every leaf renders", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const p = showContextMenu([
      ...MENU,
      { id: "more", label: "More", disabled: true, children: [{ id: "x", label: "Hidden?" }] },
    ]);
    const groups = byRole(doc, "group");
    assertEquals(groups.length, 2);
    const labelId = groups[0].getAttribute("aria-labelledby")!;
    const label = walk(groups[0]).find((el) => el.getAttribute("id") === labelId)!;
    assertEquals(label.textContent, "Move to");
    const items = byRole(doc, "menuitem");
    assertEquals(items.map((el) => el.textContent), [
      "Reply",
      "Inbox",
      "ArchiveKeep it",
      "Delete",
      "Hidden?",
    ]);
    assertEquals(
      items[4].getAttribute("aria-disabled"),
      "true",
      "a disabled submenu disables its items",
    );
    items[2].dispatch("click");
    assertEquals(await p, "archive");
  });
});

Deno.test("showContextMenu web in the shell: haptic plays the native impact; on the web it does not", async () => {
  const haptics = fakePlugin([
    "impact",
    "notification",
    "selectionStart",
    "selectionChanged",
    "selectionEnd",
  ]);
  const { doc } = makeDom();
  await inShell("android", { Haptics: haptics.plugin }, async () => {
    const p = showContextMenu([{ id: "a", label: "A" }], { haptic: true });
    byRole(doc, "menuitem")[0].dispatch("click");
    assertEquals(await p, "a");
  }, { document: doc });
  assertEquals(haptics.calls, [["impact", { style: "MEDIUM" }]]);
  let vibrated = 0;
  const { doc: web } = makeDom();
  await withGlobals({ document: web, navigator: { vibrate: () => void vibrated++ } }, async () => {
    const p = showContextMenu([{ id: "a", label: "A" }], { haptic: true });
    byRole(web, "menuitem")[0].dispatch("click");
    await p;
  });
  assertEquals(vibrated, 0, "the web never vibrates for a menu");
});

// ---- attachContextMenu: the iOS native interaction ------------------------------------------

Deno.test("attachContextMenu iOS: a press arms the native menu; menuAction routes by token", async () => {
  const menu = fakePlugin(["show", "arm", "disarm"]);
  const { el, fire, count } = target();
  const chosen: string[] = [];
  await inShell("ios", { DenextContextMenu: menu.plugin }, async () => {
    const off = attachContextMenu(el, () => MENU, (id) => chosen.push(id), { title: "Row" });
    assertEquals(el.style.getPropertyValue("-webkit-touch-callout"), "none");
    fire("pointerdown", pointer({}));
    await settle();
    const [method, arg] = menu.calls[0] as [string, Any];
    assertEquals(method, "arm");
    assertEquals(arg.rect, { x: 10, y: 20, width: 200, height: 44 });
    assertEquals(arg.title, "Row");
    assertEquals(arg.items[1].children.length, 2);
    assertEquals(arg.cornerRadius, 12);
    const context = pointer({ pointerType: "mouse" });
    fire("contextmenu", context);
    assert(context.prevented, "WebKit's own menu is suppressed");
    fire("pointercancel", pointer({}));
    await settle();
    assertEquals(menu.calls.at(-1), ["disarm", { token: arg.token }], "a scroll disarms");
    menu.fire("menuAction", { token: arg.token, id: "delete" });
    menu.fire("menuAction", { token: "someone-else", id: "reply" });
    assertEquals(chosen, ["delete"]);
    assertEquals(menu.listening(), 1);
    off();
    await settle();
    assertEquals(menu.calls.at(-1), ["disarm", { token: arg.token }]);
    assertEquals(menu.listening(), 0, "the shared listener goes with the last binding");
    assertEquals(count(), 0);
    assertEquals(el.style.getPropertyValue("-webkit-touch-callout"), "");
  }, { getComputedStyle: () => ({ borderTopLeftRadius: "12px" }) });
});

Deno.test("attachContextMenu iOS: disabled or empty menus do not arm", async () => {
  const menu = fakePlugin(["show", "arm", "disarm"]);
  const { el, fire } = target();
  await inShell("ios", { DenextContextMenu: menu.plugin }, async () => {
    const off = attachContextMenu(el, [], () => {});
    fire("pointerdown", pointer({}));
    off();
    const off2 = attachContextMenu(el, MENU, () => {}, { disabled: true });
    fire("pointerdown", pointer({}));
    off2();
    await settle();
  });
  assertEquals(menu.calls.map((c) => c[0]), ["disarm", "disarm"]);
});

// ---- attachContextMenu: the JS long press ---------------------------------------------------

Deno.test("attachContextMenu Android: a long press opens the native PopupMenu with the haptic", async () => {
  const menu = fakePlugin(["show"], { show: { selectedId: "reply" } });
  const { el, fire } = target();
  const chosen: string[] = [];
  await inShell("android", { DenextContextMenu: menu.plugin }, async () => {
    const off = attachContextMenu(el, MENU, (id) => chosen.push(id), { longPressMs: 5 });
    fire("pointerdown", pointer({ clientX: 30, clientY: 31 }));
    await wait(20);
    await settle();
    assertEquals(chosen, ["reply"]);
    const arg = menu.calls[0][1] as Any;
    assertEquals([arg.x, arg.y, arg.haptic], [30, 31, true]);
    // Android's WebView also sends contextmenu for the same long press: not a second menu.
    const late = pointer({});
    fire("contextmenu", late);
    assert(late.prevented);
    // The click ending the press does not activate the row.
    const click = pointer({});
    fire("click", click);
    assert(click.prevented && click.stopped);
    off();
  });
  assertEquals(menu.calls.length, 1);
});

Deno.test("attachContextMenu web: moving cancels the long press; a right click opens without haptic", async () => {
  const { doc } = makeDom();
  const { el, fire } = target();
  const chosen: string[] = [];
  await withGlobals({ document: doc }, async () => {
    const off = attachContextMenu(el, MENU, (id) => chosen.push(id), { longPressMs: 5 });
    fire("pointerdown", pointer({}));
    fire("pointermove", pointer({ clientX: 80 }));
    await wait(20);
    assertEquals(byRole(doc, "menu").length, 0, "a drag is not a long press");
    fire("pointerdown", pointer({ pointerType: "mouse", button: 2 }));
    const right = pointer({ pointerType: "mouse" });
    fire("contextmenu", right);
    assert(right.prevented);
    const items = byRole(doc, "menuitem");
    assertEquals(items.length, 5 - 1, "every leaf: Reply, Inbox, Archive, Delete");
    items[3].dispatch("click");
    await settle();
    // A plain click afterwards (a new press) is not swallowed.
    fire("pointerdown", pointer({ pointerType: "mouse" }));
    const click = pointer({});
    fire("click", click);
    assert(!click.prevented);
    off();
  });
  assertEquals(chosen, ["delete"]);
});

Deno.test("useContextMenu binds through a ref and reads the latest items and handler", async () => {
  const { doc } = makeDom();
  const chosen: string[] = [];
  let label = "First";
  let handler = (id: string) => chosen.push(`old:${id}`);
  await withGlobals({ document: doc }, async () => {
    function Row(props: { label: string; onSelect: (id: string) => void }) {
      const ref = useContextMenu([{ id: "go", label: props.label }], props.onSelect);
      return h("div", { ref, "data-row": "" }, "row");
    }
    const view = mount(() => h(Row, { label, onSelect: handler }));
    label = "Second";
    handler = (id: string) => chosen.push(`new:${id}`);
    view.rerender();
    const row = walk(view.container).find((el) => el.hasAttribute("data-row"))!;
    row.dispatch("contextmenu", { clientX: 1, clientY: 2 });
    const item = byRole(doc, "menuitem")[0];
    assertEquals(item.textContent, "Second");
    item.dispatch("click");
    await settle();
    view.root.unmount();
    flushSync();
  });
  assertEquals(chosen, ["new:go"]);
});

// ---- SystemIcon ----------------------------------------------------------------------------

Deno.test("materialNameFor maps SF Symbol names, .fill and unknown suffixes", () => {
  assertEquals(materialNameFor("square.and.arrow.up"), "share");
  assertEquals(materialNameFor("house.fill"), "home-fill");
  assertEquals(materialNameFor("heart.circle.fill"), "favorite-fill");
  assertEquals(materialNameFor("trash.fill"), "delete", "no -fill variant: the outlined one");
  assertEquals(materialNameFor("star"), "star");
  assertEquals(materialNameFor("sparkles.rectangle.stack"), undefined);
  registerSystemIcons({ sparkles: "M0 0Z" });
  assertEquals(materialNameFor("sparkles.rectangle.stack"), "sparkles");
});

Deno.test("hexColor reads hex and rgb()/rgba() colors", () => {
  assertEquals(hexColor("#ABC"), "#aabbcc");
  assertEquals(hexColor("rgb(255, 0, 10)"), "#ff000a");
  assertEquals(hexColor("rgba(0, 0, 0, 0.5)"), "#00000080");
  assertEquals(hexColor("rgb(1 2 3 / 100%)"), "#010203");
  assertEquals(hexColor("red"), undefined);
});

Deno.test("SystemIcon on the server draws the Material Symbol, decorative or labelled", async () => {
  const html = await renderToString(h(SystemIcon, { name: "square.and.arrow.up", size: 20 }));
  assertStringIncludes(html, 'data-dnx-system-icon="square.and.arrow.up"');
  assertStringIncludes(html, 'data-dnx-icon-source="material"');
  assertStringIncludes(html, 'viewBox="0 -960 960 960"');
  assertStringIncludes(html, 'aria-hidden="true"');
  assertStringIncludes(html, "width:20px");
  const labelled = await renderToString(
    h(SystemIcon, { name: "gearshape", android: "settings-fill", label: "Settings" }),
  );
  assertStringIncludes(labelled, 'role="img"');
  assertStringIncludes(labelled, 'aria-label="Settings"');
  const unknown = await renderToString(h(SystemIcon, { name: "no.such.symbol" }));
  assert(!unknown.includes("<svg"), "an unknown name draws an empty box");
});

Deno.test("SystemIcon in the iOS shell: the native SF Symbol as a currentColor mask, cached", async () => {
  const png = "data:image/png;base64,AAAA";
  const icons = fakePlugin(["render"], { render: { dataUrl: png, width: 20, height: 18 } });
  await inShell("ios", { DenextSystemIcon: icons.plugin }, async () => {
    const view = mount(() =>
      h("div", null, [
        h(SystemIcon, { key: "a", name: "star.fill", size: 30, weight: "semibold" }),
        h(SystemIcon, { key: "b", name: "star.fill", size: 30, weight: "semibold" }),
      ])
    );
    const spans = () =>
      walk(view.container).filter((el) => el.hasAttribute("data-dnx-system-icon"));
    assertEquals(
      spans()[0].style.getPropertyValue("visibility"),
      "hidden",
      "hidden for the round trip",
    );
    await settle();
    flushSync();
    for (const span of spans()) {
      assertEquals(span.getAttribute("data-dnx-icon-source"), "sf");
      assertStringIncludes(span.style.cssText, png);
      assertStringIncludes(span.style.cssText, "currentColor");
      assertEquals(span.childNodes.length, 0, "no Material fallback once drawn");
    }
    assertEquals(icons.calls.length, 1, "one native render for the same request");
    const arg = icons.calls[0][1] as Any;
    assertEquals([arg.name, arg.pointSize, arg.weight, arg.mode, arg.pixelScale], [
      "star.fill",
      24,
      "semibold",
      "monochrome",
      3,
    ]);
    view.root.unmount();
  }, { devicePixelRatio: 3 });
});

Deno.test("SystemIcon in the iOS shell: an unknown symbol falls back to the Material one", async () => {
  const icons = fakePlugin(["render"], { render: new Error("not_found") });
  await inShell("ios", { DenextSystemIcon: icons.plugin }, async () => {
    const view = mount(() => h(SystemIcon, { name: "house.fill", android: "home" }));
    await settle();
    flushSync();
    const span = walk(view.container).find((el) => el.hasAttribute("data-dnx-system-icon"))!;
    assertEquals(span.getAttribute("data-dnx-icon-source"), "material");
    assertEquals(span.style.getPropertyValue("visibility"), "");
    assert(walk(span).some((el) => el.tagName === "SVG"));
    view.root.unmount();
  });
});

Deno.test("SystemIcon hierarchical mode sends the resolved color; Android never asks natively", async () => {
  const icons = fakePlugin(["render"], {
    render: { dataUrl: "data:image/png;base64,B", width: 1, height: 1 },
  });
  await inShell("ios", { DenextSystemIcon: icons.plugin }, async () => {
    const view = mount(() =>
      h(SystemIcon, { name: "cloud.sun", mode: "hierarchical", color: "rgb(0, 122, 255)" })
    );
    await settle();
    flushSync();
    assertEquals((icons.calls[0][1] as Any).colors, ["#007aff"]);
    const span = walk(view.container).find((el) => el.hasAttribute("data-dnx-system-icon"))!;
    assertStringIncludes(span.style.cssText, "background-image");
    view.root.unmount();
    await preloadSystemIcons(["bell", { name: "bell", size: 24 }]);
    assertEquals(icons.calls.length, 2, "preload renders once per distinct request");
  });
  const android = fakePlugin(["render"]);
  await inShell("android", { DenextSystemIcon: android.plugin }, async () => {
    const view = mount(() => h(SystemIcon, { name: "bell" }));
    await settle();
    await preloadSystemIcons(["bell"]);
    view.root.unmount();
  });
  assertEquals(android.calls.length, 0);
});
