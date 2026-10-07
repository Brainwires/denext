// The Deno Desktop capabilities over the pinned runtime's app APIs (runtime side): notifications
// (scheduled, repeating, categories, clicks pulled once, the cold-start click), the native context
// menu, global shortcuts, launch at login and the `app` controller (application menu, trays, dock).
// Each runs against a fake `Deno.desktop`; under the stock runtime (no API) each answers
// `unavailable`, so the page keeps its web path.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { DesktopCapability, DesktopCapCtx } from "../src/desktop/extension.ts";
import type {
  DesktopAppApi,
  DesktopMenuItem,
  DesktopNotificationsApi,
  DesktopScheduledNotification,
} from "../src/desktop/launch-events.ts";
import {
  notificationsCapability,
  REPEAT_HORIZON,
  seriesTimes,
} from "../src/desktop/caps/notifications.ts";
import { contextMenuCapability } from "../src/desktop/caps/context-menu.ts";
import { shortcutsCapability } from "../src/desktop/caps/shortcuts.ts";
import { launchAtLoginCapability } from "../src/desktop/caps/launch-at-login.ts";
import { createAppController, type DockLike, type TrayLike } from "../src/desktop/caps/app.ts";
import { nativeMenu } from "../src/desktop/caps/menu.ts";
import { createPullQueue } from "../src/desktop/caps/queue.ts";
import { withDenoProps, withProps } from "./helpers/deno-stub.ts";
import { until } from "./helpers/desktop-fake-runtime.ts";

/** How long a test waits for an async effect (polled; generous for a loaded machine). */
const WAIT_MS = 10_000;

/** A handler context recording what the capability emits. */
function ctxOf(window?: unknown): DesktopCapCtx & { emitted: Array<[string, unknown]> } {
  const emitted: Array<[string, unknown]> = [];
  return {
    emit: (event, data) => void emitted.push([event, data]),
    appSupportDir: "/tmp/app",
    runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
    os: "darwin",
    window,
    signal: new AbortController().signal,
    emitted,
  };
}

