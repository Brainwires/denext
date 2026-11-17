// The `rtcviewer` desktop extension (`desktop.capabilities.extensions`): it runs in the app's Deno
// process and the page reaches it through the token-gated bridge (`desktopExtension("rtcviewer")`,
// app/viewer-client.ts). The page only controls: open / hide the video window, read status and
// stats. Frames never cross the bridge on the streaming path (the transform worker pushes them
// natively); `push` is here for a page that has encoded frames of its own (base64, one per call).

import { defineDesktopExtension, DesktopCapError } from "denext/desktop";
import { AppError, ViewerApp, type WebRtcDeps } from "../lib/app.ts";
import { desktopMainThread } from "../lib/main-thread.ts";
import { type CodecName, CODECS, findLibrary, openNative } from "../lib/native.ts";
import type { PeerLike } from "../lib/receiver.ts";
import { ViewerError } from "../lib/viewer.ts";

let app: ViewerApp | undefined;

/** The runtime's WebRTC with encoded transforms, or null (runtime 3.0.0-denext.26 has them). */
function webrtc(): WebRtcDeps | null {
  const g = globalThis as unknown as {
    RTCPeerConnection?: new () => unknown;
    RTCRtpReceiver?: { getCapabilities?(kind: string): { codecs: { mimeType: string }[] } | null };
    RTCRtpScriptTransform?: new (worker: Worker, options?: unknown) => unknown;
  };
  const { RTCPeerConnection, RTCRtpReceiver, RTCRtpScriptTransform } = g;
  if (!RTCPeerConnection || !RTCRtpScriptTransform) return null;
  return {
    peer: () => new RTCPeerConnection() as PeerLike,
    capabilities: () => RTCRtpReceiver?.getCapabilities?.("video")?.codecs ?? [],
    transform: (receiver, onMessage) => {
      const worker = new Worker(new URL("../lib/receive-worker.ts", import.meta.url).href, {
        type: "module",
      });
      worker.onmessage = (event) => onMessage(event.data);
      // The worker reads frames from here on; its `receiveTime`s are this realm's clock.
      (receiver as { transform: unknown }).transform = new RTCRtpScriptTransform(worker, {
        receiveTimeOrigin: performance.timeOrigin,
      });
      return { post: (message) => worker.postMessage(message), close: () => worker.terminate() };
    },
  };
}

/** The app's backend, made on first use. */
export function viewerApp(): ViewerApp {
  app ??= new ViewerApp({
    loadBinding: () => {
      const path = findLibrary({
        override: Deno.env.get("RTCV_NATIVE_LIB") || undefined,
        execPath: Deno.execPath(),
        cwd: Deno.cwd(),
        os: Deno.build.os,
      });
      if (!path) {
        throw new Error(
          "the native library isn't built: run `denext task native:build` (or set RTCV_NATIVE_LIB)",
        );
      }
      return openNative(path);
    },
    runOnMainThread: desktopMainThread(),
    webrtc: webrtc(),
  });
  return app;
}

function args(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
}

/** Runs `fn`, turning the app's and the viewer's refusals into bridge errors. */
async function call<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DesktopCapError) throw err;
    if (err instanceof AppError) throw new DesktopCapError(err.code, err.message);
    if (err instanceof ViewerError) throw new DesktopCapError(err.code, err.message);
    console.error("rtc-viewer-native:", err);
    throw new DesktopCapError("failed", "the viewer failed; see the app's log");
  }
}

function decodeBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default defineDesktopExtension({
  name: "rtcviewer",
  methods: {
    status: { handler: () => call(() => viewerApp().status()) },
    stats: { handler: () => call(() => viewerApp().stats()) },
    open: {
      handler: (raw: unknown) =>
        call(async () => {
          const a = args(raw);
          const display = a.display === undefined ? 0 : Number(a.display);
          if (!Number.isInteger(display) || display < 0 || display > 16) {
            throw new DesktopCapError(
              "validation",
              "display is a display index (0 is the main one)",
            );
          }
          await viewerApp().open({ fullscreen: a.fullscreen !== false, display });
          return null;
        }),
    },
    hide: {
      handler: () =>
        call(async () => {
          await viewerApp().hide();
          return null;
        }),
    },
    push: {
      handler: (raw: unknown) =>
        call(() => {
          const a = args(raw);
          const codec = a.codec as CodecName;
          if (!(codec in CODECS)) {
            throw new DesktopCapError("validation", "codec is h264, h265 or vp9");
          }
          if (typeof a.data !== "string" || a.data.length > 4 * 1024 * 1024) {
            throw new DesktopCapError("validation", "data is one base64 frame of at most 3 MB");
          }
          return viewerApp().push(codec, decodeBase64(a.data));
        }),
    },
  },
});
