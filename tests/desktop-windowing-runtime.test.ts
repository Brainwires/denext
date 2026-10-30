// The desktop windowing runtime: the window registry (the main window, the tray panel and the
// windows pages open, each with its own window token and `window` controller), the overlay methods
// of the `window` capability, the `app` capability's per-window click queues and backend tray, the
// backend tray with its panel, `setUpDesktopWindows` (keepAlive, the Dock, the close rules) and
// the `textToSpeech` capability — all against fake runtime windows, trays and docks.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { DesktopCapability, DesktopCapCtx } from "../src/desktop/extension.ts";
import type { DesktopAppApi, DesktopMenuItem } from "../src/desktop/launch-events.ts";
import { createWindowController } from "../src/desktop/caps/window.ts";
import {
  BACKEND_TRAY_ID,
  createAppController,
  type DockLike,
  type TrayLike,
} from "../src/desktop/caps/app.ts";
import {
  createWindowRegistry,
  MAX_OPEN_WINDOWS,
  openWindowSettings,
  type RegistryWindow,
  WINDOW_BINDING,
} from "../src/desktop/window-registry.ts";
import { startBackendTray } from "../src/desktop/backend-tray.ts";
import { noDesktopWindows, setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import { createSpeechCapability } from "../src/desktop/caps/speech.ts";
import { menuWire } from "../src/desktop/menu-wire.ts";

/** A handler context for window `windowId`. */
const ctxFor = (windowId = "main"): DesktopCapCtx => ({
  emit: () => {},
  appSupportDir: "/tmp/app",
  runOnMainThread: () => Promise.reject(new Error("no UI thread")),
  os: "darwin",
  windowId,
  signal: new AbortController().signal,
});

/** Call `cap.method(args)` as window `windowId`. */
async function call(
  cap: DesktopCapability,
  method: string,
  args: unknown = {},
  windowId = "main",
): Promise<unknown> {
  return await cap.methods[method].handler(args, ctxFor(windowId));
}

/** The error code a promise rejects with. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return String((err as { code?: unknown }).code);
  }
  throw new Error("expected a rejection");
}

/** A runtime window recording every call (`bind` included). */
class FakeWin extends EventTarget implements RegistryWindow {
  static made: FakeWin[] = [];
  calls: string[] = [];
  bindings = new Map<string, () => unknown>();
  visible = true;
  constructor(readonly options?: Record<string, unknown>) {
    super();
    FakeWin.made.push(this);
  }
  #rec(name: string, args: unknown[]) {
    this.calls.push(`${name}${args.length ? JSON.stringify(args) : ""}`);
  }
  bind(name: string, fn: () => unknown) {
    this.bindings.set(name, fn);
  }
  navigate(url: string) {
    this.#rec("navigate", [url]);
  }
  show() {
    this.visible = true;
    this.#rec("show", []);
  }
  hide() {
    this.visible = false;
    this.#rec("hide", []);
  }
  focus() {
    this.#rec("focus", []);
  }
  close() {
    this.#rec("close", []);
  }
  isVisible() {
    return this.visible;
  }
  setBounds(b: Record<string, number>) {
    this.#rec("setBounds", [b]);
  }
  getBounds() {
    return { x: 1, y: 2, width: 300, height: 200 };
  }
  setAlwaysOnTop(...args: unknown[]) {
    this.#rec("setAlwaysOnTop", args);
  }
  setOpacity(o: number) {
    this.#rec("setOpacity", [o]);
  }
  setIgnoreMouseEvents(...args: unknown[]) {
    this.#rec("setIgnoreMouseEvents", args);
  }
  setHitRegion(rects: unknown) {
    this.#rec("setHitRegion", [rects]);
  }
  setVisibleOnAllWorkspaces(...args: unknown[]) {
    this.#rec("setVisibleOnAllWorkspaces", args);
  }
  setSkipTaskbar(skip: boolean) {
    this.#rec("setSkipTaskbar", [skip]);
  }
}

/** A window with only the basics (no overlay setters, no bindings). */
class PlainWin extends EventTarget {
  show() {}
}

// --- the window capability's overlay methods -------------------------------------------------

