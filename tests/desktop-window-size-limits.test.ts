// The size limits of opened windows (src/desktop/window-registry.ts, app-windows.ts,
// window-config.ts): `windows.open` / `host.openWindow` / a page's `openWindow` take `minSize` /
// `maxSize`, and a window that sets neither inherits `desktop.minSize` / `desktop.maxSize` as it
// inherits `desktop.titleBar`; each is applied with the runtime's `setMinimumSize` /
// `setMaximumSize`, as the main window's are, and a minimum larger than the maximum it ends up
// with is refused before anything opens.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import type { RegistryWindow } from "../src/desktop/window-registry.ts";
import { openWindowSettings } from "../src/desktop/window-registry.ts";
import { setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import { applySizeLimits, type DesktopWindowSettings } from "../src/desktop/window-config.ts";

/** A runtime window recording the size-limit calls made on it. */
class FakeWin extends EventTarget implements RegistryWindow {
  static made: FakeWin[] = [];
  calls: string[] = [];
  constructor(readonly options?: Record<string, unknown>) {
    super();
    FakeWin.made.push(this);
  }
  bind() {}
  navigate() {}
  show() {}
  hide() {}
  focus() {}
  close() {}
  isVisible() {
    return true;
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
  setMinimumSize(width: number, height: number) {
    this.calls.push(`min:${width}x${height}`);
  }
  setMaximumSize(width: number, height: number) {
    this.calls.push(`max:${width}x${height}`);
  }
}

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

Deno.test("size limits: opened windows inherit desktop.minSize / maxSize; their own win", () => {
  const { s } = setup({
    minSize: { width: 400, height: 300 },
    maxSize: { width: 1600, height: 1200 },
  });
  s.windows.open({ url: "/a" });
  assertEquals(FakeWin.made[1].calls, ["min:400x300", "max:1600x1200"]);
  // Each limit separately: its own minimum, the inherited maximum.
  s.windows.open({ url: "/b", minSize: { width: 200.4, height: 150.6 } });
  assertEquals(FakeWin.made[2].calls, ["min:200x151", "max:1600x1200"]);
  s.windows.open({
    url: "/c",
    minSize: { width: 500, height: 500 },
    maxSize: { width: 900, height: 700 },
  });
  assertEquals(FakeWin.made[3].calls, ["min:500x500", "max:900x700"]);
});

Deno.test("size limits: without desktop.minSize / maxSize a window gets only its own", () => {
  const { s } = setup();
  s.windows.open({ url: "/a" });
  assertEquals(FakeWin.made[1].calls, []);
  s.windows.open({ url: "/b", maxSize: { width: 640, height: 480 } });
  assertEquals(FakeWin.made[2].calls, ["max:640x480"]);
});

Deno.test("size limits: openWindow checks them, before a window opens", () => {
  assertEquals(
    openWindowSettings({ url: "/", minSize: { width: 10, height: 20 } }).minSize,
    { width: 10, height: 20 },
  );
  for (const bad of [{ width: 10 }, { width: 0, height: 10 }, { width: "1", height: 2 }, 5, null]) {
    assertThrows(
      () => openWindowSettings({ url: "/", minSize: bad }),
      Error,
      "minSize must be { width, height }",
    );
  }
  assertThrows(
    () => openWindowSettings({ url: "/", maxSize: { width: 10001, height: 10 } }),
    Error,
    "maxSize must be { width, height }",
  );
  assertThrows(
    () =>
      openWindowSettings({
        url: "/",
        minSize: { width: 500, height: 100 },
        maxSize: { width: 400, height: 900 },
      }),
    Error,
    "minSize is larger than maxSize",
  );
  // Crossing the inherited limit is refused too, and nothing opens.
  const { s } = setup({ maxSize: { width: 800, height: 600 } });
  const before = FakeWin.made.length;
  const err = assertThrows(() =>
    s.windows.open({ url: "/a", minSize: { width: 900, height: 100 } })
  );
  assertStringIncludes(String(err), "minSize is larger than maxSize");
  assertEquals(FakeWin.made.length, before);
  // Its own maximum replaces the inherited one, so it opens.
  s.windows.open({
    url: "/b",
    minSize: { width: 900, height: 100 },
    maxSize: { width: 1000, height: 700 },
  });
  assertEquals(FakeWin.made.length, before + 1);
});

Deno.test("size limits: a runtime without the setters warns, naming the option", () => {
  const warnings: string[] = [];
  applySizeLimits({}, {
    minSize: { width: 1, height: 1 },
    maxSize: { width: 2, height: 2 },
  }, (m) => void warnings.push(m));
  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings[0], "desktop.minSize");
  assertStringIncludes(warnings[1], "desktop.maxSize");
  // Not a window: nothing.
  applySizeLimits(undefined, { minSize: { width: 1, height: 1 } }, () => {
    throw new Error("no warning expected");
  });
});
