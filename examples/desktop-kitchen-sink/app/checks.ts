// The kitchen sink's checks: every shipped Deno Desktop capability, driven from the page through
// the public APIs an app uses (`denext/mobile`, `denext/desktop/window`, `denext/desktop/client`).
// The storage checks also read the result back through the raw bridge or straight from disk (the
// `kitchen` extension), because the public APIs fall back to browser storage when a capability is
// off: a pass here means the native path ran.
//
// Imported by the "use client" component only (it runs in the window, never on the server).

import {
  cancelNotification,
  checkPermission,
  clipboardFormats,
  type DeepLinkEvent,
  deleteFile,
  deviceInfo,
  listDir,
  moveToTrash,
  onLocalNotificationTapped,
  openAuthSession,
  type OpenedFile,
  openSqlite,
  pendingNotifications,
  readClipboard,
  readFile,
  runtimePlatform,
  scheduleNotification,
  secureStore,
  setNotificationCategories,
  setQuickActions,
  writeClipboard,
  writeFile,
} from "denext/mobile";
import {
  appCapabilities,
  bounce,
  createTray,
  getLaunchAtLogin,
  isDesktopBridgeError,
  listShortcuts,
  onAppMenuItem,
  registerShortcut,
  setAppMenu,
  setBadge,
  setLaunchAtLogin,
  shortcutCapabilities,
} from "denext/desktop/app";
import {
  desktopExtension,
  desktopWebSocketUrl,
  desktopWsUrl,
  onDesktopEvent,
} from "denext/desktop/client";
import {
  getScreens,
  getTitleBarPreferences,
  getWindowState,
  maximizeWindow,
  onCloseRequested,
  onFileDrop,
  quitApp,
  setMaximumWindowSize,
  setMinimumWindowSize,
  setWindowBackdrop,
  setWindowSize,
  setWindowTitle,
  startFileDrag,
  unmaximizeWindow,
  windowCapabilities,
} from "denext/desktop/window";

/** What `kitchen.setup` returns (see `desktop/kitchen.ts`). */
export interface KitchenSetup {
  readonly autorun: boolean;
  /** `main` (every check), or a full-app update phase of the window test ({@link PHASE_CHECKS}). */
  readonly phase: string;
  readonly updateUrls:
    | {
      good: string;
      badSignature: string;
      downgrade: string;
      wrongApp: string;
      expired: string;
      replayed: string;
      real: string;
      /** Windows, the trusted-update phases: the update build signed with the app's certificate. */
      trustedA: string;
      /** The same build re-signed with another certificate. */
      trustedB: string;
    }
    | null;
  readonly os: "darwin" | "windows" | "linux";
  readonly target: string;
  readonly pinnedRuntime: boolean;
  readonly dataDir: string;
  readonly pid: number;
  /** `desktop.capabilities.passkeys.rpIds`: the manual passkey check defaults to the first. */
  readonly passkeyRpIds: readonly string[];
  /** `desktop.app.origin` (e.g. `kitchensink://app`). */
  readonly appOrigin: string;
  /**
   * The runner's view of the Linux session (`XDG_SESSION_TYPE`, else `WAYLAND_DISPLAY` /
   * `DISPLAY`), for a runtime whose own probe answers `"unknown"`; `null` elsewhere or by hand.
   */
  readonly sessionType: "wayland" | "x11" | "tty" | null;
  /** The packaged app's backend as the runner found it; `null` when the app was opened by hand. */
  readonly backend: "webview" | "cef" | null;
}

/** One check's outcome. */
export interface CheckResult {
  readonly name: string;
  readonly status: "pass" | "fail" | "skip";
  readonly detail: string;
  readonly ms: number;
}

/** What the checks share: the setup, and what the launch delivered. */
export interface CheckContext {
  readonly setup: KitchenSetup;
  readonly links: DeepLinkEvent[];
  readonly files: OpenedFile[];
}

/** Thrown by a check that does not apply here; reported as `skip` with the reason. */
class Skip extends Error {}

type Check = readonly [
  name: string,
  run: (ctx: CheckContext) => string | Promise<string>,
];

/** The raw bridge clients (the same RPCs `denext/mobile` makes on desktop). */
type Raw = Record<
  string,
  // deno-lint-ignore no-explicit-any
  (args?: unknown, options?: { timeoutMs?: number | false }) => Promise<any>
>;
const raw = (cap: string) => desktopExtension(cap) as unknown as Raw;
export const kitchen = raw("kitchen");

/** The Node-API addon's CRC-32 of "hello". */
const CRC32_HELLO = 907060870;
/** The file the window test asks the OS to open with the app, and its content. */
const OPEN_FILE_NAME = "open me.txt";
const OPEN_FILE_TEXT = "opened by the kitchen sink window test";
/** A 1x1 transparent PNG, base64. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns a truthy value, or fail after `ms`. */
async function waitFor<T>(
  probe: () => T | Promise<T>,
  what: string,
  ms = 5000,
  observed?: () => string | Promise<string>,
): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  do {
    const last = await probe();
    if (last) return last as NonNullable<T>;
    await sleep(100);
  } while (Date.now() < end);
  const seen = observed ? ` (observed: ${await observed()})` : "";
  throw new Error(`timed out after ${ms} ms waiting for ${what}${seen}`);
}

/** The page size, and the window's own report, for a timeout message. */
async function sizes(): Promise<string> {
  const st = await getWindowState().catch(() => null);
  const box = (b: { width: number; height: number } | null | undefined) =>
    b ? `${b.width}x${b.height}` : "null";
  return `inner ${innerWidth}x${innerHeight}, content ${box(st?.contentBounds)}, ` +
    `frame ${box(st?.bounds)}, min ${st?.minimumSize}, max ${st?.maximumSize}`;
}

/**
 * Why a geometry check cannot pass here, when the compositor overrode the request: the window
 * stays unmaximized yet covers its screen's work area (a tiling window manager such as Sway tiles
 * every window to its slot), so `setWindowBounds` / `maximizeWindow` cannot change it. The runtime
 * reports no tiling fact (`windowCapabilities()` / the session probe), so this reads the outcome.
 * `null` when the window does not fill the screen: a real failure, reported as one.
 */
async function compositorOwnsGeometry(asked: string): Promise<string | null> {
  const st = await getWindowState().catch(() => null);
  const frame = st?.bounds ?? st?.contentBounds;
  if (!st || !frame || st.maximized || st.fullscreen) return null;
  const screen = st.screen ?? (await getScreens().catch(() => [])).find((s) => s.isPrimary);
  if (!screen) return null;
  // 90% in both dimensions: a tiled window loses only the gaps and the bar to the screen.
  const fills = (r: { width: number; height: number }) =>
    frame.width >= r.width * 0.9 && frame.height >= r.height * 0.9;
  if (!fills(screen.workArea) && !fills(screen.bounds)) return null;
  return `the compositor controls this window's geometry (a tiling window manager): asked ` +
    `${asked}, the window stays ${frame.width}x${frame.height}, unmaximized, filling the ` +
    `${screen.workArea.width}x${screen.workArea.height} work area`;
}

/** Run `step`; when it fails because the compositor owns the geometry, skip with that reason. */
async function unlessTiled<T>(asked: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    const reason = await compositorOwnsGeometry(asked);
    if (reason) throw new Skip(reason);
    throw err;
  }
}

/** The error code a rejected bridge call carries. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return String((err as { code?: unknown }).code ?? (err as Error).message);
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

/**
 * A CEF window in a Wayland session: the runtime's own session probe, else the runner's (a runtime
 * before 2.9.7-denext.10 answers `"unknown"`); the runner's backend, else CEF's cookie store (only
 * CEF reports one).
 */