/** Call `cap.method(args)` the way the bridge does. */
async function call(
  cap: DesktopCapability,
  method: string,
  args: unknown = {},
  ctx: DesktopCapCtx = ctxOf(),
): Promise<unknown> {
  return await cap.methods[method].handler(args, ctx);
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

const DAY = 24 * 3600 * 1000;

/** A fake `Deno.desktop` with notifications. */
function fakeNotifications(launched: unknown[] = []) {
  const scheduled: DesktopScheduledNotification[] = [];
  const cancelled: string[] = [];
  const listeners = new Map<string, (e: Event) => void>();
  let canSchedule = true;
  const notifications: DesktopNotificationsApi = {
    capabilities: () => ({ show: true, schedule: canSchedule, actions: true, clicks: true }),
    schedule: (o) => {
      const at = scheduled.findIndex((e) => e.tag === o.tag);
      if (at >= 0) scheduled.splice(at, 1);
      scheduled.push({
        tag: o.tag!,
        title: o.title,
        body: o.body,
        at: o.at,
        data: JSON.parse(JSON.stringify(o.data ?? null)),
        actions: o.actions ?? [],
      });
      return Promise.resolve(o.tag!);
    },
    getScheduled: () =>
      Promise.resolve(scheduled.map((e) => ({ ...e, at: new Date(e.at as number) }))),
    cancel: (tag) => {
      const at = scheduled.findIndex((e) => e.tag === tag);
      if (at >= 0) scheduled.splice(at, 1);
      cancelled.push(tag);
    },
    requestPermission: () => Promise.resolve("granted"),
  };
  const api: DesktopAppApi = {
    notifications,
    launchNotificationResponses: launched as DesktopAppApi["launchNotificationResponses"],
    addEventListener: (type, l) => void listeners.set(type, l),
  };
  return {
    api,
    scheduled,
    cancelled,
    listeners,
    noSchedule: () => {
      canSchedule = false;
    },
  };
}

const NOW = new Date(2026, 9, 1, 8, 0, 0).getTime();

Deno.test("notifications: unavailable under the stock runtime (the page keeps the WebView)", async () => {
  const cap = notificationsCapability({ api: {}, autoTopUp: false });
  for (const m of ["schedule", "pending", "permission", "take", "capabilities"]) {
    assertEquals(await codeOf(call(cap, m, { id: 1, title: "t", body: "b" })), "unavailable", m);
  }
});

Deno.test("notifications: a dated notification is one OS notification, tagged by its id", async () => {
  const f = fakeNotifications();
  const cap = notificationsCapability({ api: f.api, autoTopUp: false, now: () => NOW });
  const at = NOW + 3600_000;
  assertEquals(
    await call(cap, "schedule", {
      id: 5,
      title: "Stand-up",
      body: "In 10",
      data: { path: "/standup" },
      trigger: { type: "date", date: at },
    }),
    { id: 5 },
  );
  assertEquals(f.scheduled.length, 1);
  assertEquals(f.scheduled[0].tag, "denext-5");
  assertEquals(f.scheduled[0].at, at);
  assertEquals(f.scheduled[0].data, {
    denext: { id: 5, t: "Stand-up", b: "In 10" },
    data: { path: "/standup" },
  });
  assertEquals(await call(cap, "pending"), [
    { id: 5, title: "Stand-up", body: "In 10", extra: { path: "/standup" } },
  ]);
  // No trigger: now. Scheduling an id again replaces it.
  await call(cap, "schedule", { id: 5, title: "Now", body: "" });
  assertEquals(f.scheduled.map((e) => [e.tag, e.at]), [["denext-5", NOW]]);
});

Deno.test("notifications: a repeating trigger schedules its next occurrences; cancel removes them all", async () => {
  const f = fakeNotifications();
  const cap = notificationsCapability({
    api: f.api,
    autoTopUp: false,
    now: () => NOW,
    timer: () => () => {},
  });
  await call(cap, "schedule", {
    id: 6,
    title: "Daily",
    body: "09:30",
    trigger: { type: "daily", hour: 9, minute: 30 },
  });
  assertEquals(f.scheduled.length, REPEAT_HORIZON);
  const times = f.scheduled.map((e) => e.at as number);
  assertEquals(new Date(times[0]).getHours(), 9);
  assertEquals(new Date(times[0]).getMinutes(), 30);
  for (let i = 1; i < times.length; i++) {
    // One day apart (a DST change shifts one by an hour).
    assert(Math.abs(times[i] - times[i - 1] - DAY) <= 3600_000, `occurrence ${i}`);
  }
  assert(f.scheduled.every((e) => e.tag === `denext-6-${e.at}`));
  // One pending entry per notification, not per occurrence.
  assertEquals((await call(cap, "pending") as unknown[]).length, 1);
  await call(cap, "cancel", { ids: [6] });
  assertEquals(f.scheduled, []);
  assert(f.cancelled.includes("denext-6"));
});

Deno.test("notifications: a repeating interval counts from its first occurrence", () => {
  const series = {
    trigger: { type: "interval" as const, seconds: 60, repeats: true },
    anchor: 1000,
  };
  assertEquals(seriesTimes(series, 1000, 3), [61_000, 121_000, 181_000]);
  assertEquals(seriesTimes(series, 125_000, 2), [181_000, 241_000]);
  assertEquals(seriesTimes(series, 0, 2), [1000, 61_000]);
});

Deno.test("notifications: a running app tops a series up when half of it fired", async () => {
  const f = fakeNotifications();
  let clock = NOW;
  const armed: Array<{ run: () => void; ms: number }> = [];
  const cap = notificationsCapability({
    api: f.api,
    autoTopUp: false,
    now: () => clock,
    timer: (run, ms) => {
      armed.push({ run, ms });
      return () => {};
    },
  });
  await call(cap, "schedule", {
    id: 8,
    title: "Hourly",
    body: "",
    trigger: { type: "interval", seconds: 3600, repeats: true },
  });
  assertEquals(f.scheduled.length, REPEAT_HORIZON);
  const half = armed.at(-1)!;
  // Half the series fires 9 h out; the check runs at least every 6 h.
  assertEquals(half.ms, 6 * 3600_000);
  // The OS delivered the first half.
  clock += (REPEAT_HORIZON / 2 + 1) * 3600_000;
  f.scheduled.splice(0, REPEAT_HORIZON / 2);
  half.run();
  await until(() => f.scheduled.length === REPEAT_HORIZON, WAIT_MS);
  const ats = f.scheduled.map((e) => e.at as number);
  assertEquals(new Set(ats).size, ats.length);
  assertEquals(ats.at(-1), NOW + 3600_000 * (REPEAT_HORIZON + REPEAT_HORIZON / 2));
});

Deno.test("notifications: a launch tops up the series an earlier run left", async () => {
  const f = fakeNotifications();
  const series = { trigger: { type: "daily", hour: 7, minute: 0 }, anchor: NOW };
  f.scheduled.push({
    tag: `denext-3-${NOW + DAY}`,
    title: "Left",
    body: "over",
    at: NOW + DAY,
    data: { denext: { id: 3, r: series }, data: {} },
    actions: [{ action: "snooze", title: "Snooze" }],
  });
  notificationsCapability({ api: f.api, now: () => NOW, timer: () => () => {} });
  await until(() => f.scheduled.length === REPEAT_HORIZON, WAIT_MS);
  assert(f.scheduled.every((e) => e.title === "Left" && e.actions?.[0]?.action === "snooze"));
});

Deno.test("notifications: categories become action buttons; bad input is a validation error", async () => {
  const f = fakeNotifications();
  const cap = notificationsCapability({ api: f.api, autoTopUp: false, now: () => NOW });
  await call(cap, "setCategories", {
    categories: [{ id: "msg", actions: [{ id: "reply", title: "Reply" }] }],
  });
  await call(cap, "schedule", { id: 1, title: "t", body: "b", categoryId: "msg" });
  assertEquals(f.scheduled[0].actions, [{ action: "reply", title: "Reply" }]);
  assertEquals(
    await codeOf(call(cap, "schedule", { id: 1.5, title: "t", body: "b" })),
    "validation",
  );
  assertEquals(
    await codeOf(
      call(cap, "schedule", { id: 1, title: "t", body: "b", trigger: { type: "nope" } }),
    ),
    "validation",
  );
  assertEquals(
    await codeOf(
      call(cap, "schedule", { id: 1, title: "t", body: "b", data: { big: "x".repeat(5000) } }),
    ),
    "validation",
  );
  assertEquals(
    await codeOf(call(cap, "setCategories", { categories: [{ id: "c", actions: [{ id: 1 }] }] })),
    "validation",
  );
});

Deno.test("notifications: clicks are pulled once — the launch click first, foreign ones ignored", async () => {
  const f = fakeNotifications([
    {
      tag: "denext-9",
      action: null,
      data: { denext: { id: 9, t: "Cold" }, data: { path: "/c" } },
      launch: true,
    },
    { tag: "someone-else", action: null, data: null, launch: true },
  ]);
  const cap = notificationsCapability({ api: f.api, autoTopUp: false });
  const ctx = ctxOf();
  assertEquals(await call(cap, "take", {}, ctx), [
    { id: 9, actionId: "tap", title: "Cold", data: { path: "/c" }, launch: true },
  ]);
  assertEquals(await call(cap, "take", {}, ctx), []);
  // A live click (an action button) is queued and signalled.
  f.listeners.get("notificationresponse")!(
    new CustomEvent("notificationresponse", {
      detail: { tag: "denext-9-123", action: "archive", data: { denext: { id: 9 }, data: {} } },
    }),
  );
  assertEquals(ctx.emitted, [["tap", null], ["tap", null]]);
  assertEquals(await call(cap, "take", {}, ctx), [
    { id: 9, actionId: "archive", data: {}, launch: false },
  ]);
});

Deno.test("notifications: where the runtime cannot schedule, now is a Deno Notification; later is unsupported", async () => {
  const f = fakeNotifications();
  f.noSchedule();
  const shown: Array<{ title: string; options: unknown; target: EventTarget }> = [];
  class FakeNotification extends EventTarget {
    constructor(title: string, options?: unknown) {
      super();
      shown.push({ title, options, target: this });
    }
  }
  const cap = notificationsCapability({ api: f.api, autoTopUp: false, showNow: FakeNotification });
  const ctx = ctxOf();
  await call(cap, "take", {}, ctx);
  await call(cap, "schedule", { id: 2, title: "Hi", body: "there" });
  assertEquals(shown[0].title, "Hi");
  shown[0].target.dispatchEvent(new Event("click"));
  assertEquals(await call(cap, "take", {}, ctx), [
    { id: 2, actionId: "tap", title: "Hi", body: "there", data: {}, launch: false },
  ]);
  assertEquals(
    await codeOf(
      call(cap, "schedule", {
        id: 3,
        title: "t",
        body: "",
        trigger: { type: "interval", seconds: 5 },
      }),
    ),
    "unsupported",
  );
});

Deno.test("notifications: permission — query without a prompt, request through the runtime", async () => {
  const f = fakeNotifications();
  const cap = notificationsCapability({ api: f.api, autoTopUp: false });
  // Plain Deno has no notification permission: the query falls back to "prompt"…
  assertEquals(await call(cap, "permission", {}), { state: "prompt" });
  assertEquals(await call(cap, "permission", { request: true }), { state: "granted" });
  // …or, once the OS has answered a request, to that answer.
  assertEquals(await call(cap, "permission", {}), { state: "granted" });
});

// --- menus -----------------------------------------------------------------------------------

Deno.test("menu: items, submenus, roles and separators convert; ids are collected", () => {
  const { items, ids } = nativeMenu([
    { id: "new", label: "New", accelerator: "CommandOrControl+N" },
    {
      label: "Edit",
      children: [{ role: "copy" }, "separator", {
        id: "x",
        label: "X",
        enabled: false,
        checked: true,
      }],
    },
    { separator: true },
    { role: "QUIT" },
  ]);
  assertEquals(items, [
    { item: { label: "New", id: "new", enabled: true, accelerator: "CommandOrControl+N" } },
    {
      submenu: {
        label: "Edit",
        items: [
          { role: { role: "copy" } },
          "separator",
          { item: { label: "X", id: "x", enabled: false, checked: true } },
        ],
      },
    },
    "separator",
    { role: { role: "QUIT" } },
  ]);
  assertEquals([...ids], ["new", "x"]);
  assertThrows(() => nativeMenu([{ role: "format-disk" }]));
  assertThrows(() => nativeMenu([{ label: "no id" }]));
  assertThrows(() => nativeMenu("nope"));
  let deep: unknown = [{ id: "leaf", label: "L" }];
  for (let i = 0; i < 9; i++) deep = [{ label: "S", children: deep }];
  assertThrows(() => nativeMenu(deep));
});

Deno.test("contextMenu: the native menu resolves the chosen id, null when dismissed", async () => {
  const shown: Array<{ x: number; y: number; menu: DesktopMenuItem[] }> = [];
  let answer: string | null = "open";
  const win = {
    showContextMenu: (x: number, y: number, menu: DesktopMenuItem[]) => {
      shown.push({ x, y, menu });
      return Promise.resolve(answer);
    },
  };
  const api: DesktopAppApi = {
    menuCapabilities: () => ({ contextMenu: true, contextClosed: true }),
  };
  const cap = contextMenuCapability({ api });
  const args = {
    items: [{ id: "open", label: "Open" }, { label: "More", children: [{ id: "a", label: "A" }] }],
    x: 10.4,
    y: 20.6,
    title: "Row",
  };
  assertEquals(await call(cap, "show", args, ctxOf(win)), { id: "open" });
  assertEquals(shown[0].x, 10);
  assertEquals(shown[0].y, 21);
  assertEquals(shown[0].menu[0], { item: { label: "Row", enabled: false } });
  assertEquals(shown[0].menu[1], "separator");
  answer = null;
  assertEquals(await call(cap, "show", args, ctxOf(win)), { id: null });
  // An id the menu does not have is never reported.
  answer = "injected";
  assertEquals(await call(cap, "show", args, ctxOf(win)), { id: null });
});

Deno.test("contextMenu: unavailable where the runtime cannot report a dismissal", async () => {
  const win = { showContextMenu: () => {} };
  const items = { items: [{ id: "a", label: "A" }], x: 0, y: 0 };
  for (
    const api of [{}, { menuCapabilities: () => ({ contextMenu: true, contextClosed: false }) }]
  ) {
    const cap = contextMenuCapability({ api });
    assertEquals(await codeOf(call(cap, "show", items, ctxOf(win))), "unavailable");
  }
});

// --- shortcuts / launch at login ---------------------------------------------------------------

function fakeShortcuts() {
  const held: string[] = [];
  let listener: ((e: Event) => void) | undefined;
  const api: DesktopAppApi = {
    shortcuts: {
      capabilities: () => ({ globalShortcuts: true, userBinds: false }),
      register: (acc) => {
        if (acc === "Bad") {
          return Promise.reject(
            Object.assign(new TypeError("does not parse"), { code: "invalid" }),
          );
        }
        if (acc === "Taken") {
          return Promise.reject(Object.assign(new Error("held"), { code: "conflict" }));
        }
        const canonical = acc.replace("CommandOrControl", "Ctrl");
        held.push(canonical);
        return Promise.resolve(canonical);
      },
      unregister: (acc) => {
        const at = held.indexOf(acc);
        if (at >= 0) held.splice(at, 1);
        return at >= 0;
      },
      unregisterAll: () => void held.splice(0),
      isRegistered: (acc) => held.includes(acc),
      list: () => [...held],
      canonicalize: (acc) => acc.replace("CommandOrControl", "Ctrl"),
      addEventListener: (_type, l) => void (listener = l),
    },
  };
  return {
    api,
    held,
    press: (accelerator: string) =>
      listener?.(new CustomEvent("shortcut", { detail: { accelerator } })),
  };
}

Deno.test("globalShortcuts: register, presses pulled once, errors mapped, released on page load", async () => {
  assertEquals(
    await codeOf(call(shortcutsCapability({ api: {} }), "register", { accelerator: "A" })),
    "unavailable",
  );
  const f = fakeShortcuts();
  const cap = shortcutsCapability({ api: f.api });
  const ctx = ctxOf();
  assertEquals(await call(cap, "register", { accelerator: "CommandOrControl+K" }, ctx), {
    accelerator: "Ctrl+K",
  });
  assertEquals(await codeOf(call(cap, "register", { accelerator: "Bad" }, ctx)), "validation");
  assertEquals(await codeOf(call(cap, "register", { accelerator: "Taken" }, ctx)), "conflict");
  assertEquals(await codeOf(call(cap, "register", { accelerator: "" }, ctx)), "validation");
  f.press("Ctrl+K");
  assertEquals(ctx.emitted, [["pressed", null]]);
  assertEquals(await call(cap, "take", {}, ctx), [{ accelerator: "Ctrl+K" }]);
  assertEquals(await call(cap, "take", {}, ctx), []);
  assertEquals(await call(cap, "list"), ["Ctrl+K"]);
  await cap.onPageLoad!();
  assertEquals(f.held, []);
});

Deno.test("launchAtLogin: get / set through the runtime; unexpected answers read not-supported", async () => {
  assertEquals(await codeOf(call(launchAtLoginCapability({ api: {} }), "get")), "unavailable");
  let state = "disabled";
  const api: DesktopAppApi = {
    launchAtLogin: {
      get: () => Promise.resolve(state),
      set: (on) => {
        if (state === "broken") {
          return Promise.reject(new Error("/home/me/.config/autostart: denied"));
        }
        state = on ? "requires-approval" : "disabled";
        return Promise.resolve(state);
      },
    },
  };
  const cap = launchAtLoginCapability({ api });
  assertEquals(await call(cap, "get"), { state: "disabled" });
  assertEquals(await call(cap, "set", { enabled: true }), { state: "requires-approval" });
  assertEquals(await codeOf(call(cap, "set", { enabled: "yes" })), "validation");
  state = "weird";
  assertEquals(await call(cap, "get"), { state: "not-supported" });
  state = "broken";
  // The OS message (it can name a path) never reaches the page.
  await assertRejects(
    () => call(cap, "set", { enabled: true }) as Promise<unknown>,
    Error,
    "the OS did not",
  );
});

// --- the app controller (menu bar, trays, dock) ------------------------------------------------

class FakeTray extends EventTarget implements TrayLike {
  static made: FakeTray[] = [];
  icon?: Uint8Array;
  tooltip: string | null = null;
  menu: DesktopMenuItem[] | null = null;
  destroyed = false;
  constructor() {
    super();
    FakeTray.made.push(this);
  }
  setIcon(png: Uint8Array) {
    this.icon = png;
  }
  setTooltip(text: string | null) {
    this.tooltip = text;
  }
  setMenu(menu: DesktopMenuItem[] | null) {
    this.menu = menu;
  }
  getBounds() {
    return { x: 1, y: 2, width: 3, height: 4 };
  }
  destroy() {
    this.destroyed = true;
  }
}

class FakeDock extends EventTarget implements DockLike {
  badge: string | null = null;
  bounces: boolean[] = [];
  menu: DesktopMenuItem[] | null = null;
  setBadge(text: string | null) {
    this.badge = text;
  }
  bounce(critical?: boolean) {
    this.bounces.push(critical === true);
  }
  setMenu(menu: DesktopMenuItem[] | null) {
    this.menu = menu;
  }
}

function appController(os = "darwin") {
  FakeTray.made = [];
  const win = Object.assign(new EventTarget(), {
    menu: undefined as DesktopMenuItem[] | undefined,
    setApplicationMenu(menu: DesktopMenuItem[]) {
      this.menu = menu;
    },
  });
  const dock = new FakeDock();
  const emitted: string[] = [];
  const ctl = createAppController({
    window: win,
    api: { menuCapabilities: () => ({ appMenu: true, accelerators: true }) },
    emit: (cap, event) => void emitted.push(`${cap}:${event}`),
    Tray: FakeTray,
    dock,
    os,
  });
  ctl.install();
  return { ctl, cap: ctl.capability, win, dock, emitted };
}

const PNG = "iVBORw0KGgo=";
const click = (target: EventTarget, id: string) =>
  target.dispatchEvent(new CustomEvent("menuclick", { detail: { id } }));

Deno.test("app: the application menu's clicks are pulled; ids it does not have are dropped", async () => {
  const { cap, win, emitted } = appController();
  await call(cap, "setAppMenu", {
    menu: [{
      label: "File",
      children: [{ id: "new", label: "New", accelerator: "CommandOrControl+N" }],
    }],
  });
  assert(win.menu);
  click(win, "new");
  click(win, "not-mine");
  assertEquals(emitted, ["app:action"]);
  assertEquals(await call(cap, "take"), [{ source: "menu", id: "new" }]);
  assertEquals(await call(cap, "take"), []);
  const caps = await call(cap, "capabilities") as Record<string, boolean>;
  assertEquals([caps.appMenu, caps.accelerators, caps.tray, caps.dockMenu], [
    true,
    true,
    true,
    true,
  ]);
});

Deno.test("app: trays — create, update, clicks and menu clicks, destroyed on a page load", async () => {
  const { cap } = appController();
  assertEquals(await codeOf(call(cap, "createTray", {})), "validation");
  const { id } = await call(cap, "createTray", {
    icon: PNG,
    tooltip: "Acme",
    menu: [{ id: "show", label: "Show" }],
  }) as { id: string };
  const tray = FakeTray.made[0];
  assertEquals(tray.tooltip, "Acme");
  assert(tray.icon && tray.icon.length > 0);
  tray.dispatchEvent(new Event("click"));
  tray.dispatchEvent(new Event("dblclick"));
  click(tray, "show");
  assertEquals(await call(cap, "take"), [
    { source: "tray", tray: id, event: "click" },
    { source: "tray", tray: id, event: "doubleClick" },
    { source: "trayMenu", tray: id, id: "show" },
  ]);
  await call(cap, "updateTray", { id, tooltip: null, menu: null });
  assertEquals([tray.tooltip, tray.menu], [null, null]);
  assertEquals(await call(cap, "trayBounds", { id }), { x: 1, y: 2, width: 3, height: 4 });
  assertEquals(await codeOf(call(cap, "updateTray", { id: "nope" })), "validation");
  await cap.onPageLoad!();
  assert(tray.destroyed);
  assertEquals(await codeOf(call(cap, "destroyTray", { id })), "validation");
});

Deno.test("app: badge, bounce and the Dock menu (macOS only)", async () => {
  const mac = appController("darwin");
  await call(mac.cap, "setBadge", { text: "3" });
  assertEquals(mac.dock.badge, "3");
  await call(mac.cap, "setBadge", { text: null });
  assertEquals(mac.dock.badge, "", "cleared with an empty string (the runtime shows null as text)");
  await call(mac.cap, "bounce", { critical: true });
  assertEquals(mac.dock.bounces, [true]);
  assertEquals(
    await call(mac.cap, "setDockMenu", { menu: [{ id: "new-chat", label: "New chat" }] }),
    {
      applied: true,
    },
  );
  click(mac.dock, "new-chat");
  assertEquals(await call(mac.cap, "take"), [{ source: "dock", id: "new-chat" }]);
  assertEquals(await call(mac.cap, "setDockMenu", { menu: null }), { applied: true });
  assertEquals(mac.dock.menu, null);
  const win = appController("windows");
  assertEquals(await call(win.cap, "setDockMenu", { menu: [{ id: "a", label: "A" }] }), {
    applied: false,
  });
});

Deno.test("app: no tray or dock in this runtime → unsupported", async () => {
  const ctl = createAppController({ window: undefined, emit: () => {}, os: "linux" });
  const cap = ctl.capability;
  if ((Deno as unknown as { Tray?: unknown }).Tray === undefined) {
    assertEquals(await codeOf(call(cap, "createTray", { icon: PNG })), "unsupported");
  }
  assertEquals(await codeOf(call(cap, "setAppMenu", { menu: [] })), "unsupported");
});

Deno.test("pull queue: bounded, emptied by take, signals each push", () => {
  let signals = 0;
  const q = createPullQueue<number>(() => signals++, 2);
  q.push(1);
  q.push(2);
  q.push(3);
  assertEquals(signals, 3);
  assertEquals(q.take(), [2, 3]);
  assertEquals(q.take(), []);
  q.push(4);
  q.clear();
  assertEquals(q.take(), []);
});

// --- notifications: validation, one-shot triggers, recovery and permission ---------------------

Deno.test("notifications: malformed arguments are validation errors and schedule nothing", async () => {
  const f = fakeNotifications();
  const cap = notificationsCapability({ api: f.api, autoTopUp: false, now: () => NOW });
  for (
    const args of [
      [1, 2],
      { id: 1, title: 5 },
      { id: 1, title: "t", data: [1] },
      { id: 1, title: "t", categoryId: 7 },
      { id: 1, title: "t", trigger: "tomorrow" },
      // A repeating interval must be at least a minute (a RangeError from the trigger check).
      { id: 1, title: "t", trigger: { type: "interval", seconds: 30, repeats: true } },
      // 30 February 2027 never comes.
      { id: 1, title: "t", trigger: { type: "calendar", year: 2027, month: 2, day: 30 } },
    ]
  ) {
    assertEquals(await codeOf(call(cap, "schedule", args)), "validation", JSON.stringify(args));
  }
  assertEquals(f.scheduled, []);
  assertEquals(await codeOf(call(cap, "cancel", { ids: "1" })), "validation");
  assertEquals(await codeOf(call(cap, "cancel", { ids: [1.5] })), "validation");
  assertEquals(await call(cap, "cancel", undefined), null, "no ids: nothing to cancel");
  assertEquals(await codeOf(call(cap, "setCategories", {})), "validation");
  assertEquals(
    await codeOf(call(cap, "setCategories", { categories: [{ id: "c", actions: "reply" }] })),
    "validation",
  );
  assertEquals(await call(cap, "capabilities"), {
    show: true,
    schedule: true,
    actions: true,
    clicks: true,
    categories: true,
    // No session probe in this runtime: unknown, no reasons.
    transport: "unknown",
    coldStartReason: null,
    schedulePersistsReason: null,
  });
});

Deno.test("notifications: capabilities pass on the runtime's Linux reasons (runtime 2.9.7-denext.11)", async () => {
  const f = fakeNotifications();
  const caps = (features: Record<string, unknown>) =>
    call(
      notificationsCapability({
        api: { ...f.api, platformFeatures: () => Promise.resolve(features) },
        autoTopUp: false,
      }),
      "capabilities",
    ) as Promise<Record<string, unknown>>;
  // An AppImage on GNOME without a systemd user manager: the freedesktop transport.
  const appImage = await caps({
    os: "linux",
    notificationTransport: "freedesktop",
    notificationColdStart: false,
    notificationColdStartReason: "no dev.acme.app.desktop is installed",
    notificationScheduleWhileClosed: false,
    notificationScheduleReason: "no systemd user manager on the session bus",
  });
  assertEquals(
    [appImage.transport, appImage.coldStartReason, appImage.schedulePersistsReason],
    [
      "freedesktop",
      "no dev.acme.app.desktop is installed",
      "no systemd user manager on the session bus",
    ],
  );
  // The .deb on GNOME: the portal, nothing missing (a stray reason is not passed on).
  const deb = await caps({
    os: "linux",
    notificationTransport: "portal",
    notificationColdStart: true,
    notificationColdStartReason: "stray",
    notificationScheduleWhileClosed: true,
  });
  assertEquals(
    [deb.transport, deb.coldStartReason, deb.schedulePersistsReason],
    ["portal", null, null],
  );
  // No notification server: no transport. macOS: null facts.
  assertEquals((await caps({ notificationTransport: null })).transport, null);
  assertEquals((await caps({ notificationTransport: "dbus" })).transport, "unknown");
});

Deno.test("notifications: one-shot interval / calendar triggers are one OS notification; a finite series stops", async () => {
  const f = fakeNotifications();
  const armed: number[] = [];
  const cap = notificationsCapability({
    api: f.api,
    autoTopUp: false,
    now: () => NOW,
    timer: (_run, ms) => {
      armed.push(ms);
      return () => {};
    },
  });
  await call(cap, "schedule", {
    id: 1,
    title: "In 90 s",
    trigger: { type: "interval", seconds: 90 },
  });
  await call(cap, "schedule", {
    id: 2,
    title: "Next 09:00",
    trigger: { type: "calendar", repeats: false, hour: 9, minute: 0 },
  });
  // A date already past fires now.
  await call(cap, "schedule", {
    id: 3,
    title: "Late",
    trigger: { type: "date", date: NOW - 5000 },
  });
  assertEquals(f.scheduled.map((e) => [e.tag, e.at]), [
    ["denext-1", NOW + 90_000],
    ["denext-2", new Date(2026, 9, 1, 9, 0, 0).getTime()],
    ["denext-3", NOW],
  ]);
  assertEquals(f.scheduled[0].body, "", "an absent body is empty");
  // A "repeating" calendar match that exists once is a series of one.
  const once = new Date(2027, 0, 5, 9, 0, 0).getTime();
  await call(cap, "schedule", {
    id: 4,
    title: "Once",
    trigger: { type: "calendar", year: 2027, month: 1, day: 5, hour: 9, minute: 0 },
  });
  assertEquals(f.scheduled.filter((e) => e.tag.startsWith("denext-4")).map((e) => e.tag), [
    `denext-4-${once}`,
  ]);
  assertEquals(armed.length, 1, "the series still arms its top-up check");
});

Deno.test("notifications: data too big for the meta drops the title/body copy, not the app data", async () => {
  const f = fakeNotifications();
  const cap = notificationsCapability({ api: f.api, autoTopUp: false, now: () => NOW });
  const title = "T".repeat(3800);
  await call(cap, "schedule", { id: 4, title, body: "", data: { x: "y".repeat(500) } });
  assertEquals(f.scheduled[0].title, title, "the OS still shows the full title");
  assertEquals(f.scheduled[0].data, { denext: { id: 4 }, data: { x: "y".repeat(500) } });
  const ctx = ctxOf();
  await call(cap, "take", {}, ctx);
  f.listeners.get("notificationresponse")!(
    new CustomEvent("notificationresponse", {
      detail: { tag: "denext-4", action: null, data: f.scheduled[0].data },
    }),
  );
  // No stored title/body: the tap carries only the id and the app's data.
  assertEquals(await call(cap, "take", {}, ctx), [
    { id: 4, actionId: "tap", data: { x: "y".repeat(500) }, launch: false },
  ]);
});

Deno.test("notifications: a click is recovered from its tag alone; malformed responses are dropped", async () => {
  const f = fakeNotifications();
  const api: DesktopAppApi = { ...f.api, launchNotificationResponses: undefined };
  const cap = notificationsCapability({ api, autoTopUp: false });
  const ctx = ctxOf();
  assertEquals(await call(cap, "take", {}, ctx), [], "no launch responses");
  const respond = (detail: unknown) =>
    f.listeners.get("notificationresponse")!(new CustomEvent("notificationresponse", { detail }));
  respond(undefined);
  respond({ tag: 5, data: null });
  respond({ tag: "denext-oops", data: null });
  // The data was lost (a runtime that does not round-trip it): the tag still names the id.
  respond({ tag: "denext-12-1700000000000", action: "", data: "opaque", launch: true });
  assertEquals(await call(cap, "take", {}, ctx), [
    { id: 12, actionId: "tap", data: {}, launch: true },
  ]);
  // A runtime with no event target still answers take.
  const quiet = notificationsCapability({
    api: { notifications: f.api.notifications },
    autoTopUp: false,
  });
  assertEquals(await call(quiet, "take", {}, ctxOf()), []);
});

Deno.test("notifications: pending lists each id once, in time order, skipping entries it cannot read", async () => {
  const f = fakeNotifications();
  const series = { trigger: { type: "daily", hour: 7, minute: 0 }, anchor: 100 };
  const raw = [
    { tag: "denext-7-200", at: 200, data: { denext: { id: 7, r: series }, data: {} } },
    { tag: "denext-7-100", at: 100, data: { denext: { id: 7, r: series }, data: {} } },
    { tag: "denext-8", title: "Eight", body: "b", data: null },
    { tag: "denext-bogus", at: 50, data: null },
    { tag: "someone-else", at: 1, data: null },
  ] as unknown as DesktopScheduledNotification[];
  const api: DesktopAppApi = {
    notifications: { ...f.api.notifications!, getScheduled: () => Promise.resolve(raw) },
  };
  const cap = notificationsCapability({ api, autoTopUp: false });
  assertEquals(await call(cap, "pending"), [
    { id: 8, title: "Eight", body: "b", extra: {} },
    { id: 7, title: "", body: "", extra: {} },
  ]);
});

Deno.test("notifications: a launch tops up only the series that are short, soonest check first", async () => {
  const f = fakeNotifications();
  const short = { trigger: { type: "daily", hour: 7, minute: 0 }, anchor: NOW };
  const full = { trigger: { type: "daily" as const, hour: 20, minute: 0 }, anchor: NOW };
  // A bare entry (no title/body/actions stored) for the short series.
  f.scheduled.push({
    tag: `denext-1-${NOW + DAY}`,
    at: NOW + DAY,
    data: { denext: { id: 1, r: short }, data: {} },
  } as DesktopScheduledNotification);
  for (const at of seriesTimes(full, NOW, REPEAT_HORIZON)) {
    f.scheduled.push({
      tag: `denext-2-${at}`,
      title: "Full",
      body: "",
      at,
      data: { denext: { id: 2, r: full }, data: {} },
      actions: [],
    });
  }
  const armed: number[] = [];
  notificationsCapability({
    api: f.api,
    now: () => NOW,
    timer: (_run, ms) => {
      armed.push(ms);
      return () => {};
    },
  });
  const ofSeries = (id: number) => f.scheduled.filter((e) => e.tag.startsWith(`denext-${id}-`));
  // The launch's top-up is done once the short series is full and its check is armed.
  await until(() => ofSeries(1).length === REPEAT_HORIZON && armed.length > 0, WAIT_MS);
  const added = ofSeries(1).filter((e) => e.at !== NOW + DAY);
  assert(added.every((e) => e.title === "" && e.body === "" && e.actions?.length === 0));
  assertEquals(ofSeries(2).length, REPEAT_HORIZON, "a full series gets nothing more");
  assertEquals(armed.length, 1, "one check, for the series whose midpoint comes first");
});

Deno.test("notifications: permission — provisional requests and the no-prompt query fallbacks", async () => {
  const f = fakeNotifications();
  const asked: unknown[] = [];
  const api: DesktopAppApi = {
    notifications: {
      ...f.api.notifications!,
      requestPermission: (o) => {
        asked.push(o);
        return Promise.resolve("provisional");
      },
    },
  };
  const cap = notificationsCapability({ api, autoTopUp: false });
  assertEquals(await call(cap, "permission", { request: true, provisional: true }), {
    state: "provisional",
  });
  assertEquals(asked, [{ provisional: true }]);
  // The Permissions API answers when it knows `notifications` (over the OS's earlier answer).
  await withProps(
    navigator,
    { permissions: { query: () => Promise.resolve({ state: "denied" }) } },
    async () => assertEquals(await call(cap, "permission", {}), { state: "denied" }),
  );
  // It does not (no state): the cached Notification.permission is used, "default" reads prompt
  // (a capability that has not asked the OS yet).
  const fresh = notificationsCapability({ api, autoTopUp: false });
  for (const [cached, state] of [["granted", "granted"], ["default", "prompt"]]) {
    await withProps(
      navigator,
      { permissions: { query: () => Promise.resolve({}) } },
      () =>
        withProps(globalThis, { Notification: { permission: cached } }, async () => {
          assertEquals(await call(fresh, "permission", {}), { state });
        }),
    );
  }
});

/** A runtime whose permission request answers only when the test says so, counting the prompts. */
function promptingNotifications() {
  const f = fakeNotifications();
  const prompts: Array<(state: string) => void> = [];
  const api: DesktopAppApi = {
    notifications: {
      ...f.api.notifications!,
      requestPermission: () => new Promise<string>((resolve) => prompts.push(resolve)),
    },
  };
  return { api, prompts };
}

Deno.test("notifications: permission — an OS that never answers settles at the bound with the current state", async () => {
  const { api, prompts } = promptingNotifications();
  const cap = notificationsCapability({ api, autoTopUp: false, permissionTimeoutMs: 20 });
  // Nothing known: the no-prompt query answers ("prompt" in plain Deno).
  assertEquals(await call(cap, "permission", { request: true }), { state: "prompt" });
  // The Permissions API knows the state: that is the answer.
  await withProps(
    navigator,
    { permissions: { query: () => Promise.resolve({ state: "denied" }) } },
    async () => assertEquals(await call(cap, "permission", { request: true }), { state: "denied" }),
  );
  assertEquals(prompts.length, 1, "the still-open OS request is shared, never asked twice");
  // The late OS answer is remembered: the next query and the next request see it at once.
  prompts[0]("granted");
  await Promise.resolve();
  assertEquals(await call(cap, "permission", {}), { state: "granted" });
  const again = call(cap, "permission", { request: true });
  assertEquals(prompts.length, 2, "a settled request asks the OS again");
  prompts[1]("granted");
  assertEquals(await again, { state: "granted" });
});

Deno.test("notifications: permission — concurrent requests share one OS prompt", async () => {
  const { api, prompts } = promptingNotifications();
  const cap = notificationsCapability({ api, autoTopUp: false, permissionTimeoutMs: 60_000 });
  const first = call(cap, "permission", { request: true });
  const second = call(cap, "permission", { request: true, provisional: true });
  await Promise.resolve();
  assertEquals(prompts.length, 1);
  prompts[0]("denied");
  assertEquals(await Promise.all([first, second]), [{ state: "denied" }, { state: "denied" }]);
  // A runtime that fails the request fails the callers, and the next request asks again.
  let fail = true;
  const failing = notificationsCapability({
    api: {
      notifications: {
        ...api.notifications!,
        requestPermission: () =>
          fail ? Promise.reject(new Error("no service")) : Promise.resolve("granted"),
      },
    },
    autoTopUp: false,
  });
  await assertRejects(() => call(failing, "permission", { request: true }), Error, "no service");
  fail = false;
  assertEquals(await call(failing, "permission", { request: true }), { state: "granted" });
});

Deno.test("notifications: no runtime scheduling and no Notification → unsupported; action clicks are queued", async () => {
  const f = fakeNotifications();
  f.noSchedule();
  const none = notificationsCapability({ api: f.api, autoTopUp: false });
  await withProps(globalThis, { Notification: undefined }, async () => {
    assertEquals(await codeOf(call(none, "schedule", { id: 1, title: "t" })), "unsupported");
  });
  const shown: EventTarget[] = [];
  class FakeNotification extends EventTarget {
    constructor() {
      super();
      shown.push(this);
    }
  }
  const cap = notificationsCapability({ api: f.api, autoTopUp: false, showNow: FakeNotification });
  const ctx = ctxOf();
  await call(cap, "take", {}, ctx);
  await call(cap, "schedule", { id: 2, title: "Hi" });
  shown[0].dispatchEvent(Object.assign(new Event("action"), { action: "reply" }));
  shown[0].dispatchEvent(new Event("action"));
  assertEquals(
    (await call(cap, "take", {}, ctx) as Array<{ actionId: string }>).map((t) => t.actionId),
    ["reply", "tap"],
  );
});

// --- menus / context menu / shortcuts: the remaining edges -------------------------------------

Deno.test("menu: tooltips and icons convert; bad entries, empty ids and oversize menus are refused", () => {
  const { items } = nativeMenu([{ id: "a", label: "A", tooltip: "Tip", icon: PNG }]);
  const item = (items[0] as { item: { tooltip?: string; icon?: Uint8Array } }).item;
  assertEquals(item.tooltip, "Tip");
  assert(item.icon instanceof Uint8Array && item.icon.length > 0);
  for (
    const bad of [
      [{ id: "a", label: "A", icon: "%%%" }],
      [{ id: "a", label: "A", icon: 7 }],
      [{ id: "", label: "Empty" }],
      [42],
      [null],
      Array.from({ length: 501 }, (_, i) => ({ id: `i${i}`, label: "x" })),
    ]
  ) {
    const err = assertThrows(() => nativeMenu(bad)) as { code?: string };
    assertEquals(err.code, "validation");
  }
});

Deno.test("contextMenu: capabilities report the runtime's, and bad coordinates are refused", async () => {
  const api: DesktopAppApi = {
    menuCapabilities: () => ({ contextMenu: true, contextClosed: true }),
  };
  const cap = contextMenuCapability({ api });
  assertEquals(await call(cap, "capabilities"), {
    native: true,
    contextMenu: true,
    contextClosed: true,
  });
  assertEquals(await call(contextMenuCapability({ api: {} }), "capabilities"), { native: false });
  const win = { showContextMenu: () => Promise.resolve("a") };
  const items = [{ id: "a", label: "A" }];
  for (const at of [{ x: Number.NaN, y: 0 }, { x: 0, y: 200_000 }, { x: "1", y: 0 }]) {
    assertEquals(
      await codeOf(call(cap, "show", { items, ...at }, ctxOf(win))),
      "validation",
      JSON.stringify(at),
    );
  }
  // No arguments at all: the menu itself is missing.
  assertEquals(await codeOf(call(cap, "show", undefined, ctxOf(win))), "validation");
  // An empty title adds no header row.
  const shown: DesktopMenuItem[][] = [];
  const recording = {
    showContextMenu: (_x: number, _y: number, menu: DesktopMenuItem[]) => {
      shown.push(menu);
      return Promise.resolve(undefined);
    },
  };
  assertEquals(await call(cap, "show", { items, x: 0, y: 0, title: "" }, ctxOf(recording)), {
    id: null,
  });
  assertEquals(shown[0].length, 1);
});

Deno.test("globalShortcuts: every runtime error code maps; the cap limit, unregister and canonicalize", async () => {
  const f = fakeShortcuts();
  const failing = (code: unknown) =>
    shortcutsCapability({
      api: {
        shortcuts: {
          ...f.api.shortcuts!,
          register: () => Promise.reject(Object.assign(new Error(`boom ${code}`), { code })),
        },
      },
    });
  for (
    const [code, expected] of [
      ["not_supported", "unsupported"],
      ["already_registered", "already_registered"],
      ["denied", "denied"],
      ["ENOENT", "failed"],
      [undefined, "failed"],
    ]
  ) {
    assertEquals(
      await codeOf(call(failing(code), "register", { accelerator: "Ctrl+J" })),
      expected,
      String(code),
    );
  }
  const cap = shortcutsCapability({ api: f.api });
  assertEquals(await call(cap, "capabilities"), { globalShortcuts: true, userBinds: false });
  assertEquals(await call(cap, "canonicalize", { accelerator: "CommandOrControl+P" }), {
    accelerator: "Ctrl+P",
  });
  assertEquals(await codeOf(call(cap, "canonicalize", null)), "validation");
  assertEquals(
    await codeOf(call(cap, "register", { accelerator: "K".repeat(65) })),
    "validation",
    "an over-long accelerator",
  );
  await call(cap, "register", { accelerator: "Ctrl+1" });
  assertEquals(await call(cap, "unregister", { accelerator: "Ctrl+1" }), { removed: true });
  assertEquals(await call(cap, "unregister", { accelerator: "Ctrl+1" }), { removed: false });
  for (let i = 0; i < 64; i++) f.held.push(`Ctrl+F${i}`);
  assertEquals(await codeOf(call(cap, "register", { accelerator: "Ctrl+Z" })), "validation");
  assertEquals(await call(cap, "unregisterAll"), null);
  assertEquals(f.held, []);
  // A press event without an accelerator is ignored.
  const ctx = ctxOf();
  await call(cap, "take", {}, ctx);
  f.press(undefined as unknown as string);
  assertEquals(await call(cap, "take", {}, ctx), []);
  // A page load under the stock runtime (no shortcuts API) is a no-op.
  await shortcutsCapability({ api: {} }).onPageLoad!();
});

// --- the app controller: remaining edges -------------------------------------------------------

/** A tray that also has a dark-mode icon and fails to destroy (the OS already removed it). */
class DarkTray extends FakeTray {
  iconDark?: Uint8Array | null;
  override getBounds = undefined as unknown as FakeTray["getBounds"];
  setIconDark(png: Uint8Array | null) {
    this.iconDark = png;
  }
  override destroy() {
    throw new Error("already gone");
  }
}

Deno.test("app: tray argument checks, dark icons, destroyTray and the tray limit", async () => {
  const { cap } = appController();
  for (
    const args of [
      { icon: "%%%" },
      { icon: "x".repeat(1024 * 1024 + 1) },
      { icon: PNG, tooltip: 7 },
      { icon: PNG, tooltip: "t".repeat(257) },
    ]
  ) {
    assertEquals(await codeOf(call(cap, "createTray", args)), "validation");
  }
  const { id } = await call(cap, "createTray", { icon: PNG, tooltip: "" }) as { id: string };
  assertEquals(FakeTray.made.at(-1)!.tooltip, null, "an empty tooltip clears it");
  // A tray without setIconDark ignores the dark icon.
  await call(cap, "updateTray", { id, iconDark: PNG, icon: PNG });
  assertEquals(await codeOf(call(cap, "updateTray", { id: 1 })), "validation");
  assertEquals(await call(cap, "destroyTray", { id }), null);
  assert(FakeTray.made.at(-1)!.destroyed);
  for (let i = 0; i < 8; i++) await call(cap, "createTray", { icon: PNG });
  assertEquals(await codeOf(call(cap, "createTray", { icon: PNG })), "validation");
});

Deno.test("app: a dark-icon tray takes and clears its dark icon; a failing destroy does not stop a page load", async () => {
  const dock = new FakeDock();
  const ctl = createAppController({
    window: undefined,
    emit: () => {},
    Tray: DarkTray,
    dock,
    os: "darwin",
  });
  const cap = ctl.capability;
  const { id } = await call(cap, "createTray", { icon: PNG, iconDark: PNG }) as { id: string };
  const tray = FakeTray.made.at(-1) as DarkTray;
  assert(tray.iconDark && tray.iconDark.length > 0);
  await call(cap, "updateTray", { id, iconDark: null, menu: [{ id: "m", label: "M" }] });
  assertEquals(tray.iconDark, null);
  assertEquals(await call(cap, "trayBounds", { id }), null, "no bounds API → null");
  // A menu click with no id, or one the menu does not have, is not queued.
  tray.dispatchEvent(new CustomEvent("menuclick", { detail: null }));
  click(tray, "other");
  assertEquals(await call(cap, "take"), []);
  await cap.onPageLoad!();
  assertEquals(await codeOf(call(cap, "trayBounds", { id })), "validation", "trays were dropped");
});

Deno.test("app: no window, dock or api — capabilities fall back and dock calls are unsupported", async () => {
  const cap =
    createAppController({ window: undefined, emit: () => {}, Tray: FakeTray, os: "linux" })
      .capability;
  assertEquals(await call(cap, "capabilities"), {
    appMenu: false,
    accelerators: false,
    icons: false,
    tooltips: false,
    tray: true,
    trayReason: null,
    trayHost: "unknown",
    secretService: "unknown",
    sessionType: "unknown",
    cookieEncryption: "unknown",
    badge: false,
    badgeShows: "unknown",
    badgeReason: null,
    bounce: false,
    dockMenu: false,
  });
  assertEquals(await codeOf(call(cap, "setBadge", { text: "1" })), "unsupported");
  assertEquals(await codeOf(call(cap, "bounce", null)), "unsupported");
  assertEquals(await call(cap, "setDockMenu", { menu: [] }), { applied: false });
});

Deno.test("app: badge text is checked; an empty dock menu clears it; install is idempotent", async () => {
  const { ctl, cap, win, dock, emitted } = appController();
  assertEquals(await codeOf(call(cap, "setBadge", { text: 3 })), "validation");
  await call(cap, "setBadge", null);
  assertEquals(dock.badge, "", "no arguments clears the badge");
  await call(cap, "bounce", null);
  assertEquals(dock.bounces, [false]);
  await call(cap, "setDockMenu", { menu: [{ id: "a", label: "A" }] });
  assertEquals(await call(cap, "setDockMenu", { menu: [] }), { applied: true });
  assertEquals(dock.menu, null);
  click(dock, "a");
  dock.dispatchEvent(new CustomEvent("menuclick", { detail: {} }));
  assertEquals(await call(cap, "take"), [], "the cleared dock menu's ids are gone");
  // A second install adds no second listener: one click, one action.
  ctl.install();
  await call(cap, "setAppMenu", { menu: [{ id: "n", label: "N" }] });
  win.dispatchEvent(new CustomEvent("menuclick", { detail: undefined }));
  click(win, "n");
  assertEquals(await call(cap, "take"), [{ source: "menu", id: "n" }]);
  assertEquals(emitted, ["app:action"]);
});

Deno.test("app: the runtime's Deno.Tray and Deno.dock are used when none is injected", async () => {
  const dock = new FakeDock();
  await withDenoProps({ Tray: FakeTray, dock }, async () => {
    const cap = createAppController({ window: undefined, emit: () => {} }).capability;
    const caps = await call(cap, "capabilities") as Record<string, boolean>;
    assertEquals([caps.tray, caps.badge, caps.dockMenu], [true, true, Deno.build.os === "darwin"]);
    await call(cap, "setBadge", { text: "9" });
    assertEquals(dock.badge, "9");
  });
  // A non-object Deno.dock / non-constructor Deno.Tray is ignored.
  await withDenoProps({ Tray: "nope", dock: null }, async () => {
    const cap = createAppController({ window: undefined, emit: () => {} }).capability;
    const caps = await call(cap, "capabilities") as Record<string, boolean>;
    assertEquals([caps.tray, caps.badge], [false, false]);
  });
});

// --- the runtime's session probe (Deno.desktop.platformFeatures, runtime 2.9.7-denext.10) ------

/** What a Linux session with no tray host (stock GNOME) answers. */
const NO_TRAY_HOST = {
  os: "linux",
  sessionType: "wayland",
  desktopHint: "GNOME",
  sessionBus: true,
  trayHost: false,
  trayReason: "no StatusNotifierWatcher (GNOME needs the AppIndicator extension)",
  trayClicks: false,
  trayTooltip: true,
  secretService: "locked",
  secretServicePrompt: false,
  portalVersions: { FileChooser: 4 },
  cookieEncryption: "basic",
};

/** The `unsupported` error a call rejects with. */
async function unsupportedOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown; data?: Record<string, unknown> };
    return { code: e.code, message: String(e.message), data: e.data };
  }
  throw new Error("expected a rejection");
}

