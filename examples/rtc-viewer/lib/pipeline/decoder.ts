// WebCodecs decoding of the tapped frames. Each codec is checked with `isConfigSupported` before
// it is configured: hardware decoding first (`prefer-hardware`), else whatever the engine has
// (`no-preference`), else the codec is reported unsupported. A decoder that fails while decoding
// is configured again once, without the hardware preference. Delta frames wait for a key frame
// after a (re)configure, an error or a backlog.

import type { EncodedFrame } from "./tap.ts";

/** What {@link FrameDecoder.push} did with a frame. */
export type PushResult = "decoding" | "waiting-for-key" | "dropped" | "unsupported";

/** The decoder's backlog past which delta frames are dropped until the next key frame. */
const MAX_QUEUE = 4;

/** The accelerations tried, in order. */
const ACCELERATIONS: HardwareAcceleration[] = ["prefer-hardware", "no-preference"];

/** A `VideoDecoder` that (re)configures itself for the codec of the frames it is given. */
export class FrameDecoder {
  #decoder: VideoDecoder | null = null;
  /** The codec asked for (configured, being checked, or found unsupported). */
  #codec: string | null = null;
  #state: "idle" | "checking" | "ready" | "unsupported" = "idle";
  #acceleration: HardwareAcceleration | null = null;
  /** After a decode error: skip the hardware preference from then on. */
  #softwareOnly = false;
  #needKey = true;
  #lastTimestamp = 0;
  readonly #started = new Map<number, number>();
  readonly #onFrame: (frame: VideoFrame, decodeMs: number) => void;
  readonly #onError: (message: string) => void;

  constructor(
    onFrame: (frame: VideoFrame, decodeMs: number) => void,
    onError: (message: string) => void,
  ) {
    this.#onFrame = onFrame;
    this.#onError = onError;
  }

  /** The codec string in use, once configured. */
  get codec(): string | null {
    return this.#state === "ready" ? this.#codec : null;
  }

  /** The acceleration the decoder was configured with, once configured. */
  get acceleration(): HardwareAcceleration | null {
    return this.#state === "ready" ? this.#acceleration : null;
  }

  /** Decodes `frame` as `codec` (a WebCodecs codec string; `null` when it has none). */
  push(frame: EncodedFrame, codec: string | null): PushResult {
    if (codec === null) return "unsupported";
    if (codec !== this.#codec || this.#state === "idle") this.#check(codec);
    if (this.#state === "unsupported") return "unsupported";
    // Frames that arrive while the codec is checked are dropped: a key frame starts the stream.
    if (this.#state !== "ready" || !this.#decoder) return "waiting-for-key";
    if (!frame.key) {
      if (this.#needKey) return "waiting-for-key";
      if (this.#decoder.decodeQueueSize > MAX_QUEUE) {
        this.#needKey = true;
        return "dropped";
      }
    }
    this.#needKey = false;
    // Strictly increasing microseconds from the arrival time: the output carries it back, so the
    // decode time is the output's arrival minus the input's.
    const timestamp = Math.max(this.#lastTimestamp + 1, Math.round(frame.receivedAt * 1000));
    this.#lastTimestamp = timestamp;
    this.#started.set(timestamp, performance.now());
    this.#decoder.decode(
      new EncodedVideoChunk({ type: frame.key ? "key" : "delta", timestamp, data: frame.data }),
    );
    return "decoding";
  }

  /** Finds a supported configuration for `codec`, then configures a decoder with it. */
  #check(codec: string): void {
    this.close();
    this.#codec = codec;
    this.#state = "checking";
    this.#needKey = true;
    this.#supportedConfig(codec).then((config) => {
      if (this.#codec !== codec || this.#state !== "checking") return; // superseded
      if (!config) {
        this.#state = "unsupported";
        this.#onError(`${codec} is not supported by this engine's VideoDecoder`);
        return;
      }
      this.#acceleration = config.hardwareAcceleration ?? null;
      this.#decoder = this.#create();
      this.#decoder.configure(config);
      this.#state = "ready";
    }, (err) => {
      this.#state = "unsupported";
      this.#onError(String(err));
    });
  }

  async #supportedConfig(codec: string): Promise<VideoDecoderConfig | null> {
    const tries = this.#softwareOnly ? ACCELERATIONS.slice(1) : ACCELERATIONS;
    for (const hardwareAcceleration of tries) {
      const config: VideoDecoderConfig = { codec, optimizeForLatency: true, hardwareAcceleration };
      const { supported } = await VideoDecoder.isConfigSupported(config);
      if (supported) return config;
    }
    return null;
  }

  #create(): VideoDecoder {
    return new VideoDecoder({
      output: (out) => {
        const started = this.#started.get(out.timestamp);
        this.#started.delete(out.timestamp);
        this.#onFrame(out, started === undefined ? 0 : performance.now() - started);
      },
      error: (err) => {
        // Configured again without the hardware preference at the next frame; a second failure
        // gives up on the codec (the viewer then asks for a fresh connection).
        this.#decoder = null;
        this.#state = this.#softwareOnly ? "unsupported" : "idle";
        this.#softwareOnly = true;
        this.#started.clear();
        this.#onError(`${err.name}: ${err.message}`);
      },
    });
  }

  close(): void {
    if (this.#decoder && this.#decoder.state !== "closed") this.#decoder.close();
    this.#decoder = null;
    this.#state = "idle";
    this.#started.clear();
  }
}