function cefOnWayland(
  caps: Awaited<ReturnType<typeof windowCapabilities>>,
  setup: KitchenSetup,
): boolean {
  const session = caps.sessionType === "unknown" || caps.sessionType === null
    ? setup.sessionType
    : caps.sessionType;
  const cef = setup.backend === "cef" ||
    caps.cookieEncryption === "os" || caps.cookieEncryption === "basic";
  return session === "wayland" && cef;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 2;

/**
 * The page size closest to `width` x `height` whose window fits the work area of the window's
 * screen (the primary one when the runtime does not say), with room for the frame and a margin.
 */
async function fittingSize(
  width: number,
  height: number,
): Promise<{ width: number; height: number; why: string }> {
  const state = await getWindowState();
  const screen = state.screen ?? (await getScreens()).find((s) => s.isPrimary);
  assert(screen, "no screen to fit the window on");
  const chromeW = Math.max(0, (state.bounds?.width ?? 0) - (state.contentBounds?.width ?? 0));
  const chromeH = Math.max(0, (state.bounds?.height ?? 0) - (state.contentBounds?.height ?? 0));
  const margin = 40;
  const fit = {
    width: Math.min(width, screen.workArea.width - chromeW - margin),
    height: Math.min(height, screen.workArea.height - chromeH - margin),
  };
  // Never below the configured minimum (420x320): a screen that small cannot run this check.
  assert(
    fit.width >= 420 && fit.height >= 320,
    `the work area is too small: ${JSON.stringify(screen.workArea)}`,
  );
  const clamped = fit.width !== width || fit.height !== height;
  return {
    ...fit,
    why: clamped
      ? ` (asked less than ${width}x${height}: work area ${screen.workArea.width}x${screen.workArea.height})`
      : "",
  };
}

// --- runtime -------------------------------------------------------------------------------

const runtimeChecks: Check[] = [
  ["runtime: runtimePlatform() is desktop", () => {
    eq(runtimePlatform(), "desktop", "runtimePlatform()");
    return "desktop";
  }],
  ["runtime: denext's pinned Deno Desktop runtime", ({ setup }) => {
    assert(
      setup.pinnedRuntime,
      "Deno.desktop is missing: the stock runtime is running",
    );
    return setup.target;
  }],
  ["app origin: desktop.app.origin is the page's origin", ({ setup }) => {
    eq(location.origin, setup.appOrigin, "location.origin");
    return location.origin;
  }],
  ["bridge events: the runtime pushes an event to the page", async () => {
    const marker = crypto.randomUUID();
    let got: unknown;
    const stop = onDesktopEvent("echo", "pong", (data) => {
      if ((data as { marker?: unknown })?.marker === marker) got = data;
    });
    try {
      await sleep(200); // the stream connects on the first subscription
      await raw("echo").emitPong({ marker });
      await waitFor(() => got, "the echo capability's pong event", 5000);
    } finally {
      stop();
    }
    return "pong received";
  }],
  ["websocket: the page dials the runtime's relay with the app origin", async ({ setup }) => {
    if (!setup.pinnedRuntime) throw new Skip("the stock runtime serves the page on loopback");
    const relay = desktopWsUrl();
    assert(relay, "__denext.wsUrl is missing");
    assert(/\/\.deno-desktop-relay\/[0-9a-f]{64}$/.test(relay), "the relay URL has no token");
    const url = desktopWebSocketUrl("/_kitchen/ws");
    assert(url.startsWith(`${relay}/`), `dialed ${url}, not the relay`);
    const ws = new WebSocket(url);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message from the socket")), 5000);
        ws.onmessage = (e) => {
          clearTimeout(timer);
          resolve(String(e.data));
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error(`the relay refused ${url}`));
        };
      });
      eq(JSON.parse(data).origin, location.origin, "the Origin the server saw");
    } finally {
      ws.close();
    }
    return `${new URL(relay).origin} + token · Origin ${location.origin}`;
  }],
  ["preload: ran first, after the __denext global", () => {
    const p = (globalThis as {
      __kitchenPreload?: { ran: boolean; denextGlobal: boolean; pageScriptsBefore: number };
    }).__kitchenPreload;
    assert(p?.ran, "the preload did not run");
    assert(p.denextGlobal, "the preload ran before the __denext global");
    eq(p.pageScriptsBefore, 0, "page scripts loaded before the preload");
    return "ok";
  }],
];

// --- storage -------------------------------------------------------------------------------

const storageChecks: Check[] = [
  ["secureStore: set / get / delete in the OS keychain", async () => {
    const key = "kitchen-sink-probe";
    const value = `secret-${crypto.randomUUID()}`;
    await secureStore.set(key, value);
    eq(await secureStore.get(key), value, "secureStore.get");
    eq(
      await raw("secureStore").get({ key }),
      value,
      "the native keychain entry",
    );
    await secureStore.delete(key);
    eq(await raw("secureStore").get({ key }), null, "the entry after delete");
    return "round trip through the keychain";
  }],
  ["fs: write / read / list / delete in the app's data folder", async () => {
    const text = `kitchen sink ${Date.now()}`;
    await writeFile("kitchen/fs.txt", text, {
      directory: "data",
      recursive: true,
    });
    eq(
      await readFile("kitchen/fs.txt", { directory: "data" }),
      text,
      "readFile",
    );
    const names = (await listDir("kitchen", { directory: "data" })).map((e) => e.name);
    assert(names.includes("fs.txt"), `listDir: ${names.join(", ")}`);
    eq(
      (await kitchen.diskRead({ path: "kitchen/fs.txt" })).text,
      text,
      "the file on disk",
    );
    await deleteFile("kitchen/fs.txt", { directory: "data" });
    eq(
      (await kitchen.diskRead({ path: "kitchen/fs.txt" })).text,
      null,
      "the file after delete",
    );
    return "on disk in the data folder";
  }],
  ["sqlite: a node:sqlite database in the data folder", async () => {
    const db = await openSqlite("kitchen-sink");
    try {
      eq(db.backend, "native", "backend");
      await db.exec(
        "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT)",
      );
      await db.exec("DELETE FROM t");
      await db.run("INSERT INTO t (name) VALUES (?)", ["kitchen"]);
      const rows = await db.query<{ name: string }>("SELECT name FROM t");
      eq(rows.length, 1, "row count");
      eq(rows[0].name, "kitchen", "row");
    } finally {
      await db.close();
    }
    return "native";
  }],
];

/** The clipboard text before the clipboard checks (restored after them). */
let savedClipboard: string | null = null;

// --- system --------------------------------------------------------------------------------

const systemChecks: Check[] = [
  ["device: the runtime's device facts", async ({ setup }) => {
    const facts = await raw("device").info({});
    eq(facts?.os, setup.os, "device.info().os");
    const info = await deviceInfo();
    assert(info.model, "deviceInfo().model is empty");
    return `${info.model} ${info.osVersion ?? ""}`.trim();
  }],
  ["keepAwake: acquire / release the OS assertion", async () => {
    const held = await raw("keepAwake").acquire({});
    assert(typeof held?.id === "string", "acquire returned no id");
    eq((await raw("keepAwake").release({ id: held.id }))?.ok, true, "release");
    return "held and released";
  }],
  ["clipboard: text", async () => {
    // The checks overwrite the clipboard: keep the user's text to put back afterwards.
    savedClipboard = await raw("clipboard").readText({}).catch(() => null);
    const text = `kitchen ${crypto.randomUUID()}`;
    await writeClipboard(text);
    eq(await readClipboard(), text, "readClipboard()");
    eq(await raw("clipboard").readText({}), text, "the OS clipboard");
    return "ok";
  }],
  ["clipboard: HTML", async () => {
    const marker = crypto.randomUUID();
    await writeClipboard({ html: `<b>${marker}</b>`, text: marker });
    const html = await readClipboard({ format: "html" });
    assert(
      html.includes(marker),
      `readClipboard({ format: "html" }) = ${JSON.stringify(html)}`,
    );
    eq(await readClipboard(), marker, "the plain-text alternative");
    return "ok";
  }],
  ["clipboard: PNG image + formats", async () => {
    await writeClipboard({ image: PNG_1X1 });
    const png = await readClipboard({ format: "image" });
    assert(
      png.startsWith("iVBOR"),
      `readClipboard({ format: "image" }) is not a PNG: ${png.slice(0, 16)}`,
    );
    const formats = await clipboardFormats();
    assert(
      formats.includes("image/png"),
      `clipboardFormats() = ${formats.join(", ")}`,
    );
    if (typeof savedClipboard === "string" && savedClipboard !== "") {
      await writeClipboard(savedClipboard); // the user's text, back
    }
    return formats.join(", ");
  }],
  ["shell: refuses what the config does not allow", async () => {
    const scheme = await rejection(
      raw("shell").openExternal({ url: "file:///etc/hosts" }),
    );
    const open = await rejection(raw("shell").openPath({ path: "/" }));
    return `openExternal(file:) → ${scheme}, openPath (off) → ${open}`;
  }],
  ["shell: moveToTrash an app file", async ({ setup }) => {
    if (setup.os === "darwin") {
      // The macOS trash asks Finder over Apple Events: the first time, the OS shows an Automation
      // consent prompt only a person can answer.
      throw new Skip(
        "macOS asks for Automation consent (Finder) the first time",
      );
    }
    await writeFile("kitchen/trash-me.txt", "bye", {
      directory: "data",
      recursive: true,
    });
    const sep = setup.os === "windows" ? "\\" : "/";
    await moveToTrash([setup.dataDir, "kitchen", "trash-me.txt"].join(sep));
    eq(
      (await kitchen.diskRead({ path: "kitchen/trash-me.txt" })).text,
      null,
      "the file after trash",
    );
    return "moved to the trash";
  }],
  [
    "dialogs: native dialogs available; arguments validated before any panel opens",
    async () => {
      const caps = await windowCapabilities();
      eq(caps.fileDialogs, true, "windowCapabilities().fileDialogs");
      // A save without data is refused before the panel would open (no person needed).
      const code = await rejection(raw("dialogs").saveFile({ data: 42 }));
      eq(code, "validation", "saveFile without data");
      return "fileDialogs + validation";
    },
  ],
];

// --- window --------------------------------------------------------------------------------