/** A window that records `show()`. */
function hiddenWindow(visible = false) {
  return Object.assign(new EventTarget(), {
    shown: 0,
    isVisible: () => visible,
    show() {
      this.shown++;
    },
  });
}

Deno.test("app: with the probe, a session with no tray host reports tray false with the runtime's reason", async () => {
  FakeTray.made = [];
  const cap = createAppController({
    window: undefined,
    api: { platformFeatures: () => Promise.resolve(NO_TRAY_HOST) },
    emit: () => {},
    Tray: FakeTray,
    os: "linux",
  }).capability;
  const caps = await call(cap, "capabilities") as Record<string, unknown>;
  assertEquals(
    [caps.tray, caps.trayReason, caps.trayHost],
    [false, NO_TRAY_HOST.trayReason, false],
  );
  assertEquals(
    [caps.secretService, caps.sessionType, caps.cookieEncryption],
    ["locked", "wayland", "basic"],
  );
  const err = await unsupportedOf(call(cap, "createTray", { icon: PNG }));
  assertEquals(err.code, "unsupported");
  assertEquals(err.data, { reason: NO_TRAY_HOST.trayReason, windowShown: false });
  assert(err.message.includes("AppIndicator"), err.message);
  assertEquals(FakeTray.made.length, 0, "no dead tray is created");
});

