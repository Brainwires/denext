// The multi-window follow-ups (src/desktop/app-windows.ts, window-registry.ts, window-store.ts,
// window-menu.ts): the macOS Dock's reopen click reopening the most recently closed keyed window
// (or `runDesktop({ onDockReopen })`'s window) and `DesktopRuntime.onDockReopen`; opened windows
// inheriting `desktop.titleBar` (and a per-window `titleBar`); `defaultWidth` / `defaultHeight`
// used only without a saved frame; `desktop.menu.window.reopenClosed: "list"`, `windows.forget`
// and the windows' page titles in the menus — against fake runtime windows and a fake Dock.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { DesktopCapCtx } from "../src/desktop/extension.ts";
import type { DesktopAppApi, DesktopMenuItem } from "../src/desktop/launch-events.ts";
import type { RegistryWindow } from "../src/desktop/window-registry.ts";
import { openWindowSettings } from "../src/desktop/window-registry.ts";
import {
  type DesktopDockReopenHandler,
  type DesktopSecondInstanceEvent,
  type DesktopSecondInstanceHandler,
  noDesktopWindows,
  setUpDesktopWindows,
} from "../src/desktop/app-windows.ts";
import { desktopMenuProblem, resolveDesktopMenuSettings } from "../src/desktop/menu-config.ts";
import {
  applyDesktopWindowSettings,
  resolveDesktopWindowSettings,
  windowButtonPositionProblem,
} from "../src/desktop/window-config.ts";
import { openWindowStore } from "../src/desktop/window-store.ts";
import { injectDesktopGlobal } from "../src/build/desktop.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { DesktopWindowSettings } from "../src/desktop/window-config.ts";
import type { DesktopWindowMenuSettings } from "../src/desktop/menu-config.ts";

