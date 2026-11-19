# rtc-viewer-native — a full-screen WebRTC viewer with native decode and presentation

A denext desktop app that receives a WebRTC video stream in its own Deno process and shows it
full-screen with the lowest latency the machine allows: each compressed frame goes from the
runtime's WebRTC stack straight to a native library (Rust, `native/`), which decodes it in hardware
and draws it into a native window. JavaScript only steers (`open`, `push`, `stats`, `close`); no
decoded pixel ever passes through it. Its sibling, [`examples/rtc-viewer`](../rtc-viewer), does the
same in the page with WebCodecs; this one is for when every millisecond counts.

## Run

```sh
denext task native:build    # the native library (cargo; once, and after native/ changes)
denext task desktop         # open the app: the video full-screen (black until a sender connects)
denext task send            # in a second terminal: the runtime's fake camera over WHIP
```

`denext task send -- --codec h265` (or `vp9`) picks the codec. Without a sender, play a file:

```sh
RTCV_PLAY=native/tests/fixtures/h264.bin denext task desktop   # or an Annex B .h264 / .h265
```

The tray icon is the way back from full-screen: video full-screen / in a window / hidden, show the
controls, quit. Other settings are environment variables read by `desktop.ts`: `RTCV_PORT` (the WHIP
port, 8189), `RTCV_DISPLAY` (display index, 0 is the main one), `RTCV_WINDOWED=1`, `RTCV_OPEN=0` (no
video window at launch), `RTCV_LOG_STATS=1` (stats on stdout every 2 s), `RTCV_NATIVE_LIB` (the
library's path).

**Runtime:** receiving WebRTC needs denext's Deno runtime **3.0.0-denext.26** or later (encoded
frames through `RTCRtpScriptTransform`, and the fake camera behind `DENO_FAKE_MEDIA_DEVICES=1`). On
an older runtime the app says so on its control page and file playback still works. The native
library needs a Rust toolchain to build (`rustup`, Rust 1.88+).

## How it works

```
sender (any WHIP client: scripts/send.ts, OBS, GStreamer, a browser)
  │  POST /whip (SDP offer)  →  201 + SDP answer           RTP over UDP (loopback by default)
  ▼                                                         │
┌───────────────────────── the app's Deno process ─────────┼──────────────────────────────────┐
│ lib/receiver.ts  WHIP endpoint (Deno.serve, 127.0.0.1)    ▼                                  │
│ RTCPeerConnection ── receiver.transform = RTCRtpScriptTransform(worker)                      │
│                          │ RTCEncodedVideoFrame (one compressed frame, a few KB)             │
│                          ▼                                                                   │
│ lib/receive-worker.ts  (its own thread)  ── rtcv_push(id, bytes) ── FFI ──┐                  │
│                                                                           │                  │
│ desktop/rtc-viewer.ts  (extension: open / hide / stats / status) ─────────┤                  │
│        ▲  token-gated bridge                                              │                  │
└────────┼──────────────────────────────────────────────────────────────────┼──────────────────┘
         │                                                                  ▼
  control page (app/, WebView)                         native/ (librtcviewer, Rust)
  buttons + stats, no video                            ├ VideoToolbox decode (async, real-time)
                                                       │   └ CVPixelBuffer (IOSurface, NV12)
                                                       ├ mailbox: newest picture wins
                                                       └ render thread: Metal, Y'CbCr → RGB
                                                           └ CAMetalLayer in its own NSWindow
                                                             (opened on the UI thread through
                                                              Deno.desktop.runOnMainThread)
```