Deno.test("window: opacity, levels, hit region, workspaces and taskbar reach the window", async () => {
  const win = new FakeWin();
  const cap = createWindowController({ window: win, emit: () => {} }).capability;
  await call(cap, "setOpacity", { opacity: 0.25 });
  await call(cap, "setAlwaysOnTop", { alwaysOnTop: true, level: "status" });
  await call(cap, "setAlwaysOnTop", { alwaysOnTop: true, level: "floating" });
  await call(cap, "setAlwaysOnTop", { alwaysOnTop: false, level: "status" });
  await call(cap, "setHitRegion", { rects: [{ x: 1.4, y: 2, width: 30, height: 40 }] });
  await call(cap, "setHitRegion", { rects: null });
  await call(cap, "setVisibleOnAllWorkspaces", { visible: true, visibleOnFullScreen: true });
  await call(cap, "setVisibleOnAllWorkspaces", { visible: false });
  await call(cap, "setSkipTaskbar", { skip: true });
  assertEquals(win.calls, [
    "setOpacity[0.25]",
    'setAlwaysOnTop[true,"status"]',
    "setAlwaysOnTop[true]",
    "setAlwaysOnTop[false]",
    'setHitRegion[[{"x":1,"y":2,"width":30,"height":40}]]',
    "setHitRegion[null]",
    'setVisibleOnAllWorkspaces[true,{"visibleOnFullScreen":true}]',
    'setVisibleOnAllWorkspaces[false,{"visibleOnFullScreen":false}]',
    "setSkipTaskbar[true]",
  ]);
  for (
    const [method, args] of [
      ["setOpacity", { opacity: 1.5 }],
      ["setAlwaysOnTop", { alwaysOnTop: true, level: "top" }],
      ["setHitRegion", { rects: "all" }],
      ["setHitRegion", { rects: Array(65).fill({ x: 0, y: 0, width: 1, height: 1 }) }],
      ["setVisibleOnAllWorkspaces", { visible: true, visibleOnFullScreen: 1 }],
      ["setSkipTaskbar", { skip: "yes" }],
    ] as const
  ) {
    assertEquals(await codeOf(call(cap, method, args)), "validation", method);
  }
});

Deno.test("window: click-through needs forward or a way back; a runtime without it is unsupported", async () => {
  const win = new FakeWin();
  let tray = false;
  const cap = createWindowController({ window: win, emit: () => {}, wayBack: () => tray })
    .capability;
  assertEquals(
    await codeOf(call(cap, "setIgnoreMouseEvents", { ignore: true })),
    "validation",
    "no forward and no tray: the window could never be clicked again",
  );
  await call(cap, "setIgnoreMouseEvents", { ignore: true, forward: true });
  tray = true;
  await call(cap, "setIgnoreMouseEvents", { ignore: true });
  await call(cap, "setIgnoreMouseEvents", { ignore: false });
  assertEquals(win.calls, [
    'setIgnoreMouseEvents[true,{"forward":true}]',
    'setIgnoreMouseEvents[true,{"forward":false}]',
    'setIgnoreMouseEvents[false,{"forward":false}]',
  ]);
  const plain = createWindowController({ window: new PlainWin(), emit: () => {} }).capability;
  for (const method of ["setIgnoreMouseEvents", "setHitRegion", "setSkipTaskbar"]) {
    const args = { ignore: false, rects: null, skip: true };
    assertEquals(await codeOf(call(plain, method, args)), "unsupported", method);
  }
});

Deno.test("window: capabilities report the overlay features the window has", async () => {
  const full = createWindowController({ window: new FakeWin(), emit: () => {} }).capability;
  const caps = await call(full, "capabilities") as Record<string, unknown>;
  for (
    const key of ["clickThrough", "hitRegion", "visibleOnAllWorkspaces", "skipTaskbar", "opacity"]
  ) {
    assertEquals(caps[key], true, key);
  }
  assertEquals(caps.nonActivating, true);
  assertEquals(caps.focusEvents, true);
  assertEquals(caps.clickThroughForward, false);
  assertEquals(caps.transparent, Deno.build.os !== "windows");
  const plain = createWindowController({ window: new PlainWin(), emit: () => {} }).capability;
  const few = await call(plain, "capabilities") as Record<string, unknown>;
  assertEquals([few.clickThrough, few.hitRegion, few.skipTaskbar], [false, false, false]);
});

Deno.test("window: focus and blur become events; close with a closed hook does not exit", async () => {
  const win = new FakeWin();
  const emitted: string[] = [];
  const exits: number[] = [];
  let closed = 0;
  const ctl = createWindowController({
    window: win,
    emit: (cap, event) => void emitted.push(`${cap}:${event}`),
    exit: (code) => void exits.push(code),
    closed: () => void closed++,
  });
  ctl.install();
  win.dispatchEvent(new Event("focus"));
  win.dispatchEvent(new Event("blur"));
  assertEquals(emitted, ["window:focus", "window:blur"]);
  await call(ctl.capability, "close");
  await new Promise((r) => setTimeout(r, 5));
  assertEquals([closed, exits.length], [1, 0]);
  assert(win.calls.includes("close"));
});

// --- the window registry ----------------------------------------------------------------------

/** A registry over a fake main window. */
function registry(
  opts: { keepAlive?: boolean; BrowserWindow?: unknown; tokens?: string[] } = {},
) {
  FakeWin.made = [];
  const emitted: Array<[string, string, unknown, string | undefined]> = [];
  const exits: number[] = [];
  const closedIds: string[] = [];
  const tokens = [...(opts.tokens ?? [])];
  let n = 0;
  const reg = createWindowRegistry({
    ...(opts.BrowserWindow === undefined
      ? { BrowserWindow: FakeWin }
      : opts.BrowserWindow === null
      ? {}
      : { BrowserWindow: opts.BrowserWindow as typeof FakeWin }),
    appUrl: (path) => `app://localhost${path}`,
    emit: (cap, event, data, target) => void emitted.push([cap, event, data, target]),
    keepAlive: () => opts.keepAlive === true,
    onClosed: (id) => void closedIds.push(id),
    exit: (code) => void exits.push(code),
    newToken: () => tokens.shift() ?? `token-${++n}`,
    controller: (window, id, closed) =>
      createWindowController({
        window,
        emit: (cap, event, data) => void emitted.push([cap, event, data, id]),
        closed,
      }),
  });
  const main = new FakeWin();
  reg.adopt(main, "main");
  return { reg, main, emitted, exits, closedIds };
}