const windowChecks: Check[] = [
  ["window: capabilities and state", async () => {
    const caps = await windowCapabilities();
    for (
      const k of [
        "state",
        "sizeConstraints",
        "screens",
        "closeGuard",
      ] as const
    ) {
      eq(caps[k], true, `windowCapabilities().${k}`);
    }
    const state = await getWindowState();
    eq(state.visible, true, "visible");
    assert(state.bounds && state.bounds.width > 0, "no window bounds");
    await setWindowTitle("denext kitchen sink — running checks");
    return `${state.bounds.width}x${state.bounds.height}`;
  }],
  ["window: the user's title bar preferences (for an app-drawn title bar)", async ({ setup }) => {
    const p = await getTitleBarPreferences();
    assert(
      ["left", "right"].includes(p.side) && Array.isArray(p.buttons.left) &&
        Array.isArray(p.buttons.right),
      "no buttons / side",
    );
    // macOS: the traffic lights on the left; Windows: the caption buttons on the right; Linux:
    // the desktop's own layout (xdg-desktop-portal, then GSettings, then GTK's defaults), or the
    // usual layout before runtime 2.9.7-denext.12 (source "unknown").
    if (setup.os === "darwin") eq(p.side, "left", "the macOS buttons' side");
    if (setup.os === "windows") eq(p.side, "right", "the Windows buttons' side");
    return `${p.side} ${JSON.stringify(p.buttons)} double-click ${p.doubleClick} (${p.source})`;
  }],
  ["window: file drop (onFileDrop fires)", async ({ setup }) => {
    const caps = await windowCapabilities();
    if (caps.fileDrop !== true && cefOnWayland(caps, setup)) {
      // laufey docs/drag-and-drop.md: CEF hands drag data only to Alloy-style browsers (laufey's
      // are Chrome style), and under Wayland there is no drag source to ask for the paths.
      const reason = typeof caps.fileDropReason === "string" && caps.fileDropReason
        ? caps.fileDropReason
        : "CEF under Wayland: CEF delivers drag data only to Alloy-style browsers (laufey's are " +
          "Chrome style) and Wayland has no drag source to ask for the paths";
      throw new Skip(reason);
    }
    eq(caps.fileDrop, true, "windowCapabilities().fileDrop");
    return "fileDrop";
  }],
  ["window: screens", async () => {
    const screens = await getScreens();
    assert(screens.length > 0, "no screens");
    assert(screens.some((s) => s.isPrimary), "no primary screen");
    assert(
      screens.every((s) => s.scaleFactor > 0),
      "a screen has no scale factor",
    );
    return screens.map((s) => `${s.bounds.width}x${s.bounds.height}@${s.scaleFactor}`).join(", ");
  }],
  ["window: size round trip", async () => {
    // 900x700, or less where the window's screen cannot fit that (a small CI display): the OS
    // clamps a window to the work area, so ask for a size that fits it and assert exactly that.
    const { width, height, why } = await fittingSize(900, 700);
    await setWindowSize(width, height);
    await unlessTiled(`${width}x${height}`, () =>
      waitFor(
        () => near(innerWidth, width) && near(innerHeight, height),
        `${width}x${height}`,
        5000,
        sizes,
      ));
    const state = await getWindowState();
    assert(state.contentBounds, "no contentBounds");
    assert(
      near(state.contentBounds.width, width),
      `contentBounds.width ${state.contentBounds.width}`,
    );
    return `${innerWidth}x${innerHeight}${why}`;
  }],
  ["window: minimum / maximum size clamp", async () => {
    try {
      await setMinimumWindowSize(640, 480);
      eq(
        String((await getWindowState()).minimumSize),
        "640,480",
        "minimumSize",
      );
      await setWindowSize(300, 200);
      await unlessTiled("300x200 (clamped to the 640x480 minimum)", () =>
        waitFor(
          () => near(innerWidth, 640) && near(innerHeight, 480),
          "640x480 (the minimum)",
          5000,
          sizes,
        ));
      const small = `${innerWidth}x${innerHeight}`;
      await setMaximumWindowSize(820, 620);
      await setWindowSize(1400, 1100);
      // Clamped to the maximum: 820x620, not the 1400x1100 asked for (nor left at the minimum).
      await waitFor(
        () => near(innerWidth, 820) && near(innerHeight, 620),
        "820x620 (the maximum)",
        5000,
        sizes,
      );
      return `asked 300x200 → ${small}, asked 1400x1100 → ${innerWidth}x${innerHeight}`;
    } finally {
      await setMaximumWindowSize(0, 0);
      await setMinimumWindowSize(420, 320);
      await setWindowSize(900, 700);
    }
  }],
  ["window: maximize / unmaximize", async () => {
    await maximizeWindow();
    await unlessTiled(
      "maximized",
      () => waitFor(async () => (await getWindowState()).maximized, "maximized"),
    );
    await unmaximizeWindow();
    await waitFor(
      async () => !(await getWindowState()).maximized,
      "unmaximized",
    );
    return "ok";
  }],
  ["window: backdrop", async ({ setup }) => {
    const caps = await windowCapabilities();
    const backdrop = setup.os === "darwin" ? "vibrancy" : setup.os === "windows" ? "mica" : "none";
    const applied = await setWindowBackdrop(backdrop);
    const supported = backdrop === "none" || caps[backdrop] === true;
    if (backdrop !== "none") {
      eq(applied, supported, `setWindowBackdrop("${backdrop}") applied`);
    }
    await setWindowBackdrop("none");
    return `${backdrop}: ${applied ? "applied" : "not supported here"}`;
  }],
  ["window: a guarded close keeps the app running", async () => {
    let asked = 0;
    const stop = onCloseRequested(() => {
      asked++;
      return false; // keep the window open
    });
    try {
      await sleep(300); // the guard is installed by an RPC of its own
      const quitting = await quitApp();
      eq(quitting, false, "quitApp() while guarded");
      await waitFor(() => asked > 0, "the close handler to be asked");
      await sleep(800);
      eq(
        (await getWindowState()).visible,
        true,
        "the window after the refused close",
      );
    } finally {
      stop();
    }
    return `asked ${asked}x, still open`;
  }],
  ["window: drag and drop plumbing (no pointer)", async () => {
    const stop = onFileDrop(() => {});
    stop();
    await writeFile("kitchen/drag.txt", "drag me", {
      directory: "data",
      recursive: true,
    });
    // No mouse button is held, so the OS drag cannot start: "failed", never a hang.
    const result = await startFileDrag([{
      directory: "data",
      path: "kitchen/drag.txt",
    }]);
    eq(result, "failed", "startFileDrag without a held button");
    // Only picked handles and the app's own folders can be dragged out.
    const refused = await rejection(
      startFileDrag([{ directory: "data", path: "../../../../etc/hosts" }]),
    );
    return `drag → ${result}, escaping path → ${refused}`;
  }],
];

// --- launch: deep links and opened files ---------------------------------------------------

const launchChecks: Check[] = [
  ["deep link: cold start (argv)", async ({ setup, links }) => {
    if (!setup.autorun) {
      throw new Skip("launch the app with a kitchensink-link:// URL");
    }
    const link = await waitFor(
      () => links.find((l) => l.url.startsWith("kitchensink-link://open/cold")),
      "the cold-start link",
    );
    eq(link.launch, true, "launch");
    eq(new URL(link.url).searchParams.get("x"), "1", "the link's query");
    return link.url;
  }],
  [
    "open file: cold start (argv) → a read-only handle",
    async ({ setup, files }) => {
      if (!setup.autorun) throw new Skip("launch the app with a file argument");
      const file = await waitFor(
        () => files.find((f) => f.name === OPEN_FILE_NAME),
        "the file",
      );
      eq(file.launch, true, "launch");
      eq(
        await readFile("", { directory: { picked: file.handle } }),
        OPEN_FILE_TEXT,
        "content",
      );
      const write = await rejection(
        writeFile("", "x", { directory: { picked: file.handle } }),
      );
      return `read ok, write → ${write}`;
    },
  ],
  [
    "deep link: a second launch forwards to the running app",
    async ({ setup, links }) => {
      if (!setup.autorun) throw new Skip("start a second instance with a link");
      const second = await kitchen.secondInstance(
        { id: "warm", args: ["kitchensink-link://open/warm"] },
        { timeoutMs: 60_000 },
      );
      eq(second.code, 0, "the second instance's exit code (it hands over and exits)");
      const link = await waitFor(
        () => links.find((l) => l.url.startsWith("kitchensink-link://open/warm")),
        "the forwarded link",
        30_000,
        // Did the link reach the app (queued, but its "available" event never reached the page)?
        async () => `queued in the app: ${JSON.stringify(await raw("deepLinks").take({}))}`,
      );
      eq(link.launch, false, "launch");
      return link.url;
    },
  ],
];

// --- native code and updates ---------------------------------------------------------------

