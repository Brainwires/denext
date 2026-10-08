/**
 * `expo-speech` for denext: text to speech.
 *
 * - In the Capacitor shell with `@capacitor-community/text-to-speech` (`denext mobile add
 *   text-to-speech`), the OS speech engine (AVSpeechSynthesizer / Android TextToSpeech):
 *   `onStart`, `onDone`, `onStopped`, `onError` and `onBoundary` (word ranges) are called;
 *   `pause` / `resume` reject with `ERR_UNAVAILABLE` (the plugin cannot pause), and a voice is
 *   picked by its `voiceURI` from `getAvailableVoicesAsync()`.
 * - Elsewhere, the Web Speech API (`speechSynthesis`: browsers, and the iOS WKWebView), with
 *   every callback and pause / resume. The Android System WebView has no `speechSynthesis`, so
 *   the Android shell needs the plugin.
 *
 * Utterances queue, as in Expo; `stop()` clears the queue.
 *
 * @example
 * ```ts
 * import * as Speech from "denext/expo/speech";
 *
 * Speech.speak("Hello", { language: "en-US", rate: 1.1, onDone: () => console.log("done") });
 * ```
 *
 * @module
 */

import { listenerDisposer, type ListenerHandle, nativePlugin } from "../mobile/plugin.ts";
import { CodedError, unavailable } from "./internal/common.ts";

/** A web speech event callback (`this` is the utterance). */
// deno-lint-ignore no-explicit-any
export type SpeechEventCallback = (this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => any;

/** What `onBoundary` receives from the native engine. */
export interface NativeBoundaryEvent {
  /** The word's first character. */
  charIndex: number;
  /** The word's length. */
  charLength: number;
}

/** A native boundary callback. */
export type NativeBoundaryEventCallback = (ev: NativeBoundaryEvent) => void;

/** How to speak, and what to call back. */
export interface SpeechOptions {
  /** The language (BCP 47, `"en-US"`). */
  language?: string;
  /** The pitch (1 is normal). */
  pitch?: number;
  /** The rate (1 is normal). */
  rate?: number;
  /** iOS: use the app's audio session (ignored). */
  useApplicationAudioSession?: boolean;
  /** Called when speaking starts. */
  onStart?: () => void | SpeechEventCallback;
  /** Called when `stop()` ends it. */
  onStopped?: () => void | SpeechEventCallback;
  /** Called when it finishes. */
  onDone?: () => void | SpeechEventCallback;
  /** Called when it fails. */
  onError?: (error: Error) => void | SpeechEventCallback;
  /** The volume, 0–1. */
  volume?: number;
  /** The voice's identifier (`getAvailableVoicesAsync()`). */
  voice?: string;
  /** A voice by index (Expo's web build). */
  _voiceIndex?: number;
  /** Called at each word. */
  onBoundary?: NativeBoundaryEventCallback | SpeechEventCallback | null;
  /** Web: called at an SSML mark. */
  onMark?: SpeechEventCallback | null;
  /** Web: called when paused. */
  onPause?: SpeechEventCallback | null;
  /** Web: called when resumed. */
  onResume?: SpeechEventCallback | null;
}

/** A voice's quality. */
export enum VoiceQuality {
  /** Standard. */
  Default = "Default",
  /** Enhanced (downloaded). */
  Enhanced = "Enhanced",
}

/** A voice. */
export interface Voice {
  /** Its identifier (pass as `voice`). */
  identifier: string;
  /** Its name. */
  name: string;
  /** Its quality. */
  quality: VoiceQuality;
  /** Its language. */
  language: string;
}

/** A voice as the Web Speech API (and the plugin) describes it. */
export type WebVoice = Voice & {
  /** Whether it is the default voice. */
  isDefault: boolean;
  /** Whether it runs on the device. */
  localService: boolean;
  /** Its name. */
  name: string;
  /** Its URI (the identifier). */
  voiceURI: string;
};

/** The longest text one `speak` takes (the Web Speech API's limit; Expo's web value). */
export const maxSpeechInputLength: number = 32767;

/** A voice as the plugin and the Web Speech API report it. */
interface RawVoice {
  default?: boolean;
  lang: string;
  localService?: boolean;
  name: string;
  voiceURI: string;
}

/** `@capacitor-community/text-to-speech`, the calls used here. */
interface TextToSpeechPlugin {
  speak(options: {
    text: string;
    lang?: string;
    rate?: number;
    pitch?: number;
    volume?: number;
    voice?: number;
    queueStrategy?: number;
  }): Promise<void>;
  stop(): Promise<void>;
  getSupportedVoices(): Promise<{ voices: RawVoice[] }>;
  addListener(
    event: "onRangeStart",
    fn: (info: { start: number; end: number; spokenWord: string }) => void,
  ): Promise<ListenerHandle> | ListenerHandle;
}

/** The shell's speech plugin, if installed. */
function speechPlugin(): TextToSpeechPlugin | undefined {
  return nativePlugin<TextToSpeechPlugin>("TextToSpeech", ["speak", "stop", "getSupportedVoices"]);
}

/** The Web Speech API's synthesizer, if any. */
function synth(): SpeechSynthesis | undefined {
  return (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
}

/** A voice in Expo's shape. */
function toVoice(raw: RawVoice): WebVoice {
  return {
    identifier: raw.voiceURI,
    name: raw.name,
    quality: VoiceQuality.Default,
    language: raw.lang,
    isDefault: Boolean(raw.default),
    localService: Boolean(raw.localService),
    voiceURI: raw.voiceURI,
  };
}

/** The Web Speech API's voices, once it has loaded them. */
function webVoices(s: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const now = s.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      s.removeEventListener?.("voiceschanged", done);
      resolve(s.getVoices());
    };
    s.addEventListener?.("voiceschanged", done);
    // Some engines never fire voiceschanged when they have no voices.
    setTimeout(done, 1000);
  });
}

