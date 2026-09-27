/**
 * `@notifee/react-native` for denext's React Native mode: the local-notification subset over
 * `denext/mobile`'s local notifications (`@capacitor/local-notifications`,
 * `denext mobile add local-notifications`) and permissions.
 *
 * Provided:
 * - `displayNotification` (shown now) and `createTriggerNotification` with a `TIMESTAMP`
 *   trigger (once, or repeating `HOURLY` / `DAILY` / `WEEKLY` at the timestamp's local time) or
 *   an `INTERVAL` trigger (repeating every `interval` × `timeUnit`); `title`, `body`, `data`,
 *   `android.channelId`, `android.groupId` / `ios.threadId`, `ios.categoryId`, `ios.sound` /
 *   `android.sound` and `ios.badgeCount` are carried over. A string `id` becomes a stable
 *   32-bit number underneath and comes back as the same string.
 * - `cancelNotification(s)`, `cancelTriggerNotification(s)`, `cancelAllNotifications`,
 *   `getTriggerNotificationIds`, `getTriggerNotifications` (from the pending list, so they
 *   survive a relaunch).
 * - Channels (Android): `createChannel(s)`, `deleteChannel`, `getChannel(s)`,
 *   `isChannelCreated`; groups are accepted and not created.
 * - iOS categories: `setNotificationCategories` / `getNotificationCategories`.
 * - `requestPermission` / `getNotificationSettings` (`authorizationStatus`, the rest
 *   `ENABLED` / `DISABLED` by it), `openNotificationSettings` (the app's settings page).
 * - Events: `onForegroundEvent` gets `PRESS` / `ACTION_PRESS` (with `pressAction.id` and
 *   `input`), `DELIVERED` (while the app is in the foreground) and
 *   `TRIGGER_NOTIFICATION_CREATED`. JavaScript does not run while the app is suspended, so
 *   `onBackgroundEvent` observers get the same events as they arrive with the app open, and
 *   only while no foreground observer is registered. `getInitialNotification` resolves the
 *   press that opened the app (once), else null.
 *
 * Differences: the notification's Android styling (large icon, big picture, progress,
 * messaging style, actions, full-screen intents, ongoing / timeout / chronometer) and foreground
 * services are ignored; displayed notifications cannot be listed or removed one by one
 * (`getDisplayedNotifications` is `[]`, `cancelDisplayedNotification(s)` does nothing); the
 * badge count is kept in memory and applied through the Badging API where the page has it.
 *
 * In React Native mode `import notifee from "@notifee/react-native"` resolves here.
 *
 * @example
 * ```ts
 * import notifee, { TriggerType } from "@notifee/react-native";
 *
 * await notifee.requestPermission();
 * await notifee.createTriggerNotification(
 *   { id: "standup", title: "Stand-up", body: "In 10 minutes" },
 *   { type: TriggerType.TIMESTAMP, timestamp: Date.now() + 600_000 },
 * );
 * ```
 *
 * @module
 */

import {
  cancelAllNotifications as cancelAllLocal,
  cancelNotification as cancelLocal,
  createNotificationChannel,
  deleteNotificationChannel,
  listNotificationChannels,
  type LocalNotification,
  type LocalNotificationInput,
  type LocalNotificationTap,
  type LocalNotificationTrigger,
  type NotificationChannel,
  onLocalNotificationReceived,
  onLocalNotificationTapped,
  pendingNotifications,
  scheduleNotification,
  setNotificationCategories as setLocalCategories,
} from "../mobile/local-notifications.ts";
import {
  checkPermission,
  openAppSettings,
  type PermissionState,
  requestPermission as requestOsPermission,
} from "../mobile/permissions.ts";

// ---- the package's enums (their real values) ---------------------------------------------------

/** A notification event's type. */
export enum EventType {
  /** An unknown event. */
  UNKNOWN = -1,
  /** The user dismissed a notification (never reported here). */
  DISMISSED = 0,
  /** The user pressed a notification. */
  PRESS = 1,
  /** The user pressed a notification's action. */
  ACTION_PRESS = 2,
  /** A notification was delivered (while the app is in the foreground). */
  DELIVERED = 3,
  /** The app's notifications were blocked (never reported here). */
  APP_BLOCKED = 4,
  /** A channel was blocked (never reported here). */
  CHANNEL_BLOCKED = 5,
  /** A channel group was blocked (never reported here). */
  CHANNEL_GROUP_BLOCKED = 6,
  /** A trigger notification was created. */
  TRIGGER_NOTIFICATION_CREATED = 7,
  /** A foreground service already runs (never reported here). */
  FG_ALREADY_EXIST = 8,
}

/** The app's notification permission. */
export enum AuthorizationStatus {
  /** Not asked yet. */
  NOT_DETERMINED = -1,
  /** Refused. */
  DENIED = 0,
  /** Allowed. */
  AUTHORIZED = 1,
  /** Allowed quietly (iOS provisional). */
  PROVISIONAL = 2,
}

/** Android alarm types (accepted and ignored). */
export enum AlarmType {
  /** `set`. */
  SET = 0,
  /** `setAndAllowWhileIdle`. */
  SET_AND_ALLOW_WHILE_IDLE = 1,
  /** `setExact`. */
  SET_EXACT = 2,
  /** `setExactAndAllowWhileIdle`. */
  SET_EXACT_AND_ALLOW_WHILE_IDLE = 3,
  /** `setAlarmClock`. */
  SET_ALARM_CLOCK = 4,
}

/** How a timestamp trigger repeats. */
export enum RepeatFrequency {
  /** Once. */
  NONE = -1,
  /** Every hour, at the timestamp's minute. */
  HOURLY = 0,
  /** Every day, at the timestamp's local time. */
  DAILY = 1,
  /** Every week, on the timestamp's weekday and local time. */
  WEEKLY = 2,
}

/** An interval trigger's unit. */
export enum TimeUnit {
  /** Seconds. */
  SECONDS = "SECONDS",
  /** Minutes. */
  MINUTES = "MINUTES",
  /** Hours. */
  HOURS = "HOURS",
  /** Days. */
  DAYS = "DAYS",
}

