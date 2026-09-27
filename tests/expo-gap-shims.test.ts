// denext/expo/* shims that close the React Native gap audit's Expo findings: the packages that
// broke at import (expo-tracking-transparency, expo-maps, @expo/ui's SwiftUI / Jetpack Compose
// entry points), expo-application over @capacitor/app + @capacitor/device, and
// expo-notifications' getExpoPushTokenAsync. Each runs in a faked Capacitor shell and on the web.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import * as Tracking from "../src/expo/tracking-transparency.ts";
import * as Application from "../src/expo/application.ts";
import * as Maps from "../src/expo/maps.ts";
import * as SwiftUI from "../src/expo/ui-swift-ui.ts";
import * as SwiftUIModifiers from "../src/expo/ui-swift-ui-modifiers.ts";
import * as Compose from "../src/expo/ui-jetpack-compose.ts";
import * as ComposeModifiers from "../src/expo/ui-jetpack-compose-modifiers.ts";
import * as Notifications from "../src/expo/notifications.ts";
import { resetNativeViewWarningsForTesting } from "../src/expo/internal/native-view.ts";
import { type Any, fakePlugin, inShell, mount, withGlobals } from "./helpers/mobile-fakes.ts";

/** Let promise callbacks and timers run, then commit what they scheduled. */
async function tick(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

/** Swallow console.warn for `fn` and return what was warned. */
async function quietly(fn: () => unknown | Promise<unknown>): Promise<string[]> {
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warned;
}

// ---- expo-tracking-transparency ---------------------------------------------------------------

const ATT_METHODS = ["getStatus", "requestPermission"];

Deno.test("expo-tracking-transparency: the ATT plugin's statuses in the iOS shell", async () => {
  const cases: Array<[string, string, boolean, boolean]> = [
    ["authorized", "granted", true, true],
    ["notDetermined", "undetermined", false, true],
    ["denied", "denied", false, false],
    ["restricted", "denied", false, false],
  ];
  for (const [native, status, granted, canAskAgain] of cases) {
    const att = fakePlugin(ATT_METHODS, {
      getStatus: { status: native },
      requestPermission: { status: native },
    });
    await inShell("ios", { AppTrackingTransparency: att.plugin }, async () => {
      assert(Tracking.isAvailable());
      const got = await Tracking.getTrackingPermissionsAsync();
      assertEquals([got.status, got.granted, got.canAskAgain], [status, granted, canAskAgain]);
      const asked = await Tracking.requestTrackingPermissionsAsync();
      assertEquals(asked.status, status);
    });
    assertEquals(att.calls.map(([m]) => m), ["getStatus", "requestPermission"]);
  }
});

Deno.test("expo-tracking-transparency: no plugin, Android and the web never throw", async () => {
  await inShell("ios", {}, async () => {
    assertEquals(Tracking.isAvailable(), false);
    const res = await Tracking.requestTrackingPermissionsAsync();
    assertEquals([res.status, res.granted, res.canAskAgain], ["undetermined", false, false]);
  });
  const att = fakePlugin(ATT_METHODS, { getStatus: { status: "denied" } });
  await inShell("android", { AppTrackingTransparency: att.plugin }, async () => {
    assertEquals(Tracking.isAvailable(), false, "ATT is iOS only");
    assertEquals((await Tracking.getTrackingPermissionsAsync()).status, "granted");
  });
  assertEquals(att.calls, [], "the plugin is not asked off iOS");
  assertEquals((await Tracking.requestTrackingPermissionsAsync()).granted, true, "web");
  assertEquals(Tracking.getAdvertisingId(), null);
  assertEquals(Tracking.PermissionStatus.GRANTED, "granted");
  const { root } = mount(() => {
    const [response] = Tracking.useTrackingPermissions();
    return h("p", null, response?.status ?? "…");
  });
  await tick();
  root.unmount();
});

// ---- expo-application ---------------------------------------------------------------------------

const CONFIG = {
  name: "Config Name",
  version: "1.2.0",
  ios: { bundleIdentifier: "dev.denext.ios", buildNumber: "12" },
  android: { package: "dev.denext.android", versionCode: 34 },
};

Deno.test("expo-application: null on the web, as Expo's web build", async () => {
  await withGlobals({ __DENEXT_EXPO_CONFIG__: CONFIG }, async () => {
    const info = await Application.reloadApplicationInfoForTesting();
    assertEquals(info, {
      applicationName: null,
      applicationId: null,
      nativeApplicationVersion: null,
      nativeBuildVersion: null,
    });
  });
  assertThrows(() => Application.getAndroidId(), Error, "Android only");
  await assertRejects(() => Application.getIosIdForVendorAsync(), Error, "iOS shell only");
  await assertRejects(() => Application.getInstallationTimeAsync(), Error, "No Capacitor plugin");
  await assertRejects(() => Application.getLastUpdateTimeAsync(), Error, "No Capacitor plugin");
  const err = await Application.getInstallReferrerAsync().catch((e) => e);
  assertEquals(err.code, "ERR_UNAVAILABLE");
});

Deno.test("expo-application: the iOS shell seeds from the config, then @capacitor/app wins", async () => {
  const app = fakePlugin(["getInfo"], {
    getInfo: { name: "Native", id: "dev.native", version: "2.0.0", build: "77" },
  });
  const device = fakePlugin(["getId", "getInfo"], {
    getId: { identifier: "VENDOR-1" },
    getInfo: { isVirtual: true },
  });
  await inShell("ios", { App: app.plugin, Device: device.plugin }, async () => {
    const pending = Application.reloadApplicationInfoForTesting();
    // Before the plugin answers, the constants come from the Expo config.
    assertEquals(
      [Application.applicationId, Application.nativeBuildVersion],
      ["dev.denext.ios", "12"],
    );
    assertEquals(await pending, {
      applicationName: "Native",
      applicationId: "dev.native",
      nativeApplicationVersion: "2.0.0",
      nativeBuildVersion: "77",
    });
    assertEquals(Application.applicationName, "Native", "the export is a live binding");
    assertEquals(await Application.getIosIdForVendorAsync(), "VENDOR-1");
    assertEquals(
      await Application.getIosApplicationReleaseTypeAsync(),
      Application.ApplicationReleaseType.SIMULATOR,
    );
    assertEquals(await Application.getIosPushNotificationServiceEnvironmentAsync(), null);
    assertThrows(() => Application.getAndroidId(), Error, "Android only");
  }, { __DENEXT_EXPO_CONFIG__: CONFIG });
  await Application.reloadApplicationInfoForTesting();
});

Deno.test("expo-application: Android reads the Android id; no plugins keeps the config", async () => {
  const device = fakePlugin(["getId"], { getId: { identifier: "a1b2c3" } });
  await inShell("android", { Device: device.plugin }, async () => {
    const info = await Application.reloadApplicationInfoForTesting();
    assertEquals([info.applicationId, info.nativeBuildVersion], ["dev.denext.android", "34"]);
    assertEquals(Application.getAndroidId(), "a1b2c3");
    await assertRejects(() => Application.getIosApplicationReleaseTypeAsync());
  }, { __DENEXT_EXPO_CONFIG__: CONFIG });
  await inShell("android", {}, async () => {
    await Application.reloadApplicationInfoForTesting();
    assertThrows(() => Application.getAndroidId(), Error, "denext mobile add device");
  });
  await Application.reloadApplicationInfoForTesting();
});

// ---- expo-maps -------------------------------------------------------------------------------------

Deno.test("expo-maps: loads, keeps its enums, and renders a placeholder whose ref throws", async () => {
  resetNativeViewWarningsForTesting();
  assertEquals(Maps.AppleMaps.MapType.STANDARD, "STANDARD");
  assertEquals(Maps.GoogleMaps.MapType.TERRAIN, "TERRAIN");
  assertEquals(Maps.AppleMaps.ContourStyle.GEODESIC, "GEODESIC");
  assertEquals(Maps.GoogleMaps.MapColorScheme.FOLLOW_SYSTEM, "FOLLOW_SYSTEM");
  const ref: { current: Maps.MapViewHandle | null } = { current: null };
  let container: Any;
  const warned = await quietly(async () => {
    const mounted = mount(() => h(Maps.AppleMaps.View as Any, { ref, style: { height: 200 } }));
    container = mounted.container;
    await tick();
    mounted.rerender();
    mounted.root.unmount();
  });
  assert(container !== undefined);
  assertEquals(warned.length, 1, "warns once");
  assert(warned[0].includes("expo-maps") && warned[0].includes("Leaflet"));
  let handle!: ReturnType<typeof mount>;
  await quietly(() => void (handle = mount(() => h(Maps.GoogleMaps.View as Any, { ref }))));
  assertEquals(handle.container.textContent, "Map unavailable");
  assertThrows(() => ref.current!.setCameraPosition({ zoom: 3 }), Error, "web map");
  await assertRejects(() => ref.current!.openLookAroundAsync({}), Error, "native view");
  handle.root.unmount();
  const permission = await Maps.getPermissionsAsync();
  assert(["granted", "denied", "undetermined"].includes(permission.status));
});

// ---- @expo/ui ---------------------------------------------------------------------------------------

Deno.test("@expo/ui stand-ins: every export is defined; views render children with web layout", async () => {
  for (const mod of [SwiftUI, SwiftUIModifiers, Compose, ComposeModifiers] as Any[]) {
    for (const [name, value] of Object.entries(mod)) {
      assert(value !== undefined, `${name} is defined`);
    }
  }
  resetNativeViewWarningsForTesting();
  const pressed: string[] = [];
  let html = "";
  const warned = await quietly(() => {
    const { container, root } = mount(() =>
      h(
        SwiftUI.Host as Any,
        null,
        h(
          SwiftUI.VStack as Any,
          { spacing: 4 },
          h(SwiftUI.Text as Any, null, "Hello"),
          h(SwiftUI.Button as Any, { label: "Go", onPress: () => pressed.push("go") }),
          h(SwiftUI.Chart as Any, null),
        ),
      )
    );
    html = container.innerHTML;
    const button = (container as Any).firstChild.firstChild.childNodes[1];
    assertEquals(button.tagName, "BUTTON");
    button.dispatch("click", { currentTarget: button });
    root.unmount();
  });
  assert(html.includes("<span>Hello</span>"), html);
  assert(html.includes("flex-direction:column"), html);
  assertEquals(pressed, ["go"]);
  assert(warned.some((w) => w.includes("@expo/ui/swift-ui's VStack")));
  assertEquals(warned.filter((w) => w.includes("Chart")).length, 1);
  await quietly(() => {
    const row = mount(() => h(Compose.Row as Any, null, h(Compose.Text as Any, null, "x")));
    assert(row.container.innerHTML.includes("flex-direction:row"));
    row.root.unmount();
  });
});

Deno.test("@expo/ui stand-ins: modifiers are inert configs; the helpers behave", () => {
  const padding = SwiftUIModifiers.padding({ all: 8 });
  assertEquals(padding, { $type: "padding", $args: [{ all: 8 }] });
  assert(SwiftUIModifiers.isModifier(padding));
  assertEquals(SwiftUIModifiers.filterModifiers([padding, null, 3]), [padding]);
  assertEquals(SwiftUIModifiers.createModifier("x", { a: 1 }), { $type: "x", $args: [{ a: 1 }] });
  const spring = SwiftUIModifiers.Animation.spring({ duration: 1 }).delay(2);
  assertEquals(spring.$type, "spring");
  assertEquals(SwiftUIModifiers.shapes.circle().$type, "shapes.circle");
  assertEquals(ComposeModifiers.fillMaxWidth().$type, "fillMaxWidth");
  assertEquals(ComposeModifiers.Shapes.RoundedCorner(4).$type, "Shapes.RoundedCorner");
  assertEquals(Compose.EnterTransition.fadeIn().$type, "EnterTransition.fadeIn");
  assertEquals(Compose.isDynamicColorAvailable, false);
  assertEquals(Compose.getMaterialColors(), {});
  assertEquals(Compose.transformButtonProps({ a: 1 }), { a: 1 });
  let ran = 0;
  SwiftUI.withAnimation(null, () => ran++, () => ran++);
  assertEquals(ran, 2);
  const { root } = mount(() => {
    const state = SwiftUI.useNativeState(1);
    state.set(state.get() + 1);
    return h("i", null, String(state.value));
  });
  root.unmount();
});

// ---- expo-notifications: getExpoPushTokenAsync ----------------------------------------------------

Deno.test("expo-notifications: getExpoPushTokenAsync rejects with guidance, never a fake token", async () => {
  const err = await Notifications.getExpoPushTokenAsync({ projectId: "p" }).catch((e) => e);
  assertEquals(err.code, "ERR_NOTIFICATIONS_NO_EXPO_PUSH_SERVICE");
  assert(String(err.message).includes("getDevicePushTokenAsync"));
});
