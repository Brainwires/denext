/**
 * The backend's notifications: what `desktop.ts` (`DesktopRuntime.notify`) and an extension
 * (`host.notify`) post an OS notification with, the way a page's `Notification` does. They go
 * through the `notifications` capability's own path (`src/desktop/caps/notifications.ts`: the
 * runtime's `Deno.desktop.notifications`, else the Deno `Notification` where the runtime cannot
 * schedule), so they need that capability enabled, as the page's do; their clicks reach the
 * backend's `onNotificationClick` hooks, never a page's taps.
 *
 * Runtime-only (never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, DesktopCapError } from "./extension.ts";

/** An action button on a backend notification. */
export interface DesktopNotifyAction {
  /** What a click on it reports as the click's `action` (at most 1024 UTF-8 bytes). */
  readonly id: string;
  /** The button's label. */
  readonly title: string;
}

/** What {@linkcode DesktopNotify} posts. */
export interface DesktopNotifyOptions {
  /** The title (up to 4096 characters). */
  readonly title: string;
  /** The body text (default none). */
  readonly body?: string;
  /**
   * The notification's tag: posting another with the same tag replaces it, and its clicks carry
   * it (`onNotificationClick`'s `click.tag`). 1–256 UTF-8 bytes, never starting with `denext-`
   * (denext's own tags). Default: a fresh `app-<uuid>`.
   */
  readonly tag?: string;
  /**
   * JSON data the click brings back (`click.data`), at most 4 KiB as JSON; an object may not have
   * a top-level `denext` key (denext's own notifications keep theirs there).
   */
  readonly data?: unknown;
  /** Action buttons; a click on one reports its `id` as the click's `action`. */
  readonly actions?: readonly DesktopNotifyAction[];
  /** Post it without a sound. */
  readonly silent?: boolean;
}

/** A posted backend notification. */
export interface DesktopPostedNotification {
  /** Its tag (the one given, or the one denext picked). */
  readonly tag: string;
  /** Remove it: from the OS's notification centre once shown, or before it shows. */
  close(): void;
}

/**
 * Post an OS notification from the backend. Rejects with a {@linkcode DesktopCapError}:
 * `not_enabled` while the `notifications` capability is off, `unsupported` where the Deno Desktop
 * runtime has no native notifications, `validation` for bad options.
 */
export type DesktopNotify = (options: DesktopNotifyOptions) => Promise<DesktopPostedNotification>;

/** The posting function each `notifications` capability registered, by capability. */
const notifiers = new WeakMap<DesktopCapability, DesktopNotify>();

/**
 * Register `notify` as `cap`'s backend poster (the `notifications` capability does, when built).
 *
 * @param cap The capability.
 * @param notify What posts through it.
 */
export function registerBackendNotifier(cap: DesktopCapability, notify: DesktopNotify): void {
  notifiers.set(cap, notify);
}

/** The error while the capability is off. */
function notEnabled(): DesktopCapError {
  return new DesktopCapError(
    "not_enabled",
    "notifications are not enabled: add the notifications capability " +
      "(`denext desktop add notifications`, desktop.capabilities.notifications)",
  );
}

/**
 * The backend's {@linkcode DesktopNotify} over the app's capabilities: the enabled
 * `notifications` capability's poster, else one that rejects with `not_enabled`.
 *
 * @param capabilities The capabilities the bridge serves.
 * @returns The poster.
 */
export function desktopBackendNotifier(capabilities: Iterable<DesktopCapability>): DesktopNotify {
  for (const cap of capabilities) {
    const notify = cap.name === "notifications" ? notifiers.get(cap) : undefined;
    if (notify) return notify;
  }
  return () => Promise.reject(notEnabled());
}
