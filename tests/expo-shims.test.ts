// denext/expo/* — the expo-* API shims over denext/mobile and web APIs. Each family runs in a
// faked Capacitor shell (`globalThis.Capacitor` with recorder plugins) or against faked web
// globals, asserting the Expo-shaped results and the plugin calls. Every global a test
// installs is restored.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
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
import {
  AudioPlayer,
  AudioPlaylist,
  AudioRecorder,
  AudioStream,
  NativeAudioModule,
  RecordingPresets,
} from "../src/expo/audio.ts";
import { createVideoPlayer, useVideoPlayer, VideoPlayer } from "../src/expo/video.ts";
import { ImageNativeModule } from "../src/expo/image.ts";
import * as FileSystem from "../src/expo/file-system.ts";
import * as Legacy from "../src/expo/file-system-legacy.ts";
import { deepEqual } from "../src/expo/sqlite.ts";
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

Deno.test("expo-secure-store: on the web it is not available, and a requireAuthentication value is refused, not stored in IndexedDB", async () => {
  let opened = 0;
  const indexedDB = {
    open() {
      opened++;
      throw new Error("IndexedDB opened");
    },
  };
  await withGlobals({ indexedDB }, async () => {
    assertEquals(await SecureStore.isAvailableAsync(), false, "plain IndexedDB is not secret");
    await assertRejects(
      () => SecureStore.setItemAsync("token", "tok", { requireAuthentication: true }),
      TypeError,
      "requireBiometric needs a secret store",
    );
    assertEquals(opened, 0, "the gated value never reached the plaintext store");
    // An ungated value still takes the documented web fallback.
    await assertRejects(() => SecureStore.setItemAsync("plain", "v"), Error, "IndexedDB opened");
    assertEquals(opened, 1);
  });
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
  // An https redirect can never end a native session: refused up front, nothing started.
  const never = recorder(["start"], { start: new Promise(() => {}) });
  await inShell({ DenextAuthSession: never.plugin }, async () => {
    await assertRejects(
      () => WebBrowser.openAuthSessionAsync("https://auth.test/a", "https://app.test/cb"),
      TypeError,
      "must use the app's custom scheme",
    );
  });
  assertEquals(never.calls, []);
});

