// React Native mode's community-package stand-ins over denext/mobile's native capabilities:
// react-native-permissions, react-native-share, react-native-keychain,
// react-native-haptic-feedback, @react-native-google-signin/google-signin,
// react-native-purchases and react-native-biometrics. Each runs inside a faked Capacitor shell
// (`globalThis.Capacitor` with the plugins' native methods under `Plugins`) and, where it has
// one, on its web path. Every global a test installs is restored.

import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import RNPermissions, {
  check,
  checkLocationAccuracy,
  checkMultiple,
  checkNotifications,
  openPhotoPicker,
  PERMISSIONS,
  request,
  requestMultiple,
  RESULTS,
} from "../src/react-native-compat/permissions.ts";
import Share, { open, shareSingle, Social } from "../src/react-native-compat/share.ts";
import * as Keychain from "../src/react-native-compat/keychain.ts";
import HapticFeedback, {
  HapticFeedbackTypes,
  impact,
  pattern,
  Patterns,
  setEnabled,
  trigger,
  triggerPattern,
} from "../src/react-native-compat/haptic-feedback.ts";
import {
  GoogleSignin,
  GoogleSigninButton,
  isCancelledResponse,
  isErrorWithCode,
  isNoSavedCredentialFoundResponse,
  isSuccessResponse,
  resetGoogleSigninForTesting,
  statusCodes,
} from "../src/react-native-compat/google-signin.ts";
import Purchases, {
  LOG_LEVEL,
  PURCHASES_ERROR_CODE,
  resetPurchasesCompatForTesting,
  UninitializedPurchasesError,
  UnsupportedPlatformError,
} from "../src/react-native-compat/purchases.ts";
import ReactNativeBiometrics, { BiometryTypes } from "../src/react-native-compat/biometrics.ts";
import { resetSocialLoginForTesting } from "../src/mobile/social-login.ts";
import { resetPurchasesForTesting } from "../src/mobile/purchases.ts";
import { type Any, fakePlugin, inShell } from "./helpers/mobile-fakes.ts";

const PERMISSION_METHODS = ["checkPermissions", "requestPermissions"];
const BIO_METHODS = ["checkBiometry", "internalAuthenticate"];

/** A secure-storage plugin backed by a Map. */
function fakeSecureStorage() {
  const stored = new Map<string, string>();
  const storage = fakePlugin(["internalGetItem", "internalSetItem", "internalRemoveItem"]);
  storage.plugin.internalGetItem = (arg: Any) =>
    Promise.resolve({ data: stored.get(arg.prefixedKey) ?? null });
  storage.plugin.internalSetItem = (arg: Any) => {
    stored.set(arg.prefixedKey, arg.data);
    return Promise.resolve();
  };
  storage.plugin.internalRemoveItem = (arg: Any) => {
    stored.delete(arg.prefixedKey);
    return Promise.resolve();
  };
  return { plugin: storage.plugin, stored };
}

/** An Error carrying a plugin `code`. */
function pluginError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

// ---- react-native-permissions --------------------------------------------------------------

