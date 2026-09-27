// React Native mode's community-package stand-ins over denext/mobile's device capabilities:
// react-native-bootsplash, @notifee/react-native, @react-native-community/netinfo and
// react-native-device-info. Each runs in a faked Capacitor shell and on the web.

import { assert, assertEquals } from "@std/assert";
import BootSplash, { resetBootSplashForTesting } from "../src/react-native-compat/bootsplash.ts";
import notifee, {
  AndroidImportance,
  AuthorizationStatus,
  type Event,
  EventType,
  RepeatFrequency,
  resetNotifeeForTesting,
  TimeUnit,
  TriggerType,
} from "../src/react-native-compat/notifee.ts";
import NetInfo, { NetInfoStateType } from "../src/react-native-compat/netinfo.ts";
import DeviceInfo, {
  isLowBatteryLevel,
  resetDeviceInfoForTesting,
} from "../src/react-native-compat/device-info.ts";
import { reloadApplicationInfoForTesting } from "../src/expo/application.ts";
import { resetLocalNotificationsForTesting } from "../src/mobile/local-notifications.ts";
import { type Any, fakePlugin, inShell, settle, withGlobals } from "./helpers/mobile-fakes.ts";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

// ---- react-native-bootsplash --------------------------------------------------------------------

/** A fake document holding `ids` as removable elements. */
function fakeDocument(ids: string[]) {
  const nodes = new Map<string, Any>();
  for (const id of ids) {
    nodes.set(id, { style: {}, remove: () => nodes.delete(id) });
  }
  return { nodes, document: { getElementById: (id: string) => nodes.get(id) ?? null } };
}

Deno.test("bootsplash: the shell hides the native splash; the web removes #bootsplash", async () => {
  resetBootSplashForTesting();
  const splash = fakePlugin(["hide"]);
  const dom = fakeDocument(["bootsplash", "bootsplash-style"]);
  await inShell("ios", { SplashScreen: splash.plugin }, async () => {
    assertEquals(BootSplash.isVisible(), true);
    await BootSplash.hide();
    assertEquals(splash.calls.map(([m]) => m), ["hide"]);
    assertEquals(dom.nodes.size, 0);
    assertEquals(BootSplash.isVisible(), false);
  }, { document: dom.document });

  const web = fakeDocument(["bootsplash"]);
  await withGlobals({ document: web.document }, async () => {
    assertEquals(BootSplash.isVisible(), true);
    await BootSplash.hide({ fade: true });
    assertEquals(BootSplash.isVisible(), false);
  });
  resetBootSplashForTesting();
});

// ---- @react-native-community/netinfo ------------------------------------------------------------

Deno.test("netinfo: fetch and addEventListener map the shell's status to the package's state", async () => {
  const network = fakePlugin(["getStatus"], {
    getStatus: { connected: true, connectionType: "wifi" },
  });
  await inShell("android", { Network: network.plugin }, async () => {
    const state = await NetInfo.fetch();
    assertEquals(state.type, NetInfoStateType.wifi);
    assertEquals(state.isConnected, true);
    assertEquals(state.isInternetReachable, true);
    assertEquals(state.details?.ssid, null);
    assertEquals(state.details?.isConnectionExpensive, false);

    const seen: string[] = [];
    const stop = NetInfo.addEventListener((s) => seen.push(`${s.type}:${s.isConnected}`));
    await settle();
    network.fire("networkStatusChange", { connected: true, connectionType: "cellular" });
    network.fire("networkStatusChange", { connected: false, connectionType: "none" });
    stop();
    network.fire("networkStatusChange", { connected: true, connectionType: "wifi" });
    assertEquals(seen, ["wifi:true", "cellular:true", "none:false"]); // the current state first
    assertEquals(network.listening(), 0);
    assertEquals((await NetInfo.refresh()).type, NetInfoStateType.wifi);
  });
  await withGlobals({ navigator: { onLine: false } }, async () => {
    const state = await NetInfo.fetch();
    assertEquals([state.type, state.isConnected, state.details], [
      NetInfoStateType.none,
      false,
      null,
    ]);
  });
});