Deno.test("app: a tray-only app (window hidden) gets its window shown when no tray can be shown", async () => {
  const win = hiddenWindow(false);
  const cap = createAppController({
    window: win,
    api: { platformFeatures: () => Promise.resolve(NO_TRAY_HOST) },
    emit: () => {},
    Tray: FakeTray,
    os: "linux",
  }).capability;
  const err = await unsupportedOf(call(cap, "createTray", { icon: PNG }));
  assertEquals(err.data?.windowShown, true);
  assertEquals(win.shown, 1);
  // A visible window is left alone.
  const shown = hiddenWindow(true);
  const cap2 = createAppController({
    window: shown,
    api: { platformFeatures: () => Promise.resolve(NO_TRAY_HOST) },
    emit: () => {},
    Tray: FakeTray,
    os: "linux",
  }).capability;
  assertEquals(
    (await unsupportedOf(call(cap2, "createTray", { icon: PNG }))).data?.windowShown,
    false,
  );
  assertEquals(shown.shown, 0);
  // A window whose show() throws (closed) still yields the unsupported error.
  const broken = Object.assign(new EventTarget(), {
    isVisible: () => false,
    show: () => {
      throw new Error("gone");
    },
  });
  const cap3 = createAppController({
    window: broken,
    api: { platformFeatures: () => Promise.resolve(NO_TRAY_HOST) },
    emit: () => {},
    Tray: FakeTray,
    os: "linux",
  }).capability;
  assertEquals(
    (await unsupportedOf(call(cap3, "createTray", { icon: PNG }))).data?.windowShown,
    false,
  );
});