Deno.test("registry: each window gets a token binding; tokens resolve to their window", async () => {
  const { reg, main } = registry({ tokens: ["main-token", "w1-token"] });
  assertEquals(await main.bindings.get(WINDOW_BINDING)?.(), "main-token");
  assertEquals(reg.resolveToken("main-token"), "main");
  const opened = reg.open({ url: "/settings", width: 400, height: 300, title: "Settings" });
  assertEquals(opened.id, "window-1");
  assertEquals(reg.resolveToken("w1-token"), "window-1");
  assertEquals(reg.resolveToken("nope"), undefined);
  assertEquals(reg.bound(), true);
  assertEquals(reg.count(), 2);
  const win = FakeWin.made.at(-1)!;
  assertEquals(win.options, { title: "Settings", width: 400, height: 300 });
  assertEquals(win.calls, ['navigate["app://localhost/settings"]']);
});

Deno.test("registry: open maps focusable false to noActivate, levels, hidden start, overlay setters", () => {
  const { reg } = registry();
  reg.open({
    url: "/overlay",
    frameless: true,
    transparent: true,
    focusable: false,
    alwaysOnTop: "screen-saver",
    opacity: 0.9,
    skipTaskbar: true,
    visibleOnAllWorkspaces: true,
    show: false,
    x: 10.6,
    y: -5,
  });
  const win = FakeWin.made.at(-1)!;
  assertEquals(win.options, {
    x: 11,
    y: -5,
    opacity: 0.9,
    frameless: true,
    transparent: true,
    noActivate: true,
    alwaysOnTop: true,
    show: false,
  });
  assertEquals(win.calls, [
    'setAlwaysOnTop[true,"screen-saver"]',
    "setSkipTaskbar[true]",
    'setVisibleOnAllWorkspaces[true,{"visibleOnFullScreen":true}]',
    "hide",
    'navigate["app://localhost/overlay"]',
  ]);
});

Deno.test("registry: open refuses other origins, bad options and a ninth window", () => {
  const { reg } = registry();
  for (
    const bad of [
      { url: "https://evil.example/" },
      { url: "//evil.example/x" },
      { url: "/x", width: 0 },
      { url: "/x", opacity: 2 },
      { url: "/x", alwaysOnTop: "top" },
      { url: "/x", frameless: "yes" },
      { url: "/x", title: 5 },
      { url: "/x", capabilities: "fs" },
      { url: "/x", capabilities: [""] },
    ]
  ) {
    let code = "";
    try {
      reg.open(bad);
    } catch (err) {
      code = String((err as { code?: unknown }).code);
    }
    assertEquals(code, "validation", JSON.stringify(bad));
  }
  for (let i = 0; i < MAX_OPEN_WINDOWS; i++) reg.open({ url: "/w" });
  let code = "";
  try {
    reg.open({ url: "/w" });
  } catch (err) {
    code = String((err as { code?: unknown }).code);
  }
  assertEquals(code, "validation");
  assertEquals(openWindowSettings({ url: "/" }).show, true);
});

Deno.test("registry: no runtime constructor or bindings answers unsupported", () => {
  const none = registry({ BrowserWindow: null }).reg;
  let code = "";
  try {
    none.open({ url: "/x" });
  } catch (err) {
    code = String((err as { code?: unknown }).code);
  }
  assertEquals(code, "unsupported");
  class NoBind extends EventTarget {
    navigate() {}
  }
  const unbound = registry({ BrowserWindow: NoBind }).reg;
  try {
    unbound.open({ url: "/x", capabilities: ["app"] });
  } catch (err) {
    code = String((err as { code?: unknown }).code);
  }
  assertEquals(code, "unsupported", "a subset needs bindings to tell the window apart");
  assertEquals(unbound.open({ url: "/x" }).bound, false);
});

Deno.test("registry: a capability subset limits a window; window is always allowed", () => {
  const { reg } = registry();
  const w = reg.open({ url: "/panel", capabilities: ["app"] });
  assertEquals(reg.allowed(w.id, "app"), true);
  assertEquals(reg.allowed(w.id, "window"), true);
  assertEquals(reg.allowed(w.id, "fs"), false);
  assertEquals(reg.allowed("main", "fs"), true);
});

Deno.test("registry: the app quits after its last window unless kept alive; the panel does not count", () => {
  const { reg, exits, closedIds, emitted } = registry();
  const panel = new FakeWin();
  reg.adopt(panel, "panel");
  const w = reg.open({ url: "/w" });
  reg.closed("main");
  assertEquals(exits, [], "a window is still open");
  // The user closes the opened window (no guard): it leaves, and the app quits.
  FakeWin.made.at(-1)!.dispatchEvent(new Event("close", { cancelable: true }));
  assertEquals(exits, [0]);
  assertEquals(closedIds, ["main", w.id]);
  assert(
    emitted.some(([cap, event, data]) =>
      cap === "windows" && event === "closed" && (data as { id: string }).id === w.id
    ),
  );
  reg.closed("gone"); // unknown: nothing
  assertEquals(exits, [0]);
  const alive = registry({ keepAlive: true });
  alive.reg.closed("main");
  assertEquals(alive.exits, []);
});

