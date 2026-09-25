/**
 * `expo-video` for denext: `useVideoPlayer` / `createVideoPlayer` over an
 * `HTMLVideoElement`, shown by `VideoView`.
 *
 * The player owns its `<video>` element; a `VideoView` mounts it (with `nativeControls`,
 * `contentFit` and fullscreen through the element's own controls). Thumbnails, Picture in
 * Picture, AirPlay, subtitles and the video cache are not provided (see the manifest).
 *
 * @example
 * ```ts
 * import { useVideoPlayer, VideoView } from "denext/expo/video";
 * import { h } from "denext/jsx-runtime";
 *
 * const player = useVideoPlayer(url, (p) => { p.loop = true; p.play(); });
 * h(VideoView, { player, nativeControls: true, style: { width: 320, height: 180 } });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useEffect, useMemo, useRef } from "../runtime/hooks.ts";
import {
  createEmitter,
  type Emitter,
  hostView,
  type Subscription,
  viewStyle,
} from "./internal/common.ts";
import { backing, displayUrl } from "./internal/fs.ts";

export type { Subscription };

/** A video source: a URL, `{ uri }`, or null. */
export type VideoSource =
  | string
  | { uri?: string; headers?: Record<string, string>; contentType?: string; metadata?: unknown }
  | null;

/** The player's load state. */
export type VideoPlayerStatus = "idle" | "loading" | "readyToPlay" | "error";

/** The events a player emits. */
export interface VideoPlayerEvents {
  /** Playing started or stopped. */
  playingChange: { isPlaying: boolean; oldIsPlaying?: boolean };
  /** The load state changed. */
  statusChange: {
    status: VideoPlayerStatus;
    oldStatus?: VideoPlayerStatus;
    error?: { message: string };
  };
  /** The position moved. */
  timeUpdate: {
    currentTime: number;
    currentLiveTimestamp: null;
    currentOffsetFromLive: null;
    bufferedPosition: number;
  };
  /** The source changed. */
  sourceChange: { source: VideoSource; oldSource?: VideoSource };
  /** Playback reached the end. */
  playToEnd: undefined;
}

/** A video player over an `HTMLVideoElement`. */
export class VideoPlayer {
  #element?: HTMLVideoElement;
  #source: VideoSource = null;
  #objectUrl?: string;
  #status: VideoPlayerStatus = "idle";
  #emitters = new Map<string, Emitter<unknown>>();
  /** How often `timeUpdate` fires, in seconds (0: never). */
  timeUpdateEventInterval = 0;

  /**
   * Create it.
   *
   * @param source The first source.
   */
  constructor(source: VideoSource) {
    this.#source = source;
  }

  /** The player's `<video>` element (created on first use). */
  get element(): HTMLVideoElement {
    if (this.#element) return this.#element;
    const video = document.createElement("video");
    video.playsInline = true;
    video.preload = "metadata";
    video.style.width = "100%";
    video.style.height = "100%";
    const emit = <K extends keyof VideoPlayerEvents>(event: K, payload: VideoPlayerEvents[K]) =>
      this.#emitters.get(event)?.emit(payload);
    video.addEventListener(
      "play",
      () => emit("playingChange", { isPlaying: true, oldIsPlaying: false }),
    );
    video.addEventListener(
      "pause",
      () => emit("playingChange", { isPlaying: false, oldIsPlaying: true }),
    );
    video.addEventListener("ended", () => emit("playToEnd", undefined));
    video.addEventListener("loadstart", () => this.#setStatus("loading"));
    video.addEventListener("loadeddata", () => this.#setStatus("readyToPlay"));
    video.addEventListener("error", () => this.#setStatus("error"));
    video.addEventListener("timeupdate", () =>
      emit("timeUpdate", {
        currentTime: video.currentTime,
        currentLiveTimestamp: null,
        currentOffsetFromLive: null,
        bufferedPosition: video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0,
      }));
    this.#element = video;
    this.#load(this.#source);
    return video;
  }

  /** Record and announce a status change. */
  #setStatus(status: VideoPlayerStatus): void {
    const oldStatus = this.#status;
    this.#status = status;
    this.#emitters.get("statusChange")?.emit({
      status,
      oldStatus,
      ...(status === "error" ? { error: { message: "The video could not be loaded" } } : {}),
    });
  }

  /** Point the element at `source`. */
  async #load(source: VideoSource): Promise<void> {
    const video = this.#element;
    if (!video) return;
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = undefined;
    const uri = typeof source === "string" ? source : source?.uri;
    if (!uri) {
      video.removeAttribute("src");
      this.#setStatus("idle");
      return;
    }
    if (backing(uri)) {
      this.#objectUrl = await displayUrl(uri);
      video.src = this.#objectUrl;
    } else {
      video.src = uri;
    }
  }

  /** The load state. */
  get status(): VideoPlayerStatus {
    return this.#status;
  }

  /** Whether it is playing. */
  get playing(): boolean {
    return this.#element ? !this.#element.paused && !this.#element.ended : false;
  }

  /** Whether it is muted. */
  get muted(): boolean {
    return this.element.muted;
  }
  set muted(value: boolean) {
    this.element.muted = value;
  }

