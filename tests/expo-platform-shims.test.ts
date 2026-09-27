// denext/expo/* shims for the 2.11 platform capabilities: expo-local-authentication,
// expo-location, expo-apple-authentication, expo-notifications' local scheduling and categories,
// expo-secure-store's requireAuthentication, and expo-linking's openSettings. Each runs in a
// faked Capacitor shell and on the web.

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as LocalAuthentication from "../src/expo/local-authentication.ts";
import * as Location from "../src/expo/location.ts";
import * as AppleAuthentication from "../src/expo/apple-authentication.ts";
import * as Notifications from "../src/expo/notifications.ts";
import * as SecureStore from "../src/expo/secure-store.ts";
import * as Linking from "../src/expo/linking.ts";
import { resetSocialLoginForTesting } from "../src/mobile/social-login.ts";
import { resetLocalNotificationsForTesting } from "../src/mobile/local-notifications.ts";
import { resetPushForTesting } from "../src/mobile/push.ts";
import { type Any, fakePlugin, inShell, settle, withGlobals } from "./helpers/mobile-fakes.ts";

const BIO_METHODS = ["checkBiometry", "internalAuthenticate"];
const LOCAL_METHODS = ["schedule", "getPending", "cancel", "registerActionTypes", "addListener"];

// ---- expo-local-authentication ------------------------------------------------------------------

Deno.test("expo-local-authentication: hardware, enrolment, types, level, authenticate", async () => {
  const bio = fakePlugin(BIO_METHODS, {
    checkBiometry: { isAvailable: true, biometryType: 2, biometryTypes: [2], deviceIsSecure: true },
  });
  await inShell("ios", { BiometricAuthNative: bio.plugin }, async () => {
    assertEquals(await LocalAuthentication.hasHardwareAsync(), true);
    assertEquals(await LocalAuthentication.isEnrolledAsync(), true);
    assertEquals(await LocalAuthentication.supportedAuthenticationTypesAsync(), [
      LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
    ]);
    assertEquals(
      await LocalAuthentication.getEnrolledLevelAsync(),
      LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG,
    );
    assertEquals(
      await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock",
        cancelLabel: "No",
        fallbackLabel: "",
        disableDeviceFallback: true,
      }),
      { success: true },
    );
    await LocalAuthentication.cancelAuthenticate();
  });
  assertEquals((bio.calls.at(-1)![1] as Any).allowDeviceCredential, false);
  assertEquals((bio.calls.at(-1)![1] as Any).iosFallbackTitle, "");

  const passcodeOnly = fakePlugin(BIO_METHODS, {
    checkBiometry: {
      isAvailable: false,
      biometryType: 3,
      deviceIsSecure: true,
      code: "biometryNotEnrolled",
    },
    internalAuthenticate: Object.assign(new Error("gone"), { code: "userCancel" }),
  });
  await inShell("android", { BiometricAuthNative: passcodeOnly.plugin }, async () => {
    assertEquals(await LocalAuthentication.isEnrolledAsync(), false);
    assertEquals(
      await LocalAuthentication.getEnrolledLevelAsync(),
      LocalAuthentication.SecurityLevel.SECRET,
    );
    const result = await LocalAuthentication.authenticateAsync();
    assertEquals([result.success, (result as Any).error], [false, "user_cancel"]);
  });
  assertEquals(await LocalAuthentication.hasHardwareAsync(), false, "the web has none");
  assertEquals(
    await LocalAuthentication.getEnrolledLevelAsync(),
    LocalAuthentication.SecurityLevel.NONE,
  );
  assertEquals(await LocalAuthentication.authenticateAsync(), {
    success: false,
    error: "not_available",
    warning: (await LocalAuthentication.authenticateAsync() as Any).warning,
  });
});

// ---- expo-location ---------------------------------------------------------------------------------

const FIX = { timestamp: 5, coords: { latitude: 1, longitude: 2, accuracy: 3, altitude: 4 } };

