// Reads the encoded frames a receiver gets, before any decoder: `RTCRtpScriptTransform` (a worker,
// the standard; Safari / WebKit) or Chromium's `createEncodedStreams()` (encoded insertable
// streams, on the page's thread). Each frame's bytes are copied out for WebCodecs, and the frame
// itself goes on to the engine's own pipeline (`passthrough`), which keeps its jitter buffer,
// NACKs and key-frame logic healthy; with `passthrough: false` the engine never sees them.

import type { FrameTap } from "./plan.ts";

/** One encoded frame, as the decoder takes it. */
export interface EncodedFrame {
  data: ArrayBuffer;
  key: boolean;
  /** From the frame's metadata where the engine gives it (`video/VP8`, …), else `null`. */
  mimeType: string | null;
  /** `performance.now()` when the page got it. */
  receivedAt: number;
}

/** A running tap. */
export interface Tap {
  /** Asks the remote sender for a key frame where the engine can (the script transform). */
  requestKeyFrame(): boolean;
  stop(): void;
}

/** The URL of the transform worker (public/rtc-transform-worker.js). */
const TRANSFORM_WORKER_URL = "/rtc-transform-worker.js";

interface EncodedVideoFrameLike {
  type?: string;
  data: ArrayBuffer;
  getMetadata(): { mimeType?: string };
}

interface EncodedStreams {
  readable: ReadableStream<EncodedVideoFrameLike>;
  writable: WritableStream<EncodedVideoFrameLike>;
}

/** Starts reading `receiver`'s encoded frames with `kind`. Call it from the `track` event. */
export function tapReceiver(
  receiver: RTCRtpReceiver,
  kind: FrameTap,
  onFrame: (frame: EncodedFrame) => void,
  options: { passthrough?: boolean } = {},
): Tap {
  const passthrough = options.passthrough ?? true;
  if (kind === "script-transform") {
    const worker = new Worker(TRANSFORM_WORKER_URL, { name: "rtc-transform" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as {
        type: string;
        data: ArrayBuffer;
        key: boolean;
        mimeType: string;
      };
      if (m.type === "frame") {
        onFrame({
          data: m.data,
          key: m.key,
          mimeType: m.mimeType,
          receivedAt: performance.now(),
        });
      }
    };
    // Typed by hand: not every DOM lib declares the script transform yet.
    const Transform = (globalThis as unknown as {
      RTCRtpScriptTransform: new (worker: Worker, options: unknown) => object;
    }).RTCRtpScriptTransform;
    (receiver as RTCRtpReceiver & { transform: object | null }).transform = new Transform(worker, {
      side: "receiver",
      passthrough,
    });
    return {
      requestKeyFrame() {
        worker.postMessage({ type: "keyframe" });
        return true;
      },
      stop() {
        worker.terminate();
      },
    };
  }

  // Chromium: the streams must be taken in the `track` event, before any frame flows.
  const streams = (receiver as unknown as { createEncodedStreams(): EncodedStreams })
    .createEncodedStreams();
  const abort = new AbortController();
  streams.readable
    .pipeThrough(
      new TransformStream<EncodedVideoFrameLike, EncodedVideoFrameLike>({
        transform(frame, controller) {
          onFrame({
            data: frame.data.slice(0),
            key: frame.type === "key",
            mimeType: frame.getMetadata().mimeType ?? null,
            receivedAt: performance.now(),
          });
          if (passthrough) controller.enqueue(frame);
        },
      }),
    )
    .pipeTo(streams.writable, { signal: abort.signal })
    .catch(() => {});
  return {
    requestKeyFrame: () => false,
    stop: () => abort.abort(),
  };
}
