// What Deno Desktop runtime 3.0.0-denext.6 adds to the windowing / tray layer (Brainwires/deno
// DENEXT.md item 183), against fakes of the runtime: tray events with the `TrayMouseEvent` detail
// (`contextmenu`, `auxclick`, `mouseenter` / `mouseleave`, a primary-only `click`), `popUpMenu`,
// `Deno.Tray.capabilities()` in `appCapabilities`, the macOS activation policy (`Deno.dock`, the
// config key, `laufey-launch.json` and `LAUFEY_ACTIVATION_POLICY`), the `overlay` / `skipTaskbar`
// window options, the new window capability keys, and the Linux packages' recommendations.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { DesktopCapability, DesktopCapCtx } from "../src/desktop/extension.ts";
import type { DesktopMenuItem } from "../src/desktop/launch-events.ts";
import {
  type ActivationPolicy,
  createAppController,
  type DockLike,
  type TrayLike,
} from "../src/desktop/caps/app.ts";
import {
  isPrimaryClick,
  parseTrayMouseDetail,
  TRAY_EVENT_TYPES,
  trayCapabilitiesOf,
  trayMouseDetail,
} from "../src/desktop/tray-events.ts";
import { startBackendTray } from "../src/desktop/backend-tray.ts";
import { noDesktopWindows, setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import { createWindowController } from "../src/desktop/caps/window.ts";
import { createWindowRegistry, type RegistryWindow } from "../src/desktop/window-registry.ts";
import { resolveDesktopAppSettings } from "../src/desktop/window-config.ts";
import {
  desktopActivationPolicy,
  laufeyLaunchEnv,
  unpackagedLaunchEnv,
  writeLaufeyLaunchConfig,
} from "../src/build/desktop-app-config.ts";
import { activationPolicyRuntime } from "../src/build/desktop-launch-policy.ts";
import { FIRST_OVERLAY_TRAY_RUNTIME, supportsOverlayTray } from "../src/build/deno-version.ts";
import { debControl, rpmSpec } from "../src/build/desktop-installers.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import {
  appCapabilities,
  getActivationPolicy,
  getTray,
  setActivationPolicy,
} from "../src/desktop/app.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";
import { fakePlugin, inShell, withGlobals } from "./helpers/mobile-fakes.ts";
import { speak, stopSpeaking } from "../src/mobile/speech.ts";

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

/** A runtime `TrayMouseEvent` of `type`. */
function mouse(
  type: string,
  init: { button?: string; x?: number | null; y?: number | null; double?: boolean } = {},
  modifiers: Record<string, boolean> = {},
): Event {
  return Object.assign(new Event(type), {
    button: init.button ?? "left",
    modifiers: { shift: false, ctrl: false, alt: false, meta: false, ...modifiers },
    x: init.x === undefined ? 100 : init.x,
    y: init.y === undefined ? 5 : init.y,
    double: init.double === true,
  });
}

const PNG = "iVBORw0KGgo=";

/** A `Deno.Tray` of runtime 3.0.0-denext.6: `popUpMenu` and a static `capabilities()`. */
class NewTray extends EventTarget implements TrayLike {
  static made: NewTray[] = [];
  static caps: unknown = {
    click: true,
    doubleClick: true,
    rightClick: true,
    middleClick: true,
    hover: true,
    modifiers: true,
    position: true,
    popUpMenu: true,
  };
  static capabilities() {
    return NewTray.caps;
  }
  menu: DesktopMenuItem[] | null = null;
  popped = 0;
  constructor() {
    super();
    NewTray.made.push(this);
  }
  setIcon() {}
  setTooltip() {}
  setMenu(menu: DesktopMenuItem[] | null) {
    this.menu = menu;
  }
  popUpMenu() {
    this.popped++;
    return this.menu !== null;
  }
  destroy() {}
}

