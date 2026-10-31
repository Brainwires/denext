// The desktop windowing settings: `desktop.window`'s creation-time and overlay keys, `desktop.app`'s
// keepAlive / dock, `desktop.tray` (validation, its panel's placement next to the icon) and the
// `initialWindow` block `.deno-desktop/app.json` carries so the runtime starts the window hidden,
// frameless, transparent or non-activating with no flash.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  applyDesktopWindowSettings,
  applyWindowOverlaySettings,
  desktopInitialWindow,
  desktopWindowKeyProblem,
  resolveDesktopAppSettings,
  resolveDesktopWindowSettings,
} from "../src/desktop/window-config.ts";
import {
  desktopTrayProblem,
  isAppPath,
  placeTrayPanel,
  resolveDesktopTraySettings,
} from "../src/desktop/tray-config.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";
import {
  DESKTOP_APP_CONFIG_FILE,
  syncDesktopAppConfigAt,
} from "../src/build/desktop-app-config.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { initialOverlayRuntime } from "../src/build/desktop-launch-policy.ts";
import {
  FIRST_INITIAL_OVERLAY_RUNTIME,
  supportsInitialOverlay,
} from "../src/build/deno-version.ts";

/** Validate a config with just a `desktop` block. */
function validateDesktop(desktop: unknown): void {
  validateDenextConfig({ desktop } as DenextConfig);
}

Deno.test("window settings: the creation-time and overlay keys resolve; a level from a boolean", () => {
  assertEquals(
    resolveDesktopWindowSettings({
      window: {
        show: false,
        frameless: true,
        transparent: true,
        focusable: false,
        alwaysOnTop: true,
        opacity: 0.5,
        skipTaskbar: true,
        visibleOnAllWorkspaces: true,
        overlay: true,
      },
    }),
    {
      show: false,
      frameless: true,
      transparent: true,
      focusable: false,
      alwaysOnTop: "floating",
      opacity: 0.5,
      skipTaskbar: true,
      visibleOnAllWorkspaces: true,
      overlay: true,
    },
  );
  assertEquals(resolveDesktopWindowSettings({ window: { alwaysOnTop: "status" } }), {
    alwaysOnTop: "status",
  });
  assertEquals(resolveDesktopWindowSettings({ window: { alwaysOnTop: false } }), {
    alwaysOnTop: false,
  });
});

Deno.test("window settings: a bad flag, level or opacity fails fast with the key", () => {
  assertThrows(
    () => resolveDesktopWindowSettings({ window: { show: "no" } }),
    Error,
    "window.show",
  );
  assertThrows(
    () => resolveDesktopWindowSettings({ window: { alwaysOnTop: "top" } }),
    Error,
    "window.alwaysOnTop",
  );
  assertThrows(
    () => resolveDesktopWindowSettings({ window: { opacity: 2 } }),
    Error,
    "window.opacity",
  );
  assertEquals(desktopWindowKeyProblem({ opacity: Number.NaN })?.[0], "window.opacity");
  assertEquals(desktopWindowKeyProblem({ focusable: 1 }), [
    "window.focusable",
    "must be a boolean",
  ]);
  assertEquals(desktopWindowKeyProblem({}), null);
});

Deno.test("app settings: keepAlive and dock are booleans; absent is empty", () => {
  assertEquals(resolveDesktopAppSettings({ app: { keepAlive: true, dock: false } }), {
    keepAlive: true,
    dock: false,
  });
  assertEquals(resolveDesktopAppSettings({ app: { name: "X" } }), {});
  assertEquals(resolveDesktopAppSettings(undefined), {});
  assertThrows(() => resolveDesktopAppSettings({ app: { dock: "hidden" } }), Error, "app.dock");
});

Deno.test("initialWindow: only for a hidden, frameless, transparent or non-activating window", () => {
  assertEquals(desktopInitialWindow({ width: 800, height: 600, title: "x" }), undefined);
  assertEquals(desktopInitialWindow({ show: true, focusable: true }), undefined);
  assertEquals(desktopInitialWindow({ width: 260, height: 300, show: false }), {
    width: 260,
    height: 300,
    showOnFirstLoad: false,
  });
  assertEquals(
    desktopInitialWindow({ frameless: true, transparent: true, focusable: false, width: 70000 }),
    { frameless: true, noActivate: true, transparent: true },
    "a size over the runtime's limit is left to runDesktop",
  );
});

