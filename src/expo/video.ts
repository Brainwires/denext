/**
 * `expo-video` for denext: `useVideoPlayer` / `createVideoPlayer` and `VideoView`. Where
 * `denext/mobile`'s native `"video"` view is registered (`denext mobile add native-views`: an
 * AVPlayer with the system controls on iOS, drawn under the page, so Picture in Picture and
 * AirPlay come with AVKit's controls, and a vertical swipe on it scrolls the page), `VideoView`
 * shows the player's source there and the player's `play` / `pause` / `currentTime` / `loop` /
 * `muted` drive it. Everywhere else the player owns an `HTMLVideoElement` that `VideoView`
 * mounts (with `nativeControls`, `contentFit` and fullscreen through the element's own
 * controls). A file in the app's own storage (`denext/expo/file-system`) always plays in the
 * `<video>`. Thumbnails, subtitles and the video cache are not provided (see the manifest);
 * `volume` and `playbackRate` apply to the `<video>` only.
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
import { useCallback, useEffect, useMemo, useRef, useState } from "../runtime/hooks.ts";
import { NativeViewSlot, type NativeViewSlotHandle } from "../mobile/native-view.ts";
import {
  createEmitter,
  type Emitter,
  flattenStyle,
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

/** The native video view a player is shown in, while one is. */
interface NativeLink {
  /** Run a command of the native view (`play`, `pause`, `seek`). */
  readonly command: NativeViewSlotHandle["command"];
  /** Whether it plays, as its last event said. */
  playing: boolean;
  /** The position and length, as its last answer said. */
  time: number;
  duration: number;
}

/** What `VideoView` reaches inside a player (kept off the player's public API). */
interface PlayerInternals {
  /** The native view it is shown in, or null. */
  link: NativeLink | null;
  /** Emit a player event. */
  emit<K extends keyof VideoPlayerEvents>(event: K, payload: VideoPlayerEvents[K]): void;
  /** Record and announce a status change. */
  setStatus(status: VideoPlayerStatus): void;
  /** Re-render the views showing it (a `loop` / `muted` / source change). */
  readonly views: Set<() => void>;
  /** The current source. */
  source(): VideoSource;
  /** The `<video>`, when it was made. */
  element(): HTMLVideoElement | undefined;
  /** Whether the app asked it to play (and it has not ended or been paused since). */
  wantPlaying: boolean;
}

/** Each player's internals (made on first use). */
let internals: WeakMap<VideoPlayer, PlayerInternals> | undefined;

/** A player's internals. */
function internalsOf(player: VideoPlayer): PlayerInternals {
  return internals!.get(player)!;
}

/** The URL of a source, or "" for none. */
function sourceUri(source: VideoSource): string {
  return (typeof source === "string" ? source : source?.uri) ?? "";
}

/** A video player: an `HTMLVideoElement`, or the native video view it is shown in. */
export class VideoPlayer {
  #element?: HTMLVideoElement;
  #source: VideoSource = null;
  #objectUrl?: string;
  #status: VideoPlayerStatus = "idle";
  #emitters = new Map<string, Emitter<unknown>>();
  #loop = false;
  #muted = false;
  /** How often `timeUpdate` fires, in seconds (0: never). */
  timeUpdateEventInterval = 0;
  /**
   * The largest resolution an adaptive stream may pick (accepted and ignored: the browser or
   * AVPlayer chooses).
   */
  maxResolution: { width: number; height: number } | null = null;

  /**
   * Create it.
   *
   * @param source The first source.
   */
  constructor(source: VideoSource) {
    this.#source = source;
    const views = new Set<() => void>();
    (internals ??= new WeakMap()).set(this, {
      link: null,
      emit: (event, payload) => this.#emitters.get(event)?.emit(payload),
      setStatus: (status) => this.#setStatus(status),
      views,
      source: () => this.#source,
      element: () => this.#element,
      wantPlaying: false,
    });
  }