/** A `Deno.Tray` whose constructor throws like the runtime with no tray host. */
class NoHostTray extends FakeTray {
  constructor() {
    super();
    const err = new Error(
      "Tray icons are not available here: no StatusNotifierWatcher and no XEmbed tray",
    );
    err.name = "NotSupported";
    throw err;
  }
}

/** A `Deno.Tray` whose constructor fails some other way. */
class BrokenTray extends FakeTray {
  constructor() {
    super();
    throw new TypeError("boom");
  }
}

Deno.test("app: the runtime's NotSupported from new Deno.Tray() becomes unsupported with its reason", async () => {
  const win = hiddenWindow(false);
  const cap = createAppController({
    window: win,
    // A host that left after the probe answered, or a runtime that only throws.
    api: {
      platformFeatures: () =>
        Promise.resolve({ ...NO_TRAY_HOST, trayHost: true, trayReason: null }),
    },
    emit: () => {},
    Tray: NoHostTray,
    os: "linux",
  }).capability;
  const err = await unsupportedOf(call(cap, "createTray", { icon: PNG }));
  assertEquals(err.code, "unsupported");
  assertEquals(err.data, {
    reason: "no StatusNotifierWatcher and no XEmbed tray",
    windowShown: true,
  });
  // A NotSupported with no reason in it still has one.
  class Bare extends FakeTray {
    constructor() {
      super();
      const e = new Error("");
      e.name = "NotSupported";
      throw e;
    }
  }
  const bare = createAppController({ window: undefined, emit: () => {}, Tray: Bare, os: "linux" });
  assertEquals((await unsupportedOf(call(bare.capability, "createTray", { icon: PNG }))).data, {
    reason: "no tray host",
    windowShown: false,
  });
  // Any other failure is not dressed up as unsupported.
  const broken = createAppController({
    window: undefined,
    emit: () => {},
    Tray: BrokenTray,
    os: "linux",
  });
  await assertRejects(
    () => call(broken.capability, "createTray", { icon: PNG }) as Promise<unknown>,
    TypeError,
    "boom",
  );
  // The failed attempts used no tray id: the next tray is "1".
  const ok = createAppController({
    window: undefined,
    emit: () => {},
    Tray: FakeTray,
    os: "linux",
  });
  assertEquals(await call(ok.capability, "createTray", { icon: PNG }), { id: "1" });
});