Deno.test("initialWindow: overlay only for a runtime that reads it (an older one refuses the key)", () => {
  assertEquals(desktopInitialWindow({ width: 260, height: 300, overlay: true }), undefined);
  assertEquals(desktopInitialWindow({ width: 260, height: 300, overlay: true }, true), {
    width: 260,
    height: 300,
    overlay: true,
  });
  assertEquals(
    desktopInitialWindow({ frameless: true, focusable: false, overlay: true }, false),
    { frameless: true, noActivate: true },
  );
  assertEquals(desktopInitialWindow({ overlay: false }, true), undefined);
});

Deno.test("initialOverlayRuntime: the pinned runtime from 3.0.0-denext.7, never stock or a local build", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assertEquals(FIRST_INITIAL_OVERLAY_RUNTIME, "3.0.0-denext.7");
  assertEquals(supportsInitialOverlay("3.0.0-denext.7"), true);
  assertEquals(supportsInitialOverlay("3.0.0-denext.6"), false);
  assertEquals(supportsInitialOverlay("nope"), false);
  assertEquals(initialOverlayRuntime(env({}), "3.0.0-denext.7"), true);
  assertEquals(initialOverlayRuntime(env({}), "3.0.0-denext.6"), false);
  assertEquals(
    initialOverlayRuntime(env({ DENEXT_DESKTOP_RUNTIME: "stock" }), "3.0.0-denext.7"),
    false,
  );
  assertEquals(
    initialOverlayRuntime(env({ DENEXT_DESKTOP_RUNTIME_DIR: "/x" }), "3.0.0-denext.7"),
    false,
  );
});

/** A window recording the calls its setters get. */
function recordingWindow(methods: string[]) {
  const calls: string[] = [];
  const win: Record<string, unknown> = {};
  for (const m of methods) {
    win[m] = (...args: unknown[]) => void calls.push(`${m}${JSON.stringify(args)}`);
  }
  return { win, calls };
}

Deno.test("overlay settings: level, opacity, taskbar and workspaces go to the window's setters", () => {
  const { win, calls } = recordingWindow([
    "setAlwaysOnTop",
    "setOpacity",
    "setSkipTaskbar",
    "setVisibleOnAllWorkspaces",
  ]);
  applyWindowOverlaySettings(win, {
    alwaysOnTop: "screen-saver",
    opacity: 0.8,
    skipTaskbar: true,
    visibleOnAllWorkspaces: true,
  });
  assertEquals(calls, [
    'setAlwaysOnTop[true,"screen-saver"]',
    "setOpacity[0.8]",
    "setSkipTaskbar[true]",
    'setVisibleOnAllWorkspaces[true,{"visibleOnFullScreen":true}]',
  ]);
  const plain = recordingWindow(["setAlwaysOnTop"]);
  applyWindowOverlaySettings(plain.win, { alwaysOnTop: "floating" });
  applyWindowOverlaySettings(plain.win, { alwaysOnTop: false });
  applyWindowOverlaySettings(undefined, { alwaysOnTop: false });
  assertEquals(plain.calls, ["setAlwaysOnTop[true]", "setAlwaysOnTop[false]"]);
});

/**
 * A `Deno.BrowserWindow` as macOS's runtime 3.0.0-denext.6 left it: the prototype's
 * `setAlwaysOnTop` is the native op (it drops the level: floating), and the level is set only
 * through the private `Deno_privateDesktopWindowLevel` op.
 */
class NativeLevelWindow {
  level = 0;
  onTop = false;
  setAlwaysOnTop(flag: boolean) {
    this.onTop = flag;
    this.level = flag ? 1 : 0;
  }
  [Symbol.for("Deno_privateDesktopWindowLevel")](code: number) {
    this.level = code;
  }
}

