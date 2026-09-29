// React Native mode's packages over denext/mobile's native views (2.11 RN compat round 4):
// expo-maps and react-native-maps on the "map" view, expo-video and react-native-video on the
// "video" view, and expo-symbols on SystemIcon, each in a faked Capacitor shell with a fake
// DenextNativeViews plugin, and on the web (no plugin), where the fallback renders.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { AppleMaps, GoogleMaps } from "../src/expo/maps.ts";
import { useVideoPlayer, type VideoPlayer, VideoView } from "../src/expo/video.ts";
import { SymbolView } from "../src/expo/symbols.ts";
import RNMapView, {
  deltaForZoom,
  type MapViewRef,
  Marker,
  zoomForDelta,
} from "../src/react-native-compat/maps.ts";
import RNVideo, { type VideoRef } from "../src/react-native-compat/video.ts";
import { pageTracker, type TrackerEnv } from "../src/mobile/native-view-tracker.ts";
import { resetNativeViewWarningsForTesting } from "../src/expo/internal/native-view.ts";
import { getViewManagerConfig, nativeHostComponent } from "../src/react-native/native-modules.ts";
// What React Native mode's build calls on react-native-web's UIManager, and what its
// codegenNativeCommands dispatch through (the overlay entry's).
import { dispatchViewManagerCommand, withViewManagerCommands } from "../src/react-native/mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import { type Any, fakePlugin, inShell, mount, settle } from "./helpers/mobile-fakes.ts";

/** Let passive effects and promise callbacks run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();
}

/** A tracker environment that never schedules anything (the tests read the plugin calls). */
function quietEnv(): TrackerEnv {
  return {
    now: () => 0,
    raf: () => 0,
    caf: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    viewport: () => ({ x: 0, y: 0, width: 400, height: 800 }),
    visualViewport: () => undefined,
    styleOf: () => ({}),
    hitTest: () => [null],
    dpr: () => 3,
    pageScroll: () => ({ x: 0, y: 0, width: 400, height: 800 }),
    nativeFollows: () => false,
    listen: () => () => {},
    observeResize: () => () => {},
  } as TrackerEnv;
}

/** A fake document whose elements have the media methods a `<video>` needs. */
function mediaDocument(doc: Any = makeDom().doc): Any {
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag: string) =>
    Object.assign(create(tag), {
      paused: true,
      ended: false,
      currentTime: 0,
      pause() {},
      play: () => Promise.resolve(),
    });
  return doc;
}

/** {@linkcode mount} on a document whose elements have the media methods. */
function mountMedia(render: () => unknown) {
  const { doc, container } = makeDom();
  mediaDocument(doc);
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  let n = 0;
  function Probe(_props: { n: number }) {
    return render();
  }
  const rerender = () => {
    root.render(h(Probe as Any, { n: ++n }));
    flushSync();
  };
  rerender();
  return { rerender, container: container as Any };
}

/** A fake DenextNativeViews plugin registering `types`. */
function viewsPlugin(types: string[]) {
  return fakePlugin(["types", "create", "update", "setProps", "command", "destroy"], {
    types: { types },
    create: {},
    command: { currentTime: 4, duration: 9, playing: true },
  });
}

/** The `create` call's argument. */
function created(views: ReturnType<typeof viewsPlugin>): Any {
  return views.calls.find(([m]) => m === "create")?.[1];
}

/** The `command` calls' names and args. */
function commands(views: ReturnType<typeof viewsPlugin>): Array<[string, unknown]> {
  return views.calls.filter(([m]) => m === "command").map(([, a]) => [
    (a as Any).name,
    (a as Any).args,
  ]);
}

// ---- expo-maps ----------------------------------------------------------------------------

Deno.test("expo-maps: the web renders the placeholder; the ref says how to get the map", async () => {
  resetNativeViewWarningsForTesting();
  const ref: { current: Any } = { current: null };
  const { container } = mount(() => h(AppleMaps.View as Any, { ref, style: { height: 200 } }));
  await tick();
  const slot = container.firstChild;
  assertEquals(slot.getAttribute("data-denext-native-view"), "map");
  assertEquals(slot.getAttribute("data-status"), "web");
  assert(slot.textContent.includes("Map unavailable"));
  assertThrows(
    () => ref.current.setCameraPosition({ coordinates: { latitude: 1, longitude: 2 } }),
    Error,
    "native-map",
  );
  const street = mount(() => h(GoogleMaps.StreetView as Any, {}));
  assert(street.container.textContent.includes("Street View unavailable"));
});