Deno.test("expo-web-browser: maybeCompleteAuthSession completes only the auth-session popup on the expected redirect", async () => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const posted: unknown[] = [];
  const page = (href: string, name: string | undefined) => ({
    localStorage,
    name,
    location: { origin: "https://app.test", href },
    opener: { postMessage: (m: unknown) => void posted.push(m) },
    close: () => {},
  });
  // openAuthSessionAsync on the web remembers the redirect (the popup itself is not opened here).
  await withGlobals({ localStorage, open: () => null, Capacitor: undefined }, async () => {
    await assertRejects(() =>
      WebBrowser.openAuthSessionAsync("https://auth.test/a", "https://app.test/cb")
    );
  });
  assertEquals(store.get("denext-auth-session:redirect"), "https://app.test/cb");
  // Not the popup: refused, whatever the URL.
  await withGlobals(page("https://app.test/cb?code=1", "x"), () => {
    assertEquals(
      WebBrowser.maybeCompleteAuthSession().message,
      "No auth session is currently in progress",
    );
  });
  // The popup on another page of the origin: refused.
  await withGlobals(page("https://app.test/other?code=1", "denext-auth-session"), () => {
    assertStringIncludes(WebBrowser.maybeCompleteAuthSession().message, "do not match");
  });
  assertEquals(posted, []);
  // The popup on the redirect: completes, and the remembered redirect is cleared.
  await withGlobals(page("https://app.test/cb?code=2", "denext-auth-session"), () => {
    assertEquals(WebBrowser.maybeCompleteAuthSession(), { type: "success", message: "" });
  });
  assertEquals(posted.length, 1);
  assertEquals(store.has("denext-auth-session:redirect"), false);
  // No remembered redirect: refused, unless skipRedirectCheck.
  await withGlobals(page("https://app.test/elsewhere?code=3", "denext-auth-session"), () => {
    assertStringIncludes(WebBrowser.maybeCompleteAuthSession().message, "redirect URL");
    assertEquals(
      WebBrowser.maybeCompleteAuthSession({ skipRedirectCheck: true }).type,
      "success",
    );
  });
  assertEquals(posted.length, 2);
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

// ---- file-system/legacy ----------------------------------------------------

/** The legacy API end to end: folders, text + base64, info, copy/move/delete, a reload. */
async function legacyScenario(persisted: () => string[]): Promise<void> {
  const doc = Legacy.documentDirectory!;
  const a = doc + "notes/a.txt";
  const b = doc + "notes/b.bin";
  assertEquals(await Legacy.getInfoAsync(a), { exists: false, uri: a, isDirectory: false });
  await assertRejects(() => Legacy.makeDirectoryAsync(doc + "notes/deep"), Error, "parent");
  await Legacy.makeDirectoryAsync(doc + "notes/deep", { intermediates: true });
  await Legacy.makeDirectoryAsync(doc + "notes/deep/", { intermediates: true });
  await assertRejects(() => Legacy.makeDirectoryAsync(doc + "notes/deep"), Error, "exists");

  await Legacy.writeAsStringAsync(a, "héllo");
  await Legacy.writeAsStringAsync(a, "!", { append: true });
  assertEquals(await Legacy.readAsStringAsync(a), "héllo!");
  await Legacy.writeAsStringAsync(b, "AAEC/w==", { encoding: Legacy.EncodingType.Base64 });
  assertEquals(await Legacy.readAsStringAsync(b, { encoding: "base64" }), "AAEC/w==");
  assertEquals(
    await Legacy.readAsStringAsync(b, { encoding: "base64", position: 1, length: 2 }),
    "AQI=",
  );
  const info = await Legacy.getInfoAsync(a, { md5: true });
  assert(info.exists && info.modificationTime > 0 && info.modificationTime < Date.now());
  assertEquals([info.size, info.isDirectory, "md5" in info], [7, false, false]);
  const dirInfo = await Legacy.getInfoAsync(doc + "notes");
  assertEquals([dirInfo.exists, dirInfo.isDirectory, dirInfo.exists && dirInfo.size], [
    true,
    true,
    11,
  ]);
  assertEquals((await Legacy.readDirectoryAsync(doc + "notes")).sort(), [
    "a.txt",
    "b.bin",
    "deep",
  ]);
  await assertRejects(() => Legacy.readDirectoryAsync(doc + "none"), Error, "could not be found");

  await Legacy.copyAsync({ from: a, to: doc + "notes/deep/c.txt" });
  assertEquals(await Legacy.readAsStringAsync(doc + "notes/deep/c.txt"), "héllo!");
  await Legacy.moveAsync({ from: b, to: doc + "moved.bin" });
  assertEquals((await Legacy.getInfoAsync(b)).exists, false);
  assertEquals(
    await Legacy.readAsStringAsync(doc + "moved.bin", { encoding: "base64" }),
    "AAEC/w==",
  );
  await Legacy.moveAsync({ from: doc + "notes/deep", to: doc + "archive" });
  assertEquals(await Legacy.readDirectoryAsync(doc + "archive"), ["c.txt"]);
  await assertRejects(() => Legacy.moveAsync({ from: b, to: a }), Error, "could not be found");

  await Legacy.deleteAsync(doc + "notes");
  assertEquals((await Legacy.getInfoAsync(a)).exists, false);
  await assertRejects(() => Legacy.deleteAsync(a), Error, "could not be found");
  await Legacy.deleteAsync(a, { idempotent: true });
  assertEquals(persisted().sort(), ["documents/archive/c.txt", "documents/moved.bin"]);

  resetFileSystemForTesting(); // a reload: the bytes come back from the real files
  assertEquals(await Legacy.readAsStringAsync(doc + "archive/c.txt"), "héllo!");
}

/** A fake OPFS over a path → bytes map (`documents/a.txt`). */
function pathOpfs(files: Map<string, Uint8Array>, extra: Record<string, unknown> = {}) {
  const dirAt = (prefix: string): Any => ({
    getDirectoryHandle: (name: string) => Promise.resolve(dirAt(`${prefix}${name}/`)),
    getFileHandle: (name: string, opts?: { create?: boolean }) => {
      const path = prefix + name;
      if (!files.has(path) && !opts?.create) {
        return Promise.reject(new DOMException(path, "NotFoundError"));
      }
      return Promise.resolve({
        getFile: () =>
          Promise.resolve(
            new Blob([(files.get(path) ?? new Uint8Array()) as Uint8Array<ArrayBuffer>]),
          ),
        createWritable: () =>
          Promise.resolve({
            write: (chunk: string | Uint8Array) =>
              void files.set(
                path,
                typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
              ),
            close: () => Promise.resolve(),
          }),
      });
    },
    removeEntry: (name: string) => Promise.resolve(void files.delete(prefix + name)),
  });
  return { storage: { getDirectory: () => Promise.resolve(dirAt("")), ...extra } };
}

Deno.test("expo-file-system/legacy: the promise API over the Capacitor Filesystem plugin", async () => {
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
    await legacyScenario(() => [...disk.keys()].map((k) => k.replace("DOCUMENTS/", "documents/")));
    assertEquals(disk.get("DOCUMENTS/moved.bin"), "AAEC/w==");
  }, { localStorage: memoryStorage() });
  resetFileSystemForTesting();
});

