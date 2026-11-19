# RTC viewer (web pipeline)

A full-screen WebRTC video viewer written once for the web, the desktop (a Deno Desktop window) and
mobile (a Capacitor shell on iOS and Android). The page receives the stream with the engine's own
`RTCPeerConnection`, takes the encoded frames before the engine decodes them, decodes them with
WebCodecs and draws them with WebGPU and a WGSL shader. Every stage has a web-standard fallback, and
the stats overlay names the one in use.

A sibling example, [`rtc-viewer-native`](../rtc-viewer-native/), does the same with native code;
[when to choose which](#this-or-the-native-viewer) is at the end.

## Run it

```sh
# from this directory
denext task dev                 # http://127.0.0.1:3000
```

Open two tabs:

- `http://127.0.0.1:3000/send`: the sender. Pick the test pattern (a canvas) or the camera, and
  optionally a codec, then **Start sending**.
- `http://127.0.0.1:3000/`: the viewer. **Full screen** (or F, or a double click) and **Stats** (or
  S).

Both default to the room `demo`; `?room=<name>` picks another. A viewer that joins late, reloads or
loses its decoder gets a fresh connection, so any number of viewers come and go.

### The CLI sender

```sh
denext task send                                    # → http://127.0.0.1:3000, room "demo"
denext task send --size 640x360 --fps 15 --room lab
denext task send --url http://192.168.1.20:3000 --ice stun:stun.l.google.com:19302
```

`cli/send.ts` is a plain Deno program: it joins the room through the same hub and sends with the
runtime's WebRTC (denext's Deno has `RTCPeerConnection` and `Deno.webrtc`). Its source:

| `--source`       | What it sends                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | the camera when the runtime has one, else the pattern                                                                                                                                                                                                                                                                |
| `camera`         | `navigator.mediaDevices.getUserMedia()`. With `DENO_FAKE_MEDIA_DEVICES=1` this is the runtime's fake camera, which **needs runtime `3.0.0-denext.26`** or later; on an older runtime `--source camera` stops and says so                                                                                             |
| `pattern`        | colour bars with a moving square, encoded in `cli/h264.ts` as H.264 I_PCM (raw macroblocks: no codec library, every decoder takes it) and written to a `Deno.webrtc.EncodedMediaTrack`. Works on the pinned runtime today. Large frames (≈1.5 bytes a pixel), so keep it small: 320x180 at 15 fps is about 10 Mbit/s |

`deno task send` grants `--allow-sys=networkInterfaces`, so the CLI offers its LAN addresses and a
browser on this or another machine reaches it. On a machine where nothing may listen beyond
loopback, run it with `DENO_WEBRTC_LOOPBACK_ONLY=1`; then only a peer on the same machine that also
offers loopback candidates (another Deno program, or Chromium with
`--allow-loopback-in-peer-connection`) can connect.

## The pipeline

```
sender ──WebRTC──▶ RTCPeerConnection ──▶ encoded-frame tap ──▶ WebCodecs VideoDecoder ──▶ WebGPU
 (page or CLI)       (the engine's)       (worker or streams)    (hardware first)          (WGSL)
```

| Stage          | What runs                                                                                                                                                                                                                                                                                                                                                        | Code                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Signalling     | `GET /api/signal?room=&id=&role=` is a server-sent-events stream (welcome, join, leave, message); `POST /api/signal?room=` relays one message, signed with the token the stream's welcome gave. The sender offers to each viewer; the viewer answers. In memory, one instance                                                                                    | `lib/signal/`, `app/api/signal/route.ts`, `lib/rtc/peers.ts` |
| Receive        | the engine's `RTCPeerConnection`                                                                                                                                                                                                                                                                                                                                 | `lib/rtc/peers.ts`                                           |
| Encoded frames | `RTCRtpScriptTransform` in a worker (Safari / WebKit, and Chromium and Firefox where they have it), else Chromium's encoded insertable streams (`createEncodedStreams`, with `encodedInsertableStreams: true`). Both feature-detected. Each frame's bytes are copied for WebCodecs and the frame goes on to the engine (`?passthrough=0` drops it there instead) | `public/rtc-transform-worker.js`, `lib/pipeline/tap.ts`      |
| Decode         | `VideoDecoder` with `hardwareAcceleration: "prefer-hardware"` and `optimizeForLatency`; the codec string comes from the frame's metadata or the negotiated codec (VP8, VP9, H.264, H.265, AV1). Delta frames wait for a key frame; one that is overdue is asked for (`sendKeyFrameRequest`), or the viewer asks the sender for a fresh connection                | `lib/pipeline/decoder.ts`, `lib/pipeline/codec.ts`           |
| Display        | each `VideoFrame` → `importExternalTexture`, sampled with `textureSampleBaseClampToEdge`: the YUV → RGB conversion is the external texture's, with the frame's colour space, and no copy. A uniform scales the quad to fit the picture's aspect ratio. The newest frame is drawn once per display refresh; older ones are closed                                 | `lib/pipeline/shaders.ts`, `lib/pipeline/render-webgpu.ts`   |
| Overlay        | fps, decode time, resolution, network jitter (`inbound-rtp`), codec and acceleration, and the pipeline with any fallback                                                                                                                                                                                                                                         | `app/viewer.tsx`, `lib/pipeline/stats.ts`                    |
| Full screen    | desktop: `setFullScreen` from `denext/desktop/window`, in a window with a hidden title bar (`desktop.titleBar`); mobile: the system bars hidden (`setSystemBars`, immersive mode) on a page laid out to the safe-area insets (`viewport-fit=cover` + `env(safe-area-inset-*)`); web: the Fullscreen API                                                          | `lib/fullscreen.ts`                                          |

