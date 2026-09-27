/**
 * `react-native-permissions` for denext's React Native mode: the same API over
 * `denext/mobile`'s permission calls ({@linkcode checkPermission} / {@linkcode requestPermission}
 * / {@linkcode openAppSettings}, backed by each capability's Capacitor plugin in the shell and
 * the Permissions API on the web) and App Tracking Transparency.
 *
 * Each `PERMISSIONS.*` string maps to one denext permission (camera, microphone, photos,
 * location, background location, notifications, contacts, calendar, Face ID). One that has no
 * denext counterpart (Bluetooth, Siri, motion, SMS, …), or that belongs to another platform
 * than the shell's, reads `RESULTS.UNAVAILABLE`, as the package reports a permission the
 * platform does not have. A `rationale` is not shown: denext's prompt is the system's own.
 *
 * In React Native mode `import { check, PERMISSIONS } from "react-native-permissions"`
 * resolves here, so app code runs unchanged.
 *
 * @example
 * ```ts
 * import { check, PERMISSIONS, request, RESULTS } from "react-native-permissions";
 *
 * if ((await check(PERMISSIONS.IOS.CAMERA)) === RESULTS.DENIED) {
 *   await request(PERMISSIONS.IOS.CAMERA);
 * }
 * ```
 *
 * @module
 */

import {
  checkPermission,
  openAppSettings,
  type PermissionName,
  type PermissionState,
  requestPermission,
} from "../mobile/permissions.ts";
import { getTrackingStatus, requestTrackingPermission } from "../mobile/tracking.ts";
import { nativePlatform } from "../mobile/bridge.ts";

/** iOS permissions (the package's `PERMISSIONS.IOS`). */
export const IOS_PERMISSIONS = {
  APP_TRACKING_TRANSPARENCY: "ios.permission.APP_TRACKING_TRANSPARENCY",
  BLUETOOTH: "ios.permission.BLUETOOTH",
  CALENDARS: "ios.permission.CALENDARS",
  CALENDARS_WRITE_ONLY: "ios.permission.CALENDARS_WRITE_ONLY",
  CAMERA: "ios.permission.CAMERA",
  CONTACTS: "ios.permission.CONTACTS",
  FACE_ID: "ios.permission.FACE_ID",
  LOCATION_ALWAYS: "ios.permission.LOCATION_ALWAYS",
  LOCATION_WHEN_IN_USE: "ios.permission.LOCATION_WHEN_IN_USE",
  MEDIA_LIBRARY: "ios.permission.MEDIA_LIBRARY",
  MICROPHONE: "ios.permission.MICROPHONE",
  MOTION: "ios.permission.MOTION",
  PHOTO_LIBRARY: "ios.permission.PHOTO_LIBRARY",
  PHOTO_LIBRARY_ADD_ONLY: "ios.permission.PHOTO_LIBRARY_ADD_ONLY",
  REMINDERS: "ios.permission.REMINDERS",
  SIRI: "ios.permission.SIRI",
  SPEECH_RECOGNITION: "ios.permission.SPEECH_RECOGNITION",
  STOREKIT: "ios.permission.STOREKIT",
} as const;

