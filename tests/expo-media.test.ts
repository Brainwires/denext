// expo-image-picker's multi-select and video picks (over denext/mobile's pickMedia) and
// expo-audio's background mode and lock-screen controls (over denext/mobile's now-playing API),
// driven through faked Capacitor plugins and a fake audio element.

import { assert, assertEquals } from "@std/assert";
import * as ImagePicker from "../src/expo/image-picker.ts";
import { AudioPlayer, createAudioPlayer, setAudioModeAsync } from "../src/expo/audio.ts";
import { resetNowPlayingForTesting } from "../src/mobile/now-playing.ts";
import { type Any, fakePlugin, inShell, settle, withGlobals } from "./helpers/mobile-fakes.ts";

// ---- expo-image-picker ------------------------------------------------------------------------

const GALLERY = {
  results: [
    {
      type: 0,
      uri: "file:///tmp/a.jpg",
      webPath: "capacitor://localhost/_capacitor_file_/tmp/a.jpg",
      metadata: { format: "jpeg", size: 10, resolution: "800x600" },
    },
    {
      type: 1,
      uri: "file:///tmp/b.mp4",
      webPath: "capacitor://localhost/_capacitor_file_/tmp/b.mp4",
      metadata: { format: "mp4", size: 99, duration: 2.5, resolution: "1280x720" },
    },
  ],
};

Deno.test("expo-image-picker: allowsMultipleSelection, selectionLimit and mediaTypes reach the gallery", async () => {
  const camera = fakePlugin(["getPhoto", "chooseFromGallery", "recordVideo"], {
    chooseFromGallery: GALLERY,
    recordVideo: {
      uri: "file:///tmp/rec.mov",
      webPath: "capacitor://localhost/_capacitor_file_/tmp/rec.mov",
      metadata: { format: "mov", duration: 1.25, resolution: "1920x1080" },
    },
  });
  await inShell("ios", { Camera: camera.plugin }, async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: 4,
      quality: 0.8,
    });
    assertEquals(result.canceled, false);
    assertEquals(result.assets, [
      {
        uri: "capacitor://localhost/_capacitor_file_/tmp/a.jpg",
        width: 800,
        height: 600,
        type: "image",
        fileName: "a.jpg",
        mimeType: "image/jpeg",
        assetId: null,
        exif: null,
        duration: null,
        fileSize: 10,
      },
      {
        uri: "capacitor://localhost/_capacitor_file_/tmp/b.mp4",
        width: 1280,
        height: 720,
        type: "video",
        fileName: "b.mp4",
        mimeType: "video/mp4",
        assetId: null,
        exif: null,
        duration: 2500,
        fileSize: 99,
      },
    ]);
    await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
    });
    const recorded = await ImagePicker.launchCameraAsync({ mediaTypes: "videos" });
    assertEquals(recorded.assets?.[0].type, "video");
    assertEquals(recorded.assets?.[0].duration, 1250);
    assertEquals(recorded.assets?.[0].mimeType, "video/quicktime");
    // One image, no multi-select: the pickImage path, as before.
    await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"] });
  });
  assertEquals(camera.calls.map(([m, arg]) => [m, arg]), [
    ["chooseFromGallery", {
      mediaType: 2,
      allowMultipleSelection: true,
      limit: 4,
      includeMetadata: true,
      quality: 80,
    }],
    ["chooseFromGallery", { mediaType: 1, allowMultipleSelection: false, includeMetadata: true }],
    ["recordVideo", { includeMetadata: true }],
    ["getPhoto", { resultType: "uri", source: "PHOTOS", allowEditing: false }],
  ]);
});

