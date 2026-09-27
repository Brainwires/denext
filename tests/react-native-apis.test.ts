// React Native mode's shell overlay, behaviour: denext's Keyboard, KeyboardAvoidingView,
// BackHandler, StatusBar, AccessibilityInfo, I18nManager, Alert, Platform, Linking, AppState,
// Vibration, Share and Clipboard (src/react-native/), each in a faked Capacitor shell and on
// the web fallback. RefreshControl is in mobile-pull-to-refresh.test.ts with the gesture it
// shares; the build wiring is in react-native-overlay.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  AccessibilityInfo,
  Alert,
  AppState,
  BackHandler,
  Clipboard,
  createKeyboardAvoidingView,
  I18nManager,
  Keyboard,
  Linking,
  Platform,
  Share,
  StatusBar,
  Vibration,
} from "../src/react-native/mod.ts";
import { type KeyboardEvent, resetKeyboardForTesting } from "../src/react-native/keyboard.ts";
import { resetStatusBarForTesting } from "../src/react-native/status-bar.ts";
import { resetAccessibilityInfoForTesting } from "../src/react-native/accessibility-info.ts";
import { resetI18nManagerForTesting } from "../src/react-native/i18n-manager.ts";
import { resetAppStateForTesting } from "../src/react-native/app-state.ts";
import { resetBackForTesting } from "../src/mobile/back-handler.ts";
import { resetDeepLinksForTesting } from "../src/mobile/deep-link.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import {
  type Any,
  fakePlugin,
  fakeViewport,
  frameQueue,
  inShell,
  mount,
  settle,
  Target,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

/** Wait `ms` of real time, then let promise callbacks run. */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await settle();
}

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

// ---- Keyboard ----------------------------------------------------------------

const KEYBOARD_METHODS = ["hide", "setResizeMode", "getResizeMode"];

Deno.test("Keyboard (Android shell): Will + Did events at once, RN's payload, isVisible, metrics", async () => {
  const kb = fakePlugin(KEYBOARD_METHODS);
  try {
    await inShell("android", { Keyboard: kb.plugin }, async () => {
      const seen: Array<[string, KeyboardEvent]> = [];
      const names = ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"];
      const subs = names.map((n) => Keyboard.addListener(n as Any, (e) => void seen.push([n, e])));
      await settle();
      assertEquals(Keyboard.isVisible(), false);
      kb.fire("keyboardWillShow", { keyboardHeight: 280 });
      assertEquals(seen.map(([n]) => n), ["keyboardWillShow", "keyboardDidShow"]);
      assertEquals(seen[0][1], {
        duration: 0,
        easing: "linear",
        endCoordinates: { screenX: 0, screenY: 520, width: 400, height: 280 },
        isEventFromThisApp: true,
      });
      assertEquals(Keyboard.isVisible(), true);
      assertEquals(Keyboard.metrics(), { screenX: 0, screenY: 520, width: 400, height: 280 });
      kb.fire("keyboardWillHide");
      assertEquals(seen.map(([n]) => n).slice(2), ["keyboardWillHide", "keyboardDidHide"]);
      assertEquals(seen[2][1].endCoordinates.height, 0);
      assertEquals(seen[2][1].startCoordinates?.height, 280, "where it was before");
      assertEquals(Keyboard.metrics(), undefined);
      subs[0].remove();
      subs[0].remove();
      Keyboard.removeAllListeners("keyboardDidShow");
      kb.fire("keyboardWillShow", { keyboardHeight: 300 });
      assertEquals(seen.length, 4, "removed and cleared listeners hear nothing");
      Keyboard.dismiss();
      assertEquals(kb.calls.at(-1), ["hide", undefined]);
    }, { document: {}, innerWidth: 400, innerHeight: 800 });
  } finally {
    resetKeyboardForTesting();
  }
});

