// The app's own top-level menus and each window's own Window-menu items (src/desktop/app-menus.ts,
// composed by src/desktop/menu-bar.ts and applied by src/desktop/caps/app.ts): the config checks,
// where the custom menus go beside the managed menus and a page's `setAppMenu`, per-window state
// (each window's bar built with its state, the macOS app-level menu with the app-wide state),
// checkbox and radio items, the Window-menu items' lifecycle, and click routing with the key window
// to the pages, `runDesktop({ onAppMenuItem })` and an extension's `host.onAppMenuItem` — against
// fake runtime windows and a fake `Deno.desktop`.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { DesktopCapCtx, DesktopExtensionHost } from "../src/desktop/extension.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";
import type { DesktopAppApi, DesktopMenuItem } from "../src/desktop/launch-events.ts";
import type { RegistryWindow } from "../src/desktop/window-registry.ts";
import { setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import { FIRST_APP_MENU_EVENT_RUNTIME } from "../src/build/deno-version.ts";
import {
  desktopMenuProblem,
  type DesktopMenuSettings,
  type DesktopMenuSpec,
  resolveDesktopMenuSettings,
} from "../src/desktop/menu-config.ts";
import type { DesktopAppMenuItemContext } from "../src/desktop/app-menus.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

/** A runtime window that records its application menus. */
class FakeWin extends EventTarget implements RegistryWindow {
  static made: FakeWin[] = [];
  menus: DesktopMenuItem[][] = [];
  constructor(readonly options?: Record<string, unknown>) {
    super();
    FakeWin.made.push(this);
  }
  bind() {}
  navigate() {}
  show() {}
  hide() {}
  focus() {
    this.dispatchEvent(new Event("focus"));
  }
  close() {}
  isVisible() {
    return true;
  }
  getBounds() {
    return { x: 0, y: 0, width: 800, height: 600 };
  }
  setBounds() {}
  setApplicationMenu(menu: DesktopMenuItem[]) {
    this.menus.push(menu);
  }
  /** The user closed it. */
  userClose() {
    this.dispatchEvent(new Event("close", { cancelable: true }));
  }
}

/** The last runtime before `Deno.desktop`'s app-level "menuclick": clicks come from the window. */
const WINDOW_CLICK_RUNTIME = "3.0.0-denext.13";

const FORMAT: DesktopMenuSpec = {
  id: "format",
  label: "Format",
  items: [
    { id: "bold", label: "Bold", type: "checkbox", accelerator: "CommandOrControl+B" },
    { type: "separator" },
    { id: "left", label: "Left", type: "radio", group: "align", checked: true },
    { id: "center", label: "Center", type: "radio", group: "align" },
    {
      label: "Size",
      items: [
        { id: "small", label: "Small", type: "radio", checked: true },
        { id: "large", label: "Large", type: "radio" },
      ],
    },
    { role: "toggleFullScreen" },
  ],
};

/** A desktop setup as runDesktop wires it, with custom menus. */
function setup(
  options: {
    os?: string;
    menus?: DesktopMenuSpec[];
    window?: DesktopMenuSettings["window"];
    runtimeVersion?: string;
    onAppMenuItem?: (id: string, ctx: DesktopAppMenuItemContext) => void;
  } = {},
) {
  FakeWin.made = [];
  const main = new FakeWin();
  const appMenus: DesktopMenuItem[][] = [];
  const api = Object.assign(new EventTarget(), {
    quitOnLastWindowClosed: true,
    screens: () => [],
    setApplicationMenu: (menu: DesktopMenuItem[] | null) => void appMenus.push(menu ?? []),
  }) as DesktopAppApi & EventTarget;
  const s = setUpDesktopWindows({
    window: main,
    BrowserWindow: FakeWin,
    api,
    emit: () => {},
    wantsTray: false,
    os: options.os ?? "linux",
    exit: () => {},
    warn: () => {},
    windowSettings: { key: "workspace" },
    menuSettings: {
      ...(options.menus ? { menus: options.menus } : {}),
      ...(options.window ? { window: options.window } : {}),
    },
    runtimeVersion: options.runtimeVersion ?? FIRST_APP_MENU_EVENT_RUNTIME,
    ...(options.onAppMenuItem ? { onAppMenuItem: options.onAppMenuItem } : {}),
  });
  main.addEventListener("close", (e) => {
    if (s.interceptMainClose(e)) return;
    s.mainClosed();
  });
  s.install();
  const take = (windowId = "main") =>
    s.app!.capability.methods.take.handler({}, { windowId } as DesktopCapCtx);
  const call = (method: string, args: unknown, windowId = "main") =>
    s.app!.capability.methods[method].handler(args, { windowId } as DesktopCapCtx);
  return { s, main, api, appMenus, take, call };
}

/** A user's click as `Deno.desktop` reports it (the app-level "menuclick"). */
function appClick(api: EventTarget, id: string) {
  api.dispatchEvent(new CustomEvent("menuclick", { detail: { id } }));
}

/** A readable form of a menu entry. */
function brief(entry: DesktopMenuItem): string {
  if (entry === "separator") return "---";
  if ("role" in entry) return `role:${entry.role.role}`;
  if ("submenu" in entry) return `submenu:${entry.submenu.label}`;
  const i = entry.item;
  return `${i.id}:${i.label}${i.checked ? "[x]" : ""}${i.enabled ? "" : "(off)"}`;
}

/** The top-level labels of a menu bar. */
function bar(menu: DesktopMenuItem[] | undefined): string[] {
  return (menu ?? []).map(brief);
}

/** The submenu labelled `label` of a menu bar (all levels flattened to one list). */
function submenu(menu: DesktopMenuItem[] | undefined, label: string): string[] {
  const found = (menu ?? []).find((e) =>
    typeof e === "object" && "submenu" in e && e.submenu.label === label
  ) as { submenu: { items: DesktopMenuItem[] } } | undefined;
  return (found?.submenu.items ?? []).map(brief);
}

/** Every entry of a menu bar, submenus flattened in. */
function flatten(items: DesktopMenuItem[]): DesktopMenuItem[] {
  return items.flatMap((e) =>
    typeof e === "object" && "submenu" in e ? [e, ...flatten(e.submenu.items)] : [e]
  );
}

/** The custom item `id`'s entry (any level) in a menu bar, briefly. */
function itemState(menu: DesktopMenuItem[] | undefined, id: string): string | undefined {
  const found = flatten(menu ?? []).find((e) =>
    typeof e === "object" && "item" in e && e.item.id === `denext:menu:${id}`
  );
  return found ? brief(found) : undefined;
}

/** The key of `desktop.menu`'s problem, if any. */
const keyOf = (menu: unknown) => desktopMenuProblem(menu)?.[0];
/** The text of `desktop.menu`'s problem, or "". */
const problemOf = (menu: unknown) => desktopMenuProblem(menu)?.[1] ?? "";

Deno.test("app menus: desktop.menu.menus is checked at config load and at launch", () => {
  assertEquals(desktopMenuProblem({ menus: [FORMAT] }), null);
  assertEquals(
    desktopMenuProblem({ menus: [FORMAT, { ...FORMAT, items: [] }] }),
    ["menu.menus[1].id", '"format" is used by another menu'],
  );
  assertEquals(
    desktopMenuProblem({
      menus: [FORMAT, { id: "other", label: "Other", items: [{ id: "bold", label: "B" }] }],
    }),
    ["menu.menus[1].items[0].id", '"bold" is used by another menu item'],
  );
  assertEquals(
    keyOf({ menus: [{ id: "m", label: "M", after: "help", items: [] }] }),
    "menu.menus[0].after",
  );
  assertEquals(
    keyOf({ menus: [{ id: "m", label: "M", items: [{ label: "No id" }] }] }),
    "menu.menus[0].items[0].id",
  );
  assertEquals(
    keyOf({ menus: [{ id: "m", label: "M", items: [{ role: "paste-special" }] }] }),
    "menu.menus[0].items[0].role",
  );
  assertEquals(
    keyOf({
      menus: [{ id: "m", label: "M", items: [{ id: "x", label: "X", type: "toggle" }] }],
    }),
    "menu.menus[0].items[0].type",
  );
  assertEquals(
    desktopMenuProblem({
      menus: [{ id: "m", label: "M", items: [{ label: "S", type: "radio", items: [] }] }],
    }),
    ["menu.menus[0].items[0].type", 'an entry with items is a "submenu"'],
  );
  assertEquals(
    keyOf({
      menus: [{ id: "m", label: "M", items: [{ id: "x", label: "X", icon: "not base64!" }] }],
    }),
    "menu.menus[0].items[0].icon",
  );
  let deep: Record<string, unknown> = { id: "leaf", label: "Leaf" };
  for (let i = 0; i < 9; i++) deep = { label: `L${i}`, items: [deep] };
  assertStringIncludes(
    problemOf({ menus: [{ id: "m", label: "M", items: [deep] }] }),
    "nest at most 8",
  );
  assertEquals(keyOf({ menus: "Format" }), "menu.menus");
});

Deno.test("app menus: runDesktop keeps a checked copy; the validator reports under desktop", () => {
  // At launch: a deep copy, and the window items alongside.
  const resolved = resolveDesktopMenuSettings({
    menu: { menus: [FORMAT], window: { list: true } },
  });
  assertEquals(resolved?.menus?.[0].items.length, FORMAT.items.length);
  assert(resolved?.menus?.[0].items !== FORMAT.items);
  assertEquals(resolved?.window, { list: true });
  assertEquals(resolveDesktopMenuSettings({ menu: { menus: [] } }), {});
  assertThrows(
    () => resolveDesktopMenuSettings({ menu: { menus: [{ id: "", label: "M", items: [] }] } }),
    Error,
    "desktop.menu.menus[0].id",
  );
  // The config validator reports it under desktop.
  assertThrows(
    () =>
      validateDenextConfig({
        desktop: { menu: { menus: [{ id: "m", label: "M", items: [{ label: "x" }] }] } },
      } as unknown as DenextConfig),
    Error,
    "desktop.menu.menus[0].items[0].id",
  );
});

Deno.test("app menus: the managed bar on macOS, custom menus after their anchors", () => {
  const { main, appMenus } = setup({
    os: "darwin",
    window: { list: true },
    menus: [
      { id: "tools", label: "Tools", after: "window", items: [{ id: "t", label: "T" }] },
      FORMAT, // default "view": no View, so after Edit
      { id: "go", label: "Go", after: "app", items: [{ id: "g", label: "G" }] },
      { id: "file", label: "File", after: "file", items: [{ id: "f", label: "F" }] },
    ],
  });
  assertEquals(bar(main.menus.at(-1)), [
    "submenu:App",
    "submenu:Go",
    "submenu:File",
    "submenu:Edit",
    "submenu:Format",
    "submenu:Window",
    "submenu:Tools",
  ]);
  assertEquals(submenu(main.menus.at(-1), "App"), [
    "role:about",
    "---",
    "role:hide",
    "role:hideOthers",
    "role:unhide",
    "---",
    "role:quit",
  ]);
  assertEquals(submenu(main.menus.at(-1), "Format"), [
    "denext:menu:bold:Bold",
    "---",
    "denext:menu:left:Left[x]",
    "denext:menu:center:Center",
    "submenu:Size",
    "role:toggleFullScreen",
  ]);
  // The app-level menu (no window's) carries the same bar with the app-wide state.
  assertEquals(bar(appMenus.at(-1)), bar(main.menus.at(-1)));
  // With custom menus only, macOS still gets the standard Window menu (its roles).
  const bare = setup({ os: "darwin", menus: [FORMAT] });
  assertEquals(submenu(bare.main.menus.at(-1), "Window"), ["role:minimize", "role:zoom"]);
});

Deno.test("app menus: Windows and Linux have no managed menus; the custom menus open the bar", () => {
  const { main, appMenus } = setup({
    menus: [FORMAT, { id: "go", label: "Go", after: "app", items: [{ id: "g", label: "G" }] }],
  });
  assertEquals(bar(main.menus.at(-1)), ["submenu:Go", "submenu:Format"]);
  // Where each window has its own bar, the app-level menu (which the runtime would set on every
  // window) is not used.
  assertEquals(appMenus, []);
});

Deno.test("app menus: a page's setAppMenu keeps them, placed by its submenus' labels", async () => {
  const { main, call } = setup({
    window: { newWindow: "/" },
    menus: [
      FORMAT,
      { id: "tools", label: "Tools", after: "window", items: [{ id: "t", label: "T" }] },
      { id: "go", label: "Go", after: "file", items: [{ id: "g", label: "G" }] },
    ],
  });
  await call("setAppMenu", {
    menu: [
      { label: "&File", children: [{ id: "open", label: "Open" }] },
      { label: "Edit", children: [{ role: "copy" }] },
      { label: "View", children: [{ id: "zoom", label: "Zoom" }] },
      { label: "Window", children: [{ id: "tile", label: "Tile" }] },
      { label: "Help", children: [{ id: "docs", label: "Docs" }] },
    ],
  });
  assertEquals(bar(main.menus.at(-1)), [
    "submenu:&File",
    "submenu:Go",
    "submenu:Edit",
    "submenu:View",
    "submenu:Format",
    "submenu:Window",
    "submenu:Tools",
    "submenu:Help",
  ]);
  // The backend's Window items still join the page's own Window submenu.
  assertEquals(submenu(main.menus.at(-1), "Window"), [
    "tile:Tile",
    "---",
    "denext:window:new:New Window",
  ]);
  // A page menu may not use the custom menus' or the windows' own id prefixes.
  for (const id of ["denext:menu:bold", "denext:window:app:main:x"]) {
    try {
      await call("setAppMenu", { menu: [{ label: "X", children: [{ id, label: "X" }] }] });
      throw new Error("accepted a reserved id");
    } catch (err) {
      assert(err instanceof DesktopCapError && err.code === "validation");
    }
  }
});

Deno.test("app menus: setMenu replaces, adds and removes a menu; ids stay unique", async () => {
  const { main, call, s } = setup({ menus: [FORMAT] });
  await call("setMenu", { menuId: "format", menu: { items: [{ id: "italic", label: "Italic" }] } });
  assertEquals(submenu(main.menus.at(-1), "Format"), ["denext:menu:italic:Italic"]);
  // A new menu needs a label; the backend adds one too.
  assertThrows(
    () => call("setMenu", { menuId: "docs", menu: { items: [] } }),
    DesktopCapError,
    ".label must be",
  );
  s.appMenus.setMenu("docs", {
    label: "Documents",
    after: "app",
    items: [{ id: "doc-1", label: "Notes" }],
  });
  assertEquals(bar(main.menus.at(-1)), ["submenu:Documents", "submenu:Format"]);
  // Another menu's item id is refused.
  assertThrows(
    () => s.appMenus.setMenu("docs", { items: [{ id: "italic", label: "Again" }] }),
    DesktopCapError,
    '"italic" is used by another menu item',
  );
  s.appMenus.setMenu("format", null);
  assertEquals(bar(main.menus.at(-1)), ["submenu:Documents"]);
  // Removing a menu that is not there is nothing.
  s.appMenus.setMenu("format", null);
});

Deno.test("app menus: per-window state is each window's bar; app-wide state is the fallback", () => {
  const { s, main, appMenus } = setup({ os: "darwin", menus: [FORMAT] });
  const doc = s.windows.open({ url: "/doc", key: "doc" });
  const docWin = FakeWin.made.at(-1)!;
  // The new window got its own bar.
  assertEquals(itemState(docWin.menus.at(-1), "bold"), "denext:menu:bold:Bold");
  s.appMenus.setMenuItemState("bold", { checked: true }, { windowId: doc.id });
  s.appMenus.setMenuItemState("center", { enabled: false, label: "Centre" });
  // The document window shows its own state over the app-wide one; main shows the app-wide state.
  assertEquals(itemState(docWin.menus.at(-1), "bold"), "denext:menu:bold:Bold[x]");
  assertEquals(itemState(main.menus.at(-1), "bold"), "denext:menu:bold:Bold");
  assertEquals(itemState(docWin.menus.at(-1), "center"), "denext:menu:center:Centre(off)");
  assertEquals(itemState(main.menus.at(-1), "center"), "denext:menu:center:Centre(off)");
  // The app-level menu (macOS, shown when no window with a menu is key) has the app-wide state.
  assertEquals(itemState(appMenus.at(-1), "bold"), "denext:menu:bold:Bold");
  // A window-scoped change re-applies that window's bar only.
  const mainCount = main.menus.length;
  s.appMenus.setMenuItemState("bold", { checked: false }, { windowId: doc.id });
  assertEquals(main.menus.length, mainCount);
  assertEquals(itemState(docWin.menus.at(-1), "bold"), "denext:menu:bold:Bold");
  // A window that is not open is not_found; an unknown item is a validation error.
  assertThrows(
    () => s.appMenus.setMenuItemState("bold", { checked: true }, { windowId: "window-99" }),
    DesktopCapError,
    "no such window",
  );
  assertThrows(() => s.appMenus.setMenuItemState("nope", { checked: true }), DesktopCapError);
  assertThrows(
    () => s.appMenus.setMenuItemState("bold", { checked: "yes" } as never),
    DesktopCapError,
    "must be a boolean",
  );
});

Deno.test("app menus: the key window's state follows the key window (each window keeps its own)", async () => {
  // macOS: the runtime swaps the menu bar to the key window's own; Windows / Linux: each window's
  // bar is its own. Either way, the state a window was given shows while it is key.
  const { s, main, api, take } = setup({ os: "darwin", menus: [FORMAT] });
  const a = s.windows.open({ url: "/a", key: "a" });
  const aWin = FakeWin.made.at(-1)!;
  const b = s.windows.open({ url: "/b", key: "b" });
  const bWin = FakeWin.made.at(-1)!;
  s.appMenus.setMenuItemState("bold", { checked: true }, { windowId: a.id });
  aWin.focus();
  // A click while `a` is key toggles a's own state (it was set for `a`), not the app-wide one.
  appClick(api, "denext:menu:bold");
  assertEquals(itemState(aWin.menus.at(-1), "bold"), "denext:menu:bold:Bold");
  assertEquals(itemState(bWin.menus.at(-1), "bold"), "denext:menu:bold:Bold");
  bWin.focus();
  // `b` has no state of its own: the click toggles the app-wide state (every window without one).
  appClick(api, "denext:menu:bold");
  assertEquals(itemState(bWin.menus.at(-1), "bold"), "denext:menu:bold:Bold[x]");
  assertEquals(itemState(main.menus.at(-1), "bold"), "denext:menu:bold:Bold[x]");
  // `a` keeps its own (unchecked) state.
  assertEquals(itemState(aWin.menus.at(-1), "bold"), "denext:menu:bold:Bold");
  const clicks = await take(b.id) as { keyWindow: unknown; checked?: boolean }[];
  assertEquals(clicks.map((c) => [c.keyWindow, c.checked]), [
    [{ id: a.id, key: "a" }, false],
    [{ id: b.id, key: "b" }, true],
  ]);
  // Its state goes with the window.
  aWin.userClose();
  assertThrows(
    () => s.appMenus.setMenuItemState("bold", { checked: true }, { windowId: a.id }),
    DesktopCapError,
    "no such window",
  );
});

Deno.test("app menus: radio items exclude each other within their group; checkboxes toggle", () => {
  const { main, api, s } = setup({ menus: [FORMAT] });
  appClick(api, "denext:menu:center");
  assertEquals(itemState(main.menus.at(-1), "center"), "denext:menu:center:Center[x]");
  assertEquals(itemState(main.menus.at(-1), "left"), "denext:menu:left:Left");
  // The submenu's radio items (no group) are their own group: untouched by "align".
  assertEquals(itemState(main.menus.at(-1), "small"), "denext:menu:small:Small[x]");
  appClick(api, "denext:menu:large");
  assertEquals(itemState(main.menus.at(-1), "small"), "denext:menu:small:Small");
  assertEquals(itemState(main.menus.at(-1), "center"), "denext:menu:center:Center[x]");
  // setMenuItemState checking a radio item unchecks the rest too.
  s.appMenus.setMenuItemState("left", { checked: true });
  assertEquals(itemState(main.menus.at(-1), "center"), "denext:menu:center:Center");
  // Per window: the group's state set for a window stays that window's.
  const doc = s.windows.open({ url: "/doc", key: "doc" });
  const docWin = FakeWin.made.at(-1)!;
  s.appMenus.setMenuItemState("center", { checked: true }, { windowId: doc.id });
  assertEquals(itemState(docWin.menus.at(-1), "left"), "denext:menu:left:Left");
  assertEquals(itemState(main.menus.at(-1), "left"), "denext:menu:left:Left[x]");
  docWin.focus();
  appClick(api, "denext:menu:left");
  assertEquals(itemState(docWin.menus.at(-1), "left"), "denext:menu:left:Left[x]");
  assertEquals(itemState(docWin.menus.at(-1), "center"), "denext:menu:center:Center");
  // A checkbox toggles; a disabled item's click is dropped.
  appClick(api, "denext:menu:bold");
  assertEquals(itemState(docWin.menus.at(-1), "bold"), "denext:menu:bold:Bold[x]");
  s.appMenus.setMenuItemState("bold", { enabled: false });
  appClick(api, "denext:menu:bold");
  assertEquals(itemState(docWin.menus.at(-1), "bold"), "denext:menu:bold:Bold[x](off)");
});

Deno.test("app menus: a window's own Window-menu items: shown while it is key, cleared when it closes", async () => {
  const { s, main, take, call } = setup({ window: { list: true } });
  const doc = s.windows.open({ url: "/doc", key: "doc" });
  const docWin = FakeWin.made.at(-1)!;
  // The page sets its own window's items.
  await call("setWindowMenuAppItems", {
    items: [
      { id: "d1", label: "Notes.txt", checked: true },
      { id: "d2", label: "Todo.md" },
      { type: "separator" },
      { id: "cascade", label: "Cascade", enabled: false },
    ],
  }, doc.id);
  assertEquals(submenu(docWin.menus.at(-1), "Window"), [
    "denext:window:focus:main:workspace",
    `denext:window:focus:${doc.id}:doc`,
    "---",
    `denext:window:app:${doc.id}:d1:Notes.txt[x]`,
    `denext:window:app:${doc.id}:d2:Todo.md`,
    "---",
    `denext:window:app:${doc.id}:cascade:Cascade(off)`,
  ]);
  // Not in another window's menu.
  assertEquals(submenu(main.menus.at(-1), "Window"), [
    "denext:window:focus:main:workspace",
    `denext:window:focus:${doc.id}:doc`,
  ]);
  // The backend sets any window's; a window that is not open is not_found; bad items are refused.
  s.appMenus.setWindowMenuAppItems("main", [{ id: "m1", label: "Main doc" }]);
  assert(submenu(main.menus.at(-1), "Window").includes("denext:window:app:main:m1:Main doc"));
  assertThrows(
    () => s.appMenus.setWindowMenuAppItems("window-99", []),
    DesktopCapError,
    "no such window",
  );
  assertThrows(
    () =>
      s.appMenus.setWindowMenuAppItems("main", [{ id: "x", label: "A" }, { id: "x", label: "B" }]),
    DesktopCapError,
    '"x" is used by another item',
  );
  s.appMenus.setWindowMenuAppItems("main", null);
  assertEquals(submenu(main.menus.at(-1), "Window").some((e) => e.includes(":m1:")), false);
  // Closed: its items go (the backend can no longer set them either).
  docWin.userClose();
  assertThrows(
    () => s.appMenus.setWindowMenuAppItems(doc.id, []),
    DesktopCapError,
    "no such window",
  );
  assertEquals(await take(doc.id), []);
});

Deno.test("app menus: macOS puts a window's own items before Bring All to Front", async () => {
  const { main, call } = setup({ os: "darwin", window: { list: true } });
  await call("setWindowMenuAppItems", { items: [{ id: "tile", label: "Tile Vertically" }] });
  assertEquals(submenu(main.menus.at(-1), "Window"), [
    "role:minimize",
    "role:zoom",
    "---",
    "denext:window:focus:main:workspace",
    "---",
    "denext:window:app:main:tile:Tile Vertically",
    "---",
    "role:front",
  ]);
});

Deno.test("app menus: clicks reach every page, desktop.ts and extensions with the key window", async () => {
  const seen: [string, DesktopAppMenuItemContext][] = [];
  const { s, api, take, call } = setup({
    menus: [FORMAT],
    onAppMenuItem: (id, ctx) => void seen.push([id, ctx]),
  });
  // An extension's host subscribes through the bridge.
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{
    name: "mdi",
    methods: {},
    setup: (h) => {
      host = h;
    },
  }], { appMenus: s.appMenus });
  const hostSeen: string[] = [];
  host!.onAppMenuItem((id, ctx) => void hostSeen.push(`${id}:${ctx.source}`));
  const doc = s.windows.open({ url: "/doc", key: "doc" });
  FakeWin.made.at(-1)!.focus();
  appClick(api, "denext:menu:center");
  // Every window's page hears a custom item's click.
  const expected = {
    source: "menu",
    id: "center",
    kind: "menu",
    keyWindow: { id: doc.id, key: "doc" },
    menu: "format",
    checked: true,
  };
  assertEquals(await take("main"), [expected]);
  assertEquals(await take(doc.id), [expected]);
  assertEquals(seen, [["center", {
    source: "menu",
    keyWindow: { id: doc.id, key: "doc" },
    menu: "format",
    checked: true,
  }]]);
  // A window's own item reaches only that window's page (and the backend).
  await call("setWindowMenuAppItems", { items: [{ id: "d1", label: "Notes" }] }, doc.id);
  appClick(api, `denext:window:app:${doc.id}:d1`);
  assertEquals(await take("main"), []);
  assertEquals(await take(doc.id), [{
    source: "menu",
    id: "d1",
    kind: "windowMenu",
    keyWindow: { id: doc.id, key: "doc" },
    windowId: doc.id,
  }]);
  assertEquals(seen.at(-1), ["d1", {
    source: "windowMenu",
    keyWindow: { id: doc.id, key: "doc" },
    windowId: doc.id,
  }]);
  assertEquals(hostSeen, ["center:menu", "d1:windowMenu"]);
  // A forged id for an item that does not exist is dropped.
  appClick(api, `denext:window:app:${doc.id}:nope`);
  appClick(api, "denext:menu:nope");
  assertEquals(seen.length, 2);
  // A host with no app menus API: unsupported calls, inert subscription.
  let bare: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "x", methods: {}, setup: (h) => void (bare = h) }], {});
  assertThrows(() => bare!.setMenu("m", null), DesktopCapError, "need the desktop runtime");
  bare!.onAppMenuItem(() => {})();
});

