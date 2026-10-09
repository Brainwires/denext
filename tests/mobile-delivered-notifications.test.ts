// denext/mobile's delivered notifications (deliveredNotifications / removeDeliveredNotifications)
// and scheduleNotification's `threadId`: in a faked iOS / Android shell (denext's DenextSettings
// plugin), on the web (the page's own notifications and a service worker's), and in a Deno Desktop
// window through the `notifications` capability.

import { assertEquals, assertRejects } from "@std/assert";
import {
  deliveredNotifications,
  removeDeliveredNotifications,
  scheduleNotification,
} from "../src/mobile/mod.ts";
import { resetDeliveredNotificationsForTesting } from "../src/mobile/delivered-notifications.ts";
import { resetLocalNotificationsForTesting } from "../src/mobile/local-notifications.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { type Any, fakePlugin, inShell, Target, withGlobals } from "./helpers/mobile-fakes.ts";
import { createFakeDesktopRuntime, type FakeMethod } from "./helpers/desktop-fake-runtime.ts";

const SETTINGS_METHODS = ["open", "deliveredNotifications", "removeDeliveredNotifications"];

/** A DenextSettings plugin reporting `delivered`. */
function settingsPlugin(delivered: unknown[]) {
  return fakePlugin(SETTINGS_METHODS, { deliveredNotifications: { notifications: delivered } });
}

/** What the plugin was asked to remove. */
function removed(calls: Array<[string, unknown]>): unknown {
  return (calls.find(([m]) => m === "removeDeliveredNotifications")?.[1] as Any)?.notifications;
}

const IOS_DELIVERED = [
  { id: "7", threadId: "chat-1", title: "Ann", data: { path: "/c/1" } },
  { id: "push-a", threadId: "chat-1", title: "Ann again" },
  { id: "push-b", threadId: "chat-2", title: "Bob", data: { k: 1 } },
  { id: "push-c", title: "System" },
];

// ---- iOS / Android ------------------------------------------------------------------------------

Deno.test("deliveredNotifications: lists the shell's notifications, local and pushed", async () => {
  const settings = settingsPlugin(IOS_DELIVERED);
  await inShell("ios", { DenextSettings: settings.plugin }, async () => {
    assertEquals(await deliveredNotifications(), IOS_DELIVERED);
  });
});

Deno.test("removeDeliveredNotifications: by thread, by ids, by both, and all (iOS)", async () => {
  const cases: Array<[Any, unknown]> = [
    [{ threadId: "chat-1" }, [{ id: "7" }, { id: "push-a" }]],
    [{ ids: [7, "push-c"] }, [{ id: "7" }, { id: "push-c" }]],
    [{ ids: ["7", "push-b"], threadId: "chat-1" }, [{ id: "7" }]],
    [{ all: true }, IOS_DELIVERED.map((n) => ({ id: n.id }))],
  ];
  for (const [selector, expected] of cases) {
    const settings = settingsPlugin(IOS_DELIVERED);
    await inShell("ios", { DenextSettings: settings.plugin }, async () => {
      await removeDeliveredNotifications(selector);
    });
    assertEquals(removed(settings.calls), expected, JSON.stringify(selector));
  }
  // Nothing matches: no native call at all.
  const settings = settingsPlugin(IOS_DELIVERED);
  await inShell("ios", { DenextSettings: settings.plugin }, async () => {
    await removeDeliveredNotifications({ threadId: "nope" });
  });
  assertEquals(removed(settings.calls), undefined);
});

Deno.test("removeDeliveredNotifications: an empty or malformed selector is a TypeError", async () => {
  const settings = settingsPlugin(IOS_DELIVERED);
  await inShell("ios", { DenextSettings: settings.plugin }, async () => {
    for (
      const selector of [
        undefined,
        null,
        {},
        { all: false },
        { all: true, threadId: "chat-1" },
        { ids: "7" },
        { threadId: 7 },
        { tag: {} },
      ]
    ) {
      await assertRejects(
        () => removeDeliveredNotifications(selector as Any),
        TypeError,
        undefined,
        JSON.stringify(selector),
      );
    }
  });
  assertEquals(removed(settings.calls), undefined, "nothing removed");
});

const ANDROID_DELIVERED = [
  { id: "7", threadId: "chat-1", title: "Ann" },
  { id: "8", threadId: "chat-1", title: "Ann again" },
  { id: "0", tag: "FCM-Notification:1", title: "Pushed" },
  { id: "9", threadId: "chat-2", title: "Bob" },
  { id: "100", threadId: "chat-1", summary: true },
  { id: "101", threadId: "chat-2", summary: true },
];