### Fallbacks

`lib/pipeline/plan.ts` picks the pipeline from what the engine has (a pure function, unit tested):

| The engine lacks                         | The viewer uses                                   |
| ---------------------------------------- | ------------------------------------------------- |
| nothing                                  | tap → WebCodecs → WebGPU                          |
| `RTCRtpScriptTransform`                  | Chromium's encoded insertable streams for the tap |
| WebGPU (no adapter, or the device fails) | WebGL2: `texImage2D(VideoFrame)`, same fit        |
| WebGPU and WebGL2                        | a plain `<video>` with the remote track           |
| WebCodecs, or any encoded-frame access   | a plain `<video>` with the remote track           |
| WebRTC                                   | nothing to show; the overlay says so              |

`?renderer=webgl2` or `?renderer=video` forces a step down, to try a fallback on a full engine;
`?tap=encoded-streams` uses Chromium's insertable streams where it also has the script transform.

## Targets

| Target                 | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web                    | `denext task dev` / `build` / `start`. Chromium and Safari 26 run the full pipeline; Firefox has WebCodecs and the script transform, and WebGPU where it has shipped it                                                                                                                                                                                                                                                                                                                                                                                           |
| Desktop (Deno Desktop) | `denext task desktop:dev` (the window on the dev server) or `denext task desktop` (the static export). The packaged app serves the hub from its own backend (`desktop.ts`), so its viewer and sender pages meet there; a sender elsewhere needs a hub both reach (`?signal=`, below). macOS (WKWebView) and Windows (WebView2) have WebRTC, WebCodecs and WebGPU                                                                                                                                                                                                  |
| Linux desktop          | WebKitGTK, Linux's system webview, is built without WebRTC, so `denext.config.ts` sets `desktop.backend: { linux: "cef" }`: the Linux app embeds Chromium                                                                                                                                                                                                                                                                                                                                                                                                         |
| Mobile (Capacitor)     | `capacitor.config.json` points the shell at the static export (`out/`). Add the shell once: `npm init -y && npm install -D @capacitor/cli@8 && npm install @capacitor/core@8 @capacitor/ios@8 @capacitor/android@8`, `denext task export`, `npx cap add ios` / `npx cap add android`, then `denext mobile add system-bars keep-awake` (immersive mode, the screen kept on). `denext task mobile:dev` runs the app on a phone against `denext dev` on your LAN, same origin; a release build points `server.url` at the deployed app, or the page takes `?signal=` |
| iOS                    | WebGPU from iOS 26; below that the viewer draws with WebGL2. WebCodecs' `VideoDecoder` (iOS 16.4+) and `RTCRtpScriptTransform` (iOS 15.4+) give the tap and the decoder on any current iOS. No element full screen on iPhone: the shell hides the status bar instead                                                                                                                                                                                                                                                                                              |
| Android                | the system WebView (Chromium): the full pipeline on devices with a WebGPU-capable GPU, else WebGL2                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

A page whose hub is on another origin takes `?signal=https://host:3000` (the hub URL, or an origin
for its `/api/signal`). The hub answers CORS only for its own origin, the Capacitor shells'
(`capacitor://localhost`, `https://localhost`) and `RTC_SIGNAL_ORIGINS` (comma separated); the
page's CSP allows `connect-src 'self'` by default, so add the hub to `csp.connectSrc` for a
cross-origin one.

## Tests

From the repository root (they run in the unit suite):

```sh
denext test tests/rtc-viewer-example.test.ts tests/rtc-viewer-webrtc.test.ts
```

- `rtc-viewer-example.test.ts`: the hub (relay, tokens, caps, CORS, a dropped stream), the route
  handler through `createTestApp`, every page through `probeApp` (`deno task probe` here), the
  fallback selection, codec strings, the overlay's numbers, the aspect fit, the full-screen method
  and the CLI's arguments.
- `rtc-viewer-webrtc.test.ts`: the H.264 encoder parsed back bit by bit; the WGSL compiled on Deno's
  WebGPU and drawn to check the letterbox (Deno's WebGPU has no external textures, so the test
  compiles the same shader over a `texture_2d<f32>`; skipped without an adapter); and the CLI's
  pattern track sent over a real WebRTC connection on loopback to a Deno viewer, depacketized and
  compared with the encoder's output.

What needs a browser or a device: the encoded-frame taps, WebCodecs and the WebGPU / WebGL2
renderers run only in an engine (headless Chromium covers the Chromium paths; Safari's script
transform, iOS and Android need the real thing), and so do the desktop window's and the shell's full
screen.

## This or the native viewer

Choose this one when the engines you target have the pieces (desktop Chromium and WebKit, Safari 26
and later, Android's WebView) and you want one code base: the pipeline is web standards, it ships
over the air with the rest of the UI, and it falls back by itself on an engine that lacks a stage.
Choose [`rtc-viewer-native`](../rtc-viewer-native/) when you need what the page cannot reach: the
platform decoder's lowest latency and zero-copy display, codecs or protected streams the engine does
not decode, background playback and picture in picture as the OS does them, or Linux without
embedding Chromium.