const nativeChecks: Check[] = [
  ["Node-API: a prebuilt addon loads in the app's Deno process", async () => {
    const out = await kitchen.crc32({ text: "hello" });
    assert(out.error === undefined, `the addon did not load: ${out.error}`);
    eq(out.value, CRC32_HELLO, "crc32('hello')");
    return "@node-rs/crc32";
  }],
  ["runOnMainThread: an extension's native call runs on the UI thread", async ({ setup }) => {
    if (!setup.pinnedRuntime) {
      throw new Skip("Deno.desktop.runOnMainThread needs the pinned runtime");
    }
    const out = await kitchen.mainThread({}) as { fn: string; js: string; ui: string; pid: number };
    assert(out.ui !== out.js, `${out.fn} answered ${out.ui} on both threads`);
    if (setup.os === "darwin") {
      eq(out.ui, "1", "pthread_main_np() on the UI thread");
      eq(out.js, "0", "pthread_main_np() on the JavaScript thread");
    } else if (setup.os === "linux") {
      eq(out.ui, String(out.pid), "gettid() on the UI thread (the process main thread)");
    }
    return `${out.fn}: UI thread ${out.ui}, JavaScript thread ${out.js}`;
  }],
  [
    "updater: full-app updates configured, no pending trial",
    async ({ setup }) => {
      if (!setup.updateUrls) {
        throw new Skip(
          "package with KITCHEN_SINK_UPDATE_PUBLIC_KEY",
        );
      }
      const status = await kitchen.updateStatus({});
      assert(status, "appUpdateStatus() is null");
      eq(status.configured, true, `configured (${status.reason})`);
      eq(status.trial, false, "trial");
      return `${status.appId} ${status.version} on ${status.platform}`;
    },
  ],
  ["updater: a signed newer manifest is offered", async ({ setup }) => {
    if (!setup.updateUrls) throw new Skip("no local update server");
    const r = await kitchen.updateCheck({ url: setup.updateUrls.good });
    assert(r.ok, `check failed: ${r.code}: ${r.message}`);
    eq(r.result.available, true, "available");
    eq(r.result.version, "99.0.0", "version");
    assert(Number.isSafeInteger(r.result.sequence), `sequence ${r.result.sequence}`);
    assert(r.result.expiresAt && Date.parse(r.result.expiresAt) > Date.now(), "expiresAt");
    const status = await kitchen.updateStatus({});
    eq(status?.manifestSequence, r.result.sequence, "the install's recorded sequence");
    return `${r.result.currentVersion} → ${r.result.version} (sequence ${r.result.sequence})`;
  }],
  ["updater: an expired manifest is refused (expired)", async ({ setup }) => {
    if (!setup.updateUrls) throw new Skip("no local update server");
    const r = await kitchen.updateCheck({ url: setup.updateUrls.expired });
    eq(r.ok ? `available: ${r.result.available}` : r.code, "expired", "the check");
    return "expired";
  }],
  ["updater: a lower sequence than accepted is refused (replayed)", async ({ setup }) => {
    if (!setup.updateUrls) throw new Skip("no local update server");
    // Runs after the newer manifest's check recorded its sequence as the install's floor.
    const r = await kitchen.updateCheck({ url: setup.updateUrls.replayed });
    eq(r.ok ? `available: ${r.result.available}` : r.code, "replayed", "the check");
    return "replayed";
  }],
  ["updater: another key's signature is refused", async ({ setup }) => {
    if (!setup.updateUrls) throw new Skip("no local update server");
    const r = await kitchen.updateCheck({ url: setup.updateUrls.badSignature });
    eq(r.ok ? "accepted" : r.code, "signature", "the check");
    return "signature";
  }],
  ["updater: an older version is refused", async ({ setup }) => {
    if (!setup.updateUrls) throw new Skip("no local update server");
    const r = await kitchen.updateCheck({ url: setup.updateUrls.downgrade });
    eq(
      r.ok ? `available: ${r.result.available}` : r.code,
      "downgrade",
      "the check",
    );
    return "downgrade";
  }],
  ["updater: a manifest for another app is refused (wrong_app)", async ({ setup }) => {
    if (!setup.updateUrls) throw new Skip("no local update server");
    // Signed with this app's own key, newer, but naming another app identifier.
    const r = await kitchen.updateCheck({ url: setup.updateUrls.wrongApp });
    eq(r.ok ? `available: ${r.result.available}` : r.code, "wrong_app", "the check");
    return "wrong_app";
  }],
  ["updater: confirmAppUpdate() is a no-op outside a trial launch", async ({ setup }) => {
    if (!setup.updateUrls) throw new Skip("package with KITCHEN_SINK_UPDATE_PUBLIC_KEY");
    const r = await kitchen.updateConfirm({});
    assert(r.ok, `confirmAppUpdate() threw ${r.code}: ${r.message}`);
    eq(r.result, false, "confirmAppUpdate()");
    return "nothing pending";
  }],
];

// --- security: the bridge gate, auth sessions, passkeys and the Clerk bridge -----------------

/** The RPC endpoint the bridge client posts to (`denext/desktop/client`). */
const RPC_PATH = "/_denext/desktop/rpc";

/** The per-launch token the runtime injected into this (top-level) document. */
function pageToken(): string {
  const token = (globalThis as { __denext?: { token?: unknown } }).__denext?.token;
  assert(typeof token === "string" && token !== "", "no desktop token in this document");
  return token;
}

/** An RPC body asking the harness to write `marker` (proof a request got through the gate). */
const markRequest = (marker: string) =>
  JSON.stringify({ cap: "kitchen", method: "mark", args: { name: marker } });

/** Fail when a probe that must have been refused reached the extension. */
async function assertNotReached(marker: string): Promise<void> {
  eq((await kitchen.markerExists({ name: marker })).exists, false, `the ${marker} marker`);
}

/**
 * Run `fetch` from a sandboxed `srcdoc` frame (an opaque origin: a foreign page) with the page's
 * real token, and return what it saw (`refused: <error>` or `<status> <body>`).
 */
function foreignFrameFetch(url: string, token: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.display = "none";
    frame.srcdoc = `<script>
      addEventListener("message", async (e) => {
        let out;
        try {
          const res = await fetch(e.data.url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-denext-desktop-token": e.data.token },
            body: e.data.body,
          });
          out = res.status + " " + (await res.text()).slice(0, 200);
        } catch (err) {
          out = "refused: " + String(err && err.message || err);
        }
        parent.postMessage({ kitchenFrame: out, origin: String(origin) }, "*");
      });
      parent.postMessage({ kitchenFrameReady: true }, "*");
    </script>`;
    const timer = setTimeout(() => done(new Error("the frame never answered")), 10_000);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      if (e.data?.kitchenFrameReady) frame.contentWindow?.postMessage({ url, token, body }, "*");
      else if (typeof e.data?.kitchenFrame === "string") {
        done(undefined, `${e.data.kitchenFrame} (frame origin ${e.data.origin})`);
      }
    };
    const done = (err?: Error, value?: string) => {
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      frame.remove();
      if (err) reject(err);
      else resolve(value!);
    };
    addEventListener("message", onMessage);
    document.body.append(frame);
  });
}

/** base64url, unpadded. */
function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

/** A passkey options JSON for `kind` and `rpId` (never reaches an authenticator). */
function passkeyOptions(kind: "create" | "get", rpId: string): Record<string, unknown> {
  const challenge = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return kind === "get" ? { rpId, challenge } : {
    rp: { id: rpId, name: "Kitchen sink" },
    user: { id: base64Url(new Uint8Array([1, 2, 3])), name: "kitchen", displayName: "Kitchen" },
    challenge,
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  };
}

/** The error code of a passkey envelope (`ok` when it succeeded). */
function envelopeCode(envelope: unknown): string {
  const e = envelope as { ok?: boolean; error?: { code?: string } } | null;
  return e?.ok === true ? "ok" : String(e?.error?.code ?? JSON.stringify(envelope));
}

/** `@clerk/electron`'s globals, as the preload's `installClerkDesktopBridge` set them. */
interface ClerkGlobals {
  __clerk_internal_electron?: {
    tokenCache: {
      getToken(key: string): Promise<string | null>;
      saveToken(key: string, value: string): Promise<void>;
      clearToken(key: string): Promise<void>;
    };
    oauthTransport: { getRedirectUrl(): Promise<string>; open(url: string): Promise<unknown> };
  };
  __clerk_internal_electron_passkeys?: {
    get(options: unknown): Promise<unknown>;
    create(options: unknown): Promise<unknown>;
    capabilities(): Promise<{ available: boolean }>;
    readonly platform: string;
  };
}