Deno.test("expo-file-system/legacy: the promise API over OPFS on the web; downloads and quota", async () => {
  resetFileSystemForTesting();
  const files = new Map<string, Uint8Array>();
  const estimate = () => Promise.resolve({ quota: 1000, usage: 250 });
  const fetch = (url: string) =>
    Promise.resolve(
      url.endsWith("404")
        ? new Response("gone", { status: 404 })
        : new Response("PDF", { headers: { "content-type": "application/pdf" } }),
    );
  await withGlobals({
    navigator: pathOpfs(files, { estimate }),
    localStorage: memoryStorage(),
    fetch,
  }, async () => {
    await legacyScenario(() => [...files.keys()]);
    const target = Legacy.cacheDirectory + "dl/m.pdf";
    assertEquals(await Legacy.downloadAsync("https://x.test/m.pdf", target), {
      uri: target,
      status: 200,
      headers: { "content-type": "application/pdf" },
      mimeType: "application/pdf",
    });
    assertEquals(await Legacy.readAsStringAsync(target), "PDF");
    assertEquals(new TextDecoder().decode(files.get("cache/dl/m.pdf")), "PDF");
    assertEquals((await Legacy.downloadAsync("https://x.test/404", target)).status, 404);
    await assertRejects(
      () => Legacy.downloadAsync("https://x.test/m.pdf", "https://elsewhere/m.pdf"),
      Error,
      "cannot write",
    );
    // A picker's blob:/http URL is readable and copies into the app's files.
    await Legacy.copyAsync({
      from: "https://x.test/m.pdf",
      to: Legacy.documentDirectory + "c.pdf",
    });
    assertEquals(await Legacy.readAsStringAsync(Legacy.documentDirectory + "c.pdf"), "PDF");
    assertEquals((await Legacy.getInfoAsync("https://x.test/m.pdf")).exists, true);
    assertEquals([
      await Legacy.getFreeDiskStorageAsync(),
      await Legacy.getTotalDiskCapacityAsync(),
    ], [750, 1000]);
  });
  await withGlobals({ navigator: {} }, async () => {
    await assertRejects(
      () => Legacy.getFreeDiskStorageAsync(),
      Error,
      "getFreeDiskStorageAsync is not available in denext",
    );
  });
  resetFileSystemForTesting();
});

Deno.test("expo-file-system/legacy: uploadAsync sends the bytes or a multipart form", async () => {
  resetFileSystemForTesting();
  const files = new Map<string, Uint8Array>();
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return Promise.resolve(
      new Response("stored", { status: 201, headers: { "content-type": "text/plain" } }),
    );
  };
  await withGlobals(
    { navigator: pathOpfs(files), localStorage: memoryStorage(), fetch },
    async () => {
      const file = Legacy.documentDirectory + "photo.png";
      await Legacy.writeAsStringAsync(file, "PNG");
      assertEquals(await Legacy.uploadAsync("https://x.test/raw", file, { headers: { a: "1" } }), {
        status: 201,
        headers: { "content-type": "text/plain" },
        mimeType: "text/plain",
        body: "stored",
      });
      assertEquals(sent[0].init.method, "POST");
      assertEquals(sent[0].init.headers, { a: "1" });
      assertEquals(new TextDecoder().decode(sent[0].init.body as Uint8Array), "PNG");

      await Legacy.uploadAsync("https://x.test/form", file, {
        uploadType: Legacy.FileSystemUploadType.MULTIPART,
        httpMethod: "PUT",
        fieldName: "avatar",
        parameters: { user: "7" },
      });
      const form = sent[1].init.body as FormData;
      assertEquals(sent[1].init.method, "PUT");
      assertEquals(form.get("user"), "7");
      const part = form.get("avatar") as globalThis.File;
      assertEquals([part.name, part.type, await part.text()], ["photo.png", "image/png", "PNG"]);
      await assertRejects(() =>
        Legacy.uploadAsync("https://x.test/raw", Legacy.documentDirectory + "none")
      );
    },
  );
  resetFileSystemForTesting();
});