  /** The native view this player is shown in, or null. */
  get #link(): NativeLink | null {
    return internalsOf(this).link;
  }

  /** Tell the views showing this player that a prop they send changed. */
  #changed(): void {
    for (const refresh of internalsOf(this).views) refresh();
  }

  /** The player's `<video>` element (created on first use). */
  get element(): HTMLVideoElement {
    if (this.#element) return this.#element;
    const video = document.createElement("video");
    video.playsInline = true;
    video.preload = "metadata";
    video.loop = this.#loop;
    video.muted = this.#muted;
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
    video.addEventListener("ended", () => {
      if (!video.loop) internalsOf(this).wantPlaying = false;
      emit("playToEnd", undefined);
    });
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
    const link = this.#link;
    if (link) return link.playing;
    return this.#element ? !this.#element.paused && !this.#element.ended : false;
  }

  /** Whether it is muted. */
  get muted(): boolean {
    return this.#muted;
  }
  set muted(value: boolean) {
    this.#muted = value;
    if (this.#element) this.#element.muted = value;
    this.#changed();
  }

  /** Whether it loops. */
  get loop(): boolean {
    return this.#loop;
  }
  set loop(value: boolean) {
    this.#loop = value;
    if (this.#element) this.#element.loop = value;
    this.#changed();
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
    return this.#link?.time ?? this.#element?.currentTime ?? 0;
  }
  set currentTime(value: number) {
    const link = this.#link;
    if (link) {
      link.time = value;
      link.command("seek", { seconds: value }).catch(() => {});
    } else this.element.currentTime = value;
  }

  /** The duration in seconds (0 until known). */
  get duration(): number {
    const link = this.#link;
    if (link) return link.duration;
    const d = this.#element?.duration ?? 0;
    return Number.isFinite(d) ? d : 0;
  }

  /** Start or resume playback. */
  play(): void {
    internalsOf(this).wantPlaying = true;
    const link = this.#link;
    if (link) link.command("play").catch(() => {});
    else this.element.play().catch(() => {});
  }

  /** Pause playback. */
  pause(): void {
    internalsOf(this).wantPlaying = false;
    const link = this.#link;
    if (link) link.command("pause").catch(() => {});
    else this.#element?.pause();
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
    this.#changed();
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
 * Android player-builder options (seek increments), applied before the native player is
 * built. Accepted and ignored here: the browser's controls set their own increments.
 */
export interface PlayerBuilderOptions {
  /** The seek-back increment, in seconds (ignored). */
  seekBackwardIncrement?: number;
  /** The seek-forward increment, in seconds (ignored). */
  seekForwardIncrement?: number;
  /** Whether the display switches frame rate to match the video (ignored). */
  videoChangeFrameRateStrategy?: "off" | "onlyIfSeamless";
}

/**
 * A player not tied to a component (call `release()` when done).
 *
 * @param source The source.
 * @param _playerBuilderOptions Android builder options (ignored).
 * @returns The player.
 */
export function createVideoPlayer(
  source: VideoSource,
  _playerBuilderOptions?: PlayerBuilderOptions,
): VideoPlayer {
  return new VideoPlayer(source);
}

/**
 * A player for the component's lifetime.
 *
 * @param source The source.
 * @param setup Called once with the new player (set `loop`, call `play()`, …).
 * @param _playerBuilderOptions Android builder options (ignored).
 * @returns The player.
 */
export function useVideoPlayer(
  source: VideoSource,
  setup?: (player: VideoPlayer) => void,
  _playerBuilderOptions?: PlayerBuilderOptions,
): VideoPlayer {
  const player = useMemo(() => new VideoPlayer(source), []);
  const key = sourceUri(source);
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
  /** Android: show the controls when playback starts or pauses (ignored). */
  controllerAutoShow?: boolean;
  /** The style. */
  style?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/** The `<video>` fallback's style inside the slot: the slot's whole box. */
const FILL = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 };

/** Hand the player over to the native view `command` (or back to its `<video>`, when null). */
function linkNative(player: VideoPlayer, command: NativeLink["command"] | null): void {
  const inside = internalsOf(player);
  if (!command) {
    inside.link = null;
    return;
  }
  // Carry the `<video>`'s position and play state over, and silence it.
  const element = inside.element();
  const time = element?.currentTime ?? 0;
  const playing = inside.wantPlaying;
  element?.pause();
  const link: NativeLink = { command, playing: false, time, duration: 0 };
  inside.link = link;
  if (time > 0) command("seek", { seconds: time }).catch(() => {});
  if (playing) command("play").catch(() => {});
}

/** A native video view event, as the player's own events. */
function nativeEvent(player: VideoPlayer, name: string, data: unknown): void {
  const inside = internalsOf(player);
  const link = inside.link;
  const d = (data ?? {}) as { duration?: unknown; message?: unknown };
  if (name === "ready") {
    if (link && typeof d.duration === "number") link.duration = d.duration;
    inside.setStatus("readyToPlay");
  } else if (name === "play" || name === "pause") {
    const isPlaying = name === "play";
    if (link) link.playing = isPlaying;
    inside.emit("playingChange", { isPlaying, oldIsPlaying: !isPlaying });
  } else if (name === "ended") {
    if (link) link.playing = false;
    if (!player.loop) inside.wantPlaying = false;
    inside.emit("playToEnd", undefined);
  } else if (name === "error") inside.setStatus("error");
}

/** Re-render when the player's `loop`, `muted` or source change. */
function usePlayerRefresh(player: VideoPlayer): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const views = internalsOf(player).views;
    const refresh = () => setTick((n) => n + 1);
    views.add(refresh);
    return () => void views.delete(refresh);
  }, [player]);
}

/** The `<video>` fallback: the player's own element, mounted in a host view. */
function WebVideoView(props: VideoViewProps): VNode {
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
 * Shows a player's video: in the native video view where it is registered, else in the
 * player's `<video>`.
 *
 * @param props The player, controls, fit and style.
 * @returns The view.
 */
export function VideoView(props: VideoViewProps): VNode {
  const { player, nativeControls = true, contentFit = "contain" } = props;
  usePlayerRefresh(player);
  const onCommand = useCallback(
    (command: NativeLink["command"] | null) => linkNative(player, command),
    [player],
  );
  const onEvent = useCallback((name: string, data: unknown) => nativeEvent(player, name, data), [
    player,
  ]);
  useEffect(() => () => linkNative(player, null), [player]);
  const src = sourceUri(internalsOf(player).source());
  // A file in the app's own storage is read through a blob URL the native player cannot open.
  if (backing(src)) return h(WebVideoView, props);
  return h(NativeViewSlot, {
    type: "video",
    props: {
      src,
      controls: nativeControls,
      fit: contentFit === "contain" ? "contain" : "cover",
      loop: player.loop,
      muted: player.muted,
      autoplay: false,
    },
    onEvent,
    onCommand,
    style: {
      backgroundColor: "#000",
      overflow: "hidden",
      ...(flattenStyle(props.style) as Record<string, string | number | undefined>),
    },
    children: h(WebVideoView, { ...props, style: FILL }),
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
