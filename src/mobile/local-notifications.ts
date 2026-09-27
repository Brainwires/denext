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
 * In a Deno Desktop window (`denext desktop add notifications`) the desktop runtime shows them
 * as OS notifications, schedules triggers while the app runs (not after it quits), and routes
 * a click like a tap: it focuses the window, then `onLocalNotificationTapped` fires. There are
 * no action buttons, channels or categories on desktop.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { nativePlatform, runtimePlatform } from "./bridge.ts";
import { onDesktop, viaDesktop } from "./desktop-branch.ts";
import { createFanout, type Fanout } from "./link-routing.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";
import { deliverTap, type PushTap, type PushTapOptions } from "./push.ts";

/**
 * When a local notification fires. Months are 1–12 and weekdays 1–7 with 1 = Sunday (the
 * plugin's and iOS's convention); times are the device's local time.
 *
 * - `date`: once, at that moment.
 * - `interval`: `seconds` from now; with `repeats`, every `seconds` after that (at least 60).
 * - `daily` / `weekly` / `monthly` / `yearly`: repeating at that local time.
 * - `calendar`: whenever the given components match (unset ones match anything); with
 *   `repeats: false` only the next match.
 */
export type LocalNotificationTrigger =
  | { readonly type: "date"; readonly date: Date | number }
  | { readonly type: "interval"; readonly seconds: number; readonly repeats?: boolean }
  | { readonly type: "daily"; readonly hour: number; readonly minute: number }
  | {
    readonly type: "weekly";
    readonly weekday: number;
    readonly hour: number;
    readonly minute: number;
  }
  | {
    readonly type: "monthly";
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
  }
  | {
    readonly type: "yearly";
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
  }
  | ({ readonly type: "calendar"; readonly repeats?: boolean } & CalendarComponents);

/** The date components a `calendar` trigger matches. */
export interface CalendarComponents {
  /** The year. */
  readonly year?: number;
  /** The month, 1–12. */
  readonly month?: number;
  /** The day of the month, 1–31. */
  readonly day?: number;
  /** The weekday, 1–7 with 1 = Sunday. */
  readonly weekday?: number;
  /** The hour, 0–23. */
  readonly hour?: number;
  /** The minute, 0–59. */
  readonly minute?: number;
  /** The second, 0–59 (default 0). */
  readonly second?: number;
}

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
  /** iOS: the app icon's badge number once it is delivered. */
  readonly badge?: number;
  /** iOS: the thread it groups under; Android: the group key. */
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
  /** Your payload. */
  readonly data: Readonly<Record<string, unknown>>;
}

/** A tap on (or an action of) a local notification. */
export interface LocalNotificationTap {
  /** The notification. */
  readonly notification: LocalNotification;
  /** `"tap"` for the notification itself, else the action's id. */
  readonly actionId: string;
  /** The text typed into a text-input action, if any. */
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

/** A whole number in [min, max], or a RangeError naming `what`. */
function int(fn: string, what: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${fn}: ${what} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/** The optional calendar components, range-checked. */
function components(fn: string, c: CalendarComponents): CalendarComponents {
  const out: Record<string, number> = {};
  const ranges: Array<[keyof CalendarComponents, number, number]> = [
    ["year", 1970, 9999],
    ["month", 1, 12],
    ["day", 1, 31],
    ["weekday", 1, 7],
    ["hour", 0, 23],
    ["minute", 0, 59],
    ["second", 0, 59],
  ];
  for (const [key, min, max] of ranges) {
    if (c[key] !== undefined) out[key] = int(fn, key, c[key], min, max);
  }
  return out;
}

/** A trigger's calendar components (for the repeating kinds), checked. */
function triggerComponents(fn: string, t: LocalNotificationTrigger): CalendarComponents | null {
  switch (t.type) {
    case "daily":
      return components(fn, { hour: t.hour, minute: t.minute });
    case "weekly":
      return components(fn, { weekday: t.weekday, hour: t.hour, minute: t.minute });
    case "monthly":
      return components(fn, { day: t.day, hour: t.hour, minute: t.minute });
    case "yearly":
      return components(fn, { month: t.month, day: t.day, hour: t.hour, minute: t.minute });
    case "calendar":
      return components(fn, t);
    default:
      return null;
  }
}

/** Whether `date` matches `c` (unset components match anything). */
function matches(date: Date, c: CalendarComponents): boolean {
  return (c.year === undefined || date.getFullYear() === c.year) &&
    (c.month === undefined || date.getMonth() + 1 === c.month) &&
    (c.day === undefined || date.getDate() === c.day) &&
    (c.weekday === undefined || date.getDay() + 1 === c.weekday);
}

/** The first local time on `day` at or after `after` whose time matches `c`, or null. */
function timeOnDay(day: Date, after: number, c: CalendarComponents): Date | null {
  const hours = c.hour === undefined ? [...Array(24).keys()] : [c.hour];
  const minutes = c.minute === undefined ? [...Array(60).keys()] : [c.minute];
  for (const h of hours) {
    for (const m of minutes) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, c.second ?? 0);
      if (at.getTime() > after) return at;
    }
  }
  return null;
}

