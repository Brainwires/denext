/**
 * `expo-notifications` for denext: the remote-push subset over `denext/mobile`'s push API
 * (`@capacitor/push-notifications` in the Capacitor shell: APNs on iOS, FCM on Android).
 *
 * Provided: permissions, the device push token, the received / response listeners (the tap
 * that cold-started the app included, remote and local), `setNotificationHandler`, badges,
 * delivered notifications, Android channels, and local scheduling with categories over
 * `denext/mobile`'s local notifications (`@capacitor/local-notifications`, `denext mobile add
 * local-notifications`). Expo's push service is not: `getExpoPushTokenAsync` rejects with
 * guidance, so send through APNs / FCM from your server with the device token. Channel groups,
 * topics and background tasks are not provided (see the manifest).
 *
 * On the web there is no push: permissions follow the Notifications API and
 * `getDevicePushTokenAsync` rejects.
 *
 * @example
 * ```ts
 * import * as Notifications from "denext/expo/notifications";
 *
 * if ((await Notifications.requestPermissionsAsync()).granted) {
 *   const { data: token } = await Notifications.getDevicePushTokenAsync();
 *   await registerDevice(token);
 * }
 * Notifications.addNotificationResponseReceivedListener((r) => open(r.notification));
 * ```
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import {
  onPushReceived,
  onPushTapped,
  type PushNotification,
  registerForPush,
  requestPushPermission,
} from "../mobile/push.ts";
import {
  cancelNotification,
  type LocalNotification,
  type LocalNotificationTrigger,
  localPlugin,
  nextTriggerDate,
  onLocalNotificationReceived,
  onLocalNotificationTapped,
  scheduleNotification,
  setNotificationCategories,
} from "../mobile/local-notifications.ts";
import {
  createEmitter,
  type Emitter,
  type PermissionExpiration,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
  type Subscription,
  subscription,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionResponse, Subscription };

/** The action id of a plain tap on a notification. */
export const DEFAULT_ACTION_IDENTIFIER = "expo.modules.notifications.actions.DEFAULT";

/** Android channel importance. */
export enum AndroidImportance {
  /** Unknown. */
  UNKNOWN = 0,
  /** Unspecified. */
  UNSPECIFIED = 1,
  /** None. */
  NONE = 2,
  /** Min. */
  MIN = 3,
  /** Low. */
  LOW = 4,
  /** Default. */
  DEFAULT = 5,
  /** High. */
  HIGH = 6,
  /** Max. */
  MAX = 7,
}

/** Android lock-screen visibility. */
export enum AndroidNotificationVisibility {
  /** Unknown. */
  UNKNOWN = 0,
  /** Public. */
  PUBLIC = 1,
  /** Private. */
  PRIVATE = 2,
  /** Secret. */
  SECRET = 3,
}

/** Android notification priority. */
export enum AndroidNotificationPriority {
  /** Min. */
  MIN = "min",
  /** Low. */
  LOW = "low",
  /** Default. */
  DEFAULT = "default",
  /** High. */
  HIGH = "high",
  /** Max. */
  MAX = "max",
}

/** Local-notification trigger kinds, for {@linkcode scheduleNotificationAsync}. */
export enum SchedulableTriggerInputTypes {
  /** Calendar. */
  CALENDAR = "calendar",
  /** Daily. */
  DAILY = "daily",
  /** Weekly. */
  WEEKLY = "weekly",
  /** Monthly. */
  MONTHLY = "monthly",
  /** Yearly. */
  YEARLY = "yearly",
  /** A date. */
  DATE = "date",
  /** A time interval. */
  TIME_INTERVAL = "timeInterval",
}

/** iOS authorization status. */
export enum IosAuthorizationStatus {
  /** Not asked. */
  NOT_DETERMINED = 0,
  /** Denied. */
  DENIED = 1,
  /** Authorized. */
  AUTHORIZED = 2,
  /** Provisional. */
  PROVISIONAL = 3,
  /** Ephemeral. */
  EPHEMERAL = 4,
}

/** A notification's content. */
export interface NotificationContent {
  /** The title. */
  title: string | null;
  /** The subtitle. */
  subtitle: string | null;
  /** The body. */
  body: string | null;
  /** The custom payload. */
  data?: Record<string, unknown>;
  /** The category. */
  categoryIdentifier: string | null;
  /** The sound. */
  sound: "default" | "defaultCritical" | "custom" | "defaultRingtone" | null;
}

/** A notification request: its id, content and trigger. */
export interface NotificationRequest {
  /** The notification's id. */
  identifier: string;
  /** Its content. */
  content: NotificationContent;
  /**
   * What triggered it: `{ type: "push" }` for a remote notification, the trigger it was
   * scheduled with for a local one.
   */
  trigger: { type: "push"; payload?: Record<string, unknown> } | NotificationTriggerInput;
}

/** A delivered notification. */
export interface Notification {
  /** When it arrived, in ms since the epoch. */
  date: number;
  /** Its request. */
  request: NotificationRequest;
}