/** The index of the voice to use, or undefined for the default. */
function voiceIndex(voices: readonly RawVoice[], options: SpeechOptions): number | undefined {
  if (typeof options.voice === "string") {
    const i = voices.findIndex((v) => v.voiceURI === options.voice);
    if (i >= 0) return i;
  }
  if (typeof options._voiceIndex === "number" && voices.length > 0) {
    return Math.min(voices.length - 1, Math.max(0, options._voiceIndex));
  }
  return undefined;
}

/** The utterances queued for the plugin (spoken one at a time), so `stop()` can drop them. */
const nativeQueue = new Set<SpeechOptions>();

/** The end of the plugin's queue: each utterance starts when the one before it settles. */
let nativeTail: Promise<void> = Promise.resolve();

/** Queue one utterance for the shell's plugin. */
function speakNative(plugin: TextToSpeechPlugin, text: string, options: SpeechOptions): void {
  nativeQueue.add(options);
  nativeTail = nativeTail.then(() => speakNativeNow(plugin, text, options));
}

/** Speak one queued utterance through the plugin, unless `stop()` dropped it. */
async function speakNativeNow(plugin: TextToSpeechPlugin, text: string, options: SpeechOptions) {
  if (!nativeQueue.has(options)) return;
  let disposeRange: (() => void) | undefined;
  try {
    const voices = typeof options.voice === "string" || options._voiceIndex !== undefined
      ? (await plugin.getSupportedVoices()).voices
      : [];
    if (typeof options.onBoundary === "function") {
      const onBoundary = options.onBoundary as NativeBoundaryEventCallback;
      disposeRange = listenerDisposer(
        plugin.addListener("onRangeStart", (info) => {
          onBoundary({ charIndex: info.start, charLength: info.end - info.start });
        }),
      );
    }
    options.onStart?.();
    await plugin.speak({
      text,
      lang: options.language,
      rate: options.rate,
      pitch: options.pitch,
      volume: options.volume,
      voice: voiceIndex(voices, options),
      queueStrategy: 1, // Add: never cut off another speaker (this queue is already serial).
    });
    if (nativeQueue.delete(options)) options.onDone?.();
  } catch (err) {
    if (nativeQueue.delete(options)) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    disposeRange?.();
  }
}