/** A `Deno.Tray` before 3.0.0-denext.6: no `popUpMenu`, no `capabilities()`. */
class OldTray extends EventTarget implements TrayLike {
  static made: OldTray[] = [];
  constructor() {
    super();
    OldTray.made.push(this);
  }
  setIcon() {}
  setTooltip() {}
  setMenu() {}
  destroy() {}
}

/** A `Deno.dock` with (or, `policy: false`, without) the activation policy. */
class FakeDock extends EventTarget implements DockLike {
  visible: boolean[] = [];
  policies: string[] = [];
  current: ActivationPolicy | null = "regular";
  constructor(withPolicy = true) {
    super();
    if (!withPolicy) {
      Object.assign(this, { setActivationPolicy: undefined, getActivationPolicy: undefined });
    }
  }
  setBadge() {}
  bounce() {}
  setVisible(visible: boolean) {
    this.visible.push(visible);
  }
  setActivationPolicy(policy: ActivationPolicy) {
    this.policies.push(policy);
    this.current = policy;
    return true;
  }
  getActivationPolicy() {
    return this.current;
  }
}

/** An app controller over `Tray` / `dock` with two windows. */
function appCtl(
  Tray: typeof NewTray | typeof OldTray = NewTray,
  dock: FakeDock = new FakeDock(),
  os = "darwin",
) {
  NewTray.made = [];
  OldTray.made = [];
  const ctl = createAppController({
    window: Object.assign(new EventTarget(), { isVisible: () => true }),
    emit: () => {},
    Tray,
    dock,
    os,
    windows: () => ["main", "window-1"],
  });
  ctl.install();
  return { ctl, cap: ctl.capability, dock };
}

// --- tray-events -------------------------------------------------------------------------------

Deno.test("trayMouseDetail: the runtime's detail; none from an older runtime's plain event", () => {
  assertEquals(
    trayMouseDetail(mouse("click", { button: "right", x: 3.5, y: null }, { alt: true })),
    {
      button: "right",
      modifiers: { shift: false, ctrl: false, alt: true, meta: false },
      x: 3.5,
      y: null,
      double: false,
    },
  );
  assertEquals(trayMouseDetail(new Event("click")), null);
  assertEquals(trayMouseDetail(Object.assign(new Event("click"), { button: "back" })), null);
  // The DOM-style flags and coordinates when there is no `modifiers` / `x`.
  const dom = Object.assign(new Event("click"), {
    button: "middle",
    shiftKey: true,
    metaKey: true,
    screenX: 7,
    screenY: Number.NaN,
    double: true,
  });
  assertEquals(trayMouseDetail(dom), {
    button: "middle",
    modifiers: { shift: true, ctrl: false, alt: false, meta: true },
    x: 7,
    y: null,
    double: true,
  });
  assert(isPrimaryClick(null));
  assert(!isPrimaryClick(trayMouseDetail(mouse("click", { button: "right" }))));
  assertEquals(TRAY_EVENT_TYPES.length, 6);
});

Deno.test("parseTrayMouseDetail: checks a detail from the wire", () => {
  assertEquals(parseTrayMouseDetail(null), null);
  assertEquals(parseTrayMouseDetail({ button: "up" }), null);
  assertEquals(parseTrayMouseDetail({ button: "left", modifiers: { ctrl: true }, x: "1" }), {
    button: "left",
    modifiers: { shift: false, ctrl: true, alt: false, meta: false },
    x: null,
    y: null,
    double: false,
  });
  assertEquals(parseTrayMouseDetail({ button: "right", x: 1, y: 2, double: true })?.double, true);
});