const securityChecks: Check[] = [
  ["bridge gate: a wrong token is refused (top-level page)", async () => {
    const res = await fetch(RPC_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "x-denext-desktop-token": "not-the-token" },
      body: markRequest("wrong-token-reached"),
    });
    const body = await res.json().catch(() => null) as { error?: { code?: string } } | null;
    eq(res.status, 403, "status");
    eq(body?.error?.code, "forbidden", "error code");
    await assertNotReached("wrong-token-reached");
    return "403 forbidden";
  }],
  ["bridge gate: a foreign-origin frame holding the token is refused", async () => {
    // The worst case: a foreign page (an opaque-origin frame) that somehow learned the token.
    const seen = await foreignFrameFetch(
      `${location.origin}${RPC_PATH}`,
      pageToken(),
      markRequest("frame-probe-reached"),
    );
    assert(!/^2\d\d /.test(seen), `the frame's request succeeded: ${seen}`);
    await assertNotReached("frame-probe-reached");
    return seen;
  }],
  ["bridge gate: the token over plain TCP (the runtime's loopback relay) is refused", async () => {
    const { relay, probes } = await kitchen.tcpProbe({
      token: pageToken(),
      origin: location.origin,
    }) as { relay: string | null; probes: Array<{ name: string; status: string }> };
    assert(relay, "the runtime published no loopback relay (DENO_DESKTOP_WS_URL)");
    eq(probes.length, 4, "probes run");
    for (const p of probes) {
      assert(!/ (2\d\d|101) /.test(`${p.status} `), `${p.name} was accepted: ${p.status}`);
    }
    await assertNotReached("tcp-probe-reached");
    return probes.map((p) => `${p.name} → ${p.status.replace(/^HTTP\/1\.1 /, "")}`).join("; ");
  }],
  ["auth session: the OS's own session where it has one, else not_supported", async ({ setup }) => {
    if (!setup.pinnedRuntime) throw new Skip("Deno.desktop.authSession needs the pinned runtime");
    const page = await raw("authSession").capabilities({}) as { osSession: boolean };
    const out = await kitchen.osAuthSession({}, { timeoutMs: 60_000 }) as {
      available: boolean;
      caps?: { supported: boolean; ephemeral: boolean };
      start?: string;
      expected?: string;
      url?: string;
      error?: string;
      timeout?: boolean;
    };
    eq(out.available, true, "Deno.desktop.authSession");
    eq(out.caps?.supported, setup.os === "darwin", "capabilities().supported");
    eq(page.osSession, setup.os === "darwin", "the authSession capability's osSession");
    if (setup.os !== "darwin") {
      eq(out.start, "not_supported", "start() without an OS auth session");
      return "not_supported: openAuthSession uses the system browser and the Cancel overlay";
    }
    eq(out.caps?.ephemeral, true, "capabilities().ephemeral");
    if (out.timeout || out.error === "failed" || out.error === "cancelled") {
      throw new Skip(
        `the OS auth session could not run unattended on this runner (${
          out.timeout ? "no callback in 45 s" : out.error
        })`,
      );
    }
    eq(out.error, undefined, "the ephemeral round trip's error");
    eq(out.url, out.expected, "the callback URL the sheet ended at");
    return "ephemeral ASWebAuthenticationSession round trip";
  }],
  [
    "auth session: a forged-state callback from a second instance leaves it pending",
    async ({ setup, links }) => {
      if (!setup.autorun) throw new Skip("the window test starts the second instances");
      if ((await raw("authSession").capabilities({}) as { osSession: boolean }).osSession) {
        throw new Skip(
          "this OS runs the sign-in in its own auth session (no system browser, no deep-link " +
            "callback); the OS-session check covers it",
        );
      }
      const state = crypto.randomUUID();
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64Url(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
      );
      const callback = "kitchensink-link://auth/callback";
      const url = "https://auth.invalid/authorize?response_type=code&client_id=kitchen" +
        `&redirect_uri=${encodeURIComponent(callback)}&state=${state}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`;
      let settled: string | null = null;
      const session = openAuthSession(url, {
        callbackScheme: "kitchensink-link",
        timeoutMs: 120_000,
      })
        .then(
          (r) => (settled = `resolved ${r.url}`, r),
          (err) => {
            settled = `rejected ${(err as { code?: string }).code}: ${(err as Error).message}`;
            throw err;
          },
        );
      session.catch(() => {});
      // The runner's stand-in browser (first on PATH) was asked to open exactly this URL.
      await waitFor(
        async () => ((await kitchen.browserLog({})).lines as string[] | null)?.includes(url),
        "the stand-in browser to be asked for the URL",
        10_000,
        async () => `${JSON.stringify((await kitchen.browserLog({})).lines)}; session ${settled}`,
      );
      // The system browser reports no cancellation: the page shows its Cancel overlay meanwhile.
      const overlay = document.getElementById("denext-auth-cancel");
      assert(
        overlay?.querySelector("button"),
        "no Cancel overlay while the browser has the sign-in",
      );
      const forged = await kitchen.secondInstance(
        { id: "auth-forged", args: [`${callback}?code=forged&state=forged-${state}`] },
        { timeoutMs: 60_000 },
      );
      eq(forged.code, 0, "the forged-state second instance's exit code");
      await sleep(1500);
      eq(settled, null, "the session after a forged-state callback");
      const real = await kitchen.secondInstance(
        { id: "auth-real", args: [`${callback}?code=real&state=${state}`] },
        { timeoutMs: 60_000 },
      );
      eq(real.code, 0, "the real callback's second instance exit code");
      const done = await Promise.race([session, sleep(10_000).then(() => null)]);
      assert(done, `the real callback did not complete the session (${settled})`);
      const got = new URL(done.url);
      eq(got.searchParams.get("code"), "real", "the callback's code");
      eq(got.searchParams.get("state"), state, "the callback's state");
      eq(document.getElementById("denext-auth-cancel"), null, "the Cancel overlay after sign-in");
      assert(
        !links.some((l) => l.url.startsWith(callback)),
        "an auth callback reached onDeepLink (it must be consumed by the session)",
      );
      return "forged state swallowed; the real callback completed it";
    },
  ],
  [
    "passkeys: an RP outside desktop.capabilities.passkeys is refused before the OS",
    async ({ setup }) => {
      const caps = await raw("passkeys").capabilities({});
      eq(caps.available, setup.os !== "linux", "capabilities().available");
      const codes: string[] = [];
      for (const kind of ["get", "create"] as const) {
        const envelope = await raw("passkeys")[kind]({
          optionsJson: JSON.stringify(passkeyOptions(kind, "example.com")),
        });
        codes.push(`${kind} → ${envelopeCode(envelope)}`);
        eq(envelopeCode(envelope), "invalid_rp", `${kind} for an RP that is not pinned`);
      }
      return codes.join(", ");
    },
  ],
  ["passkeys: the native path answers without a ceremony", async ({ setup }) => {
    // Pinned, so it reaches the runtime; not a domain name, so the native parser refuses it before
    // any OS request. Linux has no platform authenticator API at all.
    const envelope = await raw("passkeys").get({
      optionsJson: JSON.stringify(passkeyOptions("get", "bad_rp.invalid")),
    });
    const want = setup.os === "linux" ? "not_supported" : "invalid_rp";
    eq(envelopeCode(envelope), want, "a pinned but malformed RP");
    return `${want} (${(envelope as { error?: { message?: string } }).error?.message ?? ""})`;
  }],
  [
    "Clerk bridge: token cache in the keychain, redirect URL, OAuth URL check",
    async ({ setup }) => {
      const g = globalThis as ClerkGlobals;
      const bridge = g.__clerk_internal_electron;
      assert(bridge, "the preload did not install window.__clerk_internal_electron");
      const value = `jwt-${crypto.randomUUID()}`;
      await bridge.tokenCache.saveToken("kitchen-probe", value);
      try {
        eq(await bridge.tokenCache.getToken("kitchen-probe"), value, "getToken");
        eq(
          await raw("secureStore").get({ key: "clerk.kitchen-probe" }),
          value,
          "the keychain entry",
        );
      } finally {
        await bridge.tokenCache.clearToken("kitchen-probe");
      }
      eq(await bridge.tokenCache.getToken("kitchen-probe"), null, "getToken after clearToken");
      // macOS signs in through ASWebAuthenticationSession (no nonce); Windows and Linux use the
      // system browser, so each flow's redirect carries a per-flow `denext_nonce`.
      const redirect = new URL(await bridge.oauthTransport.getRedirectUrl());
      eq(
        `${redirect.protocol}//${redirect.host}${redirect.pathname}`,
        `${setup.appOrigin}/`,
        "getRedirectUrl() target",
      );
      const nonce = redirect.searchParams.getAll("denext_nonce");
      if (setup.os === "darwin") eq(nonce.length, 0, "getRedirectUrl() nonce on macOS");
      else {assert(
          nonce.length === 1 && /^[A-Za-z0-9_-]{22,}$/.test(nonce[0]),
          `getRedirectUrl() nonce: ${redirect.search}`,
        );}
      const refused = await rejection(bridge.oauthTransport.open("http://example.com/oauth"));
      assert(/unsupported OAuth URL protocol/.test(refused), `open(http:) → ${refused}`);
      return `keychain round trip; ${setup.appOrigin}/; http: refused`;
    },
  ],
  [
    "Clerk passkeys bridge: invalid_rp turns native passkeys off for the launch",
    async ({ setup }) => {
      const p = (globalThis as ClerkGlobals).__clerk_internal_electron_passkeys;
      assert(p, "the preload did not install window.__clerk_internal_electron_passkeys");
      const platform = setup.os === "windows" ? "win32" : setup.os;
      // The bridge turns native passkeys off for the rest of the page's life, so a second run in
      // the same page starts from "none"; the first run must still see the platform.
      if (!passkeysBridgeRan) eq(p.platform, platform, "platform before");
      passkeysBridgeRan = true;
      const envelope = await p.get(passkeyOptions("get", "example.com"));
      eq(envelopeCode(envelope), "invalid_rp", "get() for an RP that is not pinned");
      eq(p.platform, "none", "platform after invalid_rp");
      eq((await p.capabilities()).available, false, "capabilities().available after invalid_rp");
      return `${platform} → invalid_rp → none`;
    },
  ],
];