/** Android permissions (the package's `PERMISSIONS.ANDROID`). */
export const ANDROID_PERMISSIONS = {
  ACCEPT_HANDOVER: "android.permission.ACCEPT_HANDOVER",
  ACCESS_BACKGROUND_LOCATION: "android.permission.ACCESS_BACKGROUND_LOCATION",
  ACCESS_COARSE_LOCATION: "android.permission.ACCESS_COARSE_LOCATION",
  ACCESS_FINE_LOCATION: "android.permission.ACCESS_FINE_LOCATION",
  ACCESS_MEDIA_LOCATION: "android.permission.ACCESS_MEDIA_LOCATION",
  ACTIVITY_RECOGNITION: "android.permission.ACTIVITY_RECOGNITION",
  ADD_VOICEMAIL: "com.android.voicemail.permission.ADD_VOICEMAIL",
  ANSWER_PHONE_CALLS: "android.permission.ANSWER_PHONE_CALLS",
  BLUETOOTH_ADVERTISE: "android.permission.BLUETOOTH_ADVERTISE",
  BLUETOOTH_CONNECT: "android.permission.BLUETOOTH_CONNECT",
  BLUETOOTH_SCAN: "android.permission.BLUETOOTH_SCAN",
  BODY_SENSORS: "android.permission.BODY_SENSORS",
  BODY_SENSORS_BACKGROUND: "android.permission.BODY_SENSORS_BACKGROUND",
  CALL_PHONE: "android.permission.CALL_PHONE",
  CAMERA: "android.permission.CAMERA",
  GET_ACCOUNTS: "android.permission.GET_ACCOUNTS",
  NEARBY_WIFI_DEVICES: "android.permission.NEARBY_WIFI_DEVICES",
  PROCESS_OUTGOING_CALLS: "android.permission.PROCESS_OUTGOING_CALLS",
  READ_CALENDAR: "android.permission.READ_CALENDAR",
  READ_CALL_LOG: "android.permission.READ_CALL_LOG",
  READ_CONTACTS: "android.permission.READ_CONTACTS",
  READ_EXTERNAL_STORAGE: "android.permission.READ_EXTERNAL_STORAGE",
  READ_MEDIA_AUDIO: "android.permission.READ_MEDIA_AUDIO",
  READ_MEDIA_IMAGES: "android.permission.READ_MEDIA_IMAGES",
  READ_MEDIA_VIDEO: "android.permission.READ_MEDIA_VIDEO",
  READ_MEDIA_VISUAL_USER_SELECTED: "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
  READ_PHONE_NUMBERS: "android.permission.READ_PHONE_NUMBERS",
  READ_PHONE_STATE: "android.permission.READ_PHONE_STATE",
  READ_SMS: "android.permission.READ_SMS",
  RECEIVE_MMS: "android.permission.RECEIVE_MMS",
  RECEIVE_SMS: "android.permission.RECEIVE_SMS",
  RECEIVE_WAP_PUSH: "android.permission.RECEIVE_WAP_PUSH",
  RECORD_AUDIO: "android.permission.RECORD_AUDIO",
  SEND_SMS: "android.permission.SEND_SMS",
  USE_SIP: "android.permission.USE_SIP",
  UWB_RANGING: "android.permission.UWB_RANGING",
  WRITE_CALENDAR: "android.permission.WRITE_CALENDAR",
  WRITE_CALL_LOG: "android.permission.WRITE_CALL_LOG",
  WRITE_CONTACTS: "android.permission.WRITE_CONTACTS",
  WRITE_EXTERNAL_STORAGE: "android.permission.WRITE_EXTERNAL_STORAGE",
} as const;

/**
 * Windows capabilities (the package's `PERMISSIONS.WINDOWS`). Only the handful with a web
 * equivalent (webcam, microphone, location, contacts, pictures, appointments) are listed; the
 * package's other names read `undefined` here and `RESULTS.UNAVAILABLE` from {@linkcode check}.
 */
export const WINDOWS_PERMISSIONS = {
  APPOINTMENTS: "windows.permission.appointments",
  CONTACTS: "windows.permission.contacts",
  LOCATION: "windows.permission.location",
  MICROPHONE: "windows.permission.microphone",
  PICTURES_LIBRARY: "windows.permission.picturesLibrary",
  WEBCAM: "windows.permission.webcam",
} as const;