Deno.test("trayCapabilitiesOf: Tray.capabilities() where the runtime has it, clicks only before", () => {
  assertEquals(trayCapabilitiesOf(NewTray, true).hover, true);
  assertEquals(trayCapabilitiesOf(NewTray, false).click, false);
  assertEquals(trayCapabilitiesOf(OldTray, true), {
    click: true,
    doubleClick: true,
    rightClick: false,
    middleClick: false,
    hover: false,
    modifiers: false,
    position: false,
    popUpMenu: false,
  });
  assertEquals(trayCapabilitiesOf(undefined, false).doubleClick, false);
  const throwing = Object.assign(function () {}, {
    capabilities: () => {
      throw new Error("x");
    },
  });
  assertEquals(trayCapabilitiesOf(throwing, true).click, true);
  const nothing = Object.assign(function () {}, { capabilities: () => null });
  assertEquals(trayCapabilitiesOf(nothing, true).popUpMenu, false);
});

// --- the app capability ------------------------------------------------------------------------

Deno.test("app: a right click is contextmenu, not click; every event carries its detail", async () => {
  const { cap } = appCtl();
  const { id } = await call(cap, "createTray", { icon: PNG }, "window-1") as { id: string };
  const tray = NewTray.made[0];
  tray.dispatchEvent(mouse("click", { button: "right" }));
  tray.dispatchEvent(mouse("contextmenu", { button: "right" }));
  tray.dispatchEvent(mouse("click", { button: "middle" }));
  tray.dispatchEvent(mouse("auxclick", { button: "middle" }));
  tray.dispatchEvent(mouse("click", {}, { shift: true }));
  tray.dispatchEvent(mouse("dblclick", { double: true }));
  tray.dispatchEvent(mouse("mouseenter", { x: null, y: null }));
  tray.dispatchEvent(mouse("mouseleave"));
  const taken = await call(cap, "take", {}, "window-1") as Array<
    { event: string; tray: string; detail?: { button: string; modifiers: { shift: boolean } } }
  >;
  assertEquals(taken.map((a) => a.event), [
    "contextmenu",
    "auxclick",
    "click",
    "doubleClick",
    "mouseenter",
    "mouseleave",
  ]);
  assert(taken.every((a) => a.tray === id));
  assertEquals(taken[0].detail?.button, "right");
  assertEquals(taken[2].detail?.modifiers.shift, true);
});

Deno.test("app: an older runtime's plain click and dblclick still reach the page, with no detail", async () => {
  const { cap } = appCtl(OldTray);
  await call(cap, "createTray", { icon: PNG });
  OldTray.made[0].dispatchEvent(new Event("click"));
  OldTray.made[0].dispatchEvent(new Event("dblclick"));
  assertEquals(await call(cap, "take"), [
    { source: "tray", tray: "1", event: "click" },
    { source: "tray", tray: "1", event: "doubleClick" },
  ]);
  assertEquals(await call(cap, "popUpMenu", { id: "1" }), { shown: false });
});

Deno.test("app: popUpMenu opens the tray's menu where the runtime can", async () => {
  const { cap } = appCtl();
  await call(cap, "createTray", { icon: PNG });
  assertEquals(await call(cap, "popUpMenu", { id: "1" }), { shown: false }); // no menu yet
  await call(cap, "updateTray", { id: "1", menu: [{ id: "a", label: "A" }] });
  assertEquals(await call(cap, "popUpMenu", { id: "1" }), { shown: true });
  assertEquals(NewTray.made[0].popped, 2);
  assertEquals(await codeOf(call(cap, "popUpMenu", { id: "nope" })), "validation");
});

Deno.test("app: capabilities fold in Tray.capabilities() and the activation policy", async () => {
  const { cap } = appCtl();
  const caps = await call(cap, "capabilities") as Record<string, unknown>;
  assertEquals(
    [caps.trayRightClick, caps.trayHover, caps.trayPopUpMenu, caps.activationPolicy],
    [true, true, true, true],
  );
  const old = await call(appCtl(OldTray, new FakeDock(false)).cap, "capabilities") as Record<
    string,
    unknown
  >;
  assertEquals(
    [old.trayClick, old.trayRightClick, old.trayPopUpMenu, old.activationPolicy],
    [true, false, false, false],
  );
  const linux = await call(appCtl(NewTray, new FakeDock(), "linux").cap, "capabilities") as Record<
    string,
    unknown
  >;
  assertEquals(linux.activationPolicy, false);
});