Deno.test("expo-file-system/legacy: native-only exports throw or reject naming denext", async () => {
  assertEquals(Legacy.documentDirectory, "file:///documents/");
  assertEquals(Legacy.cacheDirectory, "file:///cache/");
  assertEquals(Legacy.EncodingType, FileSystem.EncodingType);
  assertThrows(
    () => Legacy.createDownloadResumable("https://x/f", "file:///documents/f"),
    Error,
    "createDownloadResumable is not available in denext",
  );
  assertThrows(
    () => Legacy.createUploadTask("https://x/u", "file:///documents/f"),
    Error,
    "createUploadTask is not available in denext",
  );
  assertThrows(() => new Legacy.UploadTask("https://x/u", "f"), Error, "UploadTask is not");
  assertThrows(() => new Legacy.DownloadResumable("https://x/u", "f"), Error, "DownloadResumable");
  await assertRejects(() => Legacy.getContentUriAsync("f"), Error, "Android-only");
  const SAF = Legacy.StorageAccessFramework;
  assertThrows(() => SAF.getUriForDirectoryInRoot("x"), Error, "not available in denext");
  await assertRejects(() => SAF.requestDirectoryPermissionsAsync(), Error, "Android-only");
  await assertRejects(() => SAF.createFileAsync("p", "n", "text/plain"), Error, "Android-only");
  assertEquals(SAF.readAsStringAsync, Legacy.readAsStringAsync);
  await Legacy.deleteLegacyDocumentDirectoryAndroid();
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
    assertEquals((await Camera.Camera.getCameraPermissionsAsync()).status, "granted");
  });
  const permissions = { query: () => Promise.resolve({ state: "denied" }) };
  await withGlobals({ navigator: { permissions } }, async () => {
    const response = await Camera.Camera.getCameraPermissionsAsync();
    assertEquals([response.status, response.canAskAgain], ["denied", false]);
  });
  await assertRejects(() => Camera.scanFromURLAsync("https://x/qr.png"), Error, "BarcodeDetector");
  // As in expo-camera 57: the permission calls are only on `Camera`, and so is scanFromURLAsync.
  assertEquals(Camera.Camera.scanFromURLAsync, Camera.scanFromURLAsync);
  for (const name of ["getCameraPermissionsAsync", "requestMicrophonePermissionsAsync"]) {
    assertEquals(name in Camera, false);
    assertEquals(typeof (Camera.Camera as Any)[name], "function");
  }
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
  // Off-device the module loads; only a call throws (so an import-time lookup is harmless).
  const thing = Expo.requireNativeModule<Record<string, (...a: unknown[]) => unknown>>("ExpoThing");
  assertThrows(() => thing.doIt(1), Error, "Cannot find native module 'ExpoThing' (calling doIt)");
  assertEquals((thing.addListener("x", () => {}) as { remove(): void }).remove(), undefined);
  assertEquals([(thing as Any).then, String(thing)], [
    undefined,
    "[missing native module ExpoThing]",
  ]);
  assertEquals(Expo.requireOptionalNativeModule("ExpoThing"), null);
  // A native view slot of type "V" (its children render where "V" is not registered natively).
  assertEquals(typeof Expo.requireNativeView("V"), "function");
  assertEquals((Expo.requireNativeView("V") as Any).displayName, "V");
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
  // SymbolView is denext/mobile's SystemIcon (a Material Symbol off iOS).
  const symbol = SymbolView({ name: "checkmark", size: 18 }) as VNode;
  assertEquals([(symbol.props as Any).size, (symbol.props as Any).name], [18, "checkmark"]);
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