/** A runtime window that records what it was created with and what was called on it. */
class FakeWin extends EventTarget implements RegistryWindow {
  static made: FakeWin[] = [];
  menus: DesktopMenuItem[][] = [];
  calls: string[] = [];
  visible = true;
  constructor(readonly options?: Record<string, unknown>) {
    super();
    FakeWin.made.push(this);
  }
  bind() {}
  navigate(url: string) {
    this.calls.push(`navigate:${url}`);
  }
  show() {
    this.visible = true;
    this.calls.push("show");
  }
  hide() {
    this.visible = false;
    this.calls.push("hide");
  }
  focus() {
    this.calls.push("focus");
  }
  close() {}
  isVisible() {
    return this.visible;
  }
  getBounds() {
    return { x: 0, y: 0, width: 800, height: 600 };
  }
  getSize(): [number, number] {
    return [800, 600];
  }
  setSize(width: number, height: number) {
    this.calls.push(`setSize:${width}x${height}`);
  }
  setBounds(bounds: Record<string, number>) {
    this.calls.push(`setBounds:${JSON.stringify(bounds)}`);
  }
  setTitle(title: string) {
    this.calls.push(`title:${title}`);
  }
  setTitleBarStyle(style: string): boolean {
    this.calls.push(`titleBar:${style}`);
    return true;
  }
  setWindowButtonPosition(position: { x: number; y: number } | null): boolean {
    this.calls.push(`buttons:${JSON.stringify(position)}`);
    return true;
  }
  setApplicationMenu(menu: DesktopMenuItem[]) {
    this.menus.push(menu);
  }
  click(id: string) {
    this.dispatchEvent(new CustomEvent("menuclick", { detail: { id } }));
  }
  userClose(): boolean {
    const event = new Event("close", { cancelable: true });
    this.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

/** A fake `Deno.dock`: an event target with the methods the app controller probes. */
class Dock extends EventTarget {
  setBadge() {}
  bounce() {}
  /** The Dock icon was clicked. */
  reopen(hasVisibleWindows: boolean) {
    this.dispatchEvent(new CustomEvent("reopen", { detail: { hasVisibleWindows } }));
  }
}

const api = () =>
  Object.assign(new EventTarget(), { quitOnLastWindowClosed: true, screens: () => [] }) as
    & DesktopAppApi
    & EventTarget;

/** A desktop setup over a fake main window, wired as runDesktop wires it. */
function setup(
  options: {
    windowSettings?: DesktopWindowSettings;
    menu?: DesktopWindowMenuSettings;
    onDockReopen?: DesktopDockReopenHandler;
    onSecondInstance?: DesktopSecondInstanceHandler;
    appSupportDir?: string;
    os?: string;
  } = {},
) {
  FakeWin.made = [];
  const main = new FakeWin();
  const dock = new Dock();
  const desktop = api();
  const warnings: string[] = [];
  const s = setUpDesktopWindows({
    window: main,
    BrowserWindow: FakeWin,
    api: desktop,
    dock: dock as never,
    emit: () => {},
    wantsTray: false,
    os: options.os ?? "darwin",
    exit: () => {},
    warn: (m) => void warnings.push(m),
    appSettings: { keepAlive: true },
    // The fake window delivers the menu's clicks: a runtime before `Deno.desktop`'s app-level
    // "menuclick", whatever runtime runs the test.
    runtimeVersion: "3.0.0-denext.13",
    ...(options.windowSettings ? { windowSettings: options.windowSettings } : {}),
    ...(options.menu ? { menuSettings: { window: options.menu } } : {}),
    ...(options.onDockReopen ? { onDockReopen: options.onDockReopen } : {}),
    ...(options.onSecondInstance ? { onSecondInstance: options.onSecondInstance } : {}),
    ...(options.appSupportDir !== undefined ? { appSupportDir: options.appSupportDir } : {}),
  });
  main.addEventListener("close", (e) => {
    if (s.interceptMainClose(e)) return;
    s.mainClosed();
  });
  s.install();
  return { s, main, dock, desktop, warnings };
}

/** A later launch forwarded by the single-instance lock, as the pinned runtime dispatches it. */
function secondLaunch(desktop: EventTarget, args: string[], cwd = "/home/u") {
  desktop.dispatchEvent(
    new CustomEvent("secondinstance", { detail: { args, cwd, urls: [], files: [] } }),
  );
}

/** Hide every window (as a kept-alive app with no window showing). */
function hideAll() {
  for (const w of FakeWin.made) w.visible = false;
}

/** The "Window" submenu of the last application menu set on `win`. */
function windowSubmenu(win: FakeWin): DesktopMenuItem[] {
  const menu = win.menus.at(-1) ?? [];
  const sub = menu.find((e) => typeof e === "object" && "submenu" in e) as
    | { submenu: { label: string; items: DesktopMenuItem[] } }
    | undefined;
  return sub?.submenu.items ?? [];
}

/** A readable form of a menu entry (a submenu with its items). */
function brief(entry: DesktopMenuItem): string {
  if (entry === "separator") return "---";
  if ("role" in entry) return `role:${entry.role.role}`;
  if ("submenu" in entry) {
    return `submenu:${entry.submenu.label}{${entry.submenu.items.map(brief).join(", ")}}`;
  }
  const i = entry.item;
  return `${i.id}:${i.label}${i.accelerator ? `[${i.accelerator}]` : ""}${
    i.enabled ? "" : "(off)"
  }`;
}

const ctx = (windowId = "main") => ({ windowId } as DesktopCapCtx);

// ---------------------------------------------------------------------------------------------
// A1: the Dock's reopen click
// ---------------------------------------------------------------------------------------------

Deno.test("dock reopen: with no window showing it reopens the most recently closed keyed window", () => {
  const { s, main, dock } = setup();
  s.windows.open({ url: "/a", key: "a" });
  s.windows.open({ url: "/b", key: "b" });
  assert(FakeWin.made[1].userClose());
  assert(FakeWin.made[2].userClose());
  hideAll();
  dock.reopen(false);
  assertEquals(s.windows.byKey("b")?.kind, "window", "the most recent first");
  assertEquals(FakeWin.made.at(-1)!.calls.includes("navigate:/b"), true);
  assert(!main.calls.includes("show"), "the main window stays hidden");
  // Again: the next one back; then nothing keyed is left, so the main window shows (as before).
  hideAll();
  dock.reopen(false);
  assertEquals(s.windows.byKey("a")?.kind, "window");
  hideAll();
  dock.reopen(false);
  assertEquals(main.calls.slice(-2), ["show", "focus"]);
});

Deno.test("dock reopen: with a window showing nothing opens; the click is left as before", () => {
  const { s, main, dock } = setup();
  s.windows.open({ url: "/a", key: "a" });
  assert(FakeWin.made[1].userClose());
  dock.reopen(true);
  assertEquals(s.windows.byKey("a"), undefined);
  assertEquals(main.calls.filter((c) => c === "show"), []);
});

Deno.test("dock reopen: runDesktop({ onDockReopen }) picks the window, or nothing with undefined", () => {
  const seen: unknown[] = [];
  let answer: { url: string; key: string } | undefined = { url: "/picked", key: "picked" };
  const { s, main, dock } = setup({
    onDockReopen: (ctx) => {
      seen.push(ctx.closed);
      return answer;
    },
  });
  s.windows.open({ url: "/a", key: "a", title: "Alpha" });
  assert(FakeWin.made[1].userClose());
  hideAll();
  dock.reopen(false);
  assertEquals(seen, [[{ key: "a", url: "/a", title: "Alpha" }]]);
  assertEquals(s.windows.byKey("picked")?.kind, "window");
  assertEquals(s.windows.byKey("a"), undefined, "the handler's window, not the default");
  // `undefined`: nothing at all, not even the main window.
  answer = undefined;
  hideAll();
  dock.reopen(false);
  assertEquals(main.calls.filter((c) => c === "show"), []);
  // A refused window (a key already open) is a warning, never a throw.
  answer = { url: "/x", key: "picked" };
  const { dock: d2, s: s2, warnings } = setup({ onDockReopen: () => ({ url: "/", key: "dup" }) });
  s2.windows.open({ url: "/", key: "dup" });
  hideAll();
  d2.reopen(false);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "Dock");
});

Deno.test("dock reopen: DesktopRuntime.onDockReopen hears every click until unsubscribed", () => {
  const { s, dock } = setup();
  const heard: boolean[] = [];
  const off = s.onDockReopen((e) => void heard.push(e.hasVisibleWindows));
  dock.reopen(true);
  dock.reopen(false);
  off();
  dock.reopen(false);
  assertEquals(heard, [true, false]);
  // No Dock (Windows, Linux, a sidecar's child): a no-op unsubscribe.
  FakeWin.made = [];
  const plain = setUpDesktopWindows({
    window: new FakeWin(),
    BrowserWindow: FakeWin,
    emit: () => {},
    wantsTray: false,
    os: "linux",
    exit: () => {},
  });
  plain.onDockReopen(() => {})();
  noDesktopWindows().onDockReopen(() => {})();
  assertEquals(noDesktopWindows().windows.forget("x"), undefined);
});

// ---------------------------------------------------------------------------------------------
// A1b: a second launch (`desktop.app.singleInstance`)
// ---------------------------------------------------------------------------------------------

Deno.test("second instance: no handler and no window showing reopens as the Dock does", () => {
  const { s, main, desktop } = setup();
  s.windows.open({ url: "/a", key: "a" });
  assert(FakeWin.made[1].userClose());
  hideAll();
  secondLaunch(desktop, ["--x"]);
  assertEquals(s.windows.byKey("a")?.kind, "window", "the most recently closed keyed window");
  assert(!main.calls.includes("show"));
  // Nothing keyed left: the main window shows again.
  hideAll();
  secondLaunch(desktop, []);
  assertEquals(main.calls.slice(-2), ["show", "focus"]);
});

Deno.test("second instance: no handler with a window showing opens nothing more", () => {
  const { s, main, desktop } = setup();
  s.windows.open({ url: "/a", key: "a" });
  assert(FakeWin.made[1].userClose());
  const before = FakeWin.made.length;
  secondLaunch(desktop, ["--x"]);
  assertEquals(FakeWin.made.length, before);
  assertEquals(s.windows.byKey("a"), undefined);
  assertEquals(main.calls.filter((c) => c === "show"), []);
});

Deno.test("second instance: runDesktop({ onSecondInstance }) gets args and cwd on every launch", () => {
  const seen: DesktopSecondInstanceEvent[] = [];
  let answer: { url: string; key: string } | undefined = undefined;
  const { s, main, desktop, warnings } = setup({
    onSecondInstance: (event) => {
      seen.push(event);
      return answer;
    },
  });
  // A window showing: still called; `undefined` opens nothing.
  secondLaunch(desktop, ["--open", "/tmp/a.txt"], "/work");
  assertEquals(seen, [{ args: ["--open", "/tmp/a.txt"], cwd: "/work" }]);
  // No window showing and `undefined`: nothing, not even the main window (the handler decided).
  hideAll();
  secondLaunch(desktop, []);
  assertEquals(main.calls.filter((c) => c === "show"), []);
  // Its options open a window.
  answer = { url: "/doc", key: "doc" };
  secondLaunch(desktop, ["doc"]);
  assertEquals(s.windows.byKey("doc")?.kind, "window");
  // A refused window (the key is open already) and a throwing handler are warnings.
  secondLaunch(desktop, ["doc"]);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "second launch");
  const thrower = setup({
    onSecondInstance: () => {
      throw new Error("boom");
    },
  });
  secondLaunch(thrower.desktop, []);
  assertStringIncludes(thrower.warnings[0], "boom");
  // A malformed detail is read as no arguments and no directory.
  seen.length = 0;
  answer = undefined;
  desktop.dispatchEvent(new CustomEvent("secondinstance", { detail: { args: "x", cwd: 1 } }));
  desktop.dispatchEvent(new CustomEvent("secondinstance", { detail: { args: [1, "y"] } }));
  assertEquals(seen, [{ args: [], cwd: "" }, { args: ["y"], cwd: "" }]);
});

