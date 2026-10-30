/**
 * The `textToSpeech` capability: the OS's text to speech in the desktop app's process
 * (`Deno.desktop.speech`: AVSpeechSynthesizer on macOS, SAPI / WinRT on Windows, speech-dispatcher
 * on Linux) for `speak()` in `denext/mobile` where the window's engine has no Web Speech
 * (WebKitGTK). No Deno Desktop runtime has `Deno.desktop.speech` yet: until one does, every call
 * answers `unsupported` and `capabilities` reports `native: false`, and `speak()` keeps using the
 * page's own `speechSynthesis` (WKWebView, WebView2, CEF on macOS and Windows).
 *
 * Registered by `runDesktop` for every app (it needs no Deno permission).
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import type { DesktopAppApi } from "../launch-events.ts";

/** The longest text one call speaks. */
const MAX_TEXT = 32 * 1024;

/** `unsupported` (501): this runtime has no OS speech. */
function noSpeech(): DesktopCapError {
  const reason = "this Deno Desktop runtime has no Deno.desktop.speech";
  return new DesktopCapError("unsupported", `text to speech is not available here: ${reason}`, {
    status: 501,
    data: { reason },
  });
}

/** A `validation` error. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/** An optional number in [min, max]. */
function rangeOpt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

/** An optional short string. */
function textOpt(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 256) {
    throw invalid(`${name} must be a string up to 256 characters`);
  }
  return value;
}

/** The checked `speak` arguments. */
function speakArgs(args: unknown): {
  text: string;
  options: { voice?: string; lang?: string; rate?: number; pitch?: number; volume?: number };
} {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (typeof a.text !== "string" || a.text.length > MAX_TEXT) {
    throw invalid(`text must be a string up to ${MAX_TEXT} characters`);
  }
  const options = {
    voice: textOpt(a.voice, "voice"),
    lang: textOpt(a.lang, "lang"),
    rate: rangeOpt(a.rate, "rate", 0.1, 10),
    pitch: rangeOpt(a.pitch, "pitch", 0, 2),
    volume: rangeOpt(a.volume, "volume", 0, 1),
  };
  return {
    text: a.text,
    options: Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
  };
}

/**
 * Create the `textToSpeech` capability over `Deno.desktop.speech` (feature-detected per call).
 *
 * @param api `Deno.desktop` (default the runtime's at call time; tests pass a fake).
 * @returns The capability.
 */
export function createSpeechCapability(
  api: () => DesktopAppApi | undefined,
): DesktopCapability {
  const speech = () => {
    const s = api()?.speech;
    return typeof s?.speak === "function" ? s : undefined;
  };
  return {
    name: "textToSpeech",
    methods: {
      capabilities: { handler: () => ({ native: speech() !== undefined }) },
      speak: {
        timeoutMs: false, // as long as the text takes to say
        handler: async (args) => {
          const { text, options } = speakArgs(args);
          const s = speech();
          if (!s) throw noSpeech();
          await s.speak(text, options);
          return null;
        },
      },
      stop: {
        handler: () => {
          const s = speech();
          if (!s) throw noSpeech();
          s.stop();
          return null;
        },
      },
      voices: {
        handler: async () => {
          const s = speech();
          if (!s) throw noSpeech();
          const list = await s.voices?.() ?? [];
          return list.slice(0, 512).map((v) => ({
            id: String(v.id),
            name: String(v.name),
            lang: String(v.lang),
          }));
        },
      },
    },
  };
}
