// React Native mode's second overlay round, behaviour: Platform.select's shell fallback and
// Platform.constants, Linking.openSettings, PermissionsAndroid, ToastAndroid, ActionSheetIOS,
// DevSettings, PlatformColor / DynamicColorIOS, RootTagContext, the useAnimatedValue family,
// SafeAreaView, react-native-safe-area-context's NativeSafeAreaProvider and
// InputAccessoryView (src/react-native/), in a faked Capacitor shell and on the web. The build
// wiring (the entry additions) is in react-native-core-build.test.ts.

import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useContext } from "../src/runtime/hooks.ts";
import {
  ActionSheetIOS,
  createAnimatedHook,
  createInputAccessoryView,
  createNativeSafeAreaProvider,
  createSafeAreaView,
  DevSettings,
  DynamicColorIOS,
  Linking,
  PermissionsAndroid,
  Platform,
  PlatformColor,
  RootTagContext,
  ToastAndroid,
} from "../src/react-native/mod.ts";
import { resetToastAndroidForTesting } from "../src/react-native/toast-android.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

/** Every element under `root`, depth-first. */
function walk(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (n: Any) => {
    if (n?.nodeType === 1) out.push(n);
    for (const c of n?.childNodes ?? []) visit(c);
  };
  visit(root);
  return out;
}

/** A fake react-native-web View: flattens its style array into `data-style`. */
function fakeView(props: Any) {
  const flat = Object.assign({}, ...[props.style].flat(Infinity).filter(Boolean));
  return h(
    "div",
    { "data-style": JSON.stringify(flat), "data-native-id": props.nativeID },
    props.children,
  );
}

/** The parsed `data-style` of `el`. */
const styleData = (el: Any) => JSON.parse(el.getAttribute("data-style"));

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0";

// ---- Platform ----------------------------------------------------------------

Deno.test("Platform.select: web first; the shell's own ios/android key; then default; never native", async () => {
  const spec = { ios: "ios", android: "android", native: "native", default: "default" };
  assertEquals(Platform.select(spec), "default", "a browser: default");
  assertEquals(Platform.select({ ios: 1, android: 2 }), undefined, "a browser has no ios/android");
  assertEquals(Platform.select({ web: "web", ...spec }), "web");
  await inShell("ios", {}, () => {
    assertEquals(Platform.select(spec), "ios");
    assertEquals(Platform.select({ ios: 44, android: 56 }), 44, "not undefined in the shell");
    assertEquals(Platform.select({ web: "web", ios: "ios" }), "web", "web still wins");
    assertEquals(Platform.select({ android: 1, native: 2, default: 3 }), 3, "native is skipped");
    assertEquals(Platform.select({ android: 1, native: 2 }), undefined);
  });
  await inShell("android", {}, () => {
    assertEquals(Platform.select(spec), "android");
    assertEquals(Platform.select({ ios: 44, android: 56 }), 56);
  });
  await withGlobals({ __denext: { desktop: true } }, () => {
    assertEquals(Platform.select(spec), "default", "Deno Desktop: as a browser");
  });
});

