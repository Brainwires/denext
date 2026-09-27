/**
 * React Native's `PermissionsAndroid` for React Native mode, over `denext/mobile`'s one
 * permission API (`checkPermission` / `requestPermission`). react-native-web has no
 * `PermissionsAndroid` at all, so an import of it was a build error.
 *
 * @module
 */

import { showDialog } from "../mobile/dialog.ts";
import {
  checkPermission,
  type PermissionName,
  type PermissionState,
  requestPermission,
} from "../mobile/permissions.ts";

/** React Native's `PermissionsAndroid.PERMISSIONS`: each Android permission's full name. */
const ANDROID_PERMISSIONS = {
  READ_CALENDAR: "android.permission.READ_CALENDAR",
  WRITE_CALENDAR: "android.permission.WRITE_CALENDAR",
  CAMERA: "android.permission.CAMERA",
  READ_CONTACTS: "android.permission.READ_CONTACTS",
  WRITE_CONTACTS: "android.permission.WRITE_CONTACTS",
  GET_ACCOUNTS: "android.permission.GET_ACCOUNTS",
  ACCESS_FINE_LOCATION: "android.permission.ACCESS_FINE_LOCATION",
  ACCESS_COARSE_LOCATION: "android.permission.ACCESS_COARSE_LOCATION",
  ACCESS_BACKGROUND_LOCATION: "android.permission.ACCESS_BACKGROUND_LOCATION",
  RECORD_AUDIO: "android.permission.RECORD_AUDIO",
  READ_PHONE_STATE: "android.permission.READ_PHONE_STATE",
  CALL_PHONE: "android.permission.CALL_PHONE",
  READ_CALL_LOG: "android.permission.READ_CALL_LOG",
  WRITE_CALL_LOG: "android.permission.WRITE_CALL_LOG",
  ADD_VOICEMAIL: "com.android.voicemail.permission.ADD_VOICEMAIL",
  READ_VOICEMAIL: "com.android.voicemail.permission.READ_VOICEMAIL",
  WRITE_VOICEMAIL: "com.android.voicemail.permission.WRITE_VOICEMAIL",
  USE_SIP: "android.permission.USE_SIP",
  PROCESS_OUTGOING_CALLS: "android.permission.PROCESS_OUTGOING_CALLS",
  BODY_SENSORS: "android.permission.BODY_SENSORS",
  BODY_SENSORS_BACKGROUND: "android.permission.BODY_SENSORS_BACKGROUND",
  SEND_SMS: "android.permission.SEND_SMS",
  RECEIVE_SMS: "android.permission.RECEIVE_SMS",
  READ_SMS: "android.permission.READ_SMS",
  RECEIVE_WAP_PUSH: "android.permission.RECEIVE_WAP_PUSH",
  RECEIVE_MMS: "android.permission.RECEIVE_MMS",
  READ_EXTERNAL_STORAGE: "android.permission.READ_EXTERNAL_STORAGE",
  READ_MEDIA_IMAGES: "android.permission.READ_MEDIA_IMAGES",
  READ_MEDIA_VIDEO: "android.permission.READ_MEDIA_VIDEO",
  READ_MEDIA_AUDIO: "android.permission.READ_MEDIA_AUDIO",
  READ_MEDIA_VISUAL_USER_SELECTED: "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
  WRITE_EXTERNAL_STORAGE: "android.permission.WRITE_EXTERNAL_STORAGE",
  BLUETOOTH_CONNECT: "android.permission.BLUETOOTH_CONNECT",
  BLUETOOTH_SCAN: "android.permission.BLUETOOTH_SCAN",
  BLUETOOTH_ADVERTISE: "android.permission.BLUETOOTH_ADVERTISE",
  ACCESS_MEDIA_LOCATION: "android.permission.ACCESS_MEDIA_LOCATION",
  ACCEPT_HANDOVER: "android.permission.ACCEPT_HANDOVER",
  ACTIVITY_RECOGNITION: "android.permission.ACTIVITY_RECOGNITION",
  ANSWER_PHONE_CALLS: "android.permission.ANSWER_PHONE_CALLS",
  READ_PHONE_NUMBERS: "android.permission.READ_PHONE_NUMBERS",
  UWB_RANGING: "android.permission.UWB_RANGING",
  POST_NOTIFICATIONS: "android.permission.POST_NOTIFICATIONS",
  NEARBY_WIFI_DEVICES: "android.permission.NEARBY_WIFI_DEVICES",
} as const;

