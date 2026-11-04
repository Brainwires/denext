// denext/mobile's permission API (checkPermission / requestPermission / usePermission /
// openAppSettings), biometrics (isBiometricAvailable / authenticateBiometric) and the
// biometric-gated secureStore. Each runs inside a faked Capacitor shell (`globalThis.Capacitor`
// with the plugins' native methods under `Plugins`) and on its web path. Every global a test
// installs is restored.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  authenticateBiometric,
  checkPermission,
  isBiometricAvailable,
  openAppSettings,
  requestPermission,
  secureStore,
  usePermission,
} from "../src/mobile/mod.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  Target,
  withGlobals,
} from "./helpers/mobile-fakes.ts";
import {
  SETTINGS_ANDROID_FILES,
  SETTINGS_IOS_FILES,
  SETTINGS_TEMPLATE_VERSION,
} from "../src/build/settings-native-templates.ts";

const PERMISSION_METHODS = ["checkPermissions", "requestPermissions"];
const BIO_METHODS = ["checkBiometry", "internalAuthenticate"];

/** An Error carrying a plugin `code`. */
function pluginError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A plugin whose check / request answers come from `states` in turn. */
function statefulPlugin(check: Record<string, unknown>, request: Record<string, unknown>) {
  return fakePlugin(PERMISSION_METHODS, { checkPermissions: check, requestPermissions: request });
}

// ---- checkPermission / requestPermission ---------------------------------------------------

Deno.test("checkPermission: native states normalize (denied → blocked, limited, rationale)", async () => {
  const camera = statefulPlugin({ camera: "denied", photos: "limited" }, {});
  await inShell("ios", { Camera: camera.plugin }, async () => {
    assertEquals(await checkPermission("camera"), "blocked");
    assertEquals(await checkPermission("photos"), "limited");
  });
  const geo = statefulPlugin({ location: "prompt-with-rationale", coarseLocation: "prompt" }, {});
  await inShell("android", { Geolocation: geo.plugin }, async () => {
    assertEquals(await checkPermission("location"), "prompt-with-rationale");
  });
  const coarse = statefulPlugin({ location: "denied", coarseLocation: "granted" }, {});
  await inShell("android", { Geolocation: coarse.plugin }, async () => {
    assertEquals(await checkPermission("location"), "limited");
  });
  const local = statefulPlugin({ display: "granted" }, {});
  const push = statefulPlugin({ receive: "denied" }, {});
  await inShell(
    "ios",
    { LocalNotifications: local.plugin, PushNotifications: push.plugin },
    async () => {
      assertEquals(await checkPermission("notifications"), "granted", "local notifications first");
    },
  );
  await inShell("ios", { PushNotifications: push.plugin }, async () => {
    assertEquals(await checkPermission("notifications"), "blocked");
  });
  const calendar = statefulPlugin({ readCalendar: "denied", writeCalendar: "granted" }, {});
  const contacts = statefulPlugin({ contacts: "prompt" }, {});
  await inShell("ios", { Calendar: calendar.plugin, Contacts: contacts.plugin }, async () => {
    assertEquals(await checkPermission("calendar"), "limited");
    assertEquals(await checkPermission("contacts"), "prompt");
  });
});

Deno.test("requestPermission: prompts only when undecided; Android's refusal reads denied", async () => {
  const camera = statefulPlugin({ camera: "prompt" }, { camera: "granted" });
  await inShell("ios", { Camera: camera.plugin }, async () => {
    assertEquals(await requestPermission("camera"), "granted");
  });
  assertEquals(camera.calls, [
    ["checkPermissions", undefined],
    ["requestPermissions", { permissions: ["camera"] }],
  ]);

  const android = statefulPlugin({ location: "prompt" }, { location: "prompt-with-rationale" });
  await inShell("android", { Geolocation: android.plugin }, async () => {
    assertEquals(await requestPermission("location"), "denied", "may ask again");
  });
  assertEquals(android.calls[1], ["requestPermissions", undefined]);

  const ios = statefulPlugin({ camera: "prompt" }, { camera: "denied" });
  await inShell("ios", { Camera: ios.plugin }, async () => {
    assertEquals(await requestPermission("camera"), "blocked", "iOS never prompts again");
  });

  const decided = statefulPlugin({ camera: "denied" }, { camera: "granted" });
  await inShell("ios", { Camera: decided.plugin }, async () => {
    assertEquals(await requestPermission("camera"), "blocked");
  });
  assertEquals(decided.calls.length, 1, "a blocked permission is not re-requested");
});

