// React Native mode's round-4 shims over existing denext/mobile capabilities, in a faked
// Capacitor shell and on the web: expo-store-review, expo-screen-orientation,
// expo-navigation-bar, expo-screen-capture, expo-media-library, react-native-fast-image, the
// React Native core additions (Settings, DrawerLayoutAndroid, TouchableNativeFeedback,
// Image.resolveAssetSource) and denext/mobile's useReducedMotion.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import * as StoreReview from "../src/expo/store-review.ts";
import * as ScreenOrientation from "../src/expo/screen-orientation.ts";
import * as NavigationBar from "../src/expo/navigation-bar.ts";
import * as ScreenCapture from "../src/expo/screen-capture.ts";
import * as MediaLibrary from "../src/expo/media-library.ts";
import * as MediaLibraryLegacy from "../src/expo/media-library-legacy.ts";
import FastImage from "../src/react-native-compat/fast-image.ts";
import {
  createTouchableNativeFeedback,
  DrawerLayoutAndroid,
  resolveAssetSource,
  Settings,
  withImageStatics,
} from "../src/react-native/mod.ts";
import { useReducedMotion } from "../src/mobile/accessibility.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

// ---- expo-store-review -----------------------------------------------------------------------

Deno.test("expo-store-review: the review sheet in the shell; nothing and no action on the web", async () => {
  assertEquals(await StoreReview.isAvailableAsync(), false);
  assertEquals(await StoreReview.hasAction(), false);
  await StoreReview.requestReview(); // does nothing
  const review = fakePlugin(["requestReview"]);
  await inShell("ios", { AppReview: review.plugin }, async () => {
    assertEquals(await StoreReview.isAvailableAsync(), true);
    await StoreReview.requestReview();
    assertEquals(review.calls.map(([m]) => m), ["requestReview"]);
    assertEquals(StoreReview.storeUrl(), null);
  });
  await withGlobals({
    __DENEXT_EXPO_CONFIG__: { ios: { appStoreUrl: "https://apps.apple.com/app/id1" } },
  }, async () => {
    assertEquals(StoreReview.storeUrl(), "https://apps.apple.com/app/id1");
    assertEquals(await StoreReview.hasAction(), true);
  });
});

// ---- expo-screen-orientation -----------------------------------------------------------------

Deno.test("expo-screen-orientation: locks, reads and listens through @capacitor/screen-orientation", async () => {
  const orientation = fakePlugin(["orientation", "lock", "unlock"], {
    orientation: { type: "landscape-secondary" },
  });
  await inShell("android", { ScreenOrientation: orientation.plugin }, async () => {
    const { OrientationLock, Orientation } = ScreenOrientation;
    await ScreenOrientation.lockAsync(OrientationLock.LANDSCAPE_LEFT);
    assertEquals(await ScreenOrientation.getOrientationLockAsync(), OrientationLock.LANDSCAPE_LEFT);
    assertEquals(await ScreenOrientation.getOrientationAsync(), Orientation.LANDSCAPE_RIGHT);
    await ScreenOrientation.lockAsync(OrientationLock.DEFAULT);
    await ScreenOrientation.lockPlatformAsync({
      screenOrientationArrayIOS: [Orientation.PORTRAIT_UP],
    });
    await ScreenOrientation.unlockAsync();
    assertEquals(orientation.calls.map(([m, a]) => [m, a]), [
      ["lock", { orientation: "landscape-primary" }],
      ["orientation", undefined],
      ["unlock", undefined],
      ["lock", { orientation: "portrait-primary" }],
      ["unlock", undefined],
    ]);
    await assertRejects(() => ScreenOrientation.lockAsync(OrientationLock.OTHER), TypeError);
    assertEquals(
      await ScreenOrientation.supportsOrientationLockAsync(OrientationLock.UNKNOWN),
      false,
    );
    const events: Any[] = [];
    const sub = ScreenOrientation.addOrientationChangeListener((e) => events.push(e));
    await settle();
    orientation.fire("screenOrientationChange", { type: "portrait-secondary" });
    assertEquals(events[0].orientationInfo.orientation, Orientation.PORTRAIT_DOWN);
    ScreenOrientation.removeOrientationChangeListener(sub);
    ScreenOrientation.addOrientationChangeListener(() => events.push("again"));
    ScreenOrientation.removeOrientationChangeListeners();
    await settle();
    orientation.fire("screenOrientationChange", { type: "portrait-primary" });
    assertEquals(events.length, 1, "every listener removed");
  });
});