Deno.test("registry: the window router acts on the calling window; the windows cap by id", async () => {
  const { reg, main } = registry();
  const w = reg.open({ url: "/w" });
  const win = FakeWin.made.at(-1)!;
  await call(reg.router, "setOpacity", { opacity: 0.5 }, w.id);
  await call(reg.router, "setOpacity", { opacity: 0.7 });
  assert(win.calls.includes("setOpacity[0.5]"));
  assert(main.calls.includes("setOpacity[0.7]"));
  assertEquals(await codeOf(call(reg.router, "setOpacity", { opacity: 1 }, "gone")), "unsupported");
  assertEquals(reg.router.perWindow, true);
  await reg.router.onPageLoad?.(w.id);
  const cap = reg.capability;
  assertEquals(await call(cap, "current", {}, w.id), { id: w.id });
  assertEquals(await call(cap, "list"), [
    { id: "main", kind: "main", visible: true },
    { id: w.id, kind: "window", visible: true },
  ]);
  await call(cap, "hide", { id: w.id });
  await call(cap, "show", { id: w.id });
  await call(cap, "focus", { id: w.id });
  await call(cap, "setBounds", { id: w.id, x: 3, width: 500.2 });
  await call(cap, "navigate", { id: w.id, url: "/other" });
  assertEquals(await call(cap, "getBounds", { id: w.id }), { x: 1, y: 2, width: 300, height: 200 });
  assertEquals(win.calls.slice(-5), [
    "hide",
    "show",
    "focus",
    'setBounds[{"x":3,"width":500}]',
    'navigate["app://localhost/other"]',
  ]);
  assertEquals(await codeOf(call(cap, "navigate", { id: w.id, url: "https://x/" })), "validation");
  assertEquals(await codeOf(call(cap, "show", { id: "nope" })), "not_found");
  assertEquals((await call(cap, "capabilities") as { open: boolean }).open, true);
  await call(cap, "close", { id: w.id });
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(reg.get(w.id), undefined);
  assert(win.calls.includes("close"));
});

Deno.test("registry: focus / blur are broadcast with the window's id", () => {
  const { reg, emitted } = registry();
  const w = reg.open({ url: "/w" });
  FakeWin.made.at(-1)!.dispatchEvent(new Event("focus"));
  assert(
    emitted.some(([cap, event, data]) =>
      cap === "windows" && event === "focus" && (data as { id: string }).id === w.id
    ),
  );
  assertEquals(reg.list().length, 2);
});

// --- the app capability: per-window queues, the backend tray, the Dock ------------------------

class FakeTray extends EventTarget implements TrayLike {
  static made: FakeTray[] = [];
  icon?: Uint8Array;
  tooltip: string | null = null;
  menu: DesktopMenuItem[] | null = null;
  destroyed = false;
  panelOptions?: Record<string, unknown>;
  panelWindow = new FakeWin();
  shown = 0;
  constructor() {
    super();
    FakeTray.made.push(this);
  }
  setIcon(png: Uint8Array) {
    this.icon = png;
  }
  setTooltip(text: string | null) {
    this.tooltip = text;
  }
  setMenu(menu: DesktopMenuItem[] | null) {
    this.menu = menu;
  }
  getBounds() {
    return { x: 1000, y: 0, width: 24, height: 24 };
  }
  destroy() {
    this.destroyed = true;
  }
  attachPanel(options: Record<string, unknown>) {
    this.panelOptions = options;
    let visible = false;
    // deno-lint-ignore no-this-alias
    const tray = this;
    return {
      window: this.panelWindow,
      get visible() {
        return visible;
      },
      show() {
        visible = true;
        tray.shown++;
      },
      hide() {
        visible = false;
      },
      toggle() {
        visible = !visible;
      },
    };
  }
}

class FakeDock extends EventTarget implements DockLike {
  visible: boolean[] = [];
  setBadge() {}
  bounce() {}
  setVisible(visible: boolean) {
    this.visible.push(visible);
  }
}

const PNG = "iVBORw0KGgo=";

/** An app controller over a hidden main window with two windows open. */
function appCtl(os = "darwin", windows = ["main", "window-1"]) {
  FakeTray.made = [];
  const win = Object.assign(new EventTarget(), {
    shown: 0,
    isVisible: () => false,
    show() {
      this.shown++;
    },
  });
  const dock = new FakeDock();
  const emitted: string[] = [];
  const ctl = createAppController({
    window: win,
    emit: (cap, event, _data, target) => void emitted.push(`${cap}:${event}@${target}`),
    Tray: FakeTray,
    dock,
    os,
    windows: () => windows,
  });
  ctl.install();
  return { ctl, cap: ctl.capability, win, dock, emitted };
}

