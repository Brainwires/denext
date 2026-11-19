// The control API over one native viewer: `open({ fullscreen, display })`, `push(encodedFrame)`,
// `stats()`, `close()`. JavaScript only steers: a pushed frame's compressed bytes are copied into
// the decoder's buffer, and the pictures stay in native code (decoder → GPU → screen).

import {
  type CodecName,
  CODECS,
  type NativeBinding,
  STAT_FIELDS,
  type StatField,
} from "./native.ts";

/**
 * Calls a native `void* fn(void*)` on the app's UI thread: `Deno.desktop.runOnMainThread` (see
 * main-thread.ts), or a stand-in in tests.
 */
export type MainThreadRunner = (
  fn: Deno.PointerValue,
  context: Deno.PointerValue,
) => Promise<bigint>;

/** The native error codes (native/src/viewer.rs `Error::code`), by name. */
const ERROR_CODES: Record<number, ViewerErrorCode> = {
  [-1]: "bad-argument",
  [-2]: "unsupported-codec",
  [-3]: "unsupported-platform",
  [-4]: "platform",
  [-5]: "not-main-thread",
  [-6]: "already-open",
  [-7]: "no-device",
};

export type ViewerErrorCode =
  | "bad-argument"
  | "unsupported-codec"
  | "unsupported-platform"
  | "platform"
  | "not-main-thread"
  | "already-open"
  | "no-device"
  | "closed";

/** A refusal from the native viewer, with its code. */
export class ViewerError extends Error {
  constructor(readonly code: ViewerErrorCode, message: string) {
    super(message);
    this.name = "ViewerError";
  }
}

/** `result` when it is not negative; else a {@link ViewerError} naming `what`. */
export function check(result: number, what: string): number {
  if (result >= 0) return result;
  const code = ERROR_CODES[result] ?? "platform";
  throw new ViewerError(code, `${what} failed: ${code} (${result})`);
}

/** Where and how the window opens. */
export interface OpenOptions {
  /** Cover the whole display (borderless, above the menu bar). Default `true`. */
  readonly fullscreen?: boolean;
  /** Which display: 0 is the main one. Default 0. */
  readonly display?: number;
}

/** An encoded frame: an `RTCEncodedVideoFrame`, or its bytes. */
export type FrameInput =
  | ArrayBuffer
  | ArrayBufferView
  | { readonly data: ArrayBuffer; readonly type?: string };

/** What `push` did. */
export type PushResult = "queued" | "waiting-for-key-frame" | "skipped";

/** A latency distribution, in milliseconds over the last 512 frames. */
export interface Latency {
  readonly last: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** What `stats()` reports. */
export interface ViewerStats {
  readonly codec: CodecName;
  readonly pushed: number;
  readonly decoded: number;
  readonly presented: number;
  /**
   * Of `presented`, the frames whose drawable reported no display time (a VM's virtual display
   * reports none): their `present` / `total` latency ends at GPU completion instead.
   */
  readonly presentedUntimed: number;
  /** Decoded but never shown (a newer picture replaced it, or the compositor dropped it). */
  readonly dropped: number;
  readonly decodeErrors: number;
  /** Dropped before the first key frame. */
  readonly waitingForKey: number;
  readonly width: number;
  readonly height: number;
  /** Hardware decode: `true` / `false`, `null` before the decoder has said. */
  readonly hardware: boolean | null;
  /** The last platform status (an `OSStatus` on macOS), 0 for none. */
  readonly lastStatus: number;
  readonly windowOpen: boolean;
  /** `push` → decoded picture. */
  readonly decode: Latency;
  /** Decoded picture → on the glass (the drawable's presented time). */
  readonly present: Latency;
  /** `push` → on the glass: what the viewer adds to glass-to-glass latency. */
  readonly total: Latency;
  /** With `inspect`: the last picture's mean luma and a hash of it. */
  readonly lumaMean: number;
  readonly lumaHash: number;
}

/** The stats from the numbers `rtcv_stats` wrote. */
export function parseStats(codec: CodecName, values: Float64Array): ViewerStats {
  const get = (field: StatField) => values[STAT_FIELDS.indexOf(field)] ?? 0;
  const latency = (prefix: "decode" | "present" | "total"): Latency => ({
    last: get(`${prefix}Last`),
    mean: get(`${prefix}Mean`),
    p50: get(`${prefix}P50`),
    p95: get(`${prefix}P95`),
    max: get(`${prefix}Max`),
  });
  const hw = get("hardware");
  return {
    codec,
    pushed: get("pushed"),
    decoded: get("decoded"),
    presented: get("presented"),
    presentedUntimed: get("presentedUntimed"),
    dropped: get("dropped"),
    decodeErrors: get("decodeErrors"),
    waitingForKey: get("waitingForKey"),
    width: get("width"),
    height: get("height"),
    hardware: hw < 0 ? null : hw === 1,
    lastStatus: get("lastStatus"),
    windowOpen: get("windowOpen") === 1,
    decode: latency("decode"),
    present: latency("present"),
    total: latency("total"),
    lumaMean: get("lumaMean"),
    lumaHash: get("lumaHash"),
  };
}

/** The bytes of a frame, without copying; null for an empty frame. */
export function frameBytes(frame: FrameInput): Uint8Array | null {
  let bytes: Uint8Array;
  if (frame instanceof ArrayBuffer) {
    bytes = new Uint8Array(frame);
  } else if (ArrayBuffer.isView(frame)) {
    bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  } else if (frame && typeof frame === "object" && frame.data instanceof ArrayBuffer) {
    if (frame.type === "empty") return null;
    bytes = new Uint8Array(frame.data);
  } else {
    throw new ViewerError(
      "bad-argument",
      "push: a frame is an ArrayBuffer, a view or an encoded frame",
    );
  }
  return bytes.byteLength === 0 ? null : bytes;
}

/** Options for {@link NativeViewer.create}. */
export interface CreateOptions {
  /** Read every decoded picture back for its luma (tests and diagnostics; costs CPU). */
  readonly inspect?: boolean;
}

/** One native viewer: a decoder and, once opened, its window. */
export class NativeViewer {
  #binding: NativeBinding;
  #run: MainThreadRunner;
  #id: number;
  #codec: CodecName;
  #closed = false;
  #windowOpen = false;
  #options: Required<OpenOptions> | null = null;
  /** Window operations in order: one at a time on the UI thread. */
  #queue: Promise<unknown> = Promise.resolve();
  #values = new Float64Array(STAT_FIELDS.length);

