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
import { desktopMenuProblem, resolveDesktopMenuSettings } from "../src/desktop/menu-config.ts";
import type { DesktopNewWindowHandler } from "../src/desktop/window-menu.ts";
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

/** A desktop setup with the window menu on, the main window wired as runDesktop wires it. */
function setup(
  options: {
    os?: string;
    menu?: { newWindow?: string | false; reopenClosed?: boolean; list?: boolean };
    newWindow?: DesktopNewWindowHandler;
    title?: string;
  } = {},
) {
  FakeWin.made = [];
  const main = new FakeWin();
  const api = quittingApi(() => FakeWin.made);
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
  assertEquals(windowSubmenu(mac.main).map(brief), [
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
  assertEquals(await app.methods.take.handler({}, ctx()), [{ source: "menu", id: "open" }]);
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