- **Receive.** `lib/receiver.ts` is a WHIP endpoint
  ([RFC 9725](https://www.rfc-editor.org/rfc/rfc9725)): the sender posts an offer, gets a complete
  answer (no trickle), and a `DELETE` ends the session. One stream at a time; a new offer replaces
  the old. The answer offers only what the library decodes (H.265, H.264, VP9 — in that order), and
  the negotiated codec switches the viewer's decoder in place.
- **Hand-off.** The receiver's frames go to an `RTCRtpScriptTransform` worker
  (`lib/receive-worker.ts`), which calls the library's `rtcv_push` through FFI on its own thread.
  The bytes are copied once, into the decoder's buffer. The app's JavaScript thread never touches a
  frame. When the decoder has no key frame to start from, the worker asks the sender for one
  (`sendKeyFrameRequest`, rate-limited).
- **Decode.** VideoToolbox, asynchronous with the real-time hint: `rtcv_push` returns as soon as the
  frame is queued. H.264 / H.265 parameter sets make the format description (a resolution change
  makes a new session); VP9 uses the supplemental decoder. Output is an IOSurface-backed NV12
  `CVPixelBuffer`, which is never copied.
- **Present.** A render thread takes the newest decoded picture (a one-slot mailbox: a picture the
  decoder replaces before it is drawn is dropped and counted, never queued — a queue adds a frame of
  latency per frame it holds), maps its two planes as Metal textures through a
  `CVMetalTextureCache`, converts Y'CbCr to RGB (BT.601 / 709 / 2020, video or full range, from the
  picture's attachments) in one full-screen triangle letterboxed to its aspect, and presents into a
  `CAMetalLayer` with `displaySyncEnabled = false` and two drawables.
- **Windows.** AppKit belongs to the UI thread. The library queues an open / close and the app runs
  it there with `Deno.desktop.runOnMainThread(rtcv_main_fn(), id)`. Full-screen is a borderless
  window covering the display above the menu bar (no Space switch, appears at once, scanned out
  directly when opaque and covering the display), shown without activating the app, so it takes no
  keyboard focus.
- **Safety at the boundary.** Viewers are ids in a registry, not pointers: a worker pushing to a
  viewer the app just closed gets `-1`, never a use-after-free. Nothing panics across the C ABI.

### Choices

- **FFI, not a Node-API addon.** The ABI is a dozen C functions over integers and byte buffers,
  which `Deno.dlopen` calls with no glue (a `buffer` argument passes a `Uint8Array`'s bytes without
  a copy). The same library is opened from the transform worker, and `runOnMainThread` takes a C
  function pointer, which the library hands out. Node-API would add a JS-object layer, an npm-style
  build and a `.node` file for nothing this API needs.
- **A desktop extension for the controls.** `defineDesktopExtension` gives the page a token-gated,
  schema-checked bridge to the backend: the page can open, hide and read stats, and nothing else.
  Frames never cross it on the streaming path.
- **`CAMetalLayer`, not `AVSampleBufferDisplayLayer`.** Both can show a `CVPixelBuffer` with no
  copy. The Metal layer was picked for control and measurement: with display sync off and two
  drawables, a picture goes to the compositor the moment it is drawn; and each drawable reports when
  it actually reached the glass (`presentedTime`), so `stats().present` is a measured number.
  `AVSampleBufferDisplayLayer` schedules display itself and reports no per-frame display time, so
  its latency could only be estimated. The design is also the same on every OS (decoder → GPU
  texture → swap chain), which is what the Windows and Linux backends below need. A head-to-head on
  the glass (a photodiode or a high-speed camera on a real display) is still to be done.

## The JavaScript API (control only)

`lib/viewer.ts` over `lib/native.ts`'s binding:

```ts
import { findLibrary, openNative } from "./lib/native.ts";
import { NativeViewer } from "./lib/viewer.ts";
import { desktopMainThread } from "./lib/main-thread.ts";

const binding = openNative(
  findLibrary({ execPath: Deno.execPath(), cwd: Deno.cwd(), os: Deno.build.os })!,
);
const viewer = NativeViewer.create(binding, desktopMainThread()!, "h264");
await viewer.open({ fullscreen: true, display: 0 }); // the native window, on the UI thread
viewer.push(encodedFrame); // an RTCEncodedVideoFrame, or its bytes: "queued" | "waiting-for-key-frame"
viewer.stats(); // { decoded, presented, dropped, decode, present, total: { p50, p95, max, … }, … }
await viewer.close(); // closes the window, frees the decoder
```

`open` again with other options moves the window; `hide()` closes it but keeps decoding;
`setCodec()` switches decoders in place. Errors are `ViewerError`s with a code (`unsupported-codec`,
`not-main-thread`, `no-device`, …). The page reaches the same through the `rtcviewer` extension
(`app/viewer-client.ts`).

## Latency

Measured on a Mac mini (Apple M5 Pro, macOS 27.2), the fake camera's own clips (640×480, 30 fps),
paced at their real rate, hardware decode, the Metal presenter drawing into an offscreen 1920×1080
target (`denext task native:measure -- <codec> 10`; 300 frames each):

| ms, p50 / p95 / max | push → decoded     | decoded → GPU done | push → GPU done    |
| ------------------- | ------------------ | ------------------ | ------------------ |
| H.264               | 1.03 / 1.29 / 43.9 | 0.99 / 1.30 / 4.06 | 2.02 / 2.53 / 48.0 |
| H.265               | 0.86 / 1.01 / 49.0 | 0.97 / 1.22 / 4.04 | 1.84 / 2.13 / 53.0 |
| VP9                 | 1.03 / 1.22 / 46.8 | 0.97 / 1.22 / 3.95 | 2.00 / 2.38 / 50.7 |

The max is the first frame (the decoder session starts on it). The whole app, in a macOS 26.6 guest
(Apple Virtualization, 4 vCPU, its virtual display), full-screen and windowed, playing the H.264 /
H.265 clips through the real window: push → decoded 1.45 / 2.73 ms (H.264) and 0.96 / 2.03 ms
(H.265) p50 / p95, push → GPU done 2.7 / 4.9 ms and 1.9 / 3.9 ms, about 1% of frames replaced in the
mailbox at start-up.

What the viewer adds to glass-to-glass latency is push → GPU done plus the compositor's wait for the
display's next refresh: at most one refresh (16.7 ms at 60 Hz, 8.3 ms at 120 Hz), less when a
full-screen opaque window is scanned out directly. On a real display `stats().total` measures it to
the glass (the drawable's `presentedTime`); a virtual display reports no glass time, so there those
frames are counted in `presentedUntimed` and timed at GPU completion. Glass-time numbers on hardware
and the WebRTC hand-off (`stats().transport.handoffMean`: the frame reassembled in the runtime →
`rtcv_push`) need a real display and runtime 3.0.0-denext.26; they are not in this table yet.

## When to pick this over `examples/rtc-viewer`

Pick **rtc-viewer-native** when:

- latency is the point (remote desktop, game streaming, cameras for a live operator, cloud
  rendering): no page compositing, no `VideoFrame` → canvas path, a swap chain with display sync
  off, and the newest picture always wins;
- the window is a dedicated full-screen surface (a kiosk, a monitor wall, a second display);
- the app needs numbers it can trust: per-frame decode and present latency from the platform;
- it must decode what the page's engine can't (HEVC in a WebView that has no HEVC WebCodecs).

Pick **rtc-viewer** (in the page) when the video is part of a UI (overlays, chat, layout, CSS), when
it must also run in a browser or on mobile, when native code and a Rust toolchain are a cost you
don't want, or when tens of milliseconds don't matter.

## Status by OS

| OS      | Status                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | **Works.** H.264, H.265 and VP9 decoded in hardware (AV1: the runtime delivers no AV1 frames, no depacketizer; VP8: no VideoToolbox decoder), Metal presentation full-screen or windowed, any display.                                                                                                                                                                        |
| Windows | **Designed, not built** (`native/src/platform/windows.rs`): a Media Foundation decoder MFT on D3D11 (`CODECAPI_AVLowLatencyMode`, NV12 textures), `ID3D11VideoProcessor` into a DXGI flip-model swap chain (`FLIP_DISCARD`, 2 buffers, max frame latency 1, tearing allowed), present times from `GetFrameStatistics`. The library builds and reports `unsupported-platform`. |
| Linux   | **Designed, not built** (`native/src/platform/linux.rs`): VA-API decode (`cros-codecs`' stateless decoders), the surface exported as DMA-BUF and imported into Vulkan with a `VkSamplerYcbcrConversion`, a `MAILBOX` / `IMMEDIATE` swap chain, present times from `VK_KHR_present_wait` / `wp_presentation`. Builds; `unsupported-platform`.                                  |

Each backend implements the same small surface (`native/src/platform/mod.rs`): a `Decoder` that
calls back with decoded pictures, a `Presenter` with a render thread over the shared mailbox, a
clock and a `Frame`. The viewer core, the C ABI, the stats and every line of JavaScript are shared.

## Permissions

`desktop.extraPermissions` (least privilege, `denext.config.ts`): `ffi: ["*"]` (the library: FFI is
full trust, so a path scope adds nothing, and the library's path differs between `desktop run` and a
packaged app), `net: ["127.0.0.1"]` (the WHIP listener and WebRTC's UDP sockets, loopback only; a
sender on another machine needs `0.0.0.0`, its address and `sys: ["networkInterfaces"]`), and `env`
for the `RTCV_*` variables. A packaged app carries the library in `Contents/Frameworks/` (macOS) or
beside its executable.

## Tests

```sh
denext task native:test   # cargo test: Annex B / VP9 / colour / stats / mailbox units, and decode
                          # round trips of the fake camera's H.264, H.265 and VP9 clips through
                          # VideoToolbox and the Metal presenter (headless, offscreen)
denext task test          # the JS control API on the built library through FFI (headless)
deno test -A tests/rtc-viewer-native.test.ts   # from the repo root: the control API, WHIP, SDP,
                                               # the worker's pump and file clips, on fakes
```

None of them opens a window. `native/tests/fixtures/*.bin` are the Deno runtime's fake-camera clips
(`ext/webrtc/fake_media/`, MIT), the exact bytes a `DENO_FAKE_MEDIA_DEVICES=1` sender puts on the
wire.

## Files

- `desktop.ts` — the entry: the WHIP endpoint, the video window at launch, the tray.
- `desktop/rtc-viewer.ts` — the `rtcviewer` extension the page calls.
- `lib/` — `native.ts` (FFI binding), `viewer.ts` (control API), `receiver.ts` (WHIP),
  `receive-worker.ts` + `pump.ts` (the transform worker), `sdp.ts`, `clip.ts`, `app.ts` (glue).
- `app/` — the control page. `scripts/send.ts` — the WHIP sender.
- `native/` — the Rust library: `src/ffi.rs` (C ABI), `src/viewer.rs` (core),
  `src/platform/{macos,windows,linux}`, `tests/decode.rs`, `examples/measure.rs`.
