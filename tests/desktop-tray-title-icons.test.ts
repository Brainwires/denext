// A tray's title (the text beside its icon in the macOS menu bar, Electron's `tray.setTitle`) and
// a tray icon per OS (`{ macos, windows, linux, default }`, each an icon or `{ icon, iconDark }`):
// in `desktop.tray`, `runDesktop({ tray })` and `denext/desktop/app`'s `createTray` / `update`.

import { assert, assertEquals, assertThrows } from "@std/assert";
import type { DesktopCapability, DesktopCapCtx } from "../src/desktop/extension.ts";
import { createAppController, type TrayLike } from "../src/desktop/caps/app.ts";
import { startBackendTray } from "../src/desktop/backend-tray.ts";
import { desktopTrayProblem, resolveDesktopTraySettings } from "../src/desktop/tray-config.ts";
import { resolveTrayIcon, trayIconOs } from "../src/desktop/tray-icons.ts";
import { trayCapabilitiesOf } from "../src/desktop/tray-events.ts";
import { appCapabilities, createTray } from "../src/desktop/app.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { bytesToBase64 } from "../src/mobile/base64.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { createFakeDesktopRuntime, type FakeMethod } from "./helpers/desktop-fake-runtime.ts";

/** Distinct base64 "PNGs" (the controller only decodes them). */
const MAC = "TUFD"; // "MAC"
const WIN = "V0lO"; // "WIN"
const WIN_DARK = "REFSSw=="; // "DARK"
const ANY = "QU5Z"; // "ANY"
const text = (png: Uint8Array | null) => png === null ? null : new TextDecoder().decode(png);

/** A `Deno.Tray` that records what it was given; `withTitle: false` is a runtime without titles. */
function trayClass(withTitle: boolean) {
  const made: TitledTray[] = [];
  class TitledTray extends EventTarget implements TrayLike {
    icons: (string | null)[] = [];
    darks: (string | null)[] = [];
    titles: (string | null)[] = [];
    constructor() {
      super();
      made.push(this);
    }
    setIcon(png: Uint8Array) {
      this.icons.push(text(png));
    }
    setIconDark(png: Uint8Array | null) {
      this.darks.push(text(png));
    }
    setTooltip() {}
    setMenu() {}
    destroy() {}
  }
  if (withTitle) {
    Object.defineProperty(TitledTray.prototype, "setTitle", {
      value(this: TitledTray, title: string | null) {
        this.titles.push(title);
      },
    });
  }
  return { Tray: TitledTray, made };
}

const ctx: DesktopCapCtx = {
  emit: () => {},
  appSupportDir: "/tmp/app",
  runOnMainThread: () => Promise.reject(new Error("no UI thread")),
  secureStore: {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  },
  pickedPath: () => {
    throw new Error("no picked paths in tests");
  },
  os: "darwin",
  windowId: "main",
  signal: new AbortController().signal,
};