Deno.test("Keyboard (iOS shell): Did follows Will after UIKit's 250 ms, with the keyboard curve", async () => {
  const kb = fakePlugin(KEYBOARD_METHODS);
  try {
    await inShell("ios", { Keyboard: kb.plugin }, async () => {
      const seen: string[] = [];
      let event: KeyboardEvent | undefined;
      Keyboard.addListener("keyboardWillShow", (e) => void (event = e, seen.push("will")));
      Keyboard.addListener("keyboardDidShow", () => void seen.push("did"));
      const ctx = { hits: 0 };
      Keyboard.addListener(
        "keyboardWillChangeFrame",
        function (this: typeof ctx) {
          this.hits++;
        } as Any,
        ctx,
      );
      await settle();
      kb.fire("keyboardWillShow", { keyboardHeight: 336 });
      assertEquals(seen, ["will"]);
      assertEquals(event?.duration, 250);
      assertEquals(event?.easing, "keyboard");
      assertEquals(ctx.hits, 1, "the listener runs with its context");
      await wait(300);
      assertEquals(seen, ["will", "did"]);
    }, { document: {}, innerWidth: 390, innerHeight: 844 });
  } finally {
    resetKeyboardForTesting();
  }
});

// ---- KeyboardAvoidingView ----------------------------------------------------

/** A fake react-native-web View: flattens its style array into `data-style`, keeps onLayout. */
function fakeView(layouts: Array<(e: Any) => void>) {
  return (props: Any) => {
    if (props.onLayout) layouts.push(props.onLayout);
    const flat = Object.assign({}, ...[props.style].flat(Infinity).filter(Boolean));
    return h("div", { "data-style": JSON.stringify(flat) }, props.children);
  };
}

/** The parsed `data-style` of `el`. */
const styleData = (el: Any) => JSON.parse(el.getAttribute("data-style"));

Deno.test("KeyboardAvoidingView: RN's overlap formula over the view's frame, per behavior", async () => {
  const vv = fakeViewport(800);
  const frames = frameQueue();
  const globals = {
    innerHeight: 800,
    visualViewport: vv,
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
  };
  await withGlobals(globals, () => {
    const cases: Array<[Any, (el: Any) => unknown, unknown]> = [
      [{ behavior: "padding" }, (el) => styleData(el).paddingBottom, 300],
      [
        { behavior: "padding", keyboardVerticalOffset: 50 },
        (el) => styleData(el).paddingBottom,
        350,
      ],
      [{ behavior: "height" }, (el) => [styleData(el).height, styleData(el).flex], [400, 0]],
      [{ behavior: "position" }, (el) => styleData(el.firstChild).bottom, 300],
      [{}, (el) => styleData(el).paddingBottom, undefined],
      [{ behavior: "padding", enabled: false }, (el) => styleData(el).paddingBottom, 0],
    ];
    for (const [props, read, expected] of cases) {
      vv.height = 800;
      const layouts: Array<(e: Any) => void> = [];
      const KAV = createKeyboardAvoidingView(fakeView(layouts) as Any);
      const { root, container } = mount(() => h(KAV as Any, props, "x"));
      // The view spans y 100…800 of an 800 px viewport.
      flushSync(() =>
        layouts.at(-1)!({ nativeEvent: { layout: { x: 0, y: 100, width: 300, height: 700 } } })
      );
      vv.height = 500; // a 300 px keyboard
      vv.fire("resize");
      flushSync(() => frames.flush());
      assertEquals(read(container.firstChild), expected, JSON.stringify(props));
      root.unmount();
    }
  });
});

// ---- BackHandler -------------------------------------------------------------

Deno.test("BackHandler (Android shell): hardwareBackPress is a LIFO stack over onBack", async () => {
  const back = fakePlugin(["setEnabled"]);
  const app = fakePlugin(["exitApp", "minimizeApp"]);
  try {
    await inShell("android", { DenextBack: back.plugin, App: app.plugin }, async () => {
      const calls: string[] = [];
      const first = () => (calls.push("first"), true);
      BackHandler.addEventListener("hardwareBackPress", first);
      const top = BackHandler.addEventListener("hardwareBackPress", () => {
        calls.push("top");
        return false;
      });
      await settle();
      back.fire("backInvoked", { canGoBack: true });
      assertEquals(calls, ["top", "first"], "newest first; false passes it on; true consumes");
      top.remove();
      BackHandler.removeEventListener("hardwareBackPress", first);
      await wait(5);
      assertEquals(back.calls.at(-1), ["setEnabled", { enabled: false }], "no handler left");
      BackHandler.exitApp();
      assertEquals(app.calls.at(-1), ["exitApp", undefined]);
    }, { document: {}, history: { back() {} } });
  } finally {
    resetBackForTesting();
  }
});

