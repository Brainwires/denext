/**
 * Local notifications for `denext/mobile`, scheduled on the device through the native
 * `LocalNotifications` plugin (`@capacitor/local-notifications`, installed by `denext mobile add
 * local-notifications`): schedule, cancel and list them, Android channels, iOS / Android
 * categories with action buttons, and the received / tapped events. A tap routes through the
 * same link rules as a push tap (`data.path` / `data.url`).
 *
 * On the web a notification scheduled for now shows through the Notifications API (when
 * permission is granted); nothing can be scheduled for later, so a trigger rejects there.
 *
 * In a Deno Desktop window with the `notifications` capability (`denext desktop add
 * notifications`) and denext's pinned runtime, they are the OS's own notifications: scheduled
 * (repeating triggers too), cancelled and listed, with category action buttons, and a click
 * (including the one that launched the app) reaches `onLocalNotificationTapped`. Without the
 * capability, or under the stock runtime, the window takes the web path.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { nativePlatform } from "./bridge.ts";
import { onDesktop, viaDesktop } from "./desktop-branch.ts";
import { createFanout, type Fanout } from "./link-routing.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";
import { deliverTap, type PushTap, type PushTapOptions } from "./push.ts";
import { trackWebNotification, type WebNotificationLike } from "./delivered-notifications.ts";
import {
  dateOf,
  int,
  type LocalNotificationTrigger,
  nextMatch,
  secondsOf,
  triggerComponents,
} from "./notification-trigger.ts";

export {
  type CalendarComponents,
  type LocalNotificationTrigger,
  nextTriggerDate,
} from "./notification-trigger.ts";

/** A local notification to schedule. */
export interface LocalNotificationInput {
  /** Its id, a 32-bit integer (default: a random one). Scheduling an id again replaces it. */
  readonly id?: number;
  /** The title. */
  readonly title: string;
  /** The body text. */
  readonly body: string;
  /** When it fires (omitted or `null`: now). */
  readonly trigger?: LocalNotificationTrigger | null;
  /** Your payload; `path` / `url` route a tap as for push (see {@linkcode onLocalNotificationTapped}). */
  readonly data?: Readonly<Record<string, unknown>>;
  /** Android: the channel it posts to (see {@linkcode createNotificationChannel}). */
  readonly channelId?: string;
  /** The category whose action buttons it shows (see {@linkcode setNotificationCategories}). */
  readonly categoryId?: string;
  /** A sound file bundled with the app (iOS: in the app bundle; Android: `res/raw`, no extension). */
  readonly sound?: string;
  /**
   * Deliver it without a sound. iOS: no sound is attached (`sound` is ignored); Android: it posts
   * silently (the plugin's `silent` flag, so no channel sound plays); Deno Desktop: passed to the
   * runtime as `silent`, which the OS notification honours where its platform has a mute (macOS,
   * Windows, Linux); web: `new Notification(title, { silent })`.
   */
  readonly silent?: boolean;
  /** iOS: the app icon's badge number once it is delivered. */
  readonly badge?: number;
  /**
   * The thread it groups under: iOS's thread identifier (as APNs `thread-id` sets a push's),
   * Android's group key. `deliveredNotifications` reports it and `removeDeliveredNotifications({
   * threadId })` clears a thread's notifications, pushes of the same thread included. On Deno
   * Desktop and the web it groups only for those two calls (the OS does not group there).
   */
  readonly threadId?: string;
  /** The same as `threadId` (which wins when both are given). */
  readonly group?: string;
  /** Android: allow it to fire while the device dozes (at most once per ~9 minutes). */
  readonly allowWhileIdle?: boolean;
}

/** A scheduled (pending) local notification. */
export interface ScheduledLocalNotification {
  /** Its id. */
  readonly id: number;
  /** The title. */
  readonly title: string;
  /** The body. */
  readonly body: string;
  /** Your payload. */
  readonly data: Readonly<Record<string, unknown>>;
}

