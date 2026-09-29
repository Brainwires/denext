// denext/mobile's screen reader state (isScreenReaderEnabled / onScreenReaderChange /
// useScreenReader over the DenextAccessibility plugin) and background location
// (watchPositionInBackground / stopBackgroundLocation over @capgo/background-geolocation), each
// in a faked Capacitor shell and on its web path.

import { assert, assertEquals } from "@std/assert";
import {
  isBackgroundLocationAvailable,
  isScreenReaderEnabled,
  onScreenReaderChange,
  stopBackgroundLocation,
  useScreenReader,
  watchPositionInBackground,
} from "../src/mobile/mod.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

Deno.test("isScreenReaderEnabled: the plugin's { value }, false without it or on failure", async () => {
  for (const [answer, expected] of [[{ value: true }, true], [{ value: false }, false]] as const) {
    const a11y = fakePlugin(["isScreenReaderEnabled"], { isScreenReaderEnabled: answer });
    await inShell("ios", { DenextAccessibility: a11y.plugin }, async () => {
      assertEquals(await isScreenReaderEnabled(), expected);
    });
  }
  const failing = fakePlugin(["isScreenReaderEnabled"], {
    isScreenReaderEnabled: new Error("boom"),
  });
  await inShell("android", { DenextAccessibility: failing.plugin }, async () => {
    assertEquals(await isScreenReaderEnabled(), false);
  });
  await inShell("ios", {}, async () => assertEquals(await isScreenReaderEnabled(), false));
  assertEquals(await isScreenReaderEnabled(), false, "the web has no screen reader API");
});

Deno.test("onScreenReaderChange: fires with the event's value until stopped", async () => {
  const a11y = fakePlugin(["isScreenReaderEnabled"]);
  await inShell("android", { DenextAccessibility: a11y.plugin }, async () => {
    const seen: boolean[] = [];
    const stop = onScreenReaderChange((on) => seen.push(on));
    await settle();
    a11y.fire("screenReaderChanged", { value: true });
    a11y.fire("screenReaderChanged", { value: false });
    a11y.fire("screenReaderChanged", {});
    stop();
    await settle();
    assertEquals(a11y.listening(), 0);
    a11y.fire("screenReaderChanged", { value: true });
    assertEquals(seen, [true, false, false]);
  });
  // No plugin: a no-op stop.
  onScreenReaderChange(() => {
    throw new Error("never");
  })();
});

Deno.test("useScreenReader: the first read, then every change; false on the web", async () => {
  const a11y = fakePlugin(["isScreenReaderEnabled"], { isScreenReaderEnabled: { value: true } });
  await inShell("ios", { DenextAccessibility: a11y.plugin }, async () => {
    let state: boolean | undefined;
    const { root, rerender } = mount(function Probe() {
      state = useScreenReader();
      return null;
    });
    assertEquals(state, false, "false before the first answer");
    await settle();
    rerender();
    assertEquals(state, true);
    a11y.fire("screenReaderChanged", { value: false });
    rerender();
    assertEquals(state, false);
    root.unmount();
    await settle();
    assertEquals(a11y.listening(), 0, "unmount removes the listener");
  });
  let web: boolean | undefined;
  const { root } = mount(function Probe() {
    web = useScreenReader();
    return null;
  });
  await settle();
  assertEquals(web, false);
  root.unmount();
});

/** A fake BackgroundGeolocation plugin: `start` keeps the callback, `stop` is recorded. */
function fakeBackground(startError?: unknown) {
  const calls: string[] = [];
  let callback: ((location?: Any, error?: Any) => void) | undefined;
  let options: Any;
  const plugin = {
    start(opts: Any, cb: (location?: Any, error?: Any) => void) {
      calls.push("start");
      options = opts;
      callback = cb;
      if (startError) throw startError;
      return "callback-1";
    },
    stop() {
      calls.push("stop");
      return Promise.resolve();
    },
  };
  return {
    plugin,
    calls,
    options: () => options,
    emit: (location?: Any, error?: Any) => callback?.(location, error),
  };
}

