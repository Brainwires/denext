// denext/expo/* — the expo-* API shims over denext/mobile and web APIs. Each family runs in a
// faked Capacitor shell (`globalThis.Capacitor` with recorder plugins) or against faked web
// globals, asserting the Expo-shaped results and the plugin calls. Every global a test
// installs is restored.

import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { makeDom } from "./helpers/dom.ts";
import * as Haptics from "../src/expo/haptics.ts";
import * as Clipboard from "../src/expo/clipboard.ts";
import * as SecureStore from "../src/expo/secure-store.ts";
import * as Sharing from "../src/expo/sharing.ts";
import * as SplashScreen from "../src/expo/splash-screen.ts";
import * as KeepAwake from "../src/expo/keep-awake.ts";
import * as Network from "../src/expo/network.ts";
import * as Device from "../src/expo/device.ts";
import * as Crypto from "../src/expo/crypto.ts";
import * as Linking from "../src/expo/linking.ts";
import * as WebBrowser from "../src/expo/web-browser.ts";
import * as AuthSession from "../src/expo/auth-session.ts";
import * as Notifications from "../src/expo/notifications.ts";
import * as QuickActions from "../src/expo/quick-actions.ts";
import * as Updates from "../src/expo/updates.ts";
import Constants from "../src/expo/constants.ts";
import { Directory, File, Paths } from "../src/expo/file-system.ts";
import * as ImagePicker from "../src/expo/image-picker.ts";
import * as DocumentPicker from "../src/expo/document-picker.ts";
import * as Camera from "../src/expo/camera.ts";
import * as Font from "../src/expo/font.ts";
import { Asset } from "../src/expo/asset.ts";
import * as Expo from "../src/expo/expo.ts";
import * as Widgets from "../src/expo/widgets.ts";
import * as DevClient from "../src/expo/dev-client.ts";
import withBuildProperties from "../src/expo/build-properties.ts";
import { BlurView } from "../src/expo/blur.ts";
import { GlassView, isGlassEffectAPIAvailable } from "../src/expo/glass-effect.ts";
import { SymbolView } from "../src/expo/symbols.ts";
import { TextInputWrapper } from "../src/expo/paste-input.ts";
import { Image } from "../src/expo/image.ts";
import { AudioPlayer, RecordingPresets } from "../src/expo/audio.ts";
import { VideoPlayer } from "../src/expo/video.ts";
import { FlipType, manipulateAsync, SaveFormat } from "../src/expo/image-manipulator.ts";
import { resetFileSystemForTesting, settled } from "../src/expo/internal/fs.ts";
import { resetPushForTesting } from "../src/mobile/push.ts";
import { resetQuickActionsForTesting } from "../src/mobile/quick-actions.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

/** Install `values` on globalThis for the duration of `fn`, then restore the originals. */
async function withGlobals(
  values: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, { configurable: true, writable: true, value });
  }
  try {
    await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(g, key, desc);
      else delete g[key];
    }
  }
}

/** Run `fn` inside a native iOS shell whose `Plugins` are `plugins`. */
function inShell(
  plugins: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: plugins };
  return withGlobals({ Capacitor, ...extra }, fn);
}

/** A plugin whose methods record `[method, arg]` and resolve `results[method]`. */
function recorder(methods: string[], results: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const plugin: Record<string, (arg?: unknown) => Promise<unknown>> = {};
  for (const m of methods) {
    plugin[m] = (arg?: unknown) => {
      calls.push([m, arg]);
      const r = results[m];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    };
  }
  return { plugin, calls };
}

