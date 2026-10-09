// denext/mobile's local notifications (schedule / cancel / pending / channels / categories /
// taps routed like push taps) and geolocation (getCurrentPosition / watchPosition /
// useLocation), each in a faked Capacitor shell and on its web path.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  cancelAllNotifications,
  cancelNotification,
  createNotificationChannel,
  deleteNotificationChannel,
  getCurrentPosition,
  listNotificationChannels,
  onLocalNotificationReceived,
  onLocalNotificationTapped,
  pendingNotifications,
  scheduleNotification,
  setNotificationCategories,
  useLocalNotificationTapped,
  useLocation,
  watchPosition,
} from "../src/mobile/mod.ts";
import {
  nextTriggerDate,
  resetLocalNotificationsForTesting,
} from "../src/mobile/local-notifications.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

const LOCAL_METHODS = [
  "schedule",
  "getPending",
  "cancel",
  "registerActionTypes",
  "createChannel",
  "deleteChannel",
  "listChannels",
];

/** The schema the plugin received for the one scheduled notification. */
function scheduled(calls: Array<[string, unknown]>): Any {
  const call = calls.find(([m]) => m === "schedule");
  return (call?.[1] as Any).notifications[0];
}

// ---- scheduleNotification -------------------------------------------------------------------

Deno.test("scheduleNotification: maps each trigger onto the plugin's schedule", async () => {
  const cases: Array<[Any, (s: Any) => void]> = [
    [undefined, (s) => assertEquals(s, undefined)],
    [{ type: "date", date: 4_102_444_800_000 }, (s) => {
      assertEquals(s.at.getTime(), 4_102_444_800_000);
    }],
    [{ type: "interval", seconds: 120, repeats: true }, (s) => {
      assertEquals(s.repeats, true);
      assert(Math.abs(s.at.getTime() - (Date.now() + 120_000)) < 5_000);
    }],
    [{ type: "daily", hour: 8, minute: 30 }, (s) => assertEquals(s.on, { hour: 8, minute: 30 })],
    [{ type: "weekly", weekday: 2, hour: 9, minute: 0 }, (s) => {
      assertEquals(s.on, { weekday: 2, hour: 9, minute: 0 });
    }],
    [{ type: "monthly", day: 1, hour: 7, minute: 5 }, (s) => {
      assertEquals(s.on, { day: 1, hour: 7, minute: 5 });
    }],
    [{ type: "yearly", month: 12, day: 25, hour: 7, minute: 0 }, (s) => {
      assertEquals(s.on, { month: 12, day: 25, hour: 7, minute: 0 });
    }],
    [{ type: "calendar", hour: 6, minute: 0 }, (s) => assertEquals(s.on, { hour: 6, minute: 0 })],
    [{ type: "calendar", hour: 6, minute: 0, repeats: false }, (s) => {
      assert(s.at instanceof Date && s.at.getHours() === 6 && s.at.getMinutes() === 0);
    }],
  ];
  for (const [trigger, check] of cases) {
    const local = fakePlugin(LOCAL_METHODS);
    await inShell("ios", { LocalNotifications: local.plugin }, async () => {
      const id = await scheduleNotification({
        id: 7,
        title: "T",
        body: "B",
        trigger,
        data: { path: "/x" },
        channelId: "reminders",
        categoryId: "message",
        group: "g",
        allowWhileIdle: trigger?.type === "date" ? undefined : undefined,
      });
      assertEquals(id, 7);
      const schema = scheduled(local.calls);
      assertEquals(schema.extra, { path: "/x" });
      assertEquals(schema.channelId, "reminders");
      assertEquals(schema.actionTypeId, "message");
      assertEquals(schema.threadIdentifier, "g");
      check(schema.schedule);
    });
  }
});

Deno.test("scheduleNotification: silent drops the sound on iOS and sets the plugin's silent flag", async () => {
  for (const platform of ["ios", "android"] as const) {
    const local = fakePlugin(LOCAL_METHODS);
    await inShell(platform, { LocalNotifications: local.plugin }, async () => {
      await scheduleNotification({ id: 1, title: "T", body: "B", sound: "ding.wav", silent: true });
      const schema = scheduled(local.calls);
      assertEquals(schema.silent, true);
      assertEquals(schema.sound, null);
    });
  }
  const local = fakePlugin(LOCAL_METHODS);
  await inShell("ios", { LocalNotifications: local.plugin }, async () => {
    await scheduleNotification({ id: 2, title: "T", body: "B", sound: "ding.wav" });
    const schema = scheduled(local.calls);
    assertEquals(schema.sound, "ding.wav");
    assertEquals("silent" in schema, false);
  });
});