Deno.test("app: a page tray's clicks go to its own window; menu clicks to every window", async () => {
  const { cap, emitted } = appCtl();
  const { id } = await call(cap, "createTray", { icon: PNG }, "window-1") as { id: string };
  FakeTray.made[0].dispatchEvent(new Event("click"));
  assertEquals(emitted, ["app:action@window-1"]);
  assertEquals(await call(cap, "take", {}, "main"), []);
  assertEquals(await call(cap, "take", {}, "window-1"), [
    { source: "tray", tray: id, event: "click" },
  ]);
});

Deno.test("app: a page load in one window removes that window's trays only", async () => {
  const { ctl, cap } = appCtl();
  await call(cap, "createTray", { icon: PNG }, "main");
  await call(cap, "createTray", { icon: PNG }, "window-1");
  await cap.onPageLoad?.("window-1");
  assertEquals(FakeTray.made.map((t) => t.destroyed), [false, true]);
  await cap.onPageLoad?.();
  assertEquals(FakeTray.made.map((t) => t.destroyed), [true, true]);
  assertEquals(cap.perWindow, true);
  ctl.windowClosed("window-1");
  assertEquals(ctl.hasTray(), false);
});

Deno.test("app: the backend tray survives page loads, cannot be removed, and its clicks reach every window", async () => {
  const { ctl, cap, emitted } = appCtl();
  const made = await ctl.createBackendTray({ icon: PNG, tooltip: "Hangar" });
  assert(!("reason" in made));
  assertEquals(FakeTray.made[0].tooltip, "Hangar");
  await cap.onPageLoad?.("main");
  assertEquals(FakeTray.made[0].destroyed, false);
  assertEquals(await codeOf(call(cap, "destroyTray", { id: BACKEND_TRAY_ID })), "validation");
  assertEquals(await call(cap, "backendTray"), { id: BACKEND_TRAY_ID });
  FakeTray.made[0].dispatchEvent(new Event("dblclick"));
  assertEquals(emitted.sort(), ["app:action@main", "app:action@window-1"]);
  made.update({ menu: [{ id: "open", label: "Open", enabled: true }] });
  assertEquals([...made.menuIds], ["open"]);
  FakeTray.made[0].dispatchEvent(new CustomEvent("menuclick", { detail: { id: "open" } }));
  assertEquals(await call(cap, "take", {}, "window-1"), [
    { source: "tray", tray: BACKEND_TRAY_ID, event: "doubleClick" },
    { source: "trayMenu", tray: BACKEND_TRAY_ID, id: "open" },
  ]);
  assertEquals(ctl.hasTray(), true);
  await assertRejects(() => ctl.createBackendTray({ icon: PNG }), Error, "exists already");
  const caps = await call(cap, "capabilities") as Record<string, unknown>;
  assertEquals([caps.backendTray, caps.trayPanel], [true, false]);
});

Deno.test("app: the panel is shown, hidden and toggled; without one it is unsupported", async () => {
  const { ctl, cap } = appCtl();
  assertEquals(await codeOf(call(cap, "panel", { action: "show" })), "unsupported");
  const made = await ctl.createBackendTray({ icon: PNG });
  assert(!("reason" in made));
  made.setPanel(FakeTray.made[0].attachPanel({}));
  assertEquals(await call(cap, "panel", { action: "show" }), { visible: true });
  assertEquals(await call(cap, "panel", { action: "toggle" }), { visible: false });
  assertEquals(await call(cap, "panel", { action: "hide" }), { visible: false });
  assertEquals(await call(cap, "panel", { action: "state" }), { visible: false });
  assertEquals(await codeOf(call(cap, "panel", { action: "spin" })), "validation");
});

Deno.test("app: with no tray host the backend tray is a reason and a hidden window is shown", async () => {
  const { ctl, win } = appCtl("linux");
  const noHost = createAppController({
    window: win,
    emit: () => {},
    api: { platformFeatures: () => Promise.resolve({ trayHost: false, trayReason: "no watcher" }) },
    Tray: FakeTray,
    os: "linux",
  });
  const made = await noHost.createBackendTray({ icon: PNG });
  assertEquals(made, { reason: "no watcher" });
  assertEquals(win.shown, 1);
  class Throwing extends FakeTray {
    constructor() {
      super();
      throw Object.assign(new Error("Tray icons are not available here: no host"), {
        name: "NotSupported",
      });
    }
  }
  const throwing = createAppController({
    window: win,
    emit: () => {},
    Tray: Throwing,
    os: "linux",
  });
  assertEquals(await throwing.createBackendTray({ icon: PNG }), { reason: "no host" });
  ctl.backendTrayPending(Promise.reject(new Error("x")));
  assertEquals(await call(ctl.capability, "backendTray"), { id: null });
});

Deno.test("app: the Dock icon is shown and hidden on macOS only; a reopen click is queued", async () => {
  const mac = appCtl("darwin");
  assertEquals(await call(mac.cap, "setDockVisible", { visible: false }), { applied: true });
  assertEquals(mac.dock.visible, [false]);
  assertEquals(await codeOf(call(mac.cap, "setDockVisible", { visible: "no" })), "validation");
  assertEquals(
    (await call(mac.cap, "capabilities") as { dockVisibility: boolean }).dockVisibility,
    true,
  );
  mac.dock.dispatchEvent(new CustomEvent("reopen", { detail: { hasVisibleWindows: false } }));
  assertEquals(await call(mac.cap, "take"), [{ source: "dockReopen", hasVisibleWindows: false }]);
  const linux = appCtl("linux");
  assertEquals(await call(linux.cap, "setDockVisible", { visible: false }), { applied: false });
});

