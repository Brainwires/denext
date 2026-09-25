/**
 * `expo-sharing` for denext: `shareAsync` over `denext/mobile`'s {@linkcode share} for a web
 * link, and over the Web Share API's file sharing for a file.
 *
 * Incoming shares (another app sharing *into* this one: `getSharedPayloads`,
 * `useIncomingShare`) need a native share extension; here there never are any, so those
 * report an empty list.
 *
 * @example
 * ```ts
 * import * as Sharing from "denext/expo/sharing";
 *
 * if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: "application/pdf" });
 * ```
 *
 * @module
 */

import { nativePlugin } from "../mobile/plugin.ts";
import { share } from "../mobile/share.ts";
import { readBytes } from "./internal/fs.ts";

/** Options for {@linkcode shareAsync}. */
export interface SharingOptions {
  /** The file's MIME type (default: from its extension). */
  mimeType?: string;
  /** The iOS Uniform Type Identifier (ignored here). */
  UTI?: string;
  /** The share sheet's title. */
  dialogTitle?: string;
  /** Where an iPad popover points (ignored here). */
  anchor?: { x?: number; y?: number; width?: number; height?: number };
}

/** What kind of content was shared into the app. */
export type ShareType = "text" | "url" | "audio" | "image" | "video" | "file";

/** The resolved kind of shared content. */
export type ContentType = "text" | "audio" | "image" | "video" | "file" | "website";

/** One item shared into the app. */
export interface SharePayload {
  /** The text, URL or file URI. */
  value: string;
  /** What it is. */
  shareType: ShareType;
  /** Its MIME type, when known. */
  mimeType?: string;
}

/** A {@linkcode SharePayload} with its content resolved. */
export type ResolvedSharePayload = SharePayload & {
  /** A readable URI for the content, or null for text. */
  contentUri: string | null;
  /** The resolved kind. */
  contentType: ContentType | null;
  /** The resolved MIME type. */
  contentMimeType: string | null;
  /** The original file name. */
  originalName: string | null;
  /** The size in bytes. */
  contentSize: number | null;
};

/** What {@linkcode useIncomingShare} returns. */
export interface UseIncomingShareResult {
  /** The raw payloads (always empty here). */
  sharedPayloads: SharePayload[];
  /** The resolved payloads (always empty here). */
  resolvedSharedPayloads: ResolvedSharePayload[];
  /** Forget the payloads. */
  clearSharedPayloads: () => void;
  /** Whether payloads are being resolved. */
  isResolving: boolean;
  /** A resolution error. */
  error: Error | null;
  /** Read the payloads again. */
  refreshSharePayloads: () => void;
}

/** The slice of `navigator` file sharing uses. */
interface FileShareNavigator {
  share?: (data: { files?: unknown[]; title?: string }) => Promise<void>;
  canShare?: (data: { files?: unknown[] }) => boolean;
}

/** `navigator`, as far as sharing goes. */
function shareNavigator(): FileShareNavigator | undefined {
  return (globalThis as { navigator?: FileShareNavigator }).navigator;
}

/**
 * Whether sharing is available: the Capacitor `Share` plugin in the shell, or the Web Share
 * API in the browser.
 *
 * @returns `true` when a share sheet can open.
 */
export function isAvailableAsync(): Promise<boolean> {
  const available = nativePlugin("Share", ["share"]) !== undefined ||
    typeof shareNavigator()?.share === "function";
  return Promise.resolve(available);
}

/**
 * Open the share sheet for `url`.
 *
 * - An `http(s):` URL is shared as a link (`denext/mobile`'s `share`, which copies it to the
 *   clipboard where there is no share sheet).
 * - Anything else (a `file:///documents/…` file, a picker's `blob:` URL) is read and shared
 *   as a file through the Web Share API. Where the browser cannot share files (or inside the
 *   native shell, whose `Share` plugin takes native paths) it rejects.
 *
 * @param url The file URI or web URL.
 * @param options The MIME type and dialog title.
 * @returns A promise that settles once the sheet closes. A dismissed sheet resolves.
 */
export async function shareAsync(url: string, options: SharingOptions = {}): Promise<void> {
  if (/^https?:/i.test(url)) {
    await share({ url, ...(options.dialogTitle ? { title: options.dialogTitle } : {}) });
    return;
  }
  const bytes = await readBytes(url);
  const name = decodeURIComponent(url.split(/[/?#]/).filter(Boolean).pop() ?? "file");
  const file = new globalThis.File([bytes as Uint8Array<ArrayBuffer>], name, {
    type: options.mimeType ?? "",
  });
  const nav = shareNavigator();
  if (typeof nav?.share !== "function" || nav.canShare?.({ files: [file] }) === false) {
    throw new Error("shareAsync: this platform cannot share files");
  }
  try {
    await nav.share({
      files: [file],
      ...(options.dialogTitle ? { title: options.dialogTitle } : {}),
    });
  } catch (err) {
    if ((err as { name?: string })?.name !== "AbortError") throw err;
  }
}

/**
 * The items shared into the app: none here (there is no share extension).
 *
 * @returns An empty list.
 */
export function getSharedPayloads(): SharePayload[] {
  return [];
}

/**
 * The items shared into the app, resolved: none here.
 *
 * @returns An empty list.
 */
export function getResolvedSharedPayloadsAsync(): Promise<ResolvedSharePayload[]> {
  return Promise.resolve([]);
}

/** Forget the items shared into the app (there are none here). */
export function clearSharedPayloads(): void {}

/**
 * Hook form of the incoming-share API: always empty here.
 *
 * @returns An empty, settled result.
 */
export function useIncomingShare(): UseIncomingShareResult {
  return {
    sharedPayloads: [],
    resolvedSharedPayloads: [],
    clearSharedPayloads,
    isResolving: false,
    error: null,
    refreshSharePayloads: () => {},
  };
}
