// The native title options (src/desktop/window-config.ts, window-registry.ts, app-windows.ts,
// caps/window.ts): `desktop.window.titleVisibility` (hide the title text, keep the OS's title bar)
// and `desktop.window.toolbarStyle` (macOS toolbar styles) — their values and combinations checked
// in the config validator, at launch and in a page's openWindow; applied to the main window and
// to opened windows after their title bar style; the page's `setTitleVisibility` /
// `setToolbarStyle` rejecting `unsupported` with the reason, or `validation` for a combination the
// runtime refuses; and the capability keys, `false` on a runtime that doesn't report them.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { createWindowController } from "../src/desktop/caps/window.ts";
import { type DesktopCapCtx, DesktopCapError } from "../src/desktop/extension.ts";
import type { DesktopAppApi, DesktopMenuItem } from "../src/desktop/launch-events.ts";
import type { RegistryWindow } from "../src/desktop/window-registry.ts";
import { openWindowSettings } from "../src/desktop/window-registry.ts";
import { setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import {
  applyDesktopWindowSettings,
  applyTitleOptions,
  type DesktopWindowSettings,
  resolveDesktopWindowSettings,
  TITLE_VISIBILITIES,
  titleOptionsProblem,
  titleOptionValuesProblem,
  TOOLBAR_STYLES,
} from "../src/desktop/window-config.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

/** A runtime window recording the chrome calls made on it. */
class FakeWin extends EventTarget implements RegistryWindow {
  static made: FakeWin[] = [];
  calls: string[] = [];
  menus: DesktopMenuItem[][] = [];
  visible = true;
  /** What setTitleVisibility / setToolbarStyle answer (the runtime's boolean). */
  answer = true;
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
  }
  hide() {
    this.visible = false;
  }
  focus() {}
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
  setSize() {}
  setBounds() {}
  setTitle() {}
  setApplicationMenu(menu: DesktopMenuItem[]) {
    this.menus.push(menu);
  }
  setTitleBarStyle(style: string): boolean {
    this.calls.push(`titleBar:${style}`);
    return true;
  }
  setTitleVisibility(visibility: string): boolean {
    this.calls.push(`titleVisibility:${visibility}`);
    return this.answer;
  }
  setToolbarStyle(style: string): boolean {
    this.calls.push(`toolbarStyle:${style}`);
    return this.answer;
  }
}

/** The title calls recorded on `win`, in order. */
const titleCalls = (win: FakeWin) =>
  win.calls.filter((c) => /^(titleBar|titleVisibility|toolbarStyle):/.test(c));

/** A desktop setup over a fake main window, wired as runDesktop wires it. */
function setup(windowSettings?: DesktopWindowSettings) {
  FakeWin.made = [];
  const main = new FakeWin();
  const warnings: string[] = [];
  const s = setUpDesktopWindows({
    window: main,
    BrowserWindow: FakeWin,
    api: Object.assign(new EventTarget(), {
      quitOnLastWindowClosed: true,
      screens: () => [],
    }) as DesktopAppApi & EventTarget,
    dock: undefined,
    emit: () => {},
    wantsTray: false,
    os: "darwin",
    exit: () => {},
    warn: (m) => void warnings.push(m),
    appSettings: { keepAlive: true },
    runtimeVersion: "3.0.0-denext.13",
    ...(windowSettings ? { windowSettings } : {}),
  });
  s.install();
  return { s, main, warnings };
}

// ---------------------------------------------------------------------------------------------
// Values and combinations
// ---------------------------------------------------------------------------------------------

