// The bridge with several windows: a request's window token names its window (an unknown one is
// refused), a window's capability subset, each window's page loads released on its own (from its
// new page's first request when navigations cannot be attributed), events targeted at one window,
// and the page side: the identity headers the bridge client sends, `openWindow` and the overlay
// calls of `denext/desktop/window`, the Dock / backend tray / panel calls of `denext/desktop/app`,
// `speak()` in `denext/mobile`, and what `runDesktop` injects and serves for them.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import { DesktopEventLog } from "../src/desktop/bridge-events.ts";
import type { DesktopCapability } from "../src/desktop/extension.ts";
import {
  currentWindowId,
  getWindows,
  onWindowBlur,
  onWindowFocus,
  openWindow,
  setAlwaysOnTop,
  setHitRegion,
  setIgnoreMouseEvents,
  setSkipTaskbar,
  setVisibleOnAllWorkspaces,
  setWindowOpacity,
  windowHandle,
} from "../src/desktop/window.ts";
import {
  appCapabilities,
  getTray,
  hideTrayPanel,
  onDockReopen,
  setDockVisible,
  showTrayPanel,
  toggleTrayPanel,
} from "../src/desktop/app.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { speak, stopSpeaking } from "../src/mobile/speech.ts";
import { createDesktopHandler, desktopAppUrl, injectDesktopGlobal } from "../src/build/desktop.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";
import { withGlobals } from "./helpers/mobile-fakes.ts";

const ORIGIN = "http://127.0.0.1:8000";
const TOKEN = "test-token-1234";