Deno.test("scheduleNotification: validation, random ids, allowWhileIdle", async () => {
  const local = fakePlugin(LOCAL_METHODS);
  await inShell("android", { LocalNotifications: local.plugin }, async () => {
    const id = await scheduleNotification({
      title: "a",
      body: "b",
      trigger: { type: "daily", hour: 1, minute: 2 },
      allowWhileIdle: true,
    });
    assert(Number.isInteger(id) && id > 0 && id <= 0x7fffffff);
    assertEquals(scheduled(local.calls).schedule.allowWhileIdle, true);
    await assertRejects(
      () => scheduleNotification({ title: "a" } as Any),
      TypeError,
      "title and body",
    );
    await assertRejects(
      () =>
        scheduleNotification({
          title: "a",
          body: "b",
          trigger: { type: "daily", hour: 24, minute: 0 },
        }),
      RangeError,
      "hour",
    );
    await assertRejects(
      () =>
        scheduleNotification({
          title: "a",
          body: "b",
          trigger: { type: "interval", seconds: 30, repeats: true },
        }),
      RangeError,
      "at least 60",
    );
    await assertRejects(
      () => scheduleNotification({ title: "a", body: "b", trigger: { type: "nope" } as Any }),
      TypeError,
      "unknown trigger",
    );
    await assertRejects(
      () =>
        scheduleNotification({
          title: "a",
          body: "b",
          trigger: { type: "calendar", month: 2, day: 31, repeats: false },
        }),
      RangeError,
      "never matches",
    );
  });
});

Deno.test("scheduleNotification: web shows a notification for now, rejects a later one", async () => {
  const shown: unknown[][] = [];
  const Notification = Object.assign(function (this: unknown, ...args: unknown[]) {
    shown.push(args);
  }, { permission: "granted" });
  await withGlobals({ Notification }, async () => {
    await scheduleNotification({ title: "Hi", body: "there" });
    await assertRejects(
      () =>
        scheduleNotification({ title: "a", body: "b", trigger: { type: "interval", seconds: 5 } }),
      Error,
      "mobile add local-notifications",
    );
  });
  assertEquals(shown, [["Hi", { body: "there" }]]);
  await assertRejects(
    () => scheduleNotification({ title: "a", body: "b" }),
    Error,
    "local-notifications",
  );
});

Deno.test("scheduleNotification: web passes silent to the Notification", async () => {
  const shown: unknown[][] = [];
  const Notification = Object.assign(function (this: unknown, ...args: unknown[]) {
    shown.push(args);
  }, { permission: "granted" });
  await withGlobals({ Notification }, async () => {
    await scheduleNotification({ title: "Hi", body: "there", silent: true });
    await scheduleNotification({ title: "Hi", body: "there", silent: false });
  });
  assertEquals(shown, [["Hi", { body: "there", silent: true }], ["Hi", { body: "there" }]]);
});

Deno.test("nextTriggerDate: computes the next local match", () => {
  const from = new Date(2030, 0, 15, 10, 0, 0).getTime(); // a Tuesday
  assertEquals(
    nextTriggerDate({ type: "daily", hour: 9, minute: 0 }, from),
    new Date(2030, 0, 16, 9),
  );
  assertEquals(
    nextTriggerDate({ type: "daily", hour: 11, minute: 0 }, from),
    new Date(2030, 0, 15, 11),
  );
  assertEquals(
    nextTriggerDate({ type: "weekly", weekday: 1, hour: 8, minute: 0 }, from),
    new Date(2030, 0, 20, 8),
    "next Sunday",
  );
  assertEquals(
    nextTriggerDate({ type: "yearly", month: 2, day: 29, hour: 0, minute: 0 }, from),
    new Date(2032, 1, 29),
    "the next leap day",
  );
  assertEquals(nextTriggerDate({ type: "date", date: from - 1 }, from), null);
  assertEquals(nextTriggerDate({ type: "interval", seconds: 60 }, from), new Date(from + 60_000));
  assertEquals(nextTriggerDate({ type: "calendar", month: 2, day: 30 }, from), null);
  assertThrows(() => nextTriggerDate({ type: "bad" } as Any, from), TypeError);
});

// ---- cancel / pending / channels / categories ------------------------------------------------

