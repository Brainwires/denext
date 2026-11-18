// The native library (native/, a Rust cdylib) as Deno FFI sees it: the C ABI's symbols, the
// codec numbers, the stats layout, and where the library file is found. `NativeBinding` is the
// seam the control API (viewer.ts) is written against, so its tests run on a fake.
//
// Why FFI (`Deno.dlopen`) and not a Node-API addon: the ABI is a dozen plain C functions over
// integers and byte buffers, which FFI calls with no glue (a `buffer` parameter passes a
// Uint8Array's bytes without a copy); the same library is opened from the transform's worker,
// which a Node-API addon would have to be loaded into separately anyway; there is no npm package
// or `.node` build step; and `runOnMainThread` takes a C function pointer, which the library hands
// out (`rtcv_main_fn`). Node-API would pay for a JS-object API this example doesn't need.

/** The ABI version this module speaks (`rtcv_abi_version`). */
const ABI_VERSION = 1;

/** The codecs, by the numbers the C ABI uses (native/src/codec.rs). */
export const CODECS = { h264: 1, h265: 2, vp9: 3, av1: 4, vp8: 5 } as const;
export type CodecName = keyof typeof CODECS;

/** The codec of a WebRTC MIME type (`video/H264`, `video/H265`, …), or null. */
export function codecFromMime(mime: string): CodecName | null {
  switch (mime.toLowerCase()) {
    case "video/h264":
      return "h264";
    case "video/h265":
    case "video/hevc":
      return "h265";
    case "video/vp9":
      return "vp9";
    case "video/av1":
      return "av1";
    case "video/vp8":
      return "vp8";
    default:
      return null;
  }
}

/**
 * The numbers `rtcv_stats` writes, in order: native/src/stats.rs's `FIELDS` (a test compares
 * the two lists).
 */
export const STAT_FIELDS = [
  "pushed",
  "decoded",
  "presented",
  "presentedUntimed",
  "dropped",
  "decodeErrors",
  "waitingForKey",
  "width",
  "height",
  "hardware",
  "lastStatus",
  "windowOpen",
  "decodeLast",
  "decodeMean",
  "decodeP50",
  "decodeP95",
  "decodeMax",
  "presentLast",
  "presentMean",
  "presentP50",
  "presentP95",
  "presentMax",
  "totalLast",
  "totalMean",
  "totalP50",
  "totalP95",
  "totalMax",
  "lumaMean",
  "lumaHash",
] as const;
export type StatField = typeof STAT_FIELDS[number];

/** The library's C ABI (native/src/ffi.rs). */
const NATIVE_SYMBOLS = {
  rtcv_abi_version: { parameters: [], result: "u32" },
  rtcv_stat_count: { parameters: [], result: "u32" },
  rtcv_create: { parameters: ["u32", "u32"], result: "i32" },
  rtcv_set_codec: { parameters: ["u32", "u32"], result: "i32" },
  rtcv_push: { parameters: ["u32", "buffer", "usize"], result: "i32" },
  rtcv_flush: { parameters: ["u32"], result: "i32" },
  rtcv_stats: { parameters: ["u32", "buffer", "usize"], result: "i32" },
  rtcv_request_open: { parameters: ["u32", "i32", "u32"], result: "i32" },
  rtcv_request_close: { parameters: ["u32"], result: "i32" },
  rtcv_main_fn: { parameters: [], result: "pointer" },
  rtcv_start_offscreen: { parameters: ["u32", "u32", "u32"], result: "i32" },
  rtcv_stop_offscreen: { parameters: ["u32"], result: "i32" },
  rtcv_destroy: { parameters: ["u32"], result: "i32" },
} as const satisfies Deno.ForeignLibraryInterface;