Deno.test("permissions: check / request map onto denext's states; other platforms unavailable", async () => {
  const camera = fakePlugin(PERMISSION_METHODS, {
    checkPermissions: { camera: "prompt", photos: "limited" },
    requestPermissions: { camera: "granted" },
  });
  await inShell("ios", { Camera: camera.plugin }, async () => {
    assertEquals(await check(PERMISSIONS.IOS.CAMERA), RESULTS.DENIED, "prompt reads denied");
    assertEquals(await check(PERMISSIONS.IOS.PHOTO_LIBRARY), RESULTS.LIMITED);
    assertEquals(await request(PERMISSIONS.IOS.CAMERA), RESULTS.GRANTED);
    assertEquals(await check(PERMISSIONS.ANDROID.CAMERA), RESULTS.UNAVAILABLE, "other platform");
    assertEquals(await check(PERMISSIONS.IOS.BLUETOOTH), RESULTS.UNAVAILABLE, "no counterpart");
    assertEquals(await check(PERMISSIONS.IOS.MICROPHONE), RESULTS.UNAVAILABLE, "no plugin");
    assertEquals(await checkLocationAccuracy(), "full");
  });
  const blocked = fakePlugin(PERMISSION_METHODS, { checkPermissions: { camera: "denied" } });
  await inShell("android", { Camera: blocked.plugin }, async () => {
    assertEquals(
      await checkMultiple([PERMISSIONS.ANDROID.CAMERA, PERMISSIONS.IOS.CAMERA]),
      {
        [PERMISSIONS.ANDROID.CAMERA]: RESULTS.BLOCKED,
        [PERMISSIONS.IOS.CAMERA]: RESULTS.UNAVAILABLE,
      },
    );
    assertEquals(
      (await requestMultiple([PERMISSIONS.ANDROID.SEND_SMS]))[PERMISSIONS.ANDROID.SEND_SMS],
      RESULTS.UNAVAILABLE,
    );
  });
  const local = fakePlugin(PERMISSION_METHODS, { checkPermissions: { display: "granted" } });
  await inShell("ios", { LocalNotifications: local.plugin }, async () => {
    const response = await checkNotifications();
    assertEquals(response.status, RESULTS.GRANTED);
    assertEquals(response.settings.alert, true);
  });
  await assertRejects(() => openPhotoPicker(), Error, "pickImage");
  assertEquals(RNPermissions.check, check);
  assertEquals(RNPermissions.RESULTS, RESULTS);
});

// ---- react-native-share --------------------------------------------------------------------

Deno.test("share: open maps the outcome, dismissal rejects unless failOnCancel is false", async () => {
  const plugin = fakePlugin(["share"]);
  await inShell("ios", { Share: plugin.plugin }, async () => {
    assertEquals(await open({ title: "T", message: "hi", url: "https://x.dev" }), {
      success: true,
      message: "shared",
    });
    assertEquals(
      await shareSingle({ social: Social.Whatsapp, message: "yo" }),
      { success: true, message: "shared" },
    );
  });
  assertEquals(plugin.calls[0], ["share", { title: "T", text: "hi", url: "https://x.dev" }]);
  const cancelling = fakePlugin(["share"], { share: new Error("Share canceled") });
  await inShell("android", { Share: cancelling.plugin }, async () => {
    await assertRejects(() => open({ message: "a" }), Error, "User did not share");
    assertEquals(await open({ message: "a", failOnCancel: false }), {
      success: false,
      message: "dismissed",
      dismissedAction: true,
    });
  });
  assertEquals(Share.Social.WHATSAPP, "whatsapp");
  assertEquals((await Share.isPackageInstalled("com.whatsapp")).isInstalled, false);
});

// ---- react-native-keychain -----------------------------------------------------------------

Deno.test("keychain: generic + internet credentials in secureStore; services index", async () => {
  const storage = fakeSecureStorage();
  await inShell("ios", { SecureStorage: storage.plugin }, async () => {
    assertEquals(await Keychain.getGenericPassword(), false);
    const result = await Keychain.setGenericPassword("ada", "s3cret", { service: "api" });
    assertEquals(result, { service: "api", storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH });
    await Keychain.setGenericPassword("bob", "pw");
    const creds = await Keychain.getGenericPassword({ service: "api" });
    assert(creds);
    assertEquals([creds.username, creds.password, creds.service], ["ada", "s3cret", "api"]);
    assertEquals(await Keychain.hasGenericPassword({ service: "api" }), true);
    assertEquals((await Keychain.getAllGenericPasswordServices()).sort(), ["api", "default"]);
    assertEquals(await Keychain.resetGenericPassword({ service: "api" }), true);
    assertEquals(await Keychain.hasGenericPassword({ service: "api" }), false);
    assertEquals(await Keychain.getAllGenericPasswordServices(), ["default"]);

    await Keychain.setInternetCredentials("x.dev", "u", "p");
    assertEquals(await Keychain.hasInternetCredentials({ server: "x.dev" }), true);
    const net = await Keychain.getInternetCredentials("x.dev");
    assert(net);
    assertEquals([net.server, net.username, net.password], ["x.dev", "u", "p"]);
    await Keychain.resetInternetCredentials({ server: "x.dev" });
    assertEquals(await Keychain.getInternetCredentials("x.dev"), false);
  });
  await assertRejects(() => Keychain.requestSharedWebCredentials(), Error, "not available");
  assertEquals(Keychain.default.ACCESS_CONTROL.BIOMETRY_ANY, "BiometryAny");
});

