/**
 * Text to speech for `denext/mobile`: `speak()` / `stopSpeaking()` on whatever engine the page has.
 *
 * 1. In the Capacitor shell with `@capacitor-community/text-to-speech` (`denext mobile add
 *    text-to-speech`): the OS engine (AVSpeechSynthesizer, Android TextToSpeech).
 * 2. Else the Web Speech API (`speechSynthesis`): browsers, the iOS WKWebView, and the Deno Desktop
 *    window's engine on macOS (WKWebView), Windows (WebView2) and CEF on macOS / Windows.
 * 3. Else, in a Deno Desktop window, the runtime's OS speech (the `textToSpeech` capability over
 *    `Deno.desktop.speech`, for WebKitGTK on Linux) once the runtime has it.
 *
 * Elsewhere (the Android WebView without the plugin) a call rejects `unavailable`.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";
import { onDesktop } from "./desktop-branch.ts";

/** How to speak. */
export interface SpeakOptions {
  /** The language (BCP 47, `"en-US"`). */
  readonly lang?: string;
  /** A voice by name (Web Speech) or id (the OS engine); the language's default otherwise. */
  readonly voice?: string;
  /** The rate, 1 is normal (0.1–10). */
  readonly rate?: number;
  /** The pitch, 1 is normal (0–2). */
  readonly pitch?: number;
  /** The volume, 0–1 (default 1). */
  readonly volume?: number;
}

/** `@capacitor-community/text-to-speech`, the calls used here. */
interface TextToSpeechPlugin {
  speak(options: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}

/** The plugin, in the shell with it installed. */
function plugin(): TextToSpeechPlugin | undefined {
  return nativePlugin<TextToSpeechPlugin>("TextToSpeech", ["speak", "stop"]);
}

/** The page's `speechSynthesis`, when it has one. */
function synth(): SpeechSynthesis | undefined {
  const s = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  return typeof s?.speak === "function" ? s : undefined;
}

/** An `unavailable` error, coded like the bridge's. */
function unavailable(): Error {
  return Object.assign(new Error("speak: there is no speech engine here"), {
    code: "unavailable",
  });
}

/** Speak through Web Speech, resolving when the utterance ends (or is stopped). */
function speakWeb(s: SpeechSynthesis, text: string, options: SpeakOptions): Promise<void> {
  const Utterance = (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance })
    .SpeechSynthesisUtterance;
  if (typeof Utterance !== "function") return Promise.reject(unavailable());
  const u = new Utterance(text);
  if (options.lang !== undefined) u.lang = options.lang;
  if (options.rate !== undefined) u.rate = options.rate;
  if (options.pitch !== undefined) u.pitch = options.pitch;
  if (options.volume !== undefined) u.volume = options.volume;
  if (options.voice !== undefined) {
    const voice = s.getVoices().find((v) =>
      v.name === options.voice || v.voiceURI === options.voice
    );
    if (voice) u.voice = voice;
  }
  return new Promise((resolve, reject) => {
    u.onend = () => resolve();
    u.onerror = (event: { error?: string }) => {
      if (event?.error === "canceled" || event?.error === "interrupted") resolve();
      else reject(new Error(`speak: ${event?.error ?? "speech failed"}`));
    };
    s.speak(u);
  });
}

/**
 * Say `text` aloud, after anything already being spoken.
 *
 * @param text What to say.
 * @param options The language, voice, rate, pitch and volume.
 * @returns A promise that settles once it has been said (or stopped). It rejects `unavailable`
 * where there is no speech engine.
 * @example
 * ```ts
 * import { speak } from "denext/mobile";
 *
 * await speak("Your build finished", { lang: "en-US", rate: 1.1 });
 * ```
 */
export async function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  const native = plugin();
  if (native) {
    await native.speak({
      text,
      ...(options.lang !== undefined ? { lang: options.lang } : {}),
      ...(options.rate !== undefined ? { rate: options.rate } : {}),
      ...(options.pitch !== undefined ? { pitch: options.pitch } : {}),
      ...(options.volume !== undefined ? { volume: options.volume } : {}),
    });
    return;
  }
  const s = synth();
  if (s) return await speakWeb(s, text, options);
  if (onDesktop()) {
    const { desktopRpc } = await import("../desktop/bridge-client.ts");
    await desktopRpc("textToSpeech", "speak", { text, ...options }, { timeoutMs: false });
    return;
  }
  throw unavailable();
}

/**
 * Stop speaking, and drop what is queued.
 *
 * @returns A promise that settles once stopped.
 */
export async function stopSpeaking(): Promise<void> {
  const native = plugin();
  if (native) return await native.stop();
  const s = synth();
  if (s) return s.cancel();
  if (onDesktop()) {
    const { desktopRpc } = await import("../desktop/bridge-client.ts");
    await desktopRpc("textToSpeech", "stop", {}).catch(() => {});
  }
}