Deno.test("expo-location: permissions, current / last known position, watch with distance", async () => {
  let watchCb: Any;
  const geo = fakePlugin(["getCurrentPosition", "watchPosition", "clearWatch", ...[
    "checkPermissions",
    "requestPermissions",
  ]], {
    getCurrentPosition: FIX,
    checkPermissions: { location: "denied", coarseLocation: "granted" },
    requestPermissions: { location: "granted" },
  });
  geo.plugin.watchPosition = (_o: unknown, cb: unknown) => {
    watchCb = cb;
    return Promise.resolve("w");
  };
  await inShell("android", { Geolocation: geo.plugin }, async () => {
    const fg = await Location.getForegroundPermissionsAsync();
    assertEquals([fg.status, fg.granted, fg.android?.accuracy], ["granted", true, "coarse"]);
    const bg = await Location.getBackgroundPermissionsAsync();
    assertEquals([bg.status, bg.canAskAgain], ["denied", false]);
    const here = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
    assertEquals(here.coords, {
      latitude: 1,
      longitude: 2,
      altitude: 4,
      accuracy: 3,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    });
    assertEquals((geo.calls.at(-1)![1] as Any).enableHighAccuracy, true);
    assertEquals((await Location.getLastKnownPositionAsync({ maxAge: 1e15 }))?.coords.latitude, 1);
    const seen: number[] = [];
    const sub = await Location.watchPositionAsync(
      { distanceInterval: 100 },
      (l) => seen.push(l.coords.latitude),
    );
    await settle();
    watchCb({ timestamp: 1, coords: { latitude: 10, longitude: 10 } });
    watchCb({ timestamp: 2, coords: { latitude: 10.0001, longitude: 10 } }); // ~11 m: dropped
    watchCb({ timestamp: 3, coords: { latitude: 10.01, longitude: 10 } }); // ~1.1 km
    sub.remove();
    assertEquals(seen, [10, 10.01]);
    assert(Location._getCurrentWatchId() >= 1);
    assertEquals(await Location.hasServicesEnabledAsync(), true);
    assertEquals(await Location.isBackgroundLocationAvailableAsync(), false);
  });
  assertEquals(
    (await Location.getForegroundPermissionsAsync()).status,
    "undetermined",
    "nothing answers during SSR",
  );
  assertEquals((await Location.getProviderStatusAsync()).locationServicesEnabled, false);
  Location.installWebGeolocationPolyfill();
  await Location.enableNetworkProviderAsync();
});

Deno.test("expo-location: geocoding needs setGeocoder", async () => {
  await assertRejects(
    () => Location.reverseGeocodeAsync({ latitude: 1, longitude: 2 }),
    Error,
    "setGeocoder",
  );
  await assertRejects(() => Location.geocodeAsync("Berlin"), Error, "setGeocoder");
  Location.setGeocoder({
    geocode: (address) => Promise.resolve([{ latitude: address.length, longitude: 0 }]),
    reverseGeocode: () =>
      Promise.resolve([{
        city: "Berlin",
        district: null,
        streetNumber: null,
        street: null,
        region: null,
        subregion: null,
        country: "Germany",
        postalCode: null,
        name: null,
        isoCountryCode: "DE",
        timezone: null,
        formattedAddress: null,
      }]),
  });
  try {
    assertEquals((await Location.geocodeAsync("Berlin"))[0].latitude, 6);
    assertEquals(
      (await Location.reverseGeocodeAsync({ latitude: 1, longitude: 2 }))[0].city,
      "Berlin",
    );
  } finally {
    Location.setGeocoder(null);
  }
});

// ---- expo-apple-authentication ------------------------------------------------------------------