Deno.test("Platform.constants: RN's shared fields per shell, plus denextShell", async () => {
  const web = Platform.constants;
  assertEquals(web.denextShell, "web");
  assertEquals(web.systemName, "web");
  assertEquals(web.reactNativeVersion, { major: 0, minor: 86, patch: 3, prerelease: null });
  assertEquals(web.forceTouchAvailable, false);
  await inShell("ios", {}, () => {
    const c = Platform.constants;
    assertEquals([c.denextShell, c.systemName, c.osVersion, c.interfaceIdiom], [
      "ios",
      "iOS",
      "17.4",
      "phone",
    ]);
  }, { navigator: { userAgent: IPHONE_UA } });
  await inShell("android", {}, () => {
    const c = Platform.constants;
    assertEquals([c.denextShell, c.systemName, c.osVersion, c.Version, c.Release], [
      "android",
      "Android",
      "14",
      34,
      "14",
    ]);
  }, { navigator: { userAgent: ANDROID_UA } });
  await withGlobals({
    __denext: { desktop: true },
    matchMedia: (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" }),
  }, () => {
    assertEquals(Platform.constants.denextShell, "desktop");
    assertEquals(Platform.constants.isDisableAnimations, true);
  });
});

// ---- Linking.openSettings ------------------------------------------------------

Deno.test("Linking.openSettings: openAppSettings (DenextSettings in the shell); rejects in a browser", async () => {
  const settings = fakePlugin(["open"]);
  await inShell("android", { DenextSettings: settings.plugin }, async () => {
    await Linking.openSettings();
  });
  assertEquals(settings.calls, [["open", undefined]]);
  const opened: unknown[][] = [];
  await inShell("ios", {}, async () => {
    await Linking.openSettings();
  }, { open: (...a: unknown[]) => void opened.push(a) });
  assertEquals(opened, [["app-settings:", "_blank"]], "iOS without the plugin: app-settings:");
  await assertRejects(() => Linking.openSettings(), Error, "system settings");
});

// ---- PermissionsAndroid ------------------------------------------------------

Deno.test("PermissionsAndroid: check / request over denext/mobile permissions; RESULTS; rationale", async () => {
  const { PERMISSIONS, RESULTS } = PermissionsAndroid;
  assertEquals(PERMISSIONS.CAMERA, "android.permission.CAMERA");
  assertEquals(RESULTS, {
    DENIED: "denied",
    GRANTED: "granted",
    NEVER_ASK_AGAIN: "never_ask_again",
  });
  const camera = fakePlugin(["checkPermissions", "requestPermissions"], {
    checkPermissions: { camera: "prompt-with-rationale", photos: "limited" },
    requestPermissions: { camera: "granted" },
  });
  const geo = fakePlugin(["checkPermissions", "requestPermissions"], {
    checkPermissions: { location: "denied", coarseLocation: "granted" },
    requestPermissions: { location: "denied", coarseLocation: "granted" },
  });
  const dialog = fakePlugin(["alert", "confirm", "prompt"], { confirm: { value: true } });
  await inShell("android", {
    Camera: camera.plugin,
    Geolocation: geo.plugin,
    Dialog: dialog.plugin,
  }, async () => {
    assertEquals(await PermissionsAndroid.check(PERMISSIONS.CAMERA), false);
    const status = await PermissionsAndroid.request(PERMISSIONS.CAMERA, {
      title: "Camera",
      message: "Scan receipts.",
      buttonNegative: "Not now",
      buttonPositive: "Continue",
    });
    assertEquals(status, "granted");
    assertEquals(dialog.calls[0], ["confirm", {
      title: "Camera",
      message: "Scan receipts.",
      okButtonTitle: "Continue",
      cancelButtonTitle: "Not now",
    }], "the rationale first (Android asked for one)");
    assertEquals(camera.calls.at(-1), ["requestPermissions", { permissions: ["camera"] }]);
    // Approximate location only: coarse is granted, fine is not.
    assertEquals(await PermissionsAndroid.check(PERMISSIONS.ACCESS_COARSE_LOCATION), true);
    assertEquals(await PermissionsAndroid.check(PERMISSIONS.ACCESS_FINE_LOCATION), false);
    // Selected photos only: the full-access names read denied.
    assertEquals(await PermissionsAndroid.check(PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED), true);
    assertEquals(await PermissionsAndroid.check(PERMISSIONS.READ_MEDIA_IMAGES), false);
    const many = await PermissionsAndroid.requestMultiple([
      PERMISSIONS.ACCESS_FINE_LOCATION,
      PERMISSIONS.ACCESS_COARSE_LOCATION,
      PERMISSIONS.BLUETOOTH_SCAN,
    ]);
    assertEquals(many as Record<string, string>, {
      [PERMISSIONS.ACCESS_FINE_LOCATION]: "denied",
      [PERMISSIONS.ACCESS_COARSE_LOCATION]: "granted",
      [PERMISSIONS.BLUETOOTH_SCAN]: "denied",
    }, "no web-view equivalent: denied");
    assertEquals(
      geo.calls.filter(([m]) => m === "requestPermissions").length,
      0,
      "limited location is decided: no prompt",
    );
    assertEquals(await PermissionsAndroid.requestPermission(PERMISSIONS.SEND_SMS), false);
    assertEquals(await PermissionsAndroid.checkPermission(PERMISSIONS.CAMERA), false);
  });
  // A refused permission the OS will not ask again for: never_ask_again.
  const blocked = fakePlugin(["checkPermissions", "requestPermissions"], {
    checkPermissions: { camera: "denied" },
  });
  await inShell("android", { Camera: blocked.plugin }, async () => {
    assertEquals(await PermissionsAndroid.request(PERMISSIONS.CAMERA), "never_ask_again");
  });
});

// ---- ToastAndroid ------------------------------------------------------------

Deno.test("ToastAndroid: @capacitor/toast in the Android shell; an in-page status toast elsewhere", async () => {
  assertEquals(
    [
      ToastAndroid.SHORT,
      ToastAndroid.LONG,
      ToastAndroid.TOP,
      ToastAndroid.BOTTOM,
      ToastAndroid.CENTER,
    ],
    [0, 1, 49, 81, 17],
  );
  const toast = fakePlugin(["show"]);
  await inShell("android", { Toast: toast.plugin }, () => {
    ToastAndroid.show("Saved", ToastAndroid.SHORT);
    ToastAndroid.showWithGravity("Offline", ToastAndroid.LONG, ToastAndroid.TOP);
  });
  assertEquals(toast.calls, [
    ["show", { text: "Saved", duration: "short", position: "bottom" }],
    ["show", { text: "Offline", duration: "long", position: "top" }],
  ]);

  const { doc } = makeDom();
  const timers: Array<[() => void, number]> = [];
  try {
    await withGlobals({
      document: doc,
      setTimeout: (fn: () => void, ms: number) => (timers.push([fn, ms]), timers.length),
    }, async () => {
      ToastAndroid.showWithGravityAndOffset("One", ToastAndroid.LONG, ToastAndroid.BOTTOM, 0, 20);
      ToastAndroid.show("Two", ToastAndroid.SHORT);
      await settle();
      let toasts = walk(doc.body).filter((el) => el.getAttribute("data-denext-toast") !== null);
      assertEquals(toasts.map((t) => t.textContent), ["One"], "toasts queue: one at a time");
      assertEquals(toasts[0].getAttribute("role"), "status");
      assertEquals(
        toasts[0].style.getPropertyValue("transform"),
        "translateX(-50%) translate(0px, -20px)",
      );
      assertEquals(timers.map(([, ms]) => ms), [3500], "LONG: 3.5 s");
      timers[0][0]();
      await settle();
      toasts = walk(doc.body).filter((el) => el.getAttribute("data-denext-toast") !== null);
      assertEquals(toasts.map((t) => t.textContent), ["Two"]);
      assertEquals(timers[1][1], 2000, "SHORT: 2 s");
      timers[1][0]();
      await settle();
    });
  } finally {
    resetToastAndroidForTesting();
  }
});

// ---- ActionSheetIOS ----------------------------------------------------------

Deno.test("ActionSheetIOS: @capacitor/action-sheet in the shell, with RN's indices", async () => {
  const sheet = fakePlugin(["showActions"], { showActions: { index: 2, canceled: false } });
  const picked: number[] = [];
  await inShell("ios", { ActionSheet: sheet.plugin }, async () => {
    ActionSheetIOS.showActionSheetWithOptions({
      title: "Thread",
      options: ["Cancel", "Archive", "Delete"],
      cancelButtonIndex: 0,
      destructiveButtonIndex: [2],
    }, (i) => void picked.push(i));
    await settle();
  });
  assertEquals(sheet.calls, [["showActions", {
    title: "Thread",
    options: [
      { title: "Cancel", style: "CANCEL" },
      { title: "Archive", style: "DEFAULT" },
      { title: "Delete", style: "DESTRUCTIVE" },
    ],
    cancelable: true,
  }]]);
  assertEquals(picked, [2]);
  const canceled = fakePlugin(["showActions"], { showActions: { index: -1, canceled: true } });
  await inShell("android", { ActionSheet: canceled.plugin }, async () => {
    ActionSheetIOS.showActionSheetWithOptions({ options: ["A", "B"] }, (i) => void picked.push(i));
    await settle();
  });
  assertEquals(picked.at(-1), -1, "dismissed without a cancel option: -1");
});

Deno.test("ActionSheetIOS (web): the in-page dialog; disabled options use the context menu", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const picked: number[] = [];
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Cancel", "Share", "Delete"], cancelButtonIndex: 0, destructiveButtonIndex: 2 },
      (i) => void picked.push(i),
    );
    await settle();
    const card = walk(doc.body).find((el) => el.getAttribute("role") === "alertdialog")!;
    const buttons = walk(card).filter((el) => el.tagName === "BUTTON");
    assertEquals(buttons.map((b) => [b.textContent, b.getAttribute("data-style")]), [
      ["Cancel", "cancel"],
      ["Share", "default"],
      ["Delete", "destructive"],
    ]);
    buttons[1].dispatch("click");
    await settle();
    assertEquals(picked, [1]);

    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Copy", "Paste"], disabledButtonIndices: [1], cancelButtonIndex: 5 },
      (i) => void picked.push(i),
    );
    await settle();
    const menu = walk(doc.body).find((el) => el.getAttribute("role") === "menu")!;
    const items = walk(menu).filter((el) => el.getAttribute("role") === "menuitem");
    assertEquals(items.map((i) => i.getAttribute("aria-disabled")), [null, "true"]);
    menu.dispatch("keydown", { key: "Escape" });
    await settle();
    assertEquals(picked.at(-1), 5, "a dismissal reports cancelButtonIndex");
  });
});