const RAW = {
  latitude: 52.5,
  longitude: 13.4,
  accuracy: 8,
  altitude: 34,
  altitudeAccuracy: null,
  bearing: 90,
  speed: 1.5,
  simulated: false,
  time: 1_700_000_000_000,
};

Deno.test("watchPositionInBackground: maps fixes and options, stops on demand", async () => {
  const bg = fakeBackground();
  await inShell("android", { BackgroundGeolocation: bg.plugin }, async () => {
    assert(isBackgroundLocationAvailable());
    const fixes: Any[] = [];
    const errors: string[] = [];
    const stop = watchPositionInBackground((p) => fixes.push(p), {
      notification: { title: "Run", message: "Recording" },
      distanceFilterM: 10,
      url: "https://api.example/loc",
      headers: { Authorization: "Bearer t" },
    }, (e) => errors.push(e.code));
    await settle();
    assertEquals(bg.options(), {
      backgroundTitle: "Run",
      backgroundMessage: "Recording",
      requestPermissions: true,
      stale: false,
      distanceFilter: 10,
      url: "https://api.example/loc",
      headers: { Authorization: "Bearer t" },
    });
    bg.emit(RAW);
    assertEquals(fixes, [{
      latitude: 52.5,
      longitude: 13.4,
      accuracy: 8,
      altitude: 34,
      altitudeAccuracy: null,
      heading: 90,
      speed: 1.5,
      timestamp: 1_700_000_000_000,
    }]);
    bg.emit(undefined, { code: "NOT_AUTHORIZED", message: "no" });
    bg.emit(undefined, { code: "SOMETHING", message: "odd" });
    assertEquals(errors, ["denied", "unavailable"]);
    stop();
    stop();
    await settle();
    bg.emit(RAW);
    assertEquals(fixes.length, 1, "no fix after stop");
    assertEquals(bg.calls, ["start", "stop"]);
  });
});

Deno.test("watchPositionInBackground: a second watch stops the first; stopBackgroundLocation", async () => {
  const bg = fakeBackground();
  await inShell("ios", { BackgroundGeolocation: bg.plugin }, async () => {
    const first: Any[] = [];
    const second: Any[] = [];
    const stopFirst = watchPositionInBackground((p) => first.push(p));
    await settle();
    assertEquals(bg.options().backgroundMessage, "Tracking your location in the background.");
    watchPositionInBackground((p) => second.push(p), { allowStale: true });
    await settle();
    await settle();
    assertEquals(bg.calls, ["start", "stop", "start"]);
    assertEquals(bg.options().stale, true);
    bg.emit(RAW);
    assertEquals([first.length, second.length], [0, 1]);
    stopFirst(); // the replaced watch's stop leaves the new one running
    await settle();
    assertEquals(bg.calls, ["start", "stop", "start"]);
    await stopBackgroundLocation();
    assertEquals(bg.calls, ["start", "stop", "start", "stop"]);
    bg.emit(RAW);
    assertEquals(second.length, 1);
  });
});

Deno.test("watchPositionInBackground: a throwing start reports unavailable", async () => {
  const bg = fakeBackground(new Error("Failed to create location manager"));
  await inShell("ios", { BackgroundGeolocation: bg.plugin }, async () => {
    const errors: Any[] = [];
    const stop = watchPositionInBackground(() => {}, {}, (e) => errors.push(e));
    await settle();
    assertEquals(errors.map((e) => [e.name, e.code]), [["GeolocationError", "unavailable"]]);
    stop();
    await settle();
  });
});

Deno.test("watchPositionInBackground: the foreground watch without the plugin", async () => {
  const cleared: number[] = [];
  let ok: Any;
  const navigator = {
    geolocation: {
      getCurrentPosition: () => {},
      watchPosition: (a: unknown) => {
        ok = a;
        return 7;
      },
      clearWatch: (id: number) => cleared.push(id),
    },
  };
  await withGlobals({ navigator }, async () => {
    assertEquals(isBackgroundLocationAvailable(), false);
    const fixes: Any[] = [];
    const stop = watchPositionInBackground((p) => fixes.push(p.latitude));
    ok({ coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp: 4 });
    stop();
    assertEquals(fixes, [1]);
    await stopBackgroundLocation(); // nothing to stop
  });
  assertEquals(cleared, [7]);
});