Deno.test("title options: the values, and the combinations that can't be shown", () => {
  assertEquals([...TITLE_VISIBILITIES], ["visible", "hidden"]);
  assertEquals([...TOOLBAR_STYLES], ["automatic", "unified", "unifiedCompact", "expanded"]);
  assertEquals(
    titleOptionValuesProblem({ titleVisibility: "hidden", toolbarStyle: "unified" }),
    null,
  );
  assertEquals(titleOptionValuesProblem({ titleVisibility: "none" })?.[0], "titleVisibility");
  assertEquals(titleOptionValuesProblem({ toolbarStyle: "compact" })?.[0], "toolbarStyle");
  // Every toolbar style with the default and hiddenInset title bars, and the hidden title.
  for (const titleBar of ["default", "hiddenInset"] as const) {
    for (const toolbarStyle of TOOLBAR_STYLES) {
      assertEquals(
        titleOptionsProblem({ titleBar, toolbarStyle, titleVisibility: "hidden" }),
        null,
      );
    }
  }
  // The hidden title bar has no toolbar: only "automatic".
  assertEquals(titleOptionsProblem({ titleBar: "hidden", toolbarStyle: "automatic" }), null);
  const hidden = titleOptionsProblem({ titleBar: "hidden", toolbarStyle: "unified" });
  assertEquals(hidden?.[0], "toolbarStyle");
  assertStringIncludes(hidden?.[1] ?? "", '"hiddenInset"');
  // A frameless window has no title bar; the defaults still combine.
  assertEquals(
    titleOptionsProblem({ frameless: true, titleVisibility: "hidden" })?.[0],
    "titleVisibility",
  );
  assertEquals(
    titleOptionsProblem({ frameless: true, toolbarStyle: "expanded" })?.[0],
    "toolbarStyle",
  );
  assertEquals(
    titleOptionsProblem({ frameless: true, titleVisibility: "visible", toolbarStyle: "automatic" }),
    null,
  );
});

Deno.test("title options: resolved at launch, failing fast on a bad value or combination", () => {
  assertEquals(
    resolveDesktopWindowSettings({
      titleBar: "hiddenInset",
      window: { titleVisibility: "hidden", toolbarStyle: "unifiedCompact" },
    }),
    { titleBar: "hiddenInset", titleVisibility: "hidden", toolbarStyle: "unifiedCompact" },
  );
  assertThrows(
    () => resolveDesktopWindowSettings({ window: { titleVisibility: "off" } }),
    Error,
    "desktop.window.titleVisibility",
  );
  assertThrows(
    () => resolveDesktopWindowSettings({ window: { toolbarStyle: "compact" } }),
    Error,
    "desktop.window.toolbarStyle",
  );
  assertThrows(
    () => resolveDesktopWindowSettings({ titleBar: "hidden", window: { toolbarStyle: "unified" } }),
    Error,
    "desktop.window.toolbarStyle",
  );
  assertThrows(
    () => resolveDesktopWindowSettings({ window: { frameless: true, titleVisibility: "hidden" } }),
    Error,
    "a frameless window has none",
  );
});

Deno.test("title options: checked by the config validator", () => {
  validateDenextConfig({
    desktop: {
      titleBar: "hiddenInset",
      window: { titleVisibility: "hidden", toolbarStyle: "expanded" },
    },
  });
  const bad = (desktop: unknown) => () =>
    validateDenextConfig({ desktop } as unknown as DenextConfig);
  assertThrows(bad({ window: { titleVisibility: true } }), Error, "desktop.window.titleVisibility");
  assertThrows(bad({ window: { toolbarStyle: "tall" } }), Error, "desktop.window.toolbarStyle");
  assertThrows(
    bad({ titleBar: "hidden", window: { toolbarStyle: "unified" } }),
    Error,
    "desktop.window.toolbarStyle",
  );
  assertThrows(
    bad({ window: { frameless: true, toolbarStyle: "unified" } }),
    Error,
    "desktop.window.toolbarStyle",
  );
});

// ---------------------------------------------------------------------------------------------
// Applied to the main window and to opened windows
// ---------------------------------------------------------------------------------------------

Deno.test("title options: the main window takes them after its title bar style", () => {
  const win = new FakeWin();
  applyDesktopWindowSettings(win, {
    titleBar: "hiddenInset",
    titleVisibility: "hidden",
    toolbarStyle: "unifiedCompact",
  });
  assertEquals(titleCalls(win), [
    "titleBar:hiddenInset",
    "titleVisibility:hidden",
    "toolbarStyle:unifiedCompact",
  ]);
  // The defaults are what a new window has: nothing to call.
  const plain = new FakeWin();
  applyDesktopWindowSettings(plain, { titleVisibility: "visible", toolbarStyle: "automatic" });
  assertEquals(titleCalls(plain), []);
  // A frameless window has no title bar.
  const frameless = new FakeWin();
  applyDesktopWindowSettings(frameless, { frameless: true, titleVisibility: "hidden" });
  assertEquals(titleCalls(frameless), []);
  // The runtime answering false (no such feature on this OS) is not an error.
  const refused = new FakeWin();
  refused.answer = false;
  const warnings: string[] = [];
  applyTitleOptions(refused, { titleVisibility: "hidden", toolbarStyle: "unified" }, (m) => {
    warnings.push(m);
  });
  assertEquals(warnings, []);
});

