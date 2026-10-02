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

/** A handler context recording what the capability emits. */
function ctxOf(window?: unknown): DesktopCapCtx & { emitted: Array<[string, unknown]> } {
  const emitted: Array<[string, unknown]> = [];
  return {
    emit: (event, data) => void emitted.push([event, data]),
    appSupportDir: "/tmp/app",
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
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(f.scheduled.length, REPEAT_HORIZON);
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
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(f.scheduled.length, REPEAT_HORIZON);
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
  assertEquals(await call(cap, "permission", { request: true }), { state: "granted" });
  // Plain Deno has no notification permission: the query falls back to "prompt".
  assertEquals(await call(cap, "permission", {}), { state: "prompt" });
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