Deno.test("ActionSheetIOS.showShareActionSheetWithOptions: RN's callbacks over Share", async () => {
  const share = fakePlugin(["share"], { share: {} });
  const calls: unknown[][] = [];
  await inShell("ios", { Share: share.plugin }, async () => {
    ActionSheetIOS.showShareActionSheetWithOptions(
      { url: "https://denext.dev", message: "Look" },
      (e) => void calls.push(["failure", e.code]),
      (ok, method) => void calls.push(["success", ok, method]),
    );
    await settle();
  });
  assertEquals(share.calls.length, 1);
  assertEquals(calls, [["success", true, null]]);
  ActionSheetIOS.dismissActionSheet();
});

// ---- DevSettings, RootTagContext, useAnimatedValue ------------------------------

Deno.test("DevSettings: reload reloads the page; addMenuItem is accepted; the emitter works", async () => {
  let reloads = 0;
  await withGlobals({ location: { reload: () => void reloads++ } }, () => {
    DevSettings.reload("because");
    DevSettings.addMenuItem("Inspect", () => {});
    DevSettings.onFastRefresh();
  });
  assertEquals(reloads, 1);
  const seen: unknown[] = [];
  const sub = DevSettings.addListener("didPressMenuItem", (e) => void seen.push(e));
  assertEquals(DevSettings.listenerCount("didPressMenuItem"), 1);
  DevSettings.emit("didPressMenuItem", { title: "Inspect" });
  sub.remove();
  sub.remove();
  DevSettings.emit("didPressMenuItem", { title: "again" });
  assertEquals(seen, [{ title: "Inspect" }]);
  assertEquals(DevSettings.listenerCount("didPressMenuItem"), 0);
  DevSettings.addListener("x", () => {});
  DevSettings.removeAllListeners();
  assertEquals(DevSettings.listenerCount("x"), 0);
});

