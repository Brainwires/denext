// The Expo SDK shims over a pinned Capacitor plugin (`denext mobile add …`): expo-intent-launcher
// (@capgo/capacitor-intent-launcher), expo-brightness (@capacitor-community/screen-brightness)
// and expo-print (@capgo/capacitor-printer). Each runs in a faked Capacitor shell and on the web.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as IntentLauncher from "../src/expo/intent-launcher.ts";
import * as Brightness from "../src/expo/brightness.ts";
import * as Print from "../src/expo/print.ts";
import { type Any, fakePlugin, inShell, withGlobals } from "./helpers/mobile-fakes.ts";

// ---- expo-intent-launcher ------------------------------------------------------------------

Deno.test("expo-intent-launcher: Expo's parameters through the plugin, Android only", async () => {
  const launcher = fakePlugin(
    ["startActivityAsync", "openApplication", "getApplicationIconAsync"],
    {
      startActivityAsync: { resultCode: -1, data: "content://x" },
      getApplicationIconAsync: { icon: "data:image/png;base64,AAA" },
    },
  );
  await inShell("android", { IntentLauncher: launcher.plugin }, async () => {
    const result = await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.LOCATION_SOURCE_SETTINGS,
      { extra: { a: 1 }, flags: 268435456 },
    );
    assertEquals(result, { resultCode: IntentLauncher.ResultCode.Success, data: "content://x" });
    IntentLauncher.openApplication("com.google.android.gm");
    assertEquals(
      await IntentLauncher.getApplicationIconAsync("com.google.android.gm"),
      "data:image/png;base64,AAA",
    );
    assertEquals(launcher.calls, [
      ["startActivityAsync", {
        extra: { a: 1 },
        flags: 268435456,
        action: "android.settings.LOCATION_SOURCE_SETTINGS",
      }],
      ["openApplication", { packageName: "com.google.android.gm" }],
      ["getApplicationIconAsync", { packageName: "com.google.android.gm" }],
    ]);
    await assertRejects(() => IntentLauncher.startActivityAsync(""), TypeError, "non-empty");
  });
  // iOS and the web: unavailable, as in Expo.
  await inShell("ios", { IntentLauncher: launcher.plugin }, async () => {
    await assertRejects(
      () => IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.SETTINGS),
      Error,
      "not available here",
    );
    assertThrows(() => IntentLauncher.openApplication("x"), Error, "not available here");
  });
  await assertRejects(() => IntentLauncher.getApplicationIconAsync("x"), Error, "not available");
  assertEquals(Object.keys(IntentLauncher.ActivityAction).length, 219, "Expo's full action list");
});

// ---- expo-brightness -----------------------------------------------------------------------

Deno.test("expo-brightness: the screen's level on iOS, the window's on Android", async () => {
  let level = 0.3;
  const sets: number[] = [];
  const ios = {
    getBrightness: () => Promise.resolve({ brightness: level }),
    setBrightness: ({ brightness }: { brightness: number }) => {
      level = brightness;
      sets.push(brightness);
      return Promise.resolve();
    },
  };
  await inShell("ios", { ScreenBrightness: ios }, async () => {
    assertEquals(await Brightness.isAvailableAsync(), true);
    await Brightness.setBrightnessAsync(1.5); // clamped
    assertEquals(level, 1);
    assertEquals(await Brightness.getSystemBrightnessAsync(), 1, "iOS: the screen's, as Expo");
    await Brightness.setSystemBrightnessAsync(0.4); // iOS: the screen's, as Expo
    assertEquals(sets, [1, 0.4]);
    // Expo's Android-only calls resolve off Android: no-op, false, UNKNOWN, no-op.
    assertEquals(await Brightness.restoreSystemBrightnessAsync(), undefined);
    assertEquals(await Brightness.isUsingSystemBrightnessAsync(), false);
    assertEquals(
      await Brightness.getSystemBrightnessModeAsync(),
      Brightness.BrightnessMode.UNKNOWN,
    );
    assertEquals(
      await Brightness.setSystemBrightnessModeAsync(Brightness.BrightnessMode.AUTOMATIC),
      undefined,
    );
    assertEquals(sets, [1, 0.4], "none of them touched the screen");
    assertEquals((await Brightness.requestPermissionsAsync()).granted, true);
  });
  const android = fakePlugin(["setBrightness", "getBrightness"], {
    getBrightness: { brightness: -1 },
  });
  await inShell("android", { ScreenBrightness: android.plugin }, async () => {
    assertEquals(await Brightness.isUsingSystemBrightnessAsync(), true);
    await Brightness.setBrightnessAsync(0.8);
    await Brightness.restoreSystemBrightnessAsync();
    await assertRejects(() => Brightness.setSystemBrightnessAsync(0.5), Error, "WRITE_SETTINGS");
    await assertRejects(() => Brightness.getSystemBrightnessModeAsync(), Error, "not readable");
    // UNKNOWN is a no-op on Android too, as in Expo.
    await Brightness.setSystemBrightnessModeAsync(Brightness.BrightnessMode.UNKNOWN);
    assertEquals(android.calls.filter(([m]) => m === "setBrightness").map(([, a]) => a), [
      { brightness: 0.8 },
      { brightness: -1 },
    ]);
  });
  Brightness.addBrightnessListener(() => {}).remove();
});