Deno.test("expo-apple-authentication: signInAsync maps the credential; iOS only", async () => {
  resetSocialLoginForTesting();
  const social = fakePlugin(["initialize", "login"], {
    login: {
      result: {
        idToken: "tok",
        authorizationCode: "code",
        profile: { user: "001", email: "a@b.c", givenName: "Ada", familyName: "Lovelace" },
      },
    },
  });
  await inShell("ios", { SocialLogin: social.plugin }, async () => {
    assertEquals(await AppleAuthentication.isAvailableAsync(), true);
    const credential = await AppleAuthentication.signInAsync({ state: "s", nonce: "n" });
    assertEquals(credential.identityToken, "tok");
    assertEquals(credential.authorizationCode, "code");
    assertEquals(credential.user, "001");
    assertEquals(credential.state, "s");
    assertEquals(credential.fullName?.givenName, "Ada");
    assertEquals(AppleAuthentication.formatFullName(credential.fullName!), "Ada Lovelace");
    assertEquals(AppleAuthentication.formatFullName(credential.fullName!, "short"), "Ada");
    const button = AppleAuthentication.AppleAuthenticationButton({
      onPress: () => {},
      buttonType: AppleAuthentication.AppleAuthenticationButtonType.CONTINUE,
      buttonStyle: AppleAuthentication.AppleAuthenticationButtonStyle.BLACK,
      cornerRadius: 12,
    }) as Any;
    assertEquals(button.type, "button");
    assertEquals(button.props["aria-label"], "Continue with Apple");
    assertEquals([button.props.style.backgroundColor, button.props.style.borderRadius], [
      "#000",
      12,
    ]);
  });
  assertEquals(await AppleAuthentication.isAvailableAsync(), false);
  assertEquals(
    AppleAuthentication.AppleAuthenticationButton({
      onPress: () => {},
      buttonType: 0,
      buttonStyle: 0,
    }),
    null,
    "nothing off iOS",
  );
  await assertRejects(() => AppleAuthentication.signInAsync(), Error, "iOS only");
  await assertRejects(
    () => AppleAuthentication.refreshAsync({ user: "x" }),
    Error,
    "not supported",
  );
  await assertRejects(
    () => AppleAuthentication.getCredentialStateAsync("x"),
    Error,
    "not supported",
  );
  AppleAuthentication.addRevokeListener(() => {}).remove();
});

// ---- expo-notifications: local scheduling ------------------------------------------------------------

Deno.test("expo-notifications: schedule / list / cancel map identifiers and triggers", async () => {
  resetLocalNotificationsForTesting();
  const pending: Any[] = [];
  const local = fakePlugin(LOCAL_METHODS);
  local.plugin.schedule = (arg: Any) => {
    local.calls.push(["schedule", arg]);
    pending.push(...arg.notifications);
    return Promise.resolve({ notifications: [] });
  };
  local.plugin.getPending = () => Promise.resolve({ notifications: pending });
  await inShell("android", { LocalNotifications: local.plugin }, async () => {
    const id = await Notifications.scheduleNotificationAsync({
      identifier: "standup",
      content: {
        title: "Stand-up",
        body: "Now",
        data: { path: "/standup" },
        categoryIdentifier: "c",
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.YEARLY,
        month: 11,
        day: 25,
        hour: 7,
        minute: 0,
        channelId: "daily",
      },
    });
    assertEquals(id, "standup");
    const schema = pending[0];
    assertEquals(
      schema.schedule.on,
      { month: 12, day: 25, hour: 7, minute: 0 },
      "Expo's month is 0-based",
    );
    assertEquals(schema.channelId, "daily");
    assertEquals(schema.actionTypeId, "c");
    assertEquals(schema.extra.path, "/standup");
    const now = await Notifications.scheduleNotificationAsync({
      content: { title: "Hi" },
      trigger: null,
    });
    assert(/^[0-9a-f-]{36}$/.test(now));
    assertEquals(pending[1].schedule, undefined);
    assertEquals(pending[1].body, "");

    const all = await Notifications.getAllScheduledNotificationsAsync();
    assertEquals(all[0].identifier, "standup");
    assertEquals(all[0].content.data, { path: "/standup" }, "bookkeeping keys stripped");
    assertEquals((all[0].trigger as Any).type, "yearly");
    await Notifications.cancelScheduledNotificationAsync("standup");
    await Notifications.cancelScheduledNotificationAsync("42");
    await Notifications.cancelAllScheduledNotificationsAsync();
  });
  const cancels = local.calls.filter(([m]) => m === "cancel").map(([, a]) =>
    (a as Any).notifications
  );
  assertEquals(cancels[1], [{ id: 42 }], "a numeric identifier is used as is");
  assertEquals(cancels[0], [{ id: pending[0].id }]);
  assertEquals(cancels[2].length, 2);
});