Deno.test("expo-maps: AppleMaps.View drives the native map (camera, markers, events, ref)", async () => {
  const views = viewsPlugin(["map"]);
  await inShell("ios", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, quietEnv());
    const ref: { current: Any } = { current: null };
    const moves: unknown[] = [];
    const clicks: unknown[] = [];
    const markers = [
      { id: "a", coordinates: { latitude: 51.5, longitude: -0.1 }, title: "A" },
      { id: "b", coordinates: { latitude: 48.8, longitude: 2.3 } },
    ];
    mount(() =>
      h(AppleMaps.View as Any, {
        ref,
        cameraPosition: { coordinates: { latitude: 51.5, longitude: -0.12 }, zoom: 11 },
        markers,
        properties: { mapType: AppleMaps.MapType.HYBRID },
        onCameraMove: (e: unknown) => moves.push(e),
        onMarkerClick: (m: unknown) => clicks.push(m),
      })
    );
    await tick();
    await tick();
    const create = created(views);
    assertEquals(create.type, "map");
    assertEquals(create.props, {
      markers: [{ latitude: 51.5, longitude: -0.1, title: "A" }, {
        latitude: 48.8,
        longitude: 2.3,
      }],
      interactive: true,
      mapType: "hybrid",
      latitude: 51.5,
      longitude: -0.12,
      zoom: 11,
    });
    const event = (name: string, data: unknown) =>
      views.fire("nativeViewEvent", { id: create.id, name, data });
    event("regionChange", { latitude: 1, longitude: 2, zoom: 5 });
    event("markerPress", { index: 1, title: "" });
    assertEquals(moves, [{ coordinates: { latitude: 1, longitude: 2 }, zoom: 5 }]);
    assertEquals(clicks, [markers[1]]);
    ref.current.selectMarker("a", { zoom: 14 });
    ref.current.setCameraPosition({ coordinates: { latitude: 3, longitude: 4 } });
    await tick();
    assertEquals(commands(views), [
      ["setRegion", { latitude: 51.5, longitude: -0.1, zoom: 14, animated: true }],
      ["setRegion", { latitude: 3, longitude: 4, zoom: 11, animated: true }],
    ]);
  });
});

// ---- react-native-maps ---------------------------------------------------------------------

Deno.test("react-native-maps: region deltas and zoom levels round-trip for a width", () => {
  const zoom = zoomForDelta(0.05, 390);
  assert(zoom > 12 && zoom < 14, `zoom ${zoom}`);
  assert(Math.abs(deltaForZoom(zoom, 390) - 0.05) < 1e-9);
  assertEquals(zoomForDelta(1e9, 390) >= 0, true, "clamped");
});