/** The permission strings, per platform. */
export const PERMISSIONS: {
  /** Android's runtime permissions. */
  readonly ANDROID: typeof ANDROID_PERMISSIONS;
  /** iOS's permissions. */
  readonly IOS: typeof IOS_PERMISSIONS;
  /** Windows' capabilities (those with a web equivalent). */
  readonly WINDOWS: typeof WINDOWS_PERMISSIONS;
} = { ANDROID: ANDROID_PERMISSIONS, IOS: IOS_PERMISSIONS, WINDOWS: WINDOWS_PERMISSIONS };

/** A permission's status (the package's `RESULTS`). */
export const RESULTS: {
  /** The platform (or this app) has no such permission. */
  readonly UNAVAILABLE: "unavailable";
  /** Refused, and the system will not prompt again: only the settings can change it. */
  readonly BLOCKED: "blocked";
  /** Not granted, and a request can still prompt. */
  readonly DENIED: "denied";
  /** Granted. */
  readonly GRANTED: "granted";
  /** Granted in part (selected photos, approximate location, write-only calendar). */
  readonly LIMITED: "limited";
} = {
  UNAVAILABLE: "unavailable",
  BLOCKED: "blocked",
  DENIED: "denied",
  GRANTED: "granted",
  LIMITED: "limited",
};

/** An iOS permission string. */
export type IOSPermission = (typeof IOS_PERMISSIONS)[keyof typeof IOS_PERMISSIONS];
/** An Android permission string. */
export type AndroidPermission = (typeof ANDROID_PERMISSIONS)[keyof typeof ANDROID_PERMISSIONS];
/** A Windows capability string. */
export type WindowsPermission = (typeof WINDOWS_PERMISSIONS)[keyof typeof WINDOWS_PERMISSIONS];
/** Any permission string. */
export type Permission = IOSPermission | AndroidPermission | WindowsPermission;
/** A permission status (a value of {@linkcode RESULTS}). */
export type PermissionStatus = (typeof RESULTS)[keyof typeof RESULTS];

/** Android's rationale dialog (not shown: denext's prompt is the system's own). */
export type RationaleObject = {
  /** The title. */
  title: string;
  /** The message. */
  message: string;
  /** The positive button. */
  buttonPositive: string;
  /** The negative button. */
  buttonNegative?: string;
};

/** A rationale: the dialog, or a function that shows your own and resolves whether to go on. */
export type Rationale = RationaleObject | (() => Promise<boolean>);

/** Location accuracy (iOS 14+). */
export type LocationAccuracy = "full" | "reduced";

/** Options for {@linkcode requestLocationAccuracy}. */
export type LocationAccuracyOptions = {
  /** The `NSLocationTemporaryUsageDescriptionDictionary` key. */
  purposeKey: string;
};

/** A notification option to request (iOS). */
export type NotificationOption =
  | "alert"
  | "badge"
  | "sound"
  | "carPlay"
  | "criticalAlert"
  | "provisional"
  | "providesAppSettings";

/** The notification settings {@linkcode checkNotifications} reports. */
export type NotificationSettings = {
  /** Alerts may show. */
  alert?: boolean;
  /** The badge may change. */
  badge?: boolean;
  /** Sounds may play. */
  sound?: boolean;
  /** CarPlay may show them. */
  carPlay?: boolean;
  /** Critical alerts may show. */
  criticalAlert?: boolean;
  /** Delivered quietly (provisional authorization). */
  provisional?: boolean;
  /** The app has its own notification settings screen. */
  providesAppSettings?: boolean;
  /** They show on the lock screen. */
  lockScreen?: boolean;
  /** They show in the notification center. */
  notificationCenter?: boolean;
};

/** What {@linkcode checkNotifications} / {@linkcode requestNotifications} resolve to. */
export type NotificationsResponse = {
  /** The status. */
  status: PermissionStatus;
  /** The settings (all on when granted, all off otherwise; the plugin reports no detail). */
  settings: NotificationSettings;
};

/** Which settings screen {@linkcode openSettings} opens (the app's own, always, here). */
export type SettingsType = "application" | "alarms" | "fullscreen" | "notifications";