Deno.test("app: setActivationPolicy / getActivationPolicy on macOS; Dock visibility before denext.6", async () => {
  const mac = appCtl();
  assertEquals(await call(mac.cap, "setActivationPolicy", { policy: "accessory" }), {
    applied: true,
  });
  assertEquals(mac.dock.policies, ["accessory"]);
  assertEquals(await call(mac.cap, "getActivationPolicy"), { policy: "accessory" });
  assertEquals(await codeOf(call(mac.cap, "setActivationPolicy", { policy: "x" })), "validation");
  // A runtime before 3.0.0-denext.6: regular / accessory show / hide the Dock icon.
  const old = appCtl(NewTray, new FakeDock(false));
  assertEquals(await call(old.cap, "setActivationPolicy", { policy: "regular" }), {
    applied: true,
  });
  assertEquals(old.dock.visible, [true]);
  assertEquals(await call(old.cap, "setActivationPolicy", { policy: "prohibited" }), {
    applied: false,
  });
  assertEquals(await call(old.cap, "getActivationPolicy"), { policy: null });
  // Windows and Linux have no policy.
  const linux = appCtl(NewTray, new FakeDock(), "linux");
  assertEquals(await call(linux.cap, "setActivationPolicy", { policy: "regular" }), {
    applied: false,
  });
  assertEquals(await call(linux.cap, "getActivationPolicy"), { policy: null });
  // An unexpected answer from the runtime reads as none.
  mac.dock.current = "weird" as ActivationPolicy;
  assertEquals(await call(mac.cap, "getActivationPolicy"), { policy: null });
});

// --- the backend tray ---------------------------------------------------------------------------

Deno.test("backend tray: click handlers hear the primary button with detail; on() and popUpMenu", async () => {
  const { ctl } = appCtl();
  const heard: string[] = [];
  const handle = await startBackendTray({
    app: ctl,
    appUrl: (p) => p,
    readFile: () => Promise.resolve(new Uint8Array([1])),
    screens: () => [],
    warn: () => {},
    settings: { icon: "/tray.png", menu: [{ id: "q", label: "Quit" }] },
    options: {
      onClick: (d) => void heard.push(`click:${d?.button ?? "none"}`),
      onDoubleClick: (d) => void heard.push(`dbl:${d?.double}`),
      onContextMenu: (d) => void heard.push(`menu:${d?.x}`),
    },
  });
  assert(handle && !("reason" in handle));
  const tray = NewTray.made[0];
  const offHover = handle.on("mouseenter", (d) => void heard.push(`enter:${d === null}`));
  tray.dispatchEvent(mouse("click", { button: "right" }));
  tray.dispatchEvent(mouse("contextmenu", { button: "right", x: 42 }));
  tray.dispatchEvent(mouse("click"));
  tray.dispatchEvent(mouse("dblclick", { double: true }));
  tray.dispatchEvent(new Event("mouseenter"));
  offHover();
  tray.dispatchEvent(new Event("mouseenter"));
  assertEquals(heard, ["menu:42", "click:left", "dbl:true", "enter:true"]);
  assertEquals(handle.popUpMenu(), true);
  assertEquals(tray.popped, 1);
});

