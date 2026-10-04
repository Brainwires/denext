// denext/expo/image and denext/expo/camera past the gap audit: expo-image's statics, BlurHash /
// ThumbHash placeholders, transitions and cache policy; expo-camera's CameraView statics, the
// getUserMedia preview's takePictureAsync / recordAsync, and the shell's @capacitor/camera
// fallback. Web APIs (Cache API, fetch, createImageBitmap, canvas, MediaRecorder) are faked.

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Image, imageCacheConfig, ImageRef, useImage } from "../src/expo/image.ts";
import { CameraView, type CameraViewHandle, PictureRef } from "../src/expo/camera.ts";
import {
  blurhashToRgba,
  hashPlaceholderUrl,
  isBlurhashValid,
  rgbaToBlurhash,
  rgbaToDataUrl,
  rgbaToThumbhash,
  thumbhashToRgba,
} from "../src/expo/internal/image-hash.ts";
import { type Any, fakePlugin, inShell, mount, withGlobals } from "./helpers/mobile-fakes.ts";

/** Let promise callbacks and timers run, then commit what they scheduled. */
async function tick(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

/** An RGBA image of `w`×`h` filled by `color(x, y)`. */
function image(w: number, h: number, color: (x: number, y: number) => number[]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) rgba.set(color(x, y), 4 * (x + y * w));
  }
  return { w, h, rgba };
}

/** The average of one channel. */
function mean(rgba: Uint8Array, channel: number): number {
  let sum = 0;
  for (let i = channel; i < rgba.length; i += 4) sum += rgba[i];
  return sum / (rgba.length / 4);
}

// ---- hashes ---------------------------------------------------------------------------------------