Deno.test("local notifications: cancel, pending, channels (Android only), categories", async () => {
  const local = fakePlugin(LOCAL_METHODS, {
    getPending: { notifications: [{ id: 3, title: "a", body: "b", extra: { k: 1 } }, { id: 4 }] },
    listChannels: { channels: [{ id: "c", name: "C", importance: 4 }] },
  });
  await inShell("android", { LocalNotifications: local.plugin }, async () => {
    assertEquals(await pendingNotifications(), [
      { id: 3, title: "a", body: "b", data: { k: 1 } },
      { id: 4, title: "", body: "", data: {} },
    ]);
    await cancelNotification(3);
    await cancelNotification([]);
    await cancelAllNotifications();
    await createNotificationChannel({ id: "c", name: "C" });
    assertEquals(await listNotificationChannels(), [{ id: "c", name: "C", importance: 4 }]);
    await deleteNotificationChannel("c");
    await setNotificationCategories([{
      id: "message",
      actions: [
        { id: "reply", title: "Reply", input: { buttonTitle: "Send", placeholder: "…" } },
        { id: "del", title: "Delete", destructive: true, foreground: false },
      ],
      hiddenPreviewsPlaceholder: "Message",
    }]);
    await assertRejects(() => createNotificationChannel({ id: 1 } as Any), TypeError);
  });
  const byMethod = (m: string) => local.calls.filter(([name]) => name === m).map(([, a]) => a);
  assertEquals(byMethod("cancel"), [
    { notifications: [{ id: 3 }] },
    { notifications: [{ id: 3 }, { id: 4 }] },
  ]);
  assertEquals(byMethod("createChannel"), [{ importance: 3, id: "c", name: "C" }]);
  assertEquals(byMethod("deleteChannel"), [{ id: "c" }]);
  assertEquals(byMethod("registerActionTypes"), [{
    types: [{
      id: "message",
      actions: [
        {
          id: "reply",
          title: "Reply",
          foreground: false,
          destructive: false,
          requiresAuthentication: false,
          input: true,
          inputButtonTitle: "Send",
          inputPlaceholder: "…",
        },
        {
          id: "del",
          title: "Delete",
          foreground: false,
          destructive: true,
          requiresAuthentication: false,
        },
      ],
      iosHiddenPreviewsBodyPlaceholder: "Message",
    }],
  }]);

  const ios = fakePlugin(LOCAL_METHODS);
  await inShell("ios", { LocalNotifications: ios.plugin }, async () => {
    await createNotificationChannel({ id: "c", name: "C" });
    assertEquals(await listNotificationChannels(), []);
  });
  assertEquals(ios.calls, [], "iOS has no channels");
  assertEquals(await pendingNotifications(), [], "the web has nothing pending");
  await cancelNotification(1);
});

// ---- received / tapped -------------------------------------------------------------------------

Deno.test("local notification taps route like push taps; received fans out", async () => {
  resetLocalNotificationsForTesting();
  const local = fakePlugin([...LOCAL_METHODS, "addListener"]);
  const pushed: string[] = [];
  const history = { pushState: (_d: unknown, _u: string, url: string) => pushed.push(url) };
  const taps: Any[] = [];
  const received: Any[] = [];
  await inShell("ios", { LocalNotifications: local.plugin }, async () => {
    const stopA = onLocalNotificationTapped((tap) => taps.push(tap));
    const stopB = onLocalNotificationTapped(() => taps.push("second"));
    const stopR = onLocalNotificationReceived((n) => received.push(n));
    await settle();
    local.fire("localNotificationActionPerformed", {
      actionId: "reply",
      inputValue: "hi",
      notification: { id: 9, title: "T", extra: { path: "/threads/9" } },
    });
    local.fire("localNotificationReceived", { id: 2, body: "b", extra: { a: 1 } });
    stopA();
    stopB();
    stopR();
    await settle();
    assertEquals(local.listening(), 0);
  }, { history });
  assertEquals(taps, [{
    notification: { id: 9, title: "T", body: undefined, data: { path: "/threads/9" } },
    actionId: "reply",
    inputValue: "hi",
  }, "second"]);
  assertEquals(pushed, ["/threads/9"], "navigated once for two subscribers");
  assertEquals(received, [{ id: 2, title: undefined, body: "b", data: { a: 1 } }]);
  assertEquals(onLocalNotificationTapped(() => {})(), undefined, "a no-op off the shell");
});

Deno.test("useLocalNotificationTapped: subscribes while mounted, custom route", async () => {
  resetLocalNotificationsForTesting();
  const local = fakePlugin([...LOCAL_METHODS, "addListener"]);
  const routed: string[] = [];
  await inShell("android", { LocalNotifications: local.plugin }, async () => {
    const { root } = mount(function Probe() {
      useLocalNotificationTapped(() => {}, { route: (path) => routed.push(path) });
      return null;
    });
    await settle();
    local.fire("localNotificationActionPerformed", {
      actionId: "tap",
      notification: { id: 1, extra: { url: "myapp://orders/1" } },
    });
    root.unmount();
    await settle();
    assertEquals(local.listening(), 0);
  });
  assertEquals(routed, ["/orders/1"]);
});

// ---- geolocation ----------------------------------------------------------------------------------

