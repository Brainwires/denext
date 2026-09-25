/**
 * `expo-audio` for denext: playback over an `HTMLAudioElement` and recording over
 * `MediaRecorder` (with metering from a Web Audio analyser), both of which Capacitor's web
 * views have.
 *
 * Provided: `useAudioPlayer` / `createAudioPlayer` / `useAudioPlayerStatus`,
 * `useAudioRecorder` / `useAudioRecorderState`, the recording presets and the permission
 * calls. The audio-session calls (`setAudioModeAsync`, `setIsAudioActiveAsync`) have no web
 * counterpart and resolve without effect. Playlists, streams, sample listeners and preloading
 * are not provided (see the manifest). A recording's `uri` is a `blob:` URL of a WebM (or
 * MP4, on Safari) file.
 *
 * @example
 * ```ts
 * import { useAudioPlayer, useAudioPlayerStatus } from "denext/expo/audio";
 *
 * const player = useAudioPlayer({ uri: url });
 * const status = useAudioPlayerStatus(player);
 * // status.playing ? player.pause() : player.play();
 * ```
 *
 * @module
 */

import { useEffect, useMemo, useRef, useState } from "../runtime/hooks.ts";
import {
  createEmitter,
  type Emitter,
  type PermissionExpiration,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
  requestMediaPermission,
  type Subscription,
  webPermission,
} from "./internal/common.ts";
import { backing, displayUrl } from "./internal/fs.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionResponse, Subscription };

/** An audio source: a URL, `{ uri }`, or null. */
export type AudioSource = string | { uri?: string; headers?: Record<string, string> } | null;

/** Options for a player. */
export interface AudioPlayerOptions {
  /** How often `playbackStatusUpdate` fires while playing, in ms (default 500). */
  updateInterval?: number;
}

/** A player's status. */
export interface AudioStatus {
  /** The player's id. */
  id: string;
  /** The position in seconds. */
  currentTime: number;
  /** `"playing"`, `"paused"`, `"ready"`, `"loading"` or `"ended"`. */
  playbackState: string;
  /** `"playing"`, `"paused"` or `"waitingToPlayAtSpecifiedRate"`. */
  timeControlStatus: string;
  /** Why it is waiting (empty here). */
  reasonForWaitingToPlay: string;
  /** Whether it is muted. */
  mute: boolean;
  /** The duration in seconds (0 until known). */
  duration: number;
  /** Whether it is playing. */
  playing: boolean;
  /** Whether it loops. */
  loop: boolean;
  /** Whether it just reached the end. */
  didJustFinish: boolean;
  /** Whether it is buffering. */
  isBuffering: boolean;
  /** Whether the source is loaded. */
  isLoaded: boolean;
  /** The playback rate. */
  playbackRate: number;
  /** Whether pitch is corrected at other rates. */
  shouldCorrectPitch: boolean;
}

let nextId = 0;

/** An audio player over an `HTMLAudioElement` (created on first use). */
export class AudioPlayer {
  /** The player's id. */
  readonly id: string = `audio-${++nextId}`;
  #element?: HTMLAudioElement;
  #source: AudioSource = null;
  #objectUrl?: string;
  #finished = false;
  #status?: Emitter<AudioStatus>;

  /**
   * Create it.
   *
   * @param source The source.
   * @param options The update interval (accepted; updates follow the media events).
   */
  constructor(source: AudioSource = null, _options: AudioPlayerOptions = {}) {
    this.#source = source;
  }

  /** The element, created with its event wiring on first use. */
  #audio(): HTMLAudioElement {
    if (this.#element) return this.#element;
    const audio = new Audio();
    audio.preload = "metadata";
    const report = () => this.#status?.emit(this.currentStatus);
    for (
      const type of [
        "play",
        "pause",
        "timeupdate",
        "loadedmetadata",
        "waiting",
        "playing",
        "ratechange",
        "volumechange",
      ]
    ) {
      audio.addEventListener(type, () => {
        if (type === "play") this.#finished = false;
        report();
      });
    }
    audio.addEventListener("ended", () => {
      this.#finished = true;
      report();
    });
    this.#element = audio;
    this.#load(this.#source);
    return audio;
  }