Deno.test("keychain: a biometric access control prompts on read; a refusal reads false", async () => {
  const storage = fakeSecureStorage();
  const bio = fakePlugin(BIO_METHODS, {
    checkBiometry: { isAvailable: true, biometryType: 2, deviceIsSecure: true },
  });
  await inShell(
    "ios",
    { SecureStorage: storage.plugin, BiometricAuthNative: bio.plugin },
    async () => {
      await Keychain.setGenericPassword("ada", "pw", {
        accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
      });
      assertEquals(
        (await Keychain.getGenericPassword({
          authenticationPrompt: { description: "Unlock" },
        }) as Any).password,
        "pw",
      );
      const auth = bio.calls.find(([m]) => m === "internalAuthenticate")![1] as Any;
      assertEquals([auth.reason, auth.allowDeviceCredential], ["Unlock", true]);
      assertEquals(await Keychain.getSupportedBiometryType(), Keychain.BIOMETRY_TYPE.FACE_ID);
      assertEquals(await Keychain.isPasscodeAuthAvailable(), true);
      assertEquals(await Keychain.canImplyAuthentication(), true);
      bio.plugin.internalAuthenticate = () => Promise.reject(pluginError("no", "userCancel"));
      assertEquals(await Keychain.getGenericPassword(), false);
      assertEquals(await Keychain.hasGenericPassword(), true, "has does not prompt");
    },
  );
});

// ---- react-native-haptic-feedback ----------------------------------------------------------

const HAPTIC_METHODS = [
  "impact",
  "notification",
  "selectionStart",
  "selectionChanged",
  "selectionEnd",
  "vibrate",
];

Deno.test("haptic-feedback: types map to impacts / notifications; setEnabled gates everything", async () => {
  const haptics = fakePlugin(HAPTIC_METHODS);
  await inShell("ios", { Haptics: haptics.plugin }, async () => {
    trigger(HapticFeedbackTypes.impactHeavy);
    trigger("notificationError");
    HapticFeedback.trigger(HapticFeedbackTypes.noHaptics);
    impact(HapticFeedbackTypes.impactMedium, 0.1);
    setEnabled(false);
    trigger(HapticFeedbackTypes.impactLight);
    setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
  });
  assertEquals(haptics.calls, [
    ["impact", { style: "HEAVY" }],
    ["notification", { type: "ERROR" }],
    ["impact", { style: "LIGHT" }],
  ]);
  assertEquals(pattern("oO.O"), [...Patterns.success]);
  assertEquals(pattern("o-O=o"), [...Patterns.notification]);
  assertEquals(pattern("oO--oO"), [...Patterns.heartbeat]);
  let threw = false;
  try {
    pattern("oX");
  } catch (err) {
    threw = err instanceof TypeError;
  }
  assert(threw, "an invalid character throws");
  const played = fakePlugin(HAPTIC_METHODS);
  await inShell("android", { Haptics: played.plugin }, async () => {
    triggerPattern(pattern("oO"));
    await new Promise((r) => setTimeout(r, 150));
  });
  assertEquals(played.calls, [["impact", { style: "LIGHT" }], ["impact", { style: "HEAVY" }]]);
});

// ---- @react-native-google-signin/google-signin ---------------------------------------------