Deno.test("image hashes: BlurHash and ThumbHash round-trip; the PNG data URL is a real PNG", () => {
  const known = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
  assert(isBlurhashValid(known));
  assert(!isBlurhashValid("LEHV6nWB2yk8pyo0adR*.7kCMdn"), "wrong length");
  assertEquals(blurhashToRgba("nope", 4, 4), null);
  const decoded = blurhashToRgba(known, 32, 32)!;
  assertEquals([decoded.w, decoded.h, decoded.rgba.length], [32, 32, 32 * 32 * 4]);

  const gradient = image(16, 8, (x) => [x * 16, 64, 255 - x * 16, 255]);
  const hash = rgbaToBlurhash(gradient, 4, 3);
  assert(isBlurhashValid(hash), hash);
  const back = blurhashToRgba(hash, 16, 8)!;
  for (const c of [0, 1, 2]) {
    assert(Math.abs(mean(back.rgba, c) - mean(gradient.rgba, c)) < 24, `channel ${c}`);
  }
  assert(back.rgba[0] < back.rgba[4 * 15], "red rises left to right");

  const red = image(8, 8, () => [220, 20, 20, 255]);
  const thumb = thumbhashToRgba(rgbaToThumbhash(red))!;
  assert(mean(thumb.rgba, 0) > 180 && mean(thumb.rgba, 1) < 70, "decodes red");
  assertEquals(thumbhashToRgba(new Uint8Array(2)), null);

  const url = rgbaToDataUrl(red);
  assertMatch(url, /^data:image\/png;base64,/);
  const bytes = Uint8Array.from(atob(url.slice(22)), (c) => c.charCodeAt(0));
  assertEquals([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assertEquals([bytes[19], bytes[23]], [8, 8], "IHDR width and height");
  assertMatch(hashPlaceholderUrl(`blurhash:/${hash}/8/4`)!, /^data:image\/png/);
  assertMatch(hashPlaceholderUrl(`thumbhash:/${btoa("\x01\x02\x03\x04\x05\x06\x07")}`)!, /^data:/);
  assertEquals(hashPlaceholderUrl("blurhash:/@@"), null);
});

// ---- expo-image: rendering -------------------------------------------------------------------------

Deno.test("expo-image: a BlurHash placeholder shows until load, then the image fades in", async () => {
  const events: string[] = [];
  let key = "a";
  const { container, rerender, root } = mount(() =>
    h(Image as Any, {
      source: { uri: "https://x/a.png" },
      placeholder: { blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
      transition: { duration: 150, timing: "linear" },
      contentPosition: { top: 0, left: 10 },
      recyclingKey: key,
      alt: "A",
      onLoadStart: () => events.push("start"),
      onLoad: (e: Any) => events.push(`load ${e.source.width}`),
      onDisplay: () => events.push("display"),
      onLoadEnd: () => events.push("end"),
    })
  );
  await tick();
  const box = container.firstChild;
  assertEquals(box.childNodes.length, 2, "placeholder + image");
  const [holder, img] = box.childNodes;
  assertMatch(holder.getAttribute("src"), /^data:image\/png;base64,/);
  assertEquals(img.style.getPropertyValue("opacity"), "0");
  assertEquals(img.style.getPropertyValue("transition"), "opacity 150ms linear");
  assertEquals(img.style.getPropertyValue("object-position"), "10px 0px");
  img.naturalWidth = 64;
  img.naturalHeight = 32;
  img.dispatch("load", { currentTarget: img });
  flushSync();
  assertEquals(box.childNodes.length, 1, "the placeholder is gone");
  assertEquals(box.firstChild.style.getPropertyValue("opacity"), "");
  assertEquals(events, ["start", "load 64", "display", "end"]);
  key = "b";
  rerender();
  await tick();
  assertEquals(box.childNodes.length, 2, "a new recycling key shows the placeholder again");
  root.unmount();
});

Deno.test("expo-image: a hash source and a plain image keep the single <img>", async () => {
  const { container, root } = mount(() =>
    h(Image as Any, { source: "blurhash:/LEHV6nWB2yk8pyo0adR*.7kCMdnj/8/8", blurRadius: 3 })
  );
  await tick();
  const img = container.firstChild;
  assertEquals(img.tagName, "IMG");
  assertMatch(img.getAttribute("src"), /^data:image\/png/);
  assertEquals(img.style.getPropertyValue("filter"), "blur(3px)");
  root.unmount();
});

// ---- expo-image: statics ---------------------------------------------------------------------------

/** A Cache API stand-in (one cache) plus a fetch that serves `bodies` by URL. */
function fakeWeb(bodies: Record<string, string>) {
  const store = new Map<string, Response>();
  const fetched: string[] = [];
  let deleted = 0;
  const cache = {
    put: (key: string, res: Response) => Promise.resolve(void store.set(String(key), res)),
    match: (key: string) => Promise.resolve(store.get(String(key))?.clone()),
  };
  const caches = {
    open: () => Promise.resolve(cache),
    delete: () => Promise.resolve(void (deleted++, store.clear())),
  };
  const fetch = (url: string) => {
    fetched.push(String(url));
    const body = bodies[String(url)];
    return Promise.resolve(
      body === undefined
        ? new Response("no", { status: 404 })
        : new Response(new Blob([body], { type: "image/png" }), {
          headers: { "Content-Type": "image/png" },
        }),
    );
  };
  const createImageBitmap = (blob: Blob) =>
    Promise.resolve({ width: blob.size, height: 2 * blob.size, close() {} });
  return {
    store,
    fetched,
    deleted: () => deleted,
    globals: { caches, fetch, createImageBitmap },
  };
}

Deno.test("expo-image: statics exist and work over the Cache API and fetch", async () => {
  Image.configureCache({ maxDiskSize: 1024 });
  assertEquals(imageCacheConfig(), { maxDiskSize: 1024 });
  assertEquals(Image.Image, ImageRef);
  const web = fakeWeb({ "https://x/a.png": "abcd", "https://x/b.png": "xy" });
  await withGlobals(web.globals, async () => {
    assert(await Image.prefetch(["https://x/a.png"], "disk"));
    assertEquals(await Image.getCachePathAsync("https://x/a.png"), "https://x/a.png");
    assertEquals(await Image.getCachePathAsync("https://x/zzz.png"), null);
    const cached = await Image.readFromCacheAsync("https://x/a.png");
    assert(cached instanceof ImageRef);
    assertEquals([cached!.width, cached!.height, cached!.mediaType], [4, 8, "image/png"]);
    await Image.writeToCacheAsync("https://x/b.png", "avatar");
    assertEquals((await Image.readFromCacheAsync("avatar"))?.width, 2);
    const ref = await Image.loadAsync({ uri: "https://x/b.png", headers: { A: "1" } });
    assertMatch(ref.uri!, /^blob:/);
    assertEquals([ref.width, ref.height, ref.isAnimated], [2, 4, false]);
    ref.release();
    assertEquals(ref.uri, null);
    await assertRejects(() => Image.loadAsync({ uri: "https://x/missing.png" }), Error, "404");
    await assertRejects(() => Image.loadAsync({}), Error, "uri");

    // A disk-policy image reads the prefetched copy.
    const { container, root } = mount(() =>
      h(Image as Any, { source: { uri: "https://x/a.png" }, cachePolicy: "disk" })
    );
    await tick();
    assertMatch(container.firstChild.getAttribute("src"), /^blob:/);
    root.unmount();

    assert(await Image.clearDiskCache());
    assertEquals(web.deleted(), 1);
    assert(await Image.clearMemoryCache());
  });
  // Without the Cache API: a memory prefetch through an image element; the disk calls answer no.
  class FakeImage {
    onload?: () => void;
    onerror?: () => void;
    set src(url: string) {
      queueMicrotask(() => url.includes("bad") ? this.onerror?.() : this.onload?.());
    }
  }
  await withGlobals({ caches: undefined, Image: FakeImage }, async () => {
    assert(await Image.prefetch("https://x/a.png"));
    assertEquals(await Image.prefetch(["https://x/a.png", "https://x/bad.png"]), false);
    assertEquals(await Image.clearDiskCache(), false);
    assertEquals(await Image.getCachePathAsync("k"), null);
    await assertRejects(() => Image.writeToCacheAsync("https://x/a.png", "k"), Error, "Cache API");
  });
});

Deno.test("expo-image: generateBlurhashAsync / generateThumbhashAsync on a canvas; useImage", async () => {
  const web = fakeWeb({ "https://x/p.png": "12345678" });
  const pixels = image(8, 16, () => [10, 200, 30, 255]).rgba;
  class OffscreenCanvas {
    constructor(public width: number, public height: number) {}
    getContext() {
      return {
        drawImage() {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(pixels.slice(0, w * h * 4)),
        }),
      };
    }
  }
  await withGlobals({ ...web.globals, OffscreenCanvas }, async () => {
    const hash = await Image.generateBlurhashAsync("https://x/p.png", [3, 3]);
    assert(isBlurhashValid(hash!), String(hash));
    const thumb = await Image.generateThumbhashAsync("https://x/p.png");
    const decoded = thumbhashToRgba(Uint8Array.from(atob(thumb), (c) => c.charCodeAt(0)))!;
    assert(mean(decoded.rgba, 1) > 150, "green survives the round trip");
    let seen: ImageRef | null = null;
    function Probe() {
      seen = useImage("https://x/p.png");
      return null;
    }
    const { root } = mount(() => h(Probe as Any, null));
    await tick();
    assertEquals((seen as ImageRef | null)?.width, 8);
    root.unmount();
  });
});

// ---- expo-camera -----------------------------------------------------------------------------------

/** A fake camera: getUserMedia, one video track, and a MediaRecorder. */
function fakeCamera() {
  const calls: Array<[string, unknown]> = [];
  const track = {
    stop: () => calls.push(["stop", null]),
    getSettings: () => ({ width: 640, facingMode: "environment" }),
    getCapabilities: () => ({ width: { max: 1920 }, height: { max: 1080 }, torch: true }),
    applyConstraints: (c: unknown) => Promise.resolve(void calls.push(["constraints", c])),
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const navigator = {
    mediaDevices: {
      getUserMedia: (c: unknown) => (calls.push(["getUserMedia", c]), Promise.resolve(stream)),
      enumerateDevices: () =>
        Promise.resolve([{ kind: "videoinput", label: "Back Camera" }, { kind: "audioinput" }]),
    },
  };
  class MediaRecorder {
    static isTypeSupported = (t: string) => t.includes("avc1");
    state = "inactive";
    mimeType = "video/mp4";
    ondataavailable?: (e: unknown) => void;
    onstop?: () => void;
    onerror?: (e: unknown) => void;
    onpause?: () => void;
    onresume?: () => void;
    timeslice?: number;
    constructor(public stream: unknown) {}
    start(timeslice?: number) {
      this.state = "recording";
      this.timeslice = timeslice;
    }
    pause() {
      this.state = "paused";
      this.onpause?.();
    }
    resume() {
      this.state = "recording";
      this.onresume?.();
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["frames"]) });
      this.onstop?.();
    }
  }
  const drawn: unknown[] = [];
  const document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        setTransform: (...a: number[]) => drawn.push(["mirror", ...a]),
        drawImage: (_v: unknown, ...a: number[]) => drawn.push(["draw", ...a]),
      }),
      toDataURL: (type: string, q: number) => `data:${type};base64,QUJD${q === 1 ? "" : "LQ"}`,
    }),
  };
  return { calls, drawn, globals: { navigator, MediaRecorder, document } };
}