Deno.test("BackHandler: accepted and inert outside the Android shell (no console.error)", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    await withGlobals({ document: {} }, () => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
      sub.remove();
      BackHandler.exitApp();
    });
  } finally {
    console.error = original;
    resetBackForTesting();
  }
  assertEquals(errors, []);
});

// ---- StatusBar ---------------------------------------------------------------

const BAR_METHODS = ["setStyle", "show", "hide", "setAnimation"];

Deno.test("StatusBar: the stack merges newest-first, applies diffs to SystemBars, pops restore", async () => {
  const bars = fakePlugin(BAR_METHODS);
  try {
    await inShell("ios", { SystemBars: bars.plugin }, async () => {
      const a = StatusBar.pushStackEntry({ barStyle: "light-content" });
      await settle();
      // The first update applies the whole merged state, as React Native's does.
      assertEquals(bars.calls, [
        ["setStyle", { style: "DARK", bar: "StatusBar" }],
        ["show", { bar: "StatusBar", animation: "NONE" }],
      ]);
      const b = StatusBar.pushStackEntry({ hidden: true, animated: true });
      await settle();
      assertEquals(bars.calls.at(-1), ["hide", { bar: "StatusBar", animation: "FADE" }]);
      const b2 = StatusBar.replaceStackEntry(b, { barStyle: "dark-content" });
      await settle();
      assertEquals(bars.calls.slice(-2), [
        ["setStyle", { style: "LIGHT", bar: "StatusBar" }],
        ["show", { bar: "StatusBar", animation: "NONE" }],
      ]);
      StatusBar.popStackEntry(b2);
      StatusBar.popStackEntry(a);
      await settle();
      assertEquals(bars.calls.at(-1), ["setStyle", { style: "DEFAULT", bar: "StatusBar" }]);
      const before = bars.calls.length;
      StatusBar.setHidden(true, "slide");
      StatusBar.setBarStyle("light-content", true);
      await settle();
      assertEquals(bars.calls.slice(before), [
        ["hide", { bar: "StatusBar", animation: "FADE" }],
        ["setStyle", { style: "DARK", bar: "StatusBar" }],
      ]);
      assertEquals(StatusBar.currentHeight, undefined, "iOS has no currentHeight");
    });
  } finally {
    resetStatusBarForTesting();
  }
});

Deno.test("StatusBar: the component pushes while mounted; Android paints backgroundColor", async () => {
  const bars = fakePlugin(BAR_METHODS);
  const { doc } = makeDom();
  const getComputedStyle = () => ({ paddingTop: "24px" });
  try {
    await inShell("android", { SystemBars: bars.plugin }, async () => {
      const { root } = mount(() =>
        h(StatusBar as Any, { barStyle: "dark-content", backgroundColor: "#123456" })
      );
      await wait(5);
      assertEquals(bars.calls[0], ["setStyle", { style: "LIGHT", bar: "StatusBar" }]);
      const strip = walk(doc.body).find((el) =>
        el.getAttribute("data-denext-status-bar-background") !== null
      );
      assert(strip, "a strip behind the status bar");
      assertEquals(strip.style.getPropertyValue("background"), "#123456");
      assertEquals(StatusBar.currentHeight, 24);
      root.unmount();
      await wait(5);
      assertEquals(bars.calls.at(-1), ["setStyle", { style: "DEFAULT", bar: "StatusBar" }]);
      assertEquals(strip.parentNode, null, "the strip goes with the last color");
    }, { document: doc, getComputedStyle });
  } finally {
    resetStatusBarForTesting();
  }
});