/** An app controller on `os` over a recording tray. */
function appCtl(os: string, withTitle = true) {
  const fake = trayClass(withTitle);
  const ctl = createAppController({
    window: Object.assign(new EventTarget(), { isVisible: () => true }),
    emit: () => {},
    Tray: fake.Tray,
    os,
    windows: () => ["main"],
  });
  ctl.install();
  const call = async (method: string, args: unknown = {}) =>
    await (ctl.capability as DesktopCapability).methods[method].handler(args, ctx);
  return { ctl, call, made: fake.made };
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

const SET = { macos: MAC, windows: { icon: WIN, iconDark: WIN_DARK }, default: ANY };

// --- the tray title ----------------------------------------------------------------------------

Deno.test("app: createTray / updateTray set the tray's title; null removes it", async () => {
  const { call, made } = appCtl("darwin");
  await call("createTray", { icon: MAC, title: "3" });
  await call("updateTray", { id: "1", title: "12:04" });
  await call("updateTray", { id: "1", title: null });
  assertEquals(made[0].titles, ["3", "12:04", null]);
  assertEquals(await codeOf(call("updateTray", { id: "1", title: "x".repeat(300) })), "validation");
  assertEquals((await call("capabilities") as Record<string, unknown>).trayTitle, true);
});

Deno.test("app: a runtime with no tray title takes title and ignores it; trayTitle is false", async () => {
  const { call, made } = appCtl("darwin", false);
  await call("createTray", { icon: MAC, title: "3" });
  assertEquals(made[0].icons, ["MAC"]);
  assertEquals((await call("capabilities") as Record<string, unknown>).trayTitle, false);
});

Deno.test("trayCapabilitiesOf: title from the runtime's probe, else from Tray.setTitle", () => {
  const titled = trayClass(true).Tray;
  const plain = trayClass(false).Tray;
  assertEquals(trayCapabilitiesOf(titled, true).title, true);
  assertEquals(trayCapabilitiesOf(titled, false).title, false); // no tray host
  assertEquals(trayCapabilitiesOf(plain, true).title, false);
  const probed = Object.assign(plain, { capabilities: () => ({ title: true }) });
  assertEquals(trayCapabilitiesOf(probed, true).title, true);
  const denied = Object.assign(trayClass(true).Tray, { capabilities: () => ({ title: false }) });
  assertEquals(trayCapabilitiesOf(denied, true).title, false);
});

// --- per-OS icons ------------------------------------------------------------------------------

Deno.test("resolveTrayIcon: the OS's entry, else default; an entry's iconDark wins", () => {
  assertEquals(resolveTrayIcon("/a.png", "/d.png", "linux"), {
    icon: "/a.png",
    iconDark: "/d.png",
  });
  assertEquals(resolveTrayIcon(SET, undefined, "darwin"), { icon: MAC });
  assertEquals(resolveTrayIcon(SET, "TOP", "darwin"), { icon: MAC, iconDark: "TOP" });
  assertEquals(resolveTrayIcon(SET, "TOP", "windows"), { icon: WIN, iconDark: WIN_DARK });
  assertEquals(resolveTrayIcon(SET, undefined, "linux"), { icon: ANY });
  assertEquals(resolveTrayIcon(SET, undefined, "freebsd"), { icon: ANY });
  assertEquals(resolveTrayIcon({ macos: MAC }, undefined, "windows"), null);
  assertEquals([trayIconOs("darwin"), trayIconOs("windows"), trayIconOs("linux")], [
    "macos",
    "windows",
    "linux",
  ]);
});

Deno.test("app: createTray / updateTray with a per-OS icon show the running OS's", async () => {
  const mac = appCtl("darwin");
  await mac.call("createTray", { icon: SET });
  assertEquals([mac.made[0].icons, mac.made[0].darks], [["MAC"], []]);

  const win = appCtl("windows");
  await win.call("createTray", { icon: SET });
  assertEquals([win.made[0].icons, win.made[0].darks], [["WIN"], ["DARK"]]);
  await win.call("updateTray", { id: "1", icon: { windows: ANY, default: MAC } });
  assertEquals(win.made[0].icons, ["WIN", "ANY"]);

  const linux = appCtl("linux");
  await linux.call("createTray", { icon: SET, iconDark: WIN_DARK });
  assertEquals([linux.made[0].icons, linux.made[0].darks], [["ANY"], ["DARK"]]);
});

Deno.test("app: a per-OS icon without the running OS or default, or with a bad key, is refused", async () => {
  const { call, made } = appCtl("linux");
  assertEquals(await codeOf(call("createTray", { icon: { macos: MAC } })), "validation");
  assertEquals(
    await codeOf(call("createTray", { icon: { ios: MAC, default: ANY } })),
    "validation",
  );
  assertEquals(await codeOf(call("createTray", { icon: { linux: { icon: 5 } } })), "validation");
  assertEquals(made.length, 0);
});

// --- the backend tray (desktop.tray / runDesktop({ tray })) ----------------------------------

Deno.test("backend tray: a per-OS icon reads only the running OS's file; title and update", async () => {
  const { ctl, made } = appCtl("windows");
  const read: string[] = [];
  const files: Record<string, string> = {
    "/mac.png": "MAC",
    "/win.png": "WIN",
    "/win-dark.png": "DARK",
  };
  const handle = await startBackendTray({
    app: ctl,
    appUrl: (p) => p,
    readFile: (path) => {
      read.push(path);
      return Promise.resolve(files[path] ? new TextEncoder().encode(files[path]) : null);
    },
    screens: () => [],
    warn: () => {},
    os: "windows",
    settings: {
      icon: { macos: "/mac.png", windows: { icon: "/win.png", iconDark: "/win-dark.png" } },
      title: "config",
    },
    options: { title: "2 running" },
  });
  assert(handle && !("reason" in handle));
  const tray = made[0];
  assertEquals(read, ["/win.png", "/win-dark.png"]);
  assertEquals([tray.icons, tray.darks, tray.titles], [["WIN"], ["DARK"], ["2 running"]]);
  const enc = (s: string) => new TextEncoder().encode(s);
  handle.update({ title: null, icon: { macos: enc("M2"), default: enc("D2") } });
  assertEquals([tray.icons, tray.titles], [["WIN", "D2"], ["2 running", null]]);
});

Deno.test("backend tray: a per-OS icon naming neither the OS nor default fails at launch", async () => {
  const { ctl } = appCtl("linux");
  let message = "";
  try {
    await startBackendTray({
      app: ctl,
      appUrl: (p) => p,
      readFile: () => Promise.resolve(new Uint8Array([1])),
      screens: () => [],
      warn: () => {},
      os: "linux",
      settings: { icon: { macos: "/mac.png" } },
    });
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes("no icon for linux"), message);
});

// --- config ------------------------------------------------------------------------------------

Deno.test("config: desktop.tray takes a title and a per-OS icon, checked key by key", () => {
  const ok = { icon: { macos: "/t.png", windows: { icon: "/w.png", iconDark: "/wd.png" } } };
  assertEquals(desktopTrayProblem({ ...ok, title: "3" }), null);
  assertEquals(desktopTrayProblem({ icon: { linux: "tray.png" } })?.[0], "tray.icon.linux");
  assertEquals(
    desktopTrayProblem({ icon: { windows: { icon: "/w.png", iconDark: 4 } } })?.[0],
    "tray.icon.windows.iconDark",
  );
  assertEquals(desktopTrayProblem({ icon: { android: "/a.png" } })?.[0], "tray.icon.android");
  assertEquals(desktopTrayProblem({ icon: {} })?.[0], "tray.icon");
  assertEquals(desktopTrayProblem({ icon: "/t.png", title: 3 })?.[0], "tray.title");
  assertEquals(resolveDesktopTraySettings({ tray: { ...ok, title: "3" } }), { ...ok, title: "3" });
  const bad = { desktop: { tray: { icon: { macos: "/t.png" }, title: 7 } } };
  const err = assertThrows(() => validateDenextConfig(bad as unknown as DenextConfig));
  assert(err instanceof Error && err.message.includes("tray.title"), String(err));
  validateDenextConfig({ desktop: { tray: { ...ok, title: "3" } } } as unknown as DenextConfig);
});

// --- the page API ------------------------------------------------------------------------------

Deno.test("client: createTray sends the title and a per-OS icon with each image as base64", async () => {
  const got: unknown[] = [];
  const caps: Record<string, Record<string, FakeMethod>> = {
    app: {
      createTray: (a) => {
        got.push(a);
        return { id: "1" };
      },
      updateTray: (a) => void got.push(a),
      capabilities: () => ({ trayTitle: true }),
    },
  };
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    const tray = await createTray({
      icon: { macos: bytes, windows: { icon: bytes, iconDark: "QUJD" }, default: "WFla" },
      title: "3",
    });
    await tray.update({ title: null });
    const b64 = bytesToBase64(bytes);
    assertEquals(got, [
      {
        icon: { macos: b64, windows: { icon: b64, iconDark: "QUJD" }, default: "WFla" },
        title: "3",
      },
      { id: "1", title: null },
    ]);
    assertEquals((await appCapabilities()).trayTitle, true);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});