Deno.test("second instance: subscribers hear every launch until unsubscribed; a throw is a warning", async () => {
  const { s, desktop, warnings } = setup();
  const heard: DesktopSecondInstanceEvent[] = [];
  const off = s.onSecondInstance((e) => void heard.push(e));
  s.onSecondInstance(() => {
    throw new Error("thrown");
  });
  s.onSecondInstance(() => Promise.reject(new Error("rejected")));
  secondLaunch(desktop, ["--a"], "/one");
  off();
  secondLaunch(desktop, ["--b"], "/two");
  assertEquals(heard, [{ args: ["--a"], cwd: "/one" }]);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(warnings.filter((w) => w.includes("thrown")).length, 2);
  assertEquals(warnings.filter((w) => w.includes("rejected")).length, 2);
});

Deno.test("second instance: without the pinned runtime's Deno.desktop it is a no-op", () => {
  FakeWin.made = [];
  const plain = setUpDesktopWindows({
    window: new FakeWin(),
    BrowserWindow: FakeWin,
    emit: () => {},
    wantsTray: false,
    os: "linux",
    exit: () => {},
    onSecondInstance: () => {
      throw new Error("never called");
    },
  });
  plain.install();
  plain.onSecondInstance(() => {})();
  // An API without addEventListener (an older runtime): installs without a throw.
  const old = setUpDesktopWindows({
    window: new FakeWin(),
    BrowserWindow: FakeWin,
    api: {} as DesktopAppApi,
    emit: () => {},
    wantsTray: false,
    os: "linux",
    exit: () => {},
  });
  old.install();
  old.onSecondInstance(() => {})();
});

