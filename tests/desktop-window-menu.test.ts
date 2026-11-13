// The standard window items of the application menu (src/desktop/window-menu.ts, `desktop.menu.window`,
// merged by src/desktop/caps/app.ts): New Window with a fresh key (or desktop.ts's window), Reopen
// Closed Window over the keyed windows the user closed, the list of open windows that focuses one,
// the macOS roles, the merge into a page's own menu, and the config checks — against fake runtime
// windows and a fake `Deno.desktop`.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { DesktopCapCtx } from "../src/desktop/extension.ts";
import type { DesktopAppApi, DesktopMenuItem } from "../src/desktop/launch-events.ts";
import type { RegistryWindow } from "../src/desktop/window-registry.ts";
import { setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import { FIRST_APP_MENU_EVENT_RUNTIME } from "../src/build/deno-version.ts";
import { desktopMenuProblem, resolveDesktopMenuSettings } from "../src/desktop/menu-config.ts";
import type { DesktopWindowMenuSettings } from "../src/desktop/menu-config.ts";
import type {
  DesktopNewWindowHandler,
  DesktopWindowMenuItemHandler,
} from "../src/desktop/window-menu.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import type { DesktopExtensionHost } from "../src/desktop/extension.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

/** A runtime window that records its application menus and its show / focus calls. */
class FakeWin extends EventTarget implements RegistryWindow {
  static made: FakeWin[] = [];
  menus: DesktopMenuItem[][] = [];
  calls: string[] = [];
  constructor(readonly options?: Record<string, unknown>) {
    super();
    FakeWin.made.push(this);
  }
  bind() {}
  navigate(url: string) {
    this.calls.push(`navigate:${url}`);
  }
  show() {
    this.calls.push("show");
  }
  hide() {}
  focus() {
    this.calls.push("focus");
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
  /** The user chose an application-menu item (by click or accelerator). */
  click(id: string) {
    this.dispatchEvent(new CustomEvent("menuclick", { detail: { id } }));
  }
  /** The user closed it. */
  userClose(): boolean {
    const event = new Event("close", { cancelable: true });
    this.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

/** A `Deno.desktop` whose `quit()` closes every window like the pinned runtime's. */
function quittingApi(windows: () => readonly EventTarget[]) {
  const api = Object.assign(new EventTarget(), {
    quitOnLastWindowClosed: true,
    screens: () => [],
    quit: () => {
      const before = new Event("beforequit", { cancelable: true });
      api.dispatchEvent(before);
      if (before.defaultPrevented) return false;
      for (const win of windows()) {
        const close = new Event("close", { cancelable: true });
        win.dispatchEvent(close);
        if (close.defaultPrevented) return false;
      }
      return true;
    },
  }) as DesktopAppApi & EventTarget;
  return api;
}

/** The last runtime before `Deno.desktop`'s app-level "menuclick": clicks come from the window. */
const WINDOW_CLICK_RUNTIME = "3.0.0-denext.13";

/** A desktop setup with the window menu on, the main window wired as runDesktop wires it. */
function setup(
  options: {
    os?: string;
    menu?: DesktopWindowMenuSettings;
    newWindow?: DesktopNewWindowHandler;
    onWindowMenuItem?: DesktopWindowMenuItemHandler;
    title?: string;
    runtimeVersion?: string;
    keepAlive?: boolean;
    /** A `Deno.desktop` with no `addEventListener` (a runtime without the listener API). */
    noListenerApi?: boolean;
  } = {},
) {
  FakeWin.made = [];
  const main = new FakeWin();
  const api = quittingApi(() => FakeWin.made);
  if (options.noListenerApi) {
    Object.defineProperty(api, "addEventListener", { value: undefined });
  }
  const warnings: string[] = [];
  const s = setUpDesktopWindows({
    window: main,
    BrowserWindow: FakeWin,
    api,
    emit: () => {},
    wantsTray: false,
    os: options.os ?? "linux",
    exit: () => {},
    warn: (m) => void warnings.push(m),
    windowSettings: { key: "workspace", ...(options.title ? { title: options.title } : {}) },
    menuSettings: {
      window: options.menu ?? { newWindow: "/", reopenClosed: true, list: true },
    },
    ...(options.newWindow ? { newWindow: options.newWindow } : {}),
    ...(options.onWindowMenuItem ? { onWindowMenuItem: options.onWindowMenuItem } : {}),
    // A runtime whose clicks reach the main window, unless a test names one (whatever runs it).
    runtimeVersion: options.runtimeVersion ?? WINDOW_CLICK_RUNTIME,
    ...(options.keepAlive !== undefined ? { appSettings: { keepAlive: options.keepAlive } } : {}),
  });
  main.addEventListener("close", (e) => {
    if (s.interceptMainClose(e)) return;
    s.mainClosed();
  });
  s.install();
  return { s, main, api, warnings };
}

/** The "Window" submenu of the last application menu set on `win`. */
function windowSubmenu(win: FakeWin): DesktopMenuItem[] {
  const menu = win.menus.at(-1) ?? [];
  const sub = menu.find((e) => typeof e === "object" && "submenu" in e) as
    | { submenu: { label: string; items: DesktopMenuItem[] } }
    | undefined;
  assertEquals(sub?.submenu.label, "Window");
  return sub!.submenu.items;
}

/** A readable form of a menu entry. */
function brief(entry: DesktopMenuItem): string {
  if (entry === "separator") return "---";
  if ("role" in entry) return `role:${entry.role.role}`;
  if ("submenu" in entry) return `submenu:${entry.submenu.label}`;
  const i = entry.item;
  return `${i.id}:${i.label}${i.accelerator ? `[${i.accelerator}]` : ""}${
    i.enabled ? "" : "(off)"
  }`;
}

const ctx = (windowId = "main") => ({ windowId } as DesktopCapCtx);

Deno.test("window menu: the items, their shortcuts and the platform's roles", () => {
  const linux = setup();
  assertEquals(windowSubmenu(linux.main).map(brief), [
    "denext:window:new:New Window[CommandOrControl+N]",
    "denext:window:reopen:Reopen Closed Window[CommandOrControl+Shift+T](off)",
    "---",
    "denext:window:focus:main:workspace",
  ]);
  const mac = setup({ os: "darwin", title: "Qutty" });
  // With no page menu the bar is the managed one: AppKit shows the first submenu under the app's
  // name, so the app menu and Edit come first.
  assertEquals((mac.main.menus.at(-1) ?? []).map(brief), [
    "submenu:App",
    "submenu:Edit",
    "submenu:Window",
  ]);
  assertEquals(windowSubmenuLabelled(mac.main, "window").map(brief), [
    "role:minimize",
    "role:zoom",
    "---",
    "denext:window:new:New Window[CommandOrControl+N]",
    "denext:window:reopen:Reopen Closed Window[CommandOrControl+Shift+T](off)",
    "---",
    "denext:window:focus:main:Qutty",
    "---",
    "role:front",
  ]);
  // Each item is its own opt-in; nothing configured means no submenu at all.
  const only = setup({ menu: { list: true } });
  assertEquals(windowSubmenu(only.main).map(brief), ["denext:window:focus:main:workspace"]);
  FakeWin.made = [];
  const off = new FakeWin();
  setUpDesktopWindows({ window: off, BrowserWindow: FakeWin, emit: () => {}, wantsTray: false })
    .install();
  assertEquals(off.menus, []);
});

Deno.test("window menu: New Window opens the configured path with a fresh key; desktop.ts can supply the window", () => {
  const { s, main } = setup();
  main.click("denext:window:new");
  main.click("denext:window:new");
  assertEquals(s.windows.list().map((w) => w.key), ["workspace", "window-1", "window-2"]);
  assertEquals(FakeWin.made.at(-1)!.calls, ["navigate:/"]);
  // The list follows: the new windows are in it, by key.
  assertEquals(windowSubmenu(main).map(brief).slice(-2), [
    "denext:window:focus:window-1:window-1",
    "denext:window:focus:window-2:window-2",
  ]);
  // Closing window-1 frees its key: the next New Window takes the lowest one again.
  s.windows.byKey("window-1")!.close();
  main.click("denext:window:new");
  assertEquals(s.windows.byKey("window-1")?.kind, "window");

  // desktop.ts decides: it gets the suggestion and the configured path, and answers the window.
  const seen: unknown[] = [];
  const own = setup({
    newWindow: (ctx) => {
      seen.push(ctx);
      return { url: "/ws", key: "ws-a", title: "A" };
    },
  });
  own.main.click("denext:window:new");
  assertEquals(seen, [{
    windows: [{ id: "main", key: "workspace" }],
    suggestedKey: "window-1",
    url: "/",
  }]);
  assertEquals(own.s.registry!.byKey("ws-a")?.title, "A");
  // `undefined`: nothing opens. A refused window (a duplicate key) is a warning.
  const none = setup({ menu: {}, newWindow: () => undefined });
  assertEquals(windowSubmenu(none.main).map(brief), [
    "denext:window:new:New Window[CommandOrControl+N]",
  ]);
  none.main.click("denext:window:new");
  assertEquals(none.s.windows.list().length, 1);
  const dup = setup({ newWindow: () => ({ url: "/", key: "workspace" }) });
  dup.main.click("denext:window:new");
  assertEquals(dup.warnings.length, 1);
  assertStringIncludes(dup.warnings[0], "New Window");
});

Deno.test("window menu: Reopen Closed Window brings back the keyed windows the user closed, not a quit's", async () => {
  const { s, main, api } = setup();
  main.click("denext:window:new"); // window-1
  main.click("denext:window:new"); // window-2
  s.windows.byKey("window-2")!.navigate("/two");
  // The user closes both: most recent first; the item turns on.
  assert(FakeWin.made[1].userClose());
  assert(FakeWin.made[2].userClose());
  assertEquals(s.menu!.closed(), [{ key: "window-2", url: "/two" }, { key: "window-1", url: "/" }]);
  assert(
    windowSubmenu(main).map(brief).includes(
      "denext:window:reopen:Reopen Closed Window[CommandOrControl+Shift+T]",
    ),
  );
  main.click("denext:window:reopen");
  assertEquals(s.registry!.byKey("window-2")?.url, "/two");
  assertEquals(FakeWin.made.at(-1)!.calls, ["navigate:/two"]);
  assertEquals(s.menu!.closed(), [{ key: "window-1", url: "/" }]);
  // A key opened again meanwhile is skipped.
  main.click("denext:window:new"); // takes window-1
  main.click("denext:window:reopen");
  assertEquals(s.menu!.closed(), []);
  assertEquals(s.windows.list().length, 3);
  assert(
    windowSubmenu(main).map(brief).includes(
      "denext:window:reopen:Reopen Closed Window[CommandOrControl+Shift+T](off)",
    ),
  );
  // A quit's closes are not remembered.
  s.lifecycle!.onAppQuit(() => {});
  api.quit!();
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(s.menu!.closed(), []);
});

Deno.test("window menu: picking a window in the list shows and focuses it; the panel is not listed", () => {
  const { s, main } = setup();
  main.click("denext:window:new");
  const opened = FakeWin.made.at(-1)!;
  opened.calls.length = 0;
  main.click(`denext:window:focus:${s.windows.byKey("window-1")!.id}`);
  assertEquals(opened.calls, ["show", "focus"]);
  main.click("denext:window:focus:gone"); // unknown: nothing
  s.registry!.adopt(new FakeWin(), "panel");
  assertEquals(
    windowSubmenu(main).map(brief).filter((b) => b.startsWith("denext:window:focus")).length,
    2,
  );
});

Deno.test("window menu: merged into a page's menu, into its own Window submenu; its clicks never reach the page", async () => {
  const { s, main } = setup({ menu: { newWindow: "/" } });
  const app = s.app!.capability;
  await app.methods.setAppMenu.handler({
    menu: [
      { label: "File", children: [{ id: "open", label: "Open", enabled: true }] },
      { label: "window", children: [{ id: "tile", label: "Tile", enabled: true }] },
    ],
  }, ctx());
  assertEquals((main.menus.at(-1) ?? []).map(brief), ["submenu:File", "submenu:window"]);
  assertEquals(windowSubmenuLabelled(main, "window").map(brief), [
    "tile:Tile",
    "---",
    "denext:window:new:New Window[CommandOrControl+N]",
  ]);
  // No Window submenu of its own: the backend's is appended.
  await app.methods.setAppMenu.handler({
    menu: [{ label: "File", children: [{ id: "open", label: "Open", enabled: true }] }],
  }, ctx());
  assertEquals((main.menus.at(-1) ?? []).map(brief), ["submenu:File", "submenu:Window"]);
  // The page's own items still reach it; the backend's do not.
  main.click("open");
  main.click("denext:window:new");
  assertEquals(await app.methods.take.handler({}, ctx()), [
    { source: "menu", id: "open", kind: "appMenu", keyWindow: { id: "main", key: "workspace" } },
  ]);
  assertEquals(s.windows.list().length, 2, "New Window still worked");
});

/** The submenu labelled `label` (any case) of the last application menu set on `win`. */
function windowSubmenuLabelled(win: FakeWin, label: string): DesktopMenuItem[] {
  const menu = win.menus.at(-1) ?? [];
  const sub = menu.find((e) =>
    typeof e === "object" && "submenu" in e && e.submenu.label.toLowerCase() === label
  ) as { submenu: { items: DesktopMenuItem[] } } | undefined;
  return sub?.submenu.items ?? [];
}

Deno.test("window menu: desktop.menu is checked at config load and at launch", () => {
  assertEquals(desktopMenuProblem(undefined), null);
  assertEquals(desktopMenuProblem({ window: { newWindow: "/", reopenClosed: true } }), null);
  assertEquals(desktopMenuProblem({ window: { newWindow: false } }), null);
  assertEquals(desktopMenuProblem([])?.[0], "menu");
  assertEquals(desktopMenuProblem({ window: 1 })?.[0], "menu.window");
  assertEquals(
    desktopMenuProblem({ window: { newWindow: "https://x/" } })?.[0],
    "menu.window.newWindow",
  );
  assertEquals(desktopMenuProblem({ window: { list: "yes" } })?.[0], "menu.window.list");
  assertEquals(resolveDesktopMenuSettings({}), undefined);
  assertEquals(resolveDesktopMenuSettings({ menu: {} }), {});
  assertEquals(resolveDesktopMenuSettings({ menu: { window: { list: true } } }), {
    window: { list: true },
  });
  assertThrows(
    () => resolveDesktopMenuSettings({ menu: { window: { reopenClosed: 1 } } }),
    Error,
    "menu.window.reopenClosed",
  );
  const validate = (menu: unknown) => validateDenextConfig({ desktop: { menu } } as DenextConfig);
  validate({ window: { newWindow: "/", reopenClosed: true, list: true } });
  assertThrows(
    () => validate({ window: { newWindow: "x" } }),
    Error,
    "desktop.menu.window.newWindow",
  );
});

/** An app-level application-menu click (`Deno.desktop`'s `"menuclick"`). */
function appClick(api: EventTarget, id: string): void {
  api.dispatchEvent(new CustomEvent("menuclick", { detail: { id } }));
}

Deno.test("window menu: a runtime before the app-level menu event takes the clicks from the main window", () => {
  const older = setup({ runtimeVersion: "3.0.0-denext.13" });
  // Deno.desktop's event is not listened to: nothing opens.
  appClick(older.api, "denext:window:new");
  assertEquals(older.s.windows.list().length, 1);
  older.main.click("denext:window:new");
  assertEquals(older.s.windows.list().length, 2);
  // A new enough runtime whose Deno.desktop has no listener API: still the main window's.
  const noApi = setup({ runtimeVersion: FIRST_APP_MENU_EVENT_RUNTIME, noListenerApi: true });
  noApi.main.click("denext:window:new");
  assertEquals(noApi.s.windows.list().length, 2);
});

Deno.test("window menu: the app-level menu event drives the menu, and the main window's is not also heard", async () => {
  const { s, main, api } = setup({ runtimeVersion: FIRST_APP_MENU_EVENT_RUNTIME });
  appClick(api, "denext:window:new");
  assertEquals(s.windows.list().map((w) => w.key), ["workspace", "window-1"]);
  // Never handled twice: the main window's event is not listened to on this runtime.
  main.click("denext:window:new");
  assertEquals(s.windows.list().length, 2);
  // The page's own items still reach the pages, once.
  const app = s.app!.capability;
  await app.methods.setAppMenu.handler({
    menu: [{ label: "File", children: [{ id: "open", label: "Open", enabled: true }] }],
  }, ctx());
  appClick(api, "open");
  main.click("open");
  assertEquals(await app.methods.take.handler({}, ctx()), [
    { source: "menu", id: "open", kind: "appMenu", keyWindow: { id: "window-1", key: "window-1" } },
  ]);
});

Deno.test("window menu: with a non-main window key, its clicks still arrive (app-level event)", () => {
  const { s, api } = setup({ runtimeVersion: FIRST_APP_MENU_EVENT_RUNTIME });
  appClick(api, "denext:window:new");
  const other = FakeWin.made.at(-1)!;
  other.calls.length = 0;
  // The other window is key: the runtime delivers on Deno.desktop, not on the main window.
  appClick(api, `denext:window:focus:${s.windows.byKey("window-1")!.id}`);
  assertEquals(other.calls, ["show", "focus"]);
  appClick(api, "denext:window:new");
  assertEquals(s.windows.list().length, 3);
});

Deno.test("window menu: Reopen Closed Window and the list keep working after the main window closes (keepAlive)", () => {
  const { s, main, api } = setup({ runtimeVersion: FIRST_APP_MENU_EVENT_RUNTIME, keepAlive: true });
  appClick(api, "denext:window:new"); // window-1
  appClick(api, "denext:window:new"); // window-2
  assert(FakeWin.made[2].userClose());
  // The main window goes; the app stays up (keepAlive) and its menu keeps answering.
  assert(main.userClose());
  assertEquals(s.windows.list().map((w) => w.key), ["window-1"]);
  assertEquals(s.menu!.closed().map((c) => c.key), ["window-2"]);
  appClick(api, "denext:window:reopen");
  assertEquals(s.windows.list().map((w) => w.key), ["window-1", "window-2"]);
  const first = FakeWin.made[1];
  first.calls.length = 0;
  appClick(api, `denext:window:focus:${s.windows.byKey("window-1")!.id}`);
  assertEquals(first.calls, ["show", "focus"]);
  appClick(api, "denext:window:new");
  assertEquals(s.windows.list().length, 3);
});

// --- the app's own items (desktop.menu.window.items) ------------------------------------------

const ITEMS: DesktopWindowMenuSettings["items"] = [
  { id: "end", label: "Close Window and End", accelerator: "CommandOrControl+Shift+W" },
  { id: "tile", label: "Tile" },
];

Deno.test("window menu items: after denext's items, before the list, with reserved ids", () => {
  const { main } = setup({
    menu: { newWindow: "/", reopenClosed: true, list: true, items: ITEMS },
  });
  assertEquals(windowSubmenu(main).map(brief), [
    "denext:window:new:New Window[CommandOrControl+N]",
    "denext:window:reopen:Reopen Closed Window[CommandOrControl+Shift+T](off)",
    "---",
    "denext:window:item:end:Close Window and End[CommandOrControl+Shift+W]",
    "denext:window:item:tile:Tile",
    "---",
    "denext:window:focus:main:workspace",
  ]);
  // Items alone make the submenu.
  const alone = setup({ menu: { items: ITEMS.slice(1) } });
  assertEquals(windowSubmenu(alone.main).map(brief), ["denext:window:item:tile:Tile"]);
});

Deno.test("window menu items: a click reaches desktop.ts and each extension once, with the key window, never a page", async () => {
  const seen: unknown[] = [];
  const { s, main } = setup({
    menu: { newWindow: "/", items: ITEMS },
    onWindowMenuItem: (id, ctx) => void seen.push(["desktop.ts", id, ctx]),
  });
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "ext", methods: {}, setup: (h) => (host = h) }], {
    lifecycle: s.lifecycle!,
    onWindowMenuItem: (fn) => s.onWindowMenuItem(fn),
  });
  const off = host!.onWindowMenuItem((id, ctx) => void seen.push(["ext", id, ctx]));
  // The page has a menu of its own: it hears its own items only.
  const app = s.app!.capability;
  await app.methods.setAppMenu.handler({
    menu: [{ label: "Window", children: [{ id: "mine", label: "Mine", enabled: true }] }],
  }, ctx());
  main.click("denext:window:new"); // window-1, keyed
  const other = FakeWin.made.at(-1)!;
  other.dispatchEvent(new Event("focus"));
  main.click("denext:window:item:end");
  assertEquals(seen, [
    ["desktop.ts", "end", { keyWindow: { id: s.windows.byKey("window-1")!.id, key: "window-1" } }],
    ["ext", "end", { keyWindow: { id: s.windows.byKey("window-1")!.id, key: "window-1" } }],
  ]);
  assertEquals(await app.methods.take.handler({}, ctx()), [], "no page queue sees it");
  assertEquals(await app.methods.take.handler({}, ctx(s.windows.byKey("window-1")!.id)), []);
  // The main window takes the focus back: it is the key window now. Unsubscribed: desktop.ts only.
  seen.length = 0;
  off();
  main.dispatchEvent(new Event("focus"));
  main.click("denext:window:item:tile");
  assertEquals(seen, [["desktop.ts", "tile", { keyWindow: { id: "main", key: "workspace" } }]]);
});

Deno.test("window menu items: a failing handler is a warning; nothing to handle a click is a warning", () => {
  const failing = setup({
    menu: { items: ITEMS },
    onWindowMenuItem: () => {
      throw new Error("boom");
    },
  });
  failing.main.click("denext:window:item:end");
  assert(failing.warnings.some((w) => w.includes('"end"') && w.includes("boom")));
  const none = setup({ menu: { items: ITEMS } });
  none.main.click("denext:window:item:end");
  assert(none.warnings.some((w) => w.includes("nothing handles it")));
});

Deno.test("window menu items: with no window open the clicks still arrive, keyWindow null (app-level event)", () => {
  const seen: unknown[] = [];
  const { main, api } = setup({
    runtimeVersion: FIRST_APP_MENU_EVENT_RUNTIME,
    keepAlive: true,
    menu: { items: ITEMS },
    onWindowMenuItem: (id, ctx) => void seen.push([id, ctx]),
  });
  assert(main.userClose());
  appClick(api, "denext:window:item:end");
  assertEquals(seen, [["end", { keyWindow: null }]]);
});

Deno.test("window menu items: before the app-level menu event the clicks come from the main window only", () => {
  const seen: unknown[] = [];
  const { main, api } = setup({
    runtimeVersion: WINDOW_CLICK_RUNTIME,
    keepAlive: true,
    menu: { items: ITEMS },
    onWindowMenuItem: (id) => void seen.push(id),
  });
  appClick(api, "denext:window:item:end"); // not listened to on this runtime
  main.click("denext:window:item:end");
  assertEquals(seen, ["end"]);
});

Deno.test("window menu items: a page's application menu may not use the reserved id prefix", async () => {
  const { s } = setup({ menu: { items: ITEMS } });
  const app = s.app!.capability;
  let error: unknown;
  try {
    await app.methods.setAppMenu.handler({
      menu: [{ id: "denext:window:item:end", label: "Fake", enabled: true }],
    }, ctx());
  } catch (err) {
    error = err;
  }
  assertStringIncludes(String((error as Error)?.message), "reserved");
});

Deno.test("window menu items: desktop.menu.window.items is checked at config load and at launch", () => {
  const items = (value: unknown) => desktopMenuProblem({ window: { items: value } });
  assertEquals(items([{ id: "a", label: "A", accelerator: "CommandOrControl+A" }]), null);
  assertEquals(items({})?.[0], "menu.window.items");
  assertEquals(items([1])?.[0], "menu.window.items[0]");
  assertEquals(items([{ label: "A" }])?.[0], "menu.window.items[0].id");
  assertEquals(items([{ id: "a\n", label: "A" }])?.[0], "menu.window.items[0].id");
  assertEquals(items([{ id: "a".repeat(129), label: "A" }])?.[0], "menu.window.items[0].id");
  assertEquals(items([{ id: "a", label: "" }])?.[0], "menu.window.items[0].label");
  assertEquals(
    items([{ id: "a", label: "A", accelerator: 1 }])?.[0],
    "menu.window.items[0].accelerator",
  );
  assertEquals(
    items([{ id: "a", label: "A" }, { id: "a", label: "B" }]),
    ["menu.window.items[1].id", '"a" is used by another item'],
  );
  assertEquals(
    items(Array.from({ length: 33 }, (_, i) => ({ id: `i${i}`, label: "x" })))?.[1],
    "holds at most 32 items",
  );
  assertEquals(
    resolveDesktopMenuSettings({
      menu: { window: { items: [{ id: "a", label: "A", extra: 1 }] } },
    }),
    { window: { items: [{ id: "a", label: "A" }] } },
  );
  const validate = (menu: unknown) => validateDenextConfig({ desktop: { menu } } as DenextConfig);
  validate({ window: { items: [{ id: "a", label: "A" }] } });
  assertThrows(
    () => validate({ window: { items: [{ id: "a" }] } }),
    Error,
    "desktop.menu.window.items[0].label",
  );
});