/** An Android notification channel. */
export interface NotificationChannel {
  /** Its id (what a notification's `channelId` names). */
  readonly id: string;
  /** The name the user sees in the app's notification settings. */
  readonly name: string;
  /** The description the user sees. */
  readonly description?: string;
  /** 1 (min) … 5 (max; heads-up); default 3. Fixed once created: the user owns it after. */
  readonly importance?: 1 | 2 | 3 | 4 | 5;
  /** A sound in `res/raw` (file name). */
  readonly sound?: string;
  /** Whether it vibrates. */
  readonly vibration?: boolean;
  /** Lock-screen visibility: -1 secret, 0 private, 1 public. */
  readonly visibility?: -1 | 0 | 1;
  /** Whether the LED lights, and its colour (`#RRGGBB`). */
  readonly lights?: boolean;
  /** The LED colour. */
  readonly lightColor?: string;
}

/** An action button on a notification. */
export interface NotificationAction {
  /** The id a tap on it reports as `actionId`. */
  readonly id: string;
  /** The button's title. */
  readonly title: string;
  /** Open the app when tapped (default: handle it in the background, iOS). */
  readonly foreground?: boolean;
  /** Show it as destructive (red, iOS). */
  readonly destructive?: boolean;
  /** Require the device to be unlocked (iOS). */
  readonly requiresAuthentication?: boolean;
  /** A text-input action (iOS): the typed text arrives as `inputValue`. */
  readonly input?: { readonly buttonTitle?: string; readonly placeholder?: string };
}

/** A category: a set of action buttons notifications opt into with `categoryId`. */
export interface NotificationCategory {
  /** Its id. On iOS, a remote push shows it by sending `aps.category` with this id. */
  readonly id: string;
  /** Its buttons. */
  readonly actions: readonly NotificationAction[];
  /** iOS: the body placeholder when previews are hidden. */
  readonly hiddenPreviewsPlaceholder?: string;
  /** iOS: report the user dismissing it as an action (`actionId` "dismiss"). */
  readonly customDismissAction?: boolean;
}

/** A local notification as the received / tapped events report it. */
export interface LocalNotification {
  /** Its id. */
  readonly id: number;
  /** The title. */
  readonly title?: string;
  /** The body. */
  readonly body?: string;
  /**
   * The payload the tap carries back. Untrusted input, not proof that your app scheduled it: on
   * Linux any process of the same user can forge a click (a D-Bus call on the app's name) with
   * any `data`, and on Windows the user's own processes can forge a toast activation. Validate it
   * before acting on it.
   */
  readonly data: Readonly<Record<string, unknown>>;
}

/** A tap on (or an action of) a local notification. */
export interface LocalNotificationTap {
  /** The notification. Its `data`, like the rest of the tap, is untrusted input. */
  readonly notification: LocalNotification;
  /** `"tap"` for the notification itself, else the action's id (untrusted, as `data` is). */
  readonly actionId: string;
  /** The text typed into a text-input action, if any (untrusted). */
  readonly inputValue?: string;
}

/** Options for {@linkcode onLocalNotificationTapped}: the same link rules as a push tap. */
export type LocalNotificationTapOptions = PushTapOptions;

/** A raw notification from the plugin (`LocalNotificationSchema`, trimmed). */
interface RawLocal {
  id?: unknown;
  title?: unknown;
  body?: unknown;
  extra?: unknown;
}

/** A raw tap from the plugin (`ActionPerformed`). */
interface RawLocalTap {
  actionId?: unknown;
  inputValue?: unknown;
  notification?: RawLocal;
}