Deno.test("RootTagContext reads 1; createAnimatedHook keeps one node per component", () => {
  class Value {
    constructor(readonly value: unknown, readonly config: unknown) {}
  }
  const made: Value[] = [];
  const useAnimatedValue = createAnimatedHook({
    Value: class extends Value {
      constructor(v: unknown, c: unknown) {
        super(v, c);
        made.push(this);
      }
    },
  }, "Value");
  const seen: unknown[] = [];
  function Reader() {
    seen.push([useContext(RootTagContext), useAnimatedValue(0.5, { useNativeDriver: false })]);
    return null;
  }
  let renders = 0;
  const { rerender, root } = mount(() => h(Reader as Any, { n: ++renders }));
  rerender();
  root.unmount();
  assertEquals(made.length, 1, "built on the first render only");
  assertEquals(seen.map(([tag]: Any) => tag), [1, 1]);
  assertStrictEquals((seen[0] as Any)[1], (seen[1] as Any)[1], "the same node every render");
  assertEquals([made[0].value, made[0].config], [0.5, { useNativeDriver: false }]);
});

// ---- PlatformColor / DynamicColorIOS -----------------------------------------------

Deno.test("PlatformColor / DynamicColorIOS: system colours as CSS, per scheme or light-dark()", async () => {
  const media = (dark: boolean, contrast = false) => (q: string) => ({
    matches: (q === "(prefers-color-scheme: dark)" && dark) ||
      (q === "(prefers-contrast: more)" && contrast),
  });
  await withGlobals({ matchMedia: media(false) }, () => {
    assertEquals(PlatformColor("label"), "#000000");
    assertEquals(PlatformColor("nope", "systemBlue"), "#007aff", "the first known name wins");
    assertEquals(PlatformColor("@android:color/holo_blue_bright"), "#00ddff");
    assertEquals(PlatformColor("?android:attr/textColorPrimary"), "#1d1b20");
    assertEquals(PlatformColor("?attr/colorAccent"), "#6750a4");
    assertEquals(DynamicColorIOS({ light: "white", dark: "black" }), "white");
  });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    assertEquals(PlatformColor("madeUp"), undefined, "unknown: the style property stays unset");
    PlatformColor("madeUp");
  } finally {
    console.warn = warn;
  }
  assertEquals(warnings.length, 1, "warned once per name");
  await withGlobals({ matchMedia: media(true, true) }, () => {
    assertEquals(PlatformColor("label"), "#ffffff");
    assertEquals(
      DynamicColorIOS({ light: "white", dark: "black", highContrastDark: "#111" }),
      "#111",
      "Increase Contrast",
    );
  });
  // An Appearance.setColorScheme override (the root's color-scheme) beats the system.
  await withGlobals({
    matchMedia: media(true),
    document: { documentElement: { style: { colorScheme: "light" } } },
  }, () => {
    assertEquals(PlatformColor("systemBackground"), "#ffffff");
  });
  // A page that lets the browser switch schemes gets a live light-dark().
  await withGlobals({
    matchMedia: media(false),
    CSS: { supports: () => true },
    document: { documentElement: { style: {} } },
    getComputedStyle: () => ({ colorScheme: "light dark" }),
  }, () => {
    assertEquals(PlatformColor("separator"), "light-dark(rgba(60,60,67,0.29), rgba(84,84,88,0.6))");
    assertEquals(DynamicColorIOS({ light: "#fff", dark: "#000" }), "light-dark(#fff, #000)");
  });
});