/** Each permission string with a denext counterpart. */
const DENEXT_NAMES: Readonly<Record<string, PermissionName>> = {
  [IOS_PERMISSIONS.CAMERA]: "camera",
  [IOS_PERMISSIONS.MICROPHONE]: "microphone",
  [IOS_PERMISSIONS.PHOTO_LIBRARY]: "photos",
  [IOS_PERMISSIONS.PHOTO_LIBRARY_ADD_ONLY]: "photos",
  [IOS_PERMISSIONS.LOCATION_WHEN_IN_USE]: "location",
  [IOS_PERMISSIONS.LOCATION_ALWAYS]: "location-background",
  [IOS_PERMISSIONS.CONTACTS]: "contacts",
  [IOS_PERMISSIONS.CALENDARS]: "calendar",
  [IOS_PERMISSIONS.CALENDARS_WRITE_ONLY]: "calendar",
  [IOS_PERMISSIONS.FACE_ID]: "biometrics",
  [ANDROID_PERMISSIONS.CAMERA]: "camera",
  [ANDROID_PERMISSIONS.RECORD_AUDIO]: "microphone",
  [ANDROID_PERMISSIONS.ACCESS_FINE_LOCATION]: "location",
  [ANDROID_PERMISSIONS.ACCESS_COARSE_LOCATION]: "location",
  [ANDROID_PERMISSIONS.ACCESS_BACKGROUND_LOCATION]: "location-background",
  [ANDROID_PERMISSIONS.READ_CONTACTS]: "contacts",
  [ANDROID_PERMISSIONS.WRITE_CONTACTS]: "contacts",
  [ANDROID_PERMISSIONS.READ_CALENDAR]: "calendar",
  [ANDROID_PERMISSIONS.WRITE_CALENDAR]: "calendar",
  [ANDROID_PERMISSIONS.READ_MEDIA_IMAGES]: "photos",
  [ANDROID_PERMISSIONS.READ_MEDIA_VIDEO]: "photos",
  [ANDROID_PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED]: "photos",
  [ANDROID_PERMISSIONS.READ_EXTERNAL_STORAGE]: "photos",
  [WINDOWS_PERMISSIONS.WEBCAM]: "camera",
  [WINDOWS_PERMISSIONS.MICROPHONE]: "microphone",
  [WINDOWS_PERMISSIONS.LOCATION]: "location",
  [WINDOWS_PERMISSIONS.CONTACTS]: "contacts",
  [WINDOWS_PERMISSIONS.PICTURES_LIBRARY]: "photos",
  [WINDOWS_PERMISSIONS.APPOINTMENTS]: "calendar",
};

/** A denext status as the package's. */
function toResult(state: PermissionState): PermissionStatus {
  switch (state) {
    case "granted":
      return RESULTS.GRANTED;
    case "limited":
      return RESULTS.LIMITED;
    case "blocked":
      return RESULTS.BLOCKED;
    default:
      return RESULTS.DENIED;
  }
}

/** Whether `permission` belongs to another platform than the shell's (on the web, none does). */
function otherPlatform(permission: string): boolean {
  const platform = nativePlatform();
  if (platform === "web") return false;
  return !(permission.startsWith(`${platform}.`) ||
    (platform === "android" && permission.startsWith("com.android.")));
}

/** Run a denext permission call, reading "nothing can answer" as `unavailable`. */
async function settle(run: () => Promise<PermissionState>): Promise<PermissionStatus> {
  try {
    return toResult(await run());
  } catch (err) {
    if ((err as { code?: string })?.code === "unsupported") return RESULTS.UNAVAILABLE;
    throw err;
  }
}

/** App Tracking Transparency's status as the package's. */
function trackingResult(status: string): PermissionStatus {
  if (status === "authorized") return RESULTS.GRANTED;
  if (status === "not-determined") return RESULTS.DENIED;
  if (status === "unavailable") return RESULTS.UNAVAILABLE;
  return RESULTS.BLOCKED;
}