Deno.test("permissions: web path (Permissions API, Notification, getUserMedia, geolocation)", async () => {
  const states: Record<string, string> = { camera: "prompt", geolocation: "denied" };
  let stopped = 0;
  const navigator = {
    permissions: {
      query: ({ name }: { name: string }) => Promise.resolve({ state: states[name] }),
    },
    mediaDevices: {
      getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: () => stopped++ }] }),
    },
    geolocation: {
      getCurrentPosition: (_ok: unknown, fail: (e: { code: number }) => void) => fail({ code: 1 }),
    },
  };
  const Notification = Object.assign(function () {}, {
    permission: "default",
    requestPermission: () => Promise.resolve("granted"),
  });
  await withGlobals({ navigator, Notification }, async () => {
    assertEquals(await checkPermission("camera"), "prompt");
    assertEquals(await requestPermission("camera"), "granted");
    assertEquals(stopped, 1, "the probe stream is stopped");
    assertEquals(await checkPermission("location"), "denied", "the web's denied stays denied");
    assertEquals(await checkPermission("photos"), "granted", "a file input needs no permission");
    assertEquals(await checkPermission("notifications"), "prompt");
    assertEquals(await requestPermission("notifications"), "granted");
    states.geolocation = "prompt";
    assertEquals(await requestPermission("location"), "denied");
  });
});

Deno.test("permissions: unsupported names reject with a PermissionError", async () => {
  await withGlobals({ navigator: {} }, async () => {
    const err = await assertRejects(
      () => checkPermission("contacts"),
      Error,
      "@capacitor-community",
    );
    assertEquals((err as Any).code, "unsupported");
    await assertRejects(
      () => checkPermission("location-background"),
      Error,
      "mobile add background-location",
    );
    await assertRejects(() => checkPermission("camera"), Error, "mobile add camera");
    await assertRejects(() => checkPermission("biometrics"), Error, "mobile add biometrics");
    await assertRejects(() => checkPermission("nope" as Any), TypeError, "unknown permission");
  });
});

Deno.test("permissions: biometrics maps availability (granted, blocked Face ID, denied)", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["ios", { isAvailable: true, biometryType: 2, biometryTypes: [2] }, "granted"],
    [
      "ios",
      { isAvailable: false, biometryType: 2, biometryTypes: [2], code: "biometryNotAvailable" },
      "blocked",
    ],
    [
      "android",
      { isAvailable: false, biometryType: 3, biometryTypes: [3], code: "biometryNotEnrolled" },
      "denied",
    ],
  ];
  for (const [platform, check, want] of cases) {
    const bio = fakePlugin(BIO_METHODS, { checkBiometry: check });
    await inShell(platform as "ios", { BiometricAuthNative: bio.plugin }, async () => {
      assertEquals(await checkPermission("biometrics"), want);
      assertEquals(await requestPermission("biometrics"), want);
    });
  }
  const none = fakePlugin(BIO_METHODS, {
    checkBiometry: { isAvailable: false, biometryType: 0, biometryTypes: [] },
  });
  await inShell("ios", { BiometricAuthNative: none.plugin }, async () => {
    await assertRejects(() => checkPermission("biometrics"), Error, "no biometric sensor");
  });
});

// ---- openAppSettings -------------------------------------------------------------------------