Deno.test("StatusBar: nothing is applied in a browser", async () => {
  const bars = fakePlugin(BAR_METHODS);
  try {
    await withGlobals({ Capacitor: { Plugins: { SystemBars: bars.plugin } } }, async () => {
      StatusBar.pushStackEntry({ barStyle: "light-content", hidden: true });
      StatusBar.setBarStyle("dark-content");
      await settle();
    });
    assertEquals(bars.calls, []);
  } finally {
    resetStatusBarForTesting();
  }
});

// ---- AccessibilityInfo -------------------------------------------------------

/** `matchMedia` answering from `table` (query → a live MediaQueryList fake). */
function mediaTable(table: Record<string, boolean>) {
  const lists = new Map<string, Any>();
  const matchMedia = (q: string) => {
    if (!lists.has(q)) lists.set(q, Object.assign(new Target(), { matches: table[q] === true }));
    return lists.get(q);
  };
  return { matchMedia, list: (q: string) => matchMedia(q) };
}

Deno.test("AccessibilityInfo: media-query settings, their change events, no screen reader", async () => {
  const media = mediaTable({
    "(prefers-reduced-motion: reduce)": true,
    "(prefers-contrast: more)": true,
  });
  await withGlobals({ matchMedia: media.matchMedia }, async () => {
    assertEquals(await AccessibilityInfo.isReduceMotionEnabled(), true);
    assertEquals(await AccessibilityInfo.isHighTextContrastEnabled(), true);
    assertEquals(await AccessibilityInfo.isDarkerSystemColorsEnabled(), true);
    assertEquals(await AccessibilityInfo.isReduceTransparencyEnabled(), false);
    assertEquals(await AccessibilityInfo.isInvertColorsEnabled(), false);
    assertEquals(await AccessibilityInfo.isBoldTextEnabled(), false);
    assertEquals(await AccessibilityInfo.isScreenReaderEnabled(), false, "no web signal");
    const seen: unknown[] = [];
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => void seen.push(v));
    media.list("(prefers-reduced-motion: reduce)").fire("change", { matches: false });
    assertEquals(seen, [false]);
    sub.remove();
    media.list("(prefers-reduced-motion: reduce)").fire("change", { matches: true });
    assertEquals(seen, [false]);
    assertEquals(await AccessibilityInfo.getRecommendedTimeoutMillis(3000), 3000);
  });
  resetAccessibilityInfoForTesting();
  // No matchMedia at all (react-native-web answered `true` here): false.
  assertEquals(await AccessibilityInfo.isReduceMotionEnabled(), false);
});

Deno.test("AccessibilityInfo: a DenextAccessibility plugin answers for the screen reader", async () => {
  const plugin = fakePlugin(["isScreenReaderEnabled"], { isScreenReaderEnabled: { value: true } });
  await inShell("ios", { DenextAccessibility: plugin.plugin }, async () => {
    assertEquals(await AccessibilityInfo.isScreenReaderEnabled(), true);
    const seen: unknown[] = [];
    const handler = (v: unknown) => void seen.push(v);
    AccessibilityInfo.addEventListener("screenReaderChanged", handler);
    await settle();
    plugin.fire("screenReaderChanged", { value: false });
    assertEquals(seen, [false]);
    AccessibilityInfo.removeEventListener("screenReaderChanged", handler);
    await settle();
    assertEquals(plugin.listening(), 0);
  });
  resetAccessibilityInfoForTesting();
});

Deno.test("AccessibilityInfo: announcements go to a live region; focus moves to the node", async () => {
  const { doc } = makeDom();
  try {
    await withGlobals({ document: doc }, async () => {
      const finished: unknown[] = [];
      AccessibilityInfo.addEventListener("announcementFinished", (e) => void finished.push(e));
      AccessibilityInfo.announceForAccessibility("Saved");
      AccessibilityInfo.announceForAccessibilityWithOptions("Now", { queue: false });
      await wait(80);
      const regions = walk(doc.body).filter((el) => el.getAttribute("aria-live"));
      assertEquals(regions.map((r) => [r.getAttribute("aria-live"), r.textContent]), [
        ["polite", "Saved"],
        ["assertive", "Now"],
      ]);
      assertEquals(finished, [
        { announcement: "Saved", success: true },
        { announcement: "Now", success: true },
      ]);
      let focused = 0;
      const node = Object.assign(doc.createElement("div"), { focus: () => void focused++ });
      (node as Any).hasAttribute = (n: string) => node.getAttribute(n) !== null;
      AccessibilityInfo.setAccessibilityFocus(node);
      assertEquals([focused, node.getAttribute("tabindex")], [1, "-1"]);
      AccessibilityInfo.sendAccessibilityEvent(node, "focus");
      assertEquals(focused, 2);
    });
  } finally {
    resetAccessibilityInfoForTesting();
  }
});

