// denext/mobile's 2.11 platform capabilities, each in a faked Capacitor shell and on its web
// path: the review prompt, store updates (and the OTA-refusal prompt), screen orientation, the
// photo library, the privacy screen, App Tracking Transparency, background tasks, and Android
// process death (restored picker results, the last route).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createAlbum,
  defineBackgroundTask,
  getAlbums,
  getAppUpdateInfo,
  getOrientation,
  getRecentMedia,
  getTrackingStatus,
  lockOrientation,
  onFlexibleUpdateProgress,
  onOrientationChange,
  onRestoredResult,
  openAppStore,
  openStoreReview,
  performImmediateUpdate,
  promptStoreUpdate,
  requestReview,
  requestTrackingPermission,
  type RestoredResult,
  restoreRouteOnRelaunch,
  runBackgroundTask,
  saveToLibrary,
  setPrivacyScreen,
  startFlexibleUpdate,
  unlockOrientation,
  useOrientation,
  usePrivacyScreen,
} from "../src/mobile/mod.ts";
import { resetRestoreRouteForTesting } from "../src/mobile/restore.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  Target,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

/** A `window.open` that records what it opened. */
function recordOpen() {
  const opened: string[] = [];
  return { opened, open: (url: string) => void opened.push(url) };
}

// ---- app-review -------------------------------------------------------------------------------

Deno.test("requestReview: AppReview natively, InAppReview as a fallback, unsupported on the web", async () => {
  const review = fakePlugin(["requestReview", "openAppStore"]);
  await inShell("ios", { AppReview: review.plugin }, async () => {
    assertEquals(await requestReview(), "requested");
  });
  assertEquals(review.calls.map(([m]) => m), ["requestReview"]);
  const community = fakePlugin(["requestReview"]);
  await inShell("android", { InAppReview: community.plugin }, async () => {
    assertEquals(await requestReview(), "requested");
  });
  assertEquals(community.calls.length, 1);
  await inShell("android", {}, async () => assertEquals(await requestReview(), "unsupported"));
  assertEquals(await requestReview(), "unsupported");
});

Deno.test("openStoreReview: the plugin natively; store URLs otherwise; iOS needs appStoreId", async () => {
  const review = fakePlugin(["requestReview", "openAppStore"]);
  await inShell("ios", { AppReview: review.plugin }, async () => {
    await assertRejects(() => openStoreReview(), TypeError, "appStoreId");
    await openStoreReview({ appStoreId: "123" });
  });
  assertEquals(review.calls, [["openAppStore", { appId: "123" }]]);
  const { opened, open } = recordOpen();
  await withGlobals({ open }, async () => {
    await openStoreReview({ appStoreId: "123" });
    await openStoreReview({ androidPackage: "com.example.app" });
    await inShell("android", {}, () => openStoreReview({ appStoreId: "9", androidPackage: "a.b" }));
    await assertRejects(() => openStoreReview(), TypeError);
  });
  assertEquals(opened, [
    "https://apps.apple.com/app/id123?action=write-review",
    "https://play.google.com/store/apps/details?id=com.example.app",
    "https://play.google.com/store/apps/details?id=a.b",
  ]);
});

// ---- app-update -------------------------------------------------------------------------------

const UPDATE_METHODS = [
  "getAppUpdateInfo",
  "openAppStore",
  "performImmediateUpdate",
  "startFlexibleUpdate",
  "completeFlexibleUpdate",
];

Deno.test("getAppUpdateInfo: normalizes the plugin's answer; unsupported on the web", async () => {
  const update = fakePlugin(UPDATE_METHODS, {
    getAppUpdateInfo: {
      currentVersionName: "1.0.0",
      currentVersionCode: "10",
      availableVersionCode: "12",
      updateAvailability: 2,
      immediateUpdateAllowed: true,
      flexibleUpdateAllowed: false,
      clientVersionStalenessDays: 3,
      updatePriority: 4,
    },
  });
  await inShell("android", { AppUpdate: update.plugin }, async () => {
    assertEquals(await getAppUpdateInfo({ country: "de" }), {
      availability: "available",
      available: true,
      currentVersion: "1.0.0",
      currentBuild: "10",
      availableBuild: "12",
      priority: 4,
      stalenessDays: 3,
      immediateAllowed: true,
      flexibleAllowed: false,
    });
  });
  assertEquals(update.calls[0], ["getAppUpdateInfo", { country: "de" }]);
  assertEquals(await getAppUpdateInfo(), { availability: "unsupported", available: false });
});