Deno.test("openAppSettings: DenextSettings natively, app-settings: on iOS without it, else rejects", async () => {
  const settings = fakePlugin(["open"]);
  await inShell("android", { DenextSettings: settings.plugin }, () => openAppSettings());
  assertEquals(settings.calls, [["open", undefined]]);

  const failing = fakePlugin(["open"], { open: new Error("nope") });
  await inShell("ios", { DenextSettings: failing.plugin }, async () => {
    const err = await assertRejects(() => openAppSettings(), Error, "nope");
    assertEquals((err as Any).code, "unavailable");
  });

  const opened: unknown[][] = [];
  await inShell("ios", {}, () => openAppSettings(), {
    open: (...args: unknown[]) => void opened.push(args),
  });
  assertEquals(opened, [["app-settings:", "_blank"]]);

  await inShell("android", {}, async () => {
    await assertRejects(() => openAppSettings(), Error, "mobile add permissions");
  });
  const err = await assertRejects(() => openAppSettings(), Error, "web page cannot");
  assertEquals((err as Any).code, "unsupported");
});

// ---- usePermission ------------------------------------------------------------------------------

Deno.test("usePermission: checks on mount, re-checks on resume, request() updates", async () => {
  const answers = [{ camera: "prompt" }, { camera: "granted" }];
  const camera = fakePlugin(PERMISSION_METHODS, { requestPermissions: { camera: "limited" } });
  camera.plugin.checkPermissions = () => Promise.resolve(answers.shift() ?? { camera: "denied" });
  const doc = Object.assign(new Target(), { visibilityState: "visible" });
  await inShell("ios", { Camera: camera.plugin }, async () => {
    let handle: Any;
    const { root, rerender } = mount(function Probe() {
      handle = usePermission("camera");
      return null;
    });
    await settle();
    rerender();
    assertEquals(handle.status, "prompt");
    doc.fire("pause");
    doc.fire("resume");
    await settle();
    rerender();
    assertEquals(handle.status, "granted", "re-checked when the app came back");
    answers.push({ camera: "prompt" });
    assertEquals(await handle.request(), "limited");
    rerender();
    assertEquals(handle.status, "limited");
    root.unmount();
  }, { document: doc });

  const unsupported: Any[] = [];
  await withGlobals({ navigator: {}, document: doc }, async () => {
    const { root, rerender } = mount(function Probe() {
      unsupported.push(usePermission("contacts"));
      return null;
    });
    await settle();
    rerender();
    const last = unsupported.at(-1);
    assertEquals(last.status, undefined);
    assertEquals(last.error?.code, "unsupported");
    root.unmount();
  });
});

// ---- biometrics ---------------------------------------------------------------------------------

Deno.test("isBiometricAvailable: sensor kinds per platform; unsupported off the shell", async () => {
  const ios = fakePlugin(BIO_METHODS, {
    checkBiometry: { isAvailable: true, biometryType: 2, biometryTypes: [2], deviceIsSecure: true },
  });
  await inShell("ios", { BiometricAuthNative: ios.plugin }, async () => {
    assertEquals(await isBiometricAvailable(), {
      available: true,
      type: "face",
      types: ["face"],
      deviceSecure: true,
    });
  });
  const android = fakePlugin(BIO_METHODS, {
    checkBiometry: {
      isAvailable: false,
      biometryType: 3,
      biometryTypes: [3, 5],
      deviceIsSecure: false,
      code: "biometryNotEnrolled",
    },
  });
  await inShell("android", { BiometricAuthNative: android.plugin }, async () => {
    assertEquals(await isBiometricAvailable(), {
      available: false,
      type: "fingerprint",
      types: ["fingerprint", "iris"],
      deviceSecure: false,
      reason: "not-enrolled",
    });
  });
  const optic = fakePlugin(BIO_METHODS, { checkBiometry: { isAvailable: true, biometryType: 4 } });
  await inShell("ios", { BiometricAuthNative: optic.plugin }, async () => {
    assertEquals((await isBiometricAvailable()).type, "iris", "Optic ID");
  });
  assertEquals(await isBiometricAvailable(), {
    available: false,
    types: [],
    deviceSecure: false,
    reason: "unsupported",
  });
});