// ---- parity round-out: native stand-ins, legacy stubs, extra parameters ----

Deno.test("expo native-module classes are stand-ins that throw when constructed", () => {
  const cases: Array<[string, () => unknown]> = [
    ["expo-camera's CameraNativeModule", () => new Camera.CameraNativeModule()],
    ["expo-image's ImageNativeModule", () => new ImageNativeModule()],
    ["expo-updates's ExpoUpdatesModule", () => new Updates.ExpoUpdatesModule()],
    ["expo-audio's NativeAudioModule", () => new NativeAudioModule()],
    ["expo-audio's AudioPlaylist", () => new AudioPlaylist([], 500, "none")],
    [
      "expo-audio's AudioStream",
      () => new AudioStream({ sampleRate: 44100, channels: 1, encoding: "float32" }),
    ],
  ];
  for (const [label, construct] of cases) {
    assertThrows(construct, Error, `${label} is native-only and unavailable on the web`);
  }
  // Importing and introspecting them is harmless.
  assertEquals(typeof Camera.CameraNativeModule, "function");
  assertEquals(Updates.ExpoUpdatesModule.name, "ExpoUpdatesModule");
});

Deno.test("expo-file-system: the legacy top-level functions warn and throw as in SDK 58", async () => {
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (message: unknown) => void warnings.push(message);
  try {
    await assertRejects(
      () => FileSystem.readAsStringAsync("file:///documents/a.txt"),
      Error,
      'Method readAsStringAsync imported from "expo-file-system" is deprecated.',
    );
    await assertRejects(
      () => FileSystem.moveAsync({ from: "file:///a", to: "file:///b" }),
      Error,
      '"expo-file-system/legacy"',
    );
    await assertRejects(() => FileSystem.getFreeDiskStorageAsync(), Error, "getFreeDiskStorage");
    assertThrows(
      () => FileSystem.createDownloadResumable("https://x/f", "file:///documents/f"),
      Error,
      "Method createDownloadResumable",
    );
    assertThrows(
      () => FileSystem.createUploadTask("https://x/u", "file:///documents/f"),
      Error,
      "Method createUploadTask",
    );
  } finally {
    console.warn = warn;
  }
  assertEquals(warnings.length, 5);
});

Deno.test("expo-crypto AESKeySize and expo-sqlite deepEqual match Expo", () => {
  assertEquals(
    [Crypto.AESKeySize.AES128, Crypto.AESKeySize.AES192, Crypto.AESKeySize.AES256],
    [128, 192, 256],
  );
  assert(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }));
  assert(deepEqual(undefined, undefined));
  assertEquals(deepEqual({ a: 1 }, { a: 2 }), false);
  assertEquals(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assertEquals(deepEqual({ a: 1 }, undefined), false);
  assertEquals(deepEqual({ a: { b: 1 } }, { a: { b: "1" } }), false);
});

Deno.test("expo functions accept Expo's extra parameters", async () => {
  Expo.installOnUIRuntime({});
  const badges: number[] = [];
  const navigator = {
    setAppBadge: (n: number) => {
      badges.push(n);
      return Promise.resolve();
    },
    clearAppBadge: () => Promise.resolve(),
  };
  await withGlobals({ navigator }, async () => {
    assertEquals(await Notifications.setBadgeCountAsync(4, { web: { method: "Title" } }), true);
  });
  assertEquals([badges, await Notifications.getBadgeCountAsync()], [[4], 4]);
  const player = createVideoPlayer(null, { seekForwardIncrement: 5 });
  assert(player instanceof VideoPlayer);
  player.release();

  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  let seen: VideoPlayer | undefined;
  let setUp: VideoPlayer | undefined;
  function Probe() {
    seen = useVideoPlayer(null, (p) => void (setUp = p), { seekBackwardIncrement: 5 });
    return null;
  }
  root.render(h(Probe as Any, null));
  flushSync();
  assert(seen instanceof VideoPlayer);
  assertEquals(setUp, seen);
  root.unmount?.();
});