Deno.test("backend tray: on macOS a plain left click opens a panel-less tray's menu, unless a click handler takes it", async () => {
  const start = (os: string, options?: { onClick?: () => void }) => {
    const { ctl } = appCtl();
    return startBackendTray({
      app: ctl,
      appUrl: (p) => p,
      readFile: () => Promise.resolve(new Uint8Array([1])),
      screens: () => [],
      warn: () => {},
      os,
      settings: { icon: "/tray.png", menu: [{ id: "q", label: "Quit" }] },
      ...(options ? { options } : {}),
    });
  };
  const mac = await start("darwin");
  assert(mac && !("reason" in mac));
  const tray = NewTray.made[0];
  tray.dispatchEvent(mouse("click"));
  assertEquals(tray.popped, 1, "a plain left click opens the menu");
  // Not a right click (the OS opens it), a modifier click, or a double click's second click.
  tray.dispatchEvent(mouse("click", { button: "right" }));
  tray.dispatchEvent(mouse("click", {}, { ctrl: true }));
  tray.dispatchEvent(mouse("click", {}, { meta: true }));
  tray.dispatchEvent(mouse("click", { double: true }));
  tray.dispatchEvent(new Event("click")); // an older runtime: no detail, no popUpMenu
  assertEquals(tray.popped, 1);
  // A backend click handler takes the left click; unsubscribing gives it back (twice is a no-op).
  const off = mac.onClick(() => {});
  tray.dispatchEvent(mouse("click"));
  assertEquals(tray.popped, 1);
  off();
  off();
  tray.dispatchEvent(mouse("click"));
  assertEquals(tray.popped, 2);
  // runDesktop({ tray: { onClick } }) too.
  const heard: string[] = [];
  await start("darwin", { onClick: () => void heard.push("click") });
  NewTray.made[0].dispatchEvent(mouse("click"));
  assertEquals([NewTray.made[0].popped, heard], [0, ["click"]]);
  // Windows and Linux keep the left click to the app (as Electron does).
  await start("windows");
  NewTray.made[0].dispatchEvent(mouse("click"));
  assertEquals(NewTray.made[0].popped, 0);
});

Deno.test("backend tray: popUpMenu is false on a runtime without it", async () => {
  const { ctl } = appCtl(OldTray);
  const handle = await startBackendTray({
    app: ctl,
    appUrl: (p) => p,
    readFile: () => Promise.resolve(new Uint8Array([1])),
    screens: () => [],
    warn: () => {},
    settings: { icon: "/tray.png" },
  });
  assert(handle && !("reason" in handle));
  assertEquals(handle.popUpMenu(), false);
});

// --- setup: the activation policy at launch and for desktop.ts -------------------------------

/** A main window. */
class Win extends EventTarget implements RegistryWindow {
  calls: string[] = [];
  constructor(readonly options?: Record<string, unknown>) {
    super();
  }
  show() {}
  hide() {
    this.calls.push("hide");
  }
  navigate(url: string) {
    this.calls.push(`navigate:${url}`);
  }
  setSkipTaskbar(skip: boolean) {
    this.calls.push(`skip:${skip}`);
  }
}

Deno.test("setup: an accessory policy hides the Dock icon at launch; desktop.ts sets the policy", () => {
  const dock = new FakeDock();
  const s = setUpDesktopWindows({
    window: new Win(),
    dock,
    os: "darwin",
    emit: () => {},
    wantsTray: true,
    appSettings: { activationPolicy: "accessory" },
  });
  assertEquals(dock.visible, [false]);
  assertEquals(s.setActivationPolicy("regular"), true);
  assertEquals(dock.policies, ["regular"]);
  assertEquals(s.getActivationPolicy(), "regular");
  // Regular at launch leaves the Dock alone.
  const regular = new FakeDock();
  setUpDesktopWindows({
    window: new Win(),
    dock: regular,
    os: "darwin",
    emit: () => {},
    wantsTray: false,
    appSettings: { activationPolicy: "regular" },
  });
  assertEquals(regular.visible, []);
  // Before 3.0.0-denext.6 the policy falls back to the Dock icon's visibility.
  const old = new FakeDock(false);
  const o = setUpDesktopWindows({
    window: new Win(),
    dock: old,
    os: "darwin",
    emit: () => {},
    wantsTray: false,
  });
  assertEquals(o.setActivationPolicy("accessory"), true);
  assertEquals(o.setActivationPolicy("prohibited"), false);
  assertEquals(old.visible, [false]);
  assertEquals(o.getActivationPolicy(), null);
  // Elsewhere there is no policy.
  const win = setUpDesktopWindows({
    window: new Win(),
    dock: new FakeDock(),
    os: "windows",
    emit: () => {},
    wantsTray: false,
  });
  assertEquals(win.setActivationPolicy("accessory"), false);
  assertEquals(win.getActivationPolicy(), null);
  const headless = noDesktopWindows();
  assertEquals(headless.setActivationPolicy("regular"), false);
  assertEquals(headless.getActivationPolicy(), null);
});