Deno.test("authenticateBiometric: passes the options, maps the plugin's error codes", async () => {
  const bio = fakePlugin(BIO_METHODS);
  await inShell("ios", { BiometricAuthNative: bio.plugin }, () =>
    authenticateBiometric({
      reason: "Unlock",
      allowDeviceCredential: true,
      fallbackTitle: "Use passcode",
      cancelTitle: "Not now",
      title: "Sign in",
    }));
  assertEquals(bio.calls, [[
    "internalAuthenticate",
    {
      reason: "Unlock",
      cancelTitle: "Not now",
      allowDeviceCredential: true,
      iosFallbackTitle: "Use passcode",
      androidTitle: "Sign in",
      androidSubtitle: "Unlock",
    },
  ]]);
  const codes: Array<[string, string]> = [
    ["userCancel", "cancelled"],
    ["systemCancel", "cancelled"],
    ["userFallback", "fallback"],
    ["biometryLockout", "lockout"],
    ["biometryNotEnrolled", "not-enrolled"],
    ["biometryNotAvailable", "unavailable"],
    ["passcodeNotSet", "passcode-not-set"],
    ["authenticationFailed", "failed"],
    ["somethingNew", "failed"],
  ];
  for (const [native, code] of codes) {
    const failing = fakePlugin(BIO_METHODS, { internalAuthenticate: pluginError("no", native) });
    await inShell("android", { BiometricAuthNative: failing.plugin }, async () => {
      const err = await assertRejects(() => authenticateBiometric(), Error, "no");
      assertEquals((err as Any).code, code, native);
      assertEquals((err as Any).name, "BiometricError");
    });
  }
  const err = await assertRejects(() => authenticateBiometric(), Error, "mobile add biometrics");
  assertEquals((err as Any).code, "unsupported");
});

// ---- biometric-gated secureStore ----------------------------------------------------------------

Deno.test("secureStore: requireBiometric stores a gated value and asks before reading it", async () => {
  const stored = new Map<string, string>();
  const storage = fakePlugin(["internalGetItem", "internalSetItem", "internalRemoveItem"]);
  storage.plugin.internalSetItem = (arg: Any) => {
    storage.calls.push(["internalSetItem", arg]);
    stored.set(arg.prefixedKey, arg.data);
    return Promise.resolve();
  };
  storage.plugin.internalGetItem = (arg: Any) =>
    Promise.resolve({ data: stored.get(arg.prefixedKey) ?? null });
  const bio = fakePlugin(BIO_METHODS);
  await inShell(
    "ios",
    { SecureStorage: storage.plugin, BiometricAuthNative: bio.plugin },
    async () => {
      await secureStore.set("token", "secret", { requireBiometric: true });
      await secureStore.set("plain", "open");
      assertEquals(await secureStore.get("plain"), "open");
      assertEquals(bio.calls.length, 0, "an ungated value needs no prompt");
      assertEquals(await secureStore.get("token", { reason: "Unlock your account" }), "secret");
      assertEquals(bio.calls, [[
        "internalAuthenticate",
        {
          reason: "Unlock your account",
          cancelTitle: undefined,
          allowDeviceCredential: false,
          iosFallbackTitle: undefined,
          androidTitle: undefined,
          androidSubtitle: "Unlock your account",
        },
      ]]);
    },
  );
  const [gated, plain] = storage.calls.map(([, arg]) => arg as Any);
  assertEquals(gated.access, 4, "whenPasscodeSetThisDeviceOnly");
  assert(gated.data.startsWith("\u0000denext-biometric:"));
  assertEquals(plain.access, 0);

  const refusing = fakePlugin(BIO_METHODS, {
    internalAuthenticate: pluginError("x", "userCancel"),
  });
  await inShell(
    "ios",
    { SecureStorage: storage.plugin, BiometricAuthNative: refusing.plugin },
    async () => {
      const err = await assertRejects(() => secureStore.get("token"), Error);
      assertEquals((err as Any).code, "cancelled");
    },
  );
  await inShell("ios", { SecureStorage: storage.plugin }, async () => {
    await assertRejects(() => secureStore.set("x", "\u0000denext-biometric:spoof"), TypeError);
    const err = await assertRejects(() => secureStore.get("token"), Error);
    assertEquals((err as Any).code, "unsupported", "no biometric plugin: the gate stays shut");
  });
});

