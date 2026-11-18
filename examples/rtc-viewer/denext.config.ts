import type { DenextConfig } from "denext/server";

export default {
  desktop: {
    // Linux's system webview (WebKitGTK) is built without WebRTC: the Linux app embeds Chromium
    // (CEF) instead. macOS (WKWebView) and Windows (WebView2) have WebRTC, WebCodecs and WebGPU.
    backend: { linux: "cef" },
    // No title bar: the picture runs to the window's top edge (the traffic lights stay on macOS).
    titleBar: "hidden",
    window: { width: 1280, height: 720, title: "RTC viewer" },
    minSize: { width: 320, height: 180 },
    app: { name: "RTC viewer", identifier: "dev.denext.rtc-viewer" },
  },
} satisfies DenextConfig;
