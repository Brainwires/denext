/**
 * The share sheet for `denext/mobile`: the native `Share` plugin in the shell, else the Web
 * Share API, else a copy to the clipboard.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";
import { writeClipboard } from "./clipboard.ts";

/** What {@linkcode share} shares. At least one of `text` or `url` (or `title`) is needed. */
export interface ShareOptions {
  /** A title for the share (the email subject, say). */
  readonly title?: string;
  /** The text to share. */
  readonly text?: string;
  /** The URL to share. */
  readonly url?: string;
}

/**
 * How a {@linkcode share} ended: `"shared"` (the sheet completed), `"copied"` (no share
 * sheet, so the text was copied to the clipboard) or `"cancelled"` (the user dismissed it).
 */
export type ShareResult = "shared" | "copied" | "cancelled";

/** The JS side of `@capacitor/share`. */
interface SharePlugin {
  share(options: { title?: string; text?: string; url?: string }): Promise<unknown>;
}

/** The slice of `navigator` the web path uses. */
interface ShareNavigator {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  canShare?: (data: { title?: string; text?: string; url?: string }) => boolean;
}

/** `opts` without its undefined keys. */
function shareData(opts: ShareOptions): { title?: string; text?: string; url?: string } {
  const data: { title?: string; text?: string; url?: string } = {};
  if (opts.title !== undefined) data.title = opts.title;
  if (opts.text !== undefined) data.text = opts.text;
  if (opts.url !== undefined) data.url = opts.url;
  return data;
}

/** Whether `err` is a dismissed share sheet (a Web Share `AbortError`, or the plugin's "Share canceled"). */
function isCancel(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  return name === "AbortError" || (typeof message === "string" && /cancel/i.test(message));
}

/** Run a share, mapping a dismissal to `"cancelled"`. */
async function settle(run: () => Promise<unknown>): Promise<ShareResult> {
  try {
    await run();
    return "shared";
  } catch (err) {
    if (isCancel(err)) return "cancelled";
    throw err;
  }
}

/**
 * Open the share sheet.
 *
 * - Inside the native shell with `@capacitor/share` installed (`denext mobile add share`),
 *   the OS share sheet.
 * - Otherwise `navigator.share` where the browser has it (and `canShare` accepts the data).
 * - Otherwise the text and URL are copied to the clipboard (joined by a space), and the
 *   result is `"copied"` so the UI can say so.
 *
 * A dismissed sheet resolves `"cancelled"` rather than rejecting.
 *
 * @param opts The title, text and URL to share.
 * @returns `"shared"`, `"copied"` or `"cancelled"`. It rejects with a `TypeError` when there
 * is nothing to share, and when sharing or copying fails for another reason.
 * @example
 * ```tsx
 * "use client";
 * import { share } from "denext/mobile";
 *
 * export function ShareButton({ url }: { url: string }) {
 *   return (
 *     <button type="button" onClick={async () => {
 *       if ((await share({ title: "Look", url })) === "copied") alert("Link copied");
 *     }}>Share</button>
 *   );
 * }
 * ```
 */
export async function share(opts: ShareOptions): Promise<ShareResult> {
  const data = shareData(opts);
  if (!data.title && !data.text && !data.url) {
    throw new TypeError("share: pass at least one of title, text or url");
  }
  const plugin = nativePlugin<SharePlugin>("Share", ["share"]);
  if (plugin) return await settle(() => plugin.share(data));
  const nav = (globalThis as { navigator?: ShareNavigator }).navigator;
  if (typeof nav?.share === "function" && nav.canShare?.(data) !== false) {
    return await settle(() => nav.share!(data));
  }
  const copy = [data.text, data.url].filter(Boolean).join(" ") || data.title!;
  await writeClipboard(copy);
  return "copied";
}