/** The secure-storage plugin over a map, as page script reaches it through the bridge. */
function fakeSecureStorage(stored = new Map<string, string>()) {
  const storage = fakePlugin(["internalGetItem", "internalSetItem", "internalRemoveItem"]);
  storage.plugin.internalSetItem = (arg: Any) => {
    storage.calls.push(["internalSetItem", arg]);
    stored.set(arg.prefixedKey, arg.data);
    return Promise.resolve();
  };
  storage.plugin.internalGetItem = (arg: Any) =>
    Promise.resolve({ data: stored.get(arg.prefixedKey) ?? null });
  storage.plugin.internalRemoveItem = (arg: Any) => {
    storage.calls.push(["internalRemoveItem", arg]);
    stored.delete(arg.prefixedKey);
    return Promise.resolve();
  };
  return { ...storage, stored };
}

/** denext's DenextSettings biometric secret store: the value only comes back after a prompt. */
function fakeBiometricStore(refuseWith?: string) {
  const secrets = new Map<string, string>();
  const prompts: Any[] = [];
  const store = fakePlugin([
    "open",
    "biometricSecretSet",
    "biometricSecretGet",
    "biometricSecretDelete",
  ]);
  store.plugin.biometricSecretSet = (arg: Any) => {
    secrets.set(arg.key, arg.value);
    return Promise.resolve();
  };
  store.plugin.biometricSecretGet = (arg: Any) => {
    if (!secrets.has(arg.key)) return Promise.resolve({ value: null });
    prompts.push(arg);
    if (refuseWith) return Promise.reject(pluginError("refused", refuseWith));
    return Promise.resolve({ value: secrets.get(arg.key) });
  };
  store.plugin.biometricSecretDelete = (arg: Any) => {
    secrets.delete(arg.key);
    return Promise.resolve();
  };
  return { ...store, secrets, prompts };
}

Deno.test("secureStore SECURITY (AU6-L5): requireBiometric is kept in the OS-enforced store, never in the page-readable one", async () => {
  const storage = fakeSecureStorage();
  const native = fakeBiometricStore();
  await inShell(
    "ios",
    { SecureStorage: storage.plugin, DenextSettings: native.plugin },
    async () => {
      assertEquals(
        await secureStore.set("token", "secret", { requireBiometric: true }),
        { stored: "keychain" },
      );
      // Page script reading the plain store through the bridge gets nothing.
      const read = await (storage.plugin.internalGetItem as (a: Any) => Promise<Any>)({
        prefixedKey: "capacitor-storage_token",
        sync: false,
      });
      assertEquals(read.data, null, "the gated value is not in the page-readable store");
      assertEquals([...storage.stored.values()].some((v) => v.includes("secret")), false);
      assertEquals(native.secrets.get("token"), "secret");
      assertEquals(native.prompts, [], "storing never prompts");

      assertEquals(await secureStore.get("token", { reason: "Unlock your account" }), "secret");
      assertEquals(native.prompts, [{
        key: "token",
        reason: "Unlock your account",
        allowDeviceCredential: false,
      }]);
      assertEquals(await secureStore.get("missing"), null, "nothing stored: no prompt, null");
      assertEquals(native.prompts.length, 1);

      // A plain value of the same key replaces the gated one; delete clears both stores.
      await secureStore.set("token", "open");
      assertEquals(native.secrets.has("token"), false);
      assertEquals(await secureStore.get("token"), "open");
      await secureStore.set("token", "secret", { requireBiometric: true });
      assertEquals(storage.stored.has("capacitor-storage_token"), false);
      await secureStore.delete("token");
      assertEquals(native.secrets.has("token"), false);
    },
  );

  const refusing = fakeBiometricStore("lockout");
  refusing.secrets.set("token", "secret");
  await inShell(
    "android",
    { SecureStorage: storage.plugin, DenextSettings: refusing.plugin },
    async () => {
      const err = await assertRejects(() => secureStore.get("token"), Error);
      assertEquals((err as Any).code, "lockout");
      assertEquals((err as Any).name, "BiometricError");
    },
  );
});

