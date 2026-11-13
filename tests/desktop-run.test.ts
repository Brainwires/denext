// `runDesktop` (src/build/desktop.ts) end to end, with `Deno.serve` stubbed so the test drives the
// exact handler the window would reach: where it listens, which world it decides it is in (the
// stock runtime's loopback port, the pinned runtime's memory transport, a refused origin), when the
// per-launch token is injected, the live-reload proxy decision, and — under a fake pinned runtime —
// the adopted window, its guarded close and the capabilities registered with it.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  type DesktopCapability,
  DesktopCapError,
  type DesktopExtensionHost,
} from "../src/desktop/extension.ts";
import { injectedGlobal } from "./helpers/desktop-bridge-server.ts";
import { notificationsCapability } from "../src/desktop/caps/notifications.ts";
import {
  boot,
  DENEXT7_DESKTOP,
  exportDir,
  get,
  pageRpc,
  RPC,
  TOKEN_HEADER,
} from "./helpers/desktop-run-boot.ts";

Deno.test("runDesktop (stock runtime): serves the export on loopback; only a loopback document gets the token", async () => {
  const outDir = await exportDir();
  try {
    const { runtime, served } = await boot({ outDir, port: 8123 });
    assertEquals([served.opts.port, served.opts.hostname], [8123, "127.0.0.1"]);
    assertEquals(runtime.window, undefined, "no BrowserWindow under a plain deno run");
    assertEquals(runtime.trust.kind, "loopback");
    const shell = await served.handler(get("http://127.0.0.1:8123/"), {});
    const html = await shell.text();
    const g = injectedGlobal(html)!;
    assertEquals(g.desktop, true);
    assert(typeof g.token === "string" && g.token.length > 0);
    // The CSP meta now allows the injected script by hash.
    assertStringIncludes(html, "script-src 'self' 'sha256-");
    // A DNS-rebinding Host or a subframe learns it is desktop, but gets no token.
    for (
      const req of [
        get("http://evil.example:8123/"),
        get("http://127.0.0.1:8123/", { "sec-fetch-dest": "iframe" }),
      ]
    ) {
      const other = injectedGlobal(await (await served.handler(req, {})).text());
      assertEquals(other?.desktop, true);
      assertEquals(other?.token, undefined);
    }
    assertEquals(
      await (await served.handler(get("http://127.0.0.1:8123/app.js"), {})).text(),
      "console.log('app')",
    );
    // No capabilities: every RPC answers unavailable (default deny), even with the token.
    const rpc = await served.handler(
      new Request(`http://127.0.0.1:8123${RPC}`, {
        method: "POST",
        headers: {
          [TOKEN_HEADER]: g.token as string,
          origin: "http://127.0.0.1:8123",
          "content-type": "application/json",
          "sec-fetch-dest": "empty",
        },
        body: JSON.stringify({ cap: "window", method: "state", args: {} }),
      }),
      {},
    );
    assertEquals((await rpc.json()).error.code, "unavailable");
    // A handler error is a 502, logged, never a crash.
    const errors: unknown[] = [];
    const prev = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      assertEquals(served.opts.onError(new Error("boom")).status, 502);
    } finally {
      console.error = prev;
    }
    assertEquals(errors.length, 1);
    runtime.emit("window", "state", null); // no page subscribed: a no-op
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop: PORT is the default port; a configured app origin without the pinned runtime warns", async () => {
  const outDir = await exportDir();
  try {
    const { served, errors } = await boot({ outDir, appOrigin: "myapp://app" }, {
      env: { PORT: "9011" },
    });
    assertEquals(served.opts.port, 9011);
    assert(errors.some((e) => e.includes('desktop.app.origin "myapp://app" is not in effect')));
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop (pinned runtime): the memory world injects the token only over the memory transport", async () => {
  const outDir = await exportDir();
  try {
    const { runtime, served } = await boot({ outDir, port: 1 }, {
      env: { DENO_DESKTOP_APP_ORIGIN: "myapp://app" },
      deno: { desktop: DENEXT7_DESKTOP },
    });
    assertEquals(runtime.trust.kind, "memory");
    const memory = await served.handler(get("http+memory://app/"), {
      remoteAddr: { transport: "memory" },
    });
    assert(typeof injectedGlobal(await memory.text())?.token === "string");
    // The same URL over TCP (an absolute-form request target) is not the memory transport.
    const tcp = await served.handler(get("http+memory://app/"), {
      remoteAddr: { transport: "tcp" },
    });
    assertEquals(injectedGlobal(await tcp.text())?.token, undefined);
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop (pinned runtime): a runtime older than denext.7 is refused, the stock one is not", async () => {
  const outDir = await exportDir();
  try {
    // denext.6: an app origin and authSession, but no cancel() — and no relay marking.
    const { runtime, served, errors } = await boot({ outDir, port: 1 }, {
      env: { DENO_DESKTOP_APP_ORIGIN: "myapp://app" },
      deno: { desktop: { authSession: { start() {}, capabilities: () => ({}) } } },
    });
    assertEquals(runtime.trust.kind, "refuse");
    assert(errors.some((e) => e.includes("older than 2.9.7-denext.7")));
    assert(errors.some((e) => e.includes("every desktop endpoint is refused")));
    // No token, even for the page's own document over the memory transport.
    const res = await served.handler(get("http+memory://app/"), {
      remoteAddr: { transport: "memory" },
    });
    assertEquals(injectedGlobal(await res.text())?.token, undefined);
    // The stock runtime (no published origin, no relay) keeps its loopback world.
    const stock = await boot({ outDir, port: 1 }, { deno: { desktop: undefined } });
    assertEquals(stock.runtime.trust.kind, "loopback");
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop: a malformed published origin refuses every desktop endpoint", async () => {
  const outDir = await exportDir();
  try {
    const { runtime, served, errors } = await boot({ outDir, port: 1 }, {
      env: { DENO_DESKTOP_APP_ORIGIN: "not an origin" },
    });
    assertEquals(runtime.trust.kind, "refuse");
    assert(errors.some((e) => e.includes("every desktop endpoint is refused")));
    const res = await served.handler(get("http://127.0.0.1:1/"), {});
    assertEquals(injectedGlobal(await res.text())?.token, undefined);
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test({
  name:
    "runDesktop: a loopback dev URL proxies to `denext dev` (token stripped); a remote one is refused",
  fn: async () => {
    const outDir = await exportDir();
    const seen: Array<{ path: string; token: string | null }> = [];
    const ac = new AbortController();
    const dev = Deno.serve({
      port: 0,
      hostname: "127.0.0.1",
      signal: ac.signal,
      onListen: () => {},
    }, (req) => {
      seen.push({ path: new URL(req.url).pathname, token: req.headers.get(TOKEN_HEADER) });
      return new Response("<html><head></head><body>from dev</body></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    try {
      const devUrl = `http://127.0.0.1:${dev.addr.port}`;
      const { served } = await boot({ outDir, port: 1 }, {
        env: { DENEXT_DESKTOP_DEV_URL: devUrl },
      });
      const res = await served.handler(
        get("http://127.0.0.1:1/settings", { [TOKEN_HEADER]: "launch-token" }),
        {},
      );
      const html = await res.text();
      assertStringIncludes(html, "from dev");
      assert(
        typeof injectedGlobal(html)?.token === "string",
        "a loopback dev target gets the token",
      );
      assertEquals(seen[0].path, "/settings");
      assertEquals(
        seen[0].token,
        null,
        "the token never reaches the dev server",
      );
      // A non-loopback target without --lan: refused, the static export is served instead.
      const remote = await boot({ outDir, port: 1 }, {
        env: { DENEXT_DESKTOP_DEV_URL: "http://192.168.1.50:3000" },
      });
      assert(remote.errors.some((e) => e.includes("serving the static export")));
      assertStringIncludes(
        await (await remote.served.handler(get("http://127.0.0.1:1/"), {})).text(),
        '<div id="root">',
      );
    } finally {
      ac.abort();
      await dev.finished;
      await Deno.remove(outDir, { recursive: true });
    }
  },
});

/** A pinned-runtime window: enough for the window controller and the app controller. */
class FakeBrowserWindow extends EventTarget {
  static last: FakeBrowserWindow | undefined;
  closed = false;
  constructor() {
    super();
    FakeBrowserWindow.last = this;
  }
  getBounds() {
    return { x: 0, y: 0, width: 1024, height: 768 };
  }
  isMaximized() {
    return false;
  }
  setTitle(_t: string) {}
  close() {
    this.closed = true;
  }
}

Deno.test("runDesktop (pinned runtime): adopts the window; its capabilities answer; a guarded close keeps the app", async () => {
  const outDir = await exportDir();
  const exits: number[] = [];
  try {
    const desktop = Object.assign(new EventTarget(), { quit: () => false, launchUrls: [] });
    const { runtime, served } = await boot({ outDir, port: 1, deepLinks: ["myapp"] }, {
      deno: {
        BrowserWindow: FakeBrowserWindow,
        desktop,
        exit: (code: number) => void exits.push(code),
      },
    });
    const win = FakeBrowserWindow.last!;
    assertEquals(runtime.window, win);
    const token = injectedGlobal(
      await (await served.handler(get("http://127.0.0.1:1/"), {})).text(),
    )!
      .token as string;
    const rpc = pageRpc(served, token);
    assertEquals(((await rpc("window", "state")).data as { bounds: unknown }).bounds, {
      x: 0,
      y: 0,
      width: 1024,
      height: 768,
    });
    assertEquals((await rpc("deepLinks", "take")).ok, true, "the launch router is registered");
    assertEquals((await rpc("app", "capabilities")).ok, true, "the app controller is registered");
    // With the page guarding the close, the native close is held, not an exit.
    assertEquals((await rpc("window", "setCloseGuard", { enabled: true })).ok, true);
    const held = new Event("close", { cancelable: true });
    win.dispatchEvent(held);
    assert(held.defaultPrevented);
    assertEquals(exits, []);
    // Unguarded, the native close ends the process.
    assertEquals((await rpc("window", "setCloseGuard", { enabled: false })).ok, true);
    win.dispatchEvent(new Event("close", { cancelable: true }));
    assertEquals(exits, [0]);
  } finally {
    FakeBrowserWindow.last = undefined;
    await Deno.remove(outDir, { recursive: true });
  }
});

/** A pinned-runtime window that can be opened, navigated, shown and given an application menu. */
class FakeMenuWindow extends FakeBrowserWindow {
  static all: FakeMenuWindow[] = [];
  menus: unknown[][] = [];
  calls: string[] = [];
  constructor(readonly options?: Record<string, unknown>) {
    super();
    FakeMenuWindow.all.push(this);
  }
  navigate(url: string) {
    this.calls.push(`navigate:${url}`);
  }
  show() {
    this.calls.push("show");
  }
  hide() {
    this.calls.push("hide");
  }
  focus() {
    this.calls.push("focus");
  }
  isVisible() {
    return true;
  }
  setBounds(b: Record<string, number>) {
    this.calls.push(`setBounds:${JSON.stringify(b)}`);
  }
  setApplicationMenu(menu: unknown[]) {
    this.menus.push(menu);
  }
}

/** A `Deno.desktop` whose `quit()` is the pinned runtime's: beforequit, then every window's close. */
function quittingDesktop(windows: () => readonly EventTarget[]) {
  const quits: number[] = [];
  const cancels: number[] = [];
  const desktop = Object.assign(new EventTarget(), {
    launchUrls: [],
    screens: () => [],
    quitOnLastWindowClosed: true,
    quit: () => {
      const before = new Event("beforequit", { cancelable: true });
      desktop.dispatchEvent(before);
      if (before.defaultPrevented) return false;
      for (const win of windows()) {
        const close = new Event("close", { cancelable: true });
        win.dispatchEvent(close);
        if (close.defaultPrevented) return false;
      }
      quits.push(1);
      return true;
    },
    cancelQuit: () => {
      cancels.push(1);
      return true;
    },
  });
  return { desktop, quits, cancels };
}

/** Wait for `cond`, up to `ms`. */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 2));
  }
}

Deno.test("runDesktop (pinned runtime): the window lifecycle, the quit guard, the window menu and the restored session are wired", async () => {
  const outDir = await exportDir();
  const support = await Deno.makeTempDir({ prefix: "denext-run-support-" });
  const exits: number[] = [];
  FakeMenuWindow.all = [];
  try {
    // The last session: a keyed "notes" window with a saved frame.
    await Deno.writeTextFile(
      join(support, "windows.json"),
      JSON.stringify({
        version: 1,
        bounds: { notes: { x: 40, y: 50, width: 400, height: 300 } },
        session: [{ key: "notes", url: "/notes" }],
      }),
    );
    const { desktop, quits, cancels } = quittingDesktop(() => FakeMenuWindow.all);
    const opened: string[] = [];
    const quitHooks: string[] = [];
    let hostWindows: () => readonly { id: string; key?: string }[] = () => [];
    const ext: DesktopCapability = {
      name: "ext",
      methods: {},
      onWindowOpened: (info) => void opened.push(info.key ?? info.id),
      onAppQuit: () => void quitHooks.push("static"),
      setup: (host) => {
        hostWindows = () => host.windows();
        host.onAppQuit(() => void quitHooks.push("host"));
      },
    };
    const { runtime, served } = await boot({
      outDir,
      port: 1,
      appSupportDir: support,
      app: { restoreWindows: true, maxWindows: 3 },
      window: { key: "workspace", title: "Workspace" },
      configMenu: { window: { newWindow: "/", reopenClosed: true, list: true } },
      newWindow: ({ suggestedKey }) => ({ url: "/fresh", key: suggestedKey, title: "Fresh" }),
      capabilities: [ext],
    }, {
      deno: {
        BrowserWindow: FakeMenuWindow,
        desktop,
        exit: (code: number) => void exits.push(code),
      },
    });
    const main = FakeMenuWindow.all[0];
    assertEquals(runtime.window, main);
    // The main window's key (desktop.window.key), and the session restored at launch.
    assertEquals(runtime.windows.byKey("workspace")?.id, "main");
    const notes = runtime.windows.byKey("notes");
    assert(notes, "the last session's window was reopened");
    assertEquals(runtime.windows.lastSession().map((w) => w.key), ["notes"]);
    const notesWin = FakeMenuWindow.all[1];
    assertEquals(notesWin.options, { x: 40, y: 50, width: 400, height: 300 }, "its saved frame");
    // (The stubbed serve has no addr, so the app URL falls back to the default port.)
    assertEquals(notesWin.calls.map((c) => c.replace(/https?:\/\/[^/]+/, "")), ["navigate:/notes"]);
    // The capabilities' static hooks and the setup host see the windows.
    assertEquals(opened, ["workspace", "notes"]);
    assertEquals(hostWindows().map((w) => w.key), ["workspace", "notes"]);
    // The Window menu (desktop.menu.window) is on the main window; New Window opens desktop.ts's window.
    const menu = main.menus.at(-1) as { submenu: { label: string; items: unknown[] } }[];
    // On macOS the managed app menu and Edit come first (AppKit's first submenu is the app menu).
    assertEquals(
      menu.map((e) => e.submenu.label),
      Deno.build.os === "darwin" ? ["App", "Edit", "Window"] : ["Window"],
    );
    // A real click: the window's "menuclick", then (from laufey API 55) Deno.desktop's. Which one
    // denext hears depends on the runtime running the test; exactly one New Window either way.
    const click = { detail: { id: "denext:window:new" } };
    main.dispatchEvent(new CustomEvent("menuclick", click));
    desktop.dispatchEvent(new CustomEvent("menuclick", click));
    assertEquals(runtime.windows.byKey("window-1")?.key, "window-1");
    assertEquals(runtime.windows.byKey("window-2"), undefined, "one click, one window");
    assertEquals(
      FakeMenuWindow.all.at(-1)!.calls.map((c) => c.replace(/https?:\/\/[^/]+/, "")),
      ["navigate:/fresh"],
    );
    assertEquals(runtime.windows.list().length, 3);
    // A document navigation with several windows open is attributed per page (windowCount), and a
    // request from a window token nobody has is refused.
    const token = injectedGlobal(
      await (await served.handler(
        get("http://127.0.0.1:1/", { "sec-fetch-mode": "navigate" }),
        {},
      )).text(),
    )!.token as string;
    const foreign = await served.handler(
      new Request(`http://127.0.0.1:1${RPC}`, {
        method: "POST",
        headers: {
          [TOKEN_HEADER]: token,
          "x-denext-desktop-window": "not-a-window",
          origin: "http://127.0.0.1:1",
          "content-type": "application/json",
          "sec-fetch-dest": "empty",
        },
        body: JSON.stringify({ cap: "app", method: "capabilities", args: {} }),
      }),
      {},
    );
    assertEquals((await foreign.json()).error, { code: "forbidden", message: "unknown window" });
    // The runtime's own surface: emit, sidecar, the activation policy, onBeforeQuit.
    runtime.emit("ext", "note", { n: 1 }, { window: "main" });
    assertThrows(() => runtime.sidecar("api"), Error, "none declared");
    assertEquals(runtime.setActivationPolicy("regular"), false, "no Dock / taskbar API here");
    assertEquals(runtime.getActivationPolicy(), null);
    const off = runtime.onBeforeQuit(() => false);
    assertEquals(desktop.quit(), false, "held for the guard");
    await until(() => cancels.length > 0);
    assertEquals([quits.length, quitHooks.length], [0, 0], "refused: nothing quit, no hook ran");
    off();
    assertEquals(desktop.quit(), false, "held while the quit hooks run");
    await until(() => quits.length > 0);
    assertEquals(quitHooks.sort(), ["host", "static"]);
    assertEquals(exits, [], "the runtime ends the process after its quit");
  } finally {
    FakeBrowserWindow.last = undefined;
    FakeMenuWindow.all = [];
    await Deno.remove(outDir, { recursive: true });
    await Deno.remove(support, { recursive: true });
  }
});

Deno.test("runDesktop (pinned runtime): an extension host opens windows through desktop.ts's windows.open", async () => {
  const outDir = await exportDir();
  FakeMenuWindow.all = [];
  try {
    const { desktop } = quittingDesktop(() => FakeMenuWindow.all);
    let host: DesktopExtensionHost | undefined;
    const ext: DesktopCapability = {
      name: "jobs",
      methods: {},
      setup: (h) => void (host = h),
    };
    const { runtime } = await boot({ outDir, port: 1, capabilities: [ext] }, {
      deno: { BrowserWindow: FakeMenuWindow, desktop, exit: () => {} },
    });
    assert(host);
    const ref = host.openWindow({ url: "/jobs", key: "jobs", title: "Jobs" });
    assertEquals(runtime.windows.byKey("jobs")?.id, ref.id);
    assertEquals(host.windows().map((w) => w.key ?? w.id), ["main", "jobs"]);
    assertEquals(
      FakeMenuWindow.all.at(-1)!.calls.map((c) => c.replace(/https?:\/\/[^/]+/, "")),
      ["navigate:/jobs"],
    );
    // The same key rules as windows.open: a duplicate is refused.
    assertThrows(() => host!.openWindow({ url: "/jobs", key: "jobs" }));
    // A runtime without message boxes (this fake has no Deno.desktop.dialog): unsupported.
    const err = await assertRejects(() => host!.confirm({ message: "Quit?" }), DesktopCapError);
    assertEquals(err.code, "unsupported");
  } finally {
    FakeBrowserWindow.last = undefined;
    FakeMenuWindow.all = [];
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop (pinned runtime): an extension host's openWindow takes desktop.titleBar and defaultWidth / defaultHeight", async () => {
  const outDir = await exportDir();
  FakeMenuWindow.all = [];
  /** A window that records its title bar style too. */
  class TitleBarWindow extends FakeMenuWindow {
    setTitleBarStyle(style: string) {
      this.calls.push(`titleBar:${style}`);
    }
  }
  try {
    const { desktop } = quittingDesktop(() => FakeMenuWindow.all);
    let host: DesktopExtensionHost | undefined;
    const ext: DesktopCapability = { name: "jobs", methods: {}, setup: (h) => void (host = h) };
    await boot({ outDir, port: 1, capabilities: [ext], window: { titleBar: "hiddenInset" } }, {
      deno: { BrowserWindow: TitleBarWindow, desktop, exit: () => {} },
    });
    assert(host);
    host.openWindow({ url: "/jobs", key: "jobs", defaultWidth: 640, defaultHeight: 480 });
    const opened = FakeMenuWindow.all.at(-1)!;
    assertEquals(opened.calls.filter((c) => c.startsWith("titleBar")), ["titleBar:hiddenInset"]);
    assertEquals([opened.options?.width, opened.options?.height], [640, 480]);
    // The window's own titleBar wins, as with windows.open.
    host.openWindow({ url: "/b", key: "b", titleBar: "hidden" });
    assertEquals(
      FakeMenuWindow.all.at(-1)!.calls.filter((c) => c.startsWith("titleBar")),
      ["titleBar:hidden"],
    );
  } finally {
    FakeBrowserWindow.last = undefined;
    FakeMenuWindow.all = [];
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop: a close before the windows are set up goes through the close rules, not a bare exit", async () => {
  const outDir = await exportDir();
  const exits: number[] = [];
  /** A window closed by the user right after it was adopted, before the sidecars were started. */
  class EarlyClosedWindow extends FakeMenuWindow {
    constructor(options?: Record<string, unknown>) {
      super(options);
      queueMicrotask(() => this.dispatchEvent(new Event("close", { cancelable: true })));
    }
  }
  FakeMenuWindow.all = [];
  try {
    const { desktop } = quittingDesktop(() => FakeMenuWindow.all);
    const { runtime } = await boot({ outDir, port: 1, app: { keepAlive: true } }, {
      deno: {
        BrowserWindow: EarlyClosedWindow,
        desktop,
        exit: (code: number) => void exits.push(code),
      },
    });
    // Kept alive: the early close dropped the window instead of ending the process.
    assertEquals(exits, []);
    assertEquals(runtime.windows.get("main"), undefined);
  } finally {
    FakeBrowserWindow.last = undefined;
    FakeMenuWindow.all = [];
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop (pinned runtime): the app's own Window-menu items reach desktop.ts and the extensions once; runtime.quit() skips its own guard", async () => {
  const outDir = await exportDir();
  FakeMenuWindow.all = [];
  try {
    const { desktop, quits } = quittingDesktop(() => FakeMenuWindow.all);
    const fromRunDesktop: unknown[] = [];
    const fromHost: unknown[] = [];
    const ext: DesktopCapability = {
      name: "ext",
      methods: {},
      setup: (host) => {
        host.onWindowMenuItem((id, ctx) => void fromHost.push([id, ctx]));
      },
    };
    const { runtime, served } = await boot({
      outDir,
      port: 1,
      window: { key: "workspace" },
      configMenu: {
        window: {
          items: [{ id: "end", label: "Close and End", accelerator: "CommandOrControl+E" }],
        },
      },
      onWindowMenuItem: (id, ctx) => void fromRunDesktop.push([id, ctx]),
      capabilities: [ext],
    }, { deno: { BrowserWindow: FakeMenuWindow, desktop, exit: () => {} } });
    const main = FakeMenuWindow.all[0];
    const menu = main.menus.at(-1) as { submenu: { label: string; items: unknown[] } }[];
    // (The submenu also carries the macOS roles when the test runs on a Mac.)
    const windowMenu = menu.find((e) => e.submenu.label === "Window")!;
    const items = windowMenu.submenu.items.filter((e) => typeof e === "object" && e && "item" in e);
    assertEquals(items, [{
      item: {
        id: "denext:window:item:end",
        label: "Close and End",
        enabled: true,
        accelerator: "CommandOrControl+E",
      },
    }]);
    // A real click: the window's "menuclick", then Deno.desktop's; denext hears one of them.
    const click = { detail: { id: "denext:window:item:end" } };
    main.dispatchEvent(new CustomEvent("menuclick", click));
    desktop.dispatchEvent(new CustomEvent("menuclick", click));
    const expected = [["end", { keyWindow: { id: "main", key: "workspace" } }]];
    assertEquals(fromRunDesktop, expected, "desktop.ts: once");
    assertEquals(fromHost, expected, "the extension: once");
    // Never queued for a page.
    const token = injectedGlobal(
      await (await served.handler(get("http://127.0.0.1:1/"), {})).text(),
    )!.token as string;
    assertEquals((await pageRpc(served, token)("app", "take")).data, []);
    // runtime.quit(): its own guard (which cancelled to ask) is not asked again.
    let asked = 0;
    runtime.onBeforeQuit(() => (asked++, false));
    assertEquals(desktop.quit(), false);
    await until(() => asked === 1);
    assertEquals(await runtime.quit(), true);
    assertEquals([asked, quits.length], [1, 1]);
  } finally {
    FakeBrowserWindow.last = undefined;
    FakeMenuWindow.all = [];
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop (pinned runtime): onWillNavigate, the extensions' and the runtime's hooks see every window's navigations", async () => {
  const outDir = await exportDir();
  FakeMenuWindow.all = [];
  try {
    const { desktop } = quittingDesktop(() => FakeMenuWindow.all);
    Object.assign(desktop, { navigationEvents: true });
    const seen: string[] = [];
    let host: DesktopExtensionHost | undefined;
    const ext: DesktopCapability = { name: "ext", methods: {}, setup: (h) => void (host = h) };
    const { runtime } = await boot({
      outDir,
      port: 1,
      capabilities: [ext],
      onWillNavigate: (e) => {
        seen.push(`desktop.ts ${e.window} ${e.url}`);
        if (e.url.startsWith("https://evil.test")) e.preventDefault();
      },
    }, { deno: { BrowserWindow: FakeMenuWindow, desktop, exit: () => {} } });
    const offHost = host!.onWillNavigate((e) => {
      seen.push(`host ${e.window} ${e.url}`);
      if (e.url.startsWith("https://idp.test")) e.allow();
    });
    const offRuntime = runtime.onWillNavigate((e) => void seen.push(`runtime ${e.window}`));
    const go = (win: EventTarget, url: string) => {
      const allowed: string[] = [];
      const event = new CustomEvent("willnavigate", {
        cancelable: true,
        detail: { url, kind: "link", allow: () => void allowed.push(url) },
      });
      win.dispatchEvent(event);
      return { prevented: event.defaultPrevented, allowed };
    };
    const main = FakeMenuWindow.all[0];
    assertEquals(go(main, "https://evil.test/"), { prevented: true, allowed: [] });
    assertEquals(go(main, "https://idp.test/a"), {
      prevented: false,
      allowed: ["https://idp.test/a"],
    });
    // A window opened later is listened to as well, under its own id.
    const opened = runtime.windows.open({ url: "/" });
    const second = FakeMenuWindow.all.at(-1)!;
    assert(second !== main);
    assertEquals(go(second, "https://evil.test/2").prevented, true);
    assertEquals(seen.slice(0, 3), [
      "desktop.ts main https://evil.test/",
      "host main https://evil.test/",
      "runtime main",
    ]);
    assert(seen.includes(`desktop.ts ${opened.id} https://evil.test/2`), seen.join("\n"));
    offHost();
    offRuntime();
    seen.length = 0;
    go(main, "myapp://app/");
    assertEquals(seen, ["desktop.ts main myapp://app/"]);
  } finally {
    FakeBrowserWindow.last = undefined;
    FakeMenuWindow.all = [];
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop (pinned runtime): a second launch reaches onSecondInstance, the extensions and still the deep links", async () => {
  const outDir = await exportDir();
  FakeMenuWindow.all = [];
  try {
    const { desktop } = quittingDesktop(() => FakeMenuWindow.all);
    const fromRunDesktop: unknown[] = [];
    const fromHook: unknown[] = [];
    const fromHost: unknown[] = [];
    const fromRuntime: unknown[] = [];
    let host: DesktopExtensionHost | undefined;
    const ext: DesktopCapability = {
      name: "ext",
      methods: {},
      onSecondInstance: (event) => void fromHook.push(event),
      setup: (h) => {
        host = h;
      },
    };
    const { runtime, served } = await boot({
      outDir,
      port: 1,
      deepLinks: ["myapp"],
      onSecondInstance: (event) => void fromRunDesktop.push(event),
      capabilities: [ext],
    }, { deno: { BrowserWindow: FakeMenuWindow, desktop, exit: () => {} } });
    const off = host!.onSecondInstance((event) => void fromHost.push(event));
    const offRuntime = runtime.onSecondInstance((event) => void fromRuntime.push(event));
    const launch = (args: string[]) =>
      desktop.dispatchEvent(
        new CustomEvent("secondinstance", {
          detail: { args, cwd: "/work", urls: ["myapp://open/1"], files: [] },
        }),
      );
    launch(["myapp://open/1", "--flag"]);
    const expected = [{ args: ["myapp://open/1", "--flag"], cwd: "/work" }];
    await until(() => fromHook.length === 1);
    assertEquals(fromRunDesktop, expected);
    assertEquals(fromHook, expected);
    assertEquals(fromHost, expected);
    assertEquals(fromRuntime, expected, "DesktopRuntime.onSecondInstance");
    // The deep link is routed to the page as before.
    const token = injectedGlobal(
      await (await served.handler(get("http://127.0.0.1:1/"), {})).text(),
    )!.token as string;
    assertEquals((await pageRpc(served, token)("deepLinks", "take")).data, [
      { url: "myapp://open/1", launch: false },
    ]);
    // Unsubscribed: the host hears no more; desktop.ts's handler and the static hook still do.
    off();
    offRuntime();
    launch([]);
    await until(() => fromHook.length === 2);
    assertEquals([fromRunDesktop.length, fromHost.length, fromRuntime.length], [2, 1, 1]);
  } finally {
    FakeBrowserWindow.last = undefined;
    FakeMenuWindow.all = [];
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop (pinned runtime): notification clicks reach onNotificationClick, the extensions, the runtime and still the page", async () => {
  const outDir = await exportDir();
  FakeMenuWindow.all = [];
  try {
    const { desktop } = quittingDesktop(() => FakeMenuWindow.all);
    // The click that launched the app: on a notification the page posted.
    const pageData = { denext: { id: 3 }, data: { path: "/inbox" } };
    Object.assign(desktop, {
      notifications: {
        capabilities: () => ({}),
        schedule: () => Promise.resolve(""),
        getScheduled: () => Promise.resolve([]),
      },
      launchNotificationResponses: [{
        tag: "denext-3",
        action: null,
        data: pageData,
        launch: true,
      }],
    });
    const fromRunDesktop: unknown[] = [];
    const fromHost: unknown[] = [];
    const fromRuntime: unknown[] = [];
    let host: DesktopExtensionHost | undefined;
    const ext: DesktopCapability = { name: "ext", methods: {}, setup: (h) => void (host = h) };
    const { runtime, served } = await boot({
      outDir,
      port: 1,
      capabilities: [ext, notificationsCapability({ api: desktop, autoTopUp: false })],
      onNotificationClick: (click) => void fromRunDesktop.push(click),
    }, { deno: { BrowserWindow: FakeMenuWindow, desktop, exit: () => {} } });
    const offHost = host!.onNotificationClick((click) => void fromHost.push(click));
    // Subscribed after runDesktop resolved: the launch click still arrives.
    const offRuntime = runtime.onNotificationClick((click) => void fromRuntime.push(click));
    await until(() => fromRuntime.length === 1);
    const launch = { tag: "denext-3", action: null, data: pageData, launch: true };
    assertEquals([fromRunDesktop, fromHost, fromRuntime], [[launch], [launch], [launch]]);
    // A click on a notification the backend posted itself through Deno.desktop.notifications.
    desktop.dispatchEvent(
      new CustomEvent("notificationresponse", {
        detail: { tag: "sync-failed", action: "retry", data: { job: 7 } },
      }),
    );
    const own = { tag: "sync-failed", action: "retry", data: { job: 7 }, launch: false };
    assertEquals([fromRunDesktop[1], fromHost[1], fromRuntime[1]], [own, own, own]);
    // The page still takes the launch click on its own notification.
    const token = injectedGlobal(
      await (await served.handler(get("http://127.0.0.1:1/"), {})).text(),
    )!.token as string;
    assertEquals((await pageRpc(served, token)("notifications", "take")).data, [
      { id: 3, actionId: "tap", data: { path: "/inbox" }, launch: true },
    ]);
    // Unsubscribed: desktop.ts's handler still hears.
    offHost();
    offRuntime();
    desktop.dispatchEvent(new CustomEvent("notificationresponse", { detail: { tag: "x" } }));
    assertEquals([fromRunDesktop.length, fromHost.length, fromRuntime.length], [3, 2, 2]);
  } finally {
    FakeBrowserWindow.last = undefined;
    FakeMenuWindow.all = [];
    await Deno.remove(outDir, { recursive: true });
  }
});