// ---- Expo SDK 58 additions -------------------------------------------------

Deno.test("expo (SDK 58): Platform, uuid and the coded errors are Expo's web build's", () => {
  assertEquals(Expo.Platform.OS, "web");
  assertEquals(Expo.Platform.select({ ios: 1, web: 2, default: 3 }), 2);
  assertEquals(Expo.Platform.select({ ios: 1, native: 4, default: 3 }), 3);
  assertEquals(Expo.Platform.select({ ios: 1 }), undefined);
  assertEquals([Expo.Platform.isAsyncDebugging, Expo.Platform.isQuest], [false, false]);
  assertEquals(Expo.Platform.isDOMAvailable, false, "no window in Deno");
  assertEquals(Expo.Platform.canUseEventListeners, false);
  // RFC 4122 / Expo's v5: the SHA-1 of the namespace bytes and the UTF-8 name.
  assertEquals(
    Expo.uuid.v5("hello.example.com", Expo.uuid.namespace.dns),
    "fdda765f-fc57-5604-a269-52a7df8164ec",
  );
  assertEquals(
    Expo.uuid.v5("https://denext.dev/é", "6ba7b811-9dad-11d1-80b4-00c04fd430c8"),
    "378b8fd7-66d7-571c-a759-cda5a794f785",
  );
  const dnsBytes = [...Expo.uuid.namespace.dns.replaceAll("-", "").matchAll(/../g)].map((m) =>
    parseInt(m[0], 16)
  );
  assertEquals(
    Expo.uuid.v5("hello.example.com", dnsBytes),
    "fdda765f-fc57-5604-a269-52a7df8164ec",
  );
  // A name past one 64-byte SHA-1 block.
  assertEquals(
    Expo.uuid.v5(
      "https://denext.dev/docs/react-native#expo-apis?".repeat(4),
      Expo.uuid.namespace.url,
    ),
    "12417472-69a2-5c62-b2d6-004d3b93cd67",
  );
  assertThrows(() => Expo.uuid.v5("x", [1, 2]), TypeError, "16 byte");
  assertMatch(
    Expo.uuid.v4(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  const coded = new Expo.CodedError("ERR_X", "boom");
  assert(coded instanceof Error);
  assertEquals([coded.code, coded.message], ["ERR_X", "boom"]);
  const missing = new Expo.UnavailabilityError("ExpoThing", "doIt");
  assert(missing instanceof Expo.CodedError);
  assertEquals(missing.code, "ERR_UNAVAILABLE");
  assertMatch(missing.message, /ExpoThing\.doIt is not available on web/);
  assertEquals(Expo.createSnapshotFriendlyRef<number>(), { current: null });
});

Deno.test("expo uuid.v4: falls back to getRandomValues outside a secure context (no randomUUID)", () => {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(crypto), "randomUUID");
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  try {
    const ids = new Set(Array.from({ length: 64 }, () => Expo.uuid.v4()));
    assertEquals(ids.size, 64);
    for (const id of ids) assertMatch(id, v4);
  } finally {
    delete (crypto as { randomUUID?: unknown }).randomUUID;
    if (desc && !Object.getOwnPropertyDescriptor(Object.getPrototypeOf(crypto), "randomUUID")) {
      Object.defineProperty(Object.getPrototypeOf(crypto), "randomUUID", desc);
    }
  }
  assertEquals(typeof crypto.randomUUID, "function", "restored");
  assertMatch(Expo.uuid.v4(), v4);
});

Deno.test("expo (SDK 58): useReleasingSharedObject releases on unmount and on a dependency change", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const log: string[] = [];
  class Thing extends Expo.SharedObject {
    constructor(readonly id: string) {
      super();
      log.push(`make ${id}`);
    }
    override release(): void {
      log.push(`release ${this.id}`);
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));
  let seen: Thing | undefined;
  function Probe(props: { id: string }) {
    seen = Expo.useReleasingSharedObject(() => new Thing(props.id), [props.id]);
    return null;
  }
  const root = createRoot(container as Any);
  root.render(h(Probe as Any, { id: "a" }));
  flushSync();
  const first = seen;
  root.render(h(Probe as Any, { id: "a" }));
  flushSync();
  assertEquals(seen, first, "same dependencies: the same object");
  root.render(h(Probe as Any, { id: "b" }));
  flushSync();
  await settle();
  assertEquals(log, ["make a", "make b", "release a"]);
  root.unmount?.();
  await settle();
  assertEquals(log, ["make a", "make b", "release a", "release b"]);

  // With shouldRecreate: false a dependency change updates the same object instead.
  const updates: string[] = [];
  let kept: Thing | undefined;
  function Keeper(props: { n: number }) {
    kept = Expo.useReleasingSharedObjectWithLifecycle({
      factory: () => new Thing("k"),
      shouldRecreate: () => false,
      update: (object, { previousDependencies, dependencies }) =>
        void updates.push(`${object.id} ${previousDependencies} -> ${dependencies}`),
      release: (object) => log.push(`custom release ${object.id}`),
    }, [props.n]);
    return null;
  }
  log.length = 0;
  const root2 = createRoot(container as Any);
  root2.render(h(Keeper as Any, { n: 1 }));
  flushSync();
  const keptFirst = kept;
  root2.render(h(Keeper as Any, { n: 2 }));
  flushSync();
  await settle();
  assertEquals(kept, keptFirst);
  assertEquals(updates, ["k 1 -> 2"]);
  root2.unmount?.();
  await settle();
  assertEquals(log, ["make k", "custom release k"]);
});

