// Loopy reading its bubbles aloud (opt in): the page's toggle, kept in localStorage, and the text a
// bubble is read as. The voice is the OS's: `speak()` in `denext/mobile` uses the window's Web
// Speech where it has one (WKWebView, WebView2, CEF on macOS and Windows) and the desktop runtime's
// `Deno.desktop.speech` otherwise (WebKitGTK on Linux, through speech-dispatcher). Pure apart from
// the storage it is handed, so it is unit-tested.

import type { LoopyMessage } from "./messages.ts";

/** Where the toggle is kept. */
export const SPEECH_KEY = "loopy.readAloud";

/** The slice of `Storage` the toggle uses. */
export type SpeechStorage = Pick<Storage, "getItem" | "setItem">;

/** Whether Loopy reads its bubbles aloud (off unless turned on; off without storage). */
export function readAloudOn(storage: SpeechStorage | undefined): boolean {
  try {
    return storage?.getItem(SPEECH_KEY) === "on";
  } catch {
    return false; // storage refused (a private window)
  }
}

/** Keep the toggle; a refused write leaves it for this session only. */
export function saveReadAloud(storage: SpeechStorage | undefined, on: boolean): void {
  try {
    storage?.setItem(SPEECH_KEY, on ? "on" : "off");
  } catch { /* not kept */ }
}

/** What Loopy says for `message`: its text, then its buttons as the choices ("Yes, or Not now."). */
export function spokenText(message: Pick<LoopyMessage, "text" | "actions">): string {
  const labels = message.actions.map((a) => a.label);
  if (labels.length === 0) return message.text;
  const choices = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
  return `${message.text} ${choices}.`;
}