/** Check or request one permission. */
function resolve(permission: Permission, ask: boolean): Promise<PermissionStatus> {
  if (otherPlatform(permission)) return Promise.resolve(RESULTS.UNAVAILABLE);
  if (permission === IOS_PERMISSIONS.APP_TRACKING_TRANSPARENCY) {
    return (ask ? requestTrackingPermission() : getTrackingStatus()).then(trackingResult);
  }
  const name = DENEXT_NAMES[permission];
  if (!name) return Promise.resolve(RESULTS.UNAVAILABLE);
  return settle(() => ask ? requestPermission(name) : checkPermission(name));
}

/**
 * A permission's status, without prompting.
 *
 * @param permission A `PERMISSIONS.*` string.
 * @returns Its status.
 */
export function check(permission: Permission): Promise<PermissionStatus> {
  return resolve(permission, false);
}

/**
 * Ask for a permission when a prompt can still be shown, and report the outcome.
 *
 * @param permission A `PERMISSIONS.*` string.
 * @param _rationale Android's rationale (not shown).
 * @returns Its status after the prompt, if one was shown.
 */
export function request(
  permission: Permission,
  _rationale?: Rationale,
): Promise<PermissionStatus> {
  return resolve(permission, true);
}

/** Resolve each of `permissions` in turn into a record. */
async function each<P extends Permission[]>(
  permissions: P,
  ask: boolean,
): Promise<Record<P[number], PermissionStatus>> {
  const out = {} as Record<P[number], PermissionStatus>;
  for (const p of permissions) out[p as P[number]] = await resolve(p, ask);
  return out;
}

/**
 * Several permissions' statuses, without prompting.
 *
 * @param permissions `PERMISSIONS.*` strings.
 * @returns Each one's status.
 */
export function checkMultiple<P extends Permission[]>(
  permissions: P,
): Promise<Record<P[number], PermissionStatus>> {
  return each(permissions, false);
}

/**
 * Ask for several permissions, one after another.
 *
 * @param permissions `PERMISSIONS.*` strings.
 * @returns Each one's status afterwards.
 */
export function requestMultiple<P extends Permission[]>(
  permissions: P,
): Promise<Record<P[number], PermissionStatus>> {
  return each(permissions, true);
}

/** A notification status with the settings that go with it. */
function notifications(status: PermissionStatus): NotificationsResponse {
  const on = status === RESULTS.GRANTED || status === RESULTS.LIMITED;
  return {
    status,
    settings: on
      ? { alert: true, badge: true, sound: true, lockScreen: true, notificationCenter: true }
      : {},
  };
}

/**
 * The notification permission (local and push), without prompting.
 *
 * @returns The status and settings.
 */
export async function checkNotifications(): Promise<NotificationsResponse> {
  return notifications(await settle(() => checkPermission("notifications")));
}

/**
 * Ask for the notification permission.
 *
 * @param _options The iOS options (the plugin asks for alert, badge and sound).
 * @param _rationale Android's rationale (not shown).
 * @returns The status and settings afterwards.
 */
export async function requestNotifications(
  _options?: NotificationOption[],
  _rationale?: Rationale,
): Promise<NotificationsResponse> {
  return notifications(await settle(() => requestPermission("notifications")));
}

/**
 * Open the app's settings screen (`openAppSettings`; `denext mobile add permissions` on
 * Android).
 *
 * @param _type Which screen: the app's own, whatever is asked.
 * @returns A promise that settles once it opened.
 */
export function openSettings(_type?: SettingsType): Promise<void> {
  return openAppSettings();
}

/** The error a call with no denext implementation rejects with. */
function unsupported(name: string, why: string): Error {
  return new Error(`react-native-permissions (denext): ${name} is not available here. ${why}`);
}