Deno.test("deliveredNotifications: Android group summaries are not listed", async () => {
  const settings = settingsPlugin(ANDROID_DELIVERED);
  await inShell("android", { DenextSettings: settings.plugin }, async () => {
    assertEquals((await deliveredNotifications()).map((n) => n.id), ["7", "8", "0", "9"]);
    assertEquals((await deliveredNotifications())[2].tag, "FCM-Notification:1");
  });
});

Deno.test("removeDeliveredNotifications: Android tags, and a summary goes with its emptied group", async () => {
  const cases: Array<[Any, unknown]> = [
    // The whole thread: its summary too, the other group's untouched.
    [{ threadId: "chat-1" }, [{ id: "7" }, { id: "8" }, { id: "100" }]],
    // One of two: the summary stays.
    [{ ids: [7] }, [{ id: "7" }]],
    // By tag (an FCM-drawn push), tag passed back for cancel(tag, id).
    [{ tag: "FCM-Notification:1" }, [{ id: "0", tag: "FCM-Notification:1" }]],
    [{ all: true }, ANDROID_DELIVERED.map((n) => n.tag ? { id: n.id, tag: n.tag } : { id: n.id })],
  ];
  for (const [selector, expected] of cases) {
    const settings = settingsPlugin(ANDROID_DELIVERED);
    await inShell("android", { DenextSettings: settings.plugin }, async () => {
      await removeDeliveredNotifications(selector);
    });
    assertEquals(removed(settings.calls), expected, JSON.stringify(selector));
  }
});

Deno.test("delivered notifications: a binary without DenextSettings generation 3 rejects", async () => {
  // Generation 2: `open` (and `sendIntent`) only.
  const old = fakePlugin(["open", "sendIntent"]);
  await inShell("android", { DenextSettings: old.plugin }, async () => {
    await assertRejects(() => deliveredNotifications(), Error, "mobile add local-notifications");
    await assertRejects(
      () => removeDeliveredNotifications({ all: true }),
      Error,
      "DenextSettings plugin, generation 3",
    );
  });
});

Deno.test("deliveredNotifications: malformed plugin answers list nothing", async () => {
  for (const answer of [undefined, {}, { notifications: "x" }, { notifications: [null, 3] }]) {
    const settings = fakePlugin(SETTINGS_METHODS, { deliveredNotifications: answer });
    await inShell("ios", { DenextSettings: settings.plugin }, async () => {
      assertEquals(await deliveredNotifications(), [], JSON.stringify(answer));
    });
  }
});

// ---- scheduleNotification's threadId --------------------------------------------------------

Deno.test("scheduleNotification: threadId is iOS's threadIdentifier and Android's group", async () => {
  const local = fakePlugin(["schedule", "getPending", "cancel", "registerActionTypes"]);
  await inShell("ios", { LocalNotifications: local.plugin }, async () => {
    await scheduleNotification({ id: 1, title: "T", body: "B", threadId: "chat-1" });
    // threadId wins over the older `group`.
    await scheduleNotification({ id: 2, title: "T", body: "B", threadId: "t", group: "g" });
    await scheduleNotification({ id: 3, title: "T", body: "B", group: "g" });
    await assertRejects(
      () => scheduleNotification({ title: "T", body: "B", threadId: 5 as Any }),
      TypeError,
      "threadId must be a string",
    );
  });
  const schemas = local.calls.map(([, a]) => (a as Any).notifications[0]);
  assertEquals(schemas.map((s) => [s.threadIdentifier, s.group]), [
    ["chat-1", "chat-1"],
    ["t", "t"],
    ["g", "g"],
  ]);
});

// ---- web ------------------------------------------------------------------------------------

/** A web Notification constructor (permission granted) whose instances close and fire `close`. */
function webNotifications() {
  const instances: Any[] = [];
  const Notification = Object.assign(
    function (this: Any, title: string, options: Any) {
      const n = Object.assign(new Target(), { title, ...options, closed: false });
      n.close = () => {
        n.closed = true;
        n.fire("close");
      };
      instances.push(n);
      return n;
    },
    { permission: "granted" },
  );
  return { Notification, instances };
}

Deno.test("delivered notifications (web): the page's own, until they close", async () => {
  resetDeliveredNotificationsForTesting();
  const { Notification, instances } = webNotifications();
  await withGlobals({ Notification }, async () => {
    await scheduleNotification({ id: 1, title: "A", body: "a", threadId: "chat-1" });
    await scheduleNotification({
      id: 2,
      title: "B",
      body: "b",
      threadId: "chat-2",
      data: { x: 1 },
    });
    await scheduleNotification({ id: 3, title: "C", body: "c", threadId: "chat-1" });
    assertEquals(instances[1].data, { x: 1 });
    assertEquals(await deliveredNotifications(), [
      { id: "1", threadId: "chat-1", title: "A" },
      { id: "2", threadId: "chat-2", title: "B", data: { x: 1 } },
      { id: "3", threadId: "chat-1", title: "C" },
    ]);
    await removeDeliveredNotifications({ threadId: "chat-1" });
    assertEquals(instances.map((n) => n.closed), [true, false, true]);
    // The user closes one: it is no longer listed.
    instances[1].close();
    assertEquals(await deliveredNotifications(), []);
  });
  resetDeliveredNotificationsForTesting();
});