/** The JS side of `@capacitor/local-notifications` (the parts used here). */
interface LocalPlugin {
  schedule(options: { notifications: Record<string, unknown>[] }): Promise<unknown>;
  getPending(): Promise<{ notifications?: RawLocal[] }>;
  cancel(options: { notifications: Array<{ id: number }> }): Promise<void>;
  registerActionTypes(options: { types: Record<string, unknown>[] }): Promise<void>;
  createChannel(channel: Record<string, unknown>): Promise<void>;
  deleteChannel(options: { id: string }): Promise<void>;
  listChannels(): Promise<{ channels?: Record<string, unknown>[] }>;
  addListener(
    eventName: string,
    listener: (event: never) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The native plugin, when the shell has it. Internal to `denext/mobile` and the Expo shim. */
export function localPlugin(): LocalPlugin | undefined {
  return nativePlugin<LocalPlugin>("LocalNotifications", [
    "schedule",
    "getPending",
    "cancel",
    "registerActionTypes",
    "addListener",
  ]);
}

/** The rejection for a call that needs the plugin. */
function needsPlugin(fn: string): Error {
  return new Error(
    `${fn}: needs the iOS/Android shell with @capacitor/local-notifications ` +
      "(`denext mobile add local-notifications`).",
  );
}

/** The plugin's `schedule` object for a trigger (none: deliver now). */
function scheduleOf(
  fn: string,
  trigger: LocalNotificationTrigger | null | undefined,
  allowWhileIdle: boolean | undefined,
): Record<string, unknown> | undefined {
  if (trigger === undefined || trigger === null) return undefined;
  const idle = allowWhileIdle === true ? { allowWhileIdle: true } : {};
  switch (trigger.type) {
    case "date":
      return { at: new Date(dateOf(fn, trigger.date)), ...idle };
    case "interval": {
      const seconds = secondsOf(fn, trigger);
      // `at` + `repeats` repeats every (at - now) on both platforms: exactly an interval.
      return {
        at: new Date(Date.now() + seconds * 1000),
        repeats: trigger.repeats === true,
        ...idle,
      };
    }
    case "calendar":
      if (trigger.repeats === false) {
        const at = nextMatch(triggerComponents(fn, trigger)!, Date.now());
        if (!at) throw new RangeError(`${fn}: the calendar trigger never matches`);
        return { at, ...idle };
      }
      return { on: triggerComponents(fn, trigger), ...idle };
    default: {
      const on = triggerComponents(fn, trigger);
      if (!on) {
        throw new TypeError(
          `${fn}: unknown trigger type "${String((trigger as { type?: unknown }).type)}"`,
        );
      }
      return { on, ...idle };
    }
  }
}

/** A random positive 32-bit id. */
function randomId(): number {
  return 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 0x7ffffffe);
}

/** The plugin's `LocalNotificationSchema` for an input. */
function schemaOf(fn: string, n: LocalNotificationInput): Record<string, unknown> {
  if (typeof n?.title !== "string" || typeof n.body !== "string") {
    throw new TypeError(`${fn}: a notification needs a string title and body`);
  }
  const id = n.id === undefined ? randomId() : int(fn, "id", n.id, -0x80000000, 0x7fffffff);
  const schema: Record<string, unknown> = { id, title: n.title, body: n.body };
  const schedule = scheduleOf(fn, n.trigger, n.allowWhileIdle);
  if (schedule) schema.schedule = schedule;
  if (n.data !== undefined) schema.extra = { ...n.data };
  if (n.channelId !== undefined) schema.channelId = n.channelId;
  if (n.categoryId !== undefined) schema.actionTypeId = n.categoryId;
  if (n.silent === true) {
    schema.silent = true;
    schema.sound = null; // iOS: an explicit no-sound; `silent` covers Android
  } else if (n.sound !== undefined) schema.sound = n.sound;
  if (n.badge !== undefined) schema.badge = n.badge;
  const thread = threadOf(n);
  if (thread !== undefined) {
    schema.group = thread;
    schema.threadIdentifier = thread;
  }
  return schema;
}

/** The thread of an input (`threadId`, else `group`), checked. */
function threadOf(n: LocalNotificationInput): string | undefined {
  const thread = n.threadId ?? n.group;
  if (thread !== undefined && typeof thread !== "string") {
    throw new TypeError("scheduleNotification: threadId must be a string");
  }
  return thread;
}

/** A notification as the Deno Desktop runtime takes it (the input's trigger, checked already). */
function desktopWire(schema: Record<string, unknown>, n: LocalNotificationInput) {
  return {
    id: schema.id as number,
    title: n.title,
    body: n.body,
    ...(n.data !== undefined ? { data: { ...n.data } } : {}),
    ...(n.categoryId !== undefined ? { categoryId: n.categoryId } : {}),
    ...(n.silent === true ? { silent: true } : {}),
    ...(typeof schema.threadIdentifier === "string" ? { threadId: schema.threadIdentifier } : {}),
    ...(n.trigger ? { trigger: n.trigger } : {}),
  };
}

/** A web Notification constructor with a granted permission, when the browser has one. */
function webNotification(): WebNotificationCtor | undefined {
  const ctor = (globalThis as { Notification?: unknown }).Notification as
    | WebNotificationCtor
    | undefined;
  return typeof ctor === "function" && ctor.permission === "granted" ? ctor : undefined;
}

/** The web `Notification` constructor, as far as {@linkcode scheduleNotification} uses it. */
interface WebNotificationCtor {
  new (
    title: string,
    options?: { body?: string; data?: unknown; silent?: boolean },
  ): WebNotificationLike;
  readonly permission?: string;
}

/**
 * Schedule a local notification (or show it now, without a trigger). Scheduling an `id` that is
 * already pending replaces it.
 *
 * Permission: ask first with `requestPermission("notifications")`; without it the OS drops
 * the notification silently. Android 12+ may deliver an exact-time trigger a few minutes late
 * unless the user allowed exact alarms.
 *
 * On the web there is no scheduler: a notification without a trigger shows through the
 * Notifications API (when permission is granted), and one with a trigger rejects. On Deno Desktop
 * with the `notifications` capability the OS schedules it (a repeating one for its next 16
 * occurrences, topped up whenever the app runs; Linux delivers while the app runs).
 *
 * @param notification What to show, and when.
 * @returns Its id (for {@linkcode cancelNotification}).
 * @example
 * ```ts
 * import { requestPermission, scheduleNotification } from "denext/mobile";
 *
 * if ((await requestPermission("notifications")) === "granted") {
 *   await scheduleNotification({
 *     title: "Stand-up",
 *     body: "In 10 minutes",
 *     trigger: { type: "weekly", weekday: 2, hour: 9, minute: 50 }, // Mondays 09:50
 *     data: { path: "/standup" }, // a tap opens /standup
 *   });
 * }
 * ```
 */
export async function scheduleNotification(notification: LocalNotificationInput): Promise<number> {
  const fn = "scheduleNotification";
  const schema = schemaOf(fn, notification);
  if (
    onDesktop() &&
    await viaDesktop("notifications", (d) => d.notifySchedule(desktopWire(schema, notification)))
  ) {
    return schema.id as number;
  }
  const plugin = localPlugin();
  if (plugin) {
    await plugin.schedule({ notifications: [schema] });
    return schema.id as number;
  }
  const show = webNotification();
  if (schema.schedule !== undefined || !show) throw needsPlugin(fn);
  const shown = new show(notification.title, {
    body: notification.body,
    ...(notification.data !== undefined ? { data: { ...notification.data } } : {}),
    ...(notification.silent === true ? { silent: true } : {}),
  });
  trackWebNotification(shown, {
    id: String(schema.id),
    title: notification.title,
    ...(schema.threadIdentifier !== undefined
      ? { threadId: schema.threadIdentifier as string }
      : {}),
    ...(notification.data !== undefined ? { data: { ...notification.data } } : {}),
  });
  return schema.id as number;
}

/**
 * Cancel pending local notifications (and remove delivered ones with those ids on Android).
 * An id that is not pending is ignored. Outside the shell it does nothing.
 *
 * @param ids One id or several.
 * @returns A promise that settles once cancelled.
 */
export async function cancelNotification(ids: number | readonly number[]): Promise<void> {
  const list = (Array.isArray(ids) ? ids : [ids]) as number[];
  if (list.length === 0) return;
  if (onDesktop() && await viaDesktop("notifications", (d) => d.notifyCancel(list))) return;
  await localPlugin()?.cancel({ notifications: list.map((id) => ({ id })) });
}

/**
 * Cancel every pending local notification. Outside the shell it does nothing.
 *
 * @returns A promise that settles once cancelled.
 */
export async function cancelAllNotifications(): Promise<void> {
  const pending = await pendingNotifications();
  await cancelNotification(pending.map((n) => n.id));
}

/** A string field, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A record, or `{}`. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** A raw notification as a {@linkcode LocalNotification}. */
function toLocal(raw: RawLocal | undefined): LocalNotification {
  return {
    id: Number(raw?.id ?? 0),
    title: str(raw?.title),
    body: str(raw?.body),
    data: record(raw?.extra),
  };
}

/**
 * The local notifications still waiting to fire (none outside the shell).
 *
 * @returns The pending notifications.
 */
export async function pendingNotifications(): Promise<ScheduledLocalNotification[]> {
  const desktop = onDesktop() && await viaDesktop("notifications", (d) => d.notifyPending());
  const plugin = localPlugin();
  if (!desktop && !plugin) return [];
  const raws = desktop ? desktop.value : (await plugin!.getPending()).notifications ?? [];
  return (raws as RawLocal[]).map((raw) => {
    const n = toLocal(raw);
    return { id: n.id, title: n.title ?? "", body: n.body ?? "", data: n.data };
  });
}

/**
 * Create (or update the name / description of) an Android notification channel. A
 * notification's `channelId` picks it; Android 8+ requires one (the plugin creates a default).
 * Resolves without doing anything on iOS and the web, which have no channels.
 *
 * @param channel The channel.
 * @returns A promise that settles once created.
 */
export async function createNotificationChannel(channel: NotificationChannel): Promise<void> {
  if (typeof channel?.id !== "string" || typeof channel.name !== "string") {
    throw new TypeError("createNotificationChannel: a channel needs a string id and name");
  }
  const create = channelMethod("createChannel");
  if (!create) return;
  await create({ importance: 3, ...channel });
}

/**
 * Delete an Android notification channel (nothing elsewhere).
 *
 * @param id The channel id.
 * @returns A promise that settles once deleted.
 */
export async function deleteNotificationChannel(id: string): Promise<void> {
  await channelMethod("deleteChannel")?.({ id });
}

/**
 * The app's Android notification channels (none elsewhere).
 *
 * @returns The channels.
 */
export async function listNotificationChannels(): Promise<NotificationChannel[]> {
  const list = channelMethod("listChannels");
  if (!list) return [];
  return ((await list()).channels ?? []).map((c) =>
    ({
      ...(c as Record<string, unknown>),
      id: String(c.id),
      name: String(c.name ?? c.id),
    }) as NotificationChannel
  );
}

/**
 * The channel methods, in the Android shell only (iOS's plugins reject them): local
 * notifications' plugin, else push's.
 */
function channelMethod<K extends "createChannel" | "deleteChannel" | "listChannels">(
  method: K,
): LocalPlugin[K] | undefined {
  if (nativePlatform() !== "android") return undefined;
  for (const name of ["LocalNotifications", "PushNotifications"]) {
    const plugin = nativePlugin<Pick<LocalPlugin, K>>(name, [method]);
    if (plugin) return plugin[method].bind(plugin) as LocalPlugin[K];
  }
  return undefined;
}

/** A category as the plugin's `ActionType`. */
function actionType(c: NotificationCategory): Record<string, unknown> {
  if (typeof c?.id !== "string" || !Array.isArray(c.actions)) {
    throw new TypeError("setNotificationCategories: a category needs a string id and actions");
  }
  return {
    id: c.id,
    actions: c.actions.map((a) => ({
      id: a.id,
      title: a.title,
      foreground: a.foreground === true,
      destructive: a.destructive === true,
      requiresAuthentication: a.requiresAuthentication === true,
      ...(a.input
        ? {
          input: true,
          inputButtonTitle: a.input.buttonTitle,
          inputPlaceholder: a.input.placeholder,
        }
        : {}),
    })),
    ...(c.hiddenPreviewsPlaceholder === undefined
      ? {}
      : { iosHiddenPreviewsBodyPlaceholder: c.hiddenPreviewsPlaceholder }),
    ...(c.customDismissAction === undefined
      ? {}
      : { iosCustomDismissAction: c.customDismissAction }),
  };
}

/**
 * Register the app's notification categories: the action buttons a notification shows when its
 * `categoryId` names one. The call **replaces** every category registered before, so pass the
 * full set each time.
 *
 * On iOS the categories live in the app's one `UNUserNotificationCenter`, so they apply to
 * remote pushes too: a push whose `aps.category` names a category shows its buttons, and the
 * tapped button arrives through `onPushTapped` as `actionId`. On Android they apply to local
 * notifications only (FCM draws its own notification without buttons). On Deno Desktop with
 * the `notifications` capability they are the notification's buttons (title only: no text input,
 * destructive or authentication options there). Elsewhere it does nothing.
 *
 * @param categories Every category.
 * @returns A promise that settles once registered.
 * @example
 * ```ts
 * import { setNotificationCategories } from "denext/mobile";
 *
 * await setNotificationCategories([{
 *   id: "message",
 *   actions: [
 *     { id: "reply", title: "Reply", input: { buttonTitle: "Send", placeholder: "Message" } },
 *     { id: "mark-read", title: "Mark as read" },
 *   ],
 * }]);
 * ```
 */
export async function setNotificationCategories(
  categories: readonly NotificationCategory[],
): Promise<void> {
  const types = categories.map(actionType);
  if (
    onDesktop() &&
    await viaDesktop("notifications", (d) => d.notifySetCategories(categories))
  ) return;
  await localPlugin()?.registerActionTypes({ types });
}

let receivedFanout: Fanout<LocalNotification> | undefined;
let tappedFanout: Fanout<LocalNotificationTap> | undefined;

/** A fan-out over one plugin event, mapped through `map`. */
function pluginFanout<Raw, T>(eventName: string, map: (raw: Raw) => T): Fanout<T> {
  return createFanout<T>((emit) =>
    listenerDisposer(localPlugin()?.addListener(eventName, (raw: never) => emit(map(raw))))
  );
}

/** A local tap as the push module's tap shape, so it routes the same way. */
function asPushTap(tap: LocalNotificationTap): PushTap {
  const { notification: n } = tap;
  return {
    notification: { id: String(n.id), title: n.title, body: n.body, data: n.data },
    actionId: tap.actionId,
    inputValue: tap.inputValue,
  };
}

/** A raw tap (the plugin's `ActionPerformed`) as a tap. */
function toLocalTap(raw: RawLocalTap | undefined): LocalNotificationTap {
  return {
    notification: toLocal(raw?.notification),
    actionId: str(raw?.actionId) ?? "tap",
    inputValue: str(raw?.inputValue),
  };
}

/** A desktop click as a tap. */
function fromDesktopTap(t: {
  id: number;
  actionId: string;
  title?: string;
  body?: string;
  data: Record<string, unknown>;
}): LocalNotificationTap {
  return {
    notification: { id: t.id, title: t.title, body: t.body, data: t.data },
    actionId: t.actionId,
  };
}

/** The desktop runtime's clicks (loaded lazily, so web and mobile bundles never fetch it). */
function desktopTapFanout(): Fanout<LocalNotificationTap> {
  return createFanout<LocalNotificationTap>((emit) => {
    let stop: (() => void) | undefined;
    let active = true;
    import("../desktop/native.ts").then((d) => {
      if (active) stop = d.onDesktopNotificationTap((t) => emit(fromDesktopTap(t)));
    }, () => {});
    return () => {
      active = false;
      stop?.();
    };
  });
}

/**
 * Where taps come from here: the native plugin; in a Deno Desktop window the runtime's
 * `notifications` capability (nothing arrives when it is not enabled); else nowhere.
 */
function tapFanout(): Fanout<LocalNotificationTap> | undefined {
  if (onDesktop()) return tappedFanout ??= desktopTapFanout();
  if (!localPlugin()) return undefined;
  return tappedFanout ??= pluginFanout<RawLocalTap, LocalNotificationTap>(
    "localNotificationActionPerformed",
    toLocalTap,
  );
}

/** Subscribe to taps with options read at delivery time. */
function subscribeTaps(
  callback: (tap: LocalNotificationTap) => void,
  options: () => LocalNotificationTapOptions,
): () => void {
  const fanout = tapFanout();
  if (!fanout) return () => {};
  return fanout.subscribe((tap, once) =>
    deliverTap(asPushTap(tap), once, () => callback(tap), options())
  );
}

/**
 * Call `callback` for each local notification delivered while the app is in the foreground.
 * Outside the shell it does nothing.
 *
 * @param callback Called with each notification.
 * @returns A function that unsubscribes.
 */
export function onLocalNotificationReceived(
  callback: (notification: LocalNotification) => void,
): () => void {
  if (!localPlugin()) return () => {};
  receivedFanout ??= pluginFanout<RawLocal, LocalNotification>(
    "localNotificationReceived",
    toLocal,
  );
  return receivedFanout.subscribe((n) => callback(n));
}

/**
 * Call `callback` when the user taps a local notification (or one of its actions), and by
 * default navigate to its `data.path` (an in-app path) or `data.url` (under the deep-link
 * acceptance rules), exactly as `onPushTapped` does for a push. A tap that
 * cold-started the app is kept by the shell (or the Deno Desktop runtime) for the first
 * listener, so subscribe early. In a Deno Desktop window it needs the `notifications`
 * capability. Elsewhere it does nothing.
 *
 * Treat a tap's `data` (and its action) as untrusted input: on Linux a click arrives as a D-Bus
 * call on the app's name, which any process of the same user can make with any `data` (as a
 * Windows toast activation can be forged by the user's own processes). Validate it before acting
 * on it; the default navigation already applies the deep-link acceptance rules.
 *
 * @param callback Called with each tap.
 * @param options Which links to accept, and how to navigate.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onLocalNotificationTapped } from "denext/mobile";
 *
 * const stop = onLocalNotificationTapped(({ actionId, inputValue }) => {
 *   if (actionId === "reply" && inputValue) sendReply(inputValue);
 * });
 * ```
 */
export function onLocalNotificationTapped(
  callback: (tap: LocalNotificationTap) => void,
  options: LocalNotificationTapOptions = {},
): () => void {
  return subscribeTaps(callback, () => options);
}

/**
 * Hook form of {@linkcode onLocalNotificationTapped}: subscribes on mount, unsubscribes on
 * unmount, and always uses the latest `callback` and `options`.
 *
 * @param callback Called with each tap.
 * @param options Which links to accept, and how to navigate.
 */
export function useLocalNotificationTapped(
  callback: (tap: LocalNotificationTap) => void,
  options?: LocalNotificationTapOptions,
): void {
  const latest = useRef({ callback, options });
  latest.current = { callback, options };
  useEffect(
    () => subscribeTaps((tap) => latest.current.callback(tap), () => latest.current.options ?? {}),
    [],
  );
}

/** Forget the shared listeners (tests only). */
export function resetLocalNotificationsForTesting(): void {
  receivedFanout = undefined;
  tappedFanout = undefined;
}