  /** Point the element at `source` (an app file is loaded through a `blob:` URL). */
  #load(source: AudioSource): void {
    const audio = this.#element;
    if (!audio) return;
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = undefined;
    const uri = typeof source === "string" ? source : source?.uri;
    if (!uri) return void audio.removeAttribute("src");
    if (!backing(uri)) return void (audio.src = uri);
    displayUrl(uri).then((url) => {
      this.#objectUrl = url;
      audio.src = url;
    }, () => {});
  }

  /** Whether it is playing. */
  get playing(): boolean {
    return this.#element ? !this.#element.paused && !this.#element.ended : false;
  }

  /** Whether the source is loaded. */
  get isLoaded(): boolean {
    return (this.#element?.readyState ?? 0) >= 1;
  }

  /** Whether it is buffering. */
  get isBuffering(): boolean {
    return (this.#element?.readyState ?? 4) < 3 && this.playing;
  }

  /** The position in seconds. */
  get currentTime(): number {
    return this.#element?.currentTime ?? 0;
  }

  /** The duration in seconds (0 until known). */
  get duration(): number {
    const d = this.#element?.duration ?? 0;
    return Number.isFinite(d) ? d : 0;
  }

  /** Whether it is muted. */
  get muted(): boolean {
    return this.#element?.muted ?? false;
  }
  set muted(value: boolean) {
    this.#audio().muted = value;
  }

  /** Whether it loops. */
  get loop(): boolean {
    return this.#element?.loop ?? false;
  }
  set loop(value: boolean) {
    this.#audio().loop = value;
  }

  /** The volume, 0–1. */
  get volume(): number {
    return this.#element?.volume ?? 1;
  }
  set volume(value: number) {
    this.#audio().volume = value;
  }

  /** The playback rate. */
  get playbackRate(): number {
    return this.#element?.playbackRate ?? 1;
  }
  set playbackRate(value: number) {
    this.#audio().playbackRate = value;
  }

  /** The status now. */
  get currentStatus(): AudioStatus {
    const playing = this.playing;
    return {
      id: this.id,
      currentTime: this.currentTime,
      playbackState: this.#finished
        ? "ended"
        : playing
        ? "playing"
        : this.isLoaded
        ? "ready"
        : "loading",
      timeControlStatus: playing ? "playing" : "paused",
      reasonForWaitingToPlay: "",
      mute: this.muted,
      duration: this.duration,
      playing,
      loop: this.loop,
      didJustFinish: this.#finished,
      isBuffering: this.isBuffering,
      isLoaded: this.isLoaded,
      playbackRate: this.playbackRate,
      shouldCorrectPitch: true,
    };
  }

  /** Start or resume playback. */
  play(): void {
    this.#audio().play().catch(() => {});
  }

  /** Pause playback. */
  pause(): void {
    this.#element?.pause();
  }

  /** Seek to `seconds`. */
  seekTo(seconds: number): Promise<void> {
    this.#audio().currentTime = seconds;
    return Promise.resolve();
  }

  /** Play `source` instead. */
  replace(source: AudioSource): void {
    this.#source = source;
    this.#finished = false;
    this.#load(source);
  }

  /** Listen for status updates. */
  addListener(
    _event: "playbackStatusUpdate",
    listener: (status: AudioStatus) => void,
  ): Subscription {
    this.#audio();
    return (this.#status ??= createEmitter()).subscribe(listener);
  }

  /** Stop and release the element. */
  remove(): void {
    this.#element?.pause();
    this.#element?.removeAttribute("src");
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#element = undefined;
  }
}

/**
 * A player not tied to a component (call `remove()` when done).
 *
 * @param source The source.
 * @param options The update interval.
 * @returns The player.
 */
export function createAudioPlayer(
  source: AudioSource = null,
  options?: AudioPlayerOptions,
): AudioPlayer {
  return new AudioPlayer(source, options);
}

/** A stable key for a source. */
function sourceKey(source: AudioSource): string {
  return typeof source === "string" ? source : source?.uri ?? "";
}

/**
 * A player for the component's lifetime (released on unmount; a new `source` replaces the
 * current one).
 *
 * @param source The source.
 * @param options The update interval.
 * @returns The player.
 */
export function useAudioPlayer(
  source: AudioSource = null,
  options?: AudioPlayerOptions,
): AudioPlayer {
  const player = useMemo(() => new AudioPlayer(source, options), []);
  const key = sourceKey(source);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else player.replace(source);
  }, [key]);
  useEffect(() => () => player.remove(), [player]);
  return player;
}

/**
 * The player's status, updated as it plays.
 *
 * @param player The player.
 * @returns The latest status.
 */
export function useAudioPlayerStatus(player: AudioPlayer): AudioStatus {
  const [status, setStatus] = useState<AudioStatus>(player.currentStatus);
  useEffect(() => {
    const sub = player.addListener("playbackStatusUpdate", setStatus);
    return () => sub.remove();
  }, [player]);
  return status;
}

/** Recording options (only `web` and `isMeteringEnabled` apply here). */
export interface RecordingOptions {
  /** The file extension. */
  extension?: string;
  /** The sample rate. */
  sampleRate?: number;
  /** The channel count. */
  numberOfChannels?: number;
  /** The bit rate. */
  bitRate?: number;
  /** Report `metering` in the recorder state. */
  isMeteringEnabled?: boolean;
  /** Android options (ignored). */
  android?: Record<string, unknown>;
  /** iOS options (ignored). */
  ios?: Record<string, unknown>;
  /** Web options: the MIME type and bit rate `MediaRecorder` uses. */
  web?: { mimeType?: string; bitsPerSecond?: number };
}

