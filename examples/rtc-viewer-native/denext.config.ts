import type { DenextConfig } from "denext/server";

// rtc-viewer-native: a full-screen, lowest-latency WebRTC viewer whose decoding and presentation
// are native (native/, a Rust library). The app's Deno process receives the stream (WHIP on
// loopback) and hands each compressed frame to the library through FFI; the library decodes in
// hardware and draws into its own window. The page is a small control panel.
export default {
  desktop: {
    // Every installer off: an example, packaged by hand.
    installers: { macos: [], linux: [], windows: [] },
    app: {
      name: "RTC Viewer Native",
      identifier: "dev.denext.rtcviewernative",
    },
    // The control panel. The video has a window of its own (native/src/platform/macos/window.rs).
    window: { width: 460, height: 640, title: "RTC Viewer (native)" },
    minSize: { width: 380, height: 420 },
    // Full-screen video covers the control panel on its display: the tray is the way back.
    tray: {
      icon: "/tray.png",
      tooltip: "RTC Viewer",
      menu: [
        { id: "fullscreen", label: "Video full screen" },
        { id: "windowed", label: "Video in a window" },
        { id: "hide", label: "Hide video" },
        { separator: true },
        { id: "controls", label: "Show controls" },
        { id: "quit", label: "Quit" },
      ],
    },
    capabilities: {
      // The backend: the native viewer, the WHIP endpoint and the transform worker.
      extensions: ["./desktop/rtc-viewer.ts"],
    },
    extraPermissions: {
      // The native library (native/): FFI is full trust, so a path scope would add nothing; the
      // library's location also differs between `desktop run` and a packaged app.
      ffi: ["*"],
      // WHIP and WebRTC on loopback only: the WHIP listener, and ICE's UDP sockets, which bind
      // 127.0.0.1 and reach the sender's loopback candidates. (A sender on another machine needs
      // `0.0.0.0`, its address and `sys: ["networkInterfaces"]` here.)
      net: ["127.0.0.1"],
      // RTCV_*: the port, display and window options desktop.ts reads, and the library override.
      env: [
        "RTCV_PORT",
        "RTCV_DISPLAY",
        "RTCV_WINDOWED",
        "RTCV_OPEN",
        "RTCV_NATIVE_LIB",
        "RTCV_PLAY",
        "RTCV_LOG_STATS",
      ],
    },
  },
} satisfies DenextConfig;