Deno.test("expo-camera: CameraView statics", async () => {
  const cam = fakeCamera();
  await withGlobals(cam.globals, async () => {
    assert(await CameraView.isAvailableAsync());
    assertEquals(await CameraView.getAvailableVideoCodecsAsync(), ["avc1"]);
    assertEquals(CameraView.isModernBarcodeScannerAvailable, false, "no BarcodeDetector");
  });
  assertEquals(await CameraView.isAvailableAsync(), false, "no camera at all");
  assertEquals(typeof CameraView.ConversionTables.type, "object");
  assertEquals(CameraView.defaultProps, {});
  await CameraView.dismissScanner();
  const scanner = fakePlugin(["scanBarcode"], { scanBarcode: { ScanResult: "hello", format: 0 } });
  await inShell("ios", { CapacitorBarcodeScanner: scanner.plugin }, async () => {
    assertEquals(CameraView.isModernBarcodeScannerAvailable, true);
    const seen: unknown[] = [];
    const sub = CameraView.onModernBarcodeScanned((r) => seen.push(r));
    await CameraView.launchScanner({ barcodeTypes: ["qr"] });
    assertEquals(seen, [{ type: "qr", data: "hello", raw: "hello" }]);
    sub.remove();
    await CameraView.launchScanner();
    assertEquals(seen.length, 1, "removed listeners hear nothing");
  });
  assertEquals((scanner.calls[0][1] as Any).hint, 0, "qr → the plugin's qr hint");
});