/** The next local time after `after` matching `c`, searching up to eight years ahead. */
function nextMatch(c: CalendarComponents, after: number): Date | null {
  const start = new Date(after);
  for (let i = 0; i < 366 * 8; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (!matches(day, c)) continue;
    const at = timeOnDay(day, after, c);
    if (at) return at;
  }
  return null;
}

/** A `date` trigger's time, checked. */
function dateOf(fn: string, date: Date | number): number {
  const ms = date instanceof Date ? date.getTime() : date;
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new TypeError(`${fn}: trigger.date must be a Date or a timestamp in milliseconds`);
  }
  return ms;
}

/** An `interval` trigger's seconds, checked (a repeating one needs at least 60). */
function secondsOf(fn: string, t: { seconds: number; repeats?: boolean }): number {
  const min = t.repeats ? 60 : 1;
  if (typeof t.seconds !== "number" || !Number.isFinite(t.seconds) || t.seconds < min) {
    throw new RangeError(
      `${fn}: trigger.seconds must be at least ${min}${
        t.repeats ? " for a repeating interval" : ""
      }`,
    );
  }
  return t.seconds;
}

/**
 * When `trigger` next fires after `from` (default now), or null when it never will (a date in
 * the past, a calendar match that does not exist). Internal to `denext/mobile` and the Expo
 * shim's `getNextTriggerDateAsync`.
 */
export function nextTriggerDate(
  trigger: LocalNotificationTrigger,
  from: number = Date.now(),
): Date | null {
  const fn = "nextTriggerDate";
  if (trigger.type === "date") {
    const at = dateOf(fn, trigger.date);
    return at > from ? new Date(at) : null;
  }
  if (trigger.type === "interval") return new Date(from + secondsOf(fn, trigger) * 1000);
  const c = triggerComponents(fn, trigger);
  if (!c) {
    throw new TypeError(
      `${fn}: unknown trigger type "${String((trigger as { type?: unknown }).type)}"`,
    );
  }
  return nextMatch(c, from);
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
  if (n.sound !== undefined) schema.sound = n.sound;
  if (n.badge !== undefined) schema.badge = n.badge;
  if (n.group !== undefined) {
    schema.group = n.group;
    schema.threadIdentifier = n.group;
  }
  return schema;
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
  new (title: string, options?: { body?: string }): unknown;
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
 * Notifications API (when permission is granted), and one with a trigger rejects.
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
  if (onDesktop() && await viaDesktop("notifications", (d) => d.notifySchedule(schema))) {
    return schema.id as number;
  }
  const plugin = localPlugin();
  if (plugin) {
    await plugin.schedule({ notifications: [schema] });
    return schema.id as number;
  }
  const show = webNotification();
  if (schema.schedule !== undefined || !show) throw needsPlugin(fn);
  new show(notification.title, { body: notification.body });
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
 * notifications only (FCM draws its own notification without buttons). Outside the shell it
 * does nothing.
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
  await localPlugin()?.registerActionTypes({ types });
}

let receivedFanout: Fanout<LocalNotification> | undefined;
let tappedFanout: Fanout<LocalNotificationTap> | undefined;
let desktopTappedFanout: Fanout<LocalNotificationTap> | undefined;

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

/** A raw tap (the plugin's `ActionPerformed`, or the desktop runtime's click) as a tap. */
function toLocalTap(raw: RawLocalTap | undefined): LocalNotificationTap {
  return {
    notification: toLocal(raw?.notification),
    actionId: str(raw?.actionId) ?? "tap",
    inputValue: str(raw?.inputValue),
  };
}

/**
 * The fan-out over Deno Desktop notification clicks (the runtime focuses the window, then
 * emits `notifications` / `click` on the bridge's event stream). The desktop module loads
 * lazily, only in a desktop window.
 */
function desktopTaps(): Fanout<LocalNotificationTap> {
  return desktopTappedFanout ??= createFanout<LocalNotificationTap>((emit) =>
    listenerDisposer(
      import("../desktop/native.ts").then((d) => ({
        remove: d.onNotificationClick((raw) => emit(toLocalTap(raw as RawLocalTap))),
      })),
    )
  );
}

/** Where taps come from here: the desktop runtime, the native plugin, or nowhere. */
function tapFanout(): Fanout<LocalNotificationTap> | undefined {
  if (runtimePlatform() === "desktop") return desktopTaps();
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
 * cold-started the app is kept by the shell for the first listener, so subscribe early.
 * Outside the shell it does nothing.
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
  desktopTappedFanout = undefined;
}