Deno.test("expo-dev-client / expo-widgets (SDK 58): tools button, initial props, enum options", async () => {
  DevClient.setToolsButtonVisible(false);
  const widget = Widgets.createWidget("Usage", () => null, { title: "Weekly" });
  const [initial] = await widget.getTimeline();
  assertEquals(initial.props, { title: "Weekly" });
  assert(initial.date instanceof Date);
  widget.setConfigurationParameterEnum("period", [{ name: "Week", value: "week" }]);
  assertEquals(await Widgets.createWidget("Bare", () => null).getTimeline(), []);
});

Deno.test("expo-font (SDK 58): families load a face per weight and style; unload by face", async () => {
  const added: Any[] = [];
  const removed: Any[] = [];
  class FakeFontFace {
    weight: string;
    style: string;
    display: string;
    constructor(readonly family: string, readonly source: string, opts: Any) {
      this.weight = opts.weight ?? "normal";
      this.style = opts.style ?? "normal";
      this.display = opts.display;
    }
    load() {
      return Promise.resolve(this);
    }
  }
  const document = {
    fonts: { add: (f: unknown) => added.push(f), delete: (f: unknown) => removed.push(f) },
  };
  await withGlobals({ FontFace: FakeFontFace, document }, async () => {
    await Font.loadAsync([{
      fontFamily: "Inter",
      fontDefinitions: [
        { path: "/fonts/inter-regular.ttf", weight: 400 },
        { path: { uri: "/fonts/inter-bold.ttf", weight: "bold" } },
        { path: "/fonts/inter-italic.ttf", weight: 400, style: "italic" },
      ],
    }]);
    assert(Font.isLoaded("Inter"));
    assertEquals(
      added.map((f) => [f.source, f.weight, f.style]),
      [
        ['url("/fonts/inter-regular.ttf")', "400", "normal"],
        ['url("/fonts/inter-bold.ttf")', "bold", "normal"],
        ['url("/fonts/inter-italic.ttf")', "400", "italic"],
      ],
    );
    await Font.unloadAsync("Inter", { weight: 700 });
    assertEquals(removed.map((f) => f.source), ['url("/fonts/inter-bold.ttf")']);
    assert(Font.isLoaded("Inter"), "the other faces stay");
    await Font.unloadAsync("Inter", { style: "italic" });
    await Font.unloadAsync("Inter");
    assertEquals(Font.isLoaded("Inter"), false);
    assertEquals(removed.length, 3);

    const err = await Font.loadAsync([{
      fontFamily: "Dup",
      fontDefinitions: [
        { path: "/a.ttf", weight: 400, style: "normal" },
        { path: "/b.ttf", weight: "normal", style: "normal" },
      ],
    }]).catch((e) => e);
    assertEquals([err instanceof Expo.CodedError, err.code], [true, "ERR_FONT_API"]);
    assertMatch(err.message, /two faces with weight 400/);
    await assertRejects(
      () => Font.loadAsync([{ fontFamily: "Empty", fontDefinitions: [] }]),
      Error,
      "No font faces",
    );
    await assertRejects(
      () =>
        Font.loadAsync([
          { fontFamily: "Twice", fontDefinitions: [{ path: "/a.ttf" }] },
          { fontFamily: "Twice", fontDefinitions: [{ path: "/b.ttf" }] },
        ]),
      Error,
      "declared more than once",
    );
    await assertRejects(
      () => Font.loadAsync([{ fontFamily: "X", fontDefinitions: [{ path: "/a.ttf" }] }], "/b"),
      Error,
      "second argument",
    );
    await Font.unloadAllAsync();
  });
});

