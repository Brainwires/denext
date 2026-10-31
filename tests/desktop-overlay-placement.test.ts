// Placing overlay windows and tray panels on Linux Wayland: a layer-shell overlay window (the main
// window with `desktop.window.overlay`, the tray panel, an `overlay: true` window) reports
// `setPosition` where the runtime has layer-shell, since the runtime turns its position into the
// layer surface's margins; and a tray panel placed at a click in a bottom taskbar keeps clear of it
// although GDK reports the whole display as the work area there.
import { assert, assertEquals } from "@std/assert";
import type { DesktopCapability, DesktopCapCtx } from "../src/desktop/extension.ts";
import { createWindowController } from "../src/desktop/caps/window.ts";
import { createWindowRegistry, type RegistryWindow } from "../src/desktop/window-registry.ts";
import { setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import {
  panelPlacementScreens,
  type PlacementScreen,
  placeTrayPanel,
  WAYLAND_PANEL_INSET,
} from "../src/desktop/tray-config.ts";

const ctx: DesktopCapCtx = {
  emit: () => {},
  appSupportDir: "/tmp/app",
  runOnMainThread: () => Promise.reject(new Error("no UI thread")),
  os: "linux",
  windowId: "main",
  signal: new AbortController().signal,
};

/** Call `cap.method(args)`. */
async function call(cap: DesktopCapability, method: string, args: unknown = {}) {
  return await cap.methods[method].handler(args, ctx);
}

/** A window with `setPosition` (every runtime has it). */
class Win extends EventTarget implements RegistryWindow {
  moved: [number, number][] = [];
  constructor(readonly options?: Record<string, unknown>) {
    super();
  }
  show() {}
  hide() {}
  navigate() {}
  setPosition(x: number, y: number) {
    this.moved.push([x, y]);
  }
}

/** `Deno.desktop` on a KDE Plasma Wayland session: app-wide `setPosition: false`, layer-shell. */
function waylandApi(caps: Record<string, boolean> = {}) {
  const screen = {
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
    workArea: { x: 0, y: 0, width: 1280, height: 800 },
    scaleFactor: 1,
    isPrimary: true,
  };
  return {
    windowCapabilities: () => ({ setPosition: false, layerShell: true, ...caps }),
    platformFeatures: () => ({ sessionType: "wayland" }),
    screens: () => [screen],
  };
}

/** The `setPosition` a controller reports. */
async function setPositionOf(options: Parameters<typeof createWindowController>[0]) {
  const ctl = createWindowController(options);
  return (await call(ctl.capability, "capabilities") as Record<string, unknown>).setPosition;
}

Deno.test("window capabilities: a layer-shell overlay window is placeable on Wayland", async () => {
  const base = { emit: () => {}, closed: () => {} };
  const api = waylandApi() as never;
  assertEquals(await setPositionOf({ ...base, window: new Win(), api, overlay: true }), true);
  // An ordinary window can't be placed on Wayland; nor an overlay where there's no layer-shell
  // (GNOME), where it is an ordinary window.
  assertEquals(await setPositionOf({ ...base, window: new Win(), api }), false);
  const gnome = waylandApi({ layerShell: false }) as never;
  assertEquals(
    await setPositionOf({ ...base, window: new Win(), api: gnome, overlay: true }),
    false,
  );
  // A window the runtime can't move at all.
  const fixed = Object.assign(new Win(), { setPosition: undefined });
  assertEquals(await setPositionOf({ ...base, window: fixed, api, overlay: true }), false);
  // X11 / macOS / Windows: what the runtime says.
  const x11 = { windowCapabilities: () => ({ setPosition: true, layerShell: false }) } as never;
  assertEquals(await setPositionOf({ ...base, window: new Win(), api: x11 }), true);
});

Deno.test("registry: a window opened or adopted as an overlay gets an overlay controller", () => {
  const seen: Record<string, boolean> = {};
  const reg = createWindowRegistry({
    BrowserWindow: Win,
    appUrl: (p) => p,
    emit: () => {},
    keepAlive: () => true,
    exit: () => {},
    controller: (window, id, closed, overlay) => {
      seen[id] = overlay;
      return createWindowController({ window, emit: () => {}, closed, overlay });
    },
  });
  reg.adopt(new Win(), "main");
  reg.adopt(new Win(), "panel", "panel", { overlay: true });
  reg.open({ url: "/hud", overlay: true });
  reg.open({ url: "/plain" });
  assertEquals(seen, { main: false, panel: true, "window-1": true, "window-2": false });
});

Deno.test("setup: the main overlay window is placeable from the runtime that makes it one", async () => {
  const setPosition = async (runtimeVersion: string, overlay: boolean) => {
    const s = setUpDesktopWindows({
      window: new Win(),
      api: waylandApi() as never,
      emit: () => {},
      wantsTray: false,
      os: "linux",
      runtimeVersion,
      windowSettings: { overlay },
    });
    const main = s.registry?.get("main");
    assert(main);
    const caps = await call(main.controller.capability, "capabilities");
    return (caps as Record<string, unknown>).setPosition;
  };
  assertEquals(await setPosition("3.0.0-denext.7", true), true);
  // denext.6 doesn't read initialWindow.overlay: the window is an ordinary one.
  assertEquals(await setPosition("3.0.0-denext.6", true), false);
  assertEquals(await setPosition("3.0.0-denext.7", false), false);
});

/** A `Deno.Tray` whose `attachPanel` records the panel's options and window. */
class PanelTray extends EventTarget {
  static last: PanelTray | undefined;
  panelOptions: Record<string, unknown> | undefined;
  readonly panelWindow = new Win();
  constructor() {
    super();
    PanelTray.last = this;
  }
  setIcon() {}
  setTooltip() {}
  setMenu() {}
  destroy() {}
  attachPanel(options: Record<string, unknown>) {
    this.panelOptions = options;
    return { window: this.panelWindow, visible: false, show() {}, hide() {}, toggle() {} };
  }
}

/** Start the backend tray with a panel under `api` and `runtimeVersion`. */
async function trayPanel(api: unknown, runtimeVersion: string) {
  const d = Deno as unknown as { Tray?: unknown };
  const before = d.Tray;
  d.Tray = PanelTray;
  try {
    const s = setUpDesktopWindows({
      window: new Win(),
      api: api as never,
      emit: () => {},
      wantsTray: true,
      os: "linux",
      runtimeVersion,
    });
    const handle = await s.startTray({
      appUrl: (p) => p,
      readFile: () => Promise.resolve(new Uint8Array([1])),
      settings: {
        icon: "/tray.png",
        panel: { url: "/panel", width: 360, height: 480, hideOnBlur: true },
      },
    });
    assert(handle?.panel);
    const tray = PanelTray.last;
    assert(tray?.panelOptions);
    const position = tray.panelOptions.position as (
      icon: { x: number; y: number; width: number; height: number },
      size: { width: number; height: number },
    ) => { x: number; y: number };
    const panel = s.registry?.get("panel");
    assert(panel);
    const caps = await call(panel.controller.capability, "capabilities");
    return { position, setPosition: (caps as Record<string, unknown>).setPosition };
  } finally {
    d.Tray = before;
  }
}

// The live test's KDE Plasma session: 1280x800, a 54 px taskbar at the bottom, the panel opened at
// the click (773 px down: the tray host gives no icon bounds) reached 21 px into the taskbar.
const CLICK = { x: 1000, y: 773, width: 1, height: 1 };
const SIZE = { width: 360, height: 480 };

Deno.test("backend tray: on Wayland the panel at a click keeps clear of a bottom taskbar", async () => {
  const { position, setPosition } = await trayPanel(waylandApi(), "3.0.0-denext.7");
  const { y } = position(CLICK, SIZE);
  assertEquals(y + SIZE.height <= 800 - 54, true, `panel bottom ${y + SIZE.height}`);
  assertEquals(y, 800 - WAYLAND_PANEL_INSET - SIZE.height);
  // The panel is a layer-shell overlay from denext.7: placeable.
  assertEquals(setPosition, true);
});

Deno.test("backend tray: a runtime that anchors to the nearest edges needs no inset", async () => {
  const api = waylandApi({ layerShellEdgeAnchor: true });
  const { position } = await trayPanel(api, "3.0.0-denext.7");
  assertEquals(position(CLICK, SIZE).y, 773 - 480 - 6);
});

Deno.test("backend tray: X11 keeps the reported work area; denext.6's panel is no overlay", async () => {
  const x11 = { ...waylandApi(), platformFeatures: () => ({ sessionType: "x11" }) };
  const { position, setPosition } = await trayPanel(x11, "3.0.0-denext.6");
  assertEquals(position(CLICK, SIZE).y, 773 - 480 - 6);
  assertEquals(setPosition, false);
});

Deno.test("panelPlacementScreens: insets only a work area that is the whole display", () => {
  const whole: PlacementScreen = {
    bounds: { x: 1280, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1280, y: 0, width: 1920, height: 1080 },
  };
  const known: PlacementScreen = {
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
    workArea: { x: 0, y: 0, width: 1280, height: 746 },
  };
  const tiny: PlacementScreen = {
    bounds: { x: 0, y: 0, width: 200, height: 100 },
    workArea: { x: 0, y: 0, width: 200, height: 100 },
  };
  assertEquals(panelPlacementScreens([whole, known], false), [whole, known]);
  const [w, k, t] = panelPlacementScreens([whole, known, tiny], true);
  assertEquals(w.workArea, { x: 1344, y: 64, width: 1792, height: 952 });
  assertEquals(k, known);
  // At most a quarter of the display.
  assertEquals(t.workArea, { x: 50, y: 25, width: 100, height: 50 });
  // The placement then stays inside it.
  assertEquals(placeTrayPanel(CLICK, SIZE, [{ ...known, workArea: known.bounds }]).y, 287);
  assertEquals(
    placeTrayPanel(CLICK, SIZE, panelPlacementScreens([{ ...known, workArea: known.bounds }], true))
      .y,
    256,
  );
});
