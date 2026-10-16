// What denext adds over Deno Desktop runtime 2.9.7-denext.20 (laufey API 49): the OS's delivered
// notifications on macOS / Windows, destructive menu items (and PNG icons in the desktop context
// menu), the share sheet over the window, Handoff / Spotlight user activities, and the Windows
// proxy launch setting — the runtime side against fakes of `Deno.desktop` / `BrowserWindow`, and
// the page side through the fake bridge runtime.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import type { DesktopCapability, DesktopCapCtx } from "../src/desktop/extension.ts";
import type {
  DesktopAppApi,
  DesktopContinuedUserActivity,
  DesktopNotificationsApi,
  DesktopScheduledNotification,
} from "../src/desktop/launch-events.ts";
import { notificationsCapability } from "../src/desktop/caps/notifications.ts";
import { createAppController } from "../src/desktop/caps/app.ts";
import { nativeMenu } from "../src/desktop/caps/menu.ts";
import { userActivityOf } from "../src/desktop/caps/user-activity.ts";
import { createWindowController } from "../src/desktop/caps/window.ts";
import { PickedPaths } from "../src/desktop/picked-paths.ts";
import {
  appCapabilities,
  clearUserActivity,
  onUserActivityContinued,
  setAppMenu,
  setUserActivity,
} from "../src/desktop/app.ts";
import { shareFromWindow } from "../src/desktop/window.ts";
import { desktopShare, showNativeContextMenu } from "../src/desktop/native.ts";
import { share } from "../src/mobile/share.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import {
  desktopUserActivityTypes,
  desktopWindowsProxy,
  unpackagedLaunchEnv,
  withUserActivityTypes,
  writeLaufeyLaunchConfig,
} from "../src/build/desktop-app-config.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  type FakeRuntime,
  until,
} from "./helpers/desktop-fake-runtime.ts";

const ctx = (): DesktopCapCtx => ({
  emit: () => {},
  appSupportDir: "/tmp/app",
  runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
  os: "darwin",
  signal: new AbortController().signal,
});

/** Call `cap.method(args)` the way the bridge does. */
async function call(cap: DesktopCapability, method: string, args: unknown = {}): Promise<unknown> {
  return await cap.methods[method].handler(args, ctx());
}

