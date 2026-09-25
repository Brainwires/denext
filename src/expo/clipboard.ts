/**
 * `expo-clipboard` for denext: the text half of the API over `denext/mobile`'s
 * {@linkcode readClipboard} / {@linkcode writeClipboard} (`@capacitor/clipboard` in the
 * Capacitor shell, the async Clipboard API on the web).
 *
 * Images, the change listener and `ClipboardPasteButton` are not provided (see the manifest).
 *
 * @example
 * ```ts
 * import * as Clipboard from "denext/expo/clipboard";
 *
 * await Clipboard.setStringAsync("hello");
 * const text = await Clipboard.getStringAsync();
 * ```
 *
 * @module
 */

import { readClipboard, writeClipboard } from "../mobile/clipboard.ts";
import { type Subscription, subscription } from "./internal/common.ts";

export type { Subscription };

/** A kind of clipboard content, as {@linkcode ClipboardEvent} lists them. */
export enum ContentType {
  /** Plain text. */
  PLAIN_TEXT = "plain-text",
  /** HTML. */
  HTML = "html",
  /** An image. */
  IMAGE = "image",
  /** A URL. */
  URL = "url",
}

/** A string format for {@linkcode getStringAsync} / {@linkcode setStringAsync}. */
export enum StringFormat {
  /** Plain text. */
  PLAIN_TEXT = "plainText",
  /** HTML (read and written as plain text here). */
  HTML = "html",
}

/** Options for {@linkcode getStringAsync}. */
export interface GetStringOptions {
  /** The preferred format; the text is always returned as plain text. */
  preferredFormat?: StringFormat;
}

/** Options for {@linkcode setStringAsync}. */
export interface SetStringOptions {
  /** The format of `text`; it is always written as plain text. */
  inputFormat?: StringFormat;
}

/** What a clipboard listener receives. */
export interface ClipboardEvent {
  /** The kinds of content now on the clipboard. */
  contentTypes: ContentType[];
}

/**
 * Read the clipboard's text.
 *
 * @param _options Ignored: the text is always plain.
 * @returns The text, or `""` when the clipboard holds none or reading is refused.
 */
export async function getStringAsync(_options?: GetStringOptions): Promise<string> {
  try {
    return await readClipboard();
  } catch {
    return "";
  }
}

/**
 * Put `text` on the clipboard.
 *
 * @param text The text.
 * @param _options Ignored: the text is always written as plain text.
 * @returns `true` once written, `false` when the platform refused.
 */
export async function setStringAsync(text: string, _options?: SetStringOptions): Promise<boolean> {
  try {
    await writeClipboard(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the clipboard holds text.
 *
 * @returns `true` when there is non-empty text.
 */
export async function hasStringAsync(): Promise<boolean> {
  return (await getStringAsync()) !== "";
}

/** `text` when it is an absolute URL, else null. */
function asUrl(text: string): string | null {
  const trimmed = text.trim();
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * The clipboard's text when it is a URL.
 *
 * @returns The URL, or null.
 */
export async function getUrlAsync(): Promise<string | null> {
  return asUrl(await getStringAsync());
}

/**
 * Put a URL on the clipboard (as text).
 *
 * @param url The URL.
 * @returns A promise that settles once written.
 */
export async function setUrlAsync(url: string): Promise<void> {
  await writeClipboard(url);
}

/**
 * Whether the clipboard's text is a URL.
 *
 * @returns `true` for a URL.
 */
export async function hasUrlAsync(): Promise<boolean> {
  return (await getUrlAsync()) !== null;
}

/**
 * Whether the clipboard holds an image. Images are not supported here: always `false`.
 *
 * @returns `false`.
 */
export function hasImageAsync(): Promise<boolean> {
  return Promise.resolve(false);
}

/**
 * Listen for clipboard changes. Neither the web nor the Capacitor plugin reports them, so
 * the listener is never called (Expo's web build behaves the same).
 *
 * @param _listener Never called.
 * @returns A subscription to remove.
 */
export function addClipboardListener(_listener: (event: ClipboardEvent) => void): Subscription {
  return subscription(() => {});
}

/**
 * Remove a clipboard listener.
 *
 * @param sub The subscription {@linkcode addClipboardListener} returned.
 * @deprecated Call `subscription.remove()`.
 */
export function removeClipboardListener(sub: Subscription): void {
  sub.remove();
}

/** Whether `ClipboardPasteButton` is available: never, here. */
export const isPasteButtonAvailable = false;