// --- the backend tray and its panel -----------------------------------------------------------

/** A backend tray context over an app controller and a registry. */
function trayContext(files: Record<string, Uint8Array> = { "/tray.png": new Uint8Array([1, 2]) }) {
  const { ctl } = appCtl();
  const reg = registry();
  const warnings: string[] = [];
  return {
    ctl,
    reg,
    warnings,
    base: {
      app: ctl,
      registry: reg.reg,
      appUrl: (path: string) => `app://localhost${path}`,
      readFile: (path: string) => Promise.resolve(files[path] ?? null),
      screens: () => [{
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 25, width: 1440, height: 800 },
      }],
      warn: (m: string) => void warnings.push(m),
    },
  };
}

Deno.test("backend tray: none configured is undefined; the icon is read from the export", async () => {
  const t = trayContext();
  assertEquals(await startBackendTray(t.base), undefined);
  const handle = await startBackendTray({
    ...t.base,
    settings: {
      icon: "/tray.png",
      tooltip: "T",
      menu: [{ label: "VMs", submenu: [{ id: "a", label: "A" }] }],
    },
  });
  assert(handle && !("reason" in handle));
  const tray = FakeTray.made[0];
  assertEquals([...tray.icon!], [1, 2]);
  assertEquals(tray.tooltip, "T");
  assertEquals(JSON.stringify(tray.menu).includes('"a"'), true);
  assertEquals(handle.getBounds(), { x: 1000, y: 0, width: 24, height: 24 });
  await assertRejects(
    () => startBackendTray({ ...trayContext({}).base, settings: { icon: "/missing.png" } }),
    Error,
    "not in the export",
  );
  await assertRejects(
    () => startBackendTray({ ...trayContext().base, options: { tooltip: "no icon" } }),
    Error,
    "needs an icon",
  );
});

Deno.test("backend tray: runDesktop's handlers hear clicks and its own menu items; update re-wires", async () => {
  const t = trayContext();
  const heard: string[] = [];
  const handle = await startBackendTray({
    ...t.base,
    settings: { icon: "/tray.png" },
    options: {
      icon: new Uint8Array([9]),
      iconDark: "/tray.png",
      menu: [{ id: "quit-vms", label: "Stop all" }],
      onClick: () => void heard.push("click"),
      onDoubleClick: () => void heard.push("dbl"),
      onMenuItem: (id) => void heard.push(`menu:${id}`),
    },
  });
  assert(handle && !("reason" in handle));
  const tray = FakeTray.made[0];
  assertEquals([...tray.icon!], [9]);
  tray.dispatchEvent(new Event("click"));
  tray.dispatchEvent(new Event("dblclick"));
  tray.dispatchEvent(new CustomEvent("menuclick", { detail: { id: "quit-vms" } }));
  tray.dispatchEvent(new CustomEvent("menuclick", { detail: { id: "not-ours" } }));
  assertEquals(heard, ["click", "dbl", "menu:quit-vms"]);
  handle.update({
    icon: new Uint8Array([7]),
    iconDark: null,
    tooltip: null,
    menu: [{ id: "b", label: "B" }],
  });
  assertEquals([...tray.icon!], [7]);
  const off = handle.onMenuItem((id) => void heard.push(`late:${id}`));
  tray.dispatchEvent(new CustomEvent("menuclick", { detail: { id: "b" } }));
  off();
  tray.dispatchEvent(new CustomEvent("menuclick", { detail: { id: "b" } }));
  assertEquals(heard.filter((h) => h.startsWith("late")), ["late:b"]);
  handle.update({ menu: null });
  assertEquals(tray.menu, null);
});

Deno.test("backend tray: the panel is registered (token bound) before it loads, placed in the work area", async () => {
  const t = trayContext();
  const handle = await startBackendTray({
    ...t.base,
    settings: {
      icon: "/tray.png",
      panel: { url: "/panel", width: 300, height: 400, hideOnBlur: true },
    },
  });
  assert(handle && !("reason" in handle) && handle.panel);
  const tray = FakeTray.made[0];
  assertEquals(tray.panelOptions?.width, 300);
  assertEquals(tray.panelOptions?.hideOnBlur, true);
  assertEquals("url" in tray.panelOptions!, false, "the panel navigates itself after the bind");
  const place = tray.panelOptions!.position as (
    b: unknown,
    s: unknown,
  ) => { x: number; y: number };
  assertEquals(place({ x: 1000, y: 860, width: 24, height: 40 }, { width: 300, height: 400 }), {
    x: 862,
    y: 425,
  });
  assert(tray.panelWindow.bindings.has(WINDOW_BINDING));
  assertEquals(tray.panelWindow.calls, ['navigate["app://localhost/panel"]']);
  assertEquals(t.reg.reg.get("panel")?.kind, "panel");
  handle.panel.show();
  assertEquals([handle.panel.visible, tray.shown], [true, 1]);
  handle.panel.toggle();
  handle.panel.hide();
  assertEquals(handle.panel.visible, false);
  assertEquals(handle.panel.id, "panel");
});