Deno.test("overlay settings: a level above floating reaches the runtime's level op when setAlwaysOnTop is native", () => {
  const levels: Record<string, number> = { status: 2, "pop-up-menu": 3, "screen-saver": 4 };
  for (const [name, code] of Object.entries(levels)) {
    const win = new NativeLevelWindow();
    applyWindowOverlaySettings(win, { alwaysOnTop: name as "status" });
    assertEquals([win.onTop, win.level], [true, code], name);
  }
  const floating = new NativeLevelWindow();
  applyWindowOverlaySettings(floating, { alwaysOnTop: "floating" });
  assertEquals(floating.level, 1);
  // A runtime without the op keeps setAlwaysOnTop's own answer; a throwing op is a warning.
  const plain = recordingWindow(["setAlwaysOnTop"]);
  applyWindowOverlaySettings(plain.win, { alwaysOnTop: "status" });
  assertEquals(plain.calls, ['setAlwaysOnTop[true,"status"]']);
  const warnings: string[] = [];
  const broken = new NativeLevelWindow();
  Object.defineProperty(broken, Symbol.for("Deno_privateDesktopWindowLevel"), {
    value: () => {
      throw new Error("no level");
    },
  });
  applyWindowOverlaySettings(broken, { alwaysOnTop: "status" }, (m) => void warnings.push(m));
  assertEquals(warnings, ["desktop.window.alwaysOnTop could not be applied: no level"]);
});

Deno.test("overlay settings: a setter no runtime has yet warns by its name, not the pinned runtime", () => {
  const warnings: string[] = [];
  applyDesktopWindowSettings({}, { skipTaskbar: true, opacity: 1 }, (m) => void warnings.push(m));
  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings[0], "denext's pinned Deno Desktop runtime");
  assertStringIncludes(warnings[1], "BrowserWindow.setSkipTaskbar");
});

Deno.test("tray settings: an icon path in the export, texts, a menu and a panel with defaults", () => {
  assertEquals(
    resolveDesktopTraySettings({
      tray: {
        icon: "/tray.png",
        iconDark: "/tray-dark.png",
        tooltip: "Hangar",
        menu: [{ id: "open", label: "Open" }],
        panel: { url: "/panel" },
      },
    }),
    {
      icon: "/tray.png",
      iconDark: "/tray-dark.png",
      tooltip: "Hangar",
      menu: [{ id: "open", label: "Open" }],
      panel: { url: "/panel", width: 360, height: 480, hideOnBlur: true },
    },
  );
  assertEquals(resolveDesktopTraySettings({}), undefined);
  assertEquals(
    resolveDesktopTraySettings({
      tray: { icon: "/t.png", panel: { url: "/p", width: 200.4, height: 100, hideOnBlur: false } },
    })?.panel,
    { url: "/p", width: 200, height: 100, hideOnBlur: false },
  );
  assertThrows(
    () => resolveDesktopTraySettings({ tray: { icon: "tray.png" } }),
    Error,
    "tray.icon",
  );
});

Deno.test("tray settings: each bad key is named", () => {
  const problem = (tray: unknown) => desktopTrayProblem(tray)?.[0];
  assertEquals(problem([]), "tray");
  assertEquals(problem({ icon: "/t.png", iconDark: "dark.png" }), "tray.iconDark");
  assertEquals(problem({ icon: "/t.png", tooltip: "x".repeat(300) }), "tray.tooltip");
  assertEquals(problem({ icon: "/t.png", menu: {} }), "tray.menu");
  assertEquals(problem({ icon: "/t.png", panel: "/p" }), "tray.panel");
  assertEquals(problem({ icon: "/t.png", panel: { url: "https://x.example/" } }), "tray.panel.url");
  assertEquals(
    problem({ icon: "/t.png", panel: { url: "/p", hideOnBlur: 1 } }),
    "tray.panel.hideOnBlur",
  );
  assertEquals(problem({ icon: "/t.png", panel: { url: "/p", width: 0 } }), "tray.panel.width");
  assertEquals(problem({ icon: "/t.png", panel: { url: "/p", height: 1e6 } }), "tray.panel.height");
  assertEquals(problem({ icon: "/t.png", panel: { url: "/p" } }), undefined);
});

Deno.test("app paths: absolute paths of the app only, never another origin", () => {
  for (const ok of ["/", "/panel", "/vm?id=1#x"]) assertEquals(isAppPath(ok), true, ok);
  for (
    const bad of [
      "",
      "panel",
      "//evil.example/",
      "/a\\b",
      "/a\nb",
      "https://x/",
      1,
      "/" + "a".repeat(3000),
    ]
  ) {
    assertEquals(isAppPath(bad), false, String(bad).slice(0, 20));
  }
});

const SCREEN = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 800 },
};
const SIZE = { width: 360, height: 480 };