Deno.test("title options: a runtime without the setters warns, naming the method", () => {
  const warnings: string[] = [];
  applyDesktopWindowSettings({ setTitle() {} }, {
    titleVisibility: "hidden",
    toolbarStyle: "expanded",
  }, (m) => void warnings.push(m));
  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings[0], "desktop.window.titleVisibility");
  assertStringIncludes(warnings[0], "BrowserWindow.setTitleVisibility");
  assertStringIncludes(warnings[1], "desktop.window.toolbarStyle");
  assertStringIncludes(warnings[1], "BrowserWindow.setToolbarStyle");
});

Deno.test("title options: opened windows inherit them; a window's own wins", () => {
  const { s, main } = setup({
    titleBar: "hiddenInset",
    titleVisibility: "hidden",
    toolbarStyle: "unified",
  });
  assertEquals(titleCalls(main), [
    "titleBar:hiddenInset",
    "titleVisibility:hidden",
    "toolbarStyle:unified",
  ]);
  s.windows.open({ url: "/a" });
  assertEquals(titleCalls(FakeWin.made[1]), [
    "titleBar:hiddenInset",
    "titleVisibility:hidden",
    "toolbarStyle:unified",
  ]);
  s.windows.open({ url: "/b", titleBar: "default", toolbarStyle: "expanded" });
  // "default" is what a new window has (applyTitleBarStyle skips it).
  assertEquals(titleCalls(FakeWin.made[2]), [
    "titleVisibility:hidden",
    "toolbarStyle:expanded",
  ]);
  // A window's own defaults opt out of the inherited ones.
  s.windows.open({ url: "/c", titleVisibility: "visible", toolbarStyle: "automatic" });
  assertEquals(titleCalls(FakeWin.made[3]), ["titleBar:hiddenInset"]);
  // A frameless window ignores the inherited options (it has no title bar).
  s.windows.open({ url: "/d", frameless: true });
  assertEquals(titleCalls(FakeWin.made[4]), []);
});

Deno.test("title options: openWindow refuses what can't be shown, before a window opens", () => {
  assertEquals(
    openWindowSettings({ url: "/", titleVisibility: "hidden", toolbarStyle: "unified" }),
    {
      ...openWindowSettings({ url: "/" }),
      titleVisibility: "hidden",
      toolbarStyle: "unified",
    },
  );
  assertThrows(
    () => openWindowSettings({ url: "/", titleVisibility: "gone" }),
    Error,
    "titleVisibility must be one of",
  );
  assertThrows(
    () => openWindowSettings({ url: "/", toolbarStyle: 3 }),
    Error,
    "toolbarStyle must be one of",
  );
  const { s } = setup({ titleBar: "hidden" });
  const before = FakeWin.made.length;
  // The inherited "hidden" title bar has no toolbar.
  assertThrows(() => s.windows.open({ url: "/a", toolbarStyle: "unified" }), Error, "toolbarStyle");
  // A frameless window's own title options.
  assertThrows(
    () => s.windows.open({ url: "/b", frameless: true, titleVisibility: "hidden" }),
    Error,
    "frameless",
  );
  assertEquals(FakeWin.made.length, before);
  // With its own "hiddenInset" it is fine.
  s.windows.open({ url: "/c", titleBar: "hiddenInset", toolbarStyle: "unified" });
  assertEquals(FakeWin.made.length, before + 1);
});

// ---------------------------------------------------------------------------------------------
// The page's setters and the capability keys
// ---------------------------------------------------------------------------------------------

const ctx = (): DesktopCapCtx => ({
  emit: () => {},
  appSupportDir: "",
  runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
  secureStore: {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  },
  pickedPath: () => {
    throw new Error("no picked paths in tests");
  },
  os: "darwin",
  signal: new AbortController().signal,
});