Deno.test("app menus: until the app uses them, only the main window gets a menu, as before", async () => {
  const { s, main, call } = setup({ window: { list: true } });
  s.windows.open({ url: "/doc", key: "doc" });
  const docWin = FakeWin.made.at(-1)!;
  assertEquals(docWin.menus, []);
  assert(main.menus.length > 0);
  // The first custom-menu call gives every window its own bar.
  await call("setMenu", { menuId: "format", menu: { label: "Format", items: [] } });
  assertEquals(bar(docWin.menus.at(-1)), ["submenu:Format", "submenu:Window"]);
});

Deno.test("app menus: frameless windows get no bar on Windows and Linux; macOS gives every window one", () => {
  const linux = setup({ menus: [FORMAT] });
  linux.s.windows.open({ url: "/hud", frameless: true });
  assertEquals(FakeWin.made.at(-1)!.menus, []);
  const mac = setup({ os: "darwin", menus: [FORMAT] });
  mac.s.windows.open({ url: "/hud", frameless: true });
  assert(FakeWin.made.at(-1)!.menus.length > 0);
});

Deno.test("app menus: on a runtime whose clicks come from the window, each window's own are heard", async () => {
  const { s, take } = setup({ menus: [FORMAT], runtimeVersion: WINDOW_CLICK_RUNTIME });
  const doc = s.windows.open({ url: "/doc", key: "doc" });
  const docWin = FakeWin.made.at(-1)!;
  docWin.focus();
  docWin.dispatchEvent(new CustomEvent("menuclick", { detail: { id: "denext:menu:bold" } }));
  const clicks = await take(doc.id) as { id: string; checked?: boolean }[];
  assertEquals(clicks.map((c) => [c.id, c.checked]), [["bold", true]]);
});

Deno.test("app menus: unsupported without an app window to set menus on", async () => {
  FakeWin.made = [];
  const s = setUpDesktopWindows({ window: undefined, emit: () => {}, wantsTray: false });
  assertThrows(() => s.appMenus.setMenu("m", null), DesktopCapError, "no window");
  // A runtime window with no setApplicationMenu: the page's calls are unsupported.
  const win = new FakeWin();
  Object.defineProperty(win, "setApplicationMenu", { value: undefined });
  const t = setUpDesktopWindows({
    window: win,
    BrowserWindow: FakeWin,
    emit: () => {},
    wantsTray: false,
  });
  assertThrows(
    () =>
      t.app!.capability.methods.setMenu.handler(
        { menuId: "m", menu: { label: "M", items: [] } },
        { windowId: "main" } as DesktopCapCtx,
      ),
    DesktopCapError,
    "not available here",
  );
  const caps = await t.app!.capability.methods.capabilities.handler({}, {} as DesktopCapCtx) as {
    customMenus: boolean;
    appLevelMenu: boolean;
  };
  assertEquals([caps.customMenus, caps.appLevelMenu], [false, false]);
});