Deno.test("secureStore SECURITY (AU6-L5): a value an older denext gated in the page moves into the OS-enforced store once opened", async () => {
  const storage = fakeSecureStorage(
    new Map([["capacitor-storage_old", "\u0000denext-biometric:legacy"]]),
  );
  const native = fakeBiometricStore();
  const bio = fakePlugin(BIO_METHODS);
  await inShell(
    "ios",
    {
      SecureStorage: storage.plugin,
      DenextSettings: native.plugin,
      BiometricAuthNative: bio.plugin,
    },
    async () => {
      assertEquals(await secureStore.get("old"), "legacy");
      assertEquals(bio.calls.length, 1, "the legacy value is still gated in the page once");
      assertEquals(native.secrets.get("old"), "legacy");
      assertEquals(storage.stored.has("capacitor-storage_old"), false);
      assertEquals(await secureStore.get("old"), "legacy");
      assertEquals(native.prompts.length, 1, "the next read goes through the native prompt");
    },
  );
});

Deno.test("DenextSettings SECURITY (AU6-L5): the biometric secret store is enforced by the OS", () => {
  const swift = SETTINGS_IOS_FILES["DenextSettingsPlugin.swift"];
  for (const method of ["biometricSecretSet", "biometricSecretGet", "biometricSecretDelete"]) {
    assert(swift.includes(`CAPPluginMethod(name: "${method}"`), method);
  }
  // A Keychain access control the OS checks, read with an evaluated LAContext.
  assert(swift.includes("[.biometryCurrentSet, .or, .devicePasscode]"));
  assert(swift.includes("kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly"));
  assert(swift.includes("query[kSecUseAuthenticationContext as String] = context"));
  assert(swift.includes('static let biometricSecretService = "dev.denext.biometric-secret"'));
  const java = SETTINGS_ANDROID_FILES["DenextSettingsPlugin.java"];
  // An Android Keystore key that needs the user for every use, opened through a CryptoObject.
  assert(java.includes(".setUserAuthenticationRequired(true)"));
  assert(java.includes(".setInvalidatedByBiometricEnrollment(true)"));
  assert(
    java.includes("spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG"),
  );
  assert(java.includes("new BiometricPrompt.CryptoObject(rsa)"));
  assert(java.includes("Cipher unwrap = result.getCryptoObject().getCipher();"));
  assert(SETTINGS_TEMPLATE_VERSION >= 4, "the generation is bumped so an older denext keeps it");
});

Deno.test("secureStore SECURITY (AU6-L5): a shell with the biometric store but no secure-storage plugin reads it back", async () => {
  const native = fakeBiometricStore();
  await inShell("android", { DenextSettings: native.plugin }, async () => {
    assertEquals(
      await secureStore.set("token", "secret", { requireBiometric: true }),
      { stored: "keychain" },
    );
    assertEquals(await secureStore.get("token"), "secret");
    assertEquals(native.prompts.length, 1);
  });
});