Deno.test("expo-camera: the preview takes pictures and records video through its ref", async () => {
  const cam = fakeCamera();
  await withGlobals(cam.globals, async () => {
    const ref: { current: CameraViewHandle | null } = { current: null };
    let ready = 0;
    const { container, root } = mount(() =>
      h(CameraView as Any, {
        ref,
        mode: "video",
        enableTorch: true,
        onCameraReady: () => ready++,
      })
    );
    await tick();
    assertEquals(ready, 1);
    const constraints = cam.calls.find(([m]) => m === "getUserMedia")![1] as Any;
    assertEquals(constraints, { video: { facingMode: "environment" }, audio: true });
    const video = container.firstChild.firstChild;
    assertEquals(video.tagName, "VIDEO");
    video.videoWidth = 40;
    video.videoHeight = 20;
    const picture = await ref.current!.takePictureAsync({
      base64: true,
      exif: true,
      mirror: true,
      scale: 0.5,
      quality: 0.5,
    }) as Any;
    assertEquals(picture, {
      uri: "data:image/jpeg;base64,QUJDLQ",
      width: 20,
      height: 10,
      format: "jpg",
      base64: "QUJDLQ",
      exif: { width: 640, facingMode: "environment" },
    });
    assertEquals(cam.drawn, [["mirror", -1, 0, 0, 1, 20, 0], ["draw", 0, 0, 20, 10]]);
    const pictureRef = await ref.current!.takePictureAsync({ pictureRef: true, imageType: "png" });
    assert(pictureRef instanceof PictureRef);
    assertEquals((await pictureRef.savePictureAsync({ base64: true })).base64, "QUJD");
    assertEquals(await ref.current!.getAvailablePictureSizesAsync(), ["1920x1080"]);
    assertEquals(await ref.current!.getAvailableLensesAsync(), [
      { deviceType: "videoinput", localizedName: "Back Camera" },
    ]);
    assert(ref.current!.getSupportedFeatures().toggleRecordingAsyncAvailable);
    assert(cam.calls.some(([m, c]) => m === "constraints" && (c as Any).advanced[0].torch));

    const recording = ref.current!.recordAsync({ maxDuration: 60 });
    await assertRejects(() => ref.current!.recordAsync(), Error, "already running");
    await ref.current!.toggleRecordingAsync();
    await ref.current!.toggleRecordingAsync();
    ref.current!.stopRecording();
    assertMatch((await recording)!.uri, /^blob:/);
    root.unmount();
    assert(cam.calls.some(([m]) => m === "stop"), "the track stops on unmount");
  });
});