/** The user's response to a notification (a tap or an action). */
export interface NotificationResponse {
  /** The notification. */
  notification: Notification;
  /** {@linkcode DEFAULT_ACTION_IDENTIFIER} for a tap, else the action's id. */
  actionIdentifier: string;
  /** Text typed into a text-input action. */
  userText?: string;
}

/** A response, null (none), or undefined (not known yet). */
export type MaybeNotificationResponse = NotificationResponse | null | undefined;

/** How a foreground notification is presented. */
export interface NotificationBehavior {
  /** Show a banner. */
  shouldShowBanner?: boolean;
  /** Add it to the notification list. */
  shouldShowList?: boolean;
  /** Play a sound. */
  shouldPlaySound: boolean;
  /** Set the badge. */
  shouldSetBadge: boolean;
  /** Show an alert (deprecated in Expo). */
  shouldShowAlert?: boolean;
}

/** Decides how foreground notifications are presented. */
export interface NotificationHandler {
  /** The behaviour for `notification`. */
  handleNotification: (notification: Notification) => Promise<NotificationBehavior>;
  /** Called once handled. */
  handleSuccess?: (notificationId: string) => void;
  /** Called when handling failed. */
  handleError?: (notificationId: string, error: Error) => void;
}

/** A permission answer with the platform details. */
export interface NotificationPermissionsStatus extends PermissionResponse {
  /** Android details. */
  android?: { importance: number; interruptionFilter?: number };
  /** iOS details. */
  ios?: { status: IosAuthorizationStatus };
}

/** Which permissions to request (the iOS flags are accepted and ignored). */
export interface NotificationPermissionsRequest {
  /** iOS options. */
  ios?: Record<string, boolean | undefined>;
  /** Android options. */
  android?: object;
}

/** A native device push token: APNs (iOS) or FCM (Android). */
export interface DevicePushToken {
  /** The platform. */
  type: "ios" | "android";
  /** The token. */
  data: string;
}

/** A push-token listener. */
export type PushTokenListener = (token: DevicePushToken) => void;

/** An Android notification channel. */
export interface NotificationChannel {
  /** Its id. */
  id: string;
  /** Its name. */
  name: string | null;
  /** Its importance. */
  importance: AndroidImportance;
  /** Its description. */
  description?: string | null;
  /** Whether it shows a badge. */
  showBadge?: boolean;
  /** Its sound. */
  sound?: string | null;
  /** Whether it vibrates. */
  enableVibrate?: boolean;
  /** Its lock-screen visibility. */
  lockscreenVisibility?: AndroidNotificationVisibility;
  /** Its light colour. */
  lightColor?: string;
}

/** What {@linkcode setNotificationChannelAsync} takes. */
export type NotificationChannelInput = Partial<Omit<NotificationChannel, "id">> & {
  /** The name. */
  name: string | null;
  /** The importance. */
  importance: AndroidImportance;
};

/** The parts of `@capacitor/push-notifications` beyond what `denext/mobile` wraps. */
interface PushExtras {
  checkPermissions?: () => Promise<{ receive?: string }>;
  getDeliveredNotifications?: () => Promise<{ notifications?: RawDelivered[] }>;
  removeDeliveredNotifications?: (o: { notifications: RawDelivered[] }) => Promise<void>;
  removeAllDeliveredNotifications?: () => Promise<void>;
  createChannel?: (channel: Record<string, unknown>) => Promise<void>;
  deleteChannel?: (o: { id: string }) => Promise<void>;
  listChannels?: () => Promise<{ channels?: Record<string, unknown>[] }>;
  unregister?: () => Promise<void>;
}

