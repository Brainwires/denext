// The Expo SDK shims that run on web APIs (and, where noted, an existing denext/mobile
// capability): expo-system-ui, expo-linear-gradient, expo-mesh-gradient, expo-checkbox,
// expo-localization, expo-battery, expo-cellular, expo-video-thumbnails, expo-mail-composer,
// expo-sms, expo-speech, expo-sensors and expo-gl. Each runs in a faked Capacitor shell and on the web.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { flushSync } from "../src/client/reconciler.ts";
import * as SystemUI from "../src/expo/system-ui.ts";
import { LinearGradient } from "../src/expo/linear-gradient.ts";
import { MeshGradientView } from "../src/expo/mesh-gradient.ts";
import Checkbox from "../src/expo/checkbox.ts";
import * as Localization from "../src/expo/localization.ts";
import * as Battery from "../src/expo/battery.ts";
import * as Cellular from "../src/expo/cellular.ts";
import * as VideoThumbnails from "../src/expo/video-thumbnails.ts";
import * as MailComposer from "../src/expo/mail-composer.ts";
import * as SMS from "../src/expo/sms.ts";
import * as Speech from "../src/expo/speech.ts";
import * as Sensors from "../src/expo/sensors.ts";
import { getWorkletContext, GLView, type GLViewHandle } from "../src/expo/gl.ts";
import { gradientImageOf } from "../src/react-native-compat/masked-view.ts";
import { FakeElement } from "./helpers/dom.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  Target,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

// ---- expo-system-ui ------------------------------------------------------------------------

Deno.test("expo-system-ui: paints <html> and <body>, reads back what was set", async () => {
  assertEquals(await SystemUI.getBackgroundColorAsync(), null);
  const html = { style: {} as Any };
  const body = { style: {} as Any };
  await withGlobals({ document: { documentElement: html, body } }, async () => {
    await SystemUI.setBackgroundColorAsync("#abc");
    assertEquals([html.style.backgroundColor, body.style.backgroundColor], ["#AABBCC", "#AABBCC"]);
    assertEquals(await SystemUI.getBackgroundColorAsync(), "#AABBCC");
    await SystemUI.setBackgroundColorAsync(0x80ff0000); // processColor: translucent red
    assertEquals(await SystemUI.getBackgroundColorAsync(), "#FF000080");
    await SystemUI.setBackgroundColorAsync("rebeccapurple");
    assertEquals(body.style.backgroundColor, "rebeccapurple");
    await SystemUI.setBackgroundColorAsync(null);
    assertEquals([body.style.backgroundColor, await SystemUI.getBackgroundColorAsync()], [
      "",
      null,
    ]);
  });
});

// ---- expo-linear-gradient / expo-mesh-gradient --------------------------------------------