/** An Android permission's full name (a value of {@linkcode ANDROID_PERMISSIONS}). */
export type Permission = (typeof ANDROID_PERMISSIONS)[keyof typeof ANDROID_PERMISSIONS];

/** What `request` resolves with (React Native's `PermissionsAndroid.RESULTS`). */
export type PermissionStatus = "granted" | "denied" | "never_ask_again";

/** The dialog `request` shows first when Android asks for a rationale. */
export interface Rationale {
  /** The dialog's title. */
  title: string;
  /** Why the app needs the permission. */
  message: string;
  /** The positive button's text (default `"OK"`). */
  buttonPositive?: string;
  /** A negative button's text. */
  buttonNegative?: string;
  /** A neutral button's text. */
  buttonNeutral?: string;
}

/** React Native's `PermissionsAndroid` module. */
export interface PermissionsAndroidStatic {
  /** Each Android permission's full name. */
  readonly PERMISSIONS: typeof ANDROID_PERMISSIONS;
  /** The statuses `request` / `requestMultiple` resolve with. */
  readonly RESULTS: {
    readonly DENIED: "denied";
    readonly GRANTED: "granted";
    readonly NEVER_ASK_AGAIN: "never_ask_again";
  };
  /** Whether `permission` is granted, without prompting. */
  check(permission: Permission): Promise<boolean>;
  /** Deprecated `check`. */
  checkPermission(permission: Permission): Promise<boolean>;
  /** Prompt for `permission` (after `rationale`, when Android asks for one); its status. */
  request(permission: Permission, rationale?: Rationale): Promise<PermissionStatus>;
  /** Deprecated `request`, resolving whether it was granted. */
  requestPermission(permission: Permission, rationale?: Rationale): Promise<boolean>;
  /** Prompt for each permission in turn; a status per permission. */
  requestMultiple(
    permissions: readonly Permission[],
  ): Promise<{ [permission in Permission]: PermissionStatus }>;
}

/** Which `denext/mobile` permission answers for each Android permission it can. */
const PERMISSION_NAMES: Readonly<Record<string, PermissionName>> = {
  "android.permission.CAMERA": "camera",
  "android.permission.RECORD_AUDIO": "microphone",
  "android.permission.ACCESS_FINE_LOCATION": "location",
  "android.permission.ACCESS_COARSE_LOCATION": "location",
  "android.permission.ACCESS_BACKGROUND_LOCATION": "location-background",
  "android.permission.POST_NOTIFICATIONS": "notifications",
  "android.permission.READ_CONTACTS": "contacts",
  "android.permission.WRITE_CONTACTS": "contacts",
  "android.permission.READ_CALENDAR": "calendar",
  "android.permission.WRITE_CALENDAR": "calendar",
  "android.permission.READ_EXTERNAL_STORAGE": "photos",
  "android.permission.READ_MEDIA_IMAGES": "photos",
  "android.permission.READ_MEDIA_VIDEO": "photos",
  "android.permission.READ_MEDIA_VISUAL_USER_SELECTED": "photos",
};

/**
 * The Android permissions a `limited` grant does NOT include: precise location (limited is
 * approximate only), full photo access (limited is the user's selection) and reading the
 * calendar (limited is write-only).
 */
const NOT_IN_LIMITED: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_CALENDAR",
]);

/** `permission`'s React Native status for a `denext/mobile` state. */
function statusOf(permission: string, state: PermissionState | undefined): PermissionStatus {
  switch (state) {
    case "granted":
      return "granted";
    case "limited":
      return NOT_IN_LIMITED.has(permission) ? "denied" : "granted";
    case "blocked":
      return "never_ask_again";
    default:
      return "denied";
  }
}

/** The `denext/mobile` state of `name`, or undefined when nothing here can answer it. */
async function stateOf(
  name: PermissionName | undefined,
  ask: boolean,
): Promise<PermissionState | undefined> {
  if (!name) return undefined;
  try {
    return await (ask ? requestPermission(name) : checkPermission(name));
  } catch {
    return undefined;
  }
}