/** A `localStorage` stand-in. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

// ---- haptics ---------------------------------------------------------------

Deno.test("expo-haptics: every call maps to the Haptics plugin", async () => {
  const methods = ["impact", "notification", "selectionStart", "selectionChanged", "selectionEnd"];
  const cases: Array<[() => Promise<void>, Array<[string, unknown]>]> = [
    [() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light), [["impact", {
      style: "LIGHT",
    }]]],
    [() => Haptics.impactAsync(), [["impact", { style: "MEDIUM" }]]],
    [() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid), [["impact", {
      style: "HEAVY",
    }]]],
    [() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft), [["impact", { style: "LIGHT" }]]],
    [
      () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
      [["notification", { type: "ERROR" }]],
    ],
    [() => Haptics.notificationAsync(), [["notification", { type: "SUCCESS" }]]],
    [
      () => Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Reject),
      [["notification", { type: "ERROR" }]],
    ],
    [() => Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.No_Haptics), []],
  ];
  for (const [call, expected] of cases) {
    const { plugin, calls } = recorder(methods);
    await inShell({ Haptics: plugin }, call);
    assertEquals(calls, expected);
  }
  const { plugin, calls } = recorder(methods);
  await inShell({ Haptics: plugin }, () => Haptics.selectionAsync());
  assertEquals(calls.map(([m]) => m), ["selectionStart", "selectionChanged", "selectionEnd"]);
  await assertRejects(() => Haptics.impactAsync("boom" as Any), TypeError);
});

// ---- clipboard -------------------------------------------------------------

Deno.test("expo-clipboard: strings through the plugin; refusals read as empty/false", async () => {
  const { plugin, calls } = recorder(["read", "write"], { read: { value: "https://x.dev" } });
  await inShell({ Clipboard: plugin }, async () => {
    assertEquals(await Clipboard.setStringAsync("hi"), true);
    assertEquals(await Clipboard.getStringAsync(), "https://x.dev");
    assertEquals(await Clipboard.hasStringAsync(), true);
    assertEquals(await Clipboard.getUrlAsync(), "https://x.dev");
    assertEquals(await Clipboard.hasImageAsync(), false);
  });
  assertEquals(calls[0], ["write", { string: "hi" }]);
  await withGlobals({ navigator: {} }, async () => {
    assertEquals(await Clipboard.getStringAsync(), "");
    assertEquals(await Clipboard.setStringAsync("x"), false);
    assertEquals(await Clipboard.getUrlAsync(), null);
  });
  Clipboard.addClipboardListener(() => {}).remove();
});

// ---- secure-store ----------------------------------------------------------

Deno.test("expo-secure-store: async get/set/delete through SecureStorage; keychainService namespaces", async () => {
  const { plugin, calls } = recorder(
    ["internalGetItem", "internalSetItem", "internalRemoveItem"],
    { internalGetItem: { data: "tok" } },
  );
  await inShell({ SecureStorage: plugin }, async () => {
    await SecureStore.setItemAsync("token", "tok", { keychainService: "auth" });
    assertEquals(await SecureStore.getItemAsync("token"), "tok");
    await SecureStore.deleteItemAsync("token");
    assertEquals(await SecureStore.isAvailableAsync(), true);
  });
  assertEquals(calls.map(([m, a]) => [m, (a as Any).prefixedKey]), [
    ["internalSetItem", "capacitor-storage_auth:token"],
    ["internalGetItem", "capacitor-storage_token"],
    ["internalRemoveItem", "capacitor-storage_token"],
  ]);
  await assertRejects(() => SecureStore.getItemAsync("bad key!"), Error, "invalid key");
  await assertRejects(() => SecureStore.setItemAsync("k", 1 as Any), Error, "must be a string");
  assertEquals("getItem" in SecureStore, false, "the sync API is omitted");
});

// ---- sharing / splash / keep-awake -----------------------------------------

Deno.test("expo-sharing, expo-splash-screen, expo-keep-awake over their plugins", async () => {
  const share = recorder(["share"]);
  const splash = recorder(["hide"]);
  const awake = recorder(["keepAwake", "allowSleep"]);
  await inShell(
    { Share: share.plugin, SplashScreen: splash.plugin, KeepAwake: awake.plugin },
    async () => {
      assertEquals(await Sharing.isAvailableAsync(), true);
      await Sharing.shareAsync("https://x.dev/", { dialogTitle: "Look" });
      assertEquals(await SplashScreen.preventAutoHideAsync(), true);
      await SplashScreen.hideAsync();
      await KeepAwake.activateKeepAwakeAsync("rec");
      await KeepAwake.activateKeepAwakeAsync("rec"); // same tag: one hold
      await KeepAwake.deactivateKeepAwake("rec");
    },
  );
  assertEquals(share.calls, [["share", { url: "https://x.dev/", title: "Look" }]]);
  assertEquals(splash.calls.length, 1);
  assertEquals(awake.calls.map(([m]) => m), ["keepAwake", "allowSleep"]);
  assertEquals(Sharing.getSharedPayloads(), []);
  assertEquals(await Sharing.getResolvedSharedPayloadsAsync(), []);
  assertEquals(Sharing.useIncomingShare().sharedPayloads, []);
});

// ---- network / device ------------------------------------------------------

Deno.test("expo-network: native status mapped to Expo's NetworkState", async () => {
  const { plugin } = recorder(["getStatus", "addListener"], {
    getStatus: { connected: true, connectionType: "wifi" },
  });
  await inShell({ Network: plugin }, async () => {
    assertEquals(await Network.getNetworkStateAsync(), {
      type: Network.NetworkStateType.WIFI,
      isConnected: true,
      isInternetReachable: true,
    });
  });
  await withGlobals({ navigator: { onLine: false } }, async () => {
    assertEquals((await Network.getNetworkStateAsync()).type, Network.NetworkStateType.NONE);
  });
  assertEquals(await Network.getIpAddressAsync(), "0.0.0.0");
});

Deno.test("expo-device: constants are Expo-shaped; getDeviceTypeAsync follows the UA or the plugin", async () => {
  assertEquals(Device.isDevice, true);
  assertEquals(Device.brand, null);
  assertEquals(Device.DeviceType.TABLET, 2);
  const ipad = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)";
  await withGlobals({ navigator: { userAgent: ipad } }, async () => {
    assertEquals(await Device.getDeviceTypeAsync(), Device.DeviceType.TABLET);
  });
  const { plugin } = recorder(["getInfo"], { getInfo: { model: "iPhone15,2" } });
  await inShell({ Device: plugin }, async () => {
    assertEquals(await Device.getDeviceTypeAsync(), Device.DeviceType.PHONE);
  });
});

// ---- crypto ----------------------------------------------------------------

Deno.test("expo-crypto: WebCrypto digests, random bytes and UUIDs", async () => {
  assertEquals(
    await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, "hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  assertEquals(
    await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA1, "hello", {
      encoding: Crypto.CryptoEncoding.BASE64,
    }),
    "qvTGHdzF6KLavt4PO0gs2a6pQ00=",
  );
  assertEquals(
    (await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA512, new Uint8Array([1]))).byteLength,
    64,
  );
  await assertRejects(() => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.MD5, "x"));
  assertEquals(Crypto.getRandomBytes(16).length, 16);
  assertEquals((await Crypto.getRandomBytesAsync(4)).length, 4);
  assertThrows(() => Crypto.getRandomBytes(2048), TypeError);
  assertMatch(Crypto.randomUUID(), /^[0-9a-f-]{36}$/);
});

// ---- linking / web-browser / auth-session ----------------------------------

Deno.test("expo-linking: createURL uses the scheme natively and the origin on the web; parse", async () => {
  const location = { origin: "https://app.test", href: "https://app.test/home?x=1" };
  await withGlobals({ location, __DENEXT_EXPO_CONFIG__: { scheme: "t3code" } }, async () => {
    assertEquals(
      Linking.createURL("/threads/1", { queryParams: { a: "b" } }),
      "https://app.test/threads/1?a=b",
    );
    assertEquals(await Linking.getInitialURL(), "https://app.test/home?x=1");
    assertEquals(Linking.getLinkingURL(), "https://app.test/home?x=1");
    await inShell({}, () => {
      assertEquals(Linking.createURL("threads/1"), "t3code://threads/1");
      assertEquals(
        Linking.createURL("x", { scheme: "other", isTripleSlashed: true }),
        "other:///x",
      );
    });
    assertEquals(Linking.collectManifestSchemes(), ["t3code"]);
    assertEquals(Linking.resolveScheme({}), "t3code");
  });
  assertEquals(Linking.parse("myapp://host/a/b?x=1&x=2&y=3"), {
    scheme: "myapp",
    hostname: "host",
    path: "a/b",
    queryParams: { x: ["1", "2"], y: "3" },
  });
  assertEquals(await Linking.canOpenURL("tel:123"), true);
  assertEquals(await Linking.canOpenURL("myapp://x"), false);
  await assertRejects(() => Linking.openSettings());
});

Deno.test("expo-web-browser: openBrowserAsync → Browser; auth session results mapped", async () => {
  const browser = recorder(["open"]);
  const auth = recorder(["start"], { start: { url: "myapp://cb?code=1" } });
  await inShell({ Browser: browser.plugin, DenextAuthSession: auth.plugin }, async () => {
    assertEquals(await WebBrowser.openBrowserAsync("https://x.dev/"), {
      type: WebBrowser.WebBrowserResultType.OPENED,
    });
    assertEquals(
      await WebBrowser.openAuthSessionAsync("https://auth.test/authorize", "myapp://cb"),
      { type: "success", url: "myapp://cb?code=1" },
    );
  });
  assertEquals(browser.calls, [["open", { url: "https://x.dev/" }]]);
  assertEquals((auth.calls[0][1] as Any).callbackScheme, "myapp");
  const cancelled = recorder(["start"], {
    start: Object.assign(new Error("closed"), { code: "cancelled" }),
  });
  await inShell({ DenextAuthSession: cancelled.plugin }, async () => {
    assertEquals(await WebBrowser.openAuthSessionAsync("https://auth.test/a", "myapp://cb"), {
      type: WebBrowser.WebBrowserResultType.CANCEL,
    });
  });
  assertEquals(WebBrowser.maybeCompleteAuthSession().type, "failed");
});

Deno.test("expo-auth-session: redirect URI, PKCE authorization URL, return-URL parsing", async () => {
  await withGlobals({ location: { origin: "https://app.test" } }, () => {
    assertEquals(AuthSession.makeRedirectUri({ path: "cb" }), "https://app.test/cb");
    assertEquals(
      AuthSession.makeRedirectUri({ path: "cb", preferLocalhost: true }),
      "https://localhost/cb",
    );
  });
  const request = new AuthSession.AuthRequest({
    clientId: "app",
    redirectUri: "myapp://cb",
    scopes: ["openid", "profile"],
    state: "s1",
  });
  const url = new URL(
    await request.makeAuthUrlAsync({ authorizationEndpoint: "https://auth.test/a" }),
  );
  assertEquals(url.searchParams.get("client_id"), "app");
  assertEquals(url.searchParams.get("scope"), "openid profile");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertMatch(url.searchParams.get("code_challenge")!, /^[\w-]{43}$/);
  assert(request.codeVerifier && request.codeVerifier.length === 64);
  const ok = request.parseReturnUrl("myapp://cb?code=c1&state=s1");
  assertEquals(ok.type === "success" && ok.params.code, "c1");
  const mismatch = request.parseReturnUrl("myapp://cb?code=c1&state=nope");
  assertEquals(mismatch.type === "error" && mismatch.errorCode, "state_mismatch");
  const denied = request.parseReturnUrl("myapp://cb?error=access_denied&state=s1");
  assertEquals(denied.type === "error" && denied.error?.code, "access_denied");
  const implicit = request.parseReturnUrl("myapp://cb#access_token=t&expires_in=60&state=s1");
  assertEquals(implicit.type === "success" && implicit.authentication?.accessToken, "t");
  assert(AuthSession.TokenResponse.isTokenFresh({ expiresIn: 3600, issuedAt: Date.now() / 1000 }));
});

// ---- notifications ---------------------------------------------------------

Deno.test("expo-notifications: permissions, received notifications and channels", async () => {
  resetPushForTesting();
  const listeners = new Map<string, (e: unknown) => void>();
  const created: unknown[] = [];
  const push: Record<string, unknown> = {
    ...recorder(["checkPermissions", "requestPermissions", "register"], {
      checkPermissions: { receive: "granted" },
    }).plugin,
    createChannel: (c?: unknown) => Promise.resolve(void created.push(c)),
    addListener: (name: string, fn: (e: unknown) => void) => {
      listeners.set(name, fn);
      return { remove: () => listeners.delete(name) };
    },
  };
  await inShell({ PushNotifications: push }, async () => {
    const perms = await Notifications.getPermissionsAsync();
    assertEquals([perms.status, perms.granted], [Notifications.PermissionStatus.GRANTED, true]);
    assertEquals((await Notifications.requestPermissionsAsync()).granted, true);
    const seen: Notifications.Notification[] = [];
    const sub = Notifications.addNotificationReceivedListener((n) => seen.push(n));
    await new Promise((r) => setTimeout(r, 0));
    listeners.get("pushNotificationReceived")!({ id: "n1", title: "T", body: "B", data: { a: 1 } });
    assertEquals(seen[0].request.identifier, "n1");
    assertEquals(seen[0].request.content.title, "T");
    assertEquals(seen[0].request.content.data, { a: 1 });
    sub.remove();
    await Notifications.setNotificationChannelAsync("agent", {
      name: "Agent",
      importance: Notifications.AndroidImportance.HIGH,
    });
  });
  assertEquals((created[0] as Any).importance, 4, "Expo HIGH → Capacitor importance 4");
  await withGlobals({ Notification: { permission: "default" } }, async () => {
    assertEquals((await Notifications.getPermissionsAsync()).status, "undetermined");
  });
  await assertRejects(() => Notifications.getDevicePushTokenAsync());
  resetPushForTesting();
});

// ---- quick-actions / updates / constants -----------------------------------

Deno.test("expo-quick-actions: setItems → AppShortcuts; the listener gets the full action", async () => {
  resetQuickActionsForTesting();
  let click: ((e: unknown) => void) | undefined;
  const set = recorder(["set", "clear"]);
  const plugin = {
    ...set.plugin,
    addListener: (_: string, fn: (e: unknown) => void) => ((click = fn), { remove() {} }),
  };
  await inShell({ AppShortcuts: plugin }, async () => {
    await QuickActions.setItems([
      { id: "new", title: "New", icon: "symbol:square.and.pencil", params: { href: "/new" } },
    ]);
    assertEquals(await QuickActions.isSupported(), true);
    const got: QuickActions.Action[] = [];
    const sub = QuickActions.addListener((a) => got.push(a));
    click!({ shortcutId: "new" });
    assertEquals(got[0].params, { href: "/new" });
    sub.remove();
  });
  assertEquals(set.calls[0], ["set", {
    shortcuts: [{
      id: "new",
      title: "New",
      iosIcon: "square.and.pencil",
      androidIcon: "square.and.pencil",
    }],
  }]);
  assertEquals(QuickActions.initial, undefined);
  resetQuickActionsForTesting();
});

Deno.test("expo-updates is disabled off the shell; expo-constants reads the config global", async () => {
  assertEquals(Updates.isEnabled, false);
  await assertRejects(() => Updates.checkForUpdateAsync(), Error, "not enabled");
  assertEquals((await Updates.fetchUpdateAsync()).isNew, false);
  assertEquals(await Updates.readLogEntriesAsync(), []);
  await withGlobals(
    { __DENEXT_EXPO_CONFIG__: { name: "T3", extra: { eas: { projectId: "p" } } } },
    () => {
      assertEquals(Constants.expoConfig?.name, "T3");
      assertEquals(Constants.easConfig, { projectId: "p" });
      assertEquals(Constants.appOwnership, null);
      assert("web" in Constants.platform);
    },
  );
  assertEquals(Constants.expoConfig, null);
});

// ---- file-system -----------------------------------------------------------

Deno.test("expo-file-system: sync writes reach the plugin in order; the index survives a reload", async () => {
  resetFileSystemForTesting();
  const disk = new Map<string, string>();
  const key = (o: Any) => `${o.directory}/${o.path}`;
  const Filesystem = {
    writeFile: (o: Any) => Promise.resolve(void disk.set(key(o), o.data)),
    readFile: (o: Any) =>
      disk.has(key(o))
        ? Promise.resolve({ data: disk.get(key(o)) })
        : Promise.reject(new Error("nope")),
    deleteFile: (o: Any) => Promise.resolve(void disk.delete(key(o))),
  };
  await inShell({ Filesystem }, async () => {
    const dir = new Directory(Paths.document, "drafts");
    dir.create({ idempotent: true, intermediates: true });
    dir.create({ idempotent: true });
    const file = new File(dir, "a.json");
    assertEquals(file.uri, "file:///documents/drafts/a.json");
    assertEquals(file.exists, false);
    file.write('{"n":1}');
    assertEquals([file.exists, file.size, file.textSync()], [true, 7, '{"n":1}']);
    file.write(new Uint8Array([33]), { append: true });
    assertEquals(await file.text(), '{"n":1}!');
    assertEquals(dir.list().map((e) => e.name), ["a.json"]);
    new File(dir, "b.bin").write("AAEC", { encoding: "base64" });
    await settled();
    assertEquals(disk.get("DOCUMENTS/drafts/b.bin"), "AAEC");

    resetFileSystemForTesting(); // a reload: the cache is gone, the index is in localStorage
    const again = new File(Paths.document, "drafts", "a.json");
    assertEquals(again.exists, true);
    assertThrows(() => again.textSync(), Error, "not loaded");
    assertEquals(await again.text(), '{"n":1}!');
    assertEquals(new Directory(Paths.document, "drafts").list().length, 2);
    again.rename("c.json");
    assertEquals(again.name, "c.json");
    await settled();
    assert(disk.has("DOCUMENTS/drafts/c.json") && !disk.has("DOCUMENTS/drafts/a.json"));
    new Directory(Paths.document, "drafts").delete();
    await settled();
    assertEquals(disk.size, 0);
    assertThrows(() => again.create(), Error, "parent folder");
  }, { localStorage: memoryStorage() });
  resetFileSystemForTesting();
});

// ---- pickers / camera ------------------------------------------------------

Deno.test("expo-image-picker / expo-document-picker: Expo results from the native pickers", async () => {
  const camera = recorder(["getPhoto"], {
    getPhoto: { webPath: "capacitor://x/p.jpg", format: "jpeg" },
  });
  const picker = recorder(["pickFiles"], {
    pickFiles: {
      files: [{ name: "a.pdf", mimeType: "application/pdf", size: 3, path: "/tmp/a.pdf" }],
    },
  });
  const convertFileSrc = (p: string) => `capacitor://localhost/_capacitor_file_${p}`;
  await withGlobals({
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      convertFileSrc,
      Plugins: { Camera: camera.plugin, FilePicker: picker.plugin },
    },
  }, async () => {
    const image = await ImagePicker.launchImageLibraryAsync({ quality: 0.5 });
    assertEquals(image.canceled, false);
    assertEquals(image.assets?.[0].uri, "capacitor://x/p.jpg");
    assertEquals(image.assets?.[0].mimeType, "image/jpeg");
    const doc = await DocumentPicker.getDocumentAsync({ type: "application/pdf" });
    assertEquals(doc.assets?.[0].uri, "capacitor://localhost/_capacitor_file_/tmp/a.pdf");
    assertEquals(doc.assets?.[0].name, "a.pdf");
  });
  assertEquals((camera.calls[0][1] as Any).source, "PHOTOS");
  assertEquals((camera.calls[0][1] as Any).quality, 50);
  assertEquals((picker.calls[0][1] as Any).types, ["application/pdf"]);
  assertEquals((await ImagePicker.getCameraPermissionsAsync()).granted, true);
});

Deno.test("expo-camera: permissions follow the scanner plugin or the browser", async () => {
  const scanner = recorder(["scanBarcode"]);
  await inShell({ CapacitorBarcodeScanner: scanner.plugin }, async () => {
    assertEquals((await Camera.getCameraPermissionsAsync()).status, "granted");
  });
  const permissions = { query: () => Promise.resolve({ state: "denied" }) };
  await withGlobals({ navigator: { permissions } }, async () => {
    const response = await Camera.getCameraPermissionsAsync();
    assertEquals([response.status, response.canAskAgain], ["denied", false]);
  });
  await assertRejects(() => Camera.scanFromURLAsync("https://x/qr.png"), Error, "BarcodeDetector");
});

// ---- font / asset / expo core / stubs --------------------------------------

Deno.test("expo-font loads through FontFace; expo-asset wraps bundled URLs", async () => {
  const added: unknown[] = [];
  class FakeFontFace {
    constructor(readonly family: string, readonly source: string, readonly opts: unknown) {}
    load() {
      return Promise.resolve(this);
    }
  }
  const document = { fonts: { add: (f: unknown) => added.push(f), delete: () => true } };
  await withGlobals({ FontFace: FakeFontFace, document }, async () => {
    await Font.loadAsync({ Inter: "/assets/inter.ttf" });
    assert(Font.isLoaded("Inter"));
    assertEquals((added[0] as Any).source, 'url("/assets/inter.ttf")');
    await Font.unloadAllAsync();
    assertEquals(Font.getLoadedFonts(), []);
  });
  const asset = await Asset.fromModule("/assets/logo.png").downloadAsync();
  assertEquals([asset.name, asset.type, asset.localUri], ["logo", "png", "/assets/logo.png"]);
  assertThrows(() => Asset.fromModule(12), TypeError, "numeric");
});

Deno.test("expo core, widgets, dev-client and build-properties answer as Expo's web build", async () => {
  assertThrows(() => Expo.requireNativeModule("ExpoThing"), Error, "Cannot find native module");
  assertEquals(Expo.requireOptionalNativeModule("ExpoThing"), null);
  assertEquals((Expo.requireNativeView("V") as Any)({}), null);
  class Mod extends Expo.NativeModule<{ change: (v: number) => void }> {}
  const mod = Expo.registerWebModule(Mod);
  const seen: number[] = [];
  const sub = mod.addListener("change", (v) => seen.push(v));
  mod.emit("change", 3);
  sub.remove();
  mod.emit("change", 4);
  assertEquals(seen, [3]);
  assertEquals(Expo.isRunningInExpoGo(), false);
  const fetched: unknown[] = [];
  const fakeFetch = (u: unknown) => {
    fetched.push(u);
    return Promise.resolve(new Response("ok"));
  };
  await withGlobals({ fetch: fakeFetch }, async () => {
    await Expo.fetch("https://x/");
  });
  assertEquals(fetched, ["https://x/"]);

  const live = Widgets.createLiveActivity("Agent", () => null);
  assertEquals(live.getInstances(), []);
  assertThrows(() => live.start({}), Error, "DenextLiveActivity plugin");
  Widgets.createWidget("W", () => null).reload();
  await DevClient.registerDevMenuItems([]);
  const config = { name: "x" };
  assertEquals(withBuildProperties(config, { ios: {} }), config);
});

// ---- components ------------------------------------------------------------

Deno.test("expo view shims render DOM views with the CSS they stand for", () => {
  const blur = BlurView({
    intensity: 50,
    tint: "dark",
    style: [{ paddingHorizontal: 4 }, null],
  }) as VNode;
  assertEquals(blur.type, "div");
  const style = (blur.props as Any).style;
  assertEquals([style.backdropFilter, style.paddingLeft, style.paddingRight], ["blur(10px)", 4, 4]);
  assertMatch(style.backgroundColor, /^rgba\(25,25,25,/);
  assertEquals(isGlassEffectAPIAvailable(), false);
  const glass = GlassView({ glassEffectStyle: "none", tintColor: "red" }) as VNode;
  assertEquals((glass.props as Any).style.backdropFilter, undefined);
  const symbol = SymbolView({ name: "checkmark", size: 18 }) as VNode;
  assertEquals([(symbol.props as Any).style.width, (symbol.props as Any)["data-symbol"]], [
    18,
    "checkmark",
  ]);
  const fallback = h("b", null);
  assertEquals(SymbolView({ name: "x", fallback }), fallback);
  const pasted: unknown[] = [];
  const wrapper = TextInputWrapper({ onPaste: (p) => pasted.push(p) }) as VNode;
  const data = { files: [], getData: () => "hello" };
  (wrapper.props as Any).onPaste({ clipboardData: data });
  assertEquals(pasted, [{ type: "text", value: "hello" }]);
});

Deno.test("expo-image renders an <img> with object-fit from contentFit", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(
    h(Image as Any, { source: { uri: "https://x/a.png" }, contentFit: "contain", alt: "A" }),
  );
  flushSync();
  const img = (container as Any).firstChild;
  assertEquals(img.tagName.toLowerCase(), "img");
  assertEquals(img.getAttribute("src"), "https://x/a.png");
  assertEquals(img.getAttribute("alt"), "A");
  root.unmount?.();
});

Deno.test("expo-audio / expo-video players report idle status before any media loads", () => {
  const audio = new AudioPlayer({ uri: "https://x/a.mp3" });
  assertEquals([audio.playing, audio.currentStatus.playbackState, audio.duration], [
    false,
    "loading",
    0,
  ]);
  audio.remove();
  assertEquals(RecordingPresets.HIGH_QUALITY.web?.mimeType, "audio/webm");
  const video = new VideoPlayer(null);
  assertEquals([video.status, video.playing, video.currentTime], ["idle", false, 0]);
});

Deno.test("expo-image-manipulator: actions run in order on a canvas; the result is a blob: URL", async () => {
  const ops: string[] = [];
  const canvas = () => {
    const c: Any = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_s: unknown, ...a: number[]) =>
          ops.push(`draw ${c.width}x${c.height} ${a.join(",")}`),
        translate: (x: number, y: number) => ops.push(`translate ${x},${y}`),
        rotate: () => ops.push("rotate"),
        scale: (x: number, y: number) => ops.push(`scale ${x},${y}`),
        fillRect: () => ops.push("fill"),
      }),
      toBlob: (cb: (b: Blob) => void, type: string) => cb(new Blob(["img"], { type })),
    };
    return c;
  };
  class FakeImage {
    naturalWidth = 400;
    naturalHeight = 200;
    crossOrigin = "";
    src = "";
    decode() {
      return Promise.resolve();
    }
  }
  await withGlobals({ document: { createElement: canvas }, Image: FakeImage }, async () => {
    const result = await manipulateAsync("https://x/a.png", [
      { resize: { width: 200 } },
      { flip: FlipType.Horizontal },
      { crop: { originX: 10, originY: 0, width: 50, height: 50 } },
      { extent: { width: 60, height: 60, backgroundColor: "#fff" } },
      { rotate: 90 },
    ], { format: SaveFormat.PNG, base64: true });
    assertEquals([result.width, result.height], [60, 60]);
    assertMatch(result.uri, /^blob:/);
    assertEquals(result.base64, "aW1n");
    URL.revokeObjectURL(result.uri);
  });
  assert(ops.includes("draw 200x100 0,0,200,100"), "resize keeps the aspect ratio");
  assert(ops.includes("scale -1,1") && ops.includes("fill") && ops.includes("rotate"));
  await assertRejects(
    () =>
      withGlobals(
        { document: { createElement: canvas }, Image: FakeImage },
        () => manipulateAsync("https://x/a.png", [{ bogus: 1 } as Any]),
      ),
    TypeError,
    "unknown action",
  );
});