// ---- react-native-device-info -------------------------------------------------------------------

Deno.test("device-info: the iOS shell answers from the user agent, then natively", async () => {
  resetDeviceInfoForTesting();
  const device = fakePlugin(["getInfo", "getId"], {
    getInfo: { model: "iPhone15,2", osVersion: "17.6", isVirtual: true },
    getId: { identifier: "VENDOR-ID" },
  });
  const app = fakePlugin(["getInfo"], {
    getInfo: { name: "Demo", id: "dev.demo", version: "1.2.3", build: "45" },
  });
  await inShell("ios", { Device: device.plugin, App: app.plugin }, async () => {
    await reloadApplicationInfoForTesting();
    // Synchronously, before the native read: the user agent.
    assertEquals(DeviceInfo.getSystemName(), "iOS");
    assertEquals(DeviceInfo.getSystemVersion(), "17.5");
    assertEquals(DeviceInfo.getModel(), "iPhone");
    assertEquals(DeviceInfo.isEmulatorSync(), false);
    // After it: native.
    assertEquals(await DeviceInfo.getUniqueId(), "VENDOR-ID");
    assertEquals(DeviceInfo.getUniqueIdSync(), "VENDOR-ID");
    assertEquals(DeviceInfo.getModel(), "iPhone15,2");
    assertEquals(DeviceInfo.getDeviceId(), "iPhone15,2");
    assertEquals(DeviceInfo.getSystemVersion(), "17.6");
    assertEquals(await DeviceInfo.isEmulator(), true);
    assertEquals(DeviceInfo.hasDynamicIsland(), true);
    assertEquals(DeviceInfo.getBrand(), "Apple");
    assertEquals(await DeviceInfo.getManufacturer(), "Apple");
    assertEquals(DeviceInfo.getDeviceType(), "Handset");
    assertEquals(DeviceInfo.isTablet(), false);
    assertEquals(DeviceInfo.getBundleId(), "dev.demo");
    assertEquals(DeviceInfo.getApplicationName(), "Demo");
    assertEquals(DeviceInfo.getReadableVersion(), "1.2.3.45");
    assertEquals(DeviceInfo.getMacAddressSync(), "02:00:00:00:00:00");
    assertEquals(await DeviceInfo.getAndroidId(), "unknown");
    // Only one native read ran.
    assertEquals(device.calls.filter(([m]) => m === "getInfo").length, 1);
  }, { navigator: { userAgent: IPHONE_UA }, screen: { width: 393, height: 852 } });
  resetDeviceInfoForTesting();
});

Deno.test("device-info: on the web the device getters are the package's web answers", async () => {
  resetDeviceInfoForTesting();
  let level = 0.5;
  const listeners: Array<() => void> = [];
  const battery = {
    get level() {
      return level;
    },
    charging: true,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: () => {},
  };
  await withGlobals({
    navigator: {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
      platform: "MacIntel",
      deviceMemory: 8,
      geolocation: {},
      getBattery: () => Promise.resolve(battery),
      storage: { estimate: () => Promise.resolve({ quota: 1000, usage: 250 }) },
    },
  }, async () => {
    assertEquals(DeviceInfo.getModel(), "unknown");
    assertEquals(DeviceInfo.getSystemName(), "unknown");
    assertEquals(DeviceInfo.getVersion(), "unknown");
    assertEquals(await DeviceInfo.getUniqueId(), "unknown");
    assertEquals(DeviceInfo.getBaseOsSync(), "Mac OS");
    assertEquals(DeviceInfo.getTotalMemorySync(), 8_000_000_000);
    assertEquals(await DeviceInfo.getFreeDiskStorage(), 750);
    assertEquals(await DeviceInfo.getTotalDiskCapacity(), 1000);
    assertEquals(DeviceInfo.isLocationEnabledSync(), true);
    assertEquals(DeviceInfo.getBatteryLevelSync(), -1);
    assertEquals(await DeviceInfo.getBatteryLevel(), 0.5);
    assertEquals(DeviceInfo.getBatteryLevelSync(), 0.5);
    assertEquals((await DeviceInfo.getPowerState()).batteryState, "charging");
    assertEquals(DeviceInfo.isBatteryChargingSync(), true);
    assertEquals(DeviceInfo.getDeviceType(), "unknown");
    assertEquals(DeviceInfo.hasNotch(), false);
    assertEquals(await DeviceInfo.getCarrier(), "unknown");
    assertEquals(await DeviceInfo.getAppSetId(), { id: "unknown", scope: -1 });
    assertEquals(isLowBatteryLevel(0.1), true);
    level = 1;
    assertEquals((await DeviceInfo.getPowerState()).batteryState, "full");
  });
  resetDeviceInfoForTesting();
});