Deno.test("app: without the probe (denext.9), a throwing or odd probe, every fact reads unknown", async () => {
  for (
    const platformFeatures of [
      undefined,
      () => Promise.resolve(null),
      () => Promise.resolve("linux"),
      () => Promise.reject(new Error("probe failed")),
      () => {
        throw new Error("probe failed before it started");
      },
      () =>
        Promise.resolve({
          trayHost: "yes",
          secretService: "maybe",
          sessionType: 7,
          cookieEncryption: "aes",
        }),
    ]
  ) {
    const cap = createAppController({
      window: undefined,
      api: platformFeatures ? { platformFeatures } : {},
      emit: () => {},
      Tray: FakeTray,
      os: "linux",
    }).capability;
    const caps = await call(cap, "capabilities") as Record<string, unknown>;
    assertEquals(
      [caps.tray, caps.trayReason, caps.trayHost, caps.secretService, caps.sessionType],
      [true, null, "unknown", "unknown", "unknown"],
    );
    assertEquals(caps.cookieEncryption, "unknown");
  }
  // macOS / the WebView backends: null session type and cookie store pass through as null.
  const mac = createAppController({
    window: undefined,
    api: {
      platformFeatures: () =>
        Promise.resolve({
          os: "macos",
          sessionType: null,
          trayHost: true,
          trayReason: "ignored when there is a host",
          secretService: "os",
          cookieEncryption: null,
        }),
    },
    emit: () => {},
    Tray: FakeTray,
    os: "darwin",
  }).capability;
  const caps = await call(mac, "capabilities") as Record<string, unknown>;
  assertEquals(
    [caps.tray, caps.trayReason, caps.trayHost, caps.secretService, caps.sessionType],
    [true, null, true, "os", null],
  );
  assertEquals(caps.cookieEncryption, null);
});

