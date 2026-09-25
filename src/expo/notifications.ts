/**
 * `expo-notifications` for denext: the remote-push subset over `denext/mobile`'s push API
 * (`@capacitor/push-notifications` in the Capacitor shell: APNs on iOS, FCM on Android).
 *
 * Provided: permissions, the device push token, the received / response listeners (the tap
 * that cold-started the app included), `setNotificationHandler`, badges, delivered
 * notifications and Android channels. Expo's push service (`getExpoPushTokenAsync`), local
 * scheduling, categories, topics and background tasks are not (see the manifest): send
 * through APNs / FCM from your server with the device token.
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

/** Local-notification trigger kinds (scheduling is not provided; kept for compatibility). */
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
  /** What triggered it (`{ type: "push" }` for a remote notification). */
  trigger: { type: "push"; payload?: Record<string, unknown> } | null;
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

/** The push plugin with `method`, when the shell has it. */
function pushExtra<K extends keyof PushExtras>(method: K): Required<PushExtras>[K] | undefined {
  const plugin = nativePlugin<PushExtras>("PushNotifications", [method]);
  return plugin?.[method]?.bind(plugin) as Required<PushExtras>[K] | undefined;
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
  return receivedEmitter ??= createEmitter((emit) =>
    onPushReceived((push) => {
      const notification = toNotification(push);
      runHandler(notification);
      emit(notification);
    })
  );
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
  stopWatchingTaps ??= onPushTapped((tap) => {
    lastResponse = {
      notification: toNotification(tap.notification),
      actionIdentifier: tap.actionId === "tap" ? DEFAULT_ACTION_IDENTIFIER : tap.actionId,
      ...(tap.inputValue === undefined ? {} : { userText: tap.inputValue }),
    };
    responseEmitter!.emit(lastResponse);
  }, { route: false });
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

/**
 * Set the app badge through the Badging API where the browser (or installed PWA) has it.
 *
 * @param count The count (0 clears it).
 * @returns `true` when the badge was set.
 */
export async function setBadgeCountAsync(count: number): Promise<boolean> {
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