// ---- @notifee/react-native ----------------------------------------------------------------------

const LOCAL_METHODS = [
  "schedule",
  "getPending",
  "cancel",
  "registerActionTypes",
  "createChannel",
  "listChannels",
  "deleteChannel",
  "checkPermissions",
  "requestPermissions",
];

Deno.test("notifee: trigger notifications schedule, list and cancel by string id", async () => {
  resetNotifeeForTesting();
  resetLocalNotificationsForTesting();
  const at = new Date(2030, 0, 6, 9, 30).getTime(); // a Sunday, 09:30 local
  const trigger = { type: TriggerType.TIMESTAMP, timestamp: at } as const;
  const local = fakePlugin(LOCAL_METHODS, {
    getPending: {
      notifications: [{
        id: 7,
        title: "Stand-up",
        body: "Soon",
        extra: { team: "a", __notifeeId: "standup", __notifeeTrigger: JSON.stringify(trigger) },
      }],
    },
  });
  await inShell("android", { LocalNotifications: local.plugin }, async () => {
    const events: Event[] = [];
    const stop = notifee.onForegroundEvent((e) => events.push(e));
    const id = await notifee.createTriggerNotification({
      id: "standup",
      title: "Stand-up",
      body: "Soon",
      data: { team: "a" },
      android: { channelId: "work" },
    }, trigger);
    assertEquals(id, "standup");
    const [, arg] = local.calls.find(([m]) => m === "schedule")!;
    const scheduled = (arg as Any).notifications[0];
    assertEquals(scheduled.channelId, "work");
    assertEquals(scheduled.extra.__notifeeId, "standup");
    assertEquals(scheduled.extra.team, "a");
    assertEquals(new Date(scheduled.schedule.at).getTime(), at);
    assertEquals(events.map((e) => e.type), [EventType.TRIGGER_NOTIFICATION_CREATED]);

    await notifee.createTriggerNotification({ id: "weekly", title: "W", body: "" }, {
      type: TriggerType.TIMESTAMP,
      timestamp: at,
      repeatFrequency: RepeatFrequency.WEEKLY,
    });
    const weekly = (local.calls.filter(([m]) => m === "schedule")[1][1] as Any).notifications[0];
    assertEquals(weekly.schedule.on, { weekday: 1, hour: 9, minute: 30 });

    await notifee.createTriggerNotification({ id: "every", title: "E", body: "" }, {
      type: TriggerType.INTERVAL,
      interval: 15,
      timeUnit: TimeUnit.MINUTES,
    });
    const every = (local.calls.filter(([m]) => m === "schedule")[2][1] as Any).notifications[0];
    assertEquals(every.schedule.repeats, true);

    assertEquals(await notifee.getTriggerNotificationIds(), ["standup"]);
    const [pending] = await notifee.getTriggerNotifications();
    assertEquals(pending.notification, {
      id: "standup",
      title: "Stand-up",
      body: "Soon",
      data: { team: "a" },
    });
    assertEquals(pending.trigger, trigger);

    await notifee.cancelNotification("standup");
    const cancel = local.calls.filter(([m]) => m === "cancel").at(-1)![1] as Any;
    assertEquals(cancel.notifications, [{ id: scheduled.id }]);
    stop();
  });
  resetNotifeeForTesting();
  resetLocalNotificationsForTesting();
});