Deno.test("in-app updates: Android result codes named; unsupported on iOS and the web", async () => {
  const update = fakePlugin(UPDATE_METHODS, {
    performImmediateUpdate: { code: 1 },
    startFlexibleUpdate: { code: 0 },
  });
  await inShell("android", { AppUpdate: update.plugin }, async () => {
    assertEquals(await performImmediateUpdate(), "cancelled");
    assertEquals(await startFlexibleUpdate(), "accepted");
    const seen: unknown[] = [];
    const stop = onFlexibleUpdateProgress((p) => seen.push(p));
    await settle();
    update.fire("onFlexibleUpdateStateChange", {
      installStatus: 2,
      bytesDownloaded: 5,
      totalBytesToDownload: 10,
    });
    update.fire("onFlexibleUpdateStateChange", { installStatus: 11 });
    stop();
    await settle();
    assertEquals(update.listening(), 0);
    assertEquals(seen, [
      { status: "downloading", bytesDownloaded: 5, totalBytes: 10 },
      { status: "downloaded" },
    ]);
  });
  await inShell("ios", { AppUpdate: update.plugin }, async () => {
    assertEquals(await performImmediateUpdate(), "unsupported");
  });
  assertEquals(await startFlexibleUpdate(), "unsupported");
});

Deno.test("openAppStore: plugin options; URL fallback; iOS without an id is refused", async () => {
  const update = fakePlugin(UPDATE_METHODS);
  await inShell(
    "android",
    { AppUpdate: update.plugin },
    () => openAppStore({ androidPackage: "a.b" }),
  );
  assertEquals(update.calls, [["openAppStore", { androidPackageName: "a.b" }]]);
  await inShell("ios", {}, async () => {
    await assertRejects(() => openAppStore(), TypeError, "appStoreId");
  });
  const { opened, open } = recordOpen();
  await withGlobals({ open }, () => openAppStore({ appStoreId: "42" }));
  assertEquals(opened, ["https://apps.apple.com/app/id42"]);
});

Deno.test("promptStoreUpdate: immediate on Android, the store on iOS, confirm and up-to-date", async () => {
  const android = fakePlugin(UPDATE_METHODS, {
    getAppUpdateInfo: { updateAvailability: 2, immediateUpdateAllowed: true },
    performImmediateUpdate: { code: 0 },
  });
  await inShell("android", { AppUpdate: android.plugin }, async () => {
    assertEquals(await promptStoreUpdate(), "updating");
  });
  assert(android.calls.some(([m]) => m === "performImmediateUpdate"));

  const ios = fakePlugin(UPDATE_METHODS, { getAppUpdateInfo: { updateAvailability: 2 } });
  await inShell("ios", { AppUpdate: ios.plugin }, async () => {
    assertEquals(await promptStoreUpdate({ confirm: () => false, appStoreId: "1" }), "declined");
    assertEquals(await promptStoreUpdate({ appStoreId: "1" }), "store-opened");
  });
  assertEquals(ios.calls.at(-1), ["openAppStore", { appId: "1" }]);

  const current = fakePlugin(UPDATE_METHODS, { getAppUpdateInfo: { updateAvailability: 1 } });
  await inShell("ios", { AppUpdate: current.plugin }, async () => {
    assertEquals(await promptStoreUpdate({ appStoreId: "1" }), "up-to-date");
    assertEquals(await promptStoreUpdate({ appStoreId: "1", force: true }), "store-opened");
  });
  assertEquals(await promptStoreUpdate(), "unsupported");
});

