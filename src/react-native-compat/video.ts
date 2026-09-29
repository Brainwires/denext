/**
 * `react-native-video` for denext (React Native mode): `Video` is `denext/mobile`'s native
 * `"video"` view where it is registered (AVPlayer with the system controls on iOS, drawn under
 * the page, and a vertical swipe on it scrolls the page: `denext mobile add native-views`), and
 * an HTML `<video>` everywhere else. React Native mode resolves the package here, so one import
 * gets the native player in the shell and a working player in a browser.
 *
 * `source` (`{ uri }` or a URL), `paused`, `muted`, `repeat`, `controls` and `resizeMode`
 * (`contain`, `cover`; `stretch` draws `cover`), `onLoad` (`duration`), `onEnd`, `onError` and
 * `onPlaybackStateChanged` work on both; `onProgress`, `volume`, `rate` and `poster` apply to the
 * `<video>` only. The ref's `seek`, `pause`, `resume` and `getCurrentPosition` reach either
 * player; `presentFullscreenPlayer` asks the `<video>` for fullscreen. Text tracks, DRM, ads,
 * Picture in Picture and the other `react-native-video` props are accepted and ignored.
 *
 * @example
 * ```ts
 * import Video from "react-native-video"; // → this module
 * import { h } from "denext/jsx-runtime";
 *
 * h(Video, { source: { uri: "https://example.com/clip.mp4" }, controls: true, style: { height: 220 } });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useCallback, useEffect, useImperativeHandle, useRef } from "../runtime/hooks.ts";
import { NativeViewSlot, type NativeViewSlotHandle } from "../mobile/native-view.ts";
import { flattenStyle } from "../expo/internal/common.ts";

/** How the video fills its view. */
export enum ResizeMode {
  /** No scaling. */
  NONE = "none",
  /** Letterboxed. */
  CONTAIN = "contain",
  /** Cropped to fill. */
  COVER = "cover",
  /** Stretched to fill. */
  STRETCH = "stretch",
}

/** A video source. */
export type VideoSource = string | { uri?: string; headers?: Record<string, string> } | number;

/** `onLoad`'s payload. */
export interface OnLoadData {
  /** The length in seconds. */
  duration: number;
  /** The position in seconds. */
  currentTime: number;
  /** The frame size (0 × 0 when unknown). */
  naturalSize: { width: number; height: number; orientation: "landscape" | "portrait" };
}

/** `onProgress`'s payload. */
export interface OnProgressData {
  /** The position in seconds. */
  currentTime: number;
  /** How far is buffered, in seconds. */
  playableDuration: number;
  /** The length in seconds. */
  seekableDuration: number;
}

/** `Video` props. */
export interface ReactVideoProps {
  /** What to play. */
  source?: VideoSource;
  /** Paused (default `false`: plays once loaded). */
  paused?: boolean;
  /** Muted. */
  muted?: boolean;
  /** Loop. */
  repeat?: boolean;
  /** Show the player's controls. */
  controls?: boolean;
  /** How the video fills the view (default `contain`). */
  resizeMode?: ResizeMode | "none" | "contain" | "cover" | "stretch";
  /** The volume, 0–1 (`<video>` only). */
  volume?: number;
  /** The playback rate (`<video>` only). */
  rate?: number;
  /** A poster image URL (`<video>` only). */
  poster?: string | { source?: { uri?: string } };
  /** Loaded. */
  onLoad?: (data: OnLoadData) => void;
  /** Playing progressed (`<video>` only). */
  onProgress?: (data: OnProgressData) => void;
  /** Reached the end. */
  onEnd?: () => void;
  /** Failed. */
  onError?: (error: { error: { errorString: string } }) => void;
  /** Started or stopped playing. */
  onPlaybackStateChanged?: (state: { isPlaying: boolean; isSeeking: boolean }) => void;
  /** The style. */
  style?: unknown;
  /** The ref (a {@linkcode VideoRef}). */
  ref?: unknown;
  /** Other props: ignored. */
  [prop: string]: unknown;
}

/** What a `Video` ref offers. */
export interface VideoRef {
  /** Jump to `time` seconds. */
  seek(time: number, tolerance?: number): void;
  /** Pause. */
  pause(): void;
  /** Play. */
  resume(): void;
  /** Go fullscreen (the `<video>`; the native player's controls have their own button). */
  presentFullscreenPlayer(): void;
  /** Leave fullscreen. */
  dismissFullscreenPlayer(): void;
  /** Set the volume, 0–1 (`<video>` only). */
  setVolume(volume: number): void;
  /** The position in seconds. */
  getCurrentPosition(): Promise<number>;
}

/** The URL of a source (a bundled asset number has none here). */
function sourceUrl(source: VideoSource | undefined): string {
  if (typeof source === "string") return source;
  return typeof source === "object" && source ? source.uri ?? "" : "";
}

/** The poster URL. */
function posterUrl(poster: ReactVideoProps["poster"]): string | undefined {
  return typeof poster === "string" ? poster : poster?.source?.uri;
}

/** What both players share: the latest props, the native runner and the `<video>`. */
interface VideoState {
  props: ReactVideoProps;
  command: NativeViewSlotHandle["command"] | null;
  element: HTMLVideoElement | null;
  position: number;
}