/** A delivered notification as the plugin lists it. */
interface RawDelivered {
  id?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

/**
 * The push plugin with `method`, when the shell has it; for the channel and delivered-list
 * calls, the local-notifications plugin (which has the same methods) otherwise.
 */
function pushExtra<K extends keyof PushExtras>(method: K): Required<PushExtras>[K] | undefined {
  for (const name of ["PushNotifications", "LocalNotifications"]) {
    if (
      name === "LocalNotifications" && (method === "unregister" || method === "checkPermissions")
    ) {
      continue;
    }
    const plugin = nativePlugin<PushExtras>(name, [method]);
    if (plugin) return plugin[method]?.bind(plugin) as Required<PushExtras>[K] | undefined;
  }
  return undefined;
}

/** A `denext/mobile` notification as Expo's. */
function toNotification(push: PushNotification | RawDelivered): Notification {
  const data = (push.data ?? {}) as Record<string, unknown>;
  return {
    date: Date.now(),
    request: {
      identifier: push.id ?? crypto.randomUUID(),
      content: {
        title: push.title ?? null,
        subtitle: null,
        body: push.body ?? null,
        data,
        categoryIdentifier: null,
        sound: null,
      },
      trigger: { type: "push", payload: data },
    },
  };
}

/** A permission status with Expo's platform details. */
function withDetails(status: PermissionStatus): NotificationPermissionsStatus {
  const ios = status === PermissionStatus.GRANTED
    ? IosAuthorizationStatus.AUTHORIZED
    : status === PermissionStatus.DENIED
    ? IosAuthorizationStatus.DENIED
    : IosAuthorizationStatus.NOT_DETERMINED;
  return { ...permissionResponse(status), ios: { status: ios } };
}

/** A plugin / Notifications API permission string as a status. */
function statusOf(state: string | undefined): PermissionStatus {
  if (state === "granted") return PermissionStatus.GRANTED;
  return state === "denied" ? PermissionStatus.DENIED : PermissionStatus.UNDETERMINED;
}

/** The web Notifications API, when the browser has it. */
function webNotifications():
  | { permission?: string; requestPermission?: () => Promise<string> }
  | undefined {
  return (globalThis as { Notification?: { permission?: string } }).Notification;
}

/**
 * Whether the app may show notifications (the plugin's state natively, the Notifications
 * API's on the web).
 *
 * @returns The permission.
 */
export async function getPermissionsAsync(): Promise<NotificationPermissionsStatus> {
  const check = pushExtra("checkPermissions");
  if (check) return withDetails(statusOf((await check()).receive));
  return withDetails(statusOf(webNotifications()?.permission));
}

/**
 * Ask for permission to show notifications (no prompt when already decided).
 *
 * @param _permissions iOS options (accepted, ignored).
 * @returns The permission.
 */
export async function requestPermissionsAsync(
  _permissions?: NotificationPermissionsRequest,
): Promise<NotificationPermissionsStatus> {
  const result = await requestPushPermission();
  if (result !== "unsupported") return withDetails(statusOf(result));
  const request = webNotifications()?.requestPermission;
  return withDetails(statusOf(request ? await request() : "denied"));
}

let tokenEmitter: Emitter<DevicePushToken> | undefined;

/**
 * Register for remote notifications and resolve with the device token (APNs on iOS, FCM on
 * Android). Rejects on the web (no web push here).
 *
 * @returns The token.
 */
export async function getDevicePushTokenAsync(): Promise<DevicePushToken> {
  const { platform, token } = await registerForPush();
  const result: DevicePushToken = { type: platform, data: token };
  tokenEmitter?.emit(result);
  return result;
}

/** An Expo push token, as Expo's push service issues it. */
export interface ExpoPushToken {
  /** Always `"expo"`. */
  type: "expo";
  /** The token (`ExponentPushToken[…]`). */
  data: string;
}

/** Options Expo's `getExpoPushTokenAsync` takes (accepted and not used here). */
export interface ExpoPushTokenOptions {
  /** Expo's API base URL. */
  baseUrl?: string;
  /** The registration URL. */
  url?: string;
  /** The token type. */
  type?: string;
  /** The installation id. */
  deviceId?: string;
  /** Use the development push service. */
  development?: boolean;
  /** The EAS project id. */
  projectId?: string;
  /** The application id. */
  applicationId?: string;
  /** A device token to register instead of asking for one. */
  devicePushToken?: DevicePushToken;
}

/**
 * Expo's push-token call. denext has no Expo push service, and wrapping the native token in
 * Expo's shape would hand your server a token Expo's push API rejects, so this always
 * rejects with code `ERR_NOTIFICATIONS_NO_EXPO_PUSH_SERVICE`: register the device token from
 * {@linkcode getDevicePushTokenAsync} with your own server and send through APNs / FCM
 * with any APNs / FCM sender.
 *
 * @param _options Expo's options (not used).
 * @returns Never resolves.
 */
export function getExpoPushTokenAsync(_options: ExpoPushTokenOptions = {}): Promise<ExpoPushToken> {
  return Promise.reject(
    Object.assign(
      new Error(
        "denext/expo: expo-notifications' getExpoPushTokenAsync needs Expo's push service, which " +
          "denext does not have. Call getDevicePushTokenAsync() for the APNs / FCM device token, " +
          "register it with your own server, and send through APNs / FCM.",
      ),
      { code: "ERR_NOTIFICATIONS_NO_EXPO_PUSH_SERVICE" },
    ),
  );
}

/**
 * Call `listener` whenever {@linkcode getDevicePushTokenAsync} obtains a token.
 *
 * @param listener Called with each token.
 * @returns A subscription to remove.
 */
export function addPushTokenListener(listener: PushTokenListener): Subscription {
  return (tokenEmitter ??= createEmitter()).subscribe(listener);
}

/**
 * Unregister from remote notifications (natively; nothing to do on the web).
 *
 * @returns A promise that settles once unregistered.
 */
export async function unregisterForNotificationsAsync(): Promise<void> {
  await pushExtra("unregister")?.();
}

let handler: NotificationHandler | null = null;
let receivedEmitter: Emitter<Notification> | undefined;

/** The received-notification fan-out, sharing one `denext/mobile` subscription. */
function received(): Emitter<Notification> {
  return receivedEmitter ??= createEmitter((emit) => {
    const deliver = (notification: Notification) => {
      runHandler(notification);
      emit(notification);
    };
    const stopPush = onPushReceived((push) => deliver(toNotification(push)));
    const stopLocal = onLocalNotificationReceived((local) => deliver(fromLocal(local)));
    return () => {
      stopPush();
      stopLocal();
    };
  });
}

/** Give `notification` to the handler, reporting success or failure to it. */
function runHandler(notification: Notification): void {
  const current = handler;
  if (!current) return;
  const id = notification.request.identifier;
  Promise.resolve()
    .then(() => current.handleNotification(notification))
    .then(() => current.handleSuccess?.(id), (err) => current.handleError?.(id, err as Error));
}

/**
 * Set the handler foreground notifications go through. The shell's presentation is set by
 * the Capacitor plugin's `presentationOptions`, so the behaviour it returns is not applied;
 * the handler is still called, with `handleSuccess` / `handleError`.
 *
 * @param next The handler, or null to remove it.
 */
export function setNotificationHandler(next: NotificationHandler | null): void {
  handler = next;
  if (next) received();
}

/**
 * Call `listener` for each notification that arrives while the app is in the foreground.
 *
 * @param listener Called with each notification.
 * @returns A subscription to remove.
 */
export function addNotificationReceivedListener(
  listener: (event: Notification) => void,
): Subscription {
  return received().subscribe(listener);
}

/**
 * Listen for dropped notifications (FCM): never reported here.
 *
 * @param _listener Never called.
 * @returns A subscription to remove.
 */
export function addNotificationsDroppedListener(_listener: () => void): Subscription {
  return subscription(() => {});
}

let lastResponse: NotificationResponse | null = null;
let responseEmitter: Emitter<NotificationResponse> | undefined;
let stopWatchingTaps: (() => void) | undefined;
const clearedEmitter: { current?: Emitter<void> } = {};

/**
 * Start (once) recording taps, so the one that cold-started the app is kept even before a
 * listener subscribes.
 */
function watchTaps(): Emitter<NotificationResponse> {
  responseEmitter ??= createEmitter();
  const respond = (notification: Notification, actionId: string, text: string | undefined) => {
    lastResponse = {
      notification,
      actionIdentifier: actionId === "tap" ? DEFAULT_ACTION_IDENTIFIER : actionId,
      ...(text === undefined ? {} : { userText: text }),
    };
    responseEmitter!.emit(lastResponse);
  };
  if (!stopWatchingTaps) {
    const stopPush = onPushTapped(
      (tap) => respond(toNotification(tap.notification), tap.actionId, tap.inputValue),
      { route: false },
    );
    const stopLocal = onLocalNotificationTapped(
      (tap) => respond(fromLocal(tap.notification), tap.actionId, tap.inputValue),
      { route: false },
    );
    stopWatchingTaps = () => {
      stopPush();
      stopLocal();
    };
  }
  return responseEmitter;
}

/**
 * Call `listener` when the user taps a notification (or one of its actions), the cold-start
 * tap included.
 *
 * @param listener Called with each response.
 * @returns A subscription to remove.
 */
export function addNotificationResponseReceivedListener(
  listener: (event: NotificationResponse) => void,
): Subscription {
  return watchTaps().subscribe(listener);
}

/**
 * The latest response (the cold-start tap, when there was one).
 *
 * @returns The response, or null.
 */
export async function getLastNotificationResponseAsync(): Promise<NotificationResponse | null> {
  watchTaps();
  // The shell hands a buffered cold-start tap to a new listener asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return lastResponse;
}

/**
 * The latest response, synchronously.
 *
 * @returns The response, or null.
 */
export function getLastNotificationResponse(): NotificationResponse | null {
  watchTaps();
  return lastResponse;
}

/** Forget the latest response. */
export function clearLastNotificationResponse(): void {
  lastResponse = null;
  clearedEmitter.current?.emit();
}

/**
 * Forget the latest response.
 *
 * @returns A promise that settles once cleared.
 */
export function clearLastNotificationResponseAsync(): Promise<void> {
  clearLastNotificationResponse();
  return Promise.resolve();
}

/**
 * Call `listener` when the latest response is cleared.
 *
 * @param listener Called on each clear.
 * @returns A subscription to remove.
 */
export function addNotificationResponseClearedListener(listener: () => void): Subscription {
  return (clearedEmitter.current ??= createEmitter()).subscribe(listener);
}

/**
 * Hook form: the latest response (undefined until known, null when there is none).
 *
 * @returns The response.
 */
export function useLastNotificationResponse(): MaybeNotificationResponse {
  const [response, setResponse] = useState<MaybeNotificationResponse>(undefined);
  useEffect(() => {
    let active = true;
    const sub = addNotificationResponseReceivedListener((r) => setResponse(r));
    const cleared = addNotificationResponseClearedListener(() => setResponse(null));
    getLastNotificationResponseAsync().then((r) => active && setResponse(r), () => {});
    return () => {
      active = false;
      sub.remove();
      cleared.remove();
    };
  }, []);
  return response;
}

let badge = 0;

/**
 * The badge count set through {@linkcode setBadgeCountAsync} (the OS count is not readable
 * here).
 *
 * @returns The count.
 */
export function getBadgeCountAsync(): Promise<number> {
  return Promise.resolve(badge);
}

/** Options for {@linkcode setBadgeCountAsync}. */
export interface SetBadgeCountOptions {
  /**
   * Expo's web badge options (the `badgin` library's `method`, `favicon`, `title`). Ignored:
   * the badge is always set through the Badging API.
   */
  web?: Record<string, unknown>;
}

/**
 * Set the app badge through the Badging API where the browser (or installed PWA) has it.
 *
 * @param count The count (0 clears it).
 * @param _options Expo's web options (ignored: there is no favicon or title fallback).
 * @returns `true` when the badge was set.
 */
export async function setBadgeCountAsync(
  count: number,
  _options?: SetBadgeCountOptions,
): Promise<boolean> {
  badge = count;
  const nav = (globalThis as {
    navigator?: { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  }).navigator;
  if (typeof nav?.setAppBadge !== "function") return false;
  try {
    await (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.());
    return true;
  } catch {
    return false;
  }
}

/**
 * The notifications shown in the notification centre (natively).
 *
 * @returns The notifications, or none on the web.
 */
export async function getPresentedNotificationsAsync(): Promise<Notification[]> {
  const list = pushExtra("getDeliveredNotifications");
  return list ? ((await list()).notifications ?? []).map(toNotification) : [];
}

/**
 * Remove one notification from the notification centre (natively).
 *
 * @param notificationIdentifier Its id.
 * @returns A promise that settles once removed.
 */
export async function dismissNotificationAsync(notificationIdentifier: string): Promise<void> {
  await pushExtra("removeDeliveredNotifications")?.({
    notifications: [{ id: notificationIdentifier }],
  });
}

/**
 * Remove every notification from the notification centre (natively).
 *
 * @returns A promise that settles once removed.
 */
export async function dismissAllNotificationsAsync(): Promise<void> {
  await pushExtra("removeAllDeliveredNotifications")?.();
}

/**
 * Create or update an Android notification channel (natively on Android; null elsewhere).
 *
 * @param channelId The channel id.
 * @param channel Its settings.
 * @returns The channel, or null where channels do not exist.
 */
export async function setNotificationChannelAsync(
  channelId: string,
  channel: NotificationChannelInput,
): Promise<NotificationChannel | null> {
  const create = pushExtra("createChannel");
  if (!create) return null;
  await create({
    id: channelId,
    name: channel.name ?? channelId,
    importance: Math.max(1, Math.min(5, channel.importance - 2)),
    description: channel.description ?? undefined,
    sound: channel.sound ?? undefined,
    vibration: channel.enableVibrate,
    visibility: channel.lockscreenVisibility,
    lightColor: channel.lightColor,
  });
  return { ...channel, id: channelId };
}

/**
 * The Android notification channels (natively on Android; none elsewhere).
 *
 * @returns The channels.
 */
export async function getNotificationChannelsAsync(): Promise<NotificationChannel[]> {
  const list = pushExtra("listChannels");
  if (!list) return [];
  return ((await list()).channels ?? []).map((c) => ({
    id: String(c.id),
    name: typeof c.name === "string" ? c.name : null,
    importance: (Number(c.importance ?? 3) + 2) as AndroidImportance,
  }));
}

/**
 * One Android notification channel.
 *
 * @param channelId The channel id.
 * @returns The channel, or null.
 */
export async function getNotificationChannelAsync(
  channelId: string,
): Promise<NotificationChannel | null> {
  return (await getNotificationChannelsAsync()).find((c) => c.id === channelId) ?? null;
}

/**
 * Delete an Android notification channel.
 *
 * @param channelId The channel id.
 * @returns A promise that settles once deleted.
 */
export async function deleteNotificationChannelAsync(channelId: string): Promise<void> {
  await pushExtra("deleteChannel")?.({ id: channelId });
}

// ---- Local scheduling (over denext/mobile's local notifications) -----------------------------

/** A trigger that only names the Android channel (delivered now). */
export type ChannelAwareTriggerInput = {
  /** The Android channel. */
  channelId: string;
};

/** Whenever the given date components match (iOS; Android repeats it the same way here). */
export type CalendarTriggerInput = {
  /** The kind. */
  type: SchedulableTriggerInputTypes.CALENDAR;
  /** The Android channel. */
  channelId?: string;
  /** Repeat on every match (default `false`: the next match only). */
  repeats?: boolean;
  /** Not applied here. */
  seconds?: number;
  /** Not applied here (the device's time zone is used). */
  timezone?: string;
  /** The year. */
  year?: number;
  /** The month, 1–12. */
  month?: number;
  /** The weekday, 1–7 with 1 = Sunday. */
  weekday?: number;
  /** Not applied here. */
  weekOfMonth?: number;
  /** Not applied here. */
  weekOfYear?: number;
  /** Not applied here. */
  weekdayOrdinal?: number;
  /** The day of the month. */
  day?: number;
  /** The hour. */
  hour?: number;
  /** The minute. */
  minute?: number;
  /** The second. */
  second?: number;
};

/** Every day at `hour`:`minute`. */
export type DailyTriggerInput = {
  /** The kind. */
  type: SchedulableTriggerInputTypes.DAILY;
  /** The Android channel. */
  channelId?: string;
  /** The hour. */
  hour: number;
  /** The minute. */
  minute: number;
};

/** Every week on `weekday` (1–7, 1 = Sunday) at `hour`:`minute`. */
export type WeeklyTriggerInput = {
  /** The kind. */
  type: SchedulableTriggerInputTypes.WEEKLY;
  /** The Android channel. */
  channelId?: string;
  /** The weekday, 1–7 with 1 = Sunday. */
  weekday: number;
  /** The hour. */
  hour: number;
  /** The minute. */
  minute: number;
};

/** Every month on `day` at `hour`:`minute`. */
export type MonthlyTriggerInput = {
  /** The kind. */
  type: SchedulableTriggerInputTypes.MONTHLY;
  /** The Android channel. */
  channelId?: string;
  /** The day of the month. */
  day: number;
  /** The hour. */
  hour: number;
  /** The minute. */
  minute: number;
};

/** Every year on `month` (0–11, as Expo's) / `day` at `hour`:`minute`. */
export type YearlyTriggerInput = {
  /** The kind. */
  type: SchedulableTriggerInputTypes.YEARLY;
  /** The Android channel. */
  channelId?: string;
  /** The day of the month. */
  day: number;
  /** The month, 0–11. */
  month: number;
  /** The hour. */
  hour: number;
  /** The minute. */
  minute: number;
};

/** Once, at `date`. */
export type DateTriggerInput = {
  /** The kind. */
  type: SchedulableTriggerInputTypes.DATE;
  /** When. */
  date: Date | number;
  /** The Android channel. */
  channelId?: string;
};

/** `seconds` from now; with `repeats`, every `seconds` (at least 60). */
export type TimeIntervalTriggerInput = {
  /** The kind. */
  type: SchedulableTriggerInputTypes.TIME_INTERVAL;
  /** The Android channel. */
  channelId?: string;
  /** Repeat (default `false`). */
  repeats?: boolean;
  /** The interval in seconds. */
  seconds: number;
};

/** A trigger that schedules the notification for later. */
export type SchedulableNotificationTriggerInput =
  | CalendarTriggerInput
  | TimeIntervalTriggerInput
  | DailyTriggerInput
  | WeeklyTriggerInput
  | MonthlyTriggerInput
  | YearlyTriggerInput
  | DateTriggerInput;

/** When a notification is delivered: `null` for now. */
export type NotificationTriggerInput =
  | null
  | ChannelAwareTriggerInput
  | SchedulableNotificationTriggerInput;

/** What a scheduled notification shows. */
export type NotificationContentInput = {
  /** The title. */
  title?: string | null;
  /** iOS: the subtitle (not supported by the plugin; ignored). */
  subtitle?: string | null;
  /** The body. */
  body?: string | null;
  /** Your payload (`path` / `url` route a tap, as for push). */
  data?: Record<string, unknown>;
  /** iOS: the badge number. */
  badge?: number;
  /** `true` / `"default"` for the default sound, or a bundled sound file's name. */
  sound?:
    | boolean
    | "default"
    | "defaultCritical"
    | "defaultRingtone"
    | (string & Record<never, never>);
  /** iOS: the launch image (ignored). */
  launchImageName?: string;
  /** Android: the vibration pattern (set it on the channel instead; ignored). */
  vibrate?: number[];
  /** Android: the priority (set the channel's importance instead; ignored). */
  priority?: string;
  /** Android: the accent colour (use the plugin's `iconColor` config; ignored). */
  color?: string;
  /** Android: dismiss on tap (the plugin always does). */
  autoDismiss?: boolean;
  /** The category whose buttons it shows. */
  categoryIdentifier?: string;
  /** Android: ongoing (ignored). */
  sticky?: boolean;
  /** iOS: attachments (ignored). */
  attachments?: unknown[];
  /** iOS: the interruption level (ignored). */
  interruptionLevel?: "passive" | "active" | "timeSensitive" | "critical";
};

/** A notification to schedule. */
export interface NotificationRequestInput {
  /** Its id (default: a new UUID); scheduling it again replaces it. */
  identifier?: string;
  /** What it shows. */
  content: NotificationContentInput;
  /** When. */
  trigger: NotificationTriggerInput;
}

/** A button on a notification category. */
export interface NotificationAction {
  /** The id a tap on it reports as `actionIdentifier`. */
  identifier: string;
  /** The button's title. */
  buttonTitle: string;
  /** A text-input button. */
  textInput?: {
    /** The send button's title. */
    submitButtonTitle: string;
    /** The field's placeholder. */
    placeholder: string;
  };
  /** How it behaves. */
  options?: {
    /** Show it as destructive. */
    isDestructive?: boolean;
    /** Require the device to be unlocked. */
    isAuthenticationRequired?: boolean;
    /** Open the app (default `true`). */
    opensAppToForeground?: boolean;
  };
}

/** Options for a category. */
export type NotificationCategoryOptions = {
  /** iOS: the body placeholder when previews are hidden. */
  previewPlaceholder?: string;
  /** iOS: Siri intents (ignored). */
  intentIdentifiers?: string[];
  /** iOS: the summary format (ignored). */
  categorySummaryFormat?: string;
  /** iOS: report a dismissal as an action. */
  customDismissAction?: boolean;
  /** iOS: allow in CarPlay (ignored). */
  allowInCarPlay?: boolean;
  /** iOS: show the title when previews are hidden (ignored). */
  showTitle?: boolean;
  /** iOS: show the subtitle when previews are hidden (ignored). */
  showSubtitle?: boolean;
  /** iOS: allow Siri to announce it (ignored). */
  allowAnnouncement?: boolean;
};

/** A category: action buttons a notification opts into with `categoryIdentifier`. */
export interface NotificationCategory {
  /** Its id (on iOS also a remote push's `aps.category`). */
  identifier: string;
  /** Its buttons. */
  actions: NotificationAction[];
  /** Its options. */
  options?: NotificationCategoryOptions;
}

/** The `extra` keys the shim stores its own bookkeeping under. */
const ID_KEY = "__expoIdentifier";
const TRIGGER_KEY = "__expoTrigger";

/** Where the registered categories persist (the plugin cannot list them). */
const CATEGORIES_KEY = "denext.expo.notificationCategories";

/** A stable 31-bit positive number for a string identifier (a numeric one is used as is). */
function numericId(identifier: string): number {
  if (/^[1-9]\d{0,9}$/.test(identifier) && Number(identifier) <= 0x7fffffff) {
    return Number(identifier);
  }
  let hash = 0x811c9dc5;
  for (const ch of identifier) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 1) || 1;
}

/** A local notification as Expo's, its bookkeeping keys taken out of `data`. */
function fromLocal(local: LocalNotification): Notification {
  const { [ID_KEY]: identifier, [TRIGGER_KEY]: trigger, ...data } = local.data as Record<
    string,
    unknown
  >;
  return {
    date: Date.now(),
    request: {
      identifier: typeof identifier === "string" ? identifier : String(local.id),
      content: {
        title: local.title ?? null,
        subtitle: null,
        body: local.body ?? null,
        data,
        categoryIdentifier: null,
        sound: null,
      },
      trigger: (trigger ?? null) as NotificationTriggerInput,
    },
  };
}

/** Expo's trigger as denext's (null: deliver now). */
function toTrigger(trigger: NotificationTriggerInput): LocalNotificationTrigger | null {
  if (trigger === null || trigger === undefined) return null;
  if (trigger instanceof Date || typeof trigger === "number") {
    return { type: "date", date: trigger as Date | number };
  }
  if (!("type" in trigger)) return null;
  switch (trigger.type) {
    case SchedulableTriggerInputTypes.DATE:
      return { type: "date", date: trigger.date };
    case SchedulableTriggerInputTypes.TIME_INTERVAL:
      return { type: "interval", seconds: trigger.seconds, repeats: trigger.repeats };
    case SchedulableTriggerInputTypes.DAILY:
      return { type: "daily", hour: trigger.hour, minute: trigger.minute };
    case SchedulableTriggerInputTypes.WEEKLY:
      return {
        type: "weekly",
        weekday: trigger.weekday,
        hour: trigger.hour,
        minute: trigger.minute,
      };
    case SchedulableTriggerInputTypes.MONTHLY:
      return { type: "monthly", day: trigger.day, hour: trigger.hour, minute: trigger.minute };
    case SchedulableTriggerInputTypes.YEARLY:
      return {
        type: "yearly",
        month: trigger.month + 1,
        day: trigger.day,
        hour: trigger.hour,
        minute: trigger.minute,
      };
    case SchedulableTriggerInputTypes.CALENDAR: {
      const { year, month, day, weekday, hour, minute, second } = trigger;
      return {
        type: "calendar",
        repeats: trigger.repeats === true,
        ...Object.fromEntries(
          Object.entries({ year, month, day, weekday, hour, minute, second }).filter(([, v]) =>
            v !== undefined
          ),
        ),
      };
    }
    default:
      throw new TypeError(
        `scheduleNotificationAsync: unsupported trigger type "${
          String((trigger as { type?: unknown }).type)
        }"`,
      );
  }
}

/** The sound to ask the plugin for (undefined: the default). */
function soundOf(sound: NotificationContentInput["sound"]): string | undefined {
  return typeof sound === "string" && !sound.startsWith("default") ? sound : undefined;
}

/**
 * Schedule a local notification (`denext mobile add local-notifications`). A `null` trigger
 * delivers it now; `identifier` defaults to a new UUID, and scheduling it again replaces it.
 * Outside the shell a notification for now shows through the Notifications API, and a later one
 * rejects (no scheduler).
 *
 * @param request The content, trigger and identifier.
 * @returns The identifier.
 */
export async function scheduleNotificationAsync(
  request: NotificationRequestInput,
): Promise<string> {
  const identifier = request.identifier ?? crypto.randomUUID();
  const trigger = request.trigger ?? null;
  const channelId = trigger && typeof trigger === "object" && "channelId" in trigger
    ? trigger.channelId
    : undefined;
  const content = request.content ?? {};
  await scheduleNotification({
    id: numericId(identifier),
    title: content.title ?? "",
    body: content.body ?? "",
    trigger: toTrigger(trigger),
    data: { ...content.data, [ID_KEY]: identifier, [TRIGGER_KEY]: trigger },
    channelId,
    categoryId: content.categoryIdentifier,
    sound: soundOf(content.sound),
    badge: content.badge,
  });
  return identifier;
}

/**
 * Cancel a scheduled notification.
 *
 * @param identifier Its identifier.
 * @returns A promise that settles once cancelled.
 */
export async function cancelScheduledNotificationAsync(identifier: string): Promise<void> {
  await cancelNotification(numericId(identifier));
}

/**
 * Cancel every scheduled notification.
 *
 * @returns A promise that settles once cancelled.
 */
export async function cancelAllScheduledNotificationsAsync(): Promise<void> {
  const pending = (await localPlugin()?.getPending())?.notifications ?? [];
  await cancelNotification(pending.map((n) => Number(n.id)));
}

/**
 * The scheduled (pending) notifications, with the triggers they were scheduled with.
 *
 * @returns The requests (none outside the shell).
 */
export async function getAllScheduledNotificationsAsync(): Promise<NotificationRequest[]> {
  const pending = (await localPlugin()?.getPending())?.notifications ?? [];
  return pending.map((raw) =>
    fromLocal({
      id: Number(raw.id),
      title: typeof raw.title === "string" ? raw.title : undefined,
      body: typeof raw.body === "string" ? raw.body : undefined,
      data: (typeof raw.extra === "object" && raw.extra !== null ? raw.extra : {}) as Record<
        string,
        unknown
      >,
    }).request
  );
}

/**
 * When a trigger would next fire, computed here in the device's time zone.
 *
 * @param trigger The trigger.
 * @returns The time in ms since the epoch, or null when it never fires.
 */
export function getNextTriggerDateAsync(
  trigger: SchedulableNotificationTriggerInput,
): Promise<number | null> {
  try {
    const local = toTrigger(trigger);
    return Promise.resolve(local ? nextTriggerDate(local)?.getTime() ?? null : null);
  } catch (err) {
    return Promise.reject(err);
  }
}

/** The categories registered so far (persisted: the plugin cannot list them). */
function storedCategories(): NotificationCategory[] {
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(CATEGORIES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Persist `categories` and register the whole set with the plugin (it replaces them all). */
async function registerCategories(categories: NotificationCategory[]): Promise<void> {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem(
      CATEGORIES_KEY,
      JSON.stringify(categories),
    );
  } catch {
    // Storage unavailable: the categories still register for this launch.
  }
  await setNotificationCategories(categories.map((c) => ({
    id: c.identifier,
    actions: c.actions.map((a) => ({
      id: a.identifier,
      title: a.buttonTitle,
      foreground: a.options?.opensAppToForeground !== false,
      destructive: a.options?.isDestructive === true,
      requiresAuthentication: a.options?.isAuthenticationRequired === true,
      ...(a.textInput
        ? {
          input: {
            buttonTitle: a.textInput.submitButtonTitle,
            placeholder: a.textInput.placeholder,
          },
        }
        : {}),
    })),
    hiddenPreviewsPlaceholder: c.options?.previewPlaceholder,
    customDismissAction: c.options?.customDismissAction,
  })));
}

/**
 * Register (or replace) a category of action buttons. On iOS it also applies to remote pushes
 * whose `aps.category` names it.
 *
 * @param identifier The category id.
 * @param actions Its buttons.
 * @param options Its options.
 * @returns The category.
 */
export async function setNotificationCategoryAsync(
  identifier: string,
  actions: NotificationAction[],
  options?: NotificationCategoryOptions,
): Promise<NotificationCategory> {
  const category: NotificationCategory = { identifier, actions, ...(options ? { options } : {}) };
  const rest = storedCategories().filter((c) => c.identifier !== identifier);
  await registerCategories([...rest, category]);
  return category;
}

/**
 * The categories registered through {@linkcode setNotificationCategoryAsync}.
 *
 * @returns The categories.
 */
export function getNotificationCategoriesAsync(): Promise<NotificationCategory[]> {
  return Promise.resolve(storedCategories());
}

/**
 * Remove a category.
 *
 * @param identifier The category id.
 * @returns Whether it existed.
 */
export async function deleteNotificationCategoryAsync(identifier: string): Promise<boolean> {
  const all = storedCategories();
  const rest = all.filter((c) => c.identifier !== identifier);
  if (rest.length === all.length) return false;
  await registerCategories(rest);
  return true;
}