// ---- screen-orientation -----------------------------------------------------------------------

Deno.test("orientation: native plugin read/lock/unlock/listen; bad lock refused", async () => {
  const plugin = fakePlugin(["orientation", "lock", "unlock"], {
    orientation: { type: "landscape-secondary" },
  });
  await inShell("ios", { ScreenOrientation: plugin.plugin }, async () => {
    assertEquals(await getOrientation(), "landscape-secondary");
    await lockOrientation("portrait");
    await unlockOrientation();
    await assertRejects(() => lockOrientation("sideways" as Any), TypeError);
    const seen: string[] = [];
    const stop = onOrientationChange((o) => seen.push(o));
    await settle();
    plugin.fire("screenOrientationChange", { type: "portrait-primary" });
    stop();
    await settle();
    assertEquals(seen, ["portrait-primary"]);
    assertEquals(plugin.listening(), 0);
  });
  assertEquals(plugin.calls.slice(1), [["lock", { orientation: "portrait" }], [
    "unlock",
    undefined,
  ]]);
});

Deno.test("orientation: the web's screen.orientation, then the media query", async () => {
  const locked: string[] = [];
  const orientation = Object.assign(new Target(), {
    type: "landscape-primary",
    lock: (o: string) => (locked.push(o), Promise.resolve()),
    unlock: () => void locked.push("unlock"),
  });
  await withGlobals({ screen: { orientation } }, async () => {
    assertEquals(await getOrientation(), "landscape-primary");
    await lockOrientation("landscape");
    await unlockOrientation();
    const seen: string[] = [];
    const stop = onOrientationChange((o) => seen.push(o));
    orientation.type = "portrait-primary";
    orientation.fire("change");
    stop();
    orientation.fire("change");
    assertEquals(seen, ["portrait-primary"]);
  });
  assertEquals(locked, ["landscape", "unlock"]);
  const matchMedia = () => ({ matches: false });
  await withGlobals({ screen: {}, matchMedia }, async () => {
    assertEquals(await getOrientation(), "landscape-primary");
    await assertRejects(() => lockOrientation("portrait"), Error, "cannot lock");
  });
});

Deno.test("useOrientation: follows the native plugin", async () => {
  const plugin = fakePlugin(["orientation", "lock", "unlock"], {
    orientation: { type: "portrait-secondary" },
  });
  await inShell("android", { ScreenOrientation: plugin.plugin }, async () => {
    let seen = "";
    const { rerender } = mount(function Probe() {
      seen = useOrientation();
      return null;
    });
    await settle();
    rerender();
    assertEquals(seen, "portrait-secondary");
    plugin.fire("screenOrientationChange", { type: "landscape-primary" });
    rerender();
    assertEquals(seen, "landscape-primary");
  });
});

// ---- media-library ----------------------------------------------------------------------------

const MEDIA_METHODS = ["savePhoto", "saveVideo", "getAlbums", "createAlbum", "getMedias"];

