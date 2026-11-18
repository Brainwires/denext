// The RTCRtpScriptTransform worker: the runtime hands it each received video frame (its RTP
// packets put back together, still compressed), and it pushes the bytes straight into the native
// viewer through FFI from this thread. The JavaScript thread of the app never sees a frame, and
// no decoded picture exists in JavaScript at all.
//
// Messages from the app: `{ library, viewer }` (which library file and viewer id to push to; sent
// again when the stream's codec changes), `{ keyFrame: true }` (ask the sender for one). To the
// app, every second: `{ stats }` (lib/pump.ts's counters).

/// <reference lib="deno.worker" />

import { type NativeBinding, openNative } from "./native.ts";
import { createPump, type ReceivedFrame } from "./pump.ts";

interface Transformer {
  readonly readable: ReadableStream<ReceivedFrame>;
  readonly options?: { receiveTimeOrigin?: number };
  sendKeyFrameRequest(): Promise<void>;
}

let binding: NativeBinding | null = null;
let libraryPath = "";
let viewer = 0;
let transformer: Transformer | null = null;

const pump = createPump({
  push: (bytes) => (binding && viewer ? binding.push(viewer, bytes) : 1),
  requestKeyFrame: () => void transformer?.sendKeyFrameRequest().catch(() => {}),
  now: () => performance.timeOrigin + performance.now(),
  get receiveTimeOrigin() {
    return transformer?.options?.receiveTimeOrigin ?? performance.timeOrigin;
  },
});

self.onmessage = (event: MessageEvent) => {
  const message = event.data as { library?: string; viewer?: number; keyFrame?: boolean };
  if (typeof message.library === "string" && message.library !== libraryPath) {
    binding?.close();
    binding = openNative(message.library);
    libraryPath = message.library;
  }
  if (typeof message.viewer === "number") viewer = message.viewer;
  if (message.keyFrame) pump.keyFrame();
};

self.addEventListener("rtctransform", async (event) => {
  transformer = (event as Event & { transformer: Transformer }).transformer;
  const reader = transformer.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pump.frame(value);
  }
});

setInterval(() => self.postMessage({ stats: pump.snapshot() }), 1000);