/** The error code a call rejects with. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return String((err as { code?: unknown }).code);
  }
  throw new Error("expected a rejection");
}

/** Run `fn` against a fake bridge runtime serving `caps`. */
async function inDesktop(
  caps: Record<string, Record<string, FakeMethod>>,
  fn: (rt: FakeRuntime) => Promise<void>,
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

// ---- delivered notifications ------------------------------------------------------------------

/** A fake `Deno.desktop.notifications` whose OS keeps a delivered list (`delivered: true`). */
function osNotifications(delivered: DesktopScheduledNotification[], listed = true) {
  const removed: Array<string | string[] | undefined> = [];
  const cancelled: string[] = [];
  const notifications: DesktopNotificationsApi = {
    capabilities: () => ({ show: true, schedule: true, delivered: listed }),
    schedule: (o) => Promise.resolve(o.tag!),
    getScheduled: () => Promise.resolve([]),
    getDelivered: () => Promise.resolve(delivered),
    removeDelivered: (tags) => void removed.push(tags),
    cancel: (tag) => void cancelled.push(tag),
    requestPermission: () => Promise.resolve("granted"),
  };
  return { api: { notifications } as DesktopAppApi, removed, cancelled };
}

const meta = (id: number, extra: Record<string, unknown> = {}) => ({
  denext: { id, t: `T${id}`, b: "", ...extra },
  data: { n: id },
});

Deno.test("notifications: on macOS / Windows the delivered list is the OS's, newest first", async () => {
  const f = osNotifications([
    { tag: "denext-1", title: "One", data: meta(1, { th: "chat-1" }) },
    { tag: "denext-2-1000", title: "Two", data: meta(2) },
    { tag: "denext-2-2000", title: "Two", data: meta(2) },
    { tag: "denext-web-k", title: "Web", data: { denext: { w: "k" } } },
    { tag: "someone-else", title: "Other", data: null },
    { tag: "denext-3", title: undefined, data: meta(3) },
  ]);
  const cap = notificationsCapability({ api: f.api, autoTopUp: false });
  // One per id (a series' occurrences fold), web notifications and foreign tags left out.
  assertEquals(await call(cap, "delivered"), [
    { id: "3", title: "T3", data: { n: 3 } },
    { id: "2", title: "Two", data: { n: 2 } },
    { id: "1", threadId: "chat-1", title: "One", data: { n: 1 } },
  ]);
  // Removing reads the OS's list: every occurrence of an id goes, scheduled ones are not touched.
  await call(cap, "removeDelivered", { ids: [2, 99] });
  assertEquals(f.removed, [["denext-2-1000", "denext-2-2000"]]);
  assertEquals(f.cancelled, []);
  await call(cap, "removeDelivered", { ids: [99] });
  assertEquals(f.removed.length, 1, "nothing to remove: no call");
  assertEquals(await codeOf(call(cap, "removeDelivered", { ids: ["x"] })), "validation");
});

Deno.test("notifications: without the OS list (Linux, older runtimes) the run's own log stays", async () => {
  const f = osNotifications([{ tag: "denext-9", title: "Nine", data: meta(9) }], false);
  const cap = notificationsCapability({ api: f.api, autoTopUp: false, now: () => 5 });
  assertEquals(await call(cap, "delivered"), []);
  await call(cap, "schedule", { id: 4, title: "Four", body: "" });
  assertEquals(await call(cap, "delivered"), [{ id: "4", title: "Four", data: {} }]);
  await call(cap, "removeDelivered", { ids: [4] });
  assertEquals(f.removed, []);
  assert(f.cancelled.includes("denext-4"));
});

// ---- menus --------------------------------------------------------------------------------------

Deno.test("menu: destructive items reach the runtime; anything but true is left out", () => {
  const { items } = nativeMenu([
    { id: "del", label: "Delete", destructive: true },
    { id: "keep", label: "Keep", destructive: "yes" },
  ]);
  const [del, keep] = items as Array<{ item: { destructive?: boolean } }>;
  assertEquals(del.item.destructive, true);
  assertEquals("destructive" in keep.item, false);
});

Deno.test("app: capabilities report the runtime's destructive style", async () => {
  const ctl = createAppController({
    window: Object.assign(new EventTarget(), { setApplicationMenu: () => {} }),
    api: { menuCapabilities: () => ({ appMenu: true, destructive: true, icons: true }) },
    emit: () => {},
    os: "darwin",
  });
  const caps = await call(ctl.capability, "capabilities") as Record<string, unknown>;
  assertEquals([caps.destructive, caps.icons], [true, true]);
});

Deno.test("page: setAppMenu and the desktop context menu carry destructive items and PNG icons", async () => {
  await inDesktop({
    app: { setAppMenu: () => null, capabilities: () => ({ destructive: true }) },
    contextMenu: { show: () => ({ id: "del" }) },
  }, async (rt) => {
    await setAppMenu([{ id: "del", label: "Delete", destructive: true, icon: "iVBO" }]);
    assertEquals(rt.calls[0].args, {
      menu: [{ id: "del", label: "Delete", enabled: true, icon: "iVBO", destructive: true }],
    });
    assertEquals((await appCapabilities()).destructive, true);
    const picked = await showNativeContextMenu(
      [
        { id: "del", label: "Delete", destructive: true, iconPng: "iVBO" },
        { id: "open", label: "Open" },
      ],
      1,
      2,
      undefined,
    );
    assertEquals(picked, "del");
    assertEquals((rt.calls.at(-1)!.args as { items: unknown[] }).items, [
      { id: "del", label: "Delete", enabled: true, destructive: true, icon: "iVBO" },
      { id: "open", label: "Open", enabled: true },
    ]);
  });
});

// ---- share sheet --------------------------------------------------------------------------------

/** A window with the pinned runtime's `share`, recording what it was asked. */
function shareWindow(answer: unknown) {
  const shared: unknown[] = [];
  return {
    shared,
    window: Object.assign(new EventTarget(), {
      share: (data: unknown) => {
        shared.push(data);
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer);
      },
    }),
  };
}

