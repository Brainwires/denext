// The `window` capability (src/desktop/caps/window.ts), the initial-window settings
// (src/desktop/window-config.ts) and the close hook runDesktop installs: driven against a fake
// `Deno.BrowserWindow` / `Deno.desktop` (the pinned runtime's surface) and a bare one (the stock
// runtime's), so every method's feature detection, the guarded close and the file drag and drop
// are covered without a desktop build.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  createWindowController,
  UNRESPONSIVE_MS,
  type WindowControllerOptions,
} from "../src/desktop/caps/window.ts";
import {
  applyDesktopWindowSettings,
  resolveDesktopWindowSettings,
} from "../src/desktop/window-config.ts";
import { type DesktopCapCtx, DesktopCapError } from "../src/desktop/extension.ts";
import { PickedPaths } from "../src/desktop/picked-paths.ts";
import { installWindowCloseHandler } from "../src/build/desktop.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import { until } from "./helpers/desktop-fake-runtime.ts";

/** How long a test waits for an async effect (polled; generous for a loaded machine). */
const WAIT_MS = 10_000;

/** A fake pinned-runtime window recording every call. */
class FakeWindow extends EventTarget {
  calls: Array<[string, unknown[]]> = [];
  maximized = false;
  closed = false;
  dragResult = "dropped";
  #rec(name: string, args: unknown[]) {
    this.calls.push([name, args]);
  }
  maximize() {
    this.#rec("maximize", []);
    this.maximized = true;
  }
  unmaximize() {
    this.#rec("unmaximize", []);
  }
  isMaximized() {
    return this.maximized;
  }
  minimize() {
    this.#rec("minimize", []);
  }
  restore() {
    this.#rec("restore", []);
  }
  isMinimized() {
    return false;
  }
  setFullScreen(flag: boolean) {
    this.#rec("setFullScreen", [flag]);
  }
  isFullScreen() {
    return false;
  }
  isVisible() {
    return true;
  }
  getBounds() {
    return { x: 10, y: 20, width: 800, height: 600 };
  }
  getContentBounds() {
    return { x: 10, y: 48, width: 800, height: 572 };
  }
  getNormalBounds() {
    return { x: 10, y: 20, width: 800, height: 600 };
  }
  getScreen() {
    return null;
  }
  getMinimumSize(): [number, number] {
    return [0, 0];
  }
  getMaximumSize(): [number, number] {
    return [0, 0];
  }
  getSize(): [number, number] {
    return [800, 600];
  }
  setSize(w: number, h: number) {
    this.#rec("setSize", [w, h]);
  }
  setPosition(x: number, y: number) {
    this.#rec("setPosition", [x, y]);
  }
  setBounds(b: unknown) {
    this.#rec("setBounds", [b]);
  }
  setMinimumSize(w: number, h: number) {
    this.#rec("setMinimumSize", [w, h]);
  }
  setMaximumSize(w: number, h: number) {
    this.#rec("setMaximumSize", [w, h]);
  }
  setTitle(t: string) {
    this.#rec("setTitle", [t]);
  }
  setResizable(r: boolean) {
    this.#rec("setResizable", [r]);
  }
  setAlwaysOnTop(a: boolean) {
    this.#rec("setAlwaysOnTop", [a]);
  }
  show() {
    this.#rec("show", []);
  }
  hide() {
    this.#rec("hide", []);
  }
  focus() {
    this.#rec("focus", []);
  }
  close() {
    this.closed = true;
    this.#rec("close", []);
  }
  setTitleBarStyle(style: string) {
    this.#rec("setTitleBarStyle", [style]);
    return true;
  }
  setWindowButtonPosition(p: unknown) {
    this.#rec("setWindowButtonPosition", [p]);
    return true;
  }
  setBackgroundMaterial(m: string) {
    this.#rec("setBackgroundMaterial", [m]);
    return m !== "none";
  }
  setVibrancy(m: string | null) {
    if (m !== null && m !== "under-window" && m !== "sidebar") {
      throw new TypeError(`Unknown vibrancy material: ${m}`);
    }
    this.#rec("setVibrancy", [m]);
    return m !== null;
  }
  startDrag(item: { files: string[]; icon?: Uint8Array }) {
    this.#rec("startDrag", [item]);
    return Promise.resolve(this.dragResult);
  }
}

/** A stock-runtime window: only the basics. */
class StockWindow extends EventTarget {
  calls: Array<[string, unknown[]]> = [];
  getSize(): [number, number] {
    return [800, 600];
  }
  getPosition(): [number, number] {
    return [5, 6];
  }
  setSize(w: number, h: number) {
    this.calls.push(["setSize", [w, h]]);
  }
  setTitle(t: string) {
    this.calls.push(["setTitle", [t]]);
  }
}

