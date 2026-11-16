// The backend's notifications (`host.notify` for an extension, `DesktopRuntime.notify` for
// desktop.ts): posted through the `notifications` capability's own path (the runtime's
// `Deno.desktop.notifications`, or the Deno `Notification` where it cannot schedule), their clicks
// reaching the backend's `onNotificationClick` hooks and never a page's taps; `not_enabled`
// without the capability, `unsupported` without the runtime's notifications, `validation` for bad
// options.

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import { createNotificationClickHooks } from "../src/desktop/notification-clicks.ts";
import { notificationsCapability } from "../src/desktop/caps/notifications.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import {
  type DesktopCapCtx,
  DesktopCapError,
  type DesktopExtensionHost,
} from "../src/desktop/extension.ts";

/** A fake `Deno.desktop` whose notifications record what is scheduled and cancelled. */
function fakeDesktop(caps: Record<string, boolean> = {}) {
  const target = new EventTarget();
  const scheduled: Record<string, unknown>[] = [];
  const cancelled: string[] = [];
  const api = {
    notifications: {
      capabilities: () => caps,
      schedule: (o: Record<string, unknown>) => {
        scheduled.push(o);
        return Promise.resolve(String(o.tag));
      },
      getScheduled: () => Promise.resolve([]),
      cancel: (tag: string) => void cancelled.push(tag),
      requestPermission: () => Promise.resolve("granted"),
    },
    addEventListener: (type: string, l: (e: Event) => void) => target.addEventListener(type, l),
  } as unknown as DesktopAppApi;
  const click = (detail: unknown) =>
    target.dispatchEvent(new CustomEvent("notificationresponse", { detail }));
  return { api, click, scheduled, cancelled };
}

/** The host an extension gets, over `capabilities`. */
function hostOver(capabilities: Parameters<typeof createDesktopBridge>[0]): DesktopExtensionHost {
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([...capabilities, {
    name: "ext",
    methods: {},
    setup: (h) => void (host = h),
  }]);
  return host!;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("host.notify: posts through the notifications capability; the click reaches the backend only", async () => {
  const f = fakeDesktop();
  const cap = notificationsCapability({ api: f.api, autoTopUp: false, now: () => 1000 });
  const host = hostOver([cap]);
  const clicks: unknown[] = [];
  createNotificationClickHooks(f.api, () => {}).add((c) => void clicks.push(c));
  const posted = await host.notify({
    title: "Build finished",
    body: "3 warnings",
    tag: "build-42",
    data: { job: 42 },
    actions: [{ id: "open", title: "Open log" }],
    silent: true,
  });
  assertEquals(posted.tag, "build-42");
  assertEquals(f.scheduled, [{
    title: "Build finished",
    body: "3 warnings",
    at: 1000,
    tag: "build-42",
    actions: [{ action: "open", title: "Open log" }],
    data: { job: 42 },
    silent: true,
  }]);
  // Re-posting a tag replaces it, like a web Notification's tag.
  assertEquals(f.cancelled, ["build-42"]);
  f.click({ tag: "build-42", action: "open", data: { job: 42 } });
  await tick();
  assertEquals(clicks, [{ tag: "build-42", action: "open", data: { job: 42 }, launch: false }]);
  // The page never takes it as one of its own taps.
  const ctx = { emit: () => {} } as unknown as DesktopCapCtx;
  assertEquals(await cap.methods.take.handler({}, ctx), []);
  posted.close();
  assertEquals(f.cancelled, ["build-42", "build-42"]);
});

Deno.test("host.notify: a tag of its own when none is given; title only is enough", async () => {
  const f = fakeDesktop();
  const host = hostOver([notificationsCapability({ api: f.api, autoTopUp: false })]);
  const a = await host.notify({ title: "One" });
  const b = await host.notify({ title: "Two" });
  assertMatch(a.tag, /^app-[0-9a-f-]{36}$/);
  assert(a.tag !== b.tag);
  assertEquals(f.scheduled[0].body, "");
  assertEquals(f.scheduled[0].actions, []);
  assert(!("data" in f.scheduled[0]) && !("silent" in f.scheduled[0]));
});

Deno.test("host.notify: not_enabled without the notifications capability", async () => {
  const host = hostOver([]);
  const err = await assertRejects(() => host.notify({ title: "x" }), DesktopCapError);
  assertEquals(err.code, "not_enabled");
});

Deno.test("host.notify: unsupported where the runtime has no native notifications", async () => {
  const api = { addEventListener: () => {} } as unknown as DesktopAppApi;
  const host = hostOver([notificationsCapability({ api, autoTopUp: false })]);
  const err = await assertRejects(() => host.notify({ title: "x" }), DesktopCapError);
  assertEquals(err.code, "unsupported");
});

Deno.test("host.notify: validation", async () => {
  const f = fakeDesktop();
  const host = hostOver([notificationsCapability({ api: f.api, autoTopUp: false })]);
  const bad = [
    {},
    { title: 3 },
    { title: "x", tag: "" },
    // denext's own notifications' tags (the pages' and their web Notifications').
    { title: "x", tag: "denext-1" },
    { title: "x", tag: "t".repeat(257) },
    { title: "x", data: { denext: { id: 1 } } },
    { title: "x", data: { blob: "x".repeat(5000) } },
    { title: "x", data: { f: () => {} } },
    { title: "x", actions: [{ id: "", title: "Open" }] },
    { title: "x", actions: "open" },
  ];
  for (const options of bad) {
    const err = await assertRejects(
      () => host.notify(options as unknown as Parameters<DesktopExtensionHost["notify"]>[0]),
      DesktopCapError,
    );
    assertEquals(err.code, "validation", JSON.stringify(options));
  }
  assertEquals(f.scheduled, []);
});

Deno.test("host.notify: where the runtime cannot schedule, the Deno Notification shows it and its click reaches the backend", async () => {
  const f = fakeDesktop({ schedule: false });
  const shown: { title: string; options: Record<string, unknown>; target: EventTarget }[] = [];
  let closed = 0;
  class FakeNotification extends EventTarget {
    constructor(title: string, options: Record<string, unknown>) {
      super();
      shown.push({ title, options, target: this });
    }
    close() {
      closed++;
    }
  }
  const host = hostOver([notificationsCapability({
    api: f.api,
    autoTopUp: false,
    showNow: FakeNotification as never,
  })]);
  const clicks: unknown[] = [];
  createNotificationClickHooks(f.api, () => {}).add((c) => void clicks.push(c));
  const posted = await host.notify({ title: "Now", tag: "now-1", data: { n: 1 } });
  assertEquals(f.scheduled, []);
  assertEquals(shown.map((s) => [s.title, s.options.tag, s.options.data]), [
    ["Now", "now-1", { n: 1 }],
  ]);
  shown[0].target.dispatchEvent(new Event("click"));
  await tick();
  assertEquals(clicks, [{ tag: "now-1", action: null, data: { n: 1 }, launch: false }]);
  posted.close();
  assertEquals(closed, 1);
});