Deno.test("registry: overlay and skipTaskbar are creation options (runtime 3.0.0-denext.6)", () => {
  const made: Win[] = [];
  class Ctor extends Win {
    constructor(options?: Record<string, unknown>) {
      super(options);
      made.push(this);
    }
  }
  const reg = createWindowRegistry({
    BrowserWindow: Ctor,
    appUrl: (p) => p,
    emit: () => {},
    keepAlive: () => true,
    exit: () => {},
    controller: (window, _id, closed) => createWindowController({ window, emit: () => {}, closed }),
  });
  reg.adopt(new Win(), "main");
  reg.open({ url: "/hud", overlay: true, skipTaskbar: false });
  assertEquals(made[0].options, { overlay: true, skipTaskbar: false });
  assertThrows(() => reg.open({ url: "/x", overlay: "yes" }), Error, "overlay must be a boolean");
});

Deno.test("window capabilities: the denext.6 keys default false until the runtime reports them", async () => {
  const ctl = createWindowController({ window: new Win(), emit: () => {}, closed: () => {} });
  const caps = await call(ctl.capability, "capabilities") as Record<string, unknown>;
  assertEquals([caps.visibleOnFullScreen, caps.layerShell, caps.activationPolicy], [
    false,
    false,
    false,
  ]);
  const reported = createWindowController({
    window: new Win(),
    api: { windowCapabilities: () => ({ layerShell: true, visibleOnFullScreen: true }) } as never,
    emit: () => {},
    closed: () => {},
  });
  const r = await call(reported.capability, "capabilities") as Record<string, unknown>;
  assertEquals([r.layerShell, r.visibleOnFullScreen], [true, true]);
});

// --- config, launch file, env ------------------------------------------------------------------

Deno.test("config: desktop.app.activationPolicy is regular or accessory, never regular with no Dock", () => {
  assertEquals(resolveDesktopAppSettings({ app: { activationPolicy: "accessory" } }), {
    activationPolicy: "accessory",
  });
  assertEquals(resolveDesktopAppSettings({ app: { dock: false } }), { dock: false });
  assertThrows(
    () => resolveDesktopAppSettings({ app: { activationPolicy: "prohibited" } }),
    Error,
    "app.activationPolicy",
  );
  const fails = (app: unknown) => {
    try {
      validateDenextConfig({ desktop: { app } } as DenextConfig);
      return "";
    } catch (err) {
      return String((err as Error).message);
    }
  };
  assertEquals(fails({ activationPolicy: "accessory", dock: false }), "");
  assert(fails({ activationPolicy: "sometimes" }).includes("desktop.app.activationPolicy"));
  assert(fails({ activationPolicy: "regular", dock: false }).includes("dock is false"));
});

Deno.test("desktopActivationPolicy: the configured one, else accessory for dock false", () => {
  assertEquals(
    desktopActivationPolicy({ desktop: { app: { activationPolicy: "regular" } } }),
    "regular",
  );
  assertEquals(desktopActivationPolicy({ desktop: { app: { dock: false } } }), "accessory");
  assertEquals(desktopActivationPolicy({ desktop: { app: { dock: true } } }), undefined);
  assertEquals(desktopActivationPolicy({}), undefined);
});