/** A fake `Deno.desktop` (the pinned runtime). */
function fakeApi(overrides: Partial<DesktopAppApi> = {}): DesktopAppApi & EventTarget {
  const target = new EventTarget();
  return Object.assign(target, {
    screens: () => [{
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
      scaleFactor: 2,
      isPrimary: true,
    }],
    windowCapabilities: () => ({ state: true, fileDrop: true, fileDragOut: true }),
    quit: () => true,
    ...overrides,
  });
}

const ctx = (): DesktopCapCtx => ({
  emit: () => {},
  appSupportDir: "",
  runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
  os: "darwin",
  signal: new AbortController().signal,
});

/** A controller over a fake window, recording emitted events and exits. */
function setup(options: Partial<WindowControllerOptions> = {}) {
  const win = new FakeWindow();
  const emitted: Array<[string, string, unknown]> = [];
  const exits: number[] = [];
  let clock = 1_000;
  const ctl = createWindowController({
    window: win,
    api: fakeApi(),
    emit: (cap, event, data) => void emitted.push([cap, event, data]),
    exit: (code) => void exits.push(code),
    now: () => clock,
    ...options,
  });
  const call = (method: string, args: unknown = {}) =>
    Promise.resolve().then(() => ctl.capability.methods[method].handler(args, ctx()));
  return {
    win,
    ctl,
    emitted,
    exits,
    call,
    tick: (ms: number) => void (clock += ms),
  };
}

Deno.test("window: state, size and chrome calls reach the BrowserWindow", async () => {
  const { win, call } = setup();
  await call("maximize");
  const state = await call("state") as Record<string, unknown>;
  assertEquals(state.maximized, true);
  assertEquals(state.bounds, { x: 10, y: 20, width: 800, height: 600 });
  assertEquals(state.minimumSize, [0, 0]);
  await call("setFullScreen", { fullscreen: true });
  await call("setSize", { width: 1024.4, height: 700 });
  await call("setMinimumSize", { width: 400, height: 0 });
  await call("setBounds", { x: 1, width: 900 });
  await call("setTitle", { title: "Docs" });
  assertEquals(await call("setTitleBarStyle", { style: "hiddenInset" }), { applied: true });
  assertEquals(await call("setWindowButtonPosition", { position: { x: 12, y: 16 } }), {
    applied: true,
  });
  assertEquals(await call("setWindowButtonPosition", { position: null }), { applied: true });
  assertEquals(win.calls.map(([n]) => n), [
    "maximize",
    "setFullScreen",
    "setSize",
    "setMinimumSize",
    "setBounds",
    "setTitle",
    "setTitleBarStyle",
    "setWindowButtonPosition",
    "setWindowButtonPosition",
  ]);
  assertEquals(win.calls[2][1], [1024, 700]);
  assertEquals(win.calls[4][1], [{ x: 1, width: 900 }]);
  assertEquals((await call("screens") as unknown[]).length, 1);
});

Deno.test("window: backdrops — vibrancy (default material), Windows materials, none", async () => {
  const { win, call } = setup();
  assertEquals(await call("setBackdrop", { backdrop: "vibrancy" }), { applied: true });
  assertEquals(win.calls.at(-1), ["setVibrancy", ["under-window"]]);
  assertEquals(await call("setBackdrop", { backdrop: "vibrancy", material: "sidebar" }), {
    applied: true,
  });
  assertEquals(await call("setBackdrop", { backdrop: "mica" }), { applied: true });
  assertEquals(win.calls.at(-1), ["setBackgroundMaterial", ["mica"]]);
  assertEquals(await call("setBackdrop", { backdrop: "none" }), { applied: false });
  const bad = await assertRejects(
    () => call("setBackdrop", { backdrop: "vibrancy", material: "glass" }),
    DesktopCapError,
  );
  assertEquals(bad.code, "validation");
  const worse = await assertRejects(
    () => call("setBackdrop", { backdrop: "blur" }),
    DesktopCapError,
  );
  assertEquals(worse.code, "validation");
});