Deno.test("google-signin: configure + signIn over signInWithGoogle; cancel; silent; web", async () => {
  resetGoogleSigninForTesting();
  resetSocialLoginForTesting();
  const login = fakePlugin(["initialize", "login"], {
    login: {
      result: {
        idToken: "id.tok",
        profile: { id: "g1", email: "a@x.dev", name: "Ada" },
      },
    },
  });
  await inShell("android", { SocialLogin: login.plugin }, async () => {
    assertEquals(await GoogleSignin.signInSilently(), {
      type: "noSavedCredentialFound",
      data: null,
    });
    await assertRejects(() => GoogleSignin.signIn(), Error, "configure");
    GoogleSignin.configure({ webClientId: "web", scopes: ["email"] });
    assertEquals(await GoogleSignin.hasPlayServices(), true);
    const response = await GoogleSignin.signIn();
    assert(isSuccessResponse(response));
    assertEquals(response.data.idToken, "id.tok");
    assertEquals(response.data.user.email, "a@x.dev");
    assertEquals(response.data.scopes, ["email"]);
    assert(GoogleSignin.hasPreviousSignIn());
    assertEquals((await GoogleSignin.getTokens()).idToken, "id.tok");
    assert(isSuccessResponse(await GoogleSignin.signInSilently()));
    await GoogleSignin.signOut();
    assertEquals(GoogleSignin.getCurrentUser(), null);
    assert(isNoSavedCredentialFoundResponse(await GoogleSignin.signInSilently()));
  });
  assertEquals(login.calls[1], ["login", { provider: "google", options: { scopes: ["email"] } }]);
  const cancelling = fakePlugin(["initialize", "login"], {
    login: pluginError("The user canceled the sign-in flow.", "USER_CANCELLED"),
  });
  resetSocialLoginForTesting();
  await inShell("android", { SocialLogin: cancelling.plugin }, async () => {
    const response = await GoogleSignin.signIn();
    assert(isCancelledResponse(response), JSON.stringify(response));
  });
  const err = await assertRejects(() => GoogleSignin.signIn());
  assert(isErrorWithCode(err));
  assertEquals(err.code, statusCodes.PLAY_SERVICES_NOT_AVAILABLE);
  assertEquals(GoogleSigninButton.Size.Wide, 1);
  assertEquals(GoogleSigninButton.Color.Dark, "dark");
  resetGoogleSigninForTesting();
});

// ---- react-native-purchases ----------------------------------------------------------------

const RC_METHODS = [
  "configure",
  "getOfferings",
  "purchasePackage",
  "restorePurchases",
  "getCustomerInfo",
  "logIn",
  "getAppUserID",
  "setLogLevel",
];

const INFO = {
  entitlements: { all: {}, active: {} },
  activeSubscriptions: [],
  originalAppUserId: "u1",
};

const PACKAGE = {
  identifier: "$rc_monthly",
  packageType: "MONTHLY",
  offeringIdentifier: "default",
  product: {
    identifier: "pro",
    title: "Pro",
    description: "",
    price: 1,
    priceString: "$1",
    currencyCode: "USD",
  },
};

