/**
 * Clipboard access for `denext/mobile`: the native `Clipboard` plugin in the shell, else the
 * async Clipboard API.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";

/** The JS side of `@capacitor/clipboard` (the string half of it). */
interface ClipboardPlugin {
  read(): Promise<{ value?: string; type?: string }>;
  write(options: { string: string }): Promise<void>;
}

/** The slice of `navigator.clipboard` the web fallback uses. */
interface WebClipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

/** The native plugin, when the shell has it. */
function clipboardPlugin(): ClipboardPlugin | undefined {
  return nativePlugin<ClipboardPlugin>("Clipboard", ["read", "write"]);
}

/** `navigator.clipboard`, or a rejection that says why there is none. */
function webClipboard(fn: string): WebClipboard {
  const clip = (globalThis as { navigator?: { clipboard?: Partial<WebClipboard> } }).navigator
    ?.clipboard;
  if (typeof clip?.readText !== "function" || typeof clip.writeText !== "function") {
    throw new Error(
      `${fn}: no clipboard available (navigator.clipboard needs a secure context; none during SSR)`,
    );
  }
  return clip as WebClipboard;
}

/**
 * Read text from the clipboard: through `@capacitor/clipboard` inside the native shell
 * (`denext mobile add clipboard`), else `navigator.clipboard.readText()`, which browsers
 * gate behind a permission prompt or a user gesture.
 *
 * @returns The clipboard's text (`""` when it holds none).
 * @example
 * ```tsx
 * "use client";
 * import { readClipboard } from "denext/mobile";
 *
 * export function PasteCode({ onCode }: { onCode: (code: string) => void }) {
 *   return <button type="button" onClick={async () => onCode(await readClipboard())}>Paste</button>;
 * }
 * ```
 */
export async function readClipboard(): Promise<string> {
  const plugin = clipboardPlugin();
  if (plugin) return (await plugin.read()).value ?? "";
  return await webClipboard("readClipboard").readText();
}

/**
 * Write text to the clipboard: through `@capacitor/clipboard` inside the native shell
 * (`denext mobile add clipboard`), else `navigator.clipboard.writeText()`.
 *
 * @param text The text to copy.
 * @returns A promise that settles once the text is on the clipboard. It rejects where there is
 * no clipboard (an insecure context, SSR) or when the platform refuses.
 * @example
 * ```tsx
 * "use client";
 * import { writeClipboard } from "denext/mobile";
 *
 * export function CopyLink({ url }: { url: string }) {
 *   return <button type="button" onClick={() => writeClipboard(url)}>Copy link</button>;
 * }
 * ```
 */
export async function writeClipboard(text: string): Promise<void> {
  const plugin = clipboardPlugin();
  if (plugin) return await plugin.write({ string: text });
  await webClipboard("writeClipboard").writeText(text);
}
