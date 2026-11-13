// The shared notification-click dispatcher (src/desktop/notification-clicks.ts): one read of
// `Deno.desktop.launchNotificationResponses` and one `"notificationresponse"` listener per
// `Deno.desktop`, fanned out to the `notifications` capability (the pages) and the backend's hooks
// (`runDesktop({ onNotificationClick })`, `DesktopRuntime.onNotificationClick`,
// `host.onNotificationClick`): every hook hears every click, any tag, the launch click included
// however late it subscribes; the pages' taps are unchanged; no `Deno.desktop`, no clicks.

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { DesktopAppApi, DesktopNotificationResponse } from "../src/desktop/launch-events.ts";
import {
  createNotificationClickHooks,
  type DesktopNotificationClick,
  subscribeNotificationResponses,
} from "../src/desktop/notification-clicks.ts";
import { notificationsCapability } from "../src/desktop/caps/notifications.ts";
import type { DesktopCapCtx } from "../src/desktop/extension.ts";

/** A fake `Deno.desktop`: the launch list (counting its reads) and a real event target. */
function fakeDesktop(launched?: DesktopNotificationResponse[]) {
  const target = new EventTarget();
  let reads = 0;
  let listeners = 0;
  const api = {
    notifications: {
      capabilities: () => ({}),
      schedule: () => Promise.resolve(""),
      getScheduled: () => Promise.resolve([]),
    },
    get launchNotificationResponses() {
      reads++;
      // Taken on first read, as the runtime does.
      const out = launched;
      launched = undefined;
      return out;
    },
    addEventListener: (type: string, l: (e: Event) => void) => {
      if (type === "notificationresponse") listeners++;
      target.addEventListener(type, l);
    },
  } as unknown as DesktopAppApi;
  const click = (detail: unknown) =>
    target.dispatchEvent(new CustomEvent("notificationresponse", { detail }));
  return { api, click, reads: () => reads, listeners: () => listeners };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const LAUNCH: DesktopNotificationResponse = {
  tag: "reminder-1",
  action: null,
  data: { id: 1 },
  launch: true,
};

Deno.test("notification clicks: every backend hook hears every click, the launch click included", async () => {
  const f = fakeDesktop([LAUNCH]);
  const warnings: string[] = [];
  const hooks = createNotificationClickHooks(f.api, (m) => void warnings.push(m));
  const first: DesktopNotificationClick[] = [];
  const offFirst = hooks.add((c) => void first.push(c));
  // Delivered on a microtask, not inside add().
  assertEquals(first, []);
  await tick();
  const launch = { tag: "reminder-1", action: null, data: { id: 1 }, launch: true };
  assertEquals(first, [launch]);
  // A hook added later (after runDesktop resolved) still hears the launch click, once.
  const late: DesktopNotificationClick[] = [];
  hooks.add((c) => void late.push(c));
  await tick();
  assertEquals(late, [launch]);
  // A live click on a notification the backend posted itself: any tag, an action button.
  f.click({ tag: "backend-sync", action: "retry", data: null });
  f.click({ tag: "plain", action: "", data: undefined });
  const live = [
    { tag: "backend-sync", action: "retry", data: null, launch: false },
    { tag: "plain", action: null, data: null, launch: false },
  ];
  assertEquals(first.slice(1), live);
  assertEquals(late.slice(1), live);
  // Malformed responses (no string tag) are dropped.
  f.click(undefined);
  f.click({ tag: 5 });
  assertEquals(first.length, 3);
  // Unsubscribed: no more.
  offFirst();
  f.click({ tag: "after", action: null });
  assertEquals([first.length, late.length], [3, 4]);
  // One read of the launch list, one listener, however many hooks.
  assertEquals([f.reads(), f.listeners()], [1, 1]);
  assertEquals(warnings, []);
});

Deno.test("notification clicks: an unsubscribe before the microtask skips the launch replay", async () => {
  const f = fakeDesktop([LAUNCH]);
  const hooks = createNotificationClickHooks(f.api, () => {});
  const heard: unknown[] = [];
  hooks.add((c) => void heard.push(c))();
  await tick();
  assertEquals(heard, []);
});

Deno.test("notification clicks: a throwing or rejecting hook is logged; the others still hear it", async () => {
  const f = fakeDesktop();
  const warnings: string[] = [];
  const hooks = createNotificationClickHooks(f.api, (m) => void warnings.push(m));
  const heard: string[] = [];
  hooks.add(() => {
    throw new Error("boom");
  });
  hooks.add(() => Promise.reject("nope"));
  hooks.add((c) => void heard.push(c.tag));
  f.click({ tag: "t", action: null });
  await tick();
  assertEquals(heard, ["t"]);
  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings[0], "boom");
  assertStringIncludes(warnings[1], "nope");
});

Deno.test("notification clicks: without Deno.desktop a hook never fires; without events only the launch list", async () => {
  const none = createNotificationClickHooks(undefined, () => {});
  const heard: unknown[] = [];
  none.add((c) => void heard.push(c))();
  subscribeNotificationResponses(undefined, "page", () => heard.push("page"))();
  await tick();
  assertEquals(heard, []);
  // A runtime with the launch list but no event target.
  const quiet = { launchNotificationResponses: [LAUNCH] } as DesktopAppApi;
  createNotificationClickHooks(quiet, () => {}).add((c) => void heard.push(c.tag));
  await tick();
  assertEquals(heard, ["reminder-1"]);
});

/** A capability context recording what it emits. */
const ctxOf = () => {
  const emitted: unknown[] = [];
  const ctx = {
    emit: (event: string, data: unknown) => void emitted.push([event, data]),
  } as unknown as DesktopCapCtx;
  return { ctx, emitted };
};

Deno.test("notification clicks: the pages and the backend share the clicks; neither takes the other's", async () => {
  const appClick = {
    tag: "denext-9",
    action: null,
    data: { denext: { id: 9 }, data: { path: "/c" } },
    launch: true,
  };
  const f = fakeDesktop([appClick]);
  // The backend subscribes first (runDesktop), so it reads the launch list.
  const backend: DesktopNotificationClick[] = [];
  createNotificationClickHooks(f.api, () => {}).add((c) => void backend.push(c));
  // A click while only the backend listens: the capability (installed later) still gets it, as
  // the runtime would have kept it for the first listener.
  f.click({ tag: "denext-9-5", action: "open", data: { denext: { id: 9 }, data: {} } });
  const cap = notificationsCapability({ api: f.api, autoTopUp: false });
  const { ctx } = ctxOf();
  const take = () => cap.methods.take.handler({}, ctx);
  assertEquals(await take(), [
    { id: 9, actionId: "tap", data: { path: "/c" }, launch: true },
    { id: 9, actionId: "open", data: {}, launch: true },
  ]);
  // A live click reaches both.
  f.click({ tag: "denext-9-6", action: null, data: { denext: { id: 9 }, data: { n: 2 } } });
  assertEquals(await take(), [{ id: 9, actionId: "tap", data: { n: 2 }, launch: false }]);
  await tick();
  assertEquals(backend.map((c) => [c.tag, c.action, c.launch]), [
    ["denext-9", null, true],
    ["denext-9-5", "open", false],
    ["denext-9-6", null, false],
  ]);
  // The backend sees denext's own wrapping of the data (it posted nothing; the page did).
  assertEquals(backend[0].data, appClick.data);
  assertEquals(f.reads(), 1);
});