/** Whether the passkeys-bridge check already ran in this page (it switches passkeys off). */
let passkeysBridgeRan = false;

// --- the full-app update phases (window test only) -------------------------------------------

/** The expected staged-signature mode of an unsigned local build, per OS. */
const DEV_SIGNATURE: Record<string, string> = {
  darwin: "dev-unsigned",
  windows: "dev-unsigned",
  linux: "none",
};

/** The version the window test packages as the update (`e2e/window-test.ts`). */
const UPDATE_VERSION = "99.0.0";

/** Checks for one update phase: run on that launch only, then the app installs or quits. */
export const PHASE_CHECKS: Readonly<Record<string, readonly Check[]>> = {
  "update-install": [
    ["update install: a copied install, not on trial", async () => {
      const s = await kitchen.updateStatus({});
      eq(s?.configured, true, `configured (${s?.reason})`);
      eq(s.trial, false, "trial");
      eq(s.version, "1.0.0", "version");
      return `${s.version} at ${s.install}`;
    }],
    [
      `update install: the signed ${UPDATE_VERSION} build downloads, verifies and stages`,
      async ({ setup }) => {
        assert(setup.updateUrls, "no local update server");
        const r = await kitchen.updateDownload({ url: setup.updateUrls.real }, {
          timeoutMs: 150_000,
        });
        assert(r.ok, `download / stage failed: ${r.code}: ${r.message}`);
        eq(r.result.version, UPDATE_VERSION, "staged version");
        eq(r.result.signatureMode, DEV_SIGNATURE[setup.os], "signature mode");
        return `${r.result.version}, signature ${r.result.signatureMode}`;
      },
    ],
  ],
  "update-trial": [
    [`update trial: ${UPDATE_VERSION} runs on trial and is left unconfirmed`, async () => {
      const s = await kitchen.updateStatus({});
      eq(s?.version, UPDATE_VERSION, "version");
      eq(s.trial, true, "trial");
      eq(s.updatedFrom, "1.0.0", "updatedFrom");
      // Deliberately NOT confirmed (`desktop.update.autoConfirm: false`): the next launch must
      // roll it back.
      return `${s.version} from ${s.updatedFrom}, trial`;
    }],
  ],
  "update-rollback": [
    ["update rollback: the unconfirmed version was rolled back at the next launch", async () => {
      const s = await kitchen.updateStatus({});
      eq(s?.version, "1.0.0", "version");
      eq(s.trial, false, "trial");
      eq(s.rolledBackFrom, UPDATE_VERSION, "rolledBackFrom");
      eq(s.rejected, UPDATE_VERSION, "rejected");
      assert(
        s.rejectedVersions?.includes(UPDATE_VERSION),
        `rejectedVersions ${s.rejectedVersions}`,
      );
      return `back on ${s.version}, ${s.rolledBackFrom} rejected`;
    }],
    ["update rollback: the rolled-back version is refused from then on", async ({ setup }) => {
      assert(setup.updateUrls, "no local update server");
      const r = await kitchen.updateCheck({ url: setup.updateUrls.real });
      eq(r.ok ? `available: ${r.result.available}` : r.code, "rejected", "the check");
      return "rejected";
    }],
  ],
  // Windows only, on a runner that trusts the window test's throwaway code-signing roots (an
  // elevated CI runner): the runtime's same-signer check is enforced only for a trusted chain.
  // The installed 1.0.0 is signed with certificate A (`e2e/window-test.ts` "sign" phase).
  "trusted-install": [
    ["trusted install: the A-signed 1.0.0, not on trial", async () => {
      const s = await kitchen.updateStatus({});
      eq(s?.configured, true, `configured (${s?.reason})`);
      eq(s.trial, false, "trial");
      eq(s.version, "1.0.0", "version");
      return `${s.version} at ${s.install}`;
    }],
    [
      `trusted install: ${UPDATE_VERSION} re-signed with another certificate (B) is refused (os_signature)`,
      async ({ setup }) => {
        assert(setup.updateUrls, "no local update server");
        const r = await kitchen.updateDownload({ url: setup.updateUrls.trustedB }, {
          timeoutMs: 150_000,
        });
        eq(r.ok ? `staged (${r.result.signatureMode})` : r.code, "os_signature", "the download");
        const s = await kitchen.updateStatus({});
        eq(s?.version, "1.0.0", "version after the refusal");
        eq(s.trial, false, "trial after the refusal");
        return `os_signature: ${r.message}`;
      },
    ],
    [
      `trusted install: ${UPDATE_VERSION} signed with the same certificate (A) stages as authenticode`,
      async ({ setup }) => {
        assert(setup.updateUrls, "no local update server");
        const r = await kitchen.updateDownload({ url: setup.updateUrls.trustedA }, {
          timeoutMs: 150_000,
        });
        assert(r.ok, `download / stage failed: ${r.code}: ${r.message}`);
        eq(r.result.version, UPDATE_VERSION, "staged version");
        eq(r.result.signatureMode, "authenticode", "signature mode");
        assert(r.result.signer, "no signer reported");
        return `${r.result.version}, authenticode, signer ${r.result.signer}`;
      },
    ],
  ],
  "trusted-trial": [
    [
      `trusted trial: ${UPDATE_VERSION} runs on trial and confirmAppUpdate() confirms it`,
      async () => {
        const s = await kitchen.updateStatus({});
        eq(s?.version, UPDATE_VERSION, "version");
        eq(s.trial, true, "trial");
        eq(s.updatedFrom, "1.0.0", "updatedFrom");
        const r = await kitchen.updateConfirm({});
        assert(r.ok, `confirmAppUpdate() threw ${r.code}: ${r.message}`);
        eq(r.result, true, "confirmAppUpdate()");
        const after = await kitchen.updateStatus({});
        eq(after?.pendingVersion ?? null, null, "pendingVersion after confirming");
        return `${s.version} from ${s.updatedFrom}, confirmed`;
      },
    ],
  ],
  "trusted-relaunch": [
    [`trusted relaunch: still ${UPDATE_VERSION}, not on trial, nothing rolled back`, async () => {
      const s = await kitchen.updateStatus({});
      eq(s?.version, UPDATE_VERSION, "version");
      eq(s.trial, false, "trial");
      eq(s.rolledBackFrom ?? null, null, "rolledBackFrom");
      assert(
        !s.rejectedVersions?.includes(UPDATE_VERSION),
        `rejectedVersions ${s.rejectedVersions}`,
      );
      return `${s.version}, confirmed, no rollback`;
    }],
  ],
};

// --- app: notifications, menus, tray, dock, shortcuts, login, DevTools -----------------------

/** A notification id the checks own (cancelled again at the end of each check). */
const NOTE_ID = 424242;

/** Is this macOS refusing because the notification permission is not granted (asked once)? */
async function macNotificationsRefused(setup: KitchenSetup, err: unknown): Promise<boolean> {
  if (setup.os !== "darwin") return false;
  const state = await checkPermission("notifications").catch(() => "unknown");
  return state !== "granted" && /notif|authoriz|permission|denied/i.test(String(err));
}

/**
 * After nothing reached the OS's scheduled list: a `skip` when the OS has not authorized
 * notifications for this app (macOS refuses an ad-hoc signed app on some hosted runners without
 * saying so), with that state as the reason; otherwise the original failure stands.
 */
async function notScheduled(err: unknown): Promise<never> {
  const os = await raw("notifications").permission({ request: false }).catch(() => null);
  const state = String(os?.state ?? "unknown");
  if (state !== "granted") {
    throw new Skip(
      `the OS has not authorized notifications for this app (authorization: ${state}), and ` +
        `nothing reached its scheduled list: ${(err as Error).message}`,
    );
  }
  throw err;
}

/** Skip where the OS has no notification service (a headless Linux session without a server). */
async function needScheduling(): Promise<void> {
  const caps = await raw("notifications").capabilities({});
  if (caps.schedule !== true) throw new Skip("no notification service in this session");
}