Deno.test("expo-file-system (SDK 58): write is async, writeSync immediate; digest and preview", async () => {
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
    const file = new File(Paths.document, "a.txt");
    const written = file.write("abc");
    assert(written instanceof Promise);
    assertEquals(file.textSync(), "abc", "readable before the promise settles");
    await written;
    assert(disk.has("DOCUMENTS/a.txt"), "on disk once it settles");
    file.writeSync(new Uint8Array([100]).buffer, { append: true });
    assertEquals(file.textSync(), "abcd");
    assertEquals(
      await file.digest("SHA-256"),
      "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589",
    );
    assertEquals(await file.digest("SHA-1"), "81fe8bfe87576c3ecb22426f8e57847382917acf");
    const md5 = await file.digest("MD5").catch((e) => e);
    assertEquals(md5.code, "ERR_UNAVAILABLE");
    assertEquals(await file.canPreview({ mimeType: "text/plain" }), false);
    await assertRejects(() => file.preview({ title: "a" }), Error, "File.preview");
  }, { localStorage: memoryStorage() });
  resetFileSystemForTesting();
});

Deno.test("expo-file-system: an awaited write rejects when the real file can't be written; the queue goes on", async () => {
  resetFileSystemForTesting();
  const disk = new Map<string, string>();
  const key = (o: Any) => `${o.directory}/${o.path}`;
  const Filesystem = {
    writeFile: (o: Any) =>
      o.path.startsWith("full")
        ? Promise.reject(new Error("disk full"))
        : Promise.resolve(void disk.set(key(o), o.data)),
    readFile: (o: Any) => Promise.resolve({ data: disk.get(key(o)) }),
    deleteFile: (o: Any) => Promise.resolve(void disk.delete(key(o))),
  };
  const warn = console.warn;
  const warned: unknown[][] = [];
  console.warn = (...args: unknown[]) => void warned.push(args);
  try {
    await inShell({ Filesystem }, async () => {
      await assertRejects(
        () => new File(Paths.document, "full.txt").write("x"),
        Error,
        "disk full",
      );
      await assertRejects(
        () => Legacy.writeAsStringAsync(Legacy.documentDirectory + "full2.txt", "x"),
        Error,
        "disk full",
      );
      new File(Paths.document, "full3.txt").writeSync("x"); // fire-and-forget: logged only
      await new File(Paths.document, "ok.txt").write("fine");
      assertEquals(disk.get("DOCUMENTS/ok.txt"), btoa("fine"), "later writes still land");
    }, { localStorage: memoryStorage() });
  } finally {
    console.warn = warn;
    resetFileSystemForTesting();
  }
  assertEquals(warned.length, 3, "every failed persist is still logged");
});

Deno.test("expo-audio (SDK 58): the recorder state counts the recorded bytes", async () => {
  class FakeRecorder {
    static isTypeSupported = () => true;
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["abcde"]) });
      this.onstop?.();
    }
  }
  const navigator = {
    mediaDevices: {
      getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }),
    },
  };
  await withGlobals({ MediaRecorder: FakeRecorder, navigator }, async () => {
    const recorder = new AudioRecorder({ ...RecordingPresets.HIGH_QUALITY, fileName: "memo" });
    await recorder.prepareToRecordAsync();
    recorder.record();
    assertEquals(recorder.getStatus().fileSize, 0);
    await recorder.stop();
    const status = recorder.getStatus();
    assertEquals([status.fileSize, status.isRecording], [5, false]);
    assert(status.url?.startsWith("blob:"));
    URL.revokeObjectURL(status.url!);
  });
});