Deno.test("backend tray: a runtime without attachPanel warns; no tray host is a reason", async () => {
  const t = trayContext();
  const proto = FakeTray.prototype as unknown as { attachPanel?: unknown };
  const saved = proto.attachPanel;
  delete proto.attachPanel;
  try {
    const handle = await startBackendTray({
      ...t.base,
      settings: { icon: "/tray.png", panel: { url: "/p", width: 1, height: 1, hideOnBlur: true } },
    });
    assert(handle && !("reason" in handle));
    assertEquals(handle.panel, undefined);
    assertStringIncludes(t.warnings[0], "Tray.attachPanel");
  } finally {
    proto.attachPanel = saved;
  }
  const noHost = trayContext();
  const app = createAppController({
    window: undefined,
    emit: () => {},
    api: { platformFeatures: () => Promise.resolve({ trayHost: false, trayReason: "none" }) },
    Tray: FakeTray,
  });
  assertEquals(
    await startBackendTray({ ...noHost.base, app, settings: { icon: "/tray.png" } }),
    { reason: "none" },
  );
  assertStringIncludes(noHost.warnings[0], "no tray icon here");
});

// --- setUpDesktopWindows ----------------------------------------------------------------------

/** A fake `Deno.desktop` with the keep-alive flag. */
function keepAliveApi(): DesktopAppApi & { quitOnLastWindowClosed: boolean } {
  return { quitOnLastWindowClosed: true, screens: () => [] };
}

Deno.test("setup: a tray keeps the app alive; keepAlive false wins; none without a window", () => {
  const api = keepAliveApi();
  const s = setUpDesktopWindows({ window: new FakeWin(), api, emit: () => {}, wantsTray: true });
  assertEquals(api.quitOnLastWindowClosed, false);
  assertEquals(s.keepAlive(), true);
  assertEquals(s.capabilities.map((c) => c.name), ["window", "windows", "app"]);
  const off = keepAliveApi();
  setUpDesktopWindows({
    window: new FakeWin(),
    api: off,
    emit: () => {},
    wantsTray: true,
    appSettings: { keepAlive: false },
  });
  assertEquals(off.quitOnLastWindowClosed, true);
  const headless = setUpDesktopWindows({ window: undefined, emit: () => {}, wantsTray: false });
  assertEquals(headless.capabilities, []);
  assertEquals(headless.windows.list(), []);
  assertEquals(headless.setDockVisible(false), false);
});

Deno.test("setup: dock false hides the Dock icon on macOS, the main window's taskbar entry elsewhere", () => {
  const dock = new FakeDock();
  setUpDesktopWindows({
    window: new FakeWin(),
    dock,
    os: "darwin",
    emit: () => {},
    wantsTray: false,
    appSettings: { dock: false },
  });
  assertEquals(dock.visible, [false]);
  const main = new FakeWin();
  const s = setUpDesktopWindows({
    window: main,
    dock: new FakeDock(),
    os: "windows",
    emit: () => {},
    wantsTray: false,
    appSettings: { dock: false },
  });
  assertEquals(main.calls, ["setSkipTaskbar[true]"]);
  assertEquals(s.setDockVisible(true), true);
  const bare = setUpDesktopWindows({
    window: new PlainWin(),
    os: "linux",
    emit: () => {},
    wantsTray: false,
  });
  assertEquals(bare.setDockVisible(false), false);
  const noDock = setUpDesktopWindows({
    window: new FakeWin(),
    os: "darwin",
    emit: () => {},
    wantsTray: false,
  });
  assertEquals(noDock.setDockVisible(false), Boolean((Deno as unknown as { dock?: unknown }).dock));
});

Deno.test("setup: closing the main window quits without keepAlive, not with it; a page closes its own window", () => {
  const exits: number[] = [];
  const quit = setUpDesktopWindows({
    window: new FakeWin(),
    emit: () => {},
    wantsTray: false,
    exit: (c) => void exits.push(c),
  });
  quit.mainClosed();
  assertEquals(exits, [0]);
  const kept = setUpDesktopWindows({
    window: new FakeWin(),
    BrowserWindow: FakeWin,
    emit: () => {},
    wantsTray: false,
    appSettings: { keepAlive: true },
    exit: (c) => void exits.push(c),
  });
  const w = kept.windows.open({ url: "/w" });
  assertEquals(kept.windows.get(w.id)?.kind, "window");
  const token = kept.registry!.get(w.id)!.token;
  kept.closeFromPage(token);
  assertEquals(kept.windows.get(w.id), undefined);
  kept.closeFromPage(null); // the main window
  assertEquals(kept.windows.list(), []);
  assertEquals(exits, [0], "kept alive");
  const headless = setUpDesktopWindows({
    window: undefined,
    emit: () => {},
    wantsTray: false,
    exit: (c) => void exits.push(c),
  });
  headless.closeFromPage(null);
  headless.mainClosed();
  assertEquals(exits, [0, 0, 0]);
});

