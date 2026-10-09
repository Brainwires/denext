/**
 * Delivered notifications for `denext/mobile`: list the notifications the app has in the
 * notification centre (local and remote push alike) and remove them — one, several, a thread's
 * worth (a chat's when the user reads or mutes it) or all.
 *
 * - iOS: `UNUserNotificationCenter`'s delivered notifications, through denext's `DenextSettings`
 *   plugin (installed by `denext mobile add local-notifications` / `push`). A thread is the
 *   content's `threadIdentifier`: APNs `aps.thread-id` for a push, `threadId` for a local
 *   notification.
 * - Android: `NotificationManager.getActiveNotifications()` through the same plugin. A thread is
 *   the notification's group key (`threadId` for a local notification); a `tag` is its tag (FCM's
 *   `android.notification.tag` for a push FCM draws).
 * - Deno Desktop (`notifications` capability, pinned runtime): the runtime lists no delivered
 *   notifications, so the list is the ones this capability posted during this run of the app whose
 *   time has come and that denext has not removed (see the docs' limits).
 * - Web: the notifications `scheduleNotification` showed in this page that are still open, plus
 *   the service worker registration's (`getNotifications()`), whose thread is `data.threadId`.
 *
 * @module
 */

import { nativePlatform } from "./bridge.ts";
import { onDesktop, viaDesktop } from "./desktop-branch.ts";
import { nativePlugin } from "./plugin.ts";

/** A notification the app has in the notification centre. */
export interface DeliveredNotification {
  /**
   * Its id: the request identifier on iOS (a local notification's id as a string, an APNs
   * `apns-collapse-id` or a generated UUID for a push), the notification id on Android (unique
   * only together with its `tag`), the id `scheduleNotification` returned on desktop and for a
   * page's own web notification, and the tag of a service worker's.
   */
  readonly id: string;
  /** The thread it groups under (iOS thread identifier, Android group key), if any. */
  readonly threadId?: string;
  /** Its tag (Android; a service worker notification's tag on the web). */
  readonly tag?: string;
  /** The title. */
  readonly title?: string;
  /**
   * Its payload: a local notification's `data`, a push's custom keys (iOS; never on Android, where
   * the OS does not keep a drawn notification's payload). Untrusted input, as a tap's is.
   */
  readonly data?: unknown;
}

/**
 * Which delivered notifications {@linkcode removeDeliveredNotifications} removes. The criteria
 * given narrow each other (a notification must match every one); `{ all: true }` alone removes
 * every delivered notification.
 */
export interface DeliveredNotificationSelector {
  /** Remove these ids (a number matches its string form). */
  readonly ids?: readonly (string | number)[];
  /** Remove the notifications of this thread. */
  readonly threadId?: string;
  /** Remove the notifications with this tag. */
  readonly tag?: string;
  /** Remove every delivered notification (no other criterion may be given with it). */
  readonly all?: boolean;
}

/** A delivered notification as denext's native plugin reports it. */
interface RawDelivered {
  id?: unknown;
  tag?: unknown;
  threadId?: unknown;
  title?: unknown;
  data?: unknown;
  /** Android: a group summary (removed with its group, never listed). */
  summary?: unknown;
}

/** The delivered-notification methods of denext's `DenextSettings` plugin (generation 3). */
interface DeliveredPlugin {
  deliveredNotifications(): Promise<{ notifications?: RawDelivered[] }>;
  removeDeliveredNotifications(
    options: { notifications: Array<{ id: string; tag?: string }> },
  ): Promise<void>;
}

/** A web notification as far as this module uses it (the page's own, or a service worker's). */
export interface WebNotificationLike {
  readonly title?: string;
  readonly tag?: string;
  readonly data?: unknown;
  close(): void;
  addEventListener?(type: string, listener: () => void): void;
}

/** A notification this page showed through the Notifications API, while it is open. */
interface TrackedWeb {
  readonly entry: DeliveredNotification;
  readonly notification: WebNotificationLike;
}

/** The page's own open web notifications, by id (insertion order: oldest first). */
const webShown = new Map<string, TrackedWeb>();
/** How many of the page's own web notifications are remembered. */
const MAX_TRACKED = 200;

/**
 * Remember a web notification `scheduleNotification` showed, until it closes. Internal to
 * `denext/mobile`.
 *
 * @param notification The `Notification` it created.
 * @param entry How it lists.
 */
export function trackWebNotification(
  notification: WebNotificationLike,
  entry: DeliveredNotification,
): void {
  webShown.delete(entry.id);
  webShown.set(entry.id, { entry, notification });
  if (webShown.size > MAX_TRACKED) webShown.delete(webShown.keys().next().value!);
  notification.addEventListener?.("close", () => {
    if (webShown.get(entry.id)?.notification === notification) webShown.delete(entry.id);
  });
}

