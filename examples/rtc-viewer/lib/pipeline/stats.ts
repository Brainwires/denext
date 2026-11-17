// The overlay's numbers. `StatsMeter` is pure (a test feeds it times); `readInbound` reads the
// receiver's `inbound-rtp` stats for jitter and the negotiated codec.

/** One overlay reading. */
export interface StatsSnapshot {
  fps: number;
  /** Mean decode time over the window, in ms. */
  decodeMs: number;
  width: number;
  height: number;
}

/** Frames per second and mean decode time over a sliding window. */
export class StatsMeter {
  readonly #windowMs: number;
  #frames: { at: number; decodeMs: number }[] = [];
  #width = 0;
  #height = 0;

  constructor(windowMs = 1000) {
    this.#windowMs = windowMs;
  }

  /** A frame was shown at `at` (ms), `decodeMs` after it entered the decoder. */
  frame(at: number, decodeMs: number, width: number, height: number): void {
    this.#frames.push({ at, decodeMs });
    this.#width = width;
    this.#height = height;
    this.#trim(at);
  }

  /** The reading at `now` (ms). */
  snapshot(now: number): StatsSnapshot {
    this.#trim(now);
    const n = this.#frames.length;
    const decode = n ? this.#frames.reduce((sum, f) => sum + f.decodeMs, 0) / n : 0;
    return {
      fps: (n * 1000) / this.#windowMs,
      decodeMs: decode,
      width: this.#width,
      height: this.#height,
    };
  }

  #trim(now: number): void {
    const from = now - this.#windowMs;
    let drop = 0;
    while (drop < this.#frames.length && this.#frames[drop].at <= from) drop++;
    if (drop) this.#frames = this.#frames.slice(drop);
  }
}

/** The receiver's network jitter and negotiated codec, from its `inbound-rtp` report. */
export interface InboundStats {
  jitterMs: number | null;
  mimeType: string | null;
  sdpFmtpLine: string | null;
  framesDecoded: number | null;
}

/** Reads {@link InboundStats} from a stats report (pure over the report's entries). */
export function inboundFromReport(
  report: Iterable<[string, Record<string, unknown>]>,
): InboundStats {
  const byId = new Map(report);
  const inbound = [...byId.values()].find((s) => s.type === "inbound-rtp" && s.kind === "video");
  const codec = typeof inbound?.codecId === "string" ? byId.get(inbound.codecId) : undefined;
  return {
    jitterMs: typeof inbound?.jitter === "number" ? inbound.jitter * 1000 : null,
    mimeType: typeof codec?.mimeType === "string" ? codec.mimeType : null,
    sdpFmtpLine: typeof codec?.sdpFmtpLine === "string" ? codec.sdpFmtpLine : null,
    framesDecoded: typeof inbound?.framesDecoded === "number" ? inbound.framesDecoded : null,
  };
}

/** {@link InboundStats} of a receiver. */
export async function readInbound(
  receiver: RTCRtpReceiver,
): Promise<InboundStats> {
  const report = await receiver.getStats();
  return inboundFromReport(
    report as unknown as Iterable<[string, Record<string, unknown>]>,
  );
}
