/**
 * Background audio and the system's now-playing controls for `denext/mobile`: the lock screen,
 * Control Center and the media notification show what the page plays (title, artist, album,
 * artwork, duration, position) and route play / pause / next / previous / seek back to it.
 *
 * - In the iOS / Android shell, denext's `DenextNowPlaying` plugin (`denext mobile add
 *   background-audio`): an `AVAudioSession` in the `.playback` category with
 *   `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` on iOS (`UIBackgroundModes: audio`
 *   keeps the page's `<audio>` playing when the app is backgrounded or the phone locked); a
 *   `MediaSession`, a media-style notification and a `mediaPlayback` foreground service on
 *   Android.
 * - Everywhere else (the web, a Deno Desktop window, a shell without the plugin), the W3C Media
 *   Session API (`navigator.mediaSession`), where the engine has it; without it the calls do
 *   nothing.
 *
 * The page still plays the audio itself (an `<audio>` element, Web Audio, expo-audio's
 * player): these functions describe it to the OS and hand the OS's commands back.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { blobToBase64 } from "./base64.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/**
 * A command from the lock screen, Control Center, the media notification, a headset or a car:
 * `"seek"` carries the target `position`, `"seekForward"` / `"seekBackward"` the `offset`.
 */
export type MediaControlAction =
  | "play"
  | "pause"
  | "stop"
  | "next"
  | "previous"
  | "seek"
  | "seekForward"
  | "seekBackward";

/** Every {@linkcode MediaControlAction}, in a fixed order. */
const ACTIONS: readonly MediaControlAction[] = [
  "play",
  "pause",
  "stop",
  "next",
  "previous",
  "seek",
  "seekForward",
  "seekBackward",
];

/** The controls offered when {@linkcode NowPlayingInfo.controls} is not given. */
const DEFAULT_CONTROLS: readonly MediaControlAction[] = ["play", "pause", "seek"];

/** The skip interval of `seekForward` / `seekBackward` when none is given, in seconds. */
const DEFAULT_SEEK_OFFSET = 10;

/** What {@linkcode setNowPlaying} describes. Every field is optional and merged into the last. */
export interface NowPlayingInfo {
  /** The track's title. */
  readonly title?: string;
  /** The artist. */
  readonly artist?: string;
  /** The album. */
  readonly album?: string;
  /**
   * The artwork's URL: `http(s):`, `data:`, or a path of the app (resolved against the page and
   * read by the page, so the native side never needs to reach the app's own origin).
   */
  readonly artwork?: string;
  /** The length in seconds; leave it out (or `Infinity`) for a live stream. */
  readonly duration?: number;
  /** Where playback is, in seconds. */
  readonly position?: number;
  /** The playback rate (default 1). */
  readonly playbackRate?: number;
  /** Whether it is playing (default `false`). */
  readonly playing?: boolean;
  /**
   * The controls the OS offers (default `["play", "pause", "seek"]`). List `"next"` /
   * `"previous"` for a queue; `"seekForward"` / `"seekBackward"` show skip buttons (iOS shows
   * them instead of next / previous).
   */
  readonly controls?: readonly MediaControlAction[];
  /** The skip interval of `seekForward` / `seekBackward`, in seconds (default 10). */
  readonly seekOffset?: number;
}

/** A command the OS sent, for {@linkcode onMediaControl}. */
export interface MediaControlEvent {
  /** What the user asked for. */
  readonly action: MediaControlAction;
  /** `"seek"`: the position to go to, in seconds. */
  readonly position?: number;
  /** `"seekForward"` / `"seekBackward"`: how far to skip, in seconds. */
  readonly offset?: number;
}

/** How the app's audio meets other apps' audio, for {@linkcode setAudioSession}. */
export type AudioInterruption = "exclusive" | "mix" | "duck";

/** Options for {@linkcode setAudioSession}. */
export interface AudioSessionOptions {
  /**
   * Keep playing in the background and with the phone locked (default `true`). iOS: the
   * `.playback` category (it also plays with the silent switch on); `false` is `.soloAmbient`.
   * Android: the foreground media service runs while something is playing.
   */
  readonly background?: boolean;
  /**
   * `"exclusive"` (the default) pauses other apps' audio and is what the lock-screen controls
   * need on iOS; `"mix"` plays alongside it; `"duck"` lowers it. iOS only: Android's WebView
   * takes audio focus itself.
   */
  readonly interruption?: AudioInterruption;
}