/** What the control API needs from the library: one method per C function. */
export interface NativeBinding {
  /** The file the library was opened from. */
  readonly path: string;
  /** `rtcv_create`: a viewer id (> 0) or a negative error code. */
  create(codec: number, flags: number): number;
  setCodec(id: number, codec: number): number;
  /** `rtcv_push`: 0 queued, 1 waiting for a key frame, or a negative error code. */
  push(id: number, frame: Uint8Array): number;
  flush(id: number): number;
  /** `rtcv_stats` into `out`: how many numbers were written, or a negative error code. */
  stats(id: number, out: Float64Array): number;
  requestOpen(id: number, display: number, fullscreen: boolean): number;
  requestClose(id: number): number;
  /** The address of `rtcv_main`, for `runOnMainThread`. */
  mainFn(): Deno.PointerValue;
  startOffscreen(id: number, width: number, height: number): number;
  stopOffscreen(id: number): number;
  destroy(id: number): number;
  /** Closes the library handle (the viewers stay in the process). */
  close(): void;
}

/** The library's file name on `os`. */
export function libraryFileName(os: typeof Deno.build.os = Deno.build.os): string {
  return os === "windows"
    ? "rtcviewer.dll"
    : os === "darwin"
    ? "librtcviewer.dylib"
    : "librtcviewer.so";
}

/** Where to look for the library, in order. */
export interface LibrarySearch {
  /** `RTCV_NATIVE_LIB`: an explicit path wins. */
  readonly override?: string;
  /** The running executable (`Deno.execPath()`): a packaged app carries the library beside it. */
  readonly execPath: string;
  /** The working directory (`denext desktop run` starts the app in the project). */
  readonly cwd: string;
  readonly os: typeof Deno.build.os;
}

/** The candidate paths for the library, most specific first. */
export function libraryCandidates(search: LibrarySearch): string[] {
  const name = libraryFileName(search.os);
  const sep = search.os === "windows" ? "\\" : "/";
  const join = (...parts: string[]) => parts.join(sep);
  const exeDir = search.execPath.slice(0, Math.max(0, search.execPath.lastIndexOf(sep)));
  const out: string[] = [];
  if (search.override) out.push(search.override);
  // macOS: <App>.app/Contents/MacOS/<exe> → Contents/Frameworks/; elsewhere beside the exe.
  if (search.os === "darwin") out.push(join(exeDir, "..", "Frameworks", name));
  out.push(join(exeDir, name));
  // A development build in the project (`denext task native:build`).
  out.push(join(search.cwd, "native", "target", "release", name));
  return out;
}

/** The first candidate that exists, or null. */
export function findLibrary(search: LibrarySearch): string | null {
  for (const path of libraryCandidates(search)) {
    try {
      if (Deno.statSync(path).isFile) return path;
    } catch {
      // Not there (or not readable): the next one.
    }
  }
  return null;
}

/**
 * Opens the library at `path` and checks it speaks this ABI. Needs `--allow-ffi` (the app's
 * `desktop.extraPermissions.ffi`).
 */
export function openNative(path: string): NativeBinding {
  const lib = Deno.dlopen(path, NATIVE_SYMBOLS);
  const s = lib.symbols;
  const abi = s.rtcv_abi_version();
  const fields = s.rtcv_stat_count();
  if (abi !== ABI_VERSION || fields !== STAT_FIELDS.length) {
    lib.close();
    throw new Error(
      `${path} speaks ABI ${abi} with ${fields} stats; this app needs ABI ${ABI_VERSION} with ${STAT_FIELDS.length} (rebuild native/)`,
    );
  }
  return {
    path,
    create: (codec, flags) => s.rtcv_create(codec, flags),
    setCodec: (id, codec) => s.rtcv_set_codec(id, codec),
    push: (id, frame) =>
      s.rtcv_push(id, frame as Uint8Array<ArrayBuffer>, BigInt(frame.byteLength)),
    flush: (id) => s.rtcv_flush(id),
    stats: (id, out) => s.rtcv_stats(id, out as Float64Array<ArrayBuffer>, BigInt(out.length)),
    requestOpen: (id, display, fullscreen) => s.rtcv_request_open(id, display, fullscreen ? 1 : 0),
    requestClose: (id) => s.rtcv_request_close(id),
    mainFn: () => s.rtcv_main_fn(),
    startOffscreen: (id, w, h) => s.rtcv_start_offscreen(id, w, h),
    stopOffscreen: (id) => s.rtcv_stop_offscreen(id),
    destroy: (id) => s.rtcv_destroy(id),
    close: () => lib.close(),
  };
}
