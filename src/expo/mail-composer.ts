/**
 * `expo-mail-composer` for denext: the compose sheet is the device's mail app, opened with a
 * `mailto:` URL through `denext/mobile`'s `openExternal` (the Capacitor shell hands it to Mail /
 * the default mail app; a browser to its mail handler; Deno Desktop to the OS).
 *
 * A `mailto:` URL carries recipients, cc, bcc, subject and a plain-text body only: an HTML body
 * is sent as its text (tags removed), and `attachments` are not supported (the call rejects
 * with `ERR_MAIL_ATTACHMENTS`, so an app can fall back to `expo-sharing`). The mail app reports
 * nothing back, so the status is always `undetermined`, as on Expo's web build.
 *
 * @example
 * ```ts
 * import * as MailComposer from "denext/expo/mail-composer";
 *
 * if (await MailComposer.isAvailableAsync()) {
 *   await MailComposer.composeAsync({ recipients: ["help@example.com"], subject: "Hi" });
 * }
 * ```
 *
 * @module
 */

import { openExternal } from "../mobile/bridge.ts";
import { CodedError } from "./internal/common.ts";

/** A mail app (`getClients`). */
export interface MailClient {
  /** Its name. */
  label: string;
  /** Its Android package. */
  packageName?: string;
  /** Its iOS URL scheme. */
  url?: string;
}

/** What to put in the message. */
export interface MailComposerOptions {
  /** To addresses. */
  recipients?: string[];
  /** Cc addresses. */
  ccRecipients?: string[];
  /** Bcc addresses. */
  bccRecipients?: string[];
  /** The subject. */
  subject?: string;
  /** The body. */
  body?: string;
  /** Whether `body` is HTML (it is sent as its text). */
  isHtml?: boolean;
  /** File URIs to attach: not supported (the call rejects). */
  attachments?: string[];
}

/** What happened to the message. */
export enum MailComposerStatus {
  /** Not reported: always, here. */
  UNDETERMINED = "undetermined",
  /** Sent. */
  SENT = "sent",
  /** Saved as a draft. */
  SAVED = "saved",
  /** Cancelled. */
  CANCELLED = "cancelled",
}

/** The result of {@linkcode composeAsync}. */
export interface MailComposerResult {
  /** The status (`undetermined` here). */
  status: MailComposerStatus;
}

/**
 * The mail apps installed: not observable from a page, so none (as Expo's web build).
 *
 * @returns An empty list.
 */
export function getClients(): MailClient[] {
  return [];
}

/** An HTML body's text. */
function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Addresses as one `mailto:` field (each percent-encoded but its `@`, comma-joined). */
function addresses(list: readonly string[] | undefined): string {
  return (list ?? []).filter(Boolean).map((a) => encodeURIComponent(a).replaceAll("%40", "@"))
    .join(",");
}

/** The `mailto:` URL for `options` (RFC 6068: each value percent-encoded, `%20` for spaces). */
function mailtoUrl(options: MailComposerOptions): string {
  const fields: string[] = [];
  const add = (key: string, encoded: string) => {
    if (encoded) fields.push(`${key}=${encoded}`);
  };
  add("cc", addresses(options.ccRecipients));
  add("bcc", addresses(options.bccRecipients));
  add("subject", encodeURIComponent(options.subject ?? ""));
  const body = options.body && (options.isHtml ? htmlText(options.body) : options.body);
  add("body", encodeURIComponent(body ?? ""));
  const query = fields.length > 0 ? `?${fields.join("&")}` : "";
  return `mailto:${addresses(options.recipients)}${query}`;
}

/**
 * Open the mail app with a message filled in.
 *
 * @param options The message.
 * @returns `{ status: "undetermined" }` once the mail app was asked to open.
 * @throws A `CodedError` (`ERR_MAIL_ATTACHMENTS`) when `attachments` are given.
 */
export async function composeAsync(options: MailComposerOptions): Promise<MailComposerResult> {
  if (options.attachments && options.attachments.length > 0) {
    throw new CodedError(
      "ERR_MAIL_ATTACHMENTS",
      "denext/expo: expo-mail-composer opens the mail app with a mailto: URL, which cannot " +
        "carry attachments. Share the file with expo-sharing instead.",
    );
  }
  await openExternal(mailtoUrl(options));
  return { status: MailComposerStatus.UNDETERMINED };
}

/**
 * Whether a mail app can be opened: wherever there is a page to open it from.
 *
 * @returns Whether {@linkcode composeAsync} can run.
 */
export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(typeof (globalThis as { open?: unknown }).open === "function");
}