const FIX = {
  timestamp: 1000,
  coords: {
    latitude: 52.5,
    longitude: 13.4,
    accuracy: 12,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
};
const POSITION = {
  latitude: 52.5,
  longitude: 13.4,
  accuracy: 12,
  altitude: null,
  altitudeAccuracy: null,
  heading: null,
  speed: null,
  timestamp: 1000,
};

Deno.test("getCurrentPosition: native options and errors; the web's navigator.geolocation", async () => {
  const geo = fakePlugin(["getCurrentPosition", "watchPosition", "clearWatch"], {
    getCurrentPosition: FIX,
  });
  await inShell("ios", { Geolocation: geo.plugin }, async () => {
    assertEquals(await getCurrentPosition({ accuracy: "balanced", timeoutMs: 5000 }), POSITION);
  });
  assertEquals(geo.calls, [[
    "getCurrentPosition",
    { enableHighAccuracy: false, timeout: 5000, maximumAge: 0 },
  ]]);
  for (
    const [code, want] of [["OS-PLUG-GLOC-0003", "denied"], ["OS-PLUG-GLOC-0010", "timeout"], [
      "X",
      "unavailable",
    ]]
  ) {
    const failing = fakePlugin(["getCurrentPosition", "watchPosition", "clearWatch"], {
      getCurrentPosition: Object.assign(new Error("fail"), { code }),
    });
    await inShell("android", { Geolocation: failing.plugin }, async () => {
      const err = await assertRejects(() => getCurrentPosition(), Error, "fail");
      assertEquals((err as Any).code, want);
    });
  }
  const navigator = {
    geolocation: {
      getCurrentPosition: (ok: (p: unknown) => void, _fail: unknown, opts: Any) => {
        assertEquals(opts, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
        ok(FIX);
      },
    },
  };
  await withGlobals({ navigator }, async () => {
    assertEquals(await getCurrentPosition({ maximumAgeMs: 60_000 }), POSITION);
  });
  await withGlobals({
    navigator: {
      geolocation: {
        getCurrentPosition: (_ok: unknown, fail: Any) => fail({ code: 1, message: "no" }),
      },
    },
  }, async () => {
    const err = await assertRejects(() => getCurrentPosition(), Error, "no");
    assertEquals((err as Any).code, "denied");
  });
  await withGlobals({ navigator: {} }, async () => {
    const err = await assertRejects(() => getCurrentPosition(), Error, "no location source");
    assertEquals((err as Any).code, "unsupported");
  });
});

Deno.test("watchPosition: native callback id, clearWatch on stop (also before the id arrives)", async () => {
  let callback: Any;
  const geo = fakePlugin(["getCurrentPosition", "watchPosition", "clearWatch"]);
  geo.plugin.watchPosition = (opts: unknown, cb: unknown) => {
    geo.calls.push(["watchPosition", opts]);
    callback = cb;
    return Promise.resolve("w1");
  };
  const fixes: Any[] = [];
  const errors: Any[] = [];
  await inShell("android", { Geolocation: geo.plugin }, async () => {
    const stop = watchPosition(
      (p) => fixes.push(p),
      { minimumIntervalMs: 500 },
      (e) => errors.push(e),
    );
    await settle();
    callback(FIX);
    callback(null, Object.assign(new Error("off"), { code: "OS-PLUG-GLOC-0007" }));
    stop();
    stop();
    callback(FIX);
    const early = watchPosition(() => {});
    early();
    await settle();
  });
  assertEquals(fixes, [POSITION]);
  assertEquals(errors.map((e) => e.code), ["unavailable"]);
  assertEquals(geo.calls, [
    ["watchPosition", {
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: 0,
      minimumUpdateInterval: 500,
    }],
    ["clearWatch", { id: "w1" }],
    ["watchPosition", { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }],
    ["clearWatch", { id: "w1" }],
  ]);
});

Deno.test("watchPosition / useLocation: the web path", async () => {
  let ok: Any;
  let fail: Any;
  const cleared: number[] = [];
  const navigator = {
    geolocation: {
      getCurrentPosition: () => {},
      watchPosition: (a: unknown, b: unknown) => {
        ok = a;
        fail = b;
        return 5;
      },
      clearWatch: (id: number) => cleared.push(id),
    },
  };
  await withGlobals({ navigator }, async () => {
    let state: Any;
    const { root, rerender } = mount(function Probe() {
      state = useLocation({ accuracy: "balanced" });
      return null;
    });
    await settle();
    ok(FIX);
    rerender();
    assertEquals(state.position, POSITION);
    fail({ code: 3, message: "slow" });
    rerender();
    assertEquals(state.error.code, "timeout");
    assertEquals(state.position, POSITION, "the last fix stays");
    root.unmount();
  });
  assertEquals(cleared, [5]);
  const errors: Any[] = [];
  await withGlobals({ navigator: {} }, async () => {
    watchPosition(() => {}, {}, (e) => errors.push(e.code))();
    await settle();
  });
  assertEquals(errors, ["unsupported"]);
});