Deno.test("app: where the badge shows follows the probe (runtime 2.9.7-denext.11)", async () => {
  const capsWith = async (features: Record<string, unknown> | undefined) => {
    const cap = createAppController({
      window: undefined,
      api: features ? { platformFeatures: () => Promise.resolve(features) } : {},
      emit: () => {},
      Tray: FakeTray,
      os: "linux",
    }).capability;
    const caps = await call(cap, "capabilities") as Record<string, unknown>;
    return [caps.badgeShows, caps.badgeReason];
  };
  // A dock reads launcher badges (Ubuntu's dock, Plasma's task manager).
  assertEquals(
    await capsWith({ ...NO_TRAY_HOST, badge: "launcher-entry", badgeReason: null }),
    ["launcher-entry", null],
  );
  // None does: the title prefix, with the runtime's reason.
  assertEquals(
    await capsWith({ ...NO_TRAY_HOST, badge: "title", badgeReason: " no dock reads them " }),
    ["title", "no dock reads them"],
  );
  // A reason only travels with "title"; an odd value, or denext.10 (no key), reads unknown.
  assertEquals(await capsWith({ badge: "dock", badgeReason: "x" }), ["dock", null]);
  assertEquals(await capsWith({ badge: "tile" }), ["unknown", null]);
  assertEquals(await capsWith(NO_TRAY_HOST), ["unknown", null]);
  assertEquals(await capsWith(undefined), ["unknown", null]);
});