/** An RPC request with the given extra headers. */
function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/_denext/desktop/rpc`, {
    method: "POST",
    headers: {
      "x-denext-desktop-token": TOKEN,
      origin: ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Run `request` through `bridge` and parse the envelope. */
async function send(
  bridge: ReturnType<typeof createDesktopBridge>,
  request: Request,
): Promise<{ status: number; body: { ok: boolean; data?: unknown; error?: { code: string } } }> {
  const res = (await bridge.handle(request, new URL(request.url), TOKEN))!;
  return { status: res.status, body: await res.json() };
}

/** A capability that answers the calling window's id and records page loads. */
function whoCap(loads: string[], perWindow: boolean, name = "who"): DesktopCapability {
  return {
    name,
    perWindow,
    methods: { me: { handler: (_a, ctx) => ({ id: ctx.windowId, window: ctx.window }) } },
    onPageLoad: (id) => void loads.push(`${name}:${id}`),
  };
}

Deno.test("bridge: a window token names the caller; an unknown one is refused; none is main", async () => {
  const loads: string[] = [];
  const bridge = createDesktopBridge([whoCap(loads, true)], {
    resolveWindow: (t) => (t === "w1-token" ? "window-1" : undefined),
    getWindow: (id) => `win:${id}`,
  });
  const call = { cap: "who", method: "me", args: {} };
  assertEquals((await send(bridge, rpc(call))).body.data, { id: "main", window: "win:main" });
  assertEquals(
    (await send(bridge, rpc(call, { "x-denext-desktop-window": "w1-token" }))).body.data,
    { id: "window-1", window: "win:window-1" },
  );
  const refused = await send(bridge, rpc(call, { "x-denext-desktop-window": "stale" }));
  assertEquals([refused.status, refused.body.error?.code], [403, "forbidden"]);
});

Deno.test("bridge: a window outside its subset gets unavailable (its web fallback)", async () => {
  const bridge = createDesktopBridge([whoCap([], false)], {
    resolveWindow: (t) => t,
    allowed: (window, cap) => window === "main" || cap !== "who",
  });
  const call = { cap: "who", method: "me", args: {} };
  assertEquals((await send(bridge, rpc(call))).body.ok, true);
  const out = await send(bridge, rpc(call, { "x-denext-desktop-window": "panel" }));
  assertEquals([out.status, out.body.error?.code], [404, "unavailable"]);
});

Deno.test("bridge: a window's new page releases what its last page held; a late request does not", async () => {
  const loads: string[] = [];
  const bridge = createDesktopBridge([whoCap(loads, true), whoCap(loads, false, "global")], {
    resolveWindow: (t) => t,
    windowCount: () => 2,
  });
  const call = { cap: "who", method: "me", args: {} };
  const as = (window: string, page: string) =>
    send(bridge, rpc(call, { "x-denext-desktop-window": window, "x-denext-desktop-page": page }));
  await as("window-1", "p1");
  await as("window-1", "p1");
  assertEquals(loads, [], "the first page of a window releases nothing");
  await as("window-1", "p2");
  assertEquals(loads, ["who:window-1"], "only the per-window capability, for that window");
  await as("window-1", "p1");
  assertEquals(loads, ["who:window-1"], "a request from the page that went changes nothing");
  await as("main", "m1");
  await as("main", "m2");
  assertEquals(loads, ["who:window-1", "who:main", "global:main"]);
  // With several windows a navigation cannot be attributed: nothing is released.
  await bridge.navigationStarted();
  assertEquals(loads.length, 3);
  // An absurd page id is ignored.
  await as("main", "x".repeat(100));
  assertEquals(loads.length, 3);
});

Deno.test("bridge: one window's navigation is its page load; the next page's first request is new", async () => {
  const loads: string[] = [];
  const bridge = createDesktopBridge([whoCap(loads, false)], {});
  const call = { cap: "who", method: "me", args: {} };
  await send(bridge, rpc(call, { "x-denext-desktop-page": "a" }));
  await bridge.navigationStarted();
  assertEquals(loads, ["who:main"]);
  await send(bridge, rpc(call, { "x-denext-desktop-page": "b" }));
  assertEquals(loads, ["who:main"], "the navigation already released the old page");
});

Deno.test("events: a targeted event reaches its window's stream only", async () => {
  const log = new DesktopEventLog();
  log.append("window", "focus", null, "window-1");
  log.append("app", "action", null);
  const read = async (window?: string) => {
    const reader = log.open(null, window).getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    await reader.cancel();
    return text;
  };
  const main = await read();
  assert(!main.includes('"focus"') && main.includes('"action"'));
  const w1 = await read("window-1");
  assert(w1.includes('"focus"'));
  const bridge = createDesktopBridge([], {
    resolveWindow: (t) => (t === "ok" ? "window-1" : undefined),
  });
  bridge.emit("window", "blur", null, "window-1");
  const events = (headers: Record<string, string>) =>
    bridge.handle(
      new Request(`${ORIGIN}/_denext/desktop/events`, {
        headers: { "x-denext-desktop-token": TOKEN, ...headers },
      }),
      new URL(`${ORIGIN}/_denext/desktop/events`),
      TOKEN,
    );
  const refused = await events({ "x-denext-desktop-window": "nope" });
  assertEquals(refused?.status, 403);
  const ok = await events({ "x-denext-desktop-window": "ok" });
  assertEquals(ok?.status, 200);
  await ok?.body?.cancel();
});

// --- the page side ------------------------------------------------------------------------------

type Rt = ReturnType<typeof createFakeDesktopRuntime>;

/** Run `fn` in a fake desktop window with `caps` enabled (and `extra` page globals). */
async function inDesktop(
  caps: Record<string, Record<string, FakeMethod>>,
  fn: (rt: Rt) => Promise<void>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  const g = globalThis as { __denext?: Record<string, unknown> };
  g.__denext = { ...g.__denext, ...extra };
  try {
    await fn(rt);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
}

const calls = (rt: Rt) => rt.calls.map((c) => `${c.cap}.${c.method}:${JSON.stringify(c.args)}`);

Deno.test("client: every request carries the page id, and the window token when the runtime binds one", async () => {
  const ok: FakeMethod = () => null;
  await inDesktop({ window: { setOpacity: ok } }, async (rt) => {
    await withGlobals(
      { bindings: { __denextWindow: () => Promise.resolve("w-tok") } },
      async () => {
        await setWindowOpacity(0.5);
        await setWindowOpacity(0.6);
      },
    );
    const [first, second] = rt.requests;
    assertEquals(first.headers.get("x-denext-desktop-window"), "w-tok");
    const page = first.headers.get("x-denext-desktop-page");
    assert(page && page === second.headers.get("x-denext-desktop-page"));
  }, { windows: true });
  // Without `__denext.windows` the page does not ask (one window): no window header.
  await inDesktop({ window: { setOpacity: ok } }, async (rt) => {
    await setWindowOpacity(1);
    assertEquals(rt.requests[0].headers.get("x-denext-desktop-window"), null);
  });
  // A binding that throws, or answers nothing usable, is no window token.
  await inDesktop({ window: { setOpacity: ok } }, async (rt) => {
    await withGlobals(
      { bindings: { __denextWindow: () => Promise.reject(new Error("x")) } },
      () => setWindowOpacity(1),
    );
    assertEquals(rt.requests[0].headers.get("x-denext-desktop-window"), null);
  }, { windows: true });
  await inDesktop({ window: { setOpacity: ok } }, async (rt) => {
    await withGlobals(
      { bindings: { __denextWindow: () => Promise.resolve(5) } },
      () => setWindowOpacity(1),
    );
    assertEquals(rt.requests[0].headers.get("x-denext-desktop-window"), null);
  }, { windows: true });
});

Deno.test("client: the overlay calls go to the window capability with their arguments", async () => {
  const ok: FakeMethod = () => null;
  const methods = [
    "setOpacity",
    "setIgnoreMouseEvents",
    "setHitRegion",
    "setVisibleOnAllWorkspaces",
    "setSkipTaskbar",
    "setAlwaysOnTop",
  ];
  await inDesktop({ window: Object.fromEntries(methods.map((m) => [m, ok])) }, async (rt) => {
    await setWindowOpacity(0.3);
    await setIgnoreMouseEvents(true, { forward: true });
    await setIgnoreMouseEvents(false);
    await setHitRegion([{ x: 1, y: 2, width: 3, height: 4, extra: 5 } as never]);
    await setHitRegion(null);
    await setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    await setVisibleOnAllWorkspaces(false);
    await setSkipTaskbar(true);
    await setAlwaysOnTop(true, "status");
    await setAlwaysOnTop(false);
    assertEquals(calls(rt), [
      'window.setOpacity:{"opacity":0.3}',
      'window.setIgnoreMouseEvents:{"ignore":true,"forward":true}',
      'window.setIgnoreMouseEvents:{"ignore":false,"forward":false}',
      'window.setHitRegion:{"rects":[{"x":1,"y":2,"width":3,"height":4}]}',
      'window.setHitRegion:{"rects":null}',
      'window.setVisibleOnAllWorkspaces:{"visible":true,"visibleOnFullScreen":true}',
      'window.setVisibleOnAllWorkspaces:{"visible":false,"visibleOnFullScreen":false}',
      'window.setSkipTaskbar:{"skip":true}',
      'window.setAlwaysOnTop:{"alwaysOnTop":true,"level":"status"}',
      'window.setAlwaysOnTop:{"alwaysOnTop":false}',
    ]);
  });
});

Deno.test("client: focus and blur subscriptions; openWindow returns a handle acting by id", async () => {
  const ok: FakeMethod = () => null;
  await inDesktop({
    window: {},
    windows: {
      open: () => ({ id: "window-1" }),
      show: ok,
      hide: ok,
      focus: ok,
      close: ok,
      navigate: ok,
      setBounds: ok,
      getBounds: () => ({ x: 1, y: 2, width: 3, height: 4 }),
      list: () => [{ id: "main", kind: "main", visible: true }, { id: "w", kind: "x" }, 7],
      current: () => ({ id: "window-1" }),
    },
  }, async (rt) => {
    const seen: string[] = [];
    const offFocus = onWindowFocus(() => void seen.push("focus"));
    const offBlur = onWindowBlur(() => void seen.push("blur"));
    const w = await openWindow({ url: "/settings", width: 400 });
    assertEquals(w.id, "window-1");
    const closed: string[] = [];
    const offClosed = w.onClosed(() => void closed.push("closed"));
    w.onFocus(() => void seen.push("w-focus"));
    w.onBlur(() => void seen.push("w-blur"));
    await until(() => rt.openStreams() > 0, 2000);
    rt.emit("window", "focus", null);
    rt.emit("window", "blur", null);
    rt.emit("windows", "focus", { id: "window-1" });
    rt.emit("windows", "blur", { id: "window-1" });
    rt.emit("windows", "closed", { id: "other" });
    rt.emit("windows", "closed", { id: "window-1" });
    await until(() => closed.length === 1 && seen.length === 4, 2000);
    assertEquals(seen, ["focus", "blur", "w-focus", "w-blur"]);
    offFocus();
    offBlur();
    offClosed();
    await w.show();
    await w.hide();
    await w.focus();
    await w.navigate("/x");
    await w.setBounds({ width: 500 });
    assertEquals(await w.getBounds(), { x: 1, y: 2, width: 3, height: 4 });
    await w.close();
    assertEquals(await getWindows(), [
      { id: "main", kind: "main", visible: true },
      { id: "w", kind: "window", visible: true },
    ]);
    assertEquals(await currentWindowId(), "window-1");
    assertEquals(windowHandle("main").id, "main");
    assert(calls(rt).includes('windows.open:{"url":"/settings","width":400}'));
    assert(calls(rt).includes('windows.setBounds:{"id":"window-1","width":500}'));
  });
  await inDesktop({
    windows: { getBounds: () => null, list: () => null, current: () => ({}) },
  }, async () => {
    assertEquals(await windowHandle("x").getBounds(), null);
    assertEquals(await getWindows(), []);
    assertEquals(await currentWindowId(), "main");
  });
});

Deno.test("client: the Dock, the backend tray and its panel", async () => {
  await inDesktop({
    app: {
      setDockVisible: () => ({ applied: true }),
      backendTray: () => ({ id: "app" }),
      panel: (a) => ({ visible: (a as { action: string }).action !== "hide" }),
      updateTray: () => null,
      take: () => [{ source: "dockReopen", hasVisibleWindows: true }],
      capabilities: () => ({ dockVisibility: true, backendTray: true, trayPanel: true }),
    },
  }, async (rt) => {
    assertEquals(await setDockVisible(false), true);
    const tray = await getTray();
    assertEquals(tray?.id, "app");
    await tray?.update({ tooltip: "x" });
    assertEquals(await showTrayPanel(), true);
    assertEquals(await toggleTrayPanel(), true);
    assertEquals(await hideTrayPanel(), false);
    const caps = await appCapabilities();
    assertEquals([caps.dockVisibility, caps.backendTray, caps.trayPanel], [true, true, true]);
    const reopened: boolean[] = [];
    const off = onDockReopen((e) => void reopened.push(e.hasVisibleWindows));
    await until(() => rt.openStreams() > 0, 2000);
    rt.emit("app", "action", null);
    await until(() => reopened.length === 1, 2000);
    off();
    assertEquals(reopened, [true]);
  });
  await inDesktop({ app: { backendTray: () => ({ id: null }) } }, async () => {
    assertEquals(await getTray(), null);
  });
});

Deno.test("speak: Web Speech first, resolving when said; stop cancels", async () => {
  const spoken: string[] = [];
  class Utterance {
    lang = "";
    rate = 1;
    pitch = 1;
    volume = 1;
    voice: unknown = null;
    onend?: () => void;
    onerror?: (e: { error?: string }) => void;
    constructor(readonly text: string) {}
  }
  const synth = {
    speaking: false,
    getVoices: () => [{ name: "Samantha", voiceURI: "v1" }],
    speak(u: Utterance) {
      spoken.push(`${u.text}|${u.lang}|${u.rate}|${(u.voice as { name?: string })?.name}`);
      queueMicrotask(() =>
        u.text === "fail"
          ? u.onerror?.({ error: "synthesis-failed" })
          : u.text === "cut"
          ? u.onerror?.({ error: "interrupted" })
          : u.onend?.()
      );
    },
    cancel: () => void spoken.push("cancel"),
  };
  await withGlobals({ speechSynthesis: synth, SpeechSynthesisUtterance: Utterance }, async () => {
    await speak("hello", { lang: "en-US", rate: 1.5, voice: "Samantha", pitch: 1, volume: 0.5 });
    await speak("cut");
    let failed = "";
    await speak("fail").catch((e) => void (failed = e.message));
    assertStringIncludes(failed, "synthesis-failed");
    await stopSpeaking();
  });
  assertEquals(spoken, [
    "hello|en-US|1.5|Samantha",
    "cut||1|undefined",
    "fail||1|undefined",
    "cancel",
  ]);
});

Deno.test("speak: the desktop runtime's speech without Web Speech; unavailable elsewhere", async () => {
  await inDesktop({ textToSpeech: { speak: () => null, stop: () => null } }, async (rt) => {
    await withGlobals({ speechSynthesis: undefined }, async () => {
      await speak("hi", { rate: 2 });
      await stopSpeaking();
    });
    assertEquals(calls(rt), ['textToSpeech.speak:{"text":"hi","rate":2}', "textToSpeech.stop:{}"]);
  }, { os: "linux" });
  await withGlobals({ speechSynthesis: undefined }, async () => {
    let code = "";
    await speak("hi").catch((e) => void (code = e.code));
    assertEquals(code, "unavailable");
    await stopSpeaking();
  });
});

// --- runDesktop's page side -------------------------------------------------------------------

Deno.test("desktopAppUrl: the app origin in the memory world, the listening loopback port otherwise", () => {
  assertEquals(
    desktopAppUrl({ kind: "memory", origin: "hangar://app" }, null)("/vm?id=1"),
    "hangar://app/vm?id=1",
  );
  assertEquals(
    desktopAppUrl({ kind: "loopback" }, { port: 4321 })("/x"),
    "http://127.0.0.1:4321/x",
  );
  assertEquals(desktopAppUrl({ kind: "loopback" }, {})("/"), "http://127.0.0.1:8000/");
});

Deno.test("inject: the page is told to ask for its window token only when windows are bound", async () => {
  const html = "<html><head></head><body></body></html>";
  const bound = await injectDesktopGlobal(html, "tok", false, undefined, undefined, {
    windows: true,
  });
  assertStringIncludes(bound, '"windows":true');
  assertStringIncludes(bound, "__denextWindow");
  const plain = await injectDesktopGlobal(html, "tok");
  assert(!plain.includes('"windows":true'));
});

Deno.test("quit endpoint: a page's window.close() names its window", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-windowing-quit-" });
  try {
    await Deno.writeTextFile(join(dir, "index.html"), "<html><head></head></html>");
    const closed: Array<string | null> = [];
    const handle = createDesktopHandler(
      {},
      dir,
      undefined,
      TOKEN,
      undefined,
      undefined,
      false,
      undefined,
      (w) => void closed.push(w),
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const quit = (headers: Record<string, string>) => {
      const req = new Request(`${ORIGIN}/_denext/desktop/quit`, {
        method: "POST",
        headers: { "x-denext-desktop-token": TOKEN, ...headers },
      });
      return handle(req, new URL(req.url));
    };
    assertEquals((await quit({ "x-denext-desktop-window": "w-tok" })).status, 204);
    assertEquals((await quit({})).status, 204);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(closed, ["w-tok", null]);
    const page = await handle(
      new Request(`${ORIGIN}/`, { headers: { "sec-fetch-dest": "document" } }),
      new URL(`${ORIGIN}/`),
    );
    assertStringIncludes(await page.text(), '"windows":true');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