Deno.test("expo-brightness: on the web, as Expo's web build (only the level calls reject)", async () => {
  assertEquals(await Brightness.isAvailableAsync(), false);
  await assertRejects(() => Brightness.getBrightnessAsync(), Error, "not available here");
  await assertRejects(() => Brightness.setBrightnessAsync(0.5), Error, "not available here");
  // Expo: getSystemBrightnessAsync is getBrightnessAsync off Android, which rejects here.
  const system = await assertRejects(() => Brightness.getSystemBrightnessAsync());
  assertEquals((system as { code?: string }).code, "ERR_UNAVAILABLE");
  // The Android-only calls never reject off Android (no unhandled rejections on iOS / the web).
  assertEquals(await Brightness.restoreSystemBrightnessAsync(), undefined);
  assertEquals(await Brightness.isUsingSystemBrightnessAsync(), false);
  assertEquals(await Brightness.getSystemBrightnessModeAsync(), Brightness.BrightnessMode.UNKNOWN);
  assertEquals(
    await Brightness.setSystemBrightnessModeAsync(Brightness.BrightnessMode.MANUAL),
    undefined,
  );
  // Expo's web permission: undetermined.
  const permission = await Brightness.getPermissionsAsync();
  assertEquals([permission.status, permission.granted], ["undetermined", false]);
  // A value that is not a number is Expo's TypeError, wherever it runs.
  await inShell(
    "ios",
    { ScreenBrightness: fakePlugin(["setBrightness", "getBrightness"]).plugin },
    async () => {
      await assertRejects(
        () => Brightness.setBrightnessAsync(Number.NaN),
        TypeError,
        "setBrightnessAsync cannot be called with NaN",
      );
    },
  );
});

// ---- expo-print ----------------------------------------------------------------------------

Deno.test("expo-print: the printer plugin in the shell; an iframe on the web", async () => {
  const printer = fakePlugin(["printHtml", "printBase64", "printFile"]);
  await inShell("ios", { Printer: printer.plugin }, async () => {
    await Print.printAsync({ html: "<h1>Hi</h1>" });
    await Print.printAsync({ uri: "data:application/pdf;base64,JVBERi0=" });
    await Print.printAsync({ uri: "file:///var/mobile/receipt.pdf" });
    await assertRejects(() => Print.printAsync({}), Error, "Must provide either");
    await assertRejects(
      () => Print.printAsync({ html: "a", uri: "b" }),
      Error,
      "exactly one of",
    );
    assertEquals(printer.calls, [
      ["printHtml", { html: "<h1>Hi</h1>" }],
      ["printBase64", { data: "JVBERi0=", mimeType: "application/pdf" }],
      ["printFile", { path: "/var/mobile/receipt.pdf" }],
    ]);
  });
  await inShell("android", {}, async () => {
    await assertRejects(() => Print.printAsync({ html: "x" }), Error, "denext mobile add print");
  });
  // The web: a hidden iframe prints the HTML; with nothing, the page itself.
  const printed: string[] = [];
  const appended: Any[] = [];
  const document = {
    createElement: () => {
      const frame: Any = {
        style: {},
        attributes: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          frame.attributes[name] = value;
        },
        remove() {},
        contentWindow: { focus() {}, print: () => printed.push(`frame:${frame.srcdoc}`) },
      };
      return frame;
    },
    body: {
      appendChild: (frame: Any) => {
        appended.push(frame);
        queueMicrotask(() => frame.onload());
      },
    },
  };
  await withGlobals({ document, print: () => printed.push("page") }, async () => {
    await Print.printAsync({ html: "<p>Receipt</p>" });
    await Print.printAsync({});
  });
  assertEquals(printed, ["frame:<p>Receipt</p>", "page"]);
  assert(appended[0].style.cssText.includes("width:0"));
  // The caller's HTML is sandboxed: it may print (modals; same origin so the page can call
  // print() on it) but never run script in the page's origin.
  assertEquals(appended[0].attributes.sandbox, "allow-modals allow-same-origin");
  assert(!appended[0].attributes.sandbox.includes("allow-scripts"));
  await assertRejects(() => Print.printToFileAsync({ html: "x" }), Error, "No PDF renderer");
  await assertRejects(() => Print.selectPrinterAsync(), Error, "not available");
  assertEquals(Print.Orientation, { portrait: "portrait", landscape: "landscape" });
});