Deno.test("expo-image-picker: orderedSelection goes through the FilePicker plugin; a cancel is canceled", async () => {
  const picker = fakePlugin(["pickImages", "pickVideos", "pickMedia"], {
    pickImages: {
      files: [
        {
          name: "2.png",
          mimeType: "image/png",
          size: 2,
          webPath: "capacitor://x/2.png",
          width: 2,
          height: 3,
        },
        {
          name: "1.png",
          mimeType: "image/png",
          size: 1,
          webPath: "capacitor://x/1.png",
          width: 4,
          height: 5,
        },
      ],
    },
    pickMedia: new Error("pickFiles canceled."),
  });
  const camera = fakePlugin(["getPhoto", "chooseFromGallery"]);
  await inShell("ios", { Camera: camera.plugin, FilePicker: picker.plugin }, async () => {
    const ordered = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      orderedSelection: true,
    });
    assertEquals(ordered.assets?.map((a) => [a.fileName, a.width, a.height]), [
      ["2.png", 2, 3],
      ["1.png", 4, 5],
    ]);
    assertEquals(
      await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: true,
        orderedSelection: true,
      }),
      { canceled: true, assets: null },
    );
  });
  assertEquals(picker.calls, [
    ["pickImages", { readData: false, limit: 0, ordered: true }],
    ["pickMedia", { readData: false, limit: 0, ordered: true }],
  ]);
  assertEquals(camera.calls, []);
});

Deno.test("expo-image-picker: the web's multiple file input, with the picked File on each asset", async () => {
  const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  const b = new File([new Uint8Array([1, 2])], "b.webm", { type: "video/webm" });
  const inputs: Any[] = [];
  const document = {
    body: { appendChild: () => {} },
    createElement(tag: string) {
      if (tag === "video") {
        // A video element that reports its metadata once given a source.
        const video: Any = { videoWidth: 640, videoHeight: 480, duration: 3.2 };
        video.removeAttribute = () => {};
        Object.defineProperty(video, "src", {
          set: () => queueMicrotask(() => video.onloadedmetadata()),
        });
        return video;
      }
      const listeners = new Map<string, () => void>();
      const el: Any = {
        tag,
        style: {},
        setAttribute: () => {},
        addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
        remove: () => {},
        click() {
          queueMicrotask(() => {
            el.files = [a, b];
            listeners.get("change")?.();
          });
        },
      };
      inputs.push(el);
      return el;
    },
  };
  await withGlobals({ document, Capacitor: undefined }, async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: 1,
    });
    assertEquals(result.assets?.length, 1);
    const [asset] = result.assets!;
    assertEquals([asset.type, asset.fileName, asset.mimeType, asset.fileSize], [
      "image",
      "a.png",
      "image/png",
      1,
    ]);
    assertEquals(asset.file, a);
    URL.revokeObjectURL(asset.uri);
    // A video: its size and length measured from the element's metadata, in ms.
    const videos = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "videos",
      allowsMultipleSelection: true,
    });
    const video = videos.assets!.find((v) => v.type === "video")!;
    assertEquals([video.width, video.height, video.duration, video.mimeType], [
      640,
      480,
      3200,
      "video/webm",
    ]);
    for (const v of videos.assets!) URL.revokeObjectURL(v.uri);
  });
  assertEquals([inputs[0].accept, inputs[0].multiple], ["image/*,video/*", true]);
});

// ---- expo-audio -------------------------------------------------------------------------------

/** A fake `HTMLAudioElement`: enough of it for AudioPlayer. */
class FakeAudio {
  static made: FakeAudio[] = [];
  paused = true;
  ended = false;
  currentTime = 0;
  duration = 180;
  playbackRate = 1;
  readyState = 4;
  muted = false;
  loop = false;
  volume = 1;
  preload = "";
  src = "";
  private listeners = new Map<string, Set<() => void>>();
  constructor() {
    FakeAudio.made.push(this);
  }
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  play(): Promise<void> {
    this.paused = false;
    this.fire("play");
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.fire("pause");
  }
  removeAttribute(): void {}
}