Deno.test("delivered notifications (web): a service worker's, by tag and data.threadId", async () => {
  resetDeliveredNotificationsForTesting();
  const closed: string[] = [];
  const sw = (tag: string, data: unknown) => ({
    title: `t-${tag}`,
    tag,
    data,
    close: () => closed.push(tag),
  });
  const list = [sw("m1", { threadId: "chat-9" }), sw("m2", null), sw("", { threadId: "chat-9" })];
  const navigator = {
    serviceWorker: {
      getRegistration: () => Promise.resolve({ getNotifications: () => Promise.resolve(list) }),
    },
  };
  await withGlobals({ navigator }, async () => {
    assertEquals(await deliveredNotifications(), [
      { id: "m1", threadId: "chat-9", tag: "m1", title: "t-m1", data: { threadId: "chat-9" } },
      { id: "m2", tag: "m2", title: "t-m2" },
      { id: "", threadId: "chat-9", title: "t-", data: { threadId: "chat-9" } },
    ]);
    await removeDeliveredNotifications({ threadId: "chat-9" });
    assertEquals(closed, ["m1", ""]);
    await removeDeliveredNotifications({ tag: "m2" });
    assertEquals(closed, ["m1", "", "m2"]);
  });
  // A registration that throws, or none at all: nothing listed.
  const broken = { serviceWorker: { getRegistration: () => Promise.reject(new Error("no")) } };
  await withGlobals({ navigator: broken }, async () => {
    assertEquals(await deliveredNotifications(), []);
  });
  assertEquals(await deliveredNotifications(), []);
  await removeDeliveredNotifications({ all: true });
});

Deno.test("delivered notifications (web): the page remembers at most 200 of its own", async () => {
  resetDeliveredNotificationsForTesting();
  const { Notification } = webNotifications();
  await withGlobals({ Notification }, async () => {
    for (let id = 1; id <= 205; id++) await scheduleNotification({ id, title: "x", body: "" });
    const ids = (await deliveredNotifications()).map((n) => n.id);
    assertEquals(ids.length, 200);
    assertEquals(ids[0], "6");
  });
  resetDeliveredNotificationsForTesting();
});

// ---- Deno Desktop -----------------------------------------------------------------------------

/** Run `fn` in a fake desktop window with `caps` enabled. */
async function inDesktop(
  caps: Record<string, Record<string, FakeMethod>>,
  fn: (rt: ReturnType<typeof createFakeDesktopRuntime>) => Promise<void>,
): Promise<void> {
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  try {
    await fn(rt);
  } finally {
    resetDesktopBridgeForTesting();
    resetLocalNotificationsForTesting();
    restore();
  }
}

Deno.test("delivered notifications (desktop): through the notifications capability", async () => {
  await inDesktop({
    notifications: {
      schedule: () => ({ id: 5 }),
      delivered: () => [
        { id: "5", threadId: "chat-1", title: "A", data: { path: "/a" } },
        { id: "6", title: "B", data: {} },
        { id: "8", threadId: "chat-1", title: "C", data: {} },
      ],
      removeDelivered: () => null,
    },
  }, async (rt) => {
    await scheduleNotification({ id: 5, title: "A", body: "a", threadId: "chat-1" });
    assertEquals(rt.calls[0].args, { id: 5, title: "A", body: "a", threadId: "chat-1" });
    assertEquals(await deliveredNotifications(), [
      { id: "5", threadId: "chat-1", title: "A", data: { path: "/a" } },
      { id: "6", title: "B", data: {} },
      { id: "8", threadId: "chat-1", title: "C", data: {} },
    ]);
    await removeDeliveredNotifications({ threadId: "chat-1" });
    assertEquals(rt.calls.at(-1)!.method, "removeDelivered");
    assertEquals(rt.calls.at(-1)!.args, { ids: [5, 8] });
    const before = rt.calls.length;
    await removeDeliveredNotifications({ threadId: "nobody" });
    assertEquals(rt.calls.length, before + 1, "listed, nothing to remove");
  });
});

Deno.test("delivered notifications (desktop): without the capability, the web path", async () => {
  resetDeliveredNotificationsForTesting();
  await inDesktop({}, async () => {
    assertEquals(await deliveredNotifications(), []);
    await removeDeliveredNotifications({ all: true });
  });
});