/** A trigger's type. */
export enum TriggerType {
  /** At a timestamp. */
  TIMESTAMP = 0,
  /** Every interval. */
  INTERVAL = 1,
}

/** iOS's preview setting. */
export enum IOSShowPreviewsSetting {
  /** Not supported. */
  NOT_SUPPORTED = -1,
  /** Never. */
  NEVER = 0,
  /** Always. */
  ALWAYS = 1,
  /** When unlocked. */
  WHEN_AUTHENTICATED = 2,
}

/** An iOS notification setting. */
export enum IOSNotificationSetting {
  /** Not supported. */
  NOT_SUPPORTED = -1,
  /** Off. */
  DISABLED = 0,
  /** On. */
  ENABLED = 1,
}

/** iOS intent identifiers for categories (accepted and ignored). */
export enum IOSIntentIdentifier {
  /** Start an audio call. */
  START_AUDIO_CALL = 0,
  /** Start a video call. */
  START_VIDEO_CALL = 1,
  /** Search the call history. */
  SEARCH_CALL_HISTORY = 2,
  /** Set the car's audio source. */
  SET_AUDIO_SOURCE_IN_CAR = 3,
  /** Set the car's climate. */
  SET_CLIMATE_SETTINGS_IN_CAR = 4,
  /** Set the car's defroster. */
  SET_DEFROSTER_SETTINGS_IN_CAR = 5,
  /** Set the car's seats. */
  SET_SEAT_SETTINGS_IN_CAR = 6,
  /** Set the car's profile. */
  SET_PROFILE_IN_CAR = 7,
  /** Save the car's profile. */
  SAVE_PROFILE_IN_CAR = 8,
  /** Start a workout. */
  START_WORKOUT = 9,
  /** Pause a workout. */
  PAUSE_WORKOUT = 10,
  /** End a workout. */
  END_WORKOUT = 11,
  /** Cancel a workout. */
  CANCEL_WORKOUT = 12,
  /** Resume a workout. */
  RESUME_WORKOUT = 13,
  /** Set a radio station. */
  SET_RADIO_STATION = 14,
  /** Send a message. */
  SEND_MESSAGE = 15,
  /** Search messages. */
  SEARCH_FOR_MESSAGES = 16,
  /** Set a message attribute. */
  SET_MESSAGE_ATTRIBUTE = 17,
  /** Send a payment. */
  SEND_PAYMENT = 18,
  /** Request a payment. */
  REQUEST_PAYMENT = 19,
  /** Search photos. */
  SEARCH_FOR_PHOTOS = 20,
  /** Start a photo slideshow. */
  START_PHOTO_PLAYBACK = 21,
  /** List ride options. */
  LIST_RIDE_OPTIONS = 22,
  /** Request a ride. */
  REQUEST_RIDE = 23,
  /** Get a ride's status. */
  GET_RIDE_STATUS = 24,
}

/** An Android notification setting. */
export enum AndroidNotificationSetting {
  /** Not supported. */
  NOT_SUPPORTED = -1,
  /** Off. */
  DISABLED = 0,
  /** On. */
  ENABLED = 1,
}

/** Android's badge icon type (ignored). */
export enum AndroidBadgeIconType {
  /** A number. */
  NONE = 0,
  /** The small icon. */
  SMALL = 1,
  /** The large icon. */
  LARGE = 2,
}

/** Android's notification category (ignored). */
export enum AndroidCategory {
  /** An alarm. */
  ALARM = "alarm",
  /** A call. */
  CALL = "call",
  /** An email. */
  EMAIL = "email",
  /** An error. */
  ERROR = "error",
  /** An event. */
  EVENT = "event",
  /** A message. */
  MESSAGE = "msg",
  /** Navigation. */
  NAVIGATION = "navigation",
  /** Progress. */
  PROGRESS = "progress",
  /** A promotion. */
  PROMO = "promo",
  /** A recommendation. */
  RECOMMENDATION = "recommendation",
  /** A reminder. */
  REMINDER = "reminder",
  /** A service. */
  SERVICE = "service",
  /** Social. */
  SOCIAL = "social",
  /** Status. */
  STATUS = "status",
  /** System. */
  SYSTEM = "sys",
  /** Transport. */
  TRANSPORT = "transport",
}

/** Android's named colours (ignored). */
export enum AndroidColor {
  /** red. */
  RED = "red",
  /** blue. */
  BLUE = "blue",
  /** green. */
  GREEN = "green",
  /** black. */
  BLACK = "black",
  /** white. */
  WHITE = "white",
  /** cyan. */
  CYAN = "cyan",
  /** magenta. */
  MAGENTA = "magenta",
  /** yellow. */
  YELLOW = "yellow",
  /** lightgray. */
  LIGHTGRAY = "lightgray",
  /** darkgray. */
  DARKGRAY = "darkgray",
  /** gray. */
  GRAY = "gray",
  /** lightgrey. */
  LIGHTGREY = "lightgrey",
  /** darkgrey. */
  DARKGREY = "darkgrey",
  /** aqua. */
  AQUA = "aqua",
  /** fuchsia. */
  FUCHSIA = "fuchsia",
  /** lime. */
  LIME = "lime",
  /** maroon. */
  MAROON = "maroon",
  /** navy. */
  NAVY = "navy",
  /** olive. */
  OLIVE = "olive",
  /** purple. */
  PURPLE = "purple",
  /** silver. */
  SILVER = "silver",
  /** teal. */
  TEAL = "teal",
}

/** Android's alert defaults (ignored). */
export enum AndroidDefaults {
  /** All. */
  ALL = -1,
  /** Lights. */
  LIGHTS = 4,
  /** Sound. */
  SOUND = 1,
  /** Vibration. */
  VIBRATE = 2,
}

/** Android's notification flags (ignored). */
export enum AndroidFlags {
  /** Repeat the sound. */
  FLAG_INSISTENT = 4,
  /** Not cleared by "Clear all". */
  FLAG_NO_CLEAR = 32,
}

/** Android's group alert behaviour (ignored). */
export enum AndroidGroupAlertBehavior {
  /** All alert. */
  ALL = 0,
  /** The summary alerts. */
  SUMMARY = 1,
  /** The children alert. */
  CHILDREN = 2,
}