/**
 * iOS's limited-library picker. Not available: use `pickImage` from `denext/mobile`.
 *
 * @returns A rejected promise.
 */
export function openPhotoPicker(): Promise<void> {
  return Promise.reject(
    unsupported("openPhotoPicker", 'Pick with `pickImage()` from "denext/mobile".'),
  );
}

/**
 * iOS 18's limited-contacts picker. Not available.
 *
 * @returns A rejected promise.
 */
export function openContactPicker(): Promise<void> {
  return Promise.reject(unsupported("openContactPicker", "There is no contact picker plugin."));
}

/**
 * The location accuracy: `reduced` while the location permission is only approximate
 * (`limited`), `full` otherwise.
 *
 * @returns The accuracy.
 */
export async function checkLocationAccuracy(): Promise<LocationAccuracy> {
  return (await check(IOS_PERMISSIONS.LOCATION_WHEN_IN_USE)) === RESULTS.LIMITED
    ? "reduced"
    : "full";
}

/**
 * Ask for full accuracy once. There is no temporary-full-accuracy prompt here, so it reports
 * the current accuracy.
 *
 * @param _options The purpose key (unused).
 * @returns The accuracy.
 */
export function requestLocationAccuracy(
  _options: LocationAccuracyOptions,
): Promise<LocationAccuracy> {
  return checkLocationAccuracy();
}

/**
 * Whether exact alarms may be scheduled (Android 12+). Local notifications schedule through
 * `denext/mobile`, which uses inexact alarms where it must, so this is `true`.
 *
 * @returns `true`.
 */
export function canScheduleExactAlarms(): Promise<boolean> {
  return Promise.resolve(true);
}

/**
 * Whether full-screen intents may be used (Android 14+). Not available here.
 *
 * @returns `false`.
 */
export function canUseFullScreenIntent(): Promise<boolean> {
  return Promise.resolve(false);
}

/** The package's default export: every call and constant above. */
const RNPermissions: {
  /** The permission strings. */
  readonly PERMISSIONS: typeof PERMISSIONS;
  /** The statuses. */
  readonly RESULTS: typeof RESULTS;
  /** {@linkcode canScheduleExactAlarms}. */
  readonly canScheduleExactAlarms: typeof canScheduleExactAlarms;
  /** {@linkcode canUseFullScreenIntent}. */
  readonly canUseFullScreenIntent: typeof canUseFullScreenIntent;
  /** {@linkcode check}. */
  readonly check: typeof check;
  /** {@linkcode checkLocationAccuracy}. */
  readonly checkLocationAccuracy: typeof checkLocationAccuracy;
  /** {@linkcode checkMultiple}. */
  readonly checkMultiple: typeof checkMultiple;
  /** {@linkcode checkNotifications}. */
  readonly checkNotifications: typeof checkNotifications;
  /** {@linkcode openContactPicker}. */
  readonly openContactPicker: typeof openContactPicker;
  /** {@linkcode openPhotoPicker}. */
  readonly openPhotoPicker: typeof openPhotoPicker;
  /** {@linkcode openSettings}. */
  readonly openSettings: typeof openSettings;
  /** {@linkcode request}. */
  readonly request: typeof request;
  /** {@linkcode requestLocationAccuracy}. */
  readonly requestLocationAccuracy: typeof requestLocationAccuracy;
  /** {@linkcode requestMultiple}. */
  readonly requestMultiple: typeof requestMultiple;
  /** {@linkcode requestNotifications}. */
  readonly requestNotifications: typeof requestNotifications;
} = {
  PERMISSIONS,
  RESULTS,
  canScheduleExactAlarms,
  canUseFullScreenIntent,
  check,
  checkLocationAccuracy,
  checkMultiple,
  checkNotifications,
  openContactPicker,
  openPhotoPicker,
  openSettings,
  request,
  requestLocationAccuracy,
  requestMultiple,
  requestNotifications,
};

export default RNPermissions;