Deno.test("setup: a guarded close is intercepted; the Dock reopen shows the main window", () => {
  const dock = new FakeDock();
  const main = new FakeWin();
  main.visible = false;
  const s = setUpDesktopWindows({ window: main, dock, emit: () => {}, wantsTray: false });
  s.install();
  assertEquals(s.interceptMainClose(new Event("close", { cancelable: true })), false);
  dock.dispatchEvent(new CustomEvent("reopen", { detail: { hasVisibleWindows: true } }));
  assertEquals(main.calls, []);
  dock.dispatchEvent(new CustomEvent("reopen", { detail: { hasVisibleWindows: false } }));
  assertEquals(main.calls, ["show", "focus"]);
});

Deno.test("setup: windows API refs act on their window; the app URL is set once the server listens", () => {
  const s = setUpDesktopWindows({
    window: new FakeWin(),
    BrowserWindow: FakeWin,
    emit: () => {},
    wantsTray: false,
    appSettings: { keepAlive: true },
  });
  s.setAppUrl((path) => `app://localhost${path}`);
  const w = s.windows.open({ url: "/a" });
  const win = FakeWin.made.at(-1)!;
  w.show();
  w.hide();
  w.focus();
  w.navigate("/b");
  assertEquals(win.calls, [
    'navigate["app://localhost/a"]',
    "show",
    "hide",
    "focus",
    'navigate["app://localhost/b"]',
  ]);
  w.close();
  w.navigate("/c"); // closed: nothing
  assertEquals(win.calls.at(-1), "close");
  assertEquals(s.windows.list().map((r) => r.id), ["main"]);
});

Deno.test("setup: startTray with no tray host turns keep-alive back off", async () => {
  const api = {
    ...keepAliveApi(),
    platformFeatures: () => Promise.resolve({ trayHost: false, trayReason: "none" }),
  };
  const s = setUpDesktopWindows({
    window: new FakeWin(),
    api,
    emit: () => {},
    wantsTray: true,
    warn: () => {},
  });
  assertEquals(api.quitOnLastWindowClosed, false);
  const tray = await s.startTray({
    settings: { icon: "/t.png" },
    appUrl: (p) => p,
    readFile: () => Promise.resolve(new Uint8Array([1])),
  });
  assertEquals(tray, undefined);
  assertEquals([s.keepAlive(), api.quitOnLastWindowClosed], [false, true]);
  const headless = setUpDesktopWindows({ window: undefined, emit: () => {}, wantsTray: true });
  assertEquals(
    await headless.startTray({ appUrl: (p) => p, readFile: () => Promise.resolve(null) }),
    undefined,
  );
});

// --- text to speech -----------------------------------------------------------------------------

Deno.test("textToSpeech: unsupported until the runtime has Deno.desktop.speech; then it speaks", async () => {
  let api: DesktopAppApi | undefined = undefined;
  const cap = createSpeechCapability(() => api);
  assertEquals(await call(cap, "capabilities"), { native: false });
  for (const m of ["speak", "stop", "voices"]) {
    assertEquals(await codeOf(call(cap, m, { text: "hi" })), "unsupported", m);
  }
  const said: unknown[] = [];
  api = {
    speech: {
      speak: (text, options) => Promise.resolve(void said.push([text, options])),
      stop: () => void said.push("stop"),
      voices: () => Promise.resolve([{ id: "v1", name: "Samantha", lang: "en-US" }]),
    },
  };
  assertEquals(await call(cap, "capabilities"), { native: true });
  await call(cap, "speak", { text: "hello", rate: 1.2, lang: "en-US" });
  await call(cap, "stop");
  assertEquals(said, [["hello", { lang: "en-US", rate: 1.2 }], "stop"]);
  assertEquals(await call(cap, "voices"), [{ id: "v1", name: "Samantha", lang: "en-US" }]);
  for (
    const bad of [{ text: 1 }, { text: "x", rate: 99 }, { text: "x", voice: 3 }, {
      text: "x".repeat(40000),
    }]
  ) {
    assertEquals(
      await codeOf(call(cap, "speak", bad)),
      "validation",
      JSON.stringify(bad).slice(0, 30),
    );
  }
  api = { speech: { speak: () => Promise.resolve(), stop: () => {} } };
  assertEquals(await call(cap, "voices"), []);
});

Deno.test("menuWire: submenus become children, disabled becomes enabled", () => {
  assertEquals(
    menuWire([
      "separator",
      { separator: true },
      { role: "quit" },
      { label: "More", submenu: [{ id: "a", label: "A", disabled: true, checked: true }] },
      { id: "b", label: "B", accelerator: "Cmd+B", tooltip: "t", icon: "x", destructive: true },
      null,
    ]),
    [
      "separator",
      "separator",
      { role: "quit" },
      { label: "More", children: [{ id: "a", label: "A", enabled: false, checked: true }] },
      {
        id: "b",
        label: "B",
        enabled: true,
        accelerator: "Cmd+B",
        tooltip: "t",
        icon: "x",
        destructive: true,
      },
      null,
    ],
  );
});

Deno.test("noDesktopWindows: a launch with no windows opens none and leaves the Dock alone", () => {
  const none = noDesktopWindows();
  let message = "";
  try {
    none.windows.open({ url: "/" });
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "no windows");
  assertEquals([none.windows.get("main"), none.windows.list(), none.setDockVisible(true)], [
    undefined,
    [],
    false,
  ]);
});