// ---------------------------------------------------------------------------------------------
// A2: the title bar style of opened windows
// ---------------------------------------------------------------------------------------------

Deno.test("titleBar: opened windows take desktop.titleBar; a window's own titleBar wins", () => {
  const { s, main } = setup({ windowSettings: { titleBar: "hiddenInset" } });
  assert(main.calls.includes("titleBar:hiddenInset"), "the main window, as before");
  s.windows.open({ url: "/a" });
  assertEquals(FakeWin.made[1].calls.filter((c) => c.startsWith("titleBar")), [
    "titleBar:hiddenInset",
  ]);
  s.windows.open({ url: "/b", titleBar: "hidden" });
  assertEquals(FakeWin.made[2].calls.filter((c) => c.startsWith("titleBar")), ["titleBar:hidden"]);
  // "default" keeps the OS's title bar (nothing to set); a frameless window has none to style.
  s.windows.open({ url: "/c", titleBar: "default" });
  s.windows.open({ url: "/d", frameless: true });
  assertEquals(FakeWin.made[3].calls.filter((c) => c.startsWith("titleBar")), []);
  assertEquals(FakeWin.made[4].calls.filter((c) => c.startsWith("titleBar")), []);
  // A page's openWindow({ titleBar }) is checked like the other options.
  assertEquals(openWindowSettings({ url: "/", titleBar: "hidden" }).titleBar, "hidden");
  assertThrows(() => openWindowSettings({ url: "/", titleBar: "shiny" }), Error, "titleBar");
  // No desktop.titleBar: an opened window is left alone.
  const plain = setup();
  plain.s.windows.open({ url: "/a" });
  assertEquals(FakeWin.made[1].calls.filter((c) => c.startsWith("titleBar")), []);
});