Deno.test("react-native-maps: MapView's Markers, region events and ref reach the native map", async () => {
  const views = viewsPlugin(["map"]);
  await inShell("android", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, quietEnv());
    const ref: { current: MapViewRef | null } = { current: null };
    const regions: Any[] = [];
    const pressed: unknown[] = [];
    let ready = 0;
    mount(() =>
      h(
        RNMapView as Any,
        {
          ref,
          initialRegion: { latitude: 10, longitude: 20, latitudeDelta: 0.1, longitudeDelta: 0.1 },
          mapType: "satellite",
          onRegionChangeComplete: (r: unknown) => regions.push(r),
          onMapReady: () => ready++,
        },
        h(Marker as Any, {
          coordinate: { latitude: 10, longitude: 20 },
          title: "Here",
          onPress: (e: unknown) => pressed.push(e),
        }),
        [h(Marker as Any, { coordinate: { latitude: 11, longitude: 21 } })],
        h("span", null, "not a marker"),
      )
    );
    await tick();
    await tick();
    const create = created(views);
    assertEquals(create.props.mapType, "satellite");
    assertEquals(create.props.markers, [
      { latitude: 10, longitude: 20, title: "Here" },
      { latitude: 11, longitude: 21 },
    ]);
    assertEquals([create.props.latitude, create.props.longitude], [10, 20]);
    assertEquals(create.props.zoom, zoomForDelta(0.1));
    assertEquals(ready, 1);
    views.fire("nativeViewEvent", {
      id: create.id,
      name: "regionChange",
      data: { latitude: 1, longitude: 2, zoom: 10 },
    });
    assertEquals([regions[0].latitude, regions[0].longitude], [1, 2]);
    assertEquals(regions[0].longitudeDelta, deltaForZoom(10));
    views.fire("nativeViewEvent", { id: create.id, name: "markerPress", data: { index: 0 } });
    assertEquals(pressed, [{
      nativeEvent: { coordinate: { latitude: 10, longitude: 20 }, id: undefined },
    }]);
    ref.current!.animateToRegion({
      latitude: 5,
      longitude: 6,
      latitudeDelta: 1,
      longitudeDelta: 1,
    });
    ref.current!.fitToElements({ animated: false });
    await tick();
    const [first, second] = commands(views) as Any[];
    assertEquals(first[1].latitude, 5);
    assertEquals(first[1].zoom, zoomForDelta(1));
    assertEquals([second[1].latitude, second[1].longitude, second[1].animated], [
      10.5,
      20.5,
      false,
    ]);
    const camera = await ref.current!.getCamera();
    assertEquals(camera.center, { latitude: 1, longitude: 2 });
  });
});

// ---- expo-video ------------------------------------------------------------------------------

Deno.test("expo-video: VideoView shows the player natively; play / seek / events map over", async () => {
  const views = viewsPlugin(["video"]);
  // The player makes its <video> (the web fallback, until the view is native) on the document.
  await inShell("ios", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, quietEnv());
    let player: VideoPlayer | undefined;
    const playing: boolean[] = [];
    const statuses: string[] = [];
    let ended = 0;
    function Screen() {
      player = useVideoPlayer("https://example.com/v.mp4", (p) => {
        p.loop = true;
      });
      return h(VideoView as Any, { player, contentFit: "cover", nativeControls: false });
    }
    mount(() => h(Screen, null));
    await tick();
    await tick();
    const create = created(views);
    assertEquals(create.type, "video");
    assertEquals(create.placement, "under", "iOS draws the system player under the page");
    assertEquals(create.scrollPassthrough, "vertical");
    assertEquals(create.props.src, "https://example.com/v.mp4");
    assertEquals(create.props.fit, "cover");
    assertEquals(create.props.controls, false);
    player!.addListener("playingChange", (e) => playing.push(e.isPlaying));
    player!.addListener("statusChange", (e) => statuses.push(e.status));
    player!.addListener("playToEnd", () => ended++);
    player!.play();
    player!.currentTime = 12;
    await tick();
    assertEquals(commands(views).map(([n]) => n), ["play", "seek"]);
    assertEquals(commands(views)[1][1], { seconds: 12 });
    const event = (name: string, data?: unknown) =>
      views.fire("nativeViewEvent", { id: create.id, name, data });
    event("ready", { duration: 30 });
    event("play");
    event("ended");
    assertEquals(statuses, ["readyToPlay"]);
    assertEquals(playing, [true]);
    assertEquals(ended, 1);
    assertEquals(player!.duration, 30);
    assertEquals(player!.playing, false, "ended");
  }, { document: mediaDocument() });
});

// ---- react-native-video ----------------------------------------------------------------------

Deno.test("react-native-video: the web renders a <video>; the shell the native player", async () => {
  const web = mountMedia(() =>
    h(RNVideo as Any, { source: { uri: "https://x/a.mp4" }, repeat: true, controls: true })
  );
  await tick();
  const video = web.container.firstChild.firstChild;
  assertEquals(video.tagName, "VIDEO");
  assertEquals(video.getAttribute("src"), "https://x/a.mp4");

  const views = viewsPlugin(["video"]);
  await inShell("android", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, quietEnv());
    const ref: { current: VideoRef | null } = { current: null };
    const loads: unknown[] = [];
    let paused = false;
    const { rerender } = mountMedia(() =>
      h(RNVideo as Any, {
        ref,
        source: "https://x/b.mp4",
        paused,
        muted: true,
        resizeMode: "stretch",
        onLoad: (d: unknown) => loads.push(d),
      })
    );
    await tick();
    await tick();
    const create = created(views);
    assertEquals(create.props, {
      src: "https://x/b.mp4",
      controls: false,
      loop: false,
      muted: true,
      autoplay: true,
      fit: "cover",
    });
    views.fire("nativeViewEvent", { id: create.id, name: "ready", data: { duration: 7 } });
    assertEquals((loads[0] as Any).duration, 7);
    paused = true;
    rerender();
    await tick();
    ref.current!.seek(3);
    assertEquals(await ref.current!.getCurrentPosition(), 4, "the native player's answer");
    const names = commands(views).map(([n]) => n);
    assert(names.includes("pause"), names.join());
    assert(names.includes("seek"), names.join());
  });
});