// ---- expo-navigation-bar ---------------------------------------------------------------------

Deno.test("expo-navigation-bar: SystemBars on Android only; visibility is what was set", async () => {
  assertEquals(await NavigationBar.getVisibilityAsync(), "hidden", "Expo's web answer");
  const bars = fakePlugin(["setStyle", "show", "hide"]);
  await inShell("android", { SystemBars: bars.plugin }, async () => {
    const seen: string[] = [];
    const sub = NavigationBar.addVisibilityListener((e) => seen.push(e.visibility));
    NavigationBar.setStyle("light");
    await NavigationBar.setVisibilityAsync("hidden");
    assertEquals(await NavigationBar.getVisibilityAsync(), "hidden");
    sub.remove();
    await NavigationBar.setVisibilityAsync("visible");
    await settle();
    assertEquals(seen, ["hidden"]);
    assertEquals(bars.calls, [
      ["setStyle", { style: "DARK", bar: "NavigationBar" }],
      ["hide", { bar: "NavigationBar" }],
      ["show", { bar: "NavigationBar" }],
    ]);
  });
  const ios = fakePlugin(["setStyle", "show", "hide"]);
  await inShell("ios", { SystemBars: ios.plugin }, async () => {
    NavigationBar.setStyle("dark");
    await NavigationBar.setVisibilityAsync("hidden");
    assertEquals(ios.calls, [], "iOS has no navigation bar");
  });
});

// ---- expo-screen-capture ---------------------------------------------------------------------

Deno.test("expo-screen-capture: keys hold FLAG_SECURE until the last releases it", async () => {
  const privacy = fakePlugin(["enable", "disable"]);
  await inShell("android", { PrivacyScreen: privacy.plugin }, async () => {
    assertEquals(await ScreenCapture.isAvailableAsync(), true);
    await ScreenCapture.preventScreenCaptureAsync("a");
    await ScreenCapture.preventScreenCaptureAsync("b");
    await ScreenCapture.allowScreenCaptureAsync("a");
    await ScreenCapture.allowScreenCaptureAsync("b");
    await ScreenCapture.allowScreenCaptureAsync("never-held");
    const calls = privacy.calls.map(([m, a]) => [m, (a as Any)?.android?.preventScreenshots]);
    assertEquals(calls, [
      ["enable", true],
      ["enable", true],
      ["enable", true],
      ["disable", undefined],
    ]);
    await ScreenCapture.enableAppSwitcherProtectionAsync(0.2);
    assertEquals((privacy.calls.at(-1)![1] as Any).ios.blurEffect, "light");
    await ScreenCapture.disableAppSwitcherProtectionAsync();
    assertEquals(privacy.calls.at(-1)![0], "disable");
    assertEquals((await ScreenCapture.getPermissionsAsync()).granted, true);
  });
});

// ---- expo-media-library ----------------------------------------------------------------------