Deno.test("window.share: text, url and app files to the OS sheet; never a raw path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-share-" });
  try {
    const docs = join(dir, "docs");
    await Deno.mkdir(docs);
    await Deno.writeTextFile(join(docs, "q3.pdf"), "%PDF");
    const outside = join(dir, "picked.txt");
    await Deno.writeTextFile(outside, "x");
    const picked = new PickedPaths();
    const handle = picked.add(await Deno.realPath(outside), "read");
    const w = shareWindow({ outcome: "completed", target: "Mail" });
    const ctl = createWindowController({
      window: w.window,
      emit: () => {},
      picked,
      dirs: { data: join(dir, "data"), cache: join(dir, "cache"), documents: docs },
    });
    const out = await call(ctl.capability, "share", {
      title: "Q3",
      url: "https://example.com/q3",
      files: [{ directory: "documents", path: "q3.pdf" }, { directory: { picked: handle } }],
      x: 10,
      y: 20,
    });
    assertEquals(out, { outcome: "completed", target: "Mail" });
    const sent = w.shared[0] as { files: string[]; title: string; x: number };
    assertEquals([sent.title, sent.x, sent.files.length], ["Q3", 10, 2]);
    assert(sent.files[0].endsWith("q3.pdf"));
    for (
      const bad of [
        {},
        { title: "only a title" },
        { url: "file:///etc/passwd" },
        { text: 7 },
        { files: [{ path: outside }] },
        { text: "x", x: "left" },
      ]
    ) {
      assertEquals(
        await codeOf(call(ctl.capability, "share", bad)),
        "validation",
        JSON.stringify(bad),
      );
    }
    // An escape from the app folder is refused before the sheet opens.
    const escape = { files: [{ directory: "documents", path: "../picked.txt" }] };
    assertEquals(await codeOf(call(ctl.capability, "share", escape)), "forbidden");
    assertEquals(w.shared.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("window.share: outcomes are whitelisted; unreadable files are forbidden; no API is unsupported", async () => {
  const odd = shareWindow({ outcome: "exploded", reason: "r".repeat(5000) });
  const ctl = createWindowController({ window: odd.window, emit: () => {} });
  const out = await call(ctl.capability, "share", { text: "hi" }) as {
    outcome: string;
    reason: string;
  };
  assertEquals(out.outcome, "failed");
  assertEquals(out.reason.length, 1024);
  const denied = shareWindow(new Deno.errors.NotCapable("read"));
  const ctl2 = createWindowController({ window: denied.window, emit: () => {} });
  assertEquals(await codeOf(call(ctl2.capability, "share", { text: "hi" })), "forbidden");
  const stock = createWindowController({ window: new EventTarget(), emit: () => {} });
  assertEquals(await codeOf(call(stock.capability, "share", { text: "hi" })), "unsupported");
});

Deno.test("page: shareFromWindow and share() on desktop", async () => {
  let answer: unknown = { outcome: "shown" };
  await inDesktop({ window: { share: () => answer } }, async (rt) => {
    assertEquals(
      await shareFromWindow({ text: "hi", files: [{ directory: "cache", path: "a.txt" }], x: 1 }),
      { outcome: "shown" },
    );
    assertEquals(rt.calls[0].args, {
      text: "hi",
      files: [{ directory: "cache", path: "a.txt" }],
      x: 1,
    });
    answer = { outcome: "weird", target: "T" };
    assertEquals(await shareFromWindow({ url: "https://x.dev/" }), {
      outcome: "failed",
      target: "T",
    });
    // denext/mobile's share(): the window's sheet first.
    answer = { outcome: "completed" };
    assertEquals(await share({ text: "hi", url: "https://x.dev/" }), "shared");
    answer = { outcome: "cancelled" };
    assertEquals(await share({ text: "hi" }), "cancelled");
    answer = { outcome: "failed", reason: "no" };
    await assertRejects(() => desktopShare({ text: "hi" }), Error, "no");
    // Linux has no sheet: the web path runs (here: the clipboard, refused without one).
    answer = { outcome: "not_supported" };
    assertEquals(await desktopShare({ text: "hi" }), undefined);
  });
  await inDesktop({
    window: { share: () => Promise.reject({ code: "unsupported", message: "old runtime" }) },
  }, async () => {
    assertEquals(await desktopShare({ text: "hi" }), undefined);
  });
});

// ---- user activities ----------------------------------------------------------------------------

/** A fake `Deno.desktop.userActivity`. */
function fakeActivities() {
  const set: unknown[] = [];
  let listener: ((a: DesktopContinuedUserActivity) => void) | undefined;
  const api: DesktopAppApi = {
    userActivity: {
      set: (a) => (set.push(a), true),
      clear: () => true,
      onContinue: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    },
  };
  return { api, set, continue: (a: DesktopContinuedUserActivity) => listener?.(a) };
}

Deno.test("app: setUserActivity / clearUserActivity through the runtime; continued ones are pulled", async () => {
  const f = fakeActivities();
  const emitted: string[] = [];
  const ctl = createAppController({
    window: new EventTarget(),
    api: f.api,
    emit: (cap, event) => void emitted.push(`${cap}:${event}`),
    os: "darwin",
  });
  const activity = {
    type: "com.example.notes.editing",
    title: "Note",
    url: "https://notes.example.com/n/1",
    userInfo: { noteId: "1" },
    keywords: ["note"],
    searchable: true,
  };
  assertEquals(await call(ctl.capability, "setUserActivity", { activity }), { applied: true });
  assertEquals(f.set, [activity]);
  assertEquals(await call(ctl.capability, "clearUserActivity"), { applied: true });
  // A continued activity before install is the runtime's to hold; after it, it is queued.
  ctl.install();
  f.continue({ type: "com.example.notes.editing", title: "Note", url: null, userInfo: { a: "1" } });
  f.continue({ type: "", title: "dropped" });
  f.continue({ type: "com.x.y", userInfo: { n: 5, s: "ok" } });
  assertEquals(emitted, ["app:activity", "app:activity"]);
  // A page load does not drop it: the launch activity waits for the first page to take it.
  await ctl.capability.onPageLoad?.();
  assertEquals(await call(ctl.capability, "takeActivities"), [
    { type: "com.example.notes.editing", title: "Note", url: null, userInfo: { a: "1" } },
    { type: "com.x.y", title: "", url: null, userInfo: { s: "ok" } },
  ]);
  assertEquals(await call(ctl.capability, "takeActivities"), []);
  // No runtime API (Windows, Linux, older runtimes): not applied, still validated.
  const none = createAppController({ window: new EventTarget(), api: {}, emit: () => {} });
  assertEquals(await call(none.capability, "setUserActivity", { activity }), { applied: false });
  assertEquals(await call(none.capability, "clearUserActivity"), { applied: false });
  assertEquals(
    await codeOf(call(none.capability, "setUserActivity", { activity: { type: "nodots" } })),
    "validation",
  );
});

Deno.test("userActivityOf: reverse-DNS type, http(s) url, string userInfo, bounded", () => {
  assertEquals(userActivityOf({ type: "com.a.b", handoff: false }), {
    type: "com.a.b",
    handoff: false,
  });
  for (
    const bad of [
      null,
      { type: "no-dots" },
      { type: "com.a.b", url: "javascript:alert(1)" },
      { type: "com.a.b", userInfo: { n: 1 } },
      { type: "com.a.b", userInfo: [] },
      { type: "com.a.b", keywords: "k" },
      { type: "com.a.b", keywords: Array.from({ length: 65 }, () => "k") },
      { type: "com.a.b", searchable: "yes" },
      { type: "com.a.b", title: "t".repeat(257) },
    ]
  ) {
    const err = assertThrows(() => userActivityOf(bad)) as { code?: string };
    assertEquals(err.code, "validation", JSON.stringify(bad)?.slice(0, 60));
  }
});

Deno.test("page: setUserActivity, clearUserActivity and onUserActivityContinued", async () => {
  const queued: unknown[] = [];
  await inDesktop({
    app: {
      setUserActivity: (a) => ({
        applied: (a as { activity: { type: string } }).activity.type !== "",
      }),
      clearUserActivity: () => ({ applied: "yes" }),
      takeActivities: () => queued.splice(0),
    },
  }, async (rt) => {
    assertEquals(await setUserActivity({ type: "com.a.b", title: "T" }), true);
    assertEquals(rt.calls[0].args, { activity: { type: "com.a.b", title: "T" } });
    assertEquals(await clearUserActivity(), false);
    queued.push(
      { type: "com.a.b", title: "T", url: "https://x.dev/", userInfo: { k: "v", n: 1 } },
      { title: "no type" },
    );
    const got: unknown[] = [];
    const stop = onUserActivityContinued((a) => got.push(a));
    await until(() => got.length === 1);
    stop();
    assertEquals(got, [{
      type: "com.a.b",
      title: "T",
      url: "https://x.dev/",
      userInfo: { k: "v" },
    }]);
  });
});

// ---- the Windows proxy and NSUserActivityTypes ---------------------------------------------------

Deno.test("desktop.windows.proxy: the Windows launch file and LAUFEY_PROXY; validated", async () => {
  const config = { desktop: { windows: { proxy: "direct" } } };
  assertEquals(desktopWindowsProxy(config), "direct");
  assertEquals(desktopWindowsProxy({ desktop: { windows: { proxy: "pac" } } }), undefined);
  assertEquals(unpackagedLaunchEnv(config, "run", "windows").LAUFEY_PROXY, "direct");
  assertEquals(unpackagedLaunchEnv(config, "run", "darwin").LAUFEY_PROXY, undefined);
  const dir = await Deno.makeTempDir({ prefix: "denext-proxy-" });
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default ${JSON.stringify(config)};\n`,
    );
    const entry = toFileUrl(join(dir, "scripts", "package-windows.ts")).href;
    const win = await writeLaufeyLaunchConfig(entry, "windows", join(dir, "win"));
    assertEquals(JSON.parse(await Deno.readTextFile(win!)).proxy, "direct");
    const linux = await writeLaufeyLaunchConfig(entry, "linux", join(dir, "linux"));
    assertEquals(JSON.parse(await Deno.readTextFile(linux!)).proxy, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  const check = (windows: unknown) => () =>
    validateDenextConfig({ desktop: { windows } } as unknown as DenextConfig);
  check({ proxy: "system" })();
  check({})();
  assertThrows(check("direct"), Error, "desktop.windows");
  assertThrows(check({ proxy: "auto" }), Error, "desktop.windows.proxy");
});

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>app</string>
	<key>NSUserActivityTypes</key>
	<array>
		<string>old.type.x</string>
	</array>
</dict>
</plist>
`;

Deno.test("desktop.macos.userActivityTypes: the bundle's NSUserActivityTypes; validated", async () => {
  const types = ["com.example.notes.editing", "com.example.notes.viewing"];
  assertEquals(
    desktopUserActivityTypes({ desktop: { macos: { userActivityTypes: types } } }),
    types,
  );
  const out = withUserActivityTypes(INFO_PLIST, types);
  assert(out.includes("<key>CFBundleExecutable</key>"));
  assert(!out.includes("old.type.x"));
  assertEquals(out.match(/NSUserActivityTypes/g)?.length, 1);
  assert(out.includes("<string>com.example.notes.viewing</string>"));
  const dir = await Deno.makeTempDir({ prefix: "denext-activity-" });
  try {
    await Deno.mkdir(join(dir, "scripts"));
    const app = join(dir, "App.app");
    await Deno.mkdir(join(app, "Contents"), { recursive: true });
    await Deno.writeTextFile(join(app, "Contents", "Info.plist"), INFO_PLIST);
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default ${JSON.stringify({ desktop: { macos: { userActivityTypes: types } } })};\n`,
    );
    const entry = toFileUrl(join(dir, "scripts", "package-macos.ts")).href;
    await writeLaufeyLaunchConfig(entry, "darwin", app);
    const written = await Deno.readTextFile(join(app, "Contents", "Info.plist"));
    assert(written.includes("<string>com.example.notes.editing</string>"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  const check = (macos: unknown) => () =>
    validateDenextConfig({ desktop: { macos } } as unknown as DenextConfig);
  check({ userActivityTypes: types })();
  assertThrows(check({ userActivityTypes: "com.a.b" }), Error, "userActivityTypes");
  assertThrows(check({ userActivityTypes: ["nodots"] }), Error, "userActivityTypes");
});