/** Android's notification styles (ignored). */
export enum AndroidStyle {
  /** A big picture. */
  BIGPICTURE = 0,
  /** Big text. */
  BIGTEXT = 1,
  /** Inbox. */
  INBOX = 2,
  /** Messaging. */
  MESSAGING = 3,
}

/** Lock-screen visibility (channels pass it on). */
export enum AndroidVisibility {
  /** Hide sensitive content on secure lock screens. */
  PRIVATE = 0,
  /** Show everything. */
  PUBLIC = 1,
  /** Show nothing. */
  SECRET = -1,
}

/** A channel's importance (channels pass it on, `NONE` as `MIN`). */
export enum AndroidImportance {
  /** Default. */
  DEFAULT = 3,
  /** Heads-up. */
  HIGH = 4,
  /** No sound. */
  LOW = 2,
  /** Silent, collapsed. */
  MIN = 1,
  /** Not shown. */
  NONE = 0,
}

/** Android's launch-activity flags (ignored). */
export enum AndroidLaunchActivityFlag {
  /** `FLAG_ACTIVITY_NO_HISTORY`. */
  NO_HISTORY = 0,
  /** `FLAG_ACTIVITY_SINGLE_TOP`. */
  SINGLE_TOP = 1,
  /** `FLAG_ACTIVITY_NEW_TASK`. */
  NEW_TASK = 2,
  /** `FLAG_ACTIVITY_MULTIPLE_TASK`. */
  MULTIPLE_TASK = 3,
  /** `FLAG_ACTIVITY_CLEAR_TOP`. */
  CLEAR_TOP = 4,
  /** `FLAG_ACTIVITY_FORWARD_RESULT`. */
  FORWARD_RESULT = 5,
  /** `FLAG_ACTIVITY_PREVIOUS_IS_TOP`. */
  PREVIOUS_IS_TOP = 6,
  /** `FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS`. */
  EXCLUDE_FROM_RECENTS = 7,
  /** `FLAG_ACTIVITY_BROUGHT_TO_FRONT`. */
  BROUGHT_TO_FRONT = 8,
  /** `FLAG_ACTIVITY_RESET_TASK_IF_NEEDED`. */
  RESET_TASK_IF_NEEDED = 9,
  /** `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`. */
  LAUNCHED_FROM_HISTORY = 10,
  /** `FLAG_ACTIVITY_CLEAR_WHEN_TASK_RESET`. */
  CLEAR_WHEN_TASK_RESET = 11,
  /** `FLAG_ACTIVITY_NEW_DOCUMENT`. */
  NEW_DOCUMENT = 12,
  /** `FLAG_ACTIVITY_NO_USER_ACTION`. */
  NO_USER_ACTION = 13,
  /** `FLAG_ACTIVITY_REORDER_TO_FRONT`. */
  REORDER_TO_FRONT = 14,
  /** `FLAG_ACTIVITY_NO_ANIMATION`. */
  NO_ANIMATION = 15,
  /** `FLAG_ACTIVITY_CLEAR_TASK`. */
  CLEAR_TASK = 16,
  /** `FLAG_ACTIVITY_TASK_ON_HOME`. */
  TASK_ON_HOME = 17,
  /** `FLAG_ACTIVITY_RETAIN_IN_RECENTS`. */
  RETAIN_IN_RECENTS = 18,
  /** `FLAG_ACTIVITY_LAUNCH_ADJACENT`. */
  LAUNCH_ADJACENT = 19,
  /** `FLAG_ACTIVITY_MATCH_EXTERNAL`. */
  MATCH_EXTERNAL = 20,
}

/** Android foreground-service types (no foreground services here). */
export enum AndroidForegroundServiceType {
  /** Camera. */
  FOREGROUND_SERVICE_TYPE_CAMERA = 64,
  /** Connected device. */
  FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE = 16,
  /** Data sync. */
  FOREGROUND_SERVICE_TYPE_DATA_SYNC = 1,
  /** Health. */
  FOREGROUND_SERVICE_TYPE_HEALTH = 256,
  /** Location. */
  FOREGROUND_SERVICE_TYPE_LOCATION = 8,
  /** Media playback. */
  FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK = 2,
  /** Media projection. */
  FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION = 32,
  /** Media processing. */
  FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING = 8192,
  /** Microphone. */
  FOREGROUND_SERVICE_TYPE_MICROPHONE = 128,
  /** Phone call. */
  FOREGROUND_SERVICE_TYPE_PHONE_CALL = 4,
  /** Remote messaging. */
  FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING = 512,
  /** Short service. */
  FOREGROUND_SERVICE_TYPE_SHORT_SERVICE = 2048,
  /** Special use. */
  FOREGROUND_SERVICE_TYPE_SPECIAL_USE = 1073741824,
  /** System exempted. */
  FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED = 1024,
  /** From the manifest. */
  FOREGROUND_SERVICE_TYPE_MANIFEST = -1,
}

// ---- the package's shapes (the parts read here) -------------------------------------------------

/** A notification, as the package describes it. */
export interface Notification {
  /** Its id (default: a random one). */
  id?: string;
  /** The title. */
  title?: string;
  /** The subtitle (iOS; kept in `data` round trips only). */
  subtitle?: string;
  /** The body. */
  body?: string;
  /** Your payload. */
  data?: { [key: string]: string | object | number };
  /** Android options: `channelId`, `groupId` and `sound` are read. */
  android?: Record<string, unknown> & { channelId?: string; groupId?: string; sound?: string };
  /** iOS options: `categoryId`, `threadId`, `sound` and `badgeCount` are read. */
  ios?: Record<string, unknown> & {
    categoryId?: string;
    threadId?: string;
    sound?: string;
    badgeCount?: number | null;
  };
}

/** A timestamp trigger. */
export interface TimestampTrigger {
  /** `TriggerType.TIMESTAMP`. */
  type: TriggerType.TIMESTAMP;
  /** When, in ms since the epoch. */
  timestamp: number;
  /** How it repeats (default once). */
  repeatFrequency?: RepeatFrequency;
  /** Android alarm options: `allowWhileIdle` is read. */
  alarmManager?: boolean | { allowWhileIdle?: boolean; type?: AlarmType };
}