/** Speak through the Web Speech API. */
async function speakWeb(s: SpeechSynthesis, text: string, options: SpeechOptions) {
  const Utterance = (globalThis as {
    SpeechSynthesisUtterance?: new (text?: string) => SpeechSynthesisUtterance;
  }).SpeechSynthesisUtterance!;
  const message = new Utterance(text);
  if (typeof options.rate === "number") message.rate = options.rate;
  if (typeof options.pitch === "number") message.pitch = options.pitch;
  if (typeof options.volume === "number") message.volume = options.volume;
  if (typeof options.language === "string") message.lang = options.language;
  if (typeof options.voice === "string" || options._voiceIndex !== undefined) {
    const voices = await webVoices(s);
    const i = voiceIndex(voices, options);
    if (i !== undefined) message.voice = voices[i];
  }
  // deno-lint-ignore no-explicit-any
  const on = message as any;
  if (options.onBoundary) on.onboundary = options.onBoundary;
  if (options.onMark) on.onmark = options.onMark;
  if (options.onPause) on.onpause = options.onPause;
  if (options.onResume) on.onresume = options.onResume;
  on.onstart = () => options.onStart?.();
  on.onend = () => options.onDone?.();
  on.onerror = (event: { error?: string }) => {
    // A cancel (stop()) is reported as "canceled" / "interrupted": that is onStopped.
    if (event?.error === "canceled" || event?.error === "interrupted") options.onStopped?.();
    else options.onError?.(new Error(event?.error ?? "speech failed"));
  };
  s.speak(message);
}

/**
 * Speak `text`, after anything already queued.
 *
 * @param text What to say (at most {@linkcode maxSpeechInputLength} characters).
 * @param options The voice, language, rate, pitch, volume and callbacks.
 */
export function speak(text: string, options: SpeechOptions = {}): void {
  const value = String(text);
  if (value.length > maxSpeechInputLength) {
    throw new CodedError(
      "ERR_SPEECH_INPUT_LENGTH",
      `Speech input text is too long! Limit of input length is: ${maxSpeechInputLength}`,
    );
  }
  const plugin = speechPlugin();
  if (plugin) {
    speakNative(plugin, value, options);
    return;
  }
  const s = synth();
  if (s) {
    speakWeb(s, value, options).catch((err) => options.onError?.(err));
    return;
  }
  queueMicrotask(() =>
    options.onError?.(
      unavailable(
        "expo-speech",
        "speak",
        "There is no speech engine here: in the Android shell run `denext mobile add " +
          "text-to-speech`.",
      ),
    )
  );
}

/**
 * The voices the engine has.
 *
 * @returns The voices (none where there is no engine).
 */
export async function getAvailableVoicesAsync(): Promise<Voice[]> {
  const plugin = speechPlugin();
  if (plugin) return (await plugin.getSupportedVoices()).voices.map(toVoice);
  const s = synth();
  return s ? (await webVoices(s)).map(toVoice) : [];
}

/**
 * Whether it is speaking.
 *
 * @returns Whether an utterance is being spoken (or queued, natively).
 */
export function isSpeakingAsync(): Promise<boolean> {
  if (speechPlugin()) return Promise.resolve(nativeQueue.size > 0);
  return Promise.resolve(Boolean(synth()?.speaking));
}

/** Stop speaking and drop the queue; each dropped utterance's `onStopped` is called. */
export async function stop(): Promise<void> {
  const plugin = speechPlugin();
  if (plugin) {
    const stopped = [...nativeQueue];
    nativeQueue.clear();
    await plugin.stop();
    for (const options of stopped) options.onStopped?.();
    return;
  }
  synth()?.cancel();
}

/**
 * Pause (the Web Speech API only).
 *
 * @throws `ERR_UNAVAILABLE` with the shell's plugin, which cannot pause.
 */
export function pause(): Promise<void> {
  if (speechPlugin()) {
    return Promise.reject(unavailable("expo-speech", "pause", "The speech plugin cannot pause."));
  }
  synth()?.pause();
  return Promise.resolve();
}

/**
 * Resume after {@linkcode pause} (the Web Speech API only).
 *
 * @throws `ERR_UNAVAILABLE` with the shell's plugin.
 */
export function resume(): Promise<void> {
  if (speechPlugin()) {
    return Promise.reject(unavailable("expo-speech", "resume", "The speech plugin cannot pause."));
  }
  synth()?.resume();
  return Promise.resolve();
}