Deno.test("titleBar: a runtime without setTitleBarStyle is a warning, never a throw", () => {
  class Bare extends FakeWin {
    override setTitleBarStyle = undefined as never;
  }
  FakeWin.made = [];
  const warnings: string[] = [];
  const s = setUpDesktopWindows({
    window: new FakeWin(),
    BrowserWindow: Bare,
    emit: () => {},
    wantsTray: false,
    os: "darwin",
    exit: () => {},
    warn: (m) => void warnings.push(m),
    windowSettings: { titleBar: "hidden" },
  });
  s.windows.open({ url: "/a" });
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "titleBar");
});

// ---------------------------------------------------------------------------------------------
// A3: defaultWidth / defaultHeight
// ---------------------------------------------------------------------------------------------

Deno.test("default size: used only when the key has no saved frame; explicit sizes win", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-window-defaults-" });
  try {
    await Deno.writeTextFile(
      join(dir, "windows.json"),
      JSON.stringify({ version: 1, bounds: { saved: { x: 10, y: 20, width: 640, height: 480 } } }),
    );
    const { s } = setup({ appSupportDir: dir });
    const opts = (i: number) => FakeWin.made[i].options ?? {};
    s.windows.open({ url: "/", key: "fresh", defaultWidth: 1000, defaultHeight: 700 });
    assertEquals([opts(1).width, opts(1).height], [1000, 700], "no saved frame: the default");
    s.windows.open({ url: "/", key: "saved", defaultWidth: 1000, defaultHeight: 700 });
    assertEquals([opts(2).width, opts(2).height], [640, 480], "the saved frame beats the default");
    s.windows.open({ url: "/", key: "x", width: 300, defaultWidth: 1000, defaultHeight: 700 });
    assertEquals([opts(3).width, opts(3).height], [300, 700], "an explicit size beats both");
    s.windows.open({ url: "/", defaultWidth: 500 });
    assertEquals(opts(4).width, 500, "no key: the default");
    s.windows.byKey("saved")!.close();
    s.windows.open({ url: "/", key: "saved", restoreBounds: false, defaultWidth: 900 });
    assertEquals(opts(5).width, 900, "restoreBounds: false skips the saved frame");
    assertThrows(() => openWindowSettings({ url: "/", defaultWidth: 0 }), Error, "defaultWidth");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("default size: desktop.window.defaultWidth / defaultHeight for the main window", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-window-defaults-main-" });
  try {
    const first = setup({
      appSupportDir: dir,
      windowSettings: { key: "main-ws", defaultWidth: 1100, defaultHeight: 750 },
    });
    assert(first.main.calls.includes("setSize:1100x750"), "no saved frame: the default");
    await Deno.writeTextFile(
      join(dir, "windows.json"),
      JSON.stringify({
        version: 1,
        bounds: { "main-ws": { x: 1, y: 2, width: 640, height: 480 } },
      }),
    );
    const again = setup({
      appSupportDir: dir,
      windowSettings: { key: "main-ws", defaultWidth: 1100, defaultHeight: 750 },
    });
    assert(!again.main.calls.some((c) => c.startsWith("setSize")), "the saved frame instead");
    assert(again.main.calls.some((c) => c.startsWith("setBounds") && c.includes('"width":640')));
    // An explicit width keeps its meaning (over the saved one too).
    const explicit = setup({
      appSupportDir: dir,
      windowSettings: { key: "main-ws", width: 1300, defaultWidth: 1100 },
    });
    assert(explicit.main.calls.includes("setSize:1300x600"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  // Resolved and checked from the config.
  assertEquals(
    resolveDesktopWindowSettings({ window: { defaultWidth: 900.4, defaultHeight: 600 } }),
    { defaultWidth: 900, defaultHeight: 600 },
  );
  assertThrows(
    () => resolveDesktopWindowSettings({ window: { defaultHeight: -1 } }),
    Error,
    "window.defaultHeight",
  );
  assertThrows(
    () => validateDenextConfig({ desktop: { window: { defaultWidth: "big" } } } as never),
    Error,
    "desktop.window.defaultWidth",
  );
});

// ---------------------------------------------------------------------------------------------
// A4: reopenClosed: "list", windows.forget, the page titles
// ---------------------------------------------------------------------------------------------

Deno.test('menu: reopenClosed: "list" lists the closed windows by title, each reopening its key', () => {
  const { s, main } = setup({ menu: { reopenClosed: "list" }, os: "linux" });
  assertEquals(windowSubmenu(main).map(brief), [
    "denext:window:reopen:Reopen Closed Window[CommandOrControl+Shift+T](off)",
  ]);
  s.windows.open({ url: "/a", key: "a", title: "Alpha" });
  s.windows.open({ url: "/b", key: "b" });
  assert(FakeWin.made[1].userClose());
  assert(FakeWin.made[2].userClose());
  assertEquals(windowSubmenu(main).map(brief), [
    "submenu:Reopen Closed Window{denext:window:reopen:b:b[CommandOrControl+Shift+T], " +
    "denext:window:reopen:a:Alpha}",
  ]);
  main.click("denext:window:reopen:a");
  assertEquals(s.windows.byKey("a")?.kind, "window");
  assertEquals(windowSubmenu(main).map(brief), [
    "submenu:Reopen Closed Window{denext:window:reopen:b:b[CommandOrControl+Shift+T]}",
  ]);
  // The accelerator's item and the plain reopen id still reopen the most recent.
  main.click("denext:window:reopen");
  assertEquals(s.windows.byKey("b")?.kind, "window");
  // Bounded: at most 10 listed.
  for (let i = 0; i < 12; i++) {
    s.windows.open({ url: "/", key: `k${i}` });
    assert(FakeWin.made.at(-1)!.userClose());
  }
  const sub = windowSubmenu(main)[0] as { submenu: { items: DesktopMenuItem[] } };
  assertEquals(sub.submenu.items.length, 10);
  assertEquals(
    brief(sub.submenu.items[0]),
    "denext:window:reopen:k11:k11[CommandOrControl+Shift+T]",
  );
});

Deno.test("windows.forget drops a key from the reopen stack, the menu and lastSession", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-window-forget-" });
  try {
    await Deno.writeTextFile(
      join(dir, "windows.json"),
      JSON.stringify({
        version: 1,
        bounds: {},
        session: [{ key: "old", url: "/old" }, { key: "keep", url: "/keep" }],
      }),
    );
    const { s, main, dock } = setup({
      appSupportDir: dir,
      menu: { reopenClosed: "list" },
      os: "linux",
    });
    assertEquals(s.windows.lastSession().map((w) => w.key), ["old", "keep"]);
    // Persisted at once: the next launch's lastSession has it gone too (until this launch
    // writes its own session).
    s.windows.forget("old");
    assertEquals(
      openWindowStore(dir, { warn: () => {} }).lastSession().map((w) => w.key),
      ["keep"],
    );
    s.windows.open({ url: "/a", key: "a" });
    assert(FakeWin.made[1].userClose());
    s.windows.forget("a");
    s.windows.forget("old");
    s.windows.forget("never-seen"); // nothing to forget: no-op
    assertEquals(s.windows.lastSession().map((w) => w.key), ["keep"]);
    assertEquals(windowSubmenu(main).map(brief), [
      "denext:window:reopen:Reopen Closed Window[CommandOrControl+Shift+T](off)",
    ]);
    hideAll();
    dock.reopen(false);
    assertEquals(s.windows.byKey("a"), undefined, "forgotten: the Dock does not bring it back");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("titles: a page's document.title and setTitle name its window in the menus", async () => {
  const { s, main } = setup({ menu: { reopenClosed: "list", list: true }, os: "linux" });
  const w = s.windows.open({ url: "/a", key: "a" });
  const router = s.registry!.router;
  await router.methods.pageTitle.handler({ title: "Report.txt" }, ctx(w.id));
  assert(windowSubmenu(main).map(brief).includes(`denext:window:focus:${w.id}:Report.txt`));
  await router.methods.setTitle.handler({ title: "Renamed" }, ctx(w.id));
  assert(windowSubmenu(main).map(brief).includes(`denext:window:focus:${w.id}:Renamed`));
  assertEquals(s.registry!.get(w.id)?.title, "Renamed");
  // An empty or oversized title is refused (the label stays).
  await assertRejectsLike(() => router.methods.pageTitle.handler({ title: 3 }, ctx(w.id)));
  await router.methods.pageTitle.handler({ title: "" }, ctx(w.id));
  assertEquals(s.registry!.get(w.id)?.title, "Renamed");
  // Closed: listed by its last title.
  assert(FakeWin.made[1].userClose());
  assertEquals(
    brief(windowSubmenu(main)[0]),
    "submenu:Reopen Closed Window{denext:window:reopen:a:Renamed[CommandOrControl+Shift+T]}",
  );
  // The page reports its title through an injected script, only with the window binding.
  const html = "<html><head></head><body></body></html>";
  const bound = await injectDesktopGlobal(html, "tok", false, undefined, undefined, {
    windows: true,
  });
  assertStringIncludes(bound, '"pageTitle"');
  assert(!(await injectDesktopGlobal(html, "tok")).includes("pageTitle"));
  assert(
    !(await injectDesktopGlobal(html, null, false, undefined, undefined, { windows: true }))
      .includes("pageTitle"),
  );
});

/** `fn` throws or rejects. */
async function assertRejectsLike(fn: () => unknown): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, "expected a throw");
}

Deno.test('menu config: reopenClosed takes true / false / "list"', () => {
  assertEquals(desktopMenuProblem({ window: { reopenClosed: "list" } }), null);
  assertEquals(
    desktopMenuProblem({ window: { reopenClosed: "all" } })?.[0],
    "menu.window.reopenClosed",
  );
  assertEquals(resolveDesktopMenuSettings({ menu: { window: { reopenClosed: "list" } } }), {
    window: { reopenClosed: "list" },
  });
  validateDenextConfig({ desktop: { menu: { window: { reopenClosed: "list" } } } } as DenextConfig);
  assertThrows(
    () =>
      validateDenextConfig(
        { desktop: { menu: { window: { reopenClosed: "yes" } } } } as unknown as DenextConfig,
      ),
    Error,
    "desktop.menu.window.reopenClosed",
  );
});

// ---------------------------------------------------------------------------------------------
// desktop.window.windowButtonPosition
// ---------------------------------------------------------------------------------------------

/** The traffic-light moves recorded on `win`. */
const buttonCalls = (win: FakeWin) => win.calls.filter((c) => c.startsWith("buttons"));

Deno.test("windowButtonPosition: the main window and opened windows take it; a window's own wins", () => {
  const { s, main } = setup({
    windowSettings: { titleBar: "hidden", windowButtonPosition: { x: 14, y: 20 } },
  });
  // After the title bar style (a style change puts the buttons back).
  const i = main.calls.indexOf("titleBar:hidden");
  assert(i >= 0 && main.calls.indexOf('buttons:{"x":14,"y":20}') > i, main.calls.join(" "));
  s.windows.open({ url: "/a" });
  assertEquals(buttonCalls(FakeWin.made[1]), ['buttons:{"x":14,"y":20}']);
  s.windows.open({ url: "/b", windowButtonPosition: { x: 8.6, y: 30 } });
  assertEquals(buttonCalls(FakeWin.made[2]), ['buttons:{"x":9,"y":30}']);
  // null keeps the OS's place; a frameless window has no buttons.
  s.windows.open({ url: "/c", windowButtonPosition: null });
  s.windows.open({ url: "/d", frameless: true });
  assertEquals(buttonCalls(FakeWin.made[3]), []);
  assertEquals(buttonCalls(FakeWin.made[4]), []);
  // Unset: nothing is moved.
  const plain = setup({ windowSettings: { titleBar: "hidden" } });
  plain.s.windows.open({ url: "/a" });
  assertEquals(buttonCalls(plain.main), []);
  assertEquals(buttonCalls(FakeWin.made[1]), []);
});

Deno.test("windowButtonPosition: a frameless main window is left alone; the stock runtime warns", () => {
  const frameless = new FakeWin();
  applyDesktopWindowSettings(frameless, { frameless: true, windowButtonPosition: { x: 1, y: 1 } });
  assertEquals(buttonCalls(frameless), []);
  const warnings: string[] = [];
  const bare = { setTitle() {} };
  applyDesktopWindowSettings(bare, { windowButtonPosition: { x: 1, y: 1 } }, (m) => {
    warnings.push(m);
  });
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "desktop.window.windowButtonPosition");
});

Deno.test("windowButtonPosition: checked in the config, at launch and in a page's openWindow", () => {
  assertEquals(windowButtonPositionProblem({ x: 0, y: 12 }), null);
  assertEquals(windowButtonPositionProblem([1, 2]), "must be { x, y }");
  assertStringIncludes(windowButtonPositionProblem({ x: -1, y: 0 }) ?? "", "x must be");
  assertStringIncludes(windowButtonPositionProblem({ x: 1, y: Infinity }) ?? "", "y must be");
  assertStringIncludes(windowButtonPositionProblem({ x: 1 }) ?? "", "y must be");
  assertEquals(
    resolveDesktopWindowSettings({ window: { windowButtonPosition: { x: 12.4, y: 18 } } })
      .windowButtonPosition,
    { x: 12, y: 18 },
  );
  assertThrows(
    () => resolveDesktopWindowSettings({ window: { windowButtonPosition: { x: "1", y: 0 } } }),
    Error,
    "desktop.window.windowButtonPosition",
  );
  validateDenextConfig({ desktop: { window: { windowButtonPosition: { x: 1, y: 2 } } } });
  assertThrows(
    () =>
      validateDenextConfig(
        { desktop: { window: { windowButtonPosition: { x: 1 } } } } as unknown as DenextConfig,
      ),
    Error,
    "desktop.window.windowButtonPosition",
  );
  assertEquals(
    openWindowSettings({ url: "/", windowButtonPosition: { x: 3, y: 4 } }).windowButtonPosition,
    { x: 3, y: 4 },
  );
  assertEquals(
    openWindowSettings({ url: "/", windowButtonPosition: null }).windowButtonPosition,
    null,
  );
  assertThrows(
    () => openWindowSettings({ url: "/", windowButtonPosition: { x: -5, y: 0 } }),
    Error,
    "windowButtonPosition",
  );
});