Deno.test("notifee: presses reach observers; permission, channels, categories, badge", async () => {
  resetNotifeeForTesting();
  resetLocalNotificationsForTesting();
  const local = fakePlugin(LOCAL_METHODS, {
    checkPermissions: { display: "prompt" },
    requestPermissions: { display: "granted" },
    listChannels: { channels: [{ id: "work", name: "Work", importance: 4 }] },
  });
  await inShell("android", { LocalNotifications: local.plugin }, async () => {
    const background: Event[] = [];
    notifee.onBackgroundEvent((e) => {
      background.push(e);
      return Promise.resolve();
    });
    await settle();
    local.fire("localNotificationActionPerformed", {
      actionId: "reply",
      inputValue: "hi",
      notification: { id: 3, title: "T", body: "B", extra: { __notifeeId: "msg-1", k: "v" } },
    });
    assertEquals(background.length, 1);
    assertEquals(background[0].type, EventType.ACTION_PRESS);
    assertEquals(background[0].detail.pressAction, { id: "reply" });
    assertEquals(background[0].detail.input, "hi");
    assertEquals(background[0].detail.notification?.id, "msg-1");
    assertEquals(background[0].detail.notification?.data, { k: "v" });

    const initial = await notifee.getInitialNotification();
    assertEquals(initial?.notification.id, "msg-1");
    assertEquals(await notifee.getInitialNotification(), null);

    const foreground: Event[] = [];
    const stop = notifee.onForegroundEvent((e) => foreground.push(e));
    local.fire("localNotificationActionPerformed", {
      actionId: "tap",
      notification: { id: 4, extra: {} },
    });
    assertEquals(foreground.map((e) => [e.type, e.detail.pressAction?.id]), [
      [EventType.PRESS, "default"],
    ]);
    assertEquals(background.length, 1, "a foreground observer takes the events");
    stop();

    assertEquals(
      (await notifee.getNotificationSettings()).authorizationStatus,
      AuthorizationStatus.NOT_DETERMINED,
    );
    assertEquals(
      (await notifee.requestPermission()).authorizationStatus,
      AuthorizationStatus.AUTHORIZED,
    );

    assertEquals(
      await notifee.createChannel({ id: "work", name: "Work", importance: AndroidImportance.HIGH }),
      "work",
    );
    assertEquals(local.calls.find(([m]) => m === "createChannel")![1], {
      id: "work",
      name: "Work",
      importance: 4,
    });
    assertEquals((await notifee.getChannel("work"))?.blocked, false);
    assertEquals(await notifee.isChannelCreated("nope"), false);

    await notifee.setNotificationCategories([{
      id: "msg",
      actions: [{ id: "reply", title: "Reply", input: { placeholderText: "Say…" } }],
    }]);
    const types = (local.calls.find(([m]) => m === "registerActionTypes")![1] as Any).types;
    assertEquals(types[0].actions[0].inputPlaceholder, "Say…");
    assertEquals((await notifee.getNotificationCategories()).map((c) => c.id), ["msg"]);

    await notifee.setBadgeCount(3);
    await notifee.incrementBadgeCount();
    await notifee.decrementBadgeCount(10);
    assertEquals(await notifee.getBadgeCount(), 0);
    assertEquals(await notifee.getDisplayedNotifications(), []);
    assert(notifee.SDK_VERSION.length > 0);
  });
  resetNotifeeForTesting();
  resetLocalNotificationsForTesting();
});