// ---- I18nManager -------------------------------------------------------------

Deno.test("I18nManager: isRTL from dir / locale; forceRTL and allowRTL flip dir live", async () => {
  const { doc } = makeDom();
  const root = doc.documentElement;
  try {
    await withGlobals({ document: doc, navigator: { language: "ar-EG" } }, () => {
      assertEquals(I18nManager.isRTL, true, "an RTL locale");
      assertEquals(I18nManager.getConstants(), {
        isRTL: true,
        doLeftAndRightSwapInRTL: true,
        localeIdentifier: "ar-EG",
      });
      root.setAttribute("dir", "ltr");
      assertEquals(I18nManager.isRTL, false, "the page's own dir wins over the locale");
      I18nManager.allowRTL(false);
      assertEquals([I18nManager.isRTL, root.getAttribute("dir")], [false, "ltr"]);
      I18nManager.forceRTL(true);
      assertEquals([I18nManager.isRTL, root.getAttribute("dir")], [true, "rtl"]);
      I18nManager.forceRTL(false);
      I18nManager.allowRTL(true);
      assertEquals(root.getAttribute("dir"), "ltr", "back to the page's own dir");
      I18nManager.swapLeftAndRightInRTL(false);
      assertEquals(I18nManager.doLeftAndRightSwapInRTL, false);
    });
    resetI18nManagerForTesting();
    const { doc: doc2 } = makeDom();
    doc2.documentElement.setAttribute("lang", "he");
    await withGlobals({ document: doc2, navigator: { language: "en-US" } }, () => {
      assertEquals(I18nManager.isRTL, true, "the root's lang is the locale");
      assertEquals(I18nManager.getConstants().localeIdentifier, "he");
    });
  } finally {
    resetI18nManagerForTesting();
  }
});

// ---- Alert -------------------------------------------------------------------

/** The open dialog's card and buttons. */
function dialogOf(doc: Any) {
  const card = walk(doc.body).find((el) => el.getAttribute("role") === "alertdialog");
  const buttons = card ? walk(card).filter((el) => el.tagName === "BUTTON") : [];
  const inputs = card ? walk(card).filter((el) => el.tagName === "INPUT") : [];
  return { card, buttons, inputs };
}

Deno.test("Alert.alert (web): an accessible modal; press, Escape → cancel, outside tap when cancelable", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const pressed: string[] = [];
    Alert.alert("Delete thread?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel", onPress: () => void pressed.push("cancel") },
      { text: "Delete", style: "destructive", onPress: () => void pressed.push("delete") },
    ]);
    await settle();
    let { card, buttons } = dialogOf(doc);
    assert(card, "role=alertdialog");
    assertEquals(card.getAttribute("aria-modal"), "true");
    assert(card.getAttribute("aria-labelledby") && card.getAttribute("aria-describedby"));
    assertEquals(buttons.map((b) => [b.textContent, b.getAttribute("data-style")]), [
      ["Cancel", "cancel"],
      ["Delete", "destructive"],
    ]);
    buttons[1].dispatch("click");
    await settle();
    assertEquals(pressed, ["delete"]);
    assertEquals(dialogOf(doc).card, undefined, "removed on close");

    Alert.alert("Leave?", null, [
      { text: "Stay", style: "cancel", onPress: () => void pressed.push("stay") },
      { text: "Leave" },
    ]);
    await settle();
    ({ card } = dialogOf(doc));
    card!.dispatch("keydown", { key: "Escape" });
    await settle();
    assertEquals(pressed.at(-1), "stay", "Escape presses the cancel button");

    let dismissed = 0;
    Alert.alert("Note", "x", undefined, { cancelable: true, onDismiss: () => void dismissed++ });
    await settle();
    ({ buttons } = dialogOf(doc));
    assertEquals(buttons.map((b) => b.textContent), ["OK"], "RN's default button");
    const backdrop = dialogOf(doc).card!.parentNode as Any;
    backdrop.dispatch("click", { target: backdrop });
    await settle();
    assertEquals(dismissed, 1);
  });
});

