// The viewer's pipeline, wired: signalling → RTCPeerConnection → encoded-frame tap → WebCodecs →
// WebGPU / WebGL2, or the remote track in a <video> when the engine lacks a piece. The page
// component (app/viewer.tsx) only renders what `onUpdate` reports.

import { hubUrl } from "../signal/client.ts";
import { startViewer, type Viewer } from "../rtc/peers.ts";
import { codecString } from "./codec.ts";
import { FrameDecoder } from "./decoder.ts";
import {
  describePipeline,
  detectCapabilities,
  parseOverride,
  parseTapOverride,
  type Pipeline,
  selectPipeline,
} from "./plan.ts";
import type { FrameRenderer } from "./renderer.ts";
import { createWebGl2Renderer } from "./render-webgl2.ts";
import { createWebGpuRenderer } from "./render-webgpu.ts";
import { readInbound, StatsMeter, type StatsSnapshot } from "./stats.ts";
import { type EncodedFrame, type Tap, tapReceiver } from "./tap.ts";

/** What the overlay shows. */
export interface SessionView {
  status: string;
  room: string;
  pipeline: string;
  /** Why this is not the full pipeline, else `null`. */
  fallback: string | null;
  stats: StatsSnapshot & {
    jitterMs: number | null;
    codec: string | null;
    acceleration: string | null;
  };
}

/** Options for {@link ViewerSession}. */
export interface SessionOptions {
  /**
   * The element the session puts its canvas in (it makes its own: see `#newCanvas`). Nothing else
   * may render into it: a component's re-render would drop a child it did not create.
   */
  surface: HTMLElement;
  video: HTMLVideoElement;
  /** The page's location: `?room=`, `?signal=`, `?renderer=`, `?tap=`, `?ice=`,
   * `?passthrough=0`. */
  location: { href: string };
  onUpdate(view: SessionView): void;
}

/** How long to wait for a key frame before asking for one, and between asks (ms). */
const KEY_FRAME_WAIT_MS = 1500;

/** The `RTCConfiguration` key Chromium wants before `createEncodedStreams()` may be called. */
const ENCODED_STREAMS_CONFIG = { encodedInsertableStreams: true };