Deno.test("window: arguments are validated before the window is touched", async () => {
  const { win, call } = setup();
  for (
    const [method, args] of [
      ["setSize", { width: 0, height: 10 }],
      ["setSize", { width: "800", height: 600 }],
      ["setPosition", { x: Infinity, y: 0 }],
      ["setFullScreen", { fullscreen: "yes" }],
      ["setTitle", { title: 42 }],
      ["setTitleBarStyle", { style: "transparent" }],
      ["setWindowButtonPosition", { position: { x: -1, y: 0 } }],
    ] as const
  ) {
    const err = await assertRejects(() => call(method, args), DesktopCapError);
    assertEquals(err.code, "validation", method);
  }
  assertEquals(win.calls, []);
});

Deno.test("window: the stock runtime keeps the basics; the rest is unsupported (501)", async () => {
  const win = new StockWindow();
  const ctl = createWindowController({ window: win, emit: () => {} });
  const call = (m: string, a: unknown = {}) =>
    Promise.resolve().then(() => ctl.capability.methods[m].handler(a, ctx()));
  await call("setSize", { width: 640, height: 480 });
  assertEquals(win.calls, [["setSize", [640, 480]]]);
  const state = await call("state") as Record<string, unknown>;
  assertEquals(state.bounds, { x: 5, y: 6, width: 800, height: 600 });
  assertEquals(state.maximized, false);
  for (
    const [method, args] of [["maximize", {}], ["screens", {}], ["setCloseGuard", {
      enabled: true,
    }]] as const
  ) {
    const err = await assertRejects(() => call(method, args), DesktopCapError);
    assertEquals(err.code, "unsupported", method);
    assertEquals(err.status, 501);
  }
  const caps = await call("capabilities") as Record<string, boolean>;
  assertEquals(caps.state, false);
  assertEquals(caps.closeGuard, false);
  assertEquals(caps.fileDrop, false);
  // No window at all (not a desktop run): unsupported, never a crash.
  const none = createWindowController({ window: undefined, emit: () => {} });
  const err = await assertRejects(
    () => Promise.resolve().then(() => none.capability.methods.state.handler({}, ctx())),
    DesktopCapError,
  );
  assertEquals(err.code, "unsupported");
});

Deno.test("window: capabilities merge the runtime's report with closeGuard", async () => {
  const { call } = setup();
  const caps = await call("capabilities") as Record<string, boolean>;
  assertEquals(caps.state, true);
  assertEquals(caps.fileDrop, true);
  assertEquals(caps.closeGuard, true);
  assertEquals(caps.vibrancy, false, "unreported keys default to false");
});

Deno.test("window: dipGeometry is reported by a runtime with Deno.desktop.shortcuts (denext.5+)", async () => {
  const legacy = await setup().call("capabilities") as Record<string, boolean>;
  // Only WebView2 hosts before denext.5 placed windows in physical pixels.
  assertEquals(legacy.dipGeometry, Deno.build.os !== "windows");
  const current = await setup({ api: { ...fakeApi(), shortcuts: {} as never } }).call(
    "capabilities",
  ) as Record<
    string,
    boolean
  >;
  assertEquals(current.dipGeometry, true);
});

Deno.test("window: state and display events are emitted as signals", () => {
  const api = fakeApi();
  const { win, emitted, ctl } = setup({ api });
  ctl.install();
  ctl.install(); // idempotent
  win.dispatchEvent(new Event("maximize"));
  win.dispatchEvent(new Event("leavefullscreen"));
  api.dispatchEvent(new Event("displaychanged"));
  assertEquals(emitted, [
    ["window", "state", null],
    ["window", "state", null],
    ["window", "display", null],
  ]);
});

Deno.test("window.titleBarPreferences: the runtime's answer, validated; followed live", async () => {
  const answer = {
    buttons: { left: ["close", "minimize", "bogus"], right: ["appmenu"] },
    side: "left",
    doubleClick: "minimize",
    colorScheme: "dark",
    accentColor: "#3daee9",
    font: "Noto Sans Bold 10",
    source: "portal",
  };
  const api = fakeApi({ titleBarPreferences: () => Promise.resolve(answer) });
  const { call, ctl, emitted } = setup({ api, os: "linux" });
  assertEquals(await call("titleBarPreferences"), {
    ...answer,
    // An item the page wouldn't know is dropped.
    buttons: { left: ["close", "minimize"], right: ["appmenu"] },
  });
  // The runtime's change event becomes the page's signal.
  ctl.install();
  api.dispatchEvent(new Event("titlebarpreferenceschanged"));
  assertEquals(emitted, [["window", "titleBarPreferences", null]]);
  // Unexpected values take the OS's default for that field.
  const odd = fakeApi({
    titleBarPreferences: () =>
      Promise.resolve({
        buttons: "nope",
        side: "top",
        doubleClick: "explode",
        colorScheme: 3,
        accentColor: "red",
        font: 7,
        source: "magic",
      }),
  });
  assertEquals(await setup({ api: odd, os: "windows" }).call("titleBarPreferences"), {
    buttons: { left: [], right: [] },
    side: "right",
    doubleClick: "maximize",
    colorScheme: "no-preference",
    accentColor: null,
    font: null,
    source: "unknown",
  });
});