// ---- expo-symbols ------------------------------------------------------------------------------

Deno.test("expo-symbols: SymbolView is SystemIcon (a Material Symbol off iOS) or the fallback", () => {
  const { container } = mount(() =>
    h(SymbolView as Any, {
      name: { ios: "house.fill", android: "home" },
      size: 20,
      tintColor: "red",
    })
  );
  const icon = container.firstChild;
  assertEquals(icon.getAttribute("data-dnx-system-icon"), "house.fill");
  assertEquals(icon.firstChild.tagName, "SVG", "the Material Symbol, drawn inline");
  assertEquals(icon.style.getPropertyValue("color"), "red");
  const withFallback = mount(() =>
    h(SymbolView as Any, { name: "star", fallback: h("i", null, "*") })
  );
  assertEquals(withFallback.container.firstChild.tagName, "I");
});

// ---- UIManager's view manager API ---------------------------------------------------------

Deno.test("UIManager: getViewManagerConfig knows the app's native components only", () => {
  assertEquals(getViewManagerConfig("NoSuchView"), null);
  nativeHostComponent("RNTChart");
  const config = getViewManagerConfig("RNTChart")!;
  assertEquals(config.Commands.zoomTo, "zoomTo", "a command's id is its name");
  assertEquals((config.Commands as Any).then, undefined, "not thenable");
  // Added in place; a member react-native-web already has is kept.
  const own = () => "own";
  const ui: Any = withViewManagerCommands({ measure: own, dispatchViewManagerCommand: own });
  assertEquals(ui.measure, own);
  assertEquals(ui.dispatchViewManagerCommand, own);
  assertEquals(ui.getViewManagerConfig, getViewManagerConfig);
  assertEquals(ui.hasViewManagerConfig("RNTChart"), true);
  assertEquals(ui.hasViewManagerConfig("NoSuchView"), false);
});

Deno.test("UIManager: dispatchViewManagerCommand runs on the native slot a ref names", async () => {
  const views = viewsPlugin(["RNTChart"]);
  const warned: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args[0]);
  try {
    await inShell("android", { DenextNativeViews: views.plugin }, async () => {
      pageTracker(views.plugin as Any, quietEnv());
      const Chart = nativeHostComponent("RNTChart");
      const ref: { current: Any } = { current: null };
      // Before the view is native, and for a tag that is no slot: a no-op, warned once.
      dispatchViewManagerCommand(ref, "zoomTo", [2]);
      dispatchViewManagerCommand(42, "zoomTo", [2]);
      assertEquals(warned.length, 1);
      assert(String(warned[0]).includes('dispatchViewManagerCommand("zoomTo") names no native'));
      mount(() => h(Chart as Any, { ref, values: [1] }));
      await tick();
      await tick();
      assertEquals(ref.current?.getAttribute("data-denext-native-view"), "RNTChart");
      const id = created(views).id;
      const { Commands } = getViewManagerConfig("RNTChart")!;
      dispatchViewManagerCommand(ref.current, Commands.zoomTo, [3, { animated: true }]);
      dispatchViewManagerCommand(ref, "reset");
      await tick();
      assertEquals(commands(views), [["zoomTo", { args: [3, { animated: true }] }], ["reset", {
        args: [],
      }]]);
      assertEquals(views.calls.filter(([m]) => m === "command").map(([, a]) => (a as Any).id), [
        id,
        id,
      ]);
      assertEquals(warned.length, 1, "no further warnings");
    });
  } finally {
    console.warn = warn;
  }
});