Deno.test("purchases: configure-then-call, listeners, raw plugin calls, error mapping", async () => {
  resetPurchasesCompatForTesting();
  resetPurchasesForTesting();
  await assertRejects(() => Purchases.getOfferings(), UninitializedPurchasesError);
  assertEquals(await Purchases.isConfigured(), false);
  const rc = fakePlugin(RC_METHODS, {
    getOfferings: { current: null, all: {} },
    purchasePackage: { productIdentifier: "pro", customerInfo: INFO, transaction: {} },
    getCustomerInfo: { customerInfo: INFO },
    logIn: { customerInfo: INFO, created: true },
    getAppUserID: { appUserID: "u1" },
  });
  await inShell("ios", { Purchases: rc.plugin }, async () => {
    Purchases.configure({ apiKey: "appl_x", appUserID: "u1" });
    assertEquals(await Purchases.isConfigured(), true);
    assertEquals(await Purchases.getOfferings(), { current: null, all: {} });
    const seen: unknown[] = [];
    const listener = (info: unknown) => seen.push(info);
    Purchases.addCustomerInfoUpdateListener(listener);
    assertEquals((await Purchases.purchasePackage(PACKAGE as Any)).productIdentifier, "pro");
    assertEquals((await Purchases.logIn("u2")).created, true);
    assertEquals(await Purchases.getAppUserID(), "u1");
    await Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    assertEquals(seen.length, 2);
    assert(Purchases.removeCustomerInfoUpdateListener(listener));
    await assertRejects(() => Purchases.syncPurchases(), UnsupportedPlatformError);
  });
  assertEquals(rc.calls[0], ["configure", { apiKey: "appl_x", appUserID: "u1" }]);
  assertEquals(rc.calls.find(([m]) => m === "logIn")![1], { appUserID: "u2" });
  assertEquals(rc.calls.find(([m]) => m === "setLogLevel")![1], { level: "DEBUG" });

  resetPurchasesCompatForTesting();
  resetPurchasesForTesting();
  const cancelling = fakePlugin(RC_METHODS, {
    purchasePackage: Object.assign(new Error("Purchase was cancelled."), { code: "1" }),
  });
  await inShell("android", { Purchases: cancelling.plugin }, async () => {
    Purchases.configure({ apiKey: "goog_y" });
    const err = await assertRejects(() => Purchases.purchasePackage(PACKAGE as Any)) as Any;
    assertEquals([err.code, err.userCancelled], [
      PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR,
      true,
    ]);
  });
  resetPurchasesCompatForTesting();
  resetPurchasesForTesting();
  Purchases.configure({ apiKey: "k" });
  const web = await assertRejects(() => Purchases.getCustomerInfo());
  assertInstanceOf(web, UnsupportedPlatformError);
  assertEquals(Purchases.PACKAGE_TYPE.MONTHLY, "MONTHLY");
  resetPurchasesCompatForTesting();
});

// ---- react-native-biometrics ---------------------------------------------------------------

Deno.test("biometrics: sensor, simple prompt, and a WebCrypto signing key in secureStore", async () => {
  const storage = fakeSecureStorage();
  const bio = fakePlugin(BIO_METHODS, {
    checkBiometry: { isAvailable: true, biometryType: 2, deviceIsSecure: true },
  });
  await inShell(
    "ios",
    { SecureStorage: storage.plugin, BiometricAuthNative: bio.plugin },
    async () => {
      const rnb = new ReactNativeBiometrics({ allowDeviceCredentials: true });
      assertEquals(await rnb.isSensorAvailable(), { available: true, biometryType: "FaceID" });
      assertEquals(await rnb.simplePrompt({ promptMessage: "Confirm" }), { success: true });
      assertEquals((await rnb.biometricKeysExist()).keysExist, false);
      const { publicKey } = await rnb.createKeys();
      assertEquals((await rnb.biometricKeysExist()).keysExist, true);
      const signed = await rnb.createSignature({ promptMessage: "Sign", payload: "hello" });
      assert(signed.success && signed.signature);
      const key = await crypto.subtle.importKey(
        "spki",
        Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0)),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      assert(
        await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          Uint8Array.from(atob(signed.signature), (c) => c.charCodeAt(0)),
          new TextEncoder().encode("hello"),
        ),
        "the signature verifies against the public key",
      );
      bio.plugin.internalAuthenticate = () => Promise.reject(pluginError("no", "userCancel"));
      assertEquals((await rnb.simplePrompt({ promptMessage: "x" })).success, false);
      assertEquals(
        (await rnb.createSignature({ promptMessage: "x", payload: "y" })).success,
        false,
      );
      assertEquals(await rnb.deleteKeys(), { keysDeleted: true });
    },
  );
  const android = fakePlugin(BIO_METHODS, {
    checkBiometry: { isAvailable: true, biometryType: 3, deviceIsSecure: true },
  });
  await inShell("android", { BiometricAuthNative: android.plugin }, async () => {
    assertEquals(
      (await new ReactNativeBiometrics().isSensorAvailable()).biometryType,
      BiometryTypes.Biometrics,
    );
  });
  assertEquals((await new ReactNativeBiometrics().isSensorAvailable()).available, false, "web");
});