Deno.test("Alert (native @capacitor/dialog): alert / confirm / prompt when they fit; else in-page", async () => {
  const dialog = fakePlugin(["alert", "confirm", "prompt"], {
    confirm: { value: true },
    prompt: { value: "Ada", cancelled: false },
  });
  const { doc } = makeDom();
  await inShell("ios", { Dialog: dialog.plugin }, async () => {
    const pressed: unknown[] = [];
    Alert.alert("Saved");
    await settle();
    Alert.alert("Delete?", "Sure?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void pressed.push("delete") },
    ]);
    await settle();
    Alert.prompt("Name", "Who?", (text) => void pressed.push(text), "plain-text", "A");
    await settle();
    assertEquals(dialog.calls, [
      ["alert", { title: "Saved", message: "", buttonTitle: "OK" }],
      ["confirm", {
        title: "Delete?",
        message: "Sure?",
        okButtonTitle: "Delete",
        cancelButtonTitle: "Cancel",
      }],
      ["prompt", {
        title: "Name",
        message: "Who?",
        okButtonTitle: "OK",
        cancelButtonTitle: "Cancel",
        inputText: "A",
      }],
    ]);
    assertEquals(pressed, ["delete", "Ada"]);

    // Three buttons, or a secure prompt: the plugin cannot, so the in-page modal.
    Alert.prompt("Password", undefined, (text) => void pressed.push(text), "secure-text");
    await settle();
    const { inputs, buttons } = dialogOf(doc);
    assertEquals(inputs.map((i) => i.getAttribute("type")), ["password"]);
    inputs[0].value = "hunter2";
    buttons[1].dispatch("click");
    await settle();
    assertEquals(pressed.at(-1), "hunter2");
    assertEquals(dialog.calls.length, 3, "the plugin was not used");
  }, { document: doc });
});

Deno.test("Alert.prompt login-password: onPress receives { login, password }", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    let got: unknown;
    Alert.prompt(
      "Sign in",
      null,
      [{ text: "Cancel", style: "cancel" }, {
        text: "Go",
        onPress: (v) => void (got = v),
      }],
      "login-password",
      "ada",
      "email-address",
    );
    await settle();
    const { inputs, buttons } = dialogOf(doc);
    assertEquals(inputs.map((i) => i.getAttribute("type")), ["text", "password"]);
    assertEquals(inputs[0].getAttribute("inputmode"), "email");
    assertEquals(inputs[0].value, "ada");
    inputs[1].value = "pw";
    buttons[1].dispatch("click");
    await settle();
    assertEquals(got, { login: "ada", password: "pw" });
  });
});

// ---- Platform ----------------------------------------------------------------

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0";

Deno.test("Platform: OS stays web in the shell; Version and isPad from the device", async () => {
  assertEquals(Platform.OS, "web");
  assertEquals(Platform.select({ web: 1, ios: 2, default: 3 }), 1);
  assertEquals(Platform.select({ ios: 2, native: 4, default: 3 }), 3, "web, else default");
  assertEquals(Platform.Version, "0.0.0");
  await inShell("ios", {}, () => {
    assertEquals(Platform.OS, "web", "web inside the iOS shell too");
    assertEquals(Platform.select({ ios: 2, default: 3 }), 3);
    assertEquals(Platform.Version, "17.4");
    assertEquals(Platform.isPad, false);
  }, { navigator: { userAgent: IPHONE_UA } });
  await inShell("android", {}, () => {
    assertEquals(Platform.OS, "web");
    assertEquals(Platform.Version, 34, "Android 14 → API 34");
  }, { navigator: { userAgent: ANDROID_UA } });
  await withGlobals({
    navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 },
  }, () => {
    assertEquals(Platform.isPad, true, "iPadOS Safari reports a Mac with touch");
    assertEquals(Platform.Version, "0.0.0", "not the shell: react-native-web's value");
  });
  assertEquals(Platform.isTV, false);
});