Deno.test("saveToLibrary: iOS camera roll; Android album created; video; the web downloads", async () => {
  const ios = fakePlugin(MEDIA_METHODS, { savePhoto: { identifier: "PH-1" } });
  await inShell("ios", { Media: ios.plugin }, async () => {
    assertEquals(await saveToLibrary("https://x/a.jpg"), { savedTo: "library", id: "PH-1" });
    await assertRejects(() => saveToLibrary(""), TypeError);
  });
  assertEquals(ios.calls, [["savePhoto", { path: "https://x/a.jpg" }]]);

  let albums: Any[] = [];
  const android = fakePlugin(MEDIA_METHODS, {
    saveVideo: { filePath: "/sdcard/Pictures/Saved/v.mp4" },
  });
  android.plugin.getAlbums = () => Promise.resolve({ albums });
  android.plugin.createAlbum = (arg: Any) => {
    albums = [...albums, { identifier: `/sdcard/Pictures/${arg.name}`, name: arg.name }];
    return Promise.resolve();
  };
  await inShell("android", { Media: android.plugin }, async () => {
    const saved = await saveToLibrary("file:///data/v.mp4", { kind: "video", fileName: "clip" });
    assertEquals(saved, { savedTo: "library", path: "/sdcard/Pictures/Saved/v.mp4" });
    assertEquals(await getAlbums(), [{ id: "/sdcard/Pictures/Saved", name: "Saved" }]);
    assertEquals((await createAlbum("Saved")).id, "/sdcard/Pictures/Saved", "existing one reused");
    assertEquals(await getRecentMedia(), [], "Android has no media query");
  });
  assertEquals(android.calls, [["saveVideo", {
    path: "file:///data/v.mp4",
    albumIdentifier: "/sdcard/Pictures/Saved",
    fileName: "clip",
  }]]);

  const clicks: Any[] = [];
  const body = { appendChild: () => {} };
  const document = {
    body,
    createElement: () => {
      const a: Any = { style: {}, remove: () => {}, click: () => clicks.push({ ...a }) };
      return a;
    },
  };
  await withGlobals({ document }, async () => {
    assertEquals(await saveToLibrary("data:image/png;base64,AA", { fileName: "x.png" }), {
      savedTo: "download",
    });
  });
  assertEquals(clicks.map((a) => [a.href, a.download]), [["data:image/png;base64,AA", "x.png"]]);
  assertEquals(await getAlbums(), []);
  await assertRejects(() => createAlbum("x"), Error, "photo library");
});

Deno.test("getRecentMedia: iOS thumbnails as data URLs, newest first", async () => {
  const ios = fakePlugin(MEDIA_METHODS, {
    getMedias: {
      medias: [
        { identifier: "A", data: "QUJD", creationDate: "2026-01-01", fullWidth: 4, fullHeight: 3 },
        { data: "ignored" },
        { identifier: "B", data: "X", duration: 2.5, fullWidth: 1, fullHeight: 1 },
      ],
    },
  });
  await inShell("ios", { Media: ios.plugin }, async () => {
    const items = await getRecentMedia({ limit: 2, types: "photos", albumId: "AL" });
    assertEquals(items.map((i) => [i.id, i.thumbnail, i.duration]), [
      ["A", "data:image/jpeg;base64,QUJD", undefined],
      ["B", "data:image/jpeg;base64,X", 2.5],
    ]);
  });
  const [, options] = ios.calls[0] as [string, Any];
  assertEquals(options.quantity, 2);
  assertEquals(options.albumIdentifier, "AL");
  assertEquals(options.sort, [{ key: "creationDate", ascending: false }]);
});

// ---- privacy-screen ---------------------------------------------------------------------------

Deno.test("privacy screen: enable config, ref-counted hook, false on the web", async () => {
  const privacy = fakePlugin(["enable", "disable"]);
  await inShell("android", { PrivacyScreen: privacy.plugin }, async () => {
    assertEquals(
      await setPrivacyScreen(true, { androidDim: true, preventScreenshots: false }),
      true,
    );
    assertEquals(await setPrivacyScreen(false), true);
    let on = true;
    const a = mount(function Probe() {
      usePrivacyScreen(on);
      return null;
    });
    const b = mount(function Probe() {
      usePrivacyScreen();
      return null;
    });
    await settle();
    a.root.unmount();
    await settle();
    assertEquals(privacy.calls.filter(([m]) => m === "disable").length, 1, "b still holds it");
    b.root.unmount();
    on = false;
    await settle();
  });
  assertEquals(privacy.calls.map(([m]) => m), ["enable", "disable", "enable", "disable"]);
  assertEquals(privacy.calls[0][1], {
    android: { dimBackground: true, preventScreenshots: false },
    ios: { blurEffect: "dark" },
  });
  assertEquals(await setPrivacyScreen(true), false);
});

// ---- tracking ---------------------------------------------------------------------------------

