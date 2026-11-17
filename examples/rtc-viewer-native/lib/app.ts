// The app's backend, in the desktop app's Deno process: the native library, the viewer, the
// WHIP endpoint and the transform worker, and what the page and the tray ask of them. One
// instance (desktop/rtc-viewer.ts's `viewerApp()`), shared by desktop.ts and the extension.

import type { Clip } from "./clip.ts";
import type { CodecName, NativeBinding } from "./native.ts";
import type { PumpStats } from "./pump.ts";
import type { CodecCapability } from "./sdp.ts";
import { type PeerLike, type SessionInfo, WHIP_PATH, WhipReceiver } from "./receiver.ts";
import {
  type MainThreadRunner,
  NativeViewer,
  type OpenOptions,
  type ViewerStats,
} from "./viewer.ts";

/** What the app is built from (desktop/rtc-viewer.ts passes the real ones; tests fakes). */
export interface AppDeps {
  /** Opens the native library. Throws with the reason when it can't. */
  loadBinding(): NativeBinding;
  /** The UI-thread runner, or null outside a Deno Desktop runtime that has one. */
  readonly runOnMainThread: MainThreadRunner | null;
  /** The WebRTC pieces, or null on a runtime without `RTCRtpScriptTransform`. */
  readonly webrtc: WebRtcDeps | null;
}

/** The runtime's WebRTC, as the receiver uses it. */
export interface WebRtcDeps {
  peer(): PeerLike;
  capabilities(): readonly CodecCapability[];
  /** Starts the transform worker and sets `receiver.transform`; posts go to the worker. */
  transform(receiver: unknown, onMessage: (data: unknown) => void): {
    post(message: unknown): void;
    close(): void;
  };
}

/** What `status()` reports to the page. */
export interface AppStatus {
  readonly os: string;
  /** The native library's file, or why it didn't load. */
  readonly library: { readonly path: string | null; readonly error: string | null };
  /** Whether windows can open (a UI-thread runner). */
  readonly windows: boolean;
  /** Whether this runtime gives encoded frames (`RTCRtpScriptTransform`). */
  readonly encodedTransform: boolean;
  /** The WHIP endpoint senders post to, or null when it isn't up. */
  readonly whip: string | null;
  readonly session: SessionInfo | null;
  readonly viewer:
    | { readonly codec: CodecName; readonly window: Required<OpenOptions> | null }
    | null;
  /** The file being played (`RTCV_PLAY`), or null. */
  readonly playing: string | null;
}

/** What `stats()` reports: the native viewer's numbers and the worker's hand-off. */
export interface AppStats {
  readonly viewer: ViewerStats | null;
  readonly transport: PumpStats | null;
}

/** A refusal the page can show (the extension turns it into a DesktopCapError). */
export class AppError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AppError";
  }
}

export class ViewerApp {
  #deps: AppDeps;
  #binding: NativeBinding | null = null;
  #bindingError: string | null = null;
  #viewer: NativeViewer | null = null;
  #receiver: WhipReceiver | null = null;
  #server: Deno.HttpServer | null = null;
  #whip: string | null = null;
  #transform: { post(message: unknown): void; close(): void } | null = null;
  #transport: PumpStats | null = null;
  #lastErrors = 0;
  #watch: ReturnType<typeof setInterval> | undefined;
  #player: ReturnType<typeof setInterval> | undefined;
  #playing: string | null = null;

  constructor(deps: AppDeps) {
    this.#deps = deps;
  }