Deno.test("launch env: LAUFEY_ACTIVATION_POLICY on macOS under a runtime that reads it", () => {
  const config = { desktop: { app: { dock: false } } };
  assertEquals(unpackagedLaunchEnv(config, "dev", "darwin", true), {
    LAUFEY_INSPECTABLE: "1",
    LAUFEY_ACTIVATION_POLICY: "accessory",
  });
  assertEquals(
    unpackagedLaunchEnv(config, "dev", "darwin", false).LAUFEY_ACTIVATION_POLICY,
    undefined,
  );
  assertEquals(
    unpackagedLaunchEnv(config, "dev", "linux", true).LAUFEY_ACTIVATION_POLICY,
    undefined,
  );
  assertEquals(laufeyLaunchEnv({ activationPolicy: "regular" }), {
    LAUFEY_ACTIVATION_POLICY: "regular",
  });
});

Deno.test("activationPolicyRuntime: the pinned runtime from 3.0.0-denext.6, never stock or a local build", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assertEquals(FIRST_OVERLAY_TRAY_RUNTIME, "3.0.0-denext.6");
  assert(supportsOverlayTray("3.0.0-denext.6"));
  assert(!supportsOverlayTray("3.0.0-denext.5"));
  assert(!supportsOverlayTray("nope"));
  assert(activationPolicyRuntime(env({}), "3.0.0-denext.6"));
  assert(!activationPolicyRuntime(env({}), "3.0.0-denext.5"));
  assert(!activationPolicyRuntime(env({ DENEXT_DESKTOP_RUNTIME: " Stock " }), "3.0.0-denext.6"));
  assert(!activationPolicyRuntime(env({ DENEXT_DESKTOP_RUNTIME_DIR: "/x" }), "3.0.0-denext.6"));
  // The pin this checkout carries reads it.
  assert(activationPolicyRuntime(env({})));
});

Deno.test("laufey-launch.json: activationPolicy on macOS only, and only for a runtime that reads it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-activation-" });
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { desktop: { app: { name: "Tray", activationPolicy: "accessory" } } };\n',
    );
    const entry = new URL(`file://${join(dir, "scripts", "package.ts")}`).href;
    const app = join(dir, "Tray.app");
    await Deno.mkdir(join(app, "Contents"), { recursive: true });
    const read = async (path: string | null) => JSON.parse(await Deno.readTextFile(path!));
    const mac = await writeLaufeyLaunchConfig(entry, "darwin", app, {
      strict: true,
      activationPolicy: true,
    });
    assertEquals((await read(mac)).activationPolicy, "accessory");
    const old = await writeLaufeyLaunchConfig(entry, "darwin", app, {
      strict: true,
      activationPolicy: false,
    });
    assertEquals((await read(old)).activationPolicy, undefined);
    const linux = await writeLaufeyLaunchConfig(entry, "linux", join(dir, "linux"), {
      activationPolicy: true,
    });
    assertEquals((await read(linux)).activationPolicy, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Linux packages recommend gtk-layer-shell and speech-dispatcher", () => {
  const meta = {
    name: "My App",
    version: "1.2.3",
    publisher: "Acme",
    description: "An app",
    identifier: "dev.example.app",
    deepLinks: [],
    singleInstance: false,
    backend: "webview",
  } as Parameters<typeof debControl>[0];
  assert(
    debControl(meta, "x86_64", 1).includes("Recommends: libgtk-layer-shell0, speech-dispatcher\n"),
  );
  const spec = rpmSpec(meta, "/tmp/s", []);
  assert(spec.includes("Recommends: libgtk-layer-shell.so.0()(64bit)\n"));
  assert(spec.includes("Recommends: speech-dispatcher\n"));
});

// --- the page side -----------------------------------------------------------------------------

type Rt = ReturnType<typeof createFakeDesktopRuntime>;