Deno.test("tracking: iOS statuses named; unavailable on Android and the web", async () => {
  const att = fakePlugin(["getStatus", "requestPermission"], {
    getStatus: { status: "notDetermined" },
    requestPermission: { status: "authorized" },
  });
  await inShell("ios", { AppTrackingTransparency: att.plugin }, async () => {
    assertEquals(await getTrackingStatus(), "not-determined");
    assertEquals(await requestTrackingPermission(), "authorized");
  });
  await inShell("android", { AppTrackingTransparency: att.plugin }, async () => {
    assertEquals(await requestTrackingPermission(), "unavailable");
  });
  assertEquals(await getTrackingStatus(), "unavailable");
  const denied = fakePlugin(["getStatus", "requestPermission"], {
    getStatus: { status: "restricted" },
    requestPermission: { status: "denied" },
  });
  await inShell("ios", { AppTrackingTransparency: denied.plugin }, async () => {
    assertEquals(await getTrackingStatus(), "restricted");
    assertEquals(await requestTrackingPermission(), "denied");
  });
});

// ---- background -------------------------------------------------------------------------------

Deno.test("defineBackgroundTask: validates the name, interval and handler", () => {
  const task = defineBackgroundTask({ name: "sync-inbox", handler: () => {} });
  assertEquals(task.interval, 15);
  assertEquals(defineBackgroundTask({ name: "a_b", interval: 60, handler: () => {} }).interval, 60);
  assertThrows(() => defineBackgroundTask({ name: "9x", handler: () => {} }), TypeError, "name");
  assertThrows(() => defineBackgroundTask({ name: "a b", handler: () => {} }), TypeError);
  assertThrows(
    () => defineBackgroundTask({ name: "x", interval: 5, handler: () => {} }),
    TypeError,
    "15",
  );
  assertThrows(() => defineBackgroundTask({ name: "x", handler: 1 as Any }), TypeError, "handler");
});

Deno.test("runBackgroundTask: dispatches to the runner's label; false on the web", async () => {
  const runner = fakePlugin(["dispatchEvent"]);
  await inShell("ios", { CapacitorBackgroundRunner: runner.plugin }, async () => {
    assertEquals(await runBackgroundTask("sync-inbox", { why: "login" }), true);
  });
  assertEquals(runner.calls, [["dispatchEvent", {
    label: "dev.denext.background",
    event: "sync-inbox",
    details: { why: "login" },
  }]]);
  assertEquals(await runBackgroundTask("x"), false);
});

// ---- restore: process death -------------------------------------------------------------------

Deno.test("onRestoredResult: camera, file picker, cancel, error and other results", async () => {
  const app = fakePlugin([]);
  const seen: RestoredResult[] = [];
  await inShell("android", { App: app.plugin }, async () => {
    const stop = onRestoredResult((r) => seen.push(r));
    await settle();
    app.fire("appRestoredResult", {
      pluginId: "Camera",
      methodName: "getPhoto",
      success: true,
      data: { webPath: "https://localhost/_capacitor_file_/p.jpg", format: "JPEG" },
    });
    app.fire("appRestoredResult", {
      pluginId: "Camera",
      methodName: "getPhoto",
      success: true,
      data: { dataUrl: "data:image/jpeg;base64,AA", format: "jpeg" },
    });
    app.fire("appRestoredResult", {
      pluginId: "FilePicker",
      methodName: "pickFiles",
      success: true,
      data: { files: [{ name: "a.pdf", mimeType: "application/pdf", size: 3, path: "/x/a.pdf" }] },
    });
    app.fire("appRestoredResult", {
      pluginId: "Camera",
      methodName: "getPhoto",
      success: false,
      error: { message: "User cancelled photos app" },
    });
    app.fire("appRestoredResult", {
      pluginId: "Camera",
      methodName: "getPhoto",
      success: false,
      error: { message: "No camera" },
    });
    app.fire("appRestoredResult", { pluginId: "Other", methodName: "m", success: true, data: 1 });
    stop();
    await settle();
    assertEquals(app.listening(), 0);
  });
  assertEquals(seen, [
    {
      kind: "image",
      image: { webPath: "https://localhost/_capacitor_file_/p.jpg", format: "jpeg" },
    },
    { kind: "image", image: { dataUrl: "data:image/jpeg;base64,AA", format: "jpeg" } },
    {
      kind: "documents",
      documents: [{ name: "a.pdf", mimeType: "application/pdf", size: 3, path: "/x/a.pdf" }],
    },
    { kind: "cancelled", pluginId: "Camera", methodName: "getPhoto" },
    { kind: "error", pluginId: "Camera", methodName: "getPhoto", message: "No camera" },
    { kind: "other", pluginId: "Other", methodName: "m", data: 1 },
  ]);
  const stop = onRestoredResult(() => {});
  stop(); // a no-op on the web
});