Deno.test("expo-linear-gradient: the CSS gradient view; null points fall back; a mask reads it", () => {
  const view = LinearGradient({
    colors: ["red", "blue"],
    locations: [0, 0.5, 1],
    start: null,
    end: [1, 1],
    dither: true,
    testID: "g",
    children: "hi",
  });
  const props = view.props as Any;
  assertEquals(props.colors, ["red", "blue"]);
  assertEquals(props.locations, [0, 0.5], "extra locations are dropped, as Expo");
  assertEquals([props.start, props.end, props.dither, props.testID], [
    undefined,
    [1, 1],
    undefined,
    "g",
  ]);
  assertEquals(props.children, "hi");
  // Rendered, it is a view with a linear-gradient background.
  const { container } = mount(() => h(LinearGradient, { colors: ["red", "blue"] }));
  const html = container.childNodes[0].outerHTML as string;
  assert(/linear-gradient\(/.test(html), html);
  // MaskedView recognises Expo's gradient element by its colors.
  const css = gradientImageOf(h(LinearGradient, { colors: ["#000", "transparent"] }));
  assert(css?.startsWith("linear-gradient("), String(css));
});

Deno.test("expo-mesh-gradient: a radial layer per point over the average colour", () => {
  const view = MeshGradientView({
    columns: 2,
    rows: 2,
    points: [[0, 0], [1, 0], [0, 1], [1, 1]],
    colors: ["red", "purple", "indigo", "blue"],
    style: { flex: 1 },
  });
  const style = (view.props as Any).style;
  assertEquals(style.backgroundImage.match(/radial-gradient\(/g)?.length, 4);
  assert(style.backgroundImage.includes("at 100% 100%, blue 0%"), style.backgroundImage);
  assert(style.backgroundColor.startsWith("color-mix("), style.backgroundColor);
  assertEquals(style.flex, 1);
  const empty = MeshGradientView({ columns: 0, rows: 0 });
  assertEquals((empty.props as Any).style.backgroundImage, undefined);
});

// ---- expo-checkbox -------------------------------------------------------------------------

Deno.test("expo-checkbox: a real checkbox input reporting onChange and onValueChange", () => {
  const seen: Any[] = [];
  const box = Checkbox({
    value: false,
    color: "#4630EB",
    onValueChange: (v: boolean) => seen.push(["value", v]),
    onChange: (e: Any) => seen.push(["change", e.nativeEvent.value]),
    style: { width: 24, height: 24 },
  });
  assertEquals(box.type, "div");
  const [input, drawn] = (box.props as Any).children;
  assertEquals([input.type, input.props.type, input.props.checked], ["input", "checkbox", false]);
  input.props.onChange({ target: { checked: true } });
  assertEquals(seen, [["change", true], ["value", true]]);
  assertEquals((box.props as Any).style.width, 24);
  assertEquals(drawn.props.style.border, "2px solid #4630EB");
  const checked = Checkbox({ value: true, disabled: true });
  const [, drawnChecked] = (checked.props as Any).children;
  assertEquals(drawnChecked.props.style.backgroundColor, "#AAB8C2");
  assert(String(drawnChecked.props.style.backgroundImage).startsWith('url("data:image/svg+xml'));
});

// ---- expo-localization ---------------------------------------------------------------------

Deno.test("expo-localization: locales and calendars from Intl and navigator.languages", async () => {
  await withGlobals({ navigator: { languages: ["pl-PL", "en-US", "ar-EG", "fr"] } }, () => {
    const [pl, us, ar, fr] = Localization.getLocales();
    assertEquals(pl.languageTag, "pl-PL");
    assertEquals([pl.languageCode, pl.regionCode, pl.languageRegionCode], ["pl", "PL", "PL"]);
    assertEquals([pl.decimalSeparator, pl.measurementSystem, pl.temperatureUnit], [
      ",",
      "metric",
      "celsius",
    ]);
    assertEquals([us.measurementSystem, us.temperatureUnit, us.decimalSeparator], [
      "us",
      "fahrenheit",
      ".",
    ]);
    assertEquals(us.digitGroupingSeparator, ",");
    assertEquals([pl.currencyCode, us.currencySymbol], [null, null]);
    assertEquals([ar.textDirection, us.textDirection], ["rtl", "ltr"]);
    assertEquals([fr.regionCode, fr.measurementSystem, fr.temperatureUnit], [null, null, null]);
  });
  const [calendar] = Localization.getCalendars();
  assertEquals(calendar.calendar, Localization.CalendarIdentifier.GREGORY);
  assert(typeof calendar.timeZone === "string" && calendar.timeZone.length > 0);
  assert(calendar.uses24hourClock === null || typeof calendar.uses24hourClock === "boolean");
  assert(
    calendar.firstWeekday === null || (calendar.firstWeekday >= 1 && calendar.firstWeekday <= 7),
  );
  assertEquals(Localization.Weekday.SUNDAY, 1);
  // The hook re-renders on languagechange.
  const page = new Target();
  const nav = { languages: ["de-DE"] };
  await withGlobals({
    navigator: nav,
    addEventListener: page.addEventListener.bind(page),
    removeEventListener: page.removeEventListener.bind(page),
  }, async () => {
    let tag = "";
    const { root } = mount(() => {
      tag = Localization.useLocales()[0].languageTag;
      return null;
    });
    await settle();
    flushSync();
    assertEquals(tag, "de-DE");
    nav.languages = ["en-GB"];
    page.fire("languagechange");
    flushSync();
    assertEquals(tag, "en-GB");
    root.unmount();
    assertEquals(page.count(), 0, "the listener is removed on unmount");
  });
});

// ---- expo-battery --------------------------------------------------------------------------

Deno.test("expo-battery: @capacitor/device in the shell, the Battery Status API on the web", async () => {
  // Nothing to read: Expo's web answers.
  assertEquals(await Battery.isAvailableAsync(), false);
  assertEquals(await Battery.getBatteryLevelAsync(), -1);
  assertEquals(await Battery.getBatteryStateAsync(), Battery.BatteryState.UNKNOWN);
  assertEquals(await Battery.isLowPowerModeEnabledAsync(), false);
  assertEquals(await Battery.isBatteryOptimizationEnabledAsync(), false);

  const device = fakePlugin(["getBatteryInfo"], {
    getBatteryInfo: { batteryLevel: 0.42, isCharging: true },
  });
  await inShell("ios", { Device: device.plugin }, async () => {
    assertEquals(await Battery.isAvailableAsync(), true);
    assertEquals(await Battery.getBatteryLevelAsync(), 0.42);
    assertEquals(await Battery.getBatteryStateAsync(), Battery.BatteryState.CHARGING);
    assertEquals(await Battery.getPowerStateAsync(), {
      batteryLevel: 0.42,
      batteryState: Battery.BatteryState.CHARGING,
      lowPowerMode: false,
    });
  });

  // The web: navigator.getBattery() and its change events.
  const manager = Object.assign(new Target(), { level: 0.5, charging: false });
  await withGlobals({ navigator: { getBattery: () => Promise.resolve(manager) } }, async () => {
    assertEquals(await Battery.isAvailableAsync(), true);
    assertEquals(await Battery.getBatteryStateAsync(), Battery.BatteryState.UNPLUGGED);
    const levels: number[] = [];
    const states: number[] = [];
    const a = Battery.addBatteryLevelListener((e) => levels.push(e.batteryLevel));
    const b = Battery.addBatteryStateListener((e) => states.push(e.batteryState));
    await settle();
    manager.level = 0.6;
    manager.fire("levelchange");
    manager.charging = true;
    manager.level = 1;
    manager.fire("chargingchange");
    assertEquals(levels, [0.6, 1]);
    assertEquals(states, [Battery.BatteryState.FULL]);
    a.remove();
    a.remove(); // twice is harmless
    b.remove();
    assertEquals(manager.count(), 0, "the last listener stops the watch");
  });
});

// ---- expo-cellular -------------------------------------------------------------------------

Deno.test("expo-cellular: the generation from the Network Information API, carrier facts null", async () => {
  assertEquals(await Cellular.getCellularGenerationAsync(), Cellular.CellularGeneration.UNKNOWN);
  await withGlobals(
    { navigator: { connection: { type: "cellular", effectiveType: "3g" } } },
    async () => {
      assertEquals(
        await Cellular.getCellularGenerationAsync(),
        Cellular.CellularGeneration.CELLULAR_3G,
      );
    },
  );
  await withGlobals(
    { navigator: { connection: { type: "wifi", effectiveType: "4g" } } },
    async () => {
      assertEquals(
        await Cellular.getCellularGenerationAsync(),
        Cellular.CellularGeneration.UNKNOWN,
      );
    },
  );
  assertEquals(await Cellular.getCarrierNameAsync(), null);
  assertEquals(await Cellular.getIsoCountryCodeAsync(), null);
  assertEquals((await Cellular.requestPermissionsAsync()).granted, true);
});

// ---- expo-video-thumbnails -----------------------------------------------------------------

Deno.test("expo-video-thumbnails: seeks a <video>, draws it on a <canvas>, returns a JPEG blob URL", async () => {
  await assertRejects(() => VideoThumbnails.getThumbnailAsync("v.mp4"), Error, "needs a page");
  const drawn: Any[] = [];
  const video = Object.assign(new Target(), {
    duration: 10,
    currentTime: 0,
    videoWidth: 640,
    videoHeight: 360,
    error: null,
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    removeAttribute(k: string) {
      delete this.attrs[k];
    },
    load() {},
  }) as Any;
  Object.defineProperty(video, "src", {
    get: () => video.attrs.src,
    set: (url: string) => {
      video.attrs.src = url;
      queueMicrotask(() => video.fire("loadeddata"));
    },
  });
  Object.defineProperty(video, "currentTime", {
    get: () => video._t ?? 0,
    set: (t: number) => {
      video._t = t;
      queueMicrotask(() => video.fire("seeked"));
    },
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (...args: Any[]) => drawn.push(args) }),
    toBlob: (cb: (b: Blob) => void, type: string, quality: number) => {
      drawn.push([type, quality]);
      cb(new Blob(["jpeg"], { type }));
    },
  };
  const document = {
    createElement: (tag: string) => tag === "video" ? video : canvas,
  };
  await withGlobals({ document }, async () => {
    const result = await VideoThumbnails.getThumbnailAsync("https://x/v.mp4", {
      time: 15000,
      quality: 0.5,
    });
    assert(result.uri.startsWith("blob:"), result.uri);
    assertEquals([result.width, result.height], [640, 360]);
    assertEquals(video._t, 10, "the time is clamped to the duration");
    assertEquals([canvas.width, canvas.height], [640, 360]);
    assertEquals(drawn[1], ["image/jpeg", 0.5]);
    assertEquals(video.crossOrigin, "anonymous");
    URL.revokeObjectURL(result.uri);
  });
});

// ---- expo-mail-composer / expo-sms ---------------------------------------------------------

Deno.test("expo-mail-composer: a mailto: URL through openExternal; attachments refused", async () => {
  const opened: string[] = [];
  await withGlobals({ open: (url: string) => void opened.push(url) }, async () => {
    assertEquals(await MailComposer.isAvailableAsync(), true);
    const result = await MailComposer.composeAsync({
      recipients: ["a@x.com", "b@x.com"],
      ccRecipients: ["c@x.com"],
      subject: "Hi there",
      body: "<p>One &amp; two</p><br>three",
      isHtml: true,
    });
    assertEquals(result.status, MailComposer.MailComposerStatus.UNDETERMINED);
    assertEquals(
      opened[0],
      "mailto:a@x.com,b@x.com?cc=c@x.com&subject=Hi%20there&body=One%20%26%20two%0A%0Athree",
    );
    await assertRejects(
      () => MailComposer.composeAsync({ attachments: ["file:///x.pdf"] }),
      Error,
      "cannot carry attachments",
    );
  });
  assertEquals(MailComposer.getClients(), []);
});

Deno.test("expo-sms: the Messages app through an sms: URL in the shell; unavailable on the web", async () => {
  assertEquals(await SMS.isAvailableAsync(), false);
  await assertRejects(() => SMS.sendSMSAsync("1", "x"), Error, "not available here");
  const opened: string[] = [];
  const open = (url: string) => void opened.push(url);
  await inShell("ios", {}, async () => {
    assertEquals(await SMS.isAvailableAsync(), true);
    assertEquals(await SMS.sendSMSAsync(["+15551234", "5556789"], "On my way"), {
      result: "unknown",
    });
    await assertRejects(
      () =>
        SMS.sendSMSAsync("1", "x", { attachments: [{ uri: "u", mimeType: "m", filename: "f" }] }),
      Error,
      "cannot carry attachments",
    );
  }, { open });
  await inShell("android", {}, () => SMS.sendSMSAsync("5551234", "a b"), { open });
  assertEquals(opened, ["sms:+15551234,5556789&body=On%20my%20way", "sms:5551234?body=a%20b"]);
});

// ---- expo-speech ---------------------------------------------------------------------------

Deno.test("expo-speech: the TextToSpeech plugin in the shell, queued, with stop and voices", async () => {
  const done: Array<() => void> = [];
  const tts = fakePlugin(["stop", "getSupportedVoices"], {
    getSupportedVoices: {
      voices: [
        { voiceURI: "com.apple.a", name: "A", lang: "en-US", default: true, localService: true },
        { voiceURI: "com.apple.b", name: "B", lang: "fr-FR", default: false, localService: true },
      ],
    },
  });
  tts.plugin.speak = (arg?: unknown) => {
    tts.calls.push(["speak", arg]);
    return new Promise<void>((resolve) => done.push(resolve)) as Any;
  };
  await inShell("android", { TextToSpeech: tts.plugin }, async () => {
    const events: string[] = [];
    Speech.speak("one", {
      voice: "com.apple.b",
      rate: 1.2,
      onStart: () => void events.push("start 1"),
      onDone: () => void events.push("done 1"),
    });
    Speech.speak("two", {
      onStart: () => void events.push("start 2"),
      onStopped: () => void events.push("stopped 2"),
    });
    await settle();
    assertEquals(await Speech.isSpeakingAsync(), true);
    assertEquals(tts.calls.filter(([m]) => m === "speak").map(([, a]) => a), [
      {
        text: "one",
        lang: undefined,
        rate: 1.2,
        pitch: undefined,
        volume: undefined,
        voice: 1,
        queueStrategy: 1,
      },
    ]);
    done[0]();
    await settle();
    assertEquals(events, ["start 1", "done 1", "start 2"]);
    await Speech.stop();
    assertEquals(events.at(-1), "stopped 2");
    assertEquals(await Speech.isSpeakingAsync(), false);
    await assertRejects(() => Speech.pause(), Error, "cannot pause");
    const voices = await Speech.getAvailableVoicesAsync();
    assertEquals(voices[1].identifier, "com.apple.b");
    assertEquals(voices[1].quality, Speech.VoiceQuality.Default);
  });
  assertThrows(() => Speech.speak("x".repeat(Speech.maxSpeechInputLength + 1)), Error, "too long");
});

Deno.test("expo-speech: the Web Speech API elsewhere; no engine reports an error", async () => {
  const spoken: Any[] = [];
  const speechSynthesis = {
    speaking: false,
    getVoices: () => [],
    speak: (u: Any) => spoken.push(u),
    cancel: () => spoken.push("cancel"),
    pause: () => spoken.push("pause"),
    resume: () => spoken.push("resume"),
  };
  class SpeechSynthesisUtterance {
    constructor(public text: string) {}
  }
  await withGlobals({ speechSynthesis, SpeechSynthesisUtterance }, async () => {
    const events: string[] = [];
    Speech.speak("hello", {
      language: "en-GB",
      pitch: 0.8,
      onDone: () => void events.push("done"),
      onStopped: () => void events.push("stopped"),
    });
    await settle();
    const u = spoken[0];
    assertEquals([u.text, u.lang, u.pitch], ["hello", "en-GB", 0.8]);
    u.onend();
    u.onerror({ error: "interrupted" });
    assertEquals(events, ["done", "stopped"]);
    await Speech.pause();
    await Speech.resume();
    await Speech.stop();
    assertEquals(spoken.slice(1), ["pause", "resume", "cancel"]);
  });
  const errors: string[] = [];
  Speech.speak("x", { onError: (e) => void errors.push((e as Any).code) });
  await settle();
  assertEquals(errors, ["ERR_UNAVAILABLE"]);
});

// ---- expo-sensors --------------------------------------------------------------------------

Deno.test("expo-sensors: motion events in Expo's units, throttled, with iOS permission", async () => {
  const page = new Target();
  let asked = 0;
  const DeviceMotionEvent = {
    requestPermission: () => {
      asked++;
      return Promise.resolve("granted");
    },
  };
  await withGlobals({
    addEventListener: page.addEventListener.bind(page),
    removeEventListener: page.removeEventListener.bind(page),
    DeviceMotionEvent,
    DeviceOrientationEvent: {},
    orientation: 90,
  }, async () => {
    const { Accelerometer, Gyroscope, DeviceMotion } = Sensors;
    assertEquals((await Accelerometer.getPermissionsAsync()).status, "undetermined");
    assertEquals(await Accelerometer.isAvailableAsync(), true, "behind the permission");
    assertEquals((await Accelerometer.requestPermissionsAsync()).granted, true);
    assertEquals(asked, 1);
    assertEquals((await Gyroscope.getPermissionsAsync()).status, "granted");

    const acc: Any[] = [];
    const gyro: Any[] = [];
    const motion: Any[] = [];
    Accelerometer.setUpdateInterval(0);
    Gyroscope.setUpdateInterval(0);
    DeviceMotion.setUpdateInterval(0);
    const a = Accelerometer.addListener((m) => acc.push(m));
    const g = Gyroscope.addListener((m) => gyro.push(m));
    const d = DeviceMotion.addListener((m) => motion.push(m));
    assertEquals(Accelerometer.getListenerCount(), 1);
    page.fire("deviceorientation", { alpha: 180, beta: 90, gamma: 0, timeStamp: 1000 });
    page.fire("devicemotion", {
      accelerationIncludingGravity: { x: 0, y: 0, z: 9.80665 },
      acceleration: { x: 1, y: 2, z: 3 },
      rotationRate: { alpha: 180, beta: 90, gamma: 0 },
      interval: 16,
      timeStamp: 2000,
    });
    assertEquals(acc, [{ x: -0, y: -0, z: -1, timestamp: 2 }]);
    assertEquals(gyro[0].x, Math.PI / 2);
    assertEquals(gyro[0].z, Math.PI);
    assertEquals(motion[0].rotation.alpha, Math.PI);
    assertEquals(motion[0].acceleration, { x: 1, y: 2, z: 3, timestamp: 2 });
    assertEquals(motion[0].orientation, Sensors.DeviceMotionOrientation.RightLandscape);
    assertEquals(motion[0].interval, 16);
    assertEquals(DeviceMotion.Gravity, 9.80665);
    // Throttled to the interval.
    Accelerometer.setUpdateInterval(60_000);
    page.fire("devicemotion", { accelerationIncludingGravity: { x: 1, y: 1, z: 1 }, timeStamp: 3 });
    page.fire("devicemotion", { accelerationIncludingGravity: { x: 1, y: 1, z: 1 }, timeStamp: 4 });
    assertEquals(acc.length, 1, "inside the interval: dropped");
    a.remove();
    g.remove();
    Accelerometer.removeAllListeners();
    d.remove();
    assertEquals(page.count(), 0, "the last listener stops the events");
  });
  // No web API: unavailable.
  assertEquals(await Sensors.Barometer.isAvailableAsync(), false);
  assertEquals(await Sensors.Magnetometer.isAvailableAsync(), false);
  assertEquals(await Sensors.Pedometer.isAvailableAsync(), false);
  await assertRejects(
    () => Sensors.Pedometer.getStepCountAsync(new Date(0), new Date()),
    Error,
    "not available",
  );
  assertEquals(await Sensors.Accelerometer.isAvailableAsync(), false, "no DeviceMotionEvent");
});

// ---- expo-gl -------------------------------------------------------------------------------

/** A fake WebGL 2 context recording calls. */
function fakeGl(canvas: Any) {
  const calls: Any[] = [];
  return {
    calls,
    canvas,
    flush: () => calls.push("flush"),
    clear: (bits: number) => calls.push(["clear", bits]),
    texImage2D: (...args: Any[]) => calls.push(["texImage2D", ...args]),
    texSubImage2D: (...args: Any[]) => calls.push(["texSubImage2D", ...args]),
    getExtension: (name: string) =>
      name === "WEBGL_lose_context" ? { loseContext: () => calls.push("lost") } : null,
  };
}

Deno.test("expo-gl: GLView hands onContextCreate a WebGL 2 context with Expo's additions", async () => {
  const created: Any[] = [];
  let handle: GLViewHandle | null = null;
  const asked: Any[] = [];
  const ctx = fakeGl(null);
  // The fake DOM has no WebGL: give its elements getContext / toBlob for this test.
  const proto = FakeElement.prototype as Any;
  proto.getContext = function (kind: string, attrs: Any) {
    asked.push([kind, attrs]);
    ctx.canvas = this;
    return kind === "webgl2" ? ctx : null;
  };
  proto.toBlob = (cb: (b: Blob) => void, type: string) => cb(new Blob(["x"], { type }));
  try {
    const { container, root } = mount(() =>
      h(GLView, {
        style: { width: 200, height: 100 },
        msaaSamples: 0,
        ref: (r: GLViewHandle | null) => void (handle = r),
        onContextCreate: (gl: Any) => created.push(gl),
      })
    );
    await settle();
    flushSync();
    const canvas = container.childNodes[0].childNodes[0];
    assertEquals(canvas.tagName.toLowerCase(), "canvas");
    assertEquals(asked, [["webgl2", { antialias: false }]]);
    const gl = created.at(-1);
    assertEquals(gl, ctx);
    assertEquals(typeof gl.contextId, "number");
    gl.endFrameEXP();
    gl.flushEXP();
    // An expo-asset Asset is drawn from its URL.
    gl.texImage2D(0, 0, 0, 0, 0, { downloadAsync: () => {}, uri: "a.png" });
    assertEquals(ctx.calls[0], "flush");
    assertEquals(ctx.calls[1].length, 7);
    const snap = await handle!.takeSnapshotAsync({ format: "png" });
    assert(String(snap.uri).startsWith("blob:"));
    assertEquals(snap.localUri, snap.uri);
    URL.revokeObjectURL(String(snap.uri));
    await assertRejects(() => handle!.createCameraTextureAsync(null), Error, "not available");
    assertEquals(getWorkletContext(1), undefined);
    assertEquals(GLView.defaultProps.msaaSamples, 4);
    root.unmount();
    flushSync();
    assertEquals(ctx.calls.at(-1), "lost", "unmounting releases the context");
  } finally {
    delete proto.getContext;
    delete proto.toBlob;
  }
});