/** The plugin, or `undefined` outside the shell / before generation 3 of DenextSettings. */
function deliveredPlugin(): DeliveredPlugin | undefined {
  return nativePlugin<DeliveredPlugin>("DenextSettings", [
    "deliveredNotifications",
    "removeDeliveredNotifications",
  ]);
}

/** The rejection in a shell whose binary lacks the plugin methods. */
function needsPlugin(fn: string): Error {
  return new Error(
    `${fn}: needs denext's DenextSettings plugin, generation 3 or later: run ` +
      "`denext mobile add local-notifications` (or `push`), then ship a new binary.",
  );
}

/** A string field, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A listed notification without its undefined fields. */
function entryOf(
  id: string,
  fields: { threadId?: unknown; tag?: unknown; title?: unknown; data?: unknown },
): DeliveredNotification {
  const threadId = str(fields.threadId);
  const tag = str(fields.tag);
  const title = str(fields.title);
  return {
    id,
    ...(threadId !== undefined ? { threadId } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(fields.data !== undefined && fields.data !== null ? { data: fields.data } : {}),
  };
}

/** A raw native entry as a listed notification. */
function fromRaw(raw: RawDelivered): DeliveredNotification {
  return entryOf(String(raw.id ?? ""), raw);
}

/** The native plugin's delivered notifications, group summaries included. */
async function nativeDelivered(plugin: DeliveredPlugin): Promise<RawDelivered[]> {
  const list = (await plugin.deliveredNotifications())?.notifications;
  return Array.isArray(list) ? list.filter((r) => r && typeof r === "object") : [];
}

/** The service worker registration's notifications (none without one). */
async function workerNotifications(): Promise<WebNotificationLike[]> {
  try {
    const sw = (globalThis.navigator as { serviceWorker?: unknown } | undefined)?.serviceWorker as
      | { getRegistration?(): Promise<unknown> }
      | undefined;
    const reg = await sw?.getRegistration?.() as
      | { getNotifications?(): Promise<WebNotificationLike[]> }
      | undefined;
    const list = await reg?.getNotifications?.();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** A service worker notification as listed: its tag is its id, `data.threadId` its thread. */
function workerEntry(n: WebNotificationLike): DeliveredNotification {
  const thread = (n.data as { threadId?: unknown } | null | undefined)?.threadId;
  return entryOf(n.tag ?? "", { threadId: thread, tag: n.tag, title: n.title, data: n.data });
}

/** The web's delivered notifications, each with the handle that closes it. */
async function webDelivered(): Promise<TrackedWeb[]> {
  const workers = (await workerNotifications()).map((n) => ({
    entry: workerEntry(n),
    notification: n,
  }));
  return [...webShown.values(), ...workers];
}

/** Whether `selector` names no notification at all, or mixes `all` with a criterion. */
function checkSelector(selector: DeliveredNotificationSelector): void {
  const fn = "removeDeliveredNotifications";
  if (typeof selector !== "object" || selector === null) {
    throw new TypeError(`${fn}: pass { ids }, { threadId }, { tag } or { all: true }`);
  }
  const { ids, threadId, tag, all } = selector;
  if (ids !== undefined && !Array.isArray(ids)) throw new TypeError(`${fn}: ids must be an array`);
  for (const [name, value] of [["threadId", threadId], ["tag", tag]] as const) {
    if (value !== undefined && typeof value !== "string") {
      throw new TypeError(`${fn}: ${name} must be a string`);
    }
  }
  const criteria = ids !== undefined || threadId !== undefined || tag !== undefined;
  if (all === true && criteria) {
    throw new TypeError(`${fn}: { all: true } removes everything; pass it alone`);
  }
  if (all !== true && !criteria) {
    throw new TypeError(
      `${fn}: no selector: pass { ids }, { threadId } or { tag }, or { all: true } to remove all`,
    );
  }
}

/** Whether `entry` matches every criterion of `selector` (`all` matches everything). */
function matches(entry: DeliveredNotification, selector: DeliveredNotificationSelector): boolean {
  if (selector.all === true) return true;
  if (selector.ids !== undefined && !selector.ids.some((id) => String(id) === entry.id)) {
    return false;
  }
  if (selector.threadId !== undefined && entry.threadId !== selector.threadId) return false;
  return selector.tag === undefined || entry.tag === selector.tag;
}

/**
 * The native entries `selector` removes: the matching notifications, plus the Android group
 * summaries left without a notification in their group.
 */
function nativeRemovals(
  raws: RawDelivered[],
  selector: DeliveredNotificationSelector,
): Array<{ id: string; tag?: string }> {
  const out: Array<{ id: string; tag?: string }> = [];
  const kept = new Set<string | undefined>();
  const emptied = new Set<string | undefined>();
  const summaries: RawDelivered[] = [];
  for (const raw of raws) {
    if (raw.summary === true) {
      summaries.push(raw);
    } else if (matches(fromRaw(raw), selector)) {
      out.push(wireOf(raw));
      emptied.add(str(raw.threadId));
    } else {
      kept.add(str(raw.threadId));
    }
  }
  for (const s of summaries) {
    const group = str(s.threadId);
    if (selector.all === true || (emptied.has(group) && !kept.has(group))) out.push(wireOf(s));
  }
  return out;
}

/** A native entry as the plugin's remove call takes it. */
function wireOf(raw: RawDelivered): { id: string; tag?: string } {
  const tag = str(raw.tag);
  return tag === undefined ? { id: String(raw.id ?? "") } : { id: String(raw.id ?? ""), tag };
}

/**
 * The notifications the app has in the notification centre: local ones and remote pushes alike,
 * most platforms newest first as the OS reports them. Group summaries (Android) are not listed.
 *
 * - iOS / Android: everything the OS shows for the app (needs `denext mobile add
 *   local-notifications` or `push`, generation 3 of denext's `DenextSettings` plugin; it rejects in
 *   a binary built before, until the command is re-run and a new binary shipped).
 * - Deno Desktop (`notifications` capability): the notifications denext posted during this run
 *   whose time has come and that were not removed through denext. The runtime cannot list the
 *   OS's notification centre, so one the user dismissed is still listed, and one from an earlier
 *   run is not.
 * - Web: the open notifications `scheduleNotification` showed from this page, plus the service
 *   worker registration's (a web push's thread is its `data.threadId`).
 *
 * @returns The delivered notifications.
 * @example
 * ```ts
 * import { deliveredNotifications } from "denext/mobile";
 *
 * const unread = (await deliveredNotifications()).filter((n) => n.threadId === chatId).length;
 * ```
 */
export async function deliveredNotifications(): Promise<DeliveredNotification[]> {
  const desktop = onDesktop() && await viaDesktop("notifications", (d) => d.notifyDelivered());
  if (desktop) return desktop.value.map((raw) => fromRaw(raw as RawDelivered));
  const plugin = deliveredPlugin();
  if (plugin) {
    return (await nativeDelivered(plugin)).filter((r) => r.summary !== true).map(fromRaw);
  }
  if (nativePlatform() !== "web") throw needsPlugin("deliveredNotifications");
  return (await webDelivered()).map((t) => t.entry);
}

/**
 * Remove delivered notifications from the notification centre — local ones and remote pushes
 * alike. Pending (scheduled) notifications are not touched: `cancelNotification` cancels those.
 *
 * The criteria given narrow each other: `{ threadId: "chat-7" }` removes the thread's
 * notifications, `{ ids: ["12"], threadId: "chat-7" }` only those of the ids in that thread. An
 * empty selector is a `TypeError` (so a missing argument never clears everything); pass
 * `{ all: true }` to remove every one. On Android, a group summary left without notifications in
 * its group is removed too. See {@linkcode deliveredNotifications} for what each platform can see.
 *
 * @param selector Which notifications to remove.
 * @returns A promise that settles once removed.
 * @example
 * ```ts
 * import { removeDeliveredNotifications } from "denext/mobile";
 *
 * // The user opened (or muted) chat 7: clear its notifications, pushes included.
 * await removeDeliveredNotifications({ threadId: "chat-7" });
 * ```
 */
export async function removeDeliveredNotifications(
  selector: DeliveredNotificationSelector,
): Promise<void> {
  checkSelector(selector);
  if (onDesktop()) {
    const done = await viaDesktop("notifications", async (d) => {
      const listed = (await d.notifyDelivered()).map((raw) => fromRaw(raw as RawDelivered));
      const ids = listed.filter((e) => matches(e, selector)).map((e) => Number(e.id));
      if (ids.length > 0) await d.notifyRemoveDelivered(ids);
    });
    if (done) return;
  }
  const plugin = deliveredPlugin();
  if (plugin) {
    const removals = nativeRemovals(await nativeDelivered(plugin), selector);
    if (removals.length > 0) await plugin.removeDeliveredNotifications({ notifications: removals });
    return;
  }
  if (nativePlatform() !== "web") throw needsPlugin("removeDeliveredNotifications");
  for (const t of await webDelivered()) {
    if (!matches(t.entry, selector)) continue;
    webShown.delete(t.entry.id);
    t.notification.close();
  }
}

/** Forget the page's tracked web notifications (tests only). */
export function resetDeliveredNotificationsForTesting(): void {
  webShown.clear();
}