/** A window controller over `win`, with the runtime reporting `caps`. */
function controller(win: unknown, caps: Record<string, boolean> | undefined) {
  const api = Object.assign(new EventTarget(), {
    screens: () => [],
    ...(caps ? { windowCapabilities: () => caps } : {}),
    quit: () => true,
  }) as DesktopAppApi & EventTarget;
  const ctl = createWindowController({ window: win as never, api, emit: () => {} });
  return (method: string, args: unknown = {}) =>
    Promise.resolve().then(() => ctl.capability.methods[method].handler(args, ctx()));
}

/** The DesktopCapError `fn` rejects with. */
async function rejection(fn: () => Promise<unknown>): Promise<DesktopCapError> {
  const err = await assertRejects(fn);
  assert(err instanceof DesktopCapError, String(err));
  return err;
}

Deno.test("setTitleVisibility: applied, or unsupported with the reason", async () => {
  const win = new FakeWin();
  const call = controller(win, { titleVisibility: true, toolbarStyle: true });
  assertEquals(await call("setTitleVisibility", { visibility: "hidden" }), null);
  assertEquals(await call("setTitleVisibility", { visibility: "visible" }), null);
  assertEquals(titleCalls(win), ["titleVisibility:hidden", "titleVisibility:visible"]);
  const invalid = await rejection(() => call("setTitleVisibility", { visibility: "off" }));
  assertEquals(invalid.code, "validation");
  // The OS can (the capability holds) but this window can't: frameless.
  win.answer = false;
  const frameless = await rejection(() => call("setTitleVisibility", { visibility: "hidden" }));
  assertEquals(frameless.code, "unsupported");
  assertStringIncludes(frameless.message, "frameless");
  // The session can't (a Linux window manager's decorations): the reason says why.
  const ssd = new FakeWin();
  ssd.answer = false;
  const none = await rejection(() =>
    controller(ssd, { titleVisibility: false })("setTitleVisibility", { visibility: "hidden" })
  );
  assertEquals(none.code, "unsupported");
  assertStringIncludes(
    none.message,
    Deno.build.os === "linux" ? "client-side decorations" : "no title visibility",
  );
  // A runtime without the setter.
  const stock = await rejection(() =>
    controller({ setTitle() {} }, undefined)("setTitleVisibility", { visibility: "hidden" })
  );
  assertEquals(stock.code, "unsupported");
  assertStringIncludes(stock.message, "BrowserWindow.setTitleVisibility");
});

Deno.test("setToolbarStyle: applied, invalid for a refused combination, else unsupported", async () => {
  const win = new FakeWin();
  const call = controller(win, { titleVisibility: true, toolbarStyle: true });
  assertEquals(await call("setToolbarStyle", { style: "unifiedCompact" }), null);
  assertEquals(titleCalls(win), ["toolbarStyle:unifiedCompact"]);
  assertEquals(
    (await rejection(() => call("setToolbarStyle", { style: "tall" }))).code,
    "validation",
  );
  // The runtime refuses it with the capability there: the window's title bar can't take one.
  win.answer = false;
  const refused = await rejection(() => call("setToolbarStyle", { style: "unified" }));
  assertEquals(refused.code, "validation");
  assertStringIncludes(refused.message, '"hiddenInset"');
  // Off macOS (no capability): unsupported, with the reason.
  const other = new FakeWin();
  other.answer = false;
  const off = await rejection(() =>
    controller(other, { toolbarStyle: false })("setToolbarStyle", { style: "unified" })
  );
  assertEquals(off.code, "unsupported");
  assertStringIncludes(off.message, "toolbar styles");
  const stock = await rejection(() =>
    controller({ setTitle() {} }, undefined)("setToolbarStyle", { style: "unified" })
  );
  assertEquals(stock.code, "unsupported");
  assertStringIncludes(stock.message, "BrowserWindow.setToolbarStyle");
});

Deno.test("capabilities: titleVisibility / toolbarStyle are false unless the runtime reports them", async () => {
  const old = await controller(new FakeWin(), { state: true })("capabilities") as Record<
    string,
    unknown
  >;
  assertEquals(old.titleVisibility, false);
  assertEquals(old.toolbarStyle, false);
  const pinned = await controller(new FakeWin(), { titleVisibility: true, toolbarStyle: true })(
    "capabilities",
  ) as Record<string, unknown>;
  assertEquals(pinned.titleVisibility, true);
  assertEquals(pinned.toolbarStyle, true);
});