  private constructor(binding: NativeBinding, run: MainThreadRunner, id: number, codec: CodecName) {
    this.#binding = binding;
    this.#run = run;
    this.#id = id;
    this.#codec = codec;
  }

  /** A viewer decoding `codec`. No window until {@link NativeViewer.open}. */
  static create(
    binding: NativeBinding,
    runOnMainThread: MainThreadRunner,
    codec: CodecName,
    options: CreateOptions = {},
  ): NativeViewer {
    const number = CODECS[codec];
    if (number === undefined) throw new ViewerError("unsupported-codec", `unknown codec ${codec}`);
    const id = check(binding.create(number, options.inspect ? 1 : 0), `create(${codec})`);
    return new NativeViewer(binding, runOnMainThread, id, codec);
  }

  /** The native id: what a transform worker pushes to (see receive-worker.ts). */
  get id(): number {
    return this.#id;
  }

  get codec(): CodecName {
    return this.#codec;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The options the window is open with, or null when it is closed. */
  get window(): Required<OpenOptions> | null {
    return this.#windowOpen ? this.#options : null;
  }

  /** Switches to another codec (a new stream), keeping the window. */
  setCodec(codec: CodecName): void {
    this.#assertOpen();
    if (codec === this.#codec) return;
    const number = CODECS[codec];
    if (number === undefined) throw new ViewerError("unsupported-codec", `unknown codec ${codec}`);
    check(this.#binding.setCodec(this.#id, number), `setCodec(${codec})`);
    this.#codec = codec;
  }

  /**
   * Opens the window (or moves it: open again with other options). Resolves once it is on
   * screen. Needs the app's UI thread (a Deno Desktop runtime with `runOnMainThread`).
   */
  open(options: OpenOptions = {}): Promise<void> {
    const wanted = {
      fullscreen: options.fullscreen ?? true,
      display: Math.max(0, Math.trunc(options.display ?? 0)),
    };
    return this.#enqueue(async () => {
      this.#assertOpen();
      const same = this.#windowOpen && this.#options?.fullscreen === wanted.fullscreen &&
        this.#options?.display === wanted.display;
      if (same) return;
      if (this.#windowOpen) await this.#main(this.#binding.requestClose(this.#id), "close");
      this.#windowOpen = false;
      await this.#main(
        this.#binding.requestOpen(this.#id, wanted.display, wanted.fullscreen),
        "open",
      );
      this.#windowOpen = true;
      this.#options = wanted;
    });
  }

  /** Closes the window, keeping the decoder (a later `open` shows the stream again). */
  hide(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed || !this.#windowOpen) return;
      await this.#main(this.#binding.requestClose(this.#id), "close");
      this.#windowOpen = false;
    });
  }

  /**
   * Hands one encoded frame to the decoder. Synchronous and cheap (the bytes are copied into the
   * decoder's buffer; decoding happens off this thread). An `empty` frame is skipped.
   */
  push(frame: FrameInput): PushResult {
    this.#assertOpen();
    const bytes = frameBytes(frame);
    if (bytes === null) return "skipped";
    const result = check(this.#binding.push(this.#id, bytes), "push");
    return result === 1 ? "waiting-for-key-frame" : "queued";
  }

  /** The decoder's and presenter's counters and latencies. */
  stats(): ViewerStats {
    this.#assertOpen();
    check(this.#binding.stats(this.#id, this.#values), "stats");
    return parseStats(this.#codec, this.#values);
  }

  /** Closes the window and frees the viewer. Idempotent. */
  close(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed) return;
      try {
        if (this.#windowOpen) await this.#main(this.#binding.requestClose(this.#id), "close");
      } finally {
        this.#windowOpen = false;
        this.#closed = true;
        this.#binding.destroy(this.#id);
      }
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new ViewerError("closed", "the viewer is closed");
  }

  /** Runs the queued window operation on the UI thread and checks its outcome. */
  async #main(queued: number, what: string): Promise<void> {
    check(queued, what);
    const context = Deno.UnsafePointer.create(BigInt(this.#id));
    const result = await this.#run(this.#binding.mainFn(), context);
    check(Number(BigInt.asIntN(64, result)), what);
  }

  #enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(op);
    this.#queue = next.catch(() => {});
    return next;
  }
}