Deno.test("expo-camera (SDK 58): onRecordingProgress while recording; no document scanner", async () => {
  assertEquals(CameraView.isDocumentScannerAvailable, false);
  assertEquals(await CameraView.scanDocumentAsync({ requestPdf: true }), null);
  const cam = fakeCamera();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await withGlobals(cam.globals, async () => {
    const ref: { current: CameraViewHandle | null } = { current: null };
    const progress: Array<{ duration: number; fileSize: number; maxDuration?: number }> = [];
    const { root } = mount(() =>
      h(CameraView as Any, { ref, onRecordingProgress: (p: Any) => progress.push(p) })
    );
    await tick();
    const recording = ref.current!.recordAsync({ maxDuration: 30, progressUpdateInterval: 0.01 });
    await wait(250);
    assert(progress.length >= 1, "reported while recording");
    assert(progress.every((p) => p.fileSize === 0 && p.maxDuration === 30 && p.duration > 0));
    await ref.current!.toggleRecordingAsync(); // pause
    const paused = progress.length;
    await wait(250);
    assertEquals(progress.length, paused, "nothing while paused");
    await ref.current!.toggleRecordingAsync(); // resume
    ref.current!.stopRecording();
    assertMatch((await recording)!.uri, /^blob:/);
    root.unmount();
  });
});

Deno.test("expo-image (SDK 58): skipOnCacheHit skips the fade for a cached image; aria-hidden", async () => {
  const web = fakeWeb({ "https://x/a.png": "abcd" });
  await withGlobals(web.globals, async () => {
    assert(await Image.prefetch(["https://x/a.png"], "disk"));
    const render = (skipOnCacheHit: string) =>
      mount(() =>
        h(Image as Any, {
          source: { uri: "https://x/a.png" },
          cachePolicy: "disk",
          transition: { duration: 150, skipOnCacheHit },
          accessibilityElementsHidden: true,
        })
      );
    const skipped = render("all");
    await tick();
    const img = skipped.container.firstChild;
    assertMatch(img.getAttribute("src"), /^blob:/);
    assertEquals(img.getAttribute("aria-hidden"), "true");
    assertEquals(img.style.getPropertyValue("transition"), "", "a disk hit does not fade");
    skipped.root.unmount();
    const memoryOnly = render("memory");
    await tick();
    const faded = memoryOnly.container.firstChild.firstChild;
    assertEquals(faded.style.getPropertyValue("transition"), "opacity 150ms ease-in-out");
    memoryOnly.root.unmount();
    assert(await Image.clearDiskCache());
  });
});

Deno.test("expo-camera: no preview → the shell's camera plugin, else a clear error", async () => {
  class FakeImage {
    naturalWidth = 0;
    naturalHeight = 0;
    onload?: () => void;
    set src(_url: string) {
      this.naturalWidth = 300;
      this.naturalHeight = 200;
      queueMicrotask(() => this.onload?.());
    }
  }
  const camera = fakePlugin(["getPhoto"], {
    getPhoto: { webPath: "capacitor://localhost/_capacitor_file_/p.jpg", format: "jpeg" },
  });
  await inShell("ios", { Camera: camera.plugin }, async () => {
    const ref: { current: CameraViewHandle | null } = { current: null };
    const errors: string[] = [];
    const { root } = mount(() =>
      h(CameraView as Any, { ref, onMountError: (e: Any) => errors.push(e.message) })
    );
    await tick();
    assertEquals(errors.length, 1, "no getUserMedia here");
    const picture = await ref.current!.takePictureAsync({ quality: 0.7 }) as Any;
    assertEquals(picture, {
      uri: "capacitor://localhost/_capacitor_file_/p.jpg",
      width: 300,
      height: 200,
      format: "jpg",
    });
    assertEquals((camera.calls[0][1] as Any).quality, 70);
    await assertRejects(() => ref.current!.recordAsync(), Error, "camera preview");
    root.unmount();
  }, { Image: FakeImage });
  const ref: { current: CameraViewHandle | null } = { current: null };
  const { root } = mount(() => h(CameraView as Any, { ref }));
  await tick();
  await assertRejects(() => ref.current!.takePictureAsync(), Error, "camera preview");
  root.unmount();
});