/** Show `rationale` (its buttons, `buttonPositive` last) and wait for any press. */
async function showRationale(rationale: Rationale): Promise<void> {
  const buttons = [
    ...(rationale.buttonNegative
      ? [{ text: rationale.buttonNegative, style: "cancel" as const }]
      : []),
    ...(rationale.buttonNeutral ? [{ text: rationale.buttonNeutral }] : []),
    { text: rationale.buttonPositive || "OK", preferred: true },
  ];
  await showDialog({
    title: String(rationale.title ?? ""),
    message: String(rationale.message ?? ""),
    buttons,
  });
}

/** `request`: the rationale when Android wants one, then the prompt. */
async function requestOne(
  permission: Permission,
  rationale?: Rationale,
): Promise<PermissionStatus> {
  const name = PERMISSION_NAMES[permission];
  if (rationale && name && (await stateOf(name, false)) === "prompt-with-rationale") {
    await showRationale(rationale);
  }
  return statusOf(permission, await stateOf(name, true));
}

/**
 * React Native's `PermissionsAndroid`, answered by `denext/mobile`'s `checkPermission` /
 * `requestPermission`, so it works in the Android shell, the iOS shell and a browser alike
 * (React Native answers only on Android; `Platform.OS` is `"web"` here, so a library that
 * guards on `"android"` never calls it anyway).
 *
 * The permissions it can answer, and the `denext/mobile` name behind each:
 *
 * - `CAMERA` → `camera`; `RECORD_AUDIO` → `microphone`;
 * - `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` → `location` (an approximate-only grant
 *   is `granted` for coarse, `denied` for fine); `ACCESS_BACKGROUND_LOCATION` →
 *   `location-background`, which denext does not ship yet, so it reads `denied`;
 * - `POST_NOTIFICATIONS` → `notifications`;
 * - `READ_CONTACTS` / `WRITE_CONTACTS` → `contacts`; `READ_CALENDAR` / `WRITE_CALENDAR` →
 *   `calendar` (write-only access is `granted` for write, `denied` for read);
 * - `READ_EXTERNAL_STORAGE`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO` and
 *   `READ_MEDIA_VISUAL_USER_SELECTED` → `photos` (a selected-photos grant is `denied` for the
 *   two full-access names).
 *
 * Every other permission (Bluetooth, SMS, phone, sensors, …) has no web-view equivalent:
 * `check` resolves `false` and `request` `"denied"`. So does a permission whose plugin is not
 * installed (see `denext mobile add`). A refused permission the OS will not prompt for again is
 * `"never_ask_again"`; `Linking.openSettings()` opens the app's settings page.
 *
 * `request(permission, rationale)` shows `rationale` first when Android reports the user
 * refused once (`prompt-with-rationale`), then prompts once any of its buttons is pressed, as
 * React Native does. `requestMultiple` prompts for each permission in turn.
 *
 * @example
 * ```ts
 * import { PermissionsAndroid } from "react-native";
 *
 * const status = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
 *   title: "Camera",
 *   message: "Scan receipts with the camera.",
 *   buttonPositive: "Continue",
 * });
 * if (status === PermissionsAndroid.RESULTS.GRANTED) openScanner();
 * ```
 */
export const PermissionsAndroid: PermissionsAndroidStatic = {
  PERMISSIONS: ANDROID_PERMISSIONS,
  RESULTS: { DENIED: "denied", GRANTED: "granted", NEVER_ASK_AGAIN: "never_ask_again" },
  async check(permission) {
    return statusOf(permission, await stateOf(PERMISSION_NAMES[permission], false)) === "granted";
  },
  checkPermission(permission) {
    return PermissionsAndroid.check(permission);
  },
  request(permission, rationale) {
    return requestOne(permission, rationale);
  },
  async requestPermission(permission, rationale) {
    return (await requestOne(permission, rationale)) === "granted";
  },
  async requestMultiple(permissions) {
    const out: Record<string, PermissionStatus> = {};
    const asked = new Map<PermissionName, PermissionState | undefined>();
    for (const permission of permissions) {
      const name = PERMISSION_NAMES[permission];
      if (name && !asked.has(name)) asked.set(name, await stateOf(name, true));
      out[permission] = statusOf(permission, name ? asked.get(name) : undefined);
    }
    return out as { [permission in Permission]: PermissionStatus };
  },
};