/** An interval trigger (repeats). */
export interface IntervalTrigger {
  /** `TriggerType.INTERVAL`. */
  type: TriggerType.INTERVAL;
  /** How many `timeUnit`s between deliveries (at least 15 minutes on Android). */
  interval: number;
  /** The unit (default seconds). */
  timeUnit?: TimeUnit;
}

/** A trigger. */
export type Trigger = TimestampTrigger | IntervalTrigger;

/** A pressed notification's action (`"default"` for the notification itself). */
export interface NotificationPressAction {
  /** The action's id. */
  id: string;
  /** Android launch options (ignored). */
  launchActivity?: string;
  /** Android launch flags (ignored). */
  launchActivityFlags?: AndroidLaunchActivityFlag[];
  /** Android main component (ignored). */
  mainComponent?: string;
}

/** An event's details. */
export interface EventDetail {
  /** The notification. */
  notification?: Notification;
  /** The pressed action. */
  pressAction?: NotificationPressAction;
  /** Text typed into an input action. */
  input?: string;
}

/** A notification event. */
export interface Event {
  /** What happened. */
  type: EventType;
  /** The details. */
  detail: EventDetail;
}

/** The press that opened the app. */
export interface InitialNotification {
  /** The notification. */
  notification: Notification;
  /** The pressed action. */
  pressAction: NotificationPressAction;
  /** Text typed into an input action. */
  input?: string;
}

/** A displayed notification. */
export interface DisplayedNotification {
  /** Its id. */
  id?: string;
  /** When it was shown. */
  date?: string;
  /** The notification. */
  notification: Notification;
  /** Its trigger. */
  trigger: Trigger;
}

/** A pending trigger notification. */
export interface TriggerNotification {
  /** The notification. */
  notification: Notification;
  /** Its trigger. */
  trigger: Trigger;
}

/** An Android channel. */
export interface AndroidChannel {
  /** Its id. */
  id: string;
  /** Its user-visible name. */
  name: string;
  /** Its description. */
  description?: string;
  /** Its importance. */
  importance?: AndroidImportance;
  /** A sound in `res/raw`. */
  sound?: string;
  /** Whether it vibrates. */
  vibration?: boolean;
  /** Whether it lights the LED. */
  lights?: boolean;
  /** The LED colour. */
  lightColor?: string;
  /** Lock-screen visibility. */
  visibility?: AndroidVisibility;
  /** Anything else the package takes (ignored). */
  [key: string]: unknown;
}

/** An Android channel as the platform reports it. */
export interface NativeAndroidChannel extends AndroidChannel {
  /** Whether the user blocked it (always false here). */
  blocked: boolean;
}

/** An Android channel group (not created here). */
export interface AndroidChannelGroup {
  /** Its id. */
  id: string;
  /** Its name. */
  name: string;
  /** Its description. */
  description?: string;
}

/** An iOS category action. */
export interface IOSNotificationCategoryAction {
  /** Its id. */
  id: string;
  /** Its title. */
  title: string;
  /** A text input. */
  input?: true | { buttonText?: string; placeholderText?: string };
  /** Destructive. */
  destructive?: boolean;
  /** Opens the app. */
  foreground?: boolean;
  /** Needs the device unlocked. */
  authenticationRequired?: boolean;
}

/** An iOS category. */
export interface IOSNotificationCategory {
  /** Its id. */
  id: string;
  /** Its actions. */
  actions?: IOSNotificationCategoryAction[];
  /** The body placeholder when previews are hidden. */
  hiddenPreviewsBodyPlaceholder?: string;
  /** Anything else the package takes (ignored). */
  [key: string]: unknown;
}

/** The notification settings. */
export interface NotificationSettings {
  /** The permission. */
  authorizationStatus: AuthorizationStatus;
  /** iOS's settings, `ENABLED` / `DISABLED` by the permission. */
  ios: Record<string, IOSNotificationSetting | IOSShowPreviewsSetting>;
  /** Android's settings (`alarm`). */
  android: { alarm: AndroidNotificationSetting };
  /** The web's (none). */
  web: Record<string, never>;
}

/** Power manager details (none here). */
export interface PowerManagerInfo {
  /** The manufacturer. */
  manufacturer?: string;
  /** The model. */
  model?: string;
  /** The OS version. */
  version?: string;
  /** The power manager's activity. */
  activity?: string | null;
}

// ---- ids and the bookkeeping kept in `data` ------------------------------------------------------

/** The `data` key carrying the notification's string id. */
const ID_KEY = "__notifeeId";
/** The `data` key carrying the trigger (JSON) of a trigger notification. */
const TRIGGER_KEY = "__notifeeTrigger";

/** A stable 31-bit positive number for a string id (a numeric one is used as is). */
function numericId(id: string): number {
  if (/^[1-9]\d{0,9}$/.test(id) && Number(id) <= 0x7fffffff) return Number(id);
  let hash = 0x811c9dc5;
  for (const ch of id) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 1) || 1;
}

/** A local notification as the package's, the bookkeeping taken out of `data`. */
function fromLocal(local: { id: number; title?: string; body?: string; data: object }): {
  notification: Notification;
  trigger?: Trigger;
} {
  const { [ID_KEY]: id, [TRIGGER_KEY]: trigger, ...data } = local.data as Record<string, unknown>;
  let parsed: Trigger | undefined;
  if (typeof trigger === "string") {
    try {
      parsed = JSON.parse(trigger) as Trigger;
    } catch { /* not ours */ }
  }
  return {
    notification: {
      id: typeof id === "string" ? id : String(local.id),
      title: local.title,
      body: local.body,
      data: data as Notification["data"],
    },
    trigger: parsed,
  };
}

/** The seconds in one `unit`. */
function unitSeconds(unit: TimeUnit | undefined): number {
  switch (unit) {
    case TimeUnit.MINUTES:
      return 60;
    case TimeUnit.HOURS:
      return 3600;
    case TimeUnit.DAYS:
      return 86400;
    default:
      return 1;
  }
}