Deno.test("window.titleBarPreferences: before runtime 2.9.7-denext.12, the OS's usual layout", async () => {
  const mac = await setup({ os: "darwin" }).call("titleBarPreferences");
  assertEquals(mac, {
    buttons: { left: ["close", "minimize", "maximize"], right: [] },
    side: "left",
    doubleClick: "maximize",
    colorScheme: "no-preference",
    accentColor: null,
    font: null,
    source: "unknown",
  });
  const linux = await setup({ os: "linux" }).call("titleBarPreferences") as {
    buttons: unknown;
    side: string;
  };
  assertEquals(linux.buttons, { left: ["menu"], right: ["minimize", "maximize", "close"] });
  assertEquals(linux.side, "right");
  // A runtime whose call throws answers the same.
  const throwing = fakeApi({ titleBarPreferences: () => Promise.reject(new Error("no portal")) });
  assertEquals(
    (await setup({ api: throwing, os: "windows" }).call("titleBarPreferences") as {
      source: string;
    }).source,
    "unknown",
  );
});

Deno.test("window close guard: off → the window closes; on → held, asked, answered", async () => {
  const { ctl, emitted, call, win, exits } = setup();
  const close = () => new Event("close", { cancelable: true });
  // No guard: the close listener may quit.
  assertEquals(ctl.interceptClose(close()), false);
  await call("setCloseGuard", { enabled: true });
  const first = close();
  assertEquals(ctl.interceptClose(first), true);
  assert(first.defaultPrevented);
  assertEquals(emitted.length, 1);
  const [, event, data] = emitted[0];
  assertEquals(event, "closeRequested");
  const id = (data as { id: string }).id;
  // A second click while the page is asking: held again, no second request.
  assertEquals(ctl.interceptClose(close()), true);
  assertEquals(emitted.length, 1);
  // A stale id (a replayed event after a reload) is not current.
  assertEquals(await call("closeAck", { id: "stale" }), { current: false });
  assertEquals(await call("closeAck", { id }), { current: true });
  // The page says no: the window stays, the next close asks again.
  assertEquals(await call("closeRespond", { id, close: false }), { closing: false });
  assertEquals(ctl.interceptClose(close()), true);
  assertEquals(emitted.length, 2);
  const id2 = (emitted[1][2] as { id: string }).id;
  assertEquals(await call("closeRespond", { id: id2, close: true }), { closing: true });
  assert(win.closed);
  await until(() => exits.length > 0, WAIT_MS);
  assertEquals(exits, [0]);
});

Deno.test("window close guard: an unresponsive page cannot keep the window open", async () => {
  const { ctl, call, tick, emitted } = setup();
  const close = () => new Event("close", { cancelable: true });
  await call("setCloseGuard", { enabled: true });
  assertEquals(ctl.interceptClose(close()), true);
  tick(UNRESPONSIVE_MS - 1);
  assertEquals(ctl.interceptClose(close()), true, "still within the grace period");
  tick(1);
  assertEquals(ctl.interceptClose(close()), false, "never acknowledged: the close goes through");
  // An acknowledged request (a page showing its own prompt) is held for as long as it takes.
  assertEquals(ctl.interceptClose(close()), true);
  const id = (emitted.at(-1)![2] as { id: string }).id;
  await call("closeAck", { id });
  tick(UNRESPONSIVE_MS * 10);
  assertEquals(ctl.interceptClose(close()), true);
});

Deno.test("window close guard: a new page load drops the guard and the pending request", async () => {
  const { ctl, call } = setup();
  await call("setCloseGuard", { enabled: true });
  assert(ctl.interceptClose(new Event("close", { cancelable: true })));
  await ctl.capability.onPageLoad!();
  assertEquals(ctl.interceptClose(new Event("close", { cancelable: true })), false);
});

Deno.test("window.quit: Deno.desktop.quit decides (a guarded close holds it); stock quits", async () => {
  let quitResult = false;
  const { call } = setup({ api: fakeApi({ quit: () => quitResult }) });
  assertEquals(await call("quit"), { quitting: false });
  quitResult = true;
  assertEquals(await call("quit"), { quitting: true });
  const exits: number[] = [];
  const stock = createWindowController({
    window: new StockWindow(),
    emit: () => {},
    exit: (c) => void exits.push(c),
  });
  assertEquals(await stock.capability.methods.quit.handler({}, ctx()), { quitting: true });
  await until(() => exits.length > 0, WAIT_MS);
  assertEquals(exits, [0]);
});