  status(): AppStatus {
    if (!this.#binding && !this.#bindingError) this.#tryBinding();
    return {
      os: Deno.build.os,
      library: { path: this.#binding?.path ?? null, error: this.#bindingError },
      windows: this.#deps.runOnMainThread !== null,
      encodedTransform: this.#deps.webrtc !== null,
      whip: this.#whip,
      session: this.#receiver?.session() ?? null,
      viewer: this.#viewer ? { codec: this.#viewer.codec, window: this.#viewer.window } : null,
      playing: this.#playing,
    };
  }

  stats(): AppStats {
    return { viewer: this.#viewer?.stats() ?? null, transport: this.#transport };
  }

  /** Opens (or moves) the video window; the viewer starts as H.264 until a stream says otherwise. */
  async open(options: OpenOptions = {}): Promise<void> {
    if (!this.#deps.runOnMainThread) {
      throw new AppError(
        "unavailable",
        "windows need the Deno Desktop runtime's UI thread (denext desktop run)",
      );
    }
    const viewer = this.#ensureViewer(this.#viewer?.codec ?? "h264");
    await viewer.open(options);
  }

  /** Closes the video window (the stream keeps decoding; `open` shows it again). */
  async hide(): Promise<void> {
    await this.#viewer?.hide();
  }

  /** Pushes one encoded frame of `codec` (the page's path; streams use the worker's). */
  push(codec: CodecName, bytes: Uint8Array): string {
    return this.#ensureViewer(codec).push(bytes);
  }

  /**
   * Plays `clip` in a loop at `fps` (no sender: a file as the source), until a WHIP session starts
   * or {@link ViewerApp.stopPlaying}. Frames are pushed from this thread on a timer.
   */
  play(name: string, clip: Clip, fps = 30): void {
    this.stopPlaying();
    if (clip.frames.length === 0) throw new AppError("validation", `${name} has no frames`);
    const viewer = this.#ensureViewer(clip.codec);
    let next = 0;
    this.#playing = name;
    this.#player = setInterval(() => {
      if (viewer.closed) return this.stopPlaying();
      viewer.push(clip.frames[next]);
      next = (next + 1) % clip.frames.length;
    }, 1000 / fps);
  }

  stopPlaying(): void {
    clearInterval(this.#player);
    this.#player = undefined;
    this.#playing = null;
  }

  /** Serves the WHIP endpoint on `hostname:port`. A no-op without encoded transforms. */
  startWhip(options: { hostname?: string; port?: number } = {}): void {
    const webrtc = this.#deps.webrtc;
    if (!webrtc || this.#server) return;
    const hostname = options.hostname ?? "127.0.0.1";
    this.#receiver = new WhipReceiver({
      peer: () => webrtc.peer(),
      capabilities: () => webrtc.capabilities(),
      attach: (receiver) => {
        this.#transform?.close();
        const transform = webrtc.transform(receiver, (data) => {
          const stats = (data as { stats?: PumpStats }).stats;
          if (stats) this.#transport = stats;
        });
        this.#transform = transform;
        return {
          close: () => {
            transform.close();
            if (this.#transform === transform) this.#transform = null;
          },
        };
      },
      ready: (codec) => {
        this.stopPlaying();
        const viewer = this.#ensureViewer(codec);
        this.#transform?.post({ library: this.#binding?.path, viewer: viewer.id });
        this.#lastErrors = viewer.stats().decodeErrors;
      },
      ended: () => {
        this.#transport = null;
      },
    });
    const receiver = this.#receiver;
    this.#server = Deno.serve({
      hostname,
      port: options.port ?? 8189,
      onListen: ({ port }) => {
        this.#whip = `http://${hostname}:${port}${WHIP_PATH}`;
        console.log(`rtc-viewer-native: WHIP endpoint ${this.#whip}`);
      },
    }, (request) => receiver.handle(request));
    // A decoder that fails frames needs a key frame: ask the sender (the worker rate-limits).
    this.#watch = setInterval(() => this.#checkDecoder(), 1000);
  }

  /** Ends the session, stops the endpoint and frees the viewer. */
  async shutdown(): Promise<void> {
    clearInterval(this.#watch);
    this.stopPlaying();
    this.#receiver?.closeSession();
    await this.#server?.shutdown();
    this.#server = null;
    this.#whip = null;
    await this.#viewer?.close();
    this.#viewer = null;
  }

  #checkDecoder(): void {
    if (!this.#viewer || !this.#transform) return;
    const errors = this.#viewer.stats().decodeErrors;
    if (errors > this.#lastErrors) this.#transform.post({ keyFrame: true });
    this.#lastErrors = errors;
  }

  #tryBinding(): NativeBinding | null {
    if (this.#binding) return this.#binding;
    try {
      this.#binding = this.#deps.loadBinding();
      this.#bindingError = null;
    } catch (err) {
      this.#bindingError = err instanceof Error ? err.message : String(err);
    }
    return this.#binding;
  }

  #ensureViewer(codec: CodecName): NativeViewer {
    const binding = this.#tryBinding();
    if (!binding) throw new AppError("unavailable", this.#bindingError ?? "no native library");
    if (!this.#viewer || this.#viewer.closed) {
      const run = this.#deps.runOnMainThread ??
        (() => Promise.reject(new AppError("unavailable", "no UI thread")));
      this.#viewer = NativeViewer.create(binding, run, codec);
    } else {
      this.#viewer.setCodec(codec);
    }
    return this.#viewer;
  }
}