Deno.test("expo-notifications: getNextTriggerDateAsync, categories, local responses", async () => {
  resetLocalNotificationsForTesting();
  resetPushForTesting();
  const next = await Notifications.getNextTriggerDateAsync({
    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
    seconds: 60,
  });
  assert(next !== null && Math.abs(next - (Date.now() + 60_000)) < 5_000);
  assertEquals(
    await Notifications.getNextTriggerDateAsync({
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: 1,
    }),
    null,
  );
  await assertRejects(
    () => Notifications.getNextTriggerDateAsync({ type: "bogus" } as Any),
    TypeError,
  );

  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const local = fakePlugin(LOCAL_METHODS);
  await inShell("ios", { LocalNotifications: local.plugin }, async () => {
    const category = await Notifications.setNotificationCategoryAsync("msg", [
      {
        identifier: "reply",
        buttonTitle: "Reply",
        textInput: { submitButtonTitle: "Send", placeholder: "…" },
      },
      { identifier: "later", buttonTitle: "Later", options: { opensAppToForeground: false } },
    ], { previewPlaceholder: "Message" });
    assertEquals(category.identifier, "msg");
    await Notifications.setNotificationCategoryAsync("other", [{
      identifier: "x",
      buttonTitle: "X",
    }]);
    assertEquals((await Notifications.getNotificationCategoriesAsync()).map((c) => c.identifier), [
      "msg",
      "other",
    ]);
    assertEquals(await Notifications.deleteNotificationCategoryAsync("other"), true);
    assertEquals(await Notifications.deleteNotificationCategoryAsync("nope"), false);

    const responses: Any[] = [];
    const sub = Notifications.addNotificationResponseReceivedListener((r) => responses.push(r));
    await settle();
    local.fire("localNotificationActionPerformed", {
      actionId: "reply",
      inputValue: "ok",
      notification: { id: 5, title: "T", extra: { __expoIdentifier: "chat-5", k: 1 } },
    });
    sub.remove();
    assertEquals(responses.length, 1);
    assertEquals(responses[0].actionIdentifier, "reply");
    assertEquals(responses[0].userText, "ok");
    assertEquals(responses[0].notification.request.identifier, "chat-5");
    assertEquals(responses[0].notification.request.content.data, { k: 1 });
  }, { localStorage });
  const registered = local.calls.filter(([m]) => m === "registerActionTypes").map(([, a]) =>
    (a as Any).types
  );
  assertEquals(registered.at(-1), [{
    id: "msg",
    actions: [
      {
        id: "reply",
        title: "Reply",
        foreground: true,
        destructive: false,
        requiresAuthentication: false,
        input: true,
        inputButtonTitle: "Send",
        inputPlaceholder: "…",
      },
      {
        id: "later",
        title: "Later",
        foreground: false,
        destructive: false,
        requiresAuthentication: false,
      },
    ],
    iosHiddenPreviewsBodyPlaceholder: "Message",
  }], "the whole set is registered each time (the plugin replaces it)");
  resetPushForTesting();
  resetLocalNotificationsForTesting();
});

// ---- expo-secure-store requireAuthentication / expo-linking openSettings --------------------------------

Deno.test("expo-secure-store: requireAuthentication gates reads; canUseBiometricAuthentication", async () => {
  const stored = new Map<string, string>();
  const storage = fakePlugin(["internalGetItem", "internalSetItem", "internalRemoveItem"]);
  storage.plugin.internalSetItem = (a: Any) =>
    Promise.resolve(void stored.set(a.prefixedKey, a.data));
  storage.plugin.internalGetItem = (a: Any) => Promise.resolve({ data: stored.get(a.prefixedKey) });
  const bio = fakePlugin(BIO_METHODS);
  await inShell(
    "ios",
    { SecureStorage: storage.plugin, BiometricAuthNative: bio.plugin },
    async () => {
      assertEquals(SecureStore.canUseBiometricAuthentication(), true);
      await SecureStore.setItemAsync("pin", "1234", { requireAuthentication: true });
      assertEquals(
        await SecureStore.getItemAsync("pin", { authenticationPrompt: "Unlock your PIN" }),
        "1234",
      );
    },
  );
  assertEquals((bio.calls[0][1] as Any).reason, "Unlock your PIN");
  assertEquals(SecureStore.canUseBiometricAuthentication(), false);
});

Deno.test("expo-linking: openSettings opens the app's settings in the shell", async () => {
  const settings = fakePlugin(["open"]);
  await inShell("android", { DenextSettings: settings.plugin }, () => Linking.openSettings());
  assertEquals(settings.calls, [["open", undefined]]);
  await withGlobals({}, async () => {
    await assertRejects(() => Linking.openSettings(), Error, "web page cannot");
  });
});