/** iOS audio quality (accepted, ignored). */
export enum AudioQuality {
  /** Min. */
  MIN = 0,
  /** Low. */
  LOW = 32,
  /** Medium. */
  MEDIUM = 64,
  /** High. */
  HIGH = 96,
  /** Max. */
  MAX = 127,
}

/** Expo's recording presets. */
export const RecordingPresets: {
  readonly HIGH_QUALITY: RecordingOptions;
  readonly LOW_QUALITY: RecordingOptions;
} = {
  HIGH_QUALITY: {
    extension: ".m4a",
    sampleRate: 44100,
    numberOfChannels: 2,
    bitRate: 128000,
    android: { outputFormat: "mpeg4", audioEncoder: "aac" },
    ios: { outputFormat: "aac ", audioQuality: AudioQuality.MAX },
    web: { mimeType: "audio/webm", bitsPerSecond: 128000 },
  },
  LOW_QUALITY: {
    extension: ".m4a",
    sampleRate: 44100,
    numberOfChannels: 2,
    bitRate: 64000,
    android: { extension: ".3gp", outputFormat: "3gp", audioEncoder: "amr_nb" },
    ios: { audioQuality: AudioQuality.MIN, outputFormat: "aac " },
    web: { mimeType: "audio/webm", bitsPerSecond: 128000 },
  },
};

/** A recorder's state. */
export interface RecorderState {
  /** Whether it is prepared. */
  canRecord: boolean;
  /** Whether it is recording. */
  isRecording: boolean;
  /** How long it has recorded, in ms. */
  durationMillis: number;
  /** Whether the media services reset (never here). */
  mediaServicesDidReset: boolean;
  /** The input level in dBFS (-160 silent to 0), with `isMeteringEnabled`. */
  metering?: number;
  /** The recording's URL once stopped. */
  url: string | null;
}

/** A recording outcome, for the status listener. */
export interface RecordingStatus {
  /** The recorder's id. */
  id: string;
  /** Whether the recording finished. */
  isFinished: boolean;
  /** Whether it failed. */
  hasError: boolean;
  /** The error message. */
  error: string | null;
  /** The recording's URL. */
  url: string | null;
  /** Whether the media services reset (never here). */
  mediaServicesDidReset?: boolean;
}

/** An audio recorder over `MediaRecorder`. */
export class AudioRecorder {
  /** The recorder's id. */
  readonly id: string = `recorder-${++nextId}`;
  /** The recording's `blob:` URL once stopped, else null. */
  uri: string | null = null;
  #options: RecordingOptions;
  #onStatus?: (status: RecordingStatus) => void;
  #stream?: MediaStream;
  #recorder?: MediaRecorder;
  #chunks: Blob[] = [];
  #startedAt = 0;
  #elapsed = 0;
  #analyser?: AnalyserNode;
  #context?: AudioContext;

  /**
   * Create it.
   *
   * @param options The recording options.
   * @param onStatus Called when a recording finishes or fails.
   */
  constructor(options: RecordingOptions, onStatus?: (status: RecordingStatus) => void) {
    this.#options = options;
    this.#onStatus = onStatus;
  }

  /** Whether it is recording. */
  get isRecording(): boolean {
    return this.#recorder?.state === "recording";
  }

  /** How long it has recorded, in seconds. */
  get currentTime(): number {
    return this.#duration() / 1000;
  }