// ---- Linking -----------------------------------------------------------------

Deno.test("Linking.openURL: openExternal for http(s)/mailto/tel, a window for other schemes, refusals", async () => {
  const opened: unknown[][] = [];
  await withGlobals({
    open: (...a: unknown[]) => void opened.push(a),
    location: { href: "https://app.test/home" },
  }, async () => {
    await Linking.openURL("https://denext.dev/docs");
    await Linking.openURL("/relative");
    await Linking.openURL("sms:+15551234");
    await Linking.openURL("https://x.test", "_self");
    await assertRejects(() => Linking.openURL("javascript:alert(1)"), TypeError, "javascript:");
    await assertRejects(() => Linking.openURL(""), TypeError);
    assertEquals(await Linking.canOpenURL("mailto:a@b.c"), true);
    assertEquals(await Linking.canOpenURL("data:text/html,x"), false);
    assertEquals(await Linking.getInitialURL(), "https://app.test/home", "a browser: the page");
    await assertRejects(() => Linking.openSettings());
  });
  assertEquals(opened, [
    ["https://denext.dev/docs", "_blank", "noopener,noreferrer"],
    ["https://app.test/relative", "_blank", "noopener,noreferrer"],
    ["sms:+15551234", "_blank", "noopener"],
    ["https://x.test/", "_self", "noopener"],
  ]);
});

Deno.test("Linking (shell): the in-app browser, the launch URL, and url events", async () => {
  const browser = fakePlugin(["open"]);
  const app = fakePlugin(["getLaunchUrl"], { getLaunchUrl: { url: "myapp://launch" } });
  try {
    await inShell("ios", { Browser: browser.plugin, App: app.plugin }, async () => {
      await Linking.openURL("https://denext.dev");
      assertEquals(browser.calls, [["open", { url: "https://denext.dev/" }]]);
      assertEquals(await Linking.getInitialURL(), "myapp://launch");
      const urls: string[] = [];
      const sub = Linking.addEventListener("url", ({ url }) => void urls.push(url));
      await wait(5);
      app.fire("appUrlOpen", { url: "myapp://threads/42" });
      await settle();
      assertEquals(
        urls,
        ["myapp://threads/42"],
        "later links only (the launch link is getInitialURL's)",
      );
      sub.remove();
      app.fire("appUrlOpen", { url: "myapp://threads/43" });
      assertEquals(urls.length, 1);
    }, { location: { href: "capacitor://localhost/" } });
  } finally {
    resetDeepLinksForTesting();
  }
});

// ---- AppState ----------------------------------------------------------------

Deno.test("AppState: visibility in a browser; @capacitor/app's inactive / background / active in iOS", async () => {
  const doc = Object.assign(new Target(), { visibilityState: "visible" });
  try {
    await withGlobals({ document: doc }, () => {
      const seen: string[] = [];
      const sub = AppState.addEventListener("change", (s) => void seen.push(s));
      assertEquals(AppState.currentState, "active");
      doc.visibilityState = "hidden";
      doc.fire("visibilitychange");
      assertEquals([AppState.currentState, seen], ["background", ["background"]]);
      sub.remove();
      assertEquals(doc.count(), 0, "the source stops with the last listener");
    });
    resetAppStateForTesting();
    const app = fakePlugin([]);
    doc.visibilityState = "visible";
    await inShell("ios", { App: app.plugin }, async () => {
      const seen: string[] = [];
      AppState.addEventListener("change", (s) => void seen.push(s));
      await settle();
      app.fire("appStateChange", { isActive: false });
      app.fire("pause");
      app.fire("resume");
      app.fire("appStateChange", { isActive: true });
      assertEquals(seen, ["inactive", "background", "active"]);
      const sub = AppState.addEventListener("memoryWarning", () => {});
      assertEquals(typeof sub.remove, "function", "always a subscription");
    }, { document: doc });
  } finally {
    resetAppStateForTesting();
  }
});