  /** Whether it loops. */
  get loop(): boolean {
    return this.element.loop;
  }
  set loop(value: boolean) {
    this.element.loop = value;
  }

  /** The volume, 0–1. */
  get volume(): number {
    return this.element.volume;
  }
  set volume(value: number) {
    this.element.volume = value;
  }

  /** The playback rate. */
  get playbackRate(): number {
    return this.element.playbackRate;
  }
  set playbackRate(value: number) {
    this.element.playbackRate = value;
  }

  /** The position in seconds. */
  get currentTime(): number {
    return this.#element?.currentTime ?? 0;
  }
  set currentTime(value: number) {
    this.element.currentTime = value;
  }

  /** The duration in seconds (0 until known). */
  get duration(): number {
    const d = this.#element?.duration ?? 0;
    return Number.isFinite(d) ? d : 0;
  }

  /** Start or resume playback. */
  play(): void {
    this.element.play().catch(() => {});
  }

  /** Pause playback. */
  pause(): void {
    this.#element?.pause();
  }

  /** Play `source` instead. */
  replace(source: VideoSource): void {
    void this.replaceAsync(source);
  }

  /** Play `source` instead, resolving once it is set. */
  async replaceAsync(source: VideoSource): Promise<void> {
    const oldSource = this.#source;
    this.#source = source;
    this.element;
    await this.#load(source);
    this.#emitters.get("sourceChange")?.emit({ source, oldSource });
  }

  /** Move by `seconds` (negative: back). */
  seekBy(seconds: number): void {
    this.currentTime = Math.max(0, this.currentTime + seconds);
  }

  /** Play again from the start. */
  replay(): void {
    this.currentTime = 0;
    this.play();
  }

  /** Listen for a player event. */
  addListener<K extends keyof VideoPlayerEvents>(
    event: K,
    listener: (payload: VideoPlayerEvents[K]) => void,
  ): Subscription {
    let emitter = this.#emitters.get(event);
    if (!emitter) this.#emitters.set(event, emitter = createEmitter());
    return emitter.subscribe(listener as (payload: unknown) => void);
  }

  /** Stop and release the element. */
  release(): void {
    this.#element?.pause();
    this.#element?.removeAttribute("src");
    this.#element?.remove();
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#element = undefined;
  }
}

/**
 * A player not tied to a component (call `release()` when done).
 *
 * @param source The source.
 * @returns The player.
 */
export function createVideoPlayer(source: VideoSource): VideoPlayer {
  return new VideoPlayer(source);
}

/**
 * A player for the component's lifetime.
 *
 * @param source The source.
 * @param setup Called once with the new player (set `loop`, call `play()`, …).
 * @returns The player.
 */
export function useVideoPlayer(
  source: VideoSource,
  setup?: (player: VideoPlayer) => void,
): VideoPlayer {
  const player = useMemo(() => new VideoPlayer(source), []);
  const key = typeof source === "string" ? source : source?.uri ?? "";
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      setup?.(player);
    } else {
      player.replace(source);
    }
  }, [key]);
  useEffect(() => () => player.release(), [player]);
  return player;
}

/** `VideoView` props. */
export interface VideoViewProps {
  /** The player to show. */
  player: VideoPlayer;
  /** Show the browser's controls (default `true`). */
  nativeControls?: boolean;
  /** How the video fills the view (default `contain`). */
  contentFit?: "contain" | "cover" | "fill";
  /** Allow fullscreen (default `true`). */
  allowsFullscreen?: boolean;
  /** Allow Picture in Picture (ignored). */
  allowsPictureInPicture?: boolean;
  /** The style. */
  style?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/**
 * Shows a player's video.
 *
 * @param props The player, controls, fit and style.
 * @returns The view.
 */
export function VideoView(props: VideoViewProps): VNode {
  const {
    player,
    nativeControls = true,
    contentFit = "contain",
    allowsFullscreen = true,
    style,
    allowsPictureInPicture: _p,
    ...rest
  } = props;
  const host = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const video = player.element;
    video.controls = nativeControls;
    video.style.objectFit = contentFit;
    if (!allowsFullscreen) video.setAttribute("controlsList", "nofullscreen");
    host.current?.appendChild(video);
    return () => video.remove();
  }, [player, nativeControls, contentFit, allowsFullscreen]);
  return h(hostView(), {
    ...rest,
    ref: (node: HTMLElement | null) => void (host.current = node),
    style: viewStyle(style, { backgroundColor: "#000", overflow: "hidden" }),
  });
}

/**
 * Whether Picture in Picture is supported: not through this shim.
 *
 * @returns `false`.
 */
export function isPictureInPictureSupported(): boolean {
  return false;
}

/**
 * Clear the video cache (the browser owns it): nothing to do.
 *
 * @returns A promise that settles at once.
 */
export function clearVideoCacheAsync(): Promise<void> {
  return Promise.resolve();
}

/**
 * Set the video cache size (the browser owns it): nothing to do.
 *
 * @param _sizeBytes Ignored.
 * @returns A promise that settles at once.
 */
export function setVideoCacheSizeAsync(_sizeBytes: number): Promise<void> {
  return Promise.resolve();
}

/**
 * The video cache size (the browser owns it): 0.
 *
 * @returns 0.
 */
export function getCurrentVideoCacheSize(): number {
  return 0;
}