const appChecks: Check[] = [
  ["DevTools: off in a packaged app (desktop.inspectable unset)", async () => {
    const { enabled } = await kitchen.devtools({});
    eq(enabled, false, "Deno.desktop.devtools.enabled");
    return "off";
  }],
  ["app menu: accelerators and roles; a click reaches onAppMenuItem", async () => {
    const caps = await appCapabilities();
    eq(caps.appMenu, true, "appCapabilities().appMenu");
    eq(caps.accelerators, true, "appCapabilities().accelerators");
    await setAppMenu([
      {
        label: "Kitchen",
        submenu: [
          { id: "kitchen-new", label: "New Window", accelerator: "CommandOrControl+Shift+N" },
          "separator",
          { role: "quit" },
        ],
      },
      { label: "Edit", submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    ]);
    const refused = await rejection(setAppMenu([{ role: "format-disk" as "quit" }]));
    eq(refused, "validation", "an unknown role");
    const got: string[] = [];
    const stop = onAppMenuItem((id) => got.push(id));
    try {
      await sleep(300); // the subscription takes the queue once
      // A synthetic OS click on the adopted window (no unattended keyboard): runtime → page.
      await kitchen.synthetic({
        kind: "window",
        type: "menuclick",
        detail: { id: "kitchen-new" },
      });
      await kitchen.synthetic({ kind: "window", type: "menuclick", detail: { id: "not-in-menu" } });
      await waitFor(() => got.length > 0, "the menu click");
      await sleep(200);
      eq(got.join(","), "kitchen-new", "the clicks reported");
    } finally {
      stop();
    }
    return `menu set; click → ${got[0]}`;
  }],
  [
    "tray: create, bounds, update, destroy (or skip with the runtime's reason)",
    async ({ setup }) => {
      const caps = await appCapabilities();
      // A session with no tray host (stock GNOME, the CI's Xvfb) is reported, never a dead icon.
      if (!caps.tray) throw new Skip(`no tray icon here: ${caps.trayReason ?? "not reported"}`);
      const tray = await createTray({
        icon: PNG_1X1,
        tooltip: "denext kitchen sink",
        menu: [{ id: "show", label: "Show" }, "separator", { role: "quit" }],
      }).catch((err) => {
        if (!isDesktopBridgeError(err) || err.code !== "unsupported") throw err;
        const reason = (err.data as { reason?: unknown } | undefined)?.reason;
        throw new Skip(`createTray(): ${typeof reason === "string" ? reason : err.message}`);
      });
      try {
        await sleep(300);
        const bounds = await tray.getBounds();
        if (setup.os === "darwin") {
          assert(bounds && bounds.width > 0, `bounds ${JSON.stringify(bounds)}`);
        }
        await tray.update({ tooltip: null, menu: [{ id: "show", label: "Show again" }] });
        return `bounds ${bounds ? `${bounds.width}x${bounds.height}` : "null (not reported here)"}`;
      } finally {
        await tray.destroy();
      }
    },
  ],
  [
    "dock: badge, attention and the Dock menu (or skip with the runtime's reason)",
    async ({ setup }) => {
      const caps = await appCapabilities();
      if (!caps.badge) throw new Skip("no badge here: this runtime has no Deno.dock");
      await setBadge(3);
      await setBadge(null);
      await bounce();
      eq(caps.dockMenu, setup.os === "darwin", "appCapabilities().dockMenu");
      await setQuickActions([{ id: "kitchen-chat", title: "New chat" }]);
      const applied = await raw("app").setDockMenu({
        menu: [{ id: "kitchen-chat", label: "New chat" }],
      });
      eq(applied?.applied, setup.os === "darwin", "the Dock menu applied");
      await setQuickActions([]);
      // Where the badge showed (runtime 2.9.7-denext.11): the Dock, a Linux launcher count, or
      // the window-title prefix, with the runtime's reason.
      const shows = caps.badgeShows === "title" && caps.badgeReason
        ? `title (${caps.badgeReason})`
        : caps.badgeShows;
      return `badge on ${shows} + bounce; Dock menu ${applied?.applied ? "set" : "n/a here"}`;
    },
  ],
  [
    "app: the session probe reports the CEF sandbox, the file chooser and the cookie store",
    async ({ setup }) => {
      const caps = await appCapabilities();
      if (!setup.pinnedRuntime || caps.sandbox === "unknown") {
        throw new Skip(
          "this runtime predates the sandbox and file chooser facts (2.9.7-denext.12)",
        );
      }
      // The runner's backend, else CEF's cookie store (only CEF reports one).
      const cef = setup.backend === "cef" || (setup.backend === null &&
        (caps.cookieEncryption === "os" || caps.cookieEncryption === "basic"));
      if (setup.os === "linux" && cef) {
        assert(
          ["namespace", "setuid", "chromium", "off"].includes(String(caps.sandbox)),
          `appCapabilities().sandbox = ${caps.sandbox}`,
        );
        assert(caps.sandboxReason, "the runtime says why (sandboxReason)");
      } else {
        eq(caps.sandbox, null, "appCapabilities().sandbox off Linux CEF");
      }
      if (setup.os === "linux") {
        assert(
          caps.fileChooser === "portal" || caps.fileChooser === "gtk",
          `appCapabilities().fileChooser = ${caps.fileChooser}`,
        );
        if (caps.fileChooser === "gtk") assert(caps.fileChooserReason, "why GTK's chooser");
      } else {
        eq(caps.fileChooser, null, "appCapabilities().fileChooser off Linux");
      }
      // macOS CEF: Chromium's mock keychain, a constant key — obfuscated, never "os".
      if (setup.os === "darwin" && cef) eq(caps.cookieEncryption, "basic", "macOS CEF cookies");
      const sandbox = caps.sandbox === null ? "n/a" : `${caps.sandbox} (${caps.sandboxReason})`;
      return `sandbox ${sandbox}; file chooser ${caps.fileChooser ?? "n/a"}${
        caps.fileChooserReason ? ` (${caps.fileChooserReason})` : ""
      }; cookies ${caps.cookieEncryption}`;
    },
  ],
  ["notifications: permission status from the OS", async () => {
    const caps = await raw("notifications").capabilities({});
    const state = await checkPermission("notifications");
    assert(
      ["granted", "prompt", "blocked", "denied"].includes(state),
      `checkPermission("notifications") = ${state}`,
    );
    // Asked without prompting (requestPushPermission() would show the OS prompt).
    const raw0 = await raw("notifications").permission({ request: false });
    assert(["granted", "prompt", "denied"].includes(raw0?.state), `the OS state ${raw0?.state}`);
    return `${state}; schedule ${caps.schedule}, persists ${caps.schedulePersists}, ` +
      `actions ${caps.actions}, cold start ${caps.coldStart}`;
  }],
  [
    "notifications: a click starts a quit app, a schedule posts while closed (or skip with the runtime's reason)",
    async ({ setup }) => {
      const caps = await raw("notifications").capabilities({});
      // macOS and Windows: the OS does both (macOS from a signed bundle), as reported above.
      if (setup.os !== "linux") {
        return `cold start ${caps.coldStart}, persists ${caps.schedulePersists}`;
      }
      // Linux (runtime 2.9.7-denext.11): the portal and the app's D-Bus service file (a .deb /
      // .rpm install) for the click, a systemd user manager for the schedule; else the runtime
      // says why. An older runtime has neither and gives no reason.
      const missing: string[] = [];
      if (caps.coldStart !== true) {
        missing.push(
          `a click can't start the app: ${caps.coldStartReason ?? "not in this runtime"}`,
        );
      }
      if (caps.schedulePersists !== true) {
        missing.push(
          `a schedule waits for the app: ${caps.schedulePersistsReason ?? "not in this runtime"}`,
        );
      }
      if (missing.length > 0) throw new Skip(missing.join("; "));
      return `cold start and posting while closed (transport ${caps.transport})`;
    },
  ],
  ["notifications: schedule / pending / cancel through the OS", async ({ setup }) => {
    await needScheduling();
    await setNotificationCategories([{ id: "kitchen", actions: [{ id: "open", title: "Open" }] }]);
    try {
      await scheduleNotification({
        id: NOTE_ID,
        title: "Kitchen sink",
        body: "scheduled by the window test",
        trigger: { type: "date", date: Date.now() + 24 * 3600_000 },
        categoryId: "kitchen",
        data: { path: "/" },
      });
    } catch (err) {
      if (await macNotificationsRefused(setup, err)) {
        throw new Skip(
          `macOS: notifications are not allowed for this app (${(err as Error).message})`,
        );
      }
      throw err;
    }
    try {
      // The OS adds the request asynchronously (macOS registers the category first).
      let pending: Awaited<ReturnType<typeof pendingNotifications>> = [];
      const mine = await waitFor(
        async () => {
          pending = await pendingNotifications();
          return pending.find((n) => n.id === NOTE_ID);
        },
        "the notification in pendingNotifications()",
        5000,
        () => JSON.stringify(pending),
      ).catch(notScheduled);
      eq(mine.data.path, "/", "its data");
      const tags = await kitchen.scheduledTags({}) as string[];
      assert(tags.includes(`denext-${NOTE_ID}`), `the OS's scheduled tags: ${tags.join(", ")}`);
    } finally {
      await cancelNotification(NOTE_ID);
    }
    await waitFor(
      async () => !(await pendingNotifications()).some((n) => n.id === NOTE_ID),
      "the notification gone after cancel",
    );
    return "scheduled, listed, cancelled";
  }],
  ["notifications: a repeating trigger is scheduled ahead in the OS", async ({ setup }) => {
    await needScheduling();
    try {
      await scheduleNotification({
        id: NOTE_ID + 1,
        title: "Kitchen sink",
        body: "every day",
        trigger: { type: "daily", hour: 4, minute: 4 },
      });
    } catch (err) {
      if (await macNotificationsRefused(setup, err)) {
        throw new Skip("macOS: notifications are not allowed for this app");
      }
      throw err;
    }
    try {
      let tags: string[] = [];
      await waitFor(
        async () => {
          tags = (await kitchen.scheduledTags({}) as string[])
            .filter((t) => t.startsWith(`denext-${NOTE_ID + 1}-`));
          return tags.length === 16;
        },
        "16 occurrences in the OS",
        5000,
        () => String(tags.length),
      ).catch((err) => tags.length === 0 ? notScheduled(err) : Promise.reject(err));
      eq(
        (await pendingNotifications()).filter((n) => n.id === NOTE_ID + 1).length,
        1,
        "one pending entry",
      );
      return `${tags.length} occurrences`;
    } finally {
      await cancelNotification(NOTE_ID + 1);
    }
  }],
  ["notifications: a click reaches onLocalNotificationTapped (synthetic OS event)", async () => {
    const taps: Array<{ id: number; actionId: string; path: unknown }> = [];
    const stop = onLocalNotificationTapped(
      (t) =>
        taps.push({ id: t.notification.id, actionId: t.actionId, path: t.notification.data.path }),
      { route: false },
    );
    try {
      await sleep(300); // the subscription takes the queue once (installing the runtime listener)
      await kitchen.synthetic({
        kind: "desktop",
        type: "notificationresponse",
        detail: {
          tag: `denext-${NOTE_ID}`,
          action: "open",
          data: { denext: { id: NOTE_ID, t: "Kitchen sink" }, data: { path: "/x" } },
          launch: false,
        },
      });
      await waitFor(() => taps.length > 0, "the tap");
      eq(
        JSON.stringify(taps[0]),
        JSON.stringify({ id: NOTE_ID, actionId: "open", path: "/x" }),
        "tap",
      );
    } finally {
      stop();
    }
    return "routed";
  }],
  [
    "notifications: the web Notification API (denext's shim), a click reaches onclick",
    async ({ setup }) => {
      if (!setup.pinnedRuntime) throw new Skip("the shim needs the pinned runtime");
      // deno-lint-ignore no-explicit-any
      const Web = (globalThis as any).Notification;
      assert(
        typeof Web === "function" && Web.maxActions === 0,
        "Notification is not denext's shim",
      );
      // The OS's own state, asked without a prompt before the request, as the checks above do
      // (a query after an unanswered macOS prompt is unproven), and bounded either way.
      const os = await Promise.race([
        raw("notifications").permission({ request: false }).catch(() => null),
        sleep(3000).then(() => null),
      ]);
      const osState = String(os?.state ?? "unknown");
      const state = await Web.requestPermission();
      eq(Web.permission, state, "Notification.permission after requestPermission()");
      const clicks: string[] = [];
      const shown: string[] = [];
      const note = new Web("Kitchen sink", { body: "a web Notification", tag: "kitchen-web" });
      note.onclick = (e: Event) => clicks.push(`onclick:${e.type}`);
      note.addEventListener("click", () => clicks.push("click"));
      note.onshow = () => shown.push("show");
      note.onerror = () => shown.push("error");
      try {
        if (state !== "granted") {
          // As in a browser without permission: the notification fires `error` and is never
          // posted, so there is nothing to click. macOS refuses an ad-hoc signed app on some
          // hosted runners without a prompt; skip only when the OS itself says it is not granted.
          await waitFor(() => shown.length > 0, "the error event of an unpermitted notification");
          eq(shown.join(","), "error", "the events of a notification without permission");
          assert(
            osState !== "granted",
            `the OS state is granted but requestPermission() = ${state}`,
          );
          throw new Skip(
            `the OS has not authorized notifications for this app (authorization: ${osState}); ` +
              `requestPermission() = ${state} and the notification fired error, so no click`,
          );
        }
        await waitFor(() => shown.length > 0, "the web Notification to be posted");
        eq(shown.join(","), "show", "the events of a posted notification");
        await sleep(300); // the shim's event stream connects on the first notification
        // The OS reporting a click on it (synthetic: the event the runtime dispatches).
        const key = (note as { __key: string }).__key;
        await kitchen.synthetic({
          kind: "desktop",
          type: "notificationresponse",
          detail: { tag: `denext-web-${key}`, action: null, data: { denext: { w: key } } },
        });
        await waitFor(() => clicks.length === 2, "the click on the web Notification");
        eq(clicks.join(","), "onclick:click,click", "the click events");
      } finally {
        note.close();
      }
      return `permission ${state}; click routed`;
    },
  ],
  ["context menu: the native menu; arguments checked before it opens", async () => {
    const caps = await raw("contextMenu").capabilities({});
    eq(caps.native, true, "a native context menu with dismissal");
    const code = await rejection(
      raw("contextMenu").show({ items: [{ label: "no id" }], x: 1, y: 1 }),
    );
    eq(code, "validation", "an item without an id");
    return `native; icons ${caps.icons}, tooltips ${caps.tooltips}`;
  }],
  ["global shortcuts: register / list / a press / unregister", async () => {
    const caps = await shortcutCapabilities();
    if (!caps.globalShortcuts) throw new Skip("no global shortcuts in this session");
    let pressed = 0;
    const s = await registerShortcut("CommandOrControl+Alt+Shift+F9", () => pressed++).catch(
      (err) => {
        // The XDG GlobalShortcuts portal (where the user binds each shortcut): GNOME's asks a
        // person once, and with no one to approve it the registration comes back `denied`.
        if (caps.userBinds && (err as { code?: unknown })?.code === "denied") {
          throw new Skip("the desktop's portal requires user approval for global shortcuts");
        }
        throw err;
      },
    );
    try {
      assert((await listShortcuts()).includes(s.accelerator), "listShortcuts()");
      await sleep(300);
      // A synthetic press (no unattended keyboard): the runtime's event → the page's handler.
      await kitchen.synthetic({
        kind: "shortcuts",
        type: "shortcut",
        detail: { accelerator: s.accelerator },
      });
      await waitFor(() => pressed > 0, "the press");
    } finally {
      await s.unregister();
    }
    assert(!(await listShortcuts()).includes(s.accelerator), "still registered");
    return s.accelerator;
  }],
  ["launch at login: the state, toggled where it needs no approval", async ({ setup }) => {
    const before = await getLaunchAtLogin();
    assert(before !== "not-supported", `getLaunchAtLogin() = ${before}`);
    if (setup.os === "darwin") return `${before} (not toggled: macOS asks the user)`;
    eq(await setLaunchAtLogin(true), "enabled", "after setLaunchAtLogin(true)");
    eq(await setLaunchAtLogin(false), "disabled", "after setLaunchAtLogin(false)");
    return `${before} → enabled → disabled`;
  }],
];

/** Every check, in the order they run. */
export const CHECKS: readonly Check[] = [
  ...runtimeChecks,
  ...storageChecks,
  ...systemChecks,
  ...windowChecks,
  ...appChecks,
  ...launchChecks,
  ...nativeChecks,
  ...securityChecks,
];

/** The checks of `phase`: every check for `main`, else that update phase's. */
export function checksFor(phase: string): readonly Check[] {
  return phase === "main" ? CHECKS : PHASE_CHECKS[phase] ?? [];
}

/**
 * The longest a single check may take. A check whose promise never settles (an OS call that never
 * answers) fails with this as the reason instead of holding back the whole report.
 */
export const CHECK_DEADLINE_MS = 60_000;

/** `run`'s outcome, or a rejection once `ms` pass without one. */
function withDeadline<T>(run: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

/**
 * Run the phase's checks in order, reporting each as it finishes (`onStart` as it begins, so a
 * runner can name the check a stuck page is in).
 */
export async function runChecks(
  ctx: CheckContext,
  onResult: (result: CheckResult) => void,
  onStart?: (name: string, index: number) => void | Promise<void>,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const [name, run] of checksFor(ctx.setup.phase)) {
    await Promise.resolve(onStart?.(name, results.length)).catch(() => {});
    const started = performance.now();
    let result: CheckResult;
    try {
      const detail = await withDeadline(Promise.resolve().then(() => run(ctx)), CHECK_DEADLINE_MS);
      result = {
        name,
        status: "pass",
        detail,
        ms: Math.round(performance.now() - started),
      };
    } catch (err) {
      const status = err instanceof Skip ? "skip" : "fail";
      const detail = err instanceof Error ? err.message : String(err);
      result = {
        name,
        status,
        detail,
        ms: Math.round(performance.now() - started),
      };
    }
    results.push(result);
    onResult(result);
  }
  return results;
}
