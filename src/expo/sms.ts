/**
 * `expo-sms` for denext: in the Capacitor shell, the device's Messages app opened by navigating
 * to an `sms:` URL (recipients and body filled in; the user sends it), which the shell hands to
 * the OS. The app reports nothing back,
 * so the result is always `unknown` (Expo's Android answer). Attachments are not supported:
 * an `sms:` URL cannot carry them, so the call rejects with `ERR_SMS_ATTACHMENTS`.
 *
 * Outside the shell `isAvailableAsync()` is `false` and `sendSMSAsync` rejects with
 * `ERR_UNAVAILABLE`, as on Expo's web build.
 *
 * @example
 * ```ts
 * import * as SMS from "denext/expo/sms";
 *
 * if (await SMS.isAvailableAsync()) {
 *   const { result } = await SMS.sendSMSAsync(["5551234"], "On my way");
 * }
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { CodedError, unavailable } from "./internal/common.ts";

/** What happened to the message (`unknown` here: the Messages app reports nothing). */
export interface SMSResponse {
  /** The outcome. */
  result: "unknown" | "sent" | "cancelled";
}

/** A file to attach (not supported here). */
export interface SMSAttachment {
  /** The file's URI. */
  uri: string;
  /** Its MIME type. */
  mimeType: string;
  /** Its name. */
  filename: string;
}

/** Options for {@linkcode sendSMSAsync}. */
export interface SMSOptions {
  /** Files to attach: not supported (the call rejects). */
  attachments?: SMSAttachment | SMSAttachment[] | undefined;
}

/**
 * The `sms:` URL for `addresses` and `message`: iOS reads the body after `&`, Android (and RFC
 * 5724) after `?`.
 */
function smsUrl(addresses: readonly string[], message: string, ios: boolean): string {
  const to = addresses.map((a) => encodeURIComponent(a.trim()).replaceAll("%2B", "+")).join(",");
  if (!message) return `sms:${to}`;
  return `sms:${to}${ios ? "&" : "?"}body=${encodeURIComponent(message)}`;
}

/**
 * Open the Messages app with a message to `addresses` filled in.
 *
 * @param addresses One phone number or several.
 * @param message The text.
 * @param options Attachments (not supported).
 * @returns `{ result: "unknown" }` once the Messages app was asked to open.
 * @throws A `CodedError`: `ERR_UNAVAILABLE` outside the shell, `ERR_SMS_ATTACHMENTS` with
 *   attachments.
 */
export async function sendSMSAsync(
  addresses: string | string[],
  message: string,
  options: SMSOptions = {},
): Promise<SMSResponse> {
  const platform = nativePlatform();
  if (platform === "web") {
    throw unavailable(
      "expo-sms",
      "sendSMSAsync",
      "It opens the Messages app in the iOS / Android shell.",
    );
  }
  const attachments = options.attachments;
  if (attachments && (!Array.isArray(attachments) || attachments.length > 0)) {
    throw new CodedError(
      "ERR_SMS_ATTACHMENTS",
      "denext/expo: expo-sms opens the Messages app with an sms: URL, which cannot carry " +
        "attachments. Share the file with expo-sharing instead.",
    );
  }
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  // The page navigates to the sms: URL, and the shell hands that navigation to the OS (as it does
  // a tapped sms: link: Capacitor's navigation policy opens a foreign scheme externally and
  // cancels it, so the page stays). Not window.open: without a user gesture, which an awaited
  // call has lost, a popup is blocked silently and the call would resolve as if it had opened.
  const location = (globalThis as { location?: { assign?(url: string): void } }).location;
  if (typeof location?.assign !== "function") {
    throw new CodedError(
      "ERR_UNAVAILABLE",
      "denext/expo: expo-sms could not open the Messages app: there is no page to navigate.",
    );
  }
  location.assign(smsUrl(list, message ?? "", platform === "ios"));
  await Promise.resolve();
  return { result: "unknown" };
}

/**
 * Whether messages can be sent: in the iOS / Android shell.
 *
 * @returns Whether {@linkcode sendSMSAsync} can open the Messages app.
 */
export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(nativePlatform() !== "web");
}