  /** The recorded time in ms. */
  #duration(): number {
    return this.#elapsed + (this.isRecording ? Date.now() - this.#startedAt : 0);
  }

  /** Report an outcome to the status listener. */
  #report(error: string | null): void {
    this.#onStatus?.({
      id: this.id,
      isFinished: error === null,
      hasError: error !== null,
      error,
      url: this.uri,
    });
  }

  /** Open the microphone and get ready to record. */
  async prepareToRecordAsync(options?: RecordingOptions): Promise<void> {
    if (options) this.#options = options;
    this.#stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const web = this.#options.web ?? {};
    const mimeType = web.mimeType && MediaRecorder.isTypeSupported?.(web.mimeType)
      ? web.mimeType
      : undefined;
    const recorder = new MediaRecorder(this.#stream, {
      ...(mimeType ? { mimeType } : {}),
      ...(web.bitsPerSecond ? { audioBitsPerSecond: web.bitsPerSecond } : {}),
    });
    this.#chunks = [];
    this.#elapsed = 0;
    this.uri = null;
    recorder.ondataavailable = (e) => e.data.size > 0 && this.#chunks.push(e.data);
    recorder.onerror = () => this.#report("recording failed");
    this.#recorder = recorder;
    if (this.#options.isMeteringEnabled) this.#meter(this.#stream);
  }

  /** Measure the input level through a Web Audio analyser. */
  #meter(stream: MediaStream): void {
    const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Context) return;
    this.#context = new Context();
    this.#analyser = this.#context.createAnalyser();
    this.#analyser.fftSize = 1024;
    this.#context.createMediaStreamSource(stream).connect(this.#analyser);
  }

  /** The input level in dBFS, when metering. */
  #level(): number | undefined {
    if (!this.#analyser) return undefined;
    const samples = new Float32Array(this.#analyser.fftSize);
    this.#analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
    return rms > 0 ? Math.max(-160, 20 * Math.log10(rms)) : -160;
  }

  /** Start (or resume) recording. */
  record(): void {
    const recorder = this.#recorder;
    if (!recorder) throw new Error("record: call prepareToRecordAsync() first");
    if (recorder.state === "paused") recorder.resume();
    else if (recorder.state === "inactive") recorder.start();
    this.#startedAt = Date.now();
  }

  /** Pause recording. */
  pause(): void {
    if (!this.isRecording) return;
    this.#elapsed = this.#duration();
    this.#recorder!.pause();
  }

  /** Stop recording; `uri` then holds the recording. */
  async stop(): Promise<void> {
    const recorder = this.#recorder;
    if (!recorder || recorder.state === "inactive") return;
    this.#elapsed = this.#duration();
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    recorder.stop();
    await stopped;
    const blob = new Blob(this.#chunks, { type: recorder.mimeType || "audio/webm" });
    this.uri = URL.createObjectURL(blob);
    this.#release();
    this.#report(null);
  }

  /** Stop the microphone and the analyser. */
  #release(): void {
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = undefined;
    this.#context?.close().catch(() => {});
    this.#context = undefined;
    this.#analyser = undefined;
  }

  /** The state now. */
  getStatus(): RecorderState {
    const metering = this.#level();
    return {
      canRecord: this.#recorder !== undefined && this.#stream !== undefined,
      isRecording: this.isRecording,
      durationMillis: this.#duration(),
      mediaServicesDidReset: false,
      ...(metering === undefined ? {} : { metering }),
      url: this.uri,
    };
  }

  /** Stop and release everything (the hook calls it on unmount). */
  release(): void {
    if (this.#recorder?.state !== "inactive") this.#recorder?.stop();
    this.#release();
  }
}

/**
 * A recorder for the component's lifetime.
 *
 * @param options The recording options.
 * @param statusListener Called when a recording finishes or fails.
 * @returns The recorder.
 */
export function useAudioRecorder(
  options: RecordingOptions,
  statusListener?: (status: RecordingStatus) => void,
): AudioRecorder {
  const listener = useRef(statusListener);
  listener.current = statusListener;
  const recorder = useMemo(() => new AudioRecorder(options, (s) => listener.current?.(s)), []);
  useEffect(() => () => recorder.release(), [recorder]);
  return recorder;
}

/**
 * The recorder's state, polled every `interval` ms.
 *
 * @param recorder The recorder.
 * @param interval The poll interval (default 500).
 * @returns The latest state.
 */
export function useAudioRecorderState(recorder: AudioRecorder, interval = 500): RecorderState {
  const [state, setState] = useState<RecorderState>(() => recorder.getStatus());
  useEffect(() => {
    const timer = setInterval(() => setState(recorder.getStatus()), interval);
    return () => clearInterval(timer);
  }, [recorder, interval]);
  return state;
}

/**
 * Set the audio session mode: there is no audio session on the web, so nothing changes.
 *
 * @param _mode The mode.
 * @returns A promise that settles at once.
 */
export function setAudioModeAsync(_mode: Record<string, unknown>): Promise<void> {
  return Promise.resolve();
}

/**
 * Activate or deactivate the audio session: there is none on the web.
 *
 * @param _active Whether active.
 * @returns A promise that settles at once.
 */
export function setIsAudioActiveAsync(_active: boolean): Promise<void> {
  return Promise.resolve();
}

/**
 * The microphone permission (the browser's).
 *
 * @returns The permission.
 */
export async function getRecordingPermissionsAsync(): Promise<PermissionResponse> {
  return permissionResponse(await webPermission("microphone"));
}

/**
 * Ask for the microphone (a `getUserMedia` call, stopped at once).
 *
 * @returns The permission.
 */
export async function requestRecordingPermissionsAsync(): Promise<PermissionResponse> {
  return permissionResponse(await requestMediaPermission({ audio: true }));
}
