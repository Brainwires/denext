// What the transform's worker does with each received frame (receive-worker.ts is the thin shell
// around this, so it is tested without a peer connection): push it to the native viewer, ask the
// sender for a key frame when the decoder has nothing to start from, and measure the hand-off
// (the frame's reassembly in the runtime → the native push).

/** A received frame, as the transformer's readable gives it (`RTCEncodedVideoFrame`). */
export interface ReceivedFrame {
  readonly data: ArrayBuffer;
  readonly type?: string;
  getMetadata?(): { readonly receiveTime?: number; readonly mimeType?: string };
}

/** What the pump calls. */
export interface PumpDeps {
  /** The native push: 0 queued, 1 waiting for a key frame, negative an error (`rtcv_push`). */
  push(bytes: Uint8Array): number;
  /** `transformer.sendKeyFrameRequest()`. */
  requestKeyFrame(): void;
  /** Milliseconds since the epoch, sub-millisecond (`performance.timeOrigin + performance.now()`). */
  now(): number;
  /**
   * The window realm's `performance.timeOrigin`: a frame's `receiveTime` is that realm's
   * `performance.now()` when the runtime reassembled it.
   */
  readonly receiveTimeOrigin: number;
  /** The least time between two key frame requests, in ms. Default 500. */
  readonly keyFrameIntervalMs?: number;
}

/** The pump's counters, posted to the app every second. */
export interface PumpStats {
  readonly frames: number;
  readonly bytes: number;
  readonly skipped: number;
  readonly refused: number;
  readonly keyFrameRequests: number;
  /** Reassembled → pushed, in ms: mean and max over the frames since the last snapshot. */
  readonly handoffMean: number;
  readonly handoffMax: number;
}

export interface Pump {
  /** Handles one frame. */
  frame(frame: ReceivedFrame): void;
  /** Asks for a key frame now (rate-limited). */
  keyFrame(): void;
  /** The counters; the hand-off window restarts. */
  snapshot(): PumpStats;
}

export function createPump(deps: PumpDeps): Pump {
  const interval = deps.keyFrameIntervalMs ?? 500;
  let frames = 0;
  let bytes = 0;
  let skipped = 0;
  let refused = 0;
  let keyFrameRequests = 0;
  let lastRequest = -Infinity;
  let handoffSum = 0;
  let handoffCount = 0;
  let handoffMax = 0;

  const keyFrame = () => {
    const now = deps.now();
    if (now - lastRequest < interval) return;
    lastRequest = now;
    keyFrameRequests++;
    try {
      deps.requestKeyFrame();
    } catch {
      // The transform is gone (the connection closed): nothing to ask.
    }
  };

  return {
    frame(frame) {
      if (frame.type === "empty" || frame.data.byteLength === 0) {
        skipped++;
        return;
      }
      const result = deps.push(new Uint8Array(frame.data));
      if (result < 0) {
        refused++;
        return;
      }
      frames++;
      bytes += frame.data.byteLength;
      const receiveTime = frame.getMetadata?.().receiveTime;
      if (typeof receiveTime === "number") {
        const handoff = deps.now() - (deps.receiveTimeOrigin + receiveTime);
        if (handoff >= 0 && Number.isFinite(handoff)) {
          handoffSum += handoff;
          handoffCount++;
          handoffMax = Math.max(handoffMax, handoff);
        }
      }
      if (result === 1) keyFrame();
    },
    keyFrame,
    snapshot() {
      const out: PumpStats = {
        frames,
        bytes,
        skipped,
        refused,
        keyFrameRequests,
        handoffMean: handoffCount ? handoffSum / handoffCount : 0,
        handoffMax,
      };
      handoffSum = 0;
      handoffCount = 0;
      handoffMax = 0;
      return out;
    },
  };
}