Deno.test("expo-media-library: save, albums and the newest assets over @capacitor-community/media", async () => {
  assertEquals(MediaLibraryLegacy.saveToLibraryAsync, MediaLibrary.saveToLibraryAsync);
  const media = fakePlugin(["savePhoto", "saveVideo", "getAlbums", "createAlbum", "getMedias"], {
    savePhoto: { identifier: "P1" },
    saveVideo: { identifier: "V1" },
    getAlbums: {
      albums: [{ identifier: "A1", name: "Trips", type: "user" }, {
        identifier: "S1",
        name: "Recents",
        type: "smart",
      }],
    },
    getMedias: {
      medias: [{
        identifier: "M1",
        data: "data:image/jpeg;base64,AA",
        creationDate: "2026-01-02T00:00:00Z",
        fullWidth: 4,
        fullHeight: 3,
      }],
    },
  });
  await inShell("ios", { Media: media.plugin }, async () => {
    assertEquals(await MediaLibrary.isAvailableAsync(), true);
    await MediaLibrary.saveToLibraryAsync("file:///tmp/clip.mov");
    const asset = await MediaLibrary.createAssetAsync("file:///tmp/a.jpg", "A1");
    assertEquals([asset.id, asset.mediaType], ["P1", "photo"]);
    assertEquals(media.calls.find(([m]) => m === "saveVideo")![1], {
      path: "file:///tmp/clip.mov",
    });
    assertEquals(
      (media.calls.filter(([m]) => m === "savePhoto").at(-1)![1] as Any).albumIdentifier,
      "A1",
    );
    assertEquals((await MediaLibrary.getAlbumsAsync()).map((a) => a.title), ["Trips"]);
    assertEquals(
      (await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true })).map((a) => a.type),
      ["album", "smartAlbum"],
    );
    assertEquals((await MediaLibrary.getAlbumAsync("Trips"))?.id, "A1");
    assertEquals(await MediaLibrary.getAlbumAsync("None"), null);
    const page = await MediaLibrary.getAssetsAsync({ first: 5, mediaType: ["photo", "video"] });
    assertEquals(page.assets[0].id, "M1");
    assertEquals(page.assets[0].creationTime, Date.parse("2026-01-02T00:00:00Z"));
    assertEquals([page.hasNextPage, page.totalCount], [false, 1]);
    assertEquals((media.calls.find(([m]) => m === "getMedias")![1] as Any).types, "all");
    await assertRejects(() => MediaLibrary.deleteAssetsAsync("M1"), Error, "not available");
    assertEquals(await MediaLibrary.albumNeedsMigrationAsync("A1"), false);
  });
});

Deno.test("expo-media-library (SDK 58): album types, metadata, smart albums and URI versions", async () => {
  const { Album, AlbumType, AssetUriVersion, Query } = MediaLibrary;
  assertEquals([AlbumType.ALBUM, AlbumType.SMART_ALBUM], ["album", "smartAlbum"]);
  assertEquals([AssetUriVersion.CURRENT, AssetUriVersion.ORIGINAL], ["current", "original"]);
  const media = fakePlugin(["savePhoto", "saveVideo", "getAlbums", "createAlbum", "getMedias"], {
    getAlbums: {
      albums: [
        { identifier: "A1", name: "Trips", type: "user" },
        { identifier: "S1", name: "Recents", type: "smart" },
        { identifier: "D1", name: "Shared", type: "shared" },
      ],
    },
    getMedias: { medias: [{ identifier: "M1", data: "data:image/jpeg;base64,AA" }] },
  });
  await inShell("ios", { Media: media.plugin }, async () => {
    assertEquals(await Album.getAlbumsMetadata(), [
      { id: "A1", title: "Trips", type: AlbumType.ALBUM },
      { id: "S1", title: "Recents", type: AlbumType.SMART_ALBUM },
      { id: "D1", title: "Shared", type: AlbumType.ALBUM },
    ]);
    assertEquals((await Album.getSmartAlbums()).map((a) => a.id), ["S1"]);
    assertEquals(await new Album("S1").getType(), "smartAlbum");
    assertEquals(await new Album("A1").getType(), "album");
    await assertRejects(() => new Album("gone").getType(), Error, "not found");
    const [asset] = await new Query().exe();
    assertEquals(
      await asset.getUri({ version: AssetUriVersion.ORIGINAL }),
      "data:image/jpeg;base64,AA",
    );
  });
  // Android's plugin reports no type: the metadata says null, getType a regular album.
  const android = fakePlugin(["savePhoto", "saveVideo", "getAlbums", "createAlbum", "getMedias"], {
    getAlbums: { albums: [{ identifier: "/Pictures/Saved", name: "Saved" }] },
  });
  await inShell("android", { Media: android.plugin }, async () => {
    assertEquals((await Album.getAlbumsMetadata())[0].type, null);
    assertEquals(await new Album("/Pictures/Saved").getType(), "album");
    assertEquals(await Album.getSmartAlbums(), []);
  });
});