Deno.test("panel placement: under a top menu bar icon, above a bottom taskbar icon, in the work area", () => {
  // macOS: the icon in the menu bar, the panel under it, centred.
  assertEquals(placeTrayPanel({ x: 1000, y: 0, width: 24, height: 24 }, SIZE, [SCREEN]), {
    x: 832,
    y: 30,
  });
  // Windows: the icon in a bottom taskbar, the panel above it (inside the work area).
  assertEquals(placeTrayPanel({ x: 1000, y: 860, width: 24, height: 40 }, SIZE, [SCREEN]), {
    x: 832,
    y: 345,
  });
  // An icon at the right edge: moved left so it stays on the display.
  assertEquals(placeTrayPanel({ x: 1430, y: 0, width: 10, height: 24 }, SIZE, [SCREEN]).x, 1080);
  // No display known: under the icon, as the runtime's default.
  assertEquals(placeTrayPanel({ x: 100, y: 0, width: 20, height: 20 }, SIZE, []), {
    x: -70,
    y: 20,
  });
  // A second display: the one the icon is on.
  const right = {
    bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1440, y: 0, width: 1920, height: 1040 },
  };
  assertEquals(
    placeTrayPanel({ x: 3300, y: 1045, width: 30, height: 35 }, SIZE, [SCREEN, right]),
    { x: 3000, y: 559 },
  );
});

Deno.test("config validation: the new window, app and tray keys", () => {
  validateDesktop({
    app: { keepAlive: true, dock: false },
    window: { show: false, frameless: true, focusable: false, alwaysOnTop: "status", opacity: 1 },
    tray: { icon: "/tray.png", panel: { url: "/panel" } },
  });
  assertThrows(
    () => validateDesktop({ app: { keepAlive: "yes" } }),
    Error,
    "desktop.app.keepAlive",
  );
  assertThrows(
    () => validateDesktop({ window: { transparent: 1 } }),
    Error,
    "desktop.window.transparent",
  );
  validateDesktop({ window: { overlay: true, focusable: false } });
  assertThrows(
    () => validateDesktop({ window: { overlay: "yes" } }),
    Error,
    "desktop.window.overlay",
  );
  assertThrows(() => validateDesktop({ tray: { icon: "tray.png" } }), Error, "desktop.tray.icon");
});

Deno.test("resolveDesktopCapabilities: hands runDesktop the app settings and the config tray", async () => {
  const resolved = await resolveDesktopCapabilities({
    desktop: {
      app: { identifier: "dev.denext.test", keepAlive: true, dock: false },
      tray: { icon: "/tray.png" },
    },
  });
  assertEquals(resolved.app, { keepAlive: true, dock: false });
  assertEquals(resolved.configTray, { icon: "/tray.png" });
  const none = await resolveDesktopCapabilities({ desktop: {} });
  assertEquals(none.app, {});
  assertEquals("configTray" in none, false);
});

Deno.test("sync: initialWindow goes to app.json for a windowless or overlay window", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-desktop-windowing-" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    const config = {
      desktop: { window: { width: 260, height: 300, show: false, frameless: true } },
    };
    assertEquals((await syncDesktopAppConfigAt(dir, config)).appJson, "written");
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, DESKTOP_APP_CONFIG_FILE))), {
      initialWindow: { width: 260, height: 300, frameless: true, showOnFirstLoad: false },
    });
    // On a runtime that reads them: the overlay flag, and the app's name for untitled windows.
    const overlay = {
      desktop: {
        app: { name: "Loopy" },
        window: { width: 260, height: 300, focusable: false, overlay: true },
      },
    };
    await syncDesktopAppConfigAt(dir, overlay, true);
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, DESKTOP_APP_CONFIG_FILE))), {
      name: "Loopy",
      initialWindow: { width: 260, height: 300, noActivate: true, overlay: true },
    });
    // On an older runtime neither key (the runtime would refuse the file).
    await syncDesktopAppConfigAt(dir, overlay, false);
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, DESKTOP_APP_CONFIG_FILE))), {
      initialWindow: { width: 260, height: 300, noActivate: true },
    });
    // A plain sized window needs none (app.json is not written for it).
    assertEquals(
      (await syncDesktopAppConfigAt(dir, { desktop: { window: { width: 900 } } })).appJson !==
        "written",
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
