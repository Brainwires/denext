// The control API (lib/viewer.ts) on the BUILT native library through Deno FFI, headless:
// `denext task test` (builds native/ first). The fake camera's H.264 clip goes through
// `NativeViewer.push` → `rtcv_push` → VideoToolbox, then the Metal presenter into an offscreen
// target; `open` is driven through `rtcv_main` called from this (non-UI) thread, which the library
// must refuse without touching AppKit. No window is opened.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { findLibrary, openNative, STAT_FIELDS } from "../lib/native.ts";
import { NativeViewer, ViewerError } from "../lib/viewer.ts";

const root = fromFileUrl(new URL("..", import.meta.url));
const path = findLibrary({ execPath: Deno.execPath(), cwd: root, os: Deno.build.os });

/** The clip's `<u32 little-endian length><frame>` records. */
function frames(name: string): Uint8Array[] {
  const blob = Deno.readFileSync(`${root}/native/tests/fixtures/${name}`);
  const view = new DataView(blob.buffer);
  const out: Uint8Array[] = [];
  for (let at = 0; at + 4 <= blob.length;) {
    const len = view.getUint32(at, true);
    out.push(blob.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  return out;
}

/** `void* fn(void*)`, as Deno FFI declares it. */
const MAIN_FN = { parameters: ["pointer"], result: "pointer" } as const;

/** Calls the native `void* fn(void*)` right here, as a stand-in for the UI thread. */
const callHere = (fn: Deno.PointerValue, context: Deno.PointerValue) => {
  const pointer = fn as Deno.PointerObject<typeof MAIN_FN>;
  const result = new Deno.UnsafeFnPointer(pointer, MAIN_FN).call(context);
  return Promise.resolve(BigInt(Deno.UnsafePointer.value(result)));
};

async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

Deno.test({
  name: "rtc-viewer-native ffi: H.264 frames decode and present, natively",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    assert(path, "build the library first: denext task native:build");
    const binding = openNative(path);
    try {
      const viewer = NativeViewer.create(binding, callHere, "h264", { inspect: true });
      assertEquals(binding.startOffscreen(viewer.id, 1280, 720), 0);
      for (const frame of frames("h264.bin")) {
        assertEquals(viewer.push(frame), "queued");
        assertEquals(binding.flush(viewer.id), 0);
        const decoded = viewer.stats().decoded;
        await until(() => viewer.stats().presented === decoded);
      }
      const stats = viewer.stats();
      assertEquals([stats.pushed, stats.decoded, stats.presented], [30, 30, 30]);
      assertEquals([stats.width, stats.height], [640, 480]);
      assert(stats.lumaMean > 40 && stats.lumaMean < 220, `luma ${stats.lumaMean}`);
      assert(stats.total.max > 0 && stats.total.max < 1000);
      assertEquals(binding.stopOffscreen(viewer.id), 0);

      // Window work off the UI thread: refused by the library, reported as such.
      const err = await assertRejects(() => viewer.open(), ViewerError);
      assertEquals(err.code, "not-main-thread");
      assertEquals(viewer.window, null);

      // Switch codec in place, then a stale id after close is refused (no use-after-free).
      viewer.setCodec("h265");
      assertEquals(viewer.push(frames("h265.bin")[0]), "queued");
      const id = viewer.id;
      await viewer.close();
      assertEquals(binding.push(id, frames("h264.bin")[0]), -1);
      assertEquals(binding.create(4, 0), -2); // AV1: no decoder
    } finally {
      binding.close();
    }
  },
});

Deno.test({
  name: "rtc-viewer-native ffi: the library speaks this ABI",
  ignore: Deno.build.os !== "darwin",
  fn() {
    assert(path, "build the library first: denext task native:build");
    const lib = Deno.dlopen(
      path,
      {
        rtcv_abi_version: { parameters: [], result: "u32" },
        rtcv_stat_count: { parameters: [], result: "u32" },
      } as const,
    );
    try {
      assertEquals(lib.symbols.rtcv_stat_count(), STAT_FIELDS.length);
      assertEquals(lib.symbols.rtcv_abi_version(), 1);
    } finally {
      lib.close();
    }
  },
});