/** Run `fn` in a fake desktop window with `caps` enabled. */
async function inDesktop(
  caps: Record<string, Record<string, FakeMethod>>,
  fn: (rt: Rt) => Promise<void>,
): Promise<void> {
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  try {
    await fn(rt);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
}

Deno.test("client: tray events by DOM name with their detail; popUpMenu; the activation policy", async () => {
  const queued = [
    { source: "tray", tray: "app", event: "click", detail: { button: "left", x: 1, y: 2 } },
    { source: "tray", tray: "app", event: "contextmenu", detail: { button: "right" } },
    { source: "tray", tray: "app", event: "doubleClick" },
    { source: "tray", tray: "app", event: "mouseenter" },
    { source: "tray", tray: "app", event: "bogus" },
    { source: "tray", tray: "other", event: "contextmenu" },
  ];
  let served = false;
  await inDesktop({
    app: {
      backendTray: () => ({ id: "app" }),
      popUpMenu: (a) => ({ shown: (a as { id: string }).id === "app" }),
      setActivationPolicy: (a) => ({ applied: (a as { policy: string }).policy !== "prohibited" }),
      getActivationPolicy: () => ({ policy: "accessory" }),
      take: () => {
        if (served) return [];
        served = true;
        return queued;
      },
      capabilities: () => ({ trayRightClick: true, trayHover: true, activationPolicy: true }),
    },
  }, async (rt) => {
    const tray = (await getTray())!;
    const clicks: string[] = [];
    const menus: string[] = [];
    const doubles: string[] = [];
    const hovers: number[] = [];
    const offs = [
      tray.onClick((event, detail) => void clicks.push(`${event}:${detail?.x ?? "-"}`)),
      tray.on("contextmenu", (d) => void menus.push(d?.button ?? "-")),
      tray.on("dblclick", (d) => void doubles.push(String(d))),
      tray.on("mouseenter", () => void hovers.push(1)),
    ];
    await until(() => rt.openStreams() > 0, 2000);
    rt.emit("app", "action", null);
    await until(() => clicks.length === 3 && hovers.length === 1, 2000);
    for (const off of offs) off();
    // The unknown event reads as a click.
    assertEquals(clicks, ["click:1", "doubleClick:-", "click:-"]);
    assertEquals(menus, ["right"]);
    assertEquals(doubles, ["null"]);
    assertEquals(await tray.popUpMenu(), true);
    assertEquals(await setActivationPolicy("accessory"), true);
    assertEquals(await setActivationPolicy("prohibited"), false);
    assertEquals(await getActivationPolicy(), "accessory");
    const caps = await appCapabilities();
    assertEquals([caps.trayRightClick, caps.trayHover, caps.activationPolicy], [true, true, true]);
    assertEquals([caps.trayMiddleClick, caps.trayPopUpMenu], [false, false]);
  });
  await inDesktop({ app: { getActivationPolicy: () => ({ policy: 5 }) } }, async () => {
    assertEquals(await getActivationPolicy(), null);
  });
});

// --- speak() in the shell (the OS engine Loopy's voice falls back to) --------------------------

Deno.test("speak: the shell's text-to-speech plugin first, with only the options given", async () => {
  const tts = fakePlugin(["speak", "stop"]);
  await inShell("android", { TextToSpeech: tts.plugin }, async () => {
    await speak("hello", { lang: "en-GB", rate: 1.2, pitch: 0.9, volume: 0.5 });
    await speak("plain");
    await stopSpeaking();
  });
  assertEquals(tts.calls, [
    ["speak", { text: "hello", lang: "en-GB", rate: 1.2, pitch: 0.9, volume: 0.5 }],
    ["speak", { text: "plain" }],
    ["stop", undefined],
  ]);
});

Deno.test("speak: Web Speech without SpeechSynthesisUtterance is unavailable", async () => {
  const synth = { speak: () => {}, cancel: () => {}, getVoices: () => [] };
  await withGlobals({ speechSynthesis: synth, SpeechSynthesisUtterance: undefined }, async () => {
    let code = "";
    await speak("x").catch((e) => void (code = (e as { code: string }).code));
    assertEquals(code, "unavailable");
  });
});