/** The ref over whichever player is showing. */
function videoRef(state: { current: VideoState }): VideoRef {
  const native = (name: string, args?: Record<string, unknown>) =>
    state.current.command?.(name, args).then((r) => {
      const t = (r as { currentTime?: unknown } | undefined)?.currentTime;
      if (typeof t === "number") state.current.position = t;
      return r;
    }).catch(() => undefined);
  return {
    seek(time) {
      if (state.current.command) void native("seek", { seconds: time });
      else if (state.current.element) state.current.element.currentTime = time;
    },
    pause() {
      if (state.current.command) void native("pause");
      else state.current.element?.pause();
    },
    resume() {
      if (state.current.command) void native("play");
      else state.current.element?.play().catch(() => {});
    },
    presentFullscreenPlayer() {
      state.current.element?.requestFullscreen?.().catch(() => {});
    },
    dismissFullscreenPlayer() {
      const doc = globalThis.document as Document | undefined;
      if (doc?.fullscreenElement) doc.exitFullscreen?.().catch(() => {});
    },
    setVolume(volume) {
      if (state.current.element) state.current.element.volume = volume;
    },
    async getCurrentPosition() {
      if (state.current.command) await native("status");
      return state.current.element?.currentTime ?? state.current.position;
    },
  };
}

/** The native player's events, as the props' callbacks. */
function onNativeEvent(state: { current: VideoState }, name: string, data: unknown): void {
  const p = state.current.props;
  if (name === "ready") {
    const duration = Number((data as { duration?: unknown } | null)?.duration) || 0;
    p.onLoad?.({
      duration,
      currentTime: 0,
      naturalSize: { width: 0, height: 0, orientation: "landscape" },
    });
  } else if (name === "ended") p.onEnd?.();
  else if (name === "play" || name === "pause") {
    p.onPlaybackStateChanged?.({ isPlaying: name === "play", isSeeking: false });
  } else if (name === "error") {
    const message = String((data as { message?: unknown } | null)?.message ?? "playback failed");
    p.onError?.({ error: { errorString: message } });
  }
}

/** The `<video>`'s event handlers, as the props' callbacks. */
function webHandlers(state: { current: VideoState }): Record<string, (e: Event) => void> {
  const p = () => state.current.props;
  const el = (e: Event) => e.currentTarget as HTMLVideoElement;
  return {
    onLoadedMetadata(e) {
      const v = el(e);
      p().onLoad?.({
        duration: Number.isFinite(v.duration) ? v.duration : 0,
        currentTime: v.currentTime,
        naturalSize: {
          width: v.videoWidth,
          height: v.videoHeight,
          orientation: v.videoHeight > v.videoWidth ? "portrait" : "landscape",
        },
      });
    },
    onTimeUpdate(e) {
      const v = el(e);
      p().onProgress?.({
        currentTime: v.currentTime,
        playableDuration: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
        seekableDuration: Number.isFinite(v.duration) ? v.duration : 0,
      });
    },
    onEnded: () => p().onEnd?.(),
    onPlay: () => p().onPlaybackStateChanged?.({ isPlaying: true, isSeeking: false }),
    onPause: () => p().onPlaybackStateChanged?.({ isPlaying: false, isSeeking: false }),
    onError: () => p().onError?.({ error: { errorString: "the video could not be played" } }),
  };
}

/** Keep the `<video>`'s play state, volume and rate on the props. */
function useWebPlayback(state: { current: VideoState }, props: ReactVideoProps): void {
  useEffect(() => {
    const v = state.current.element;
    if (!v) return;
    if (props.paused) v.pause();
    else v.play().catch(() => {});
  }, [props.paused]);
  useEffect(() => {
    const v = state.current.element;
    if (v && typeof props.volume === "number") v.volume = Math.max(0, Math.min(1, props.volume));
    if (v && typeof props.rate === "number" && props.rate > 0) v.playbackRate = props.rate;
  }, [props.volume, props.rate]);
}

/**
 * A video: the native player where it is registered, else a `<video>`.
 *
 * @param props The source, playback state, callbacks and style.
 * @returns The view.
 */
export function Video(props: ReactVideoProps): VNode {
  const state = useRef<VideoState>({ props, command: null, element: null, position: 0 });
  state.current.props = props;
  useImperativeHandle(props.ref as never, () => videoRef(state), []);
  useWebPlayback(state, props);
  const onEvent = useCallback(
    (name: string, data: unknown) => onNativeEvent(state, name, data),
    [],
  );
  const onCommand = useCallback((command: VideoState["command"]) => {
    state.current.command = command;
  }, []);
  // A `paused` change after the view is native: play or pause it.
  const nativePaused = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const command = state.current.command;
    if (!command || nativePaused.current === !!props.paused) return;
    nativePaused.current = !!props.paused;
    command(props.paused ? "pause" : "play").catch(() => {});
  });
  const src = sourceUrl(props.source);
  const fit = props.resizeMode === "cover" || props.resizeMode === "stretch" ? "cover" : "contain";
  const style = flattenStyle(props.style) as Record<string, string | number | undefined>;
  const video = h("video", {
    ref: (el: HTMLVideoElement | null) => void (state.current.element = el),
    src: src || undefined,
    poster: posterUrl(props.poster),
    controls: props.controls === true,
    loop: props.repeat === true,
    muted: props.muted === true,
    autoPlay: !props.paused,
    playsInline: true,
    preload: "metadata",
    style: { width: "100%", height: "100%", objectFit: fit, backgroundColor: "#000" },
    ...webHandlers(state),
  });
  return h(NativeViewSlot, {
    type: "video",
    props: {
      src,
      controls: props.controls === true,
      loop: props.repeat === true,
      muted: props.muted === true,
      autoplay: !props.paused,
      fit,
    },
    onEvent,
    onCommand,
    style: { backgroundColor: "#000", overflow: "hidden", ...style },
    children: video,
  });
}

/** The package's default export: {@linkcode Video}. */
export default Video;