Deno.test("expo-audio: setAudioModeAsync sets the shell's audio session from Expo's mode", async () => {
  const native = fakePlugin(["configureSession", "setNowPlaying", "clearNowPlaying"]);
  await inShell("ios", { DenextNowPlaying: native.plugin }, async () => {
    await setAudioModeAsync({ playsInSilentMode: true });
    await setAudioModeAsync({ shouldPlayInBackground: true, interruptionMode: "doNotMix" });
    await setAudioModeAsync({ interruptionMode: "duckOthers" });
    await setAudioModeAsync({ shouldPlayInBackground: false, interruptionMode: "mixWithOthers" });
  });
  assertEquals(native.calls, [
    ["configureSession", { background: true, interruption: "exclusive" }],
    ["configureSession", { background: true, interruption: "duck" }],
    ["configureSession", { background: false, interruption: "mix" }],
  ]);
  // Off the shell a browser decides itself: nothing to call, nothing thrown.
  await withGlobals(
    { Capacitor: undefined },
    () => setAudioModeAsync({ shouldPlayInBackground: true }),
  );
});

Deno.test("expo-audio: setActiveForLockScreen shows the player and routes the controls to it", async () => {
  resetNowPlayingForTesting();
  FakeAudio.made = [];
  const native = fakePlugin(["configureSession", "setNowPlaying", "clearNowPlaying"]);
  await inShell("android", { DenextNowPlaying: native.plugin }, async () => {
    const player = createAudioPlayer("https://cdn.example.com/a.mp3");
    player.setActiveForLockScreen(
      true,
      { title: "Track", artist: "Artist", albumTitle: "Album", artworkUrl: "https://x.test/a.jpg" },
      { showSeekForward: true, showNextTrack: true },
    );
    await settle();
    const element = FakeAudio.made[0];
    const sent = () => native.calls.filter(([m]) => m === "setNowPlaying").map(([, a]) => a as Any);
    assertEquals(sent()[0], {
      title: "Track",
      artist: "Artist",
      album: "Album",
      artwork: "https://x.test/a.jpg",
      duration: 180,
      position: 0,
      playbackRate: 1,
      playing: false,
      controls: ["play", "pause", "seek", "seekForward"],
      seekOffset: 10,
    });
    native.fire("mediaControl", { action: "play" });
    assertEquals(element.paused, false);
    await settle();
    assertEquals(sent().at(-1).playing, true, "the new state follows the command");
    native.fire("mediaControl", { action: "seekForward", offset: 10 });
    assertEquals(element.currentTime, 10);
    native.fire("mediaControl", { action: "seek", position: 170 });
    native.fire("mediaControl", { action: "seekForward", offset: 30 });
    assertEquals(element.currentTime, 180, "clamped to the duration");
    native.fire("mediaControl", { action: "pause" });
    assertEquals(element.paused, true);
    player.updateLockScreenMetadata({ title: "Track 2" });
    await settle();
    assertEquals(sent().at(-1).title, "Track 2");
    assertEquals(sent().at(-1).artist, undefined);
    // Another player takes the lock screen: the first no longer answers the controls.
    const other = new AudioPlayer("https://cdn.example.com/b.mp3");
    other.setActiveForLockScreen(true, { title: "B" }, { isLiveStream: true });
    await settle();
    assertEquals(sent().at(-1).controls, ["play", "pause"]);
    assertEquals("duration" in sent().at(-1), false, "a live stream has no duration");
    native.fire("mediaControl", { action: "play" });
    assertEquals(element.paused, true);
    assertEquals(FakeAudio.made[1].paused, false);
    assertEquals(native.listening(), 1);
    player.clearLockScreenControls(); // not the holder: nothing changes
    assertEquals(native.calls.filter(([m]) => m === "clearNowPlaying").length, 0);
    other.remove();
    await settle();
    assertEquals(native.calls.filter(([m]) => m === "clearNowPlaying").length, 1);
    assertEquals(native.listening(), 0);
    player.remove();
  }, { Audio: FakeAudio });
  assert(FakeAudio.made.length === 2);
  resetNowPlayingForTesting();
});