// ---- Vibration / Share / Clipboard ------------------------------------------

Deno.test("Vibration: @capacitor/haptics in the shell (RN's wait/vibrate pattern); navigator.vibrate on the web", async () => {
  const haptics = fakePlugin(["vibrate"]);
  await inShell("android", { Haptics: haptics.plugin }, async () => {
    Vibration.vibrate();
    assertEquals(haptics.calls, [["vibrate", { duration: 400 }]]);
    Vibration.vibrate([0, 30, 20, 40]);
    await wait(80);
    assertEquals(haptics.calls.slice(1), [["vibrate", { duration: 30 }], ["vibrate", {
      duration: 40,
    }]]);
    Vibration.vibrate([10, 20], true);
    await wait(70);
    Vibration.cancel();
    const n = haptics.calls.length;
    assert(n >= 4, "repeats until cancelled");
    await wait(60);
    assertEquals(haptics.calls.length, n, "cancel stops the loop");
  });
  const patterns: unknown[] = [];
  await withGlobals({ navigator: { vibrate: (p: unknown) => (patterns.push(p), true) } }, () => {
    Vibration.vibrate(100);
    Vibration.vibrate([50, 100]);
    Vibration.cancel();
  });
  assertEquals(patterns, [[0, 0, 100], [0, 50, 100], 0], "web patterns start with a vibration");
});

Deno.test("Share.share: RN's result shape over denext/mobile's share; validation", async () => {
  const sharePlugin = fakePlugin(["share"]);
  await inShell("ios", { Share: sharePlugin.plugin }, async () => {
    assertEquals(await Share.share({ title: "T", message: "M", url: "https://x.test" }), {
      action: "sharedAction",
      activityType: null,
    });
    assertEquals(sharePlugin.calls, [["share", { title: "T", text: "M", url: "https://x.test" }]]);
  });
  const cancelled = fakePlugin(["share"], { share: new Error("Share canceled") });
  await inShell("android", { Share: cancelled.plugin }, async () => {
    assertEquals(await Share.share({ message: "M" }), { action: "dismissedAction" });
  });
  await assertRejects(() => Share.share({ title: "only a title" }), TypeError, "URL and message");
  assertEquals([Share.sharedAction, Share.dismissedAction], ["sharedAction", "dismissedAction"]);
});

Deno.test("Clipboard: @capacitor/clipboard in the shell; getString never rejects", async () => {
  const clip = fakePlugin(["read", "write"], { read: { value: "hi" } });
  await inShell("ios", { Clipboard: clip.plugin }, async () => {
    assertEquals(await Clipboard.getString(), "hi");
    Clipboard.setString("copied");
    await settle();
    assertEquals(clip.calls.at(-1), ["write", { string: "copied" }]);
    assertEquals(Clipboard.isAvailable(), true);
  });
  assertEquals(await Clipboard.getString(), "", "no clipboard at all: empty, as in RN-web");
});

Deno.test("Alert (web): Tab wraps focus inside the dialog; Enter in the field presses OK", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    let got: unknown;
    Alert.prompt("Rename", null, (text) => void (got = text));
    await settle();
    const { card, inputs, buttons } = dialogOf(doc);
    const focused: string[] = [];
    for (const el of [...inputs, ...buttons]) {
      (el as Any).focus = () => void focused.push(el.tagName + ":" + el.textContent);
    }
    card!.dispatch("keydown", { key: "Tab", target: buttons[1] });
    card!.dispatch("keydown", { key: "Tab", target: inputs[0], shiftKey: true });
    assertEquals(focused, ["INPUT:", "BUTTON:OK"], "last → first, first → last");
    card!.dispatch("keydown", { key: "Escape" });
    await settle();
    assertEquals(got, undefined, "Escape pressed Cancel");
    Alert.prompt("Rename", null, (text) => void (got = text), "plain-text", "draft");
    await settle();
    const second = dialogOf(doc);
    second.card!.dispatch("keydown", { key: "Enter", target: second.inputs[0] });
    await settle();
    assertEquals(got, "draft");
  });
});