Deno.test("expo-media-library: SDK 58's class API (Asset, Album, Query) over the same plugin", async () => {
  const { Album, Asset, AssetField, MediaType, Query } = MediaLibrary;
  assertEquals([MediaType.IMAGE, MediaLibraryLegacy.MediaType.photo], ["image", "photo"]);
  const media = fakePlugin(["savePhoto", "saveVideo", "getAlbums", "createAlbum", "getMedias"], {
    savePhoto: { identifier: "P9" },
    getAlbums: { albums: [{ identifier: "A1", name: "Trips", type: "user" }] },
    getMedias: {
      medias: [
        { identifier: "M1", data: "data:image/jpeg;base64,AA", fullWidth: 4, fullHeight: 3 },
        { identifier: "M2", data: "data:image/jpeg;base64,BB", duration: 5 },
      ],
    },
  });
  await inShell("ios", { Media: media.plugin }, async () => {
    const trips = (await Album.get("Trips"))!;
    assertEquals([trips.id, await trips.getTitle()], ["A1", "Trips"]);
    assertEquals(await Album.get("Nope"), null);
    assertEquals((await Album.getAll()).map((a) => a.id), ["A1"]);
    const saved = await Asset.create("file:///tmp/a.jpg", trips);
    assertEquals([saved.id, await saved.getMediaType()], ["P9", "image"]);
    assertEquals(
      (media.calls.find(([m]) => m === "savePhoto")![1] as Any).albumIdentifier,
      "A1",
    );
    const listed = await new Query().eq(AssetField.MEDIA_TYPE, MediaType.VIDEO).offset(1)
      .limit(1).album(trips).exe();
    const request = media.calls.find(([m]) => m === "getMedias")![1] as Any;
    assertEquals([request.types, request.quantity, request.albumIdentifier], ["videos", 2, "A1"]);
    assertEquals(listed.map((a) => a.id), ["M2"]);
    assertEquals(await listed[0].getDuration(), 5);
    assertEquals(await listed[0].getMediaType(), "video");
    assertEquals(await listed[0].getUri(), "data:image/jpeg;base64,BB");
    await assertRejects(() => listed[0].getExif(), Error, "not available");
    await assertRejects(() => Asset.delete(listed), Error, "not available");
    await assertRejects(() => MediaLibrary.presentPermissionsPicker(), Error, "not available");
    assertEquals(await new Asset("x").getMediaSubtypes(), []);
  });
});

// ---- react-native-fast-image -------------------------------------------------------------------

Deno.test("react-native-fast-image: an image (an <img> without react-native-web) with the statics", async () => {
  const loads: unknown[] = [];
  const { container } = mount(() =>
    h(FastImage as Any, {
      source: { uri: "https://x/a.png", priority: FastImage.priority.high },
      resizeMode: FastImage.resizeMode.center,
      style: { width: 10, height: 10 },
      onLoad: (e: unknown) => loads.push(e),
    })
  );
  const img = container.firstChild;
  assertEquals(img.tagName, "IMG");
  assertEquals(img.getAttribute("src"), "https://x/a.png");
  assertEquals(img.style.getPropertyValue("object-fit"), "none");
  const over = mount(() =>
    h(FastImage as Any, { source: "https://x/b.png" }, h("span", null, "caption"))
  );
  assertEquals(over.container.firstChild.childNodes.length, 2, "the image and its children");
  await FastImage.clearMemoryCache();
  await FastImage.clearDiskCache();
  const made: string[] = [];
  await withGlobals({
    Image: class {
      set src(v: string) {
        made.push(v);
      }
    },
  }, () => FastImage.preload([{ uri: "https://x/c.png" }, {}]));
  assertEquals(made, ["https://x/c.png"]);
});

// ---- React Native core additions -------------------------------------------------------------