/** A browser-ish page at `path` with a document that fires visibility changes. */
function page(path: string) {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const document = Object.assign(new Target(), { visibilityState: "visible" });
  const location = { pathname: path, search: "", hash: "" };
  const navigations: string[] = [];
  return { store, localStorage, document, location, navigations };
}

Deno.test("restoreRouteOnRelaunch: saves on hide, restores a fresh route on a cold start", async () => {
  resetRestoreRouteForTesting();
  const p = page("/orders/42");
  p.location.search = "?tab=items";
  const extra = { localStorage: p.localStorage, document: p.document, location: p.location };
  await inShell("android", {}, async () => {
    assertEquals(await restoreRouteOnRelaunch(), null, "nothing saved yet");
    p.document.visibilityState = "hidden";
    p.document.fire("visibilitychange");
  }, extra);
  const saved = JSON.parse(p.store.get("denext:last-route")!);
  assertEquals(saved.path, "/orders/42?tab=items");

  // The relaunch: a fresh page on the start path.
  resetRestoreRouteForTesting();
  p.location.pathname = "/";
  p.location.search = "";
  await inShell("android", {}, async () => {
    const restored = await restoreRouteOnRelaunch({ navigate: (to) => p.navigations.push(to) });
    assertEquals(restored, "/orders/42?tab=items");
  }, extra);
  assertEquals(p.navigations, ["/orders/42?tab=items"]);

  // Too old, not on a start path, the web, a foreign path: left alone.
  for (
    const [at, pathname, platform, path] of [
      [Date.now() - 3_600_000, "/", "android", "/orders/1"],
      [Date.now(), "/deep/link", "ios", "/orders/1"],
      [Date.now(), "/", "web", "/orders/1"],
      [Date.now(), "/", "ios", "//evil.example/x"],
    ] as const
  ) {
    resetRestoreRouteForTesting();
    p.store.set("denext:last-route", JSON.stringify({ path, at }));
    p.location.pathname = pathname;
    const run = () => restoreRouteOnRelaunch({ navigate: (to) => p.navigations.push(to) });
    if (platform === "web") {
      await withGlobals(extra, async () => assertEquals(await run(), null));
    } else {
      await inShell(platform, {}, async () => assertEquals(await run(), null), extra);
    }
  }
  assertEquals(p.navigations.length, 1);
});

Deno.test("restoreRouteOnRelaunch: the Preferences plugin natively, and the default navigation", async () => {
  resetRestoreRouteForTesting();
  const prefs = fakePlugin(["get", "set"], {
    get: { value: JSON.stringify({ path: "/cart", at: Date.now() - 1000 }) },
  });
  const p = page("/");
  const replaced: string[] = [];
  const events: string[] = [];
  const history = {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url),
  };
  await inShell("ios", { Preferences: prefs.plugin }, async () => {
    assertEquals(await restoreRouteOnRelaunch(), "/cart");
    p.document.fire("pause");
  }, {
    document: p.document,
    location: p.location,
    history,
    dispatchEvent: (e: Event) => void events.push(e.type),
  });
  assertEquals(replaced, ["/cart"]);
  assertEquals(events, ["popstate"]);
  assertEquals(prefs.calls[0], ["get", { key: "denext:last-route" }]);
  const [method, arg] = prefs.calls[1] as [string, Any];
  assertEquals([method, arg.key, JSON.parse(arg.value).path], ["set", "denext:last-route", "/"]);
});