Deno.test("app: no Deno.Tray, Deno.dock or app menu — unsupported carries a reason", async () => {
  const cap = createAppController({ window: undefined, emit: () => {}, os: "linux" }).capability;
  if ((Deno as unknown as { Tray?: unknown }).Tray === undefined) {
    const tray = await unsupportedOf(call(cap, "createTray", { icon: PNG }));
    assertEquals(tray.data?.reason, "this Deno Desktop runtime has no API for it");
    const caps = await call(cap, "capabilities") as Record<string, unknown>;
    assertEquals([caps.tray, caps.trayReason], [
      false,
      "this Deno Desktop runtime has no API for it",
    ]);
  }
  assertEquals(
    (await unsupportedOf(call(cap, "setAppMenu", { menu: [] }))).data?.reason,
    "no app window",
  );
  const withWin = createAppController({ window: new EventTarget(), emit: () => {}, os: "linux" });
  assertEquals(
    (await unsupportedOf(call(withWin.capability, "setAppMenu", { menu: [] }))).data?.reason,
    "this Deno Desktop runtime has no BrowserWindow.setApplicationMenu",
  );
  assertEquals(
    (await unsupportedOf(call(cap, "setBadge", { text: "1" }))).data?.reason,
    "this Deno Desktop runtime has no Deno.dock",
  );
  const reason = (await unsupportedOf(call(cap, "bounce", {}))).data?.reason;
  assertEquals(reason, "this Deno Desktop runtime has no Deno.dock");
});

Deno.test("globalShortcuts: not_supported carries the runtime's message as the reason", async () => {
  const fail = (message: string) => {
    const err = Object.assign(new Error(message), { code: "not_supported" });
    return Promise.reject(err);
  };
  let message = "the GlobalShortcuts portal is not available";
  const cap = shortcutsCapability({
    api: {
      shortcuts: {
        register: () => fail(message),
        unregister: () => false,
        unregisterAll: () => {},
        list: () => [],
        canonicalize: (a: string) => a,
        capabilities: () => ({ globalShortcuts: false, userBinds: false }),
        addEventListener: () => {},
      } as unknown as DesktopAppApi["shortcuts"],
    },
  });
  const err = await unsupportedOf(call(cap, "register", { accelerator: "Ctrl+K" }));
  assertEquals([err.code, err.data?.reason], ["unsupported", message]);
  message = "";
  const bare = await unsupportedOf(call(cap, "register", { accelerator: "Ctrl+J" }));
  assertEquals(bare.data?.reason, "no global shortcuts in this session");
});

Deno.test("app: platformfeatureschanged asks the page to re-read the capabilities", async () => {
  const api = Object.assign(new EventTarget(), {
    platformFeatures: () => Promise.resolve({ ...NO_TRAY_HOST, trayHost: true, trayReason: null }),
  });
  const events: string[] = [];
  const ctl = createAppController({
    window: undefined,
    api,
    emit: (cap, event) => events.push(`${cap}:${event}`),
    Tray: FakeTray,
    os: "linux",
  });
  api.dispatchEvent(new Event("platformfeatureschanged"));
  assertEquals(events, [], "nothing before install");
  ctl.install();
  api.dispatchEvent(new Event("platformfeatureschanged"));
  assertEquals(events, ["app:capabilities"]);
  const caps = await call(ctl.capability, "capabilities") as Record<string, unknown>;
  assertEquals([caps.tray, caps.trayHost], [true, true]);
});