Deno.test("Settings: values in localStorage; watchKeys fires for its keys until cleared", async () => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  await withGlobals({ localStorage }, () => {
    let fired = 0;
    const id = Settings.watchKeys(["theme"], () => fired++);
    Settings.set({ theme: "dark", count: 2 });
    assertEquals(Settings.get("theme"), "dark");
    assertEquals(Settings.get("count"), 2);
    assertEquals(Settings.get("missing"), undefined);
    Settings.set({ other: 1 });
    Settings.clearWatch(id);
    Settings.set({ theme: undefined });
    assertEquals(fired, 1);
    assertEquals(Settings.get("theme"), undefined);
    assert(store.has("denext:rn-settings:count"));
  });
});

Deno.test("DrawerLayoutAndroid: renders the screen and the drawer; the ref opens it", async () => {
  const ref: { current: Any } = { current: null };
  let opened = 0;
  const { container } = mount(() =>
    h(DrawerLayoutAndroid as Any, {
      ref,
      drawerWidth: 200,
      renderNavigationView: () => h("nav", null, "menu"),
      onDrawerOpen: () => opened++,
    }, h("main", null, "screen"))
  );
  assert(container.textContent.includes("screen"));
  assert(container.textContent.includes("menu"));
  assertEquals(typeof ref.current.openDrawer, "function");
  ref.current.openDrawer();
  await new Promise((r) => setTimeout(r, 300));
  await settle();
  assertEquals(opened, 1);
});

Deno.test("TouchableNativeFeedback: the child gets the press handlers; the statics are inert", () => {
  const configs: Any[] = [];
  const TNF = createTouchableNativeFeedback((_host, config) => {
    configs.push(config);
    return { onClick: () => (config.onPress as () => void)() };
  });
  let pressed = 0;
  const { container } = mount(() =>
    h(TNF as Any, {
      onPress: () => pressed++,
      testID: "row",
      background: TNF.Ripple("#f00", false),
    }, h("div", { id: "child" }, "Row"))
  );
  const child = container.firstChild;
  assertEquals(child.getAttribute("id"), "child", "no wrapper view");
  assertEquals(child.getAttribute("testID") ?? child.getAttribute("testid"), "row");
  assertEquals(configs[0].onPress !== undefined, true);
  (configs[0].onPress as () => void)();
  assertEquals(pressed, 1);
  assertEquals(TNF.canUseNativeForeground(), false);
  assertEquals(TNF.SelectableBackground().type, "ThemeAttrAndroid");
});

Deno.test("Image.resolveAssetSource: URLs resolve to themselves; the statics are added once", () => {
  assertEquals(resolveAssetSource("/a@2x.png"), { uri: "/a@2x.png", scale: 1 });
  assertEquals(resolveAssetSource([{ uri: "/b.png", width: 3, height: 4, scale: 2 }]), {
    uri: "/b.png",
    width: 3,
    height: 4,
    scale: 2,
  });
  assertEquals(resolveAssetSource(12), null, "a Metro asset number has no URL here");
  assertEquals(resolveAssetSource(""), null);
  const sizes: unknown[] = [];
  const Image = withImageStatics(Object.assign(() => null, {
    getSize: (uri: string, ok: (w: number, h: number) => void) => {
      sizes.push(uri);
      ok(1, 2);
    },
    prefetch: (uri: string) => Promise.resolve(uri),
  })) as Any;
  assertEquals(Image.resolveAssetSource("/c.png").uri, "/c.png");
  let got: unknown;
  Image.getSizeWithHeaders("/d.png", { A: "1" }, (w: number, hh: number) => (got = [w, hh]));
  assertEquals([sizes, got], [["/d.png"], [1, 2]]);
  assertEquals(withImageStatics(7), 7, "not an Image: unchanged");
});

Deno.test("useReducedMotion: follows prefers-reduced-motion, live", async () => {
  const listeners = new Set<() => void>();
  const query = {
    matches: true,
    addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
  };
  await withGlobals({ matchMedia: () => query }, async () => {
    let seen: boolean | undefined;
    function Probe() {
      seen = useReducedMotion();
      return null;
    }
    const { root } = mount(() => h(Probe as Any, null));
    await settle();
    assertEquals(seen, true);
    query.matches = false;
    for (const fn of listeners) fn();
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(seen, false);
    root.unmount();
    assertEquals(listeners.size, 0);
  });
});