/** A package trigger as denext's. */
function triggerOf(trigger: Trigger): LocalNotificationTrigger {
  if (trigger.type === TriggerType.INTERVAL) {
    return {
      type: "interval",
      seconds: trigger.interval * unitSeconds(trigger.timeUnit),
      repeats: true,
    };
  }
  if (trigger.type !== TriggerType.TIMESTAMP || typeof trigger.timestamp !== "number") {
    throw new TypeError("notifee: a trigger needs a TIMESTAMP or INTERVAL type");
  }
  const at = new Date(trigger.timestamp);
  switch (trigger.repeatFrequency) {
    case RepeatFrequency.HOURLY:
      return { type: "calendar", minute: at.getMinutes(), repeats: true };
    case RepeatFrequency.DAILY:
      return { type: "daily", hour: at.getHours(), minute: at.getMinutes() };
    case RepeatFrequency.WEEKLY:
      return {
        type: "weekly",
        weekday: at.getDay() + 1,
        hour: at.getHours(),
        minute: at.getMinutes(),
      };
    default:
      return { type: "date", date: trigger.timestamp };
  }
}

/** A package notification (and trigger) as denext's input. */
function inputOf(notification: Notification, trigger?: Trigger): LocalNotificationInput {
  const id = notification.id ?? crypto.randomUUID();
  const { android = {}, ios = {} } = notification;
  const sound = ios.sound ?? android.sound;
  const idle = trigger?.type === TriggerType.TIMESTAMP && typeof trigger.alarmManager === "object"
    ? trigger.alarmManager.allowWhileIdle === true
    : undefined;
  const input: Record<string, unknown> = {
    id: numericId(id),
    title: notification.title ?? "",
    body: notification.body ?? "",
    data: {
      ...notification.data,
      [ID_KEY]: id,
      ...(trigger ? { [TRIGGER_KEY]: JSON.stringify(trigger) } : {}),
    },
    trigger: trigger ? triggerOf(trigger) : null,
    channelId: android.channelId,
    categoryId: ios.categoryId,
    sound: typeof sound === "string" && sound !== "default" ? sound : undefined,
    badge: typeof ios.badgeCount === "number" ? ios.badgeCount : undefined,
    group: android.groupId ?? ios.threadId,
    allowWhileIdle: idle,
  };
  for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key];
  return input as unknown as LocalNotificationInput;
}

// ---- events --------------------------------------------------------------------------------------

/** Foreground and background observers, and the denext subscriptions feeding them. */
const observers = {
  foreground: new Set<(event: Event) => void>(),
  background: new Set<(event: Event) => Promise<void>>(),
  stop: null as (() => void) | null,
  initial: undefined as InitialNotification | null | undefined,
};

