/**
 * Receive what other apps share to this one (a link, text, images) for `denext/mobile`: the web
 * side of the `DenextShareReceive` plugin that `denext mobile add share-extension` installs (an
 * iOS Share Extension and an Android share target). On the web, and in a shell without the
 * plugin, nothing is ever received: subscribing is a no-op.
 *
 * Nothing runs at import.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { createFanout, type Fanout } from "./link-routing.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";
import { shareListener } from "./share-handoff.ts";

/** A file shared to the app, copied where the app can read it. */
export interface SharedFile {
  /**
   * Its absolute path on the device: in the App Group container on iOS (kept seven days), in
   * the app's cache on Android (the OS may clear it). Copy what you keep. A webview reads it
   * through `Capacitor.convertFileSrc("file://" + path)`.
   */
  readonly path: string;
  /** Its MIME type (`image/jpeg`, …; `application/octet-stream` when unknown). */
  readonly mimeType: string;
}

/** One share: any of a web link, text and files. */
export interface SharedContent {
  /** Shared text (iOS joins several text items with newlines). */
  readonly text?: string;
  /** A shared http(s) link (Android: text that is exactly one link). */
  readonly url?: string;
  /** Shared images. */
  readonly files?: readonly SharedFile[];
}

/** The JS face of the native plugin (Capacitor seeds a stub per registered method). */
interface ShareReceivePlugin {
  consume(): Promise<{ items?: unknown } | undefined>;
  addListener(
    eventName: "shareReceived",
    listener: () => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The native plugin, when the shell has it. */
function sharePlugin(): ShareReceivePlugin | undefined {
  return nativePlugin<ShareReceivePlugin>("DenextShareReceive", ["consume", "addListener"]);
}

/** A string field of `value`, when it is a non-empty string. */
function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

/** The files of a native item, keeping well-formed ones. */
function sharedFiles(value: unknown): SharedFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) => {
    if (typeof file !== "object" || file === null) return [];
    const path = stringField(file as Record<string, unknown>, "path");
    const mimeType = stringField(file as Record<string, unknown>, "mimeType") ??
      "application/octet-stream";
    return path === undefined ? [] : [{ path, mimeType }];
  });
}

/** A native item as {@linkcode SharedContent}, or undefined when it holds nothing usable. */
function sharedContent(item: unknown): SharedContent | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const record = item as Record<string, unknown>;
  const text = stringField(record, "text");
  const url = stringField(record, "url");
  const files = sharedFiles(record.files);
  if (text === undefined && url === undefined && files.length === 0) return undefined;
  return {
    ...(text === undefined ? {} : { text }),
    ...(url === undefined ? {} : { url }),
    ...(files.length === 0 ? {} : { files }),
  };
}

/** Take every waiting share from the plugin and hand each to `emit`. */
async function drain(plugin: ShareReceivePlugin, emit: (content: SharedContent) => void) {
  let result: { items?: unknown } | undefined;
  try {
    result = await plugin.consume();
  } catch (err) {
    console.error("denext/mobile: onShareReceived could not read the shares", err);
    return;
  }
  const items = Array.isArray(result?.items) ? result.items : [];
  for (const item of items) {
    const content = sharedContent(item);
    if (content) emit(content);
  }
}

/** The shared listener: drain on attach (a cold start's share) and on every native event. */
function fanout(plugin: ShareReceivePlugin): Fanout<SharedContent> {
  shareListener.fanout ??= createFanout<SharedContent>((emit) => {
    const stop = listenerDisposer(
      plugin.addListener("shareReceived", () => void drain(plugin, emit)),
    );
    void drain(plugin, emit);
    return stop;
  }) as Fanout<unknown>;
  return shareListener.fanout as Fanout<SharedContent>;
}

/**
 * Call `callback` with each share other apps send to this one, including the one that opened
 * the app: shares wait natively until the first subscriber arrives, so subscribe early (a root
 * layout or the app shell); only the subscribers present when a share is handed over see it.
 * Outside the native shell, or without the plugin, it does nothing.
 *
 * `denext mobile add share-extension` installs the native side: on iOS a Share Extension
 * (queued through the App Group, then the app is opened with `<scheme>://denext-share`, which
 * `onDeepLink` ignores), on Android SEND / SEND_MULTIPLE intent filters.
 *
 * @param callback Called with each share.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onShareReceived } from "denext/mobile";
 *
 * const stop = onShareReceived(({ url, text, files }) => {
 *   if (url) location.assign(`/new?link=${encodeURIComponent(url)}`);
 *   else console.log(text, files?.length ?? 0);
 * });
 * ```
 */
export function onShareReceived(callback: (content: SharedContent) => void): () => void {
  const plugin = sharePlugin();
  if (!plugin) return () => {};
  return fanout(plugin).subscribe((content) => callback(content));
}

/**
 * Hook form of {@linkcode onShareReceived}: subscribes on mount, unsubscribes on unmount, and
 * always calls the latest `callback`.
 *
 * @param callback Called with each share.
 * @example
 * ```tsx
 * "use client";
 * import { useRouter } from "denext";
 * import { useShareReceived } from "denext/mobile";
 *
 * export function ShareTarget() {
 *   const router = useRouter();
 *   useShareReceived(({ url }) => url && router.push(`/new?link=${encodeURIComponent(url)}`));
 *   return null;
 * }
 * ```
 */
export function useShareReceived(callback: (content: SharedContent) => void): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  useEffect(() => onShareReceived((content) => cbRef.current(content)), []);
}