/** The JS side of denext's `DenextNowPlaying` plugin. */
interface NowPlayingPlugin {
  configureSession(options: { background: boolean; interruption: AudioInterruption }): Promise<
    unknown
  >;
  setNowPlaying(info: NativeNowPlaying): Promise<unknown>;
  clearNowPlaying(): Promise<unknown>;
  addListener(
    eventName: "mediaControl",
    listener: (event: { action?: string; position?: number; offset?: number }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** What the plugin's `setNowPlaying` receives. */
interface NativeNowPlaying {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
  duration?: number;
  position: number;
  playbackRate: number;
  playing: boolean;
  controls: MediaControlAction[];
  seekOffset: number;
}

/** The slice of the W3C Media Session API used here. */
interface MediaSessionLike {
  metadata: unknown;
  playbackState: "none" | "paused" | "playing";
  setActionHandler(action: string, handler: ((details: MediaActionDetails) => void) | null): void;
  setPositionState?(state?: { duration: number; playbackRate: number; position: number }): void;
}

/** A Media Session action's details. */
interface MediaActionDetails {
  action?: string;
  seekTime?: number;
  seekOffset?: number;
}

/** {@linkcode MediaControlAction} → the Media Session action. */
const WEB_ACTIONS: Readonly<Record<MediaControlAction, string>> = {
  play: "play",
  pause: "pause",
  stop: "stop",
  next: "nexttrack",
  previous: "previoustrack",
  seek: "seekto",
  seekForward: "seekforward",
  seekBackward: "seekbackward",
};

/** The native plugin, when the shell has it. */
function nowPlayingPlugin(): NowPlayingPlugin | undefined {
  return nativePlugin<NowPlayingPlugin>("DenextNowPlaying", [
    "setNowPlaying",
    "clearNowPlaying",
    "addListener",
  ]);
}

/** `navigator.mediaSession`, where the engine has it. */
function mediaSession(): MediaSessionLike | undefined {
  const nav = (globalThis as { navigator?: { mediaSession?: MediaSessionLike } }).navigator;
  const session = nav?.mediaSession;
  return session && typeof session.setActionHandler === "function" ? session : undefined;
}

/** The handlers {@linkcode onMediaControl} registered. */
const handlers = new Set<(event: MediaControlEvent) => void>();
/** The native `mediaControl` listener's disposer while there are handlers. */
let stopNative: (() => void) | undefined;
/** The info merged from every {@linkcode setNowPlaying} since the last clear. */
let current: NowPlayingInfo = {};
/** What was last sent to the OS, to skip updates that only restate the clock. */
let lastSent: { key: string; position: number; at: number; rate: number; playing: boolean } | null =
  null;
/** Bumped by every update sent on (and by a clear), so a slower earlier one is dropped. */
let sendSeq = 0;
/** The last artwork resolved for the native side: its source and what was sent. */
let artworkCache: { source: string; resolved: Promise<string | undefined> } | null = null;

/** Hand `event` to every handler; one that throws does not stop the others. */
function dispatch(event: MediaControlEvent): void {
  for (const handler of [...handlers]) {
    try {
      handler(event);
    } catch (err) {
      console.error(err);
    }
  }
}

/** A native event as a {@linkcode MediaControlEvent}, or null for an unknown action. */
function fromNative(
  event: { action?: string; position?: number; offset?: number } | undefined,
): MediaControlEvent | null {
  const action = event?.action as MediaControlAction | undefined;
  if (!action || !ACTIONS.includes(action)) return null;
  return {
    action,
    ...(typeof event?.position === "number" ? { position: event.position } : {}),
    ...(typeof event?.offset === "number" ? { offset: event.offset } : {}),
  };
}

/** The finite, positive number `n`, else undefined. */
function positive(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The controls in `info`, known actions only, in their fixed order. */
function controlsOf(info: NowPlayingInfo): MediaControlAction[] {
  const asked = info.controls ?? DEFAULT_CONTROLS;
  return ACTIONS.filter((a) => asked.includes(a));
}

/** The current time in ms, for extrapolating the position. */
function now(): number {
  return typeof performance === "object" ? performance.now() : Date.now();
}

/**
 * Whether `info` restates what the OS already has: the same metadata, state and controls, and a
 * position within a second of where the last update's clock has run to by now. The OS advances
 * the position itself from the rate, so a page that reports every `timeupdate` sends only the
 * changes (a seek, a pause, a new track).
 */
function isRestatement(key: string, position: number, playing: boolean, rate: number): boolean {
  if (!lastSent || lastSent.key !== key || lastSent.playing !== playing) return false;
  const elapsed = playing ? ((now() - lastSent.at) / 1000) * lastSent.rate : 0;
  return lastSent.rate === rate && Math.abs(lastSent.position + elapsed - position) < 1;
}

/** Resolve `src` against the page and read an app-origin or `blob:` one into a `data:` URL. */
async function readArtwork(src: string): Promise<string | undefined> {
  const href = (globalThis as { location?: { href?: string } }).location?.href;
  let url: URL;
  try {
    url = new URL(src, href);
  } catch {
    return undefined;
  }
  if (url.protocol === "data:") return url.href;
  // Compared by scheme and host: `capacitor://localhost` has an opaque ("null") origin.
  const page = href ? new URL(href) : undefined;
  const local = url.protocol === "blob:" ||
    (page !== undefined && url.protocol === page.protocol && url.host === page.host);
  if (!local) return /^https?:$/.test(url.protocol) ? url.href : undefined;
  try {
    const response = await fetch(url.href);
    if (!response.ok) return undefined;
    const blob = await response.blob();
    return `data:${blob.type || "image/png"};base64,${await blobToBase64(blob)}`;
  } catch {
    return undefined;
  }
}

/** The artwork to send natively for `src`, read once per source. */
function nativeArtwork(src: string | undefined): Promise<string | undefined> {
  if (!src) return Promise.resolve(undefined);
  if (artworkCache?.source !== src) artworkCache = { source: src, resolved: readArtwork(src) };
  return artworkCache.resolved;
}

/** What the native plugin's `setNowPlaying` receives for `info` (its artwork read first). */
async function nativePayload(
  info: NowPlayingInfo,
  position: number,
  playbackRate: number,
): Promise<NativeNowPlaying> {
  const artwork = await nativeArtwork(info.artwork);
  const duration = positive(info.duration);
  const text = Object.fromEntries(
    (["title", "artist", "album"] as const).flatMap((k) =>
      info[k] === undefined ? [] : [[k, info[k]]]
    ),
  );
  return {
    ...text,
    ...(artwork === undefined ? {} : { artwork }),
    ...(duration === undefined ? {} : { duration }),
    position,
    playbackRate,
    playing: info.playing === true,
    controls: controlsOf(info),
    seekOffset: positive(info.seekOffset) ?? DEFAULT_SEEK_OFFSET,
  };
}

/** Point the Media Session's action handlers at {@linkcode dispatch} (or clear them). */
function applyWebHandlers(session: MediaSessionLike): void {
  const enabled = handlers.size > 0 && Object.keys(current).length > 0 ? controlsOf(current) : [];
  const offset = positive(current.seekOffset) ?? DEFAULT_SEEK_OFFSET;
  for (const action of ACTIONS) {
    const handler = !enabled.includes(action) ? null : (details: MediaActionDetails) => {
      if (action === "seek") {
        if (typeof details?.seekTime === "number") {
          dispatch({ action, position: details.seekTime });
        }
      } else if (action === "seekForward" || action === "seekBackward") {
        dispatch({ action, offset: positive(details?.seekOffset) ?? offset });
      } else dispatch({ action });
    };
    try {
      session.setActionHandler(WEB_ACTIONS[action], handler);
    } catch {
      // The engine does not support this action.
    }
  }
}

/** Describe `info` through the Media Session API. */
function setWebNowPlaying(session: MediaSessionLike, info: NowPlayingInfo): void {
  const Metadata = (globalThis as { MediaMetadata?: new (init: unknown) => unknown })
    .MediaMetadata;
  if (typeof Metadata === "function") {
    session.metadata = new Metadata({
      title: info.title ?? "",
      artist: info.artist ?? "",
      album: info.album ?? "",
      artwork: info.artwork ? [{ src: info.artwork }] : [],
    });
  }
  session.playbackState = info.playing ? "playing" : "paused";
  const duration = positive(info.duration);
  if (duration !== undefined) {
    try {
      session.setPositionState?.({
        duration,
        playbackRate: positive(info.playbackRate) ?? 1,
        position: Math.min(Math.max(info.position ?? 0, 0), duration),
      });
    } catch {
      // An engine that refuses the state keeps its own.
    }
  }
  applyWebHandlers(session);
}

/**
 * Show what is playing on the lock screen, in Control Center / the media notification, and on
 * headsets and cars, and offer the controls in `info.controls` there (they reach
 * {@linkcode onMediaControl}). Each call merges `info` into the last one, so after the first a
 * page sends what changed: `{ playing: false, position }` on pause, a new title for the next
 * track. Calls that only restate the clock (a `timeupdate` while playing) are not sent on: the
 * OS runs the position on from the rate.
 *
 * In the shell this needs `denext mobile add background-audio`; elsewhere it uses
 * `navigator.mediaSession` (nothing happens without it, or during SSR).
 *
 * @param info The track, its state and the controls to offer.
 * @returns A promise that settles once the OS has it. It rejects only when the native plugin
 * does.
 * @example
 * ```ts
 * import { onMediaControl, setAudioSession, setNowPlaying } from "denext/mobile";
 *
 * await setAudioSession({ background: true });
 * const audio = new Audio("/episodes/42.mp3");
 * onMediaControl(({ action, position }) => {
 *   if (action === "play") audio.play();
 *   if (action === "pause") audio.pause();
 *   if (action === "seek" && position !== undefined) audio.currentTime = position;
 * });
 * audio.addEventListener("play", () =>
 *   setNowPlaying({ title: "Episode 42", artist: "The Show", artwork: "/cover.jpg",
 *     duration: audio.duration, position: audio.currentTime, playing: true }));
 * audio.addEventListener("pause", () =>
 *   setNowPlaying({ playing: false, position: audio.currentTime }));
 * ```
 */
export async function setNowPlaying(info: NowPlayingInfo): Promise<void> {
  current = { ...current, ...info };
  const merged = current;
  const playing = merged.playing === true;
  const playbackRate = positive(merged.playbackRate) ?? 1;
  const position = Math.max(0, Number.isFinite(merged.position) ? merged.position! : 0);
  const { position: _p, ...rest } = merged;
  const key = JSON.stringify({
    ...rest,
    controls: controlsOf(merged),
    handlers: handlers.size > 0,
  });
  if (isRestatement(key, position, playing, playbackRate)) return;
  lastSent = { key, position, at: now(), rate: playbackRate, playing };
  const seq = ++sendSeq;
  const plugin = nowPlayingPlugin();
  if (plugin) {
    ensureNativeListener(plugin);
    const payload = await nativePayload(merged, position, playbackRate);
    // A newer update (or a clear) has taken over while the artwork was read.
    if (seq === sendSeq) await plugin.setNowPlaying(payload);
    return;
  }
  const session = mediaSession();
  if (session) setWebNowPlaying(session, { ...merged, position });
}

/**
 * Take the now-playing information and the controls off the lock screen (the media
 * notification goes, and on Android the foreground service stops). Call it when playback ends
 * for good, not on pause.
 *
 * @returns A promise that settles once the OS has dropped it.
 * @example
 * ```ts
 * import { clearNowPlaying } from "denext/mobile";
 *
 * audio.addEventListener("ended", () => clearNowPlaying());
 * ```
 */
export async function clearNowPlaying(): Promise<void> {
  sendSeq++;
  current = {};
  lastSent = null;
  artworkCache = null;
  const plugin = nowPlayingPlugin();
  if (plugin) {
    await plugin.clearNowPlaying();
    return;
  }
  const session = mediaSession();
  if (!session) return;
  session.metadata = null;
  session.playbackState = "none";
  applyWebHandlers(session);
  try {
    session.setPositionState?.();
  } catch {
    // Nothing to clear.
  }
}

/** Listen for the plugin's `mediaControl` events while there are handlers. */
function ensureNativeListener(plugin: NowPlayingPlugin): void {
  if (stopNative || handlers.size === 0) return;
  stopNative = listenerDisposer(plugin.addListener("mediaControl", (event) => {
    const control = fromNative(event);
    if (control) dispatch(control);
  }));
}

/**
 * Call `handler` with each command the OS sends for the now-playing item (lock screen, Control
 * Center, the media notification, headset buttons, a car); returns a function that stops
 * listening. Only the controls {@linkcode setNowPlaying} offered are sent. On the web the
 * handlers replace the browser's own media-key behaviour while any is registered.
 *
 * @param handler Called with the command: `action`, plus `position` for `"seek"` and `offset`
 * for `"seekForward"` / `"seekBackward"`.
 * @returns A function that removes the handler.
 * @example
 * ```ts
 * import { onMediaControl } from "denext/mobile";
 *
 * const stop = onMediaControl(({ action }) => {
 *   if (action === "next") queue.next();
 *   if (action === "previous") queue.previous();
 * });
 * ```
 */
export function onMediaControl(handler: (event: MediaControlEvent) => void): () => void {
  const wrapped = (event: MediaControlEvent) => handler(event);
  const wasEmpty = handlers.size === 0;
  handlers.add(wrapped);
  const plugin = nowPlayingPlugin();
  if (plugin) ensureNativeListener(plugin);
  else if (wasEmpty) {
    const session = mediaSession();
    if (session && Object.keys(current).length > 0) applyWebHandlers(session);
  }
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    handlers.delete(wrapped);
    if (handlers.size > 0) return;
    stopNative?.();
    stopNative = undefined;
    const session = plugin ? undefined : mediaSession();
    if (session) applyWebHandlers(session);
  };
}

/**
 * Hook form of {@linkcode onMediaControl}: handles the OS's media commands while the component
 * is mounted, always with the latest `handler`.
 *
 * @param handler Called with each command.
 * @example
 * ```tsx
 * "use client";
 * import { useMediaControl } from "denext/mobile";
 *
 * export function Player({ audio }: { audio: HTMLAudioElement }) {
 *   useMediaControl(({ action, position }) => {
 *     if (action === "play") audio.play();
 *     else if (action === "pause") audio.pause();
 *     else if (action === "seek" && position !== undefined) audio.currentTime = position;
 *   });
 *   return null;
 * }
 * ```
 */
export function useMediaControl(handler: (event: MediaControlEvent) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => onMediaControl((event) => latest.current(event)), []);
}

/**
 * Set how the app's audio behaves: whether it keeps playing in the background and with the
 * phone locked, and how it meets other apps' audio. In the iOS shell this sets the
 * `AVAudioSession` category (`.playback` for background audio) and activates it; on Android the
 * choice decides whether a foreground media service keeps playback alive; on the web (and
 * without the plugin) it does nothing, as a browser decides itself.
 *
 * Needs `denext mobile add background-audio` (which also declares the iOS `audio` background
 * mode and Android's media-playback foreground service).
 *
 * @param options `background` (default `true`) and `interruption` (default `"exclusive"`).
 * @returns A promise that settles once the session is set. It rejects when the OS refuses it.
 * @example
 * ```ts
 * import { setAudioSession } from "denext/mobile";
 *
 * await setAudioSession({ background: true, interruption: "exclusive" });
 * ```
 */
export async function setAudioSession(options: AudioSessionOptions = {}): Promise<void> {
  const interruption = options.interruption ?? "exclusive";
  if (!["exclusive", "mix", "duck"].includes(interruption)) {
    throw new TypeError(
      `setAudioSession: unknown interruption "${interruption}" (exclusive, mix or duck)`,
    );
  }
  const plugin = nativePlugin<NowPlayingPlugin>("DenextNowPlaying", ["configureSession"]);
  if (!plugin) return;
  await plugin.configureSession({ background: options.background !== false, interruption });
}

/** Forget every handler and the merged state (tests). */
export function resetNowPlayingForTesting(): void {
  handlers.clear();
  stopNative?.();
  stopNative = undefined;
  current = {};
  lastSent = null;
  artworkCache = null;
}