// ---- Safe areas --------------------------------------------------------------

Deno.test("SafeAreaView: pads with denext/mobile's inset source (Capacitor's var, then env())", () => {
  const SafeAreaView = createSafeAreaView(fakeView as Any);
  const { container, root } = mount(() => h(SafeAreaView as Any, { style: { flex: 1 } }, "x"));
  const style = styleData(container.firstChild);
  assertEquals(style.paddingTop, "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))");
  assertEquals(
    style.paddingBottom,
    "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
  );
  assertEquals(style.flex, 1);
  root.unmount();
});

Deno.test("NativeSafeAreaProvider: reports useSafeAreaInsets() as safe-area-context's onInsetsChange", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const insets = {
    paddingTop: "47px",
    paddingRight: "0px",
    paddingBottom: "34px",
    paddingLeft: "0px",
  };
  const events: Any[] = [];
  await withGlobals({
    document: doc,
    getComputedStyle: () => insets,
    requestAnimationFrame: (fn: () => void) => (fn(), 1),
    cancelAnimationFrame: () => {},
    innerWidth: 390,
    innerHeight: 844,
  }, async () => {
    const Provider = createNativeSafeAreaProvider(fakeView as Any);
    const root = createRoot(container as Any);
    root.render(h(Provider as Any, { onInsetsChange: (e: Any) => void events.push(e) }, "app"));
    flushSync();
    await settle();
    flushSync();
    assertEquals(events.at(-1).nativeEvent.insets, { top: 47, right: 0, bottom: 34, left: 0 });
    assert("frame" in events.at(-1).nativeEvent);
    root.unmount();
  });
});

// ---- InputAccessoryView ------------------------------------------------------

Deno.test("InputAccessoryView: docked over the keyboard; with a nativeID only while editing", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  await withGlobals({ document: doc }, () => {
    const Bar = createInputAccessoryView(fakeView as Any);
    const root = createRoot(container as Any);
    root.render(h(Bar as Any, { backgroundColor: "#eee" }, "sticky"));
    flushSync();
    const dock = container.firstChild as Any;
    assertEquals(dock.getAttribute("data-denext-input-accessory"), "");
    assertEquals(dock.style.getPropertyValue("position"), "fixed");
    assertEquals(styleData(dock.firstChild).backgroundColor, "#eee");

    root.render(h(Bar as Any, { nativeID: "composer" }, "tools"));
    flushSync();
    assertEquals(container.childNodes.length, 0, "hidden until a text field is edited");
    const input = doc.createElement("input");
    flushSync(() => doc.dispatch("focusin", { target: input }));
    assertEquals(
      (container.firstChild as Any).getAttribute("data-denext-input-accessory"),
      "composer",
    );
    flushSync(() => doc.dispatch("focusout", { target: input, relatedTarget: null }));
    assertEquals(container.childNodes.length, 0);
    root.unmount();
  });
});