Deno.test("window drops: files become read-only handles, folders readFolder; taken once", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-drop-" });
  try {
    const file = join(dir, "a.txt");
    await Deno.writeTextFile(file, "hi");
    const folder = join(dir, "sub");
    await Deno.mkdir(folder);
    await Deno.writeTextFile(join(folder, "b.txt"), "inner");
    const picked = new PickedPaths();
    const { ctl, call, emitted, win } = setup({ picked });
    ctl.install();
    win.dispatchEvent(
      new CustomEvent("drop", {
        detail: { paths: [file, folder, join(dir, "gone.txt"), 42], count: 4, x: 30, y: 40 },
      }),
    );
    await until(() => emitted.length > 0, WAIT_MS);
    assertEquals(emitted, [["window", "drop", null]]);
    const drops = await call("takeDrops") as Array<
      { x: number; y: number; files: Array<Record<string, unknown>> }
    >;
    assertEquals(drops.length, 1);
    assertEquals([drops[0].x, drops[0].y], [30, 40]);
    const [f, d] = drops[0].files;
    assertEquals(drops[0].files.length, 2, "a missing path and a non-string are skipped");
    assertEquals([f.name, f.kind, f.size], ["a.txt", "file", 2]);
    assertEquals([d.name, d.kind], ["sub", "directory"]);
    // Read-only: the file handle reads, refuses a write; the folder handle reads inside, no write.
    assertEquals((await picked.resolve(f.handle, "", false)).target, await Deno.realPath(file));
    await assertRejects(() => picked.resolve(f.handle, "", true), DesktopCapError);
    const inner = await picked.resolve(d.handle, "b.txt", false);
    assertEquals(await Deno.readTextFile(inner.target), "inner");
    await assertRejects(() => picked.resolve(d.handle, "b.txt", true), DesktopCapError);
    await assertRejects(() => picked.resolve(d.handle, "../a.txt", false), DesktopCapError);
    // Taken: the queue is empty now; a drop with nothing usable emits nothing.
    assertEquals(await call("takeDrops"), []);
    await ctl.acceptDrop({ paths: [join(dir, "nope")] });
    assertEquals(emitted.length, 1);
    // A new page load forgets drops the old page never took.
    await ctl.acceptDrop({ paths: [file] });
    await ctl.capability.onPageLoad!();
    assertEquals(await call("takeDrops"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("window.startDrag: picked handles and app-folder files only, never a raw path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-dragout-" });
  try {
    const data = join(dir, "data");
    await Deno.mkdir(join(data, "export"), { recursive: true });
    await Deno.writeTextFile(join(data, "export", "r.pdf"), "%PDF");
    const outside = join(dir, "secret.txt");
    await Deno.writeTextFile(outside, "s");
    const picked = new PickedPaths();
    const handle = picked.add(await Deno.realPath(outside), "read");
    const { call, win } = setup({
      picked,
      dirs: { data, cache: join(dir, "cache"), documents: join(dir, "docs") },
    });
    const out = await call("startDrag", {
      items: [{ directory: "data", path: "export/r.pdf" }, { directory: { picked: handle } }],
      icon: btoa("\x89PNG"),
    });
    assertEquals(out, { result: "dropped" });
    const [, [item]] = win.calls.at(-1)! as [string, [{ files: string[]; icon: Uint8Array }]];
    assertEquals(item.files.length, 2);
    assert(item.files[0].endsWith(join("export", "r.pdf")));
    assertEquals(item.icon.length, 4);
    // Escapes and raw paths are refused.
    for (
      const items of [
        [{ directory: "data", path: "../secret.txt" }],
        [{ path: outside }],
        [{ directory: "data", path: "" }],
        [{ directory: "data", path: "missing.txt" }],
        [{ directory: { picked: "forged" } }],
        [],
      ]
    ) {
      await assertRejects(() => call("startDrag", { items }), DesktopCapError);
    }
    win.dragResult = "weird";
    assertEquals(
      await call("startDrag", { items: [{ directory: { picked: handle } }] }),
      { result: "failed" },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("window.startDrag: the engine profile and updater dirs never leave by drag", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-dragout-reserved-" });
  try {
    const data = join(dir, "data");
    for (const sub of ["CEF", "WebKitGTK", "WebView2", "ui-updates"]) {
      await Deno.mkdir(join(data, sub), { recursive: true });
      await Deno.writeTextFile(join(data, sub, "Cookies"), "secret");
    }
    const { call, win } = setup({
      picked: new PickedPaths(),
      dirs: { data, cache: join(dir, "cache"), documents: join(dir, "docs") },
    });
    const before = win.calls.length;
    for (const path of ["CEF/Cookies", "cef/Cookies", "WEBKITGTK/Cookies", "webview2/Cookies"]) {
      const err = await assertRejects(
        () => call("startDrag", { items: [{ directory: "data", path }] }),
        DesktopCapError,
      );
      assertEquals(err.code, "forbidden", path);
    }
    await assertRejects(
      () => call("startDrag", { items: [{ directory: "data", path: "ui-updates/Cookies" }] }),
      DesktopCapError,
    );
    assertEquals(win.calls.length, before, "nothing reached the window");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("window: size limits, resizability and always-on-top reach the window, validated", async () => {
  const { win, call } = setup();
  await call("setMaximumSize", { width: 1920, height: 0 }); // 0 = no limit on that axis
  await call("setResizable", { resizable: false });
  await call("setAlwaysOnTop", { alwaysOnTop: true });
  await call("unmaximize");
  await call("minimize");
  await call("restore");
  await call("show");
  await call("hide");
  await call("focus");
  await call("setPosition", { x: -40.6, y: 12 });
  assertEquals(win.calls, [
    ["setMaximumSize", [1920, 0]],
    ["setResizable", [false]],
    ["setAlwaysOnTop", [true]],
    ["unmaximize", []],
    ["minimize", []],
    ["restore", []],
    ["show", []],
    ["hide", []],
    ["focus", []],
    ["setPosition", [-41, 12]],
  ]);
  for (
    const [method, args] of [
      ["setMaximumSize", { width: -1, height: 0 }],
      ["setResizable", { resizable: 1 }],
      ["setAlwaysOnTop", {}],
      ["setTitle", { title: "x".repeat(1025) }],
      ["setBounds", { height: 0 }],
      ["setCloseGuard", { enabled: "on" }],
    ] as const
  ) {
    const err = await assertRejects(() => call(method, args), DesktopCapError);
    assertEquals(err.code, "validation", method);
  }
  assertEquals(win.calls.length, 10, "nothing more reached the window");
});

Deno.test("window: a window without bounds APIs reports null bounds; a throwing report is ignored", async () => {
  const bare = new EventTarget();
  const ctl = createWindowController({
    window: bare,
    api: fakeApi({
      windowCapabilities: () => {
        throw new Error("older runtime");
      },
    }),
    emit: () => {},
  });
  const call = (m: string) =>
    Promise.resolve().then(() => ctl.capability.methods[m].handler({}, ctx()));
  const state = await call("state") as Record<string, unknown>;
  assertEquals(state.bounds, null);
  assertEquals(state.contentBounds, null);
  assertEquals(state.visible, true);
  const caps = await call("capabilities") as Record<string, boolean>;
  assertEquals(caps.fileDrop, false, "the stock defaults stand when the report throws");
  assertEquals(caps.closeGuard, true);
  assertEquals(caps.screens, true);
});

Deno.test("window: backdrop none clears whichever API the runtime has; other errors pass through", async () => {
  // Vibrancy only (macOS): `none` clears it.
  const mac = new FakeWindow();
  Object.defineProperty(mac, "setBackgroundMaterial", { value: undefined });
  const a = setup({ window: mac });
  assertEquals(await a.call("setBackdrop", { backdrop: "none" }), { applied: false });
  assertEquals(mac.calls.at(-1), ["setVibrancy", [null]]);
  // Neither API: nothing applied, nothing thrown.
  const bare = setup({ window: new EventTarget() });
  assertEquals(await bare.call("setBackdrop", { backdrop: "none" }), { applied: false });
  // A runtime failure that is not an unknown material is not turned into a validation error.
  const broken = new FakeWindow();
  Object.defineProperty(broken, "setVibrancy", {
    value: () => {
      throw new Error("compositor gone");
    },
  });
  const err = await assertRejects(
    () => setup({ window: broken }).call("setBackdrop", { backdrop: "vibrancy" }),
    Error,
    "compositor gone",
  );
  assert(!(err instanceof DesktopCapError));
  // Windows materials on a runtime without them: unsupported.
  const none = await assertRejects(
    () => bare.call("setBackdrop", { backdrop: "acrylic" }),
    DesktopCapError,
  );
  assertEquals(none.code, "unsupported");
});

Deno.test("window close guard: turning it off drops the pending request; close() skips the page", async () => {
  const { ctl, call, emitted, win, exits } = setup();
  await call("setCloseGuard", { enabled: true });
  assert(ctl.interceptClose(new Event("close", { cancelable: true })));
  const id = (emitted.at(-1)![2] as { id: string }).id;
  await call("setCloseGuard", { enabled: false });
  // The page's late answer no longer refers to anything; the window closes freely now.
  assertEquals(await call("closeAck", { id }), { current: false });
  assertEquals(await call("closeRespond", { id, close: true }), { closing: false });
  assertEquals(ctl.interceptClose(new Event("close", { cancelable: true })), false);
  // `close` closes without asking, even while guarded.
  await call("setCloseGuard", { enabled: true });
  assertEquals(await call("close"), null);
  assert(win.closed);
  await until(() => exits.length > 0, WAIT_MS);
  assertEquals(exits, [0]);
  // ...and the guard is gone with it.
  assertEquals(ctl.interceptClose(new Event("close", { cancelable: true })), false);
});

Deno.test("window drops: malformed details are ignored; only the newest 16 untaken drops are kept", async () => {
  const { ctl, call, emitted } = setup({
    resolveDropped: (path) =>
      Promise.resolve({ real: `/real${path}`, kind: "file" as const, size: 1 }),
  });
  await ctl.acceptDrop(null);
  await ctl.acceptDrop({ paths: "not-a-list" });
  await ctl.acceptDrop({ paths: ["", 7] });
  assertEquals(emitted, []);
  for (let i = 0; i < 20; i++) await ctl.acceptDrop({ paths: [`/f${i}`], x: "left", y: NaN });
  assertEquals(emitted.length, 20, "each drop signals the page");
  const drops = await call("takeDrops") as Array<
    { x: number; y: number; files: Array<{ path: string }> }
  >;
  assertEquals(drops.length, 16);
  assertEquals(drops[0].files[0].path, "/real/f4");
  assertEquals(drops[15].files[0].path, "/real/f19");
  assertEquals([drops[0].x, drops[0].y], [0, 0], "non-finite coordinates become 0");
});

Deno.test("window.startDrag: app-folder items need the folders; a bad icon is refused", async () => {
  const { call, win } = setup(); // no `dirs`
  const err = await assertRejects(
    () => call("startDrag", { items: [{ directory: "cache", path: "a.txt" }] }),
    DesktopCapError,
  );
  assertEquals(err.code, "validation");
  const dir = await Deno.makeTempDir({ prefix: "denext-dragicon-" });
  try {
    await Deno.writeTextFile(join(dir, "a.txt"), "a");
    const withDirs = setup({ dirs: { data: dir, cache: dir, documents: dir } });
    for (const icon of [42, "A".repeat(2 * 1024 * 1024 + 1)]) {
      const bad = await assertRejects(
        () => withDirs.call("startDrag", { items: [{ directory: "data", path: "a.txt" }], icon }),
        DesktopCapError,
      );
      assertEquals(bad.code, "validation");
    }
    assertEquals(withDirs.win.calls, []);
    assertEquals(win.calls, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("installWindowCloseHandler: the intercept hook can keep the app running", () => {
  const exits: number[] = [];
  let hold = true;
  const win = installWindowCloseHandler(
    EventTarget,
    (c) => void exits.push(c),
    (e) => {
      if (hold) e.preventDefault();
      return hold;
    },
  ) as EventTarget;
  const first = new Event("close", { cancelable: true });
  win.dispatchEvent(first);
  assert(first.defaultPrevented);
  assertEquals(exits, []);
  hold = false;
  win.dispatchEvent(new Event("close", { cancelable: true }));
  assertEquals(exits, [0]);
});

// --- initial-window settings ---------------------------------------------------------

Deno.test("window settings: resolved from desktop.window / titleBar / backdrop / min / max", () => {
  assertEquals(resolveDesktopWindowSettings(undefined), {});
  assertEquals(
    resolveDesktopWindowSettings({
      window: { width: 1200.6, height: 800, title: "App", resizable: false },
      titleBar: "hiddenInset",
      backdrop: "vibrancy",
      minSize: { width: 640, height: 480 },
      maxSize: { width: 2000, height: 1600 },
    }),
    {
      width: 1201,
      height: 800,
      title: "App",
      resizable: false,
      titleBar: "hiddenInset",
      backdrop: "vibrancy",
      minSize: { width: 640, height: 480 },
      maxSize: { width: 2000, height: 1600 },
    },
  );
  for (
    const bad of [
      { window: { width: 0 } },
      { window: { title: 3 } },
      { window: "big" },
      { titleBar: "transparent" },
      { backdrop: "blur" },
      { minSize: { width: 10 } },
      { minSize: { width: 900, height: 900 }, maxSize: { width: 800, height: 1000 } },
    ]
  ) {
    assertThrows(() => resolveDesktopWindowSettings(bad), Error, "desktop.");
  }
});

Deno.test("window settings: applied to the pinned runtime's window", () => {
  const win = new FakeWindow();
  const warnings: string[] = [];
  applyDesktopWindowSettings(win, {
    width: 1000,
    title: "T",
    resizable: false,
    titleBar: "hidden",
    backdrop: "mica",
    minSize: { width: 300, height: 200 },
    maxSize: { width: 3000, height: 2000 },
  }, (m) => void warnings.push(m));
  assertEquals(win.calls, [
    ["setMinimumSize", [300, 200]],
    ["setMaximumSize", [3000, 2000]],
    ["setSize", [1000, 600]],
    ["setTitle", ["T"]],
    ["setResizable", [false]],
    ["setTitleBarStyle", ["hidden"]],
    ["setBackgroundMaterial", ["mica"]],
  ]);
  assertEquals(warnings, []);
  const vib = new FakeWindow();
  applyDesktopWindowSettings(vib, { backdrop: "vibrancy", titleBar: "default" }, () => {});
  assertEquals(vib.calls, [["setVibrancy", ["under-window"]]]);
});

Deno.test("window settings: the stock runtime applies the basics and warns for the rest", () => {
  const win = new StockWindow();
  const warnings: string[] = [];
  applyDesktopWindowSettings(win, {
    width: 900,
    height: 700,
    title: "T",
    titleBar: "hidden",
    minSize: { width: 1, height: 1 },
  }, (m) => void warnings.push(m));
  assertEquals(win.calls, [["setSize", [900, 700]], ["setTitle", ["T"]]]);
  assertEquals(warnings.length, 2);
  assert(warnings.every((w) => w.includes("pinned")));
  // Outside the desktop runtime: nothing to apply, nothing thrown.
  applyDesktopWindowSettings(undefined, { width: 1 });
});

Deno.test("resolver: the window settings and app folders reach runDesktop", async () => {
  const r = await resolveDesktopCapabilities({
    desktop: { titleBar: "hiddenInset", minSize: { width: 500, height: 400 } },
  } as never);
  assertEquals(r.window, { titleBar: "hiddenInset", minSize: { width: 500, height: 400 } });
  assert(r.appDirs.data.length > 0);
  await assertRejects(
    () => resolveDesktopCapabilities({ desktop: { backdrop: "glass" } } as never),
    Error,
    "desktop.backdrop",
  );
});

Deno.test("window: capabilities carry the session probe's facts; unknown without the probe", async () => {
  const before = await setup().call("capabilities") as Record<string, unknown>;
  assertEquals([before.sessionType, before.cookieEncryption], ["unknown", "unknown"]);
  const probed = await setup({
    api: fakeApi({
      platformFeatures: () =>
        Promise.resolve({ os: "linux", sessionType: "wayland", cookieEncryption: "basic" }),
    }),
  }).call("capabilities") as Record<string, unknown>;
  assertEquals([probed.sessionType, probed.cookieEncryption], ["wayland", "basic"]);
  assertEquals(probed.closeGuard, true, "the window's own keys are unchanged");
});

Deno.test("window: unsupported says why (data.reason)", async () => {
  const win = new StockWindow();
  const ctl = createWindowController({ window: win, emit: () => {} });
  const call = (m: string, a: unknown = {}) =>
    Promise.resolve().then(() => ctl.capability.methods[m].handler(a, ctx()));
  const err = await assertRejects(() => call("maximize"), DesktopCapError);
  assertEquals(err.data, { reason: "this Deno Desktop runtime has no BrowserWindow.maximize" });
  const screens = await assertRejects(() => call("screens"), DesktopCapError);
  assert(
    String((screens.data as { reason?: unknown }).reason).includes("pinned runtime adds it"),
  );
  const none = createWindowController({ window: undefined, emit: () => {} });
  const noWin = await assertRejects(
    () => Promise.resolve().then(() => none.capability.methods.state.handler({}, ctx())),
    DesktopCapError,
  );
  assertEquals(noWin.data, { reason: "no window was adopted (not a desktop run)" });
});