/** One viewer page's pipeline. */
export class ViewerSession {
  readonly #options: SessionOptions;
  readonly #params: URLSearchParams;
  readonly #meter = new StatsMeter();
  #view: SessionView;
  #pipeline: Pipeline = { tap: null, renderer: "video", fallback: null };
  #canvas: HTMLCanvasElement | null = null;
  #renderer: FrameRenderer | null = null;
  #decoder: FrameDecoder | null = null;
  #viewer: Viewer | null = null;
  #tap: Tap | null = null;
  #receiver: RTCRtpReceiver | null = null;
  #negotiated: { mimeType: string | null; fmtp: string | null } = {
    mimeType: null,
    fmtp: null,
  };
  #pending: VideoFrame | null = null;
  #waitingSince = 0;
  #lastAsk = 0;
  #raf = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#params = new URL(options.location.href).searchParams;
    this.#view = {
      status: "starting",
      room: this.#params.get("room") || "demo",
      pipeline: "detecting…",
      fallback: null,
      stats: {
        fps: 0,
        decodeMs: 0,
        width: 0,
        height: 0,
        jitterMs: null,
        codec: null,
        acceleration: null,
      },
    };
  }

  /** Picks the pipeline, makes its renderer and joins the room. */
  async start(): Promise<void> {
    const caps = await detectCapabilities();
    this.#pipeline = selectPipeline(
      caps,
      parseOverride(this.#params.get("renderer")),
      parseTapOverride(this.#params.get("tap")),
    );
    this.#renderer = await this.#makeRenderer();
    if (this.#stopped) return;
    if (this.#renderer) {
      this.#decoder = new FrameDecoder(
        (frame, ms) => this.#decoded(frame, ms),
        (message) => this.#update({ status: `decoder: ${message}` }),
      );
      this.#raf = requestAnimationFrame(this.#paint);
    }
    this.#update({
      pipeline: describePipeline(this.#pipeline),
      fallback: this.#pipeline.fallback,
    });
    const ice = this.#params.getAll("ice").map((urls) => ({ urls }));
    this.#viewer = startViewer({
      url: hubUrl(this.#options.location),
      room: this.#view.room,
      rtcConfig: {
        iceServers: ice,
        ...(this.#pipeline.tap === "encoded-streams" ? ENCODED_STREAMS_CONFIG : {}),
      } as RTCConfiguration,
      onTrack: (event) => this.#track(event),
      onClosed: () => this.#untrack(),
      onStatus: (status) => this.#update({ status }),
    });
    this.#timer = setInterval(() => void this.#poll(), 1000);
  }

  /** WebGPU, else WebGL2 (each step down is noted as the fallback), else the <video> path. */
  async #makeRenderer(): Promise<FrameRenderer | null> {
    if (this.#pipeline.renderer === "webgpu") {
      try {
        return await createWebGpuRenderer(this.#newCanvas());
      } catch (err) {
        this.#pipeline = {
          ...this.#pipeline,
          renderer: "webgl2",
          fallback: `WebGPU: ${err}`,
        };
      }
    }
    if (this.#pipeline.renderer === "webgl2") {
      try {
        return createWebGl2Renderer(this.#newCanvas());
      } catch (err) {
        this.#pipeline = {
          tap: null,
          renderer: "video",
          fallback: `WebGL2: ${err}`,
        };
      }
    }
    this.#canvas?.remove();
    this.#canvas = null;
    return null;
  }

  /**
   * A fresh canvas in the surface, replacing the last one: a canvas keeps the first kind of context
   * it gave out, so the step from WebGPU down to WebGL2 needs a new element.
   */
  #newCanvas(): HTMLCanvasElement {
    this.#canvas?.remove();
    const canvas = document.createElement("canvas");
    this.#options.surface.append(canvas);
    this.#canvas = canvas;
    return canvas;
  }

  #track(event: RTCTrackEvent): void {
    if (event.track.kind !== "video") return;
    this.#untrack();
    this.#receiver = event.receiver;
    const tap = this.#pipeline.tap;
    if (!tap || !this.#decoder) {
      this.#options.video.srcObject = event.streams[0] ??
        new MediaStream([event.track]);
      this.#options.video.play().catch(() => {});
      this.#countVideoFrames(this.#options.video);
      return;
    }
    // The key-frame clock starts at the connection's first frame (see #askForKeyFrame).
    this.#waitingSince = 0;
    this.#tap = tapReceiver(
      event.receiver,
      tap,
      (frame) => this.#frame(frame),
      {
        passthrough: this.#params.get("passthrough") !== "0",
      },
    );
  }

  /**
   * The <video> path's numbers: `requestVideoFrameCallback` reports each presented frame, with the
   * engine's own decode time (`processingDuration`) where it gives one.
   */
  #countVideoFrames(video: HTMLVideoElement): void {
    if (typeof video.requestVideoFrameCallback !== "function") return;
    const onFrame: VideoFrameRequestCallback = (now, meta) => {
      if (this.#stopped || video.srcObject === null) return;
      const decodeMs = (meta.processingDuration ?? 0) * 1000;
      this.#meter.frame(now, decodeMs, meta.width, meta.height);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  #untrack(): void {
    this.#tap?.stop();
    this.#tap = null;
    // A new connection starts with a key frame: let the decoder check its codec again.
    this.#decoder?.close();
    this.#receiver = null;
    this.#negotiated = { mimeType: null, fmtp: null };
    this.#options.video.srcObject = null;
  }

  #frame(frame: EncodedFrame): void {
    if (!this.#negotiated.mimeType) this.#readNegotiated();
    const mimeType = frame.mimeType ?? this.#negotiated.mimeType;
    const codec = mimeType ? codecString(mimeType, this.#negotiated.fmtp ?? undefined) : null;
    const result = this.#decoder!.push(frame, codec);
    if (result === "decoding") this.#waitingSince = 0;
    else if (result !== "unsupported") this.#askForKeyFrame(frame.receivedAt);
    else if (codec === null && this.#view.status !== `no WebCodecs name for ${mimeType}`) {
      this.#update({ status: `no WebCodecs name for ${mimeType}` });
    }
  }

  /** The answer's first codec: what the sender sends unless the stats say otherwise. */
  #readNegotiated(): void {
    const codec = this.#receiver?.getParameters().codecs?.[0];
    if (codec) {
      this.#negotiated = {
        mimeType: codec.mimeType,
        fmtp: codec.sdpFmtpLine ?? null,
      };
    }
  }

  /** A key frame is overdue: ask the sender (script transform), else for a fresh connection. */
  #askForKeyFrame(now: number): void {
    if (!this.#waitingSince) this.#waitingSince = now;
    if (
      now - this.#waitingSince < KEY_FRAME_WAIT_MS ||
      now - this.#lastAsk < KEY_FRAME_WAIT_MS
    ) {
      return;
    }
    this.#lastAsk = now;
    if (!this.#tap?.requestKeyFrame()) this.#viewer?.restart();
  }

  #decoded(frame: VideoFrame, decodeMs: number): void {
    this.#meter.frame(
      performance.now(),
      decodeMs,
      frame.displayWidth,
      frame.displayHeight,
    );
    this.#pending?.close();
    this.#pending = frame;
  }

  /** Draws the newest decoded frame once per display refresh (older ones were closed). */
  #paint = () => {
    if (this.#stopped) return;
    const frame = this.#pending;
    this.#pending = null;
    if (frame) this.#renderer?.draw(frame);
    this.#raf = requestAnimationFrame(this.#paint);
  };

  async #poll(): Promise<void> {
    const receiver = this.#receiver;
    const inbound = receiver ? await readInbound(receiver).catch(() => null) : null;
    if (inbound?.mimeType) {
      this.#negotiated = {
        mimeType: inbound.mimeType,
        fmtp: inbound.sdpFmtpLine,
      };
    }
    const snapshot = this.#meter.snapshot(performance.now());
    this.#update({
      stats: {
        ...snapshot,
        jitterMs: inbound?.jitterMs ?? null,
        codec: this.#decoder?.codec ?? inbound?.mimeType ?? null,
        acceleration: this.#decoder?.codec ? this.#decoder.acceleration : null,
      },
    });
  }

  #update(patch: Partial<SessionView>): void {
    this.#view = { ...this.#view, ...patch };
    if (!this.#stopped) this.#options.onUpdate(this.#view);
  }

  stop(): void {
    this.#stopped = true;
    cancelAnimationFrame(this.#raf);
    clearInterval(this.#timer);
    this.#untrack();
    this.#viewer?.close();
    this.#decoder?.close();
    this.#pending?.close();
    this.#renderer?.destroy();
    this.#canvas?.remove();
  }
}