/** Deliver `event` to the foreground observers, or to the background ones when there are none. */
function deliver(event: Event): void {
  const targets = observers.foreground.size > 0
    ? [...observers.foreground]
    : [...observers.background];
  for (const observer of targets) {
    try {
      const result = (observer as (e: Event) => unknown)(event);
      if (result instanceof Promise) result.catch(() => {});
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }
}

/** A denext tap as the package's press. */
function pressOf(tap: LocalNotificationTap): InitialNotification {
  const { notification } = fromLocal(tap.notification);
  return {
    notification,
    pressAction: { id: tap.actionId === "tap" ? "default" : tap.actionId },
    ...(tap.inputValue === undefined ? {} : { input: tap.inputValue }),
  };
}

/** Start listening to denext's taps and deliveries (once). */
function listen(): void {
  if (observers.stop) return;
  const stopTaps = onLocalNotificationTapped((tap) => {
    const press = pressOf(tap);
    if (observers.initial === undefined) observers.initial = press;
    deliver({
      type: tap.actionId === "tap" ? EventType.PRESS : EventType.ACTION_PRESS,
      detail: press,
    });
  }, { route: false });
  const stopReceived = onLocalNotificationReceived((n: LocalNotification) => {
    deliver({ type: EventType.DELIVERED, detail: { notification: fromLocal(n).notification } });
  });
  observers.stop = () => {
    stopTaps();
    stopReceived();
  };
}

/**
 * Observe notification events while the app runs.
 *
 * @param observer Called with each event.
 * @returns A function that unsubscribes.
 */
export function onForegroundEvent(observer: (event: Event) => void): () => void {
  observers.foreground.add(observer);
  listen();
  return () => void observers.foreground.delete(observer);
}

/**
 * Observe events the app did not see in the foreground. JavaScript does not run while the app
 * is suspended, so these are the events that arrive (the press that opened the app included)
 * while no {@linkcode onForegroundEvent} observer is registered.
 *
 * @param observer Called with each event.
 */
export function onBackgroundEvent(observer: (event: Event) => Promise<void>): void {
  observers.background.add(observer);
  listen();
}

/**
 * The press that opened the app, once; null when it was not opened from a notification (or
 * was already reported).
 *
 * @returns The press, or null.
 */
export async function getInitialNotification(): Promise<InitialNotification | null> {
  listen();
  // The plugin retains the launch tap and replays it to the first listener.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const initial = observers.initial ?? null;
  observers.initial = null;
  return initial;
}

/** Forget every observer and the initial press (tests only). */
export function resetNotifeeForTesting(): void {
  observers.stop?.();
  observers.stop = null;
  observers.foreground.clear();
  observers.background.clear();
  observers.initial = undefined;
  categories = [];
  badge = 0;
}

// ---- display and triggers ------------------------------------------------------------------------

/**
 * Show a notification now.
 *
 * @param notification The notification.
 * @returns Its id.
 */
export async function displayNotification(notification: Notification): Promise<string> {
  const input = inputOf(notification);
  await scheduleNotification(input);
  return (input.data as Record<string, string>)[ID_KEY];
}

/**
 * Schedule a notification for a trigger.
 *
 * @param notification The notification.
 * @param trigger When it fires.
 * @returns Its id.
 */
export async function createTriggerNotification(
  notification: Notification,
  trigger: Trigger,
): Promise<string> {
  const input = inputOf(notification, trigger);
  await scheduleNotification(input);
  const id = (input.data as Record<string, string>)[ID_KEY];
  deliver({
    type: EventType.TRIGGER_NOTIFICATION_CREATED,
    detail: { notification: { ...notification, id } },
  });
  return id;
}

/** The pending notifications as the package's trigger notifications. */
async function pending(): Promise<Array<TriggerNotification & { key: number }>> {
  return (await pendingNotifications()).map((n) => {
    const { notification, trigger } = fromLocal(n);
    return {
      key: n.id,
      notification,
      trigger: trigger ?? { type: TriggerType.TIMESTAMP, timestamp: 0 },
    };
  });
}

/** The ids of the pending trigger notifications. */
export async function getTriggerNotificationIds(): Promise<string[]> {
  return (await pending()).map((p) => p.notification.id!);
}

/** The pending trigger notifications. */
export async function getTriggerNotifications(): Promise<TriggerNotification[]> {
  return (await pending()).map(({ notification, trigger }) => ({ notification, trigger }));
}

/** Displayed notifications cannot be listed here: `[]`. */
export function getDisplayedNotifications(): Promise<DisplayedNotification[]> {
  return Promise.resolve([]);
}

/**
 * Cancel a notification (its pending trigger).
 *
 * @param notificationId Its id.
 * @param _tag Android's tag (ignored).
 */
export async function cancelNotification(notificationId: string, _tag?: string): Promise<void> {
  await cancelLocal(numericId(notificationId));
}

/**
 * Cancel the given notifications, or every pending one.
 *
 * @param notificationIds The ids (default: all).
 * @param _tag Android's tag (ignored).
 */
export async function cancelAllNotifications(
  notificationIds?: string[],
  _tag?: string,
): Promise<void> {
  if (notificationIds) await cancelLocal(notificationIds.map(numericId));
  else await cancelAllLocal();
}

/**
 * Cancel a pending trigger notification.
 *
 * @param notificationId Its id.
 */
export function cancelTriggerNotification(notificationId: string): Promise<void> {
  return cancelNotification(notificationId);
}

/**
 * Cancel the given pending trigger notifications, or every one.
 *
 * @param notificationIds The ids (default: all).
 */
export function cancelTriggerNotifications(notificationIds?: string[]): Promise<void> {
  return cancelAllNotifications(notificationIds);
}

/** Displayed notifications cannot be removed one by one here: does nothing. */
export function cancelDisplayedNotification(_notificationId: string, _tag?: string): Promise<void> {
  return Promise.resolve();
}

/** Displayed notifications cannot be removed here: does nothing. */
export function cancelDisplayedNotifications(_notificationIds?: string[]): Promise<void> {
  return Promise.resolve();
}

// ---- channels ------------------------------------------------------------------------------------

/** A package channel as denext's. */
function channelOf(channel: AndroidChannel): NotificationChannel {
  const importance = Math.min(5, Math.max(1, channel.importance ?? AndroidImportance.DEFAULT));
  const out: Record<string, unknown> = {
    id: channel.id,
    name: channel.name,
    description: channel.description,
    importance,
    sound: channel.sound,
    vibration: channel.vibration,
    lights: channel.lights,
    lightColor: channel.lightColor,
    visibility: channel.visibility,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out as unknown as NotificationChannel;
}

/**
 * Create (or update) an Android channel; does nothing elsewhere.
 *
 * @param channel The channel.
 * @returns Its id.
 */
export async function createChannel(channel: AndroidChannel): Promise<string> {
  await createNotificationChannel(channelOf(channel));
  return channel.id;
}

/**
 * Create several Android channels.
 *
 * @param channels The channels.
 */
export async function createChannels(channels: AndroidChannel[]): Promise<void> {
  for (const channel of channels) await createChannel(channel);
}

/**
 * Delete an Android channel.
 *
 * @param channelId Its id.
 */
export function deleteChannel(channelId: string): Promise<void> {
  return deleteNotificationChannel(channelId);
}

/** The Android channels (`[]` elsewhere). */
export async function getChannels(): Promise<NativeAndroidChannel[]> {
  return (await listNotificationChannels()).map((c) => ({
    ...c,
    importance: c.importance as AndroidImportance | undefined,
    visibility: c.visibility as AndroidVisibility | undefined,
    blocked: false,
  }));
}

/**
 * An Android channel, or null.
 *
 * @param channelId Its id.
 */
export async function getChannel(channelId: string): Promise<NativeAndroidChannel | null> {
  return (await getChannels()).find((c) => c.id === channelId) ?? null;
}

/**
 * Whether an Android channel exists.
 *
 * @param channelId Its id.
 */
export async function isChannelCreated(channelId: string): Promise<boolean> {
  return (await getChannel(channelId)) !== null;
}

/** Whether the user blocked a channel: `false` (not reported here). */
export function isChannelBlocked(_channelId: string): Promise<boolean> {
  return Promise.resolve(false);
}

/** Channel groups are not created here: resolves the group's id. */
export function createChannelGroup(channelGroup: AndroidChannelGroup): Promise<string> {
  return Promise.resolve(channelGroup.id);
}

/** Channel groups are not created here: does nothing. */
export function createChannelGroups(_channelGroups: AndroidChannelGroup[]): Promise<void> {
  return Promise.resolve();
}

/** Channel groups are not created here: does nothing. */
export function deleteChannelGroup(_channelGroupId: string): Promise<void> {
  return Promise.resolve();
}

/** Channel groups are not created here: null. */
export function getChannelGroup(_channelGroupId: string): Promise<null> {
  return Promise.resolve(null);
}

/** Channel groups are not created here: `[]`. */
export function getChannelGroups(): Promise<never[]> {
  return Promise.resolve([]);
}

// ---- categories, permission, settings, badge -------------------------------------------------------

/** The categories set last (the plugin cannot list them). */
let categories: IOSNotificationCategory[] = [];

/**
 * Set the iOS categories (their action buttons).
 *
 * @param next The categories.
 */
export async function setNotificationCategories(next: IOSNotificationCategory[]): Promise<void> {
  await setLocalCategories(next.map((c) => ({
    id: c.id,
    actions: (c.actions ?? []).map((a) => ({
      id: a.id,
      title: a.title,
      foreground: a.foreground,
      destructive: a.destructive,
      requiresAuthentication: a.authenticationRequired,
      ...(a.input
        ? {
          input: a.input === true
            ? {}
            : { buttonTitle: a.input.buttonText, placeholder: a.input.placeholderText },
        }
        : {}),
    })),
    hiddenPreviewsPlaceholder: c.hiddenPreviewsBodyPlaceholder,
  })));
  categories = [...next];
}

/** The categories set last. */
export function getNotificationCategories(): Promise<IOSNotificationCategory[]> {
  return Promise.resolve([...categories]);
}

/** A denext permission state as the package's status. */
function statusOf(state: PermissionState): AuthorizationStatus {
  switch (state) {
    case "granted":
      return AuthorizationStatus.AUTHORIZED;
    case "limited":
      return AuthorizationStatus.PROVISIONAL;
    case "denied":
    case "blocked":
      return AuthorizationStatus.DENIED;
    default:
      return AuthorizationStatus.NOT_DETERMINED;
  }
}

/** The settings for a status. */
function settingsOf(status: AuthorizationStatus): NotificationSettings {
  const on = status === AuthorizationStatus.AUTHORIZED ||
    status === AuthorizationStatus.PROVISIONAL;
  const s = on ? IOSNotificationSetting.ENABLED : IOSNotificationSetting.DISABLED;
  return {
    authorizationStatus: status,
    ios: {
      alert: s,
      badge: s,
      criticalAlert: IOSNotificationSetting.NOT_SUPPORTED,
      showPreviews: on ? IOSShowPreviewsSetting.ALWAYS : IOSShowPreviewsSetting.NEVER,
      sound: s,
      carPlay: IOSNotificationSetting.NOT_SUPPORTED,
      lockScreen: s,
      announcement: IOSNotificationSetting.NOT_SUPPORTED,
      notificationCenter: s,
      inAppNotificationSettings: IOSNotificationSetting.NOT_SUPPORTED,
      authorizationStatus: status as number,
    },
    android: { alarm: AndroidNotificationSetting.ENABLED },
    web: {},
  };
}

/** Read (or, with `ask`, request) the notification permission; `DENIED` where there is none. */
async function permission(ask: boolean): Promise<NotificationSettings> {
  try {
    const state = ask
      ? await requestOsPermission("notifications")
      : await checkPermission("notifications");
    return settingsOf(statusOf(state));
  } catch {
    return settingsOf(AuthorizationStatus.DENIED);
  }
}

/**
 * Ask for the notification permission (a decided one comes back without a prompt).
 *
 * @param _permissions iOS's requested options (ignored: alert, badge and sound).
 * @returns The settings.
 */
export function requestPermission(_permissions?: Record<string, boolean>): Promise<
  NotificationSettings
> {
  return permission(true);
}

/** The notification settings, without a prompt. */
export function getNotificationSettings(): Promise<NotificationSettings> {
  return permission(false);
}

/** Open the app's settings page (the channel's page is not reachable here). */
export function openNotificationSettings(_channelId?: string): Promise<void> {
  return openAppSettings();
}

/** Open the app's settings page (Android's alarm permission lives there). */
export function openAlarmPermissionSettings(): Promise<void> {
  return openAppSettings();
}

/** Open the app's settings page (battery optimisation lives there). */
export function openBatteryOptimizationSettings(): Promise<void> {
  return openAppSettings();
}

/** Whether battery optimisation is on: `false` (not reported here). */
export function isBatteryOptimizationEnabled(): Promise<boolean> {
  return Promise.resolve(false);
}

/** Power manager details: `{}` (not reported here). */
export function getPowerManagerInfo(): Promise<PowerManagerInfo> {
  return Promise.resolve({});
}

/** There is no power manager page to open here: does nothing. */
export function openPowerManagerSettings(): Promise<void> {
  return Promise.resolve();
}

/** The badge count set last (the plugin cannot read the app icon's). */
let badge = 0;

/** Apply `count` through the Badging API, where the page has it. */
function applyBadge(count: number): void {
  const nav = (globalThis as {
    navigator?: { setAppBadge?(n?: number): Promise<void>; clearAppBadge?(): Promise<void> };
  }).navigator;
  const done = count > 0 ? nav?.setAppBadge?.(count) : nav?.clearAppBadge?.();
  done?.catch?.(() => {});
}

/** The badge count set last. */
export function getBadgeCount(): Promise<number> {
  return Promise.resolve(badge);
}

/**
 * Set the badge count (kept in memory; applied through the Badging API where there is one).
 *
 * @param count The count.
 */
export function setBadgeCount(count: number): Promise<void> {
  badge = Math.max(0, Math.floor(count));
  applyBadge(badge);
  return Promise.resolve();
}

/** Add to the badge count. */
export function incrementBadgeCount(incrementBy = 1): Promise<void> {
  return setBadgeCount(badge + incrementBy);
}

/** Subtract from the badge count (not below 0). */
export function decrementBadgeCount(decrementBy = 1): Promise<void> {
  return setBadgeCount(badge - decrementBy);
}

/** Foreground services do not exist here: the task is never run. */
export function registerForegroundService(
  _task: (notification: Notification) => Promise<void>,
): void {}

/** Foreground services do not exist here: does nothing. */
export function stopForegroundService(): Promise<void> {
  return Promise.resolve();
}

/** The notification drawer cannot be closed here: does nothing. */
export function hideNotificationDrawer(): void {}

/** The package's default export: the module's API plus `SDK_VERSION`. */
export interface NotifeeModule {
  /** {@linkcode cancelAllNotifications}. */
  readonly cancelAllNotifications: typeof cancelAllNotifications;
  /** {@linkcode cancelDisplayedNotifications}. */
  readonly cancelDisplayedNotifications: typeof cancelDisplayedNotifications;
  /** {@linkcode cancelTriggerNotifications}. */
  readonly cancelTriggerNotifications: typeof cancelTriggerNotifications;
  /** {@linkcode cancelNotification}. */
  readonly cancelNotification: typeof cancelNotification;
  /** {@linkcode cancelDisplayedNotification}. */
  readonly cancelDisplayedNotification: typeof cancelDisplayedNotification;
  /** {@linkcode cancelTriggerNotification}. */
  readonly cancelTriggerNotification: typeof cancelTriggerNotification;
  /** {@linkcode createChannel}. */
  readonly createChannel: typeof createChannel;
  /** {@linkcode createChannels}. */
  readonly createChannels: typeof createChannels;
  /** {@linkcode createChannelGroup}. */
  readonly createChannelGroup: typeof createChannelGroup;
  /** {@linkcode createChannelGroups}. */
  readonly createChannelGroups: typeof createChannelGroups;
  /** {@linkcode deleteChannel}. */
  readonly deleteChannel: typeof deleteChannel;
  /** {@linkcode deleteChannelGroup}. */
  readonly deleteChannelGroup: typeof deleteChannelGroup;
  /** {@linkcode displayNotification}. */
  readonly displayNotification: typeof displayNotification;
  /** {@linkcode openAlarmPermissionSettings}. */
  readonly openAlarmPermissionSettings: typeof openAlarmPermissionSettings;
  /** {@linkcode createTriggerNotification}. */
  readonly createTriggerNotification: typeof createTriggerNotification;
  /** {@linkcode getTriggerNotificationIds}. */
  readonly getTriggerNotificationIds: typeof getTriggerNotificationIds;
  /** {@linkcode getDisplayedNotifications}. */
  readonly getDisplayedNotifications: typeof getDisplayedNotifications;
  /** {@linkcode getTriggerNotifications}. */
  readonly getTriggerNotifications: typeof getTriggerNotifications;
  /** {@linkcode getChannel}. */
  readonly getChannel: typeof getChannel;
  /** {@linkcode isChannelCreated}. */
  readonly isChannelCreated: typeof isChannelCreated;
  /** {@linkcode isChannelBlocked}. */
  readonly isChannelBlocked: typeof isChannelBlocked;
  /** {@linkcode getChannels}. */
  readonly getChannels: typeof getChannels;
  /** {@linkcode getChannelGroup}. */
  readonly getChannelGroup: typeof getChannelGroup;
  /** {@linkcode getChannelGroups}. */
  readonly getChannelGroups: typeof getChannelGroups;
  /** {@linkcode getInitialNotification}. */
  readonly getInitialNotification: typeof getInitialNotification;
  /** {@linkcode onBackgroundEvent}. */
  readonly onBackgroundEvent: typeof onBackgroundEvent;
  /** {@linkcode onForegroundEvent}. */
  readonly onForegroundEvent: typeof onForegroundEvent;
  /** {@linkcode openNotificationSettings}. */
  readonly openNotificationSettings: typeof openNotificationSettings;
  /** {@linkcode registerForegroundService}. */
  readonly registerForegroundService: typeof registerForegroundService;
  /** {@linkcode stopForegroundService}. */
  readonly stopForegroundService: typeof stopForegroundService;
  /** {@linkcode requestPermission}. */
  readonly requestPermission: typeof requestPermission;
  /** {@linkcode setNotificationCategories}. */
  readonly setNotificationCategories: typeof setNotificationCategories;
  /** {@linkcode getNotificationCategories}. */
  readonly getNotificationCategories: typeof getNotificationCategories;
  /** {@linkcode getNotificationSettings}. */
  readonly getNotificationSettings: typeof getNotificationSettings;
  /** {@linkcode getBadgeCount}. */
  readonly getBadgeCount: typeof getBadgeCount;
  /** {@linkcode setBadgeCount}. */
  readonly setBadgeCount: typeof setBadgeCount;
  /** {@linkcode incrementBadgeCount}. */
  readonly incrementBadgeCount: typeof incrementBadgeCount;
  /** {@linkcode decrementBadgeCount}. */
  readonly decrementBadgeCount: typeof decrementBadgeCount;
  /** {@linkcode openBatteryOptimizationSettings}. */
  readonly openBatteryOptimizationSettings: typeof openBatteryOptimizationSettings;
  /** {@linkcode isBatteryOptimizationEnabled}. */
  readonly isBatteryOptimizationEnabled: typeof isBatteryOptimizationEnabled;
  /** {@linkcode getPowerManagerInfo}. */
  readonly getPowerManagerInfo: typeof getPowerManagerInfo;
  /** {@linkcode openPowerManagerSettings}. */
  readonly openPowerManagerSettings: typeof openPowerManagerSettings;
  /** {@linkcode hideNotificationDrawer}. */
  readonly hideNotificationDrawer: typeof hideNotificationDrawer;
  /** The version of the package this stands in for. */
  readonly SDK_VERSION: string;
}

/** The package's default export. */
const notifee: NotifeeModule = {
  cancelAllNotifications,
  cancelDisplayedNotifications,
  cancelTriggerNotifications,
  cancelNotification,
  cancelDisplayedNotification,
  cancelTriggerNotification,
  createChannel,
  createChannels,
  createChannelGroup,
  createChannelGroups,
  deleteChannel,
  deleteChannelGroup,
  displayNotification,
  openAlarmPermissionSettings,
  createTriggerNotification,
  getTriggerNotificationIds,
  getDisplayedNotifications,
  getTriggerNotifications,
  getChannel,
  isChannelCreated,
  isChannelBlocked,
  getChannels,
  getChannelGroup,
  getChannelGroups,
  getInitialNotification,
  onBackgroundEvent,
  onForegroundEvent,
  openNotificationSettings,
  registerForegroundService,
  stopForegroundService,
  requestPermission,
  setNotificationCategories,
  getNotificationCategories,
  getNotificationSettings,
  getBadgeCount,
  setBadgeCount,
  incrementBadgeCount,
  decrementBadgeCount,
  openBatteryOptimizationSettings,
  isBatteryOptimizationEnabled,
  getPowerManagerInfo,
  openPowerManagerSettings,
  hideNotificationDrawer,
  SDK_VERSION: "9.1.8",
};

export default notifee;
