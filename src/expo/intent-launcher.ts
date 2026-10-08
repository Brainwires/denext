/**
 * `expo-intent-launcher` for denext: Android intents from the Capacitor shell, through
 * `@capgo/capacitor-intent-launcher` (`denext mobile add intent-launcher`), whose
 * `startActivityAsync` takes Expo's parameters and returns Expo's result. `openApplication` and
 * `getApplicationIconAsync` go through the same plugin.
 *
 * Android only, as in Expo: in the iOS shell and on the web every call throws or rejects with
 * `ERR_UNAVAILABLE` (open an iOS settings screen with `denext/mobile`'s `openAppSettings()`).
 *
 * @example
 * ```ts
 * import { ActivityAction, startActivityAsync } from "denext/expo/intent-launcher";
 *
 * await startActivityAsync(ActivityAction.LOCATION_SOURCE_SETTINGS);
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { unavailable } from "./internal/common.ts";

/** The intent actions Expo names (any other action string works too). */
export enum ActivityAction {
  ACCESSIBILITY_COLOR_CONTRAST_SETTINGS = "android.settings.ACCESSIBILITY_COLOR_CONTRAST_SETTINGS",
  ACCESSIBILITY_COLOR_MOTION_SETTINGS = "android.settings.ACCESSIBILITY_COLOR_MOTION_SETTINGS",
  ACCESSIBILITY_COLOR_SPACE_SETTINGS = "com.android.settings.ACCESSIBILITY_COLOR_SPACE_SETTINGS",
  ACCESSIBILITY_DETAILS_SETTINGS = "android.settings.ACCESSIBILITY_DETAILS_SETTINGS",
  ACCESSIBILITY_SETTINGS = "android.settings.ACCESSIBILITY_SETTINGS",
  ACCESSIBILITY_SETTINGS_FOR_SUW = "android.settings.ACCESSIBILITY_SETTINGS_FOR_SUW",
  ACCESSIBILITY_SHORTCUT_SETTINGS = "android.settings.ACCESSIBILITY_SHORTCUT_SETTINGS",
  ACCOUNT_SYNC_SETTINGS = "android.settings.ACCOUNT_SYNC_SETTINGS",
  ADAPTIVE_BRIGHTNESS_SETTINGS = "android.settings.ADAPTIVE_BRIGHTNESS_SETTINGS",
  ADD_ACCOUNT_SETTINGS = "android.settings.ADD_ACCOUNT_SETTINGS",
  ADVANCED_CONNECTED_DEVICE_SETTINGS = "com.android.settings.ADVANCED_CONNECTED_DEVICE_SETTINGS",
  ADVANCED_MEMORY_PROTECTION_SETTINGS = "android.settings.ADVANCED_MEMORY_PROTECTION_SETTINGS",
  AIRPLANE_MODE_SETTINGS = "android.settings.AIRPLANE_MODE_SETTINGS",
  ALL_APPS_NOTIFICATION_SETTINGS = "android.settings.ALL_APPS_NOTIFICATION_SETTINGS",
  ALL_APPS_NOTIFICATION_SETTINGS_FOR_REVIEW =
    "android.settings.ALL_APPS_NOTIFICATION_SETTINGS_FOR_REVIEW",
  APN_SETTINGS = "android.settings.APN_SETTINGS",
  APP_LOCALE_SETTINGS = "android.settings.APP_LOCALE_SETTINGS",
  APP_MEMORY_USAGE = "android.settings.APP_MEMORY_USAGE",
  APP_NOTIFICATION_BUBBLE_SETTINGS = "android.settings.APP_NOTIFICATION_BUBBLE_SETTINGS",
  APP_NOTIFICATION_REDACTION = "android.settings.ACTION_APP_NOTIFICATION_REDACTION",
  APP_NOTIFICATION_SETTINGS = "android.settings.APP_NOTIFICATION_SETTINGS",
  APP_OPEN_BY_DEFAULT_SETTINGS = "android.settings.APP_OPEN_BY_DEFAULT_SETTINGS",
  APP_STORAGE_SETTINGS = "com.android.settings.APP_STORAGE_SETTINGS",
  APPLICATION_DETAILS_SETTINGS = "android.settings.APPLICATION_DETAILS_SETTINGS",
  APPLICATION_DEVELOPMENT_SETTINGS = "android.settings.APPLICATION_DEVELOPMENT_SETTINGS",
  APPLICATION_SETTINGS = "android.settings.APPLICATION_SETTINGS",
  AUDIO_STREAM_DIALOG = "android.settings.AUDIO_STREAM_DIALOG",
  AUTO_ROTATE_SETTINGS = "android.settings.AUTO_ROTATE_SETTINGS",
  AUTOMATIC_ZEN_RULE_SETTINGS = "android.settings.AUTOMATIC_ZEN_RULE_SETTINGS",
  BACKUP_SETTINGS = "com.android.settings.BACKUP_SETTINGS",
  BATTERY_POWER_USAGE_ADVANCED = "com.android.settings.battery.action.POWER_USAGE_ADVANCED",
  BATTERY_SAVER_SCHEDULE_SETTINGS = "com.android.settings.BATTERY_SAVER_SCHEDULE_SETTINGS",
  BATTERY_SAVER_SETTINGS = "android.settings.BATTERY_SAVER_SETTINGS",
  BIOMETRIC_ENROLL = "android.settings.BIOMETRIC_ENROLL",
  BIOMETRIC_SETTINGS_PROVIDER = "com.android.settings.biometrics.BIOMETRIC_SETTINGS_PROVIDER",
  BLUETOOTH_AUDIO_SHARING_SETTINGS = "com.android.settings.BLUETOOTH_AUDIO_SHARING_SETTINGS",
  BLUETOOTH_DASHBOARD_SETTINGS = "android.settings.BLUETOOTH_DASHBOARD_SETTINGS",
  BLUETOOTH_DEVICE_DETAIL_SETTINGS = "com.android.settings.BLUETOOTH_DEVICE_DETAIL_SETTINGS",
  BLUETOOTH_LE_AUDIO_QR_CODE_SCANNER = "android.settings.BLUETOOTH_LE_AUDIO_QR_CODE_SCANNER",
  BLUETOOTH_PAIRING_SETTINGS = "android.settings.BLUETOOTH_PAIRING_SETTINGS",
  BLUETOOTH_SETTINGS = "android.settings.BLUETOOTH_SETTINGS",
  BLUTOOTH_FIND_BROADCASTS_ACTIVITY = "android.settings.BLUTOOTH_FIND_BROADCASTS_ACTIVITY",
  BUGREPORT_HANDLER_SETTINGS = "android.settings.BUGREPORT_HANDLER_SETTINGS",
  BUTTON_NAVIGATION_SETTINGS = "com.android.settings.BUTTON_NAVIGATION_SETTINGS",
  CAPTIONING_SETTINGS = "android.settings.CAPTIONING_SETTINGS",
  CAST_SETTINGS = "android.settings.CAST_SETTINGS",
  CELLULAR_NETWORK_SECURITY = "android.settings.CELLULAR_NETWORK_SECURITY",
  CHANNEL_NOTIFICATION_SETTINGS = "android.settings.CHANNEL_NOTIFICATION_SETTINGS",
  COLOR_INVERSION_SETTINGS = "android.settings.COLOR_INVERSION_SETTINGS",
  COMBINED_BIOMETRICS_SETTINGS = "android.settings.COMBINED_BIOMETRICS_SETTINGS",
  COMMUNAL_SETTINGS = "android.settings.COMMUNAL_SETTINGS",
  CONDITION_PROVIDER_SETTINGS = "android.settings.ACTION_CONDITION_PROVIDER_SETTINGS",
  CONVERSATION_SETTINGS = "android.settings.CONVERSATION_SETTINGS",
  CREDENTIAL_PROVIDER = "android.settings.CREDENTIAL_PROVIDER",
  DARK_THEME_SETTINGS = "android.settings.DARK_THEME_SETTINGS",
  DATA_ROAMING_SETTINGS = "android.settings.DATA_ROAMING_SETTINGS",
  DATA_SAVER_SETTINGS = "android.settings.DATA_SAVER_SETTINGS",
  DATA_USAGE_SETTINGS = "android.settings.DATA_USAGE_SETTINGS",
  DATE_SETTINGS = "android.settings.DATE_SETTINGS",
  DEVELOPMENT_START_DSU_LOADER = "android.settings.development.START_DSU_LOADER",
  DEVICE_INFO_SETTINGS = "android.settings.DEVICE_INFO_SETTINGS",
  DEVICE_NAME = "android.settings.DEVICE_NAME",
  DISPLAY_SETTINGS = "android.settings.DISPLAY_SETTINGS",
  DREAM_SETTINGS = "android.settings.DREAM_SETTINGS",
  ENTERPRISE_PRIVACY_SETTINGS = "android.settings.ENTERPRISE_PRIVACY_SETTINGS",
  FACE_ENROLL = "android.settings.FACE_ENROLL",
  FACE_SETTINGS = "android.settings.FACE_SETTINGS",
  FACTORY_RESET = "com.android.settings.action.FACTORY_RESET",
  FINGERPRINT_ENROLL = "android.settings.FINGERPRINT_ENROLL",
  FINGERPRINT_SETTINGS = "android.settings.FINGERPRINT_SETTINGS",
  FINGERPRINT_SETTINGS_V2 = "android.settings.FINGERPRINT_SETTINGS_V2",
  FINGERPRINT_SETUP = "android.settings.FINGERPRINT_SETUP",
  FIRST_DAY_OF_WEEK_SETTINGS = "android.settings.FIRST_DAY_OF_WEEK_SETTINGS",
  GESTURE_NAVIGATION_SETTINGS = "com.android.settings.GESTURE_NAVIGATION_SETTINGS",
  HARD_KEYBOARD_LAYOUT_PICKER_SETTINGS = "android.settings.HARD_KEYBOARD_LAYOUT_PICKER_SETTINGS",
  HARD_KEYBOARD_SETTINGS = "android.settings.HARD_KEYBOARD_SETTINGS",
  HEARING_DEVICES_PAIRING_SETTINGS = "android.settings.HEARING_DEVICES_PAIRING_SETTINGS",
  HEARING_DEVICES_SETTINGS = "android.settings.HEARING_DEVICES_SETTINGS",
  HOME_SETTINGS = "android.settings.HOME_SETTINGS",
  IA_SETTINGS = "com.android.settings.action.IA_SETTINGS",
  IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS =
    "android.settings.IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS",
  IGNORE_BATTERY_OPTIMIZATION_SETTINGS = "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS",
  INPUT_METHOD_SETTINGS = "android.settings.INPUT_METHOD_SETTINGS",
  INPUT_METHOD_SUBTYPE_SETTINGS = "android.settings.INPUT_METHOD_SUBTYPE_SETTINGS",
  INTERNAL_STORAGE_SETTINGS = "android.settings.INTERNAL_STORAGE_SETTINGS",
  LANGUAGE_SETTINGS = "android.settings.LANGUAGE_SETTINGS",
  LICENSE = "android.settings.LICENSE",
  LOCALE_SETTINGS = "android.settings.LOCALE_SETTINGS",
  LOCATION_SCANNING_SETTINGS = "android.settings.LOCATION_SCANNING_SETTINGS",
  LOCATION_SOURCE_SETTINGS = "android.settings.LOCATION_SOURCE_SETTINGS",
  LOCK_SCREEN_SETTINGS = "android.settings.LOCK_SCREEN_SETTINGS",
  MANAGE_ADAPTIVE_NOTIFICATIONS = "android.settings.MANAGE_ADAPTIVE_NOTIFICATIONS",
  MANAGE_ALL_APPLICATIONS_SETTINGS = "android.settings.MANAGE_ALL_APPLICATIONS_SETTINGS",
  MANAGE_ALL_FILES_ACCESS_PERMISSION = "android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION",
  MANAGE_ALL_SIM_PROFILES_SETTINGS = "android.settings.MANAGE_ALL_SIM_PROFILES_SETTINGS",
  MANAGE_APP_ALL_FILES_ACCESS_PERMISSION =
    "android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION",
  MANAGE_APP_LONG_RUNNING_JOBS = "android.settings.MANAGE_APP_LONG_RUNNING_JOBS",
  MANAGE_APP_OVERLAY_PERMISSION = "android.settings.MANAGE_APP_OVERLAY_PERMISSION",
  MANAGE_APP_USE_FULL_SCREEN_INTENT = "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT",
  MANAGE_APPLICATIONS_SETTINGS = "android.settings.MANAGE_APPLICATIONS_SETTINGS",
  MANAGE_CLONED_APPS_SETTINGS = "android.settings.MANAGE_CLONED_APPS_SETTINGS",
  MANAGE_CROSS_PROFILE_ACCESS = "android.settings.MANAGE_CROSS_PROFILE_ACCESS",
  MANAGE_DEFAULT_APPS_SETTINGS = "android.settings.MANAGE_DEFAULT_APPS_SETTINGS",
  MANAGE_DOMAIN_URLS = "android.settings.MANAGE_DOMAIN_URLS",
  MANAGE_OVERLAY_PERMISSION = "android.settings.action.MANAGE_OVERLAY_PERMISSION",
  MANAGE_UNKNOWN_APP_SOURCES = "android.settings.MANAGE_UNKNOWN_APP_SOURCES",
  MANAGE_USER_ASPECT_RATIO_SETTINGS = "android.settings.MANAGE_USER_ASPECT_RATIO_SETTINGS",
  MANAGE_WRITE_SETTINGS = "android.settings.action.MANAGE_WRITE_SETTINGS",
  MANAGED_PROFILE_SETTINGS = "android.settings.MANAGED_PROFILE_SETTINGS",
  MEDIA_BROADCAST_DIALOG = "android.settings.MEDIA_BROADCAST_DIALOG",
  MEDIA_CONTROLS_SETTINGS = "android.settings.ACTION_MEDIA_CONTROLS_SETTINGS",
  MEMORY_CARD_SETTINGS = "android.settings.MEMORY_CARD_SETTINGS",
  MMS_MESSAGE_SETTING = "android.settings.MMS_MESSAGE_SETTING",
  MOBILE_DATA_USAGE = "android.settings.MOBILE_DATA_USAGE",
  MOBILE_NETWORK_LIST = "android.settings.MOBILE_NETWORK_LIST",
  MODULE_LICENSES = "android.settings.MODULE_LICENSES",
  MONITORING_CERT_INFO = "com.android.settings.MONITORING_CERT_INFO",
  MORE_SECURITY_PRIVACY_SETTINGS = "com.android.settings.MORE_SECURITY_PRIVACY_SETTINGS",
  NAVIGATION_MODE_SETTINGS = "com.android.settings.NAVIGATION_MODE_SETTINGS",
  NETWORK_OPERATOR_SETTINGS = "android.settings.NETWORK_OPERATOR_SETTINGS",
  NETWORK_PROVIDER_SETTINGS = "android.settings.NETWORK_PROVIDER_SETTINGS",
  NFC_SETTINGS = "android.settings.NFC_SETTINGS",
  NIGHT_DISPLAY_SETTINGS = "android.settings.NIGHT_DISPLAY_SETTINGS",
  NOTIFICATION_ASSISTANT_SETTINGS = "android.settings.NOTIFICATION_ASSISTANT_SETTINGS",
  NOTIFICATION_HISTORY = "android.settings.NOTIFICATION_HISTORY",
  NOTIFICATION_LISTENER_DETAIL_SETTINGS = "android.settings.NOTIFICATION_LISTENER_DETAIL_SETTINGS",
  NOTIFICATION_LISTENER_SETTINGS = "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS",
  NOTIFICATION_POLICY_ACCESS_DETAIL_SETTINGS =
    "android.settings.NOTIFICATION_POLICY_ACCESS_DETAIL_SETTINGS",
  NOTIFICATION_POLICY_ACCESS_SETTINGS = "android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS",
  NOTIFICATION_SETTINGS = "android.settings.NOTIFICATION_SETTINGS",
  ONE_HANDED_SETTINGS = "android.settings.action.ONE_HANDED_SETTINGS",
  OPEN_PRIVATE_SPACE_SETTINGS = "com.android.settings.action.OPEN_PRIVATE_SPACE_SETTINGS",
  OTHER_SOUND_SETTINGS = "android.settings.ACTION_OTHER_SOUND_SETTINGS",
  PANEL_INTERNET_CONNECTIVITY = "android.settings.panel.action.INTERNET_CONNECTIVITY",
  PANEL_NFC = "android.settings.panel.action.NFC",
  PANEL_VOLUME = "android.settings.panel.action.VOLUME",
  PANEL_WIFI = "android.settings.panel.action.WIFI",
  PICTURE_IN_PICTURE_SETTINGS = "android.settings.PICTURE_IN_PICTURE_SETTINGS",
  POWER_MENU_SETTINGS = "android.settings.ACTION_POWER_MENU_SETTINGS",
  PREMIUM_SMS_SETTINGS = "android.settings.PREMIUM_SMS_SETTINGS",
  PREVIOUSLY_CONNECTED_DEVICE = "com.android.settings.PREVIOUSLY_CONNECTED_DEVICE",
  PRINT_SETTINGS = "android.settings.ACTION_PRINT_SETTINGS",
  PRIVACY_ADVANCED_SETTINGS = "android.settings.PRIVACY_ADVANCED_SETTINGS",
  PRIVACY_CONTROLS = "android.settings.PRIVACY_CONTROLS",
  PRIVACY_SETTINGS = "android.settings.PRIVACY_SETTINGS",
  PROCESS_WIFI_EASY_CONNECT_URI = "android.settings.PROCESS_WIFI_EASY_CONNECT_URI",
  REDUCE_BRIGHT_COLORS_SETTINGS = "android.settings.REDUCE_BRIGHT_COLORS_SETTINGS",
  REGIONAL_PREFERENCES_SETTINGS = "android.settings.REGIONAL_PREFERENCES_SETTINGS",
  REMOTE_AUTHENTICATOR_ENROLL = "android.settings.REMOTE_AUTHENTICATOR_ENROLL",
  REQUEST_ENABLE_CONTENT_CAPTURE = "android.settings.REQUEST_ENABLE_CONTENT_CAPTURE",
  REQUEST_IGNORE_BATTERY_OPTIMIZATIONS = "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  REQUEST_MANAGE_MEDIA = "android.settings.REQUEST_MANAGE_MEDIA",
  REQUEST_MEDIA_ROUTING_CONTROL = "android.settings.REQUEST_MEDIA_ROUTING_CONTROL",
  REQUEST_SCHEDULE_EXACT_ALARM = "android.settings.REQUEST_SCHEDULE_EXACT_ALARM",
  REQUEST_SET_AUTOFILL_SERVICE = "android.settings.REQUEST_SET_AUTOFILL_SERVICE",
  SATELLITE_SETTING = "android.settings.SATELLITE_SETTING",
  SCREEN_TIMEOUT_SETTINGS = "android.settings.SCREEN_TIMEOUT_SETTINGS",
  SEARCH_RESULT_TRAMPOLINE = "com.android.settings.SEARCH_RESULT_TRAMPOLINE",
  SECURITY_ADVANCED_SETTINGS = "com.android.settings.security.SECURITY_ADVANCED_SETTINGS",
  SECURITY_SETTINGS = "android.settings.SECURITY_SETTINGS",
  SETTINGS = "android.settings.SETTINGS",
  SETTINGS_EMBED_DEEP_LINK_ACTIVITY = "android.settings.SETTINGS_EMBED_DEEP_LINK_ACTIVITY",
  SETUP_LOCK_SCREEN = "com.android.settings.SETUP_LOCK_SCREEN",
  SHOW_ADMIN_SUPPORT_DETAILS = "android.settings.SHOW_ADMIN_SUPPORT_DETAILS",
  SHOW_MANUAL = "android.settings.SHOW_MANUAL",
  SHOW_REGULATORY_INFO = "android.settings.SHOW_REGULATORY_INFO",
  SHOW_REMOTE_BUGREPORT_DIALOG = "android.settings.SHOW_REMOTE_BUGREPORT_DIALOG",
  SHOW_RESTRICTED_SETTING_DIALOG = "android.settings.SHOW_RESTRICTED_SETTING_DIALOG",
  SIM_PREFERENCE_SETTINGS = "android.settings.SIM_PREFERENCE_SETTINGS",
  SIM_SUB_INFO_SETTINGS = "com.android.settings.sim.SIM_SUB_INFO_SETTINGS",
  SOUND_SETTINGS = "android.settings.SOUND_SETTINGS",
  SPA_SEARCH_LANDING = "android.settings.SPA_SEARCH_LANDING",
  STORAGE_MANAGER_SETTINGS = "android.settings.STORAGE_MANAGER_SETTINGS",
  STYLUS_USI_DETAILS_SETTINGS = "com.android.settings.STYLUS_USI_DETAILS_SETTINGS",
  SUGGESTION_STATE_PROVIDER = "com.android.settings.action.SUGGESTION_STATE_PROVIDER",
  SUPPORT_SETTINGS = "com.android.settings.action.SUPPORT_SETTINGS",
  SYNC_SETTINGS = "android.settings.SYNC_SETTINGS",
  TEMPERATURE_UNIT_SETTINGS = "android.settings.TEMPERATURE_UNIT_SETTINGS",
  TETHER_PROVISIONING_UI = "android.settings.TETHER_PROVISIONING_UI",
  TETHER_SETTINGS = "android.settings.TETHER_SETTINGS",
  TETHER_UNSUPPORTED_CARRIER_UI = "android.settings.TETHER_UNSUPPORTED_CARRIER_UI",
  TEXT_READING_SETTINGS = "android.settings.TEXT_READING_SETTINGS",
  TRUSTED_CREDENTIALS = "com.android.settings.TRUSTED_CREDENTIALS",
  TRUSTED_CREDENTIALS_USER = "com.android.settings.TRUSTED_CREDENTIALS_USER",
  TTS_SETTINGS = "com.android.settings.TTS_SETTINGS",
  TURN_SCREEN_ON_SETTINGS = "android.settings.TURN_SCREEN_ON_SETTINGS",
  USAGE_ACCESS_SETTINGS = "android.settings.USAGE_ACCESS_SETTINGS",
  USER_DICTIONARY_INSERT = "android.settings.USER_DICTIONARY_INSERT",
  USER_DICTIONARY_SETTINGS = "android.settings.USER_DICTIONARY_SETTINGS",
  USER_SETTINGS = "android.settings.USER_SETTINGS",
  VIEW_ADVANCED_POWER_USAGE_DETAIL = "android.settings.VIEW_ADVANCED_POWER_USAGE_DETAIL",
  VOICE_CONTROL_AIRPLANE_MODE = "android.settings.VOICE_CONTROL_AIRPLANE_MODE",
  VOICE_CONTROL_BATTERY_SAVER_MODE = "android.settings.VOICE_CONTROL_BATTERY_SAVER_MODE",
  VOICE_CONTROL_DO_NOT_DISTURB_MODE = "android.settings.VOICE_CONTROL_DO_NOT_DISTURB_MODE",
  VOICE_INPUT_SETTINGS = "android.settings.VOICE_INPUT_SETTINGS",
  VPN_SETTINGS = "android.settings.VPN_SETTINGS",
  VR_LISTENER_SETTINGS = "android.settings.VR_LISTENER_SETTINGS",
  WALLPAPER_SETTINGS = "android.settings.WALLPAPER_SETTINGS",
  WEBVIEW_SETTINGS = "android.settings.WEBVIEW_SETTINGS",
  WIFI_ADD_NETWORKS = "android.settings.WIFI_ADD_NETWORKS",
  WIFI_CALLING_SETTINGS = "android.settings.WIFI_CALLING_SETTINGS",
  WIFI_DETAILS_SETTINGS = "android.settings.WIFI_DETAILS_SETTINGS",
  WIFI_DIALOG = "com.android.settings.WIFI_DIALOG",
  WIFI_DPP_CONFIGURATOR_AUTH_QR_CODE_GENERATOR =
    "android.settings.WIFI_DPP_CONFIGURATOR_AUTH_QR_CODE_GENERATOR",
  WIFI_DPP_CONFIGURATOR_QR_CODE_GENERATOR =
    "android.settings.WIFI_DPP_CONFIGURATOR_QR_CODE_GENERATOR",
  WIFI_DPP_CONFIGURATOR_QR_CODE_SCANNER = "android.settings.WIFI_DPP_CONFIGURATOR_QR_CODE_SCANNER",
  WIFI_DPP_ENROLLEE_QR_CODE_SCANNER = "android.settings.WIFI_DPP_ENROLLEE_QR_CODE_SCANNER",
  WIFI_IP_SETTINGS = "android.settings.WIFI_IP_SETTINGS",
  WIFI_NETWORK_REQUEST = "com.android.settings.wifi.action.NETWORK_REQUEST",
  WIFI_SAVED_NETWORK_SETTINGS = "android.settings.WIFI_SAVED_NETWORK_SETTINGS",
  WIFI_SCANNING_SETTINGS = "android.settings.WIFI_SCANNING_SETTINGS",
  WIFI_SETTINGS = "android.settings.WIFI_SETTINGS",
  WIFI_TETHER_SETTINGS = "com.android.settings.WIFI_TETHER_SETTINGS",
  WIRELESS_SETTINGS = "android.settings.WIRELESS_SETTINGS",
  ZEN_MODE_AUTOMATION_SETTINGS = "android.settings.ZEN_MODE_AUTOMATION_SETTINGS",
  ZEN_MODE_EVENT_RULE_SETTINGS = "android.settings.ZEN_MODE_EVENT_RULE_SETTINGS",
  ZEN_MODE_PRIORITY_SETTINGS = "android.settings.ZEN_MODE_PRIORITY_SETTINGS",
  ZEN_MODE_SCHEDULE_RULE_SETTINGS = "android.settings.ZEN_MODE_SCHEDULE_RULE_SETTINGS",
  ZEN_MODE_SETTINGS = "android.settings.ZEN_MODE_SETTINGS",
}

/** Extra intent parameters. */
export interface IntentLauncherParams {
  /** The MIME type of the data. */
  type?: string;
  /** The category. */
  category?: string;
  /** Extras (`putExtra`). */
  // deno-lint-ignore no-explicit-any
  extra?: Record<string, any>;
  /** The data URI. */
  data?: string;
  /** Intent flags. */
  flags?: number;
  /** The package of the component to start. */
  packageName?: string;
  /** The class of the component to start (with `packageName`). */
  className?: string;
}

/** What the started activity returned. */
export interface IntentLauncherResult {
  /** Its result code. */
  resultCode: ResultCode;
  /** The data URI it returned. */
  data?: string;
  /** The extras it returned. */
  extra?: object;
}

/** An activity's result code. */
export enum ResultCode {
  /** `RESULT_OK`. */
  Success = -1,
  /** `RESULT_CANCELED`. */
  Canceled = 0,
  /** `RESULT_FIRST_USER`. */
  FirstUser = 1,
}

/** `@capgo/capacitor-intent-launcher`, the calls used here. */
interface IntentLauncherPlugin {
  startActivityAsync(
    options: IntentLauncherParams & { action: string },
  ): Promise<{ resultCode: number; data?: string; extra?: Record<string, unknown> }>;
  openApplication(options: { packageName: string }): Promise<void>;
  getApplicationIconAsync(options: { packageName: string }): Promise<{ icon: string }>;
}

/** Why a call is unavailable here. */
const ANDROID_ONLY = "Intents exist in the Android shell only (`denext mobile add " +
  "intent-launcher`); on iOS open settings with denext/mobile's openAppSettings().";

/** The Android shell's plugin, or undefined elsewhere. */
function launcher(): IntentLauncherPlugin | undefined {
  if (nativePlatform() !== "android") return undefined;
  return nativePlugin<IntentLauncherPlugin>("IntentLauncher", [
    "startActivityAsync",
    "openApplication",
    "getApplicationIconAsync",
  ]);
}

/**
 * Start an activity for `activityAction` and wait for its result.
 *
 * @param activityAction An {@linkcode ActivityAction} or any intent action string.
 * @param params The data, type, category, extras, flags and component.
 * @returns The activity's result.
 * @throws `TypeError` for an empty action; `ERR_UNAVAILABLE` off the Android shell.
 */
export async function startActivityAsync(
  activityAction: ActivityAction | string,
  params: IntentLauncherParams = {},
): Promise<IntentLauncherResult> {
  if (!activityAction || typeof activityAction !== "string") {
    throw new TypeError("'activityAction' argument must be a non-empty string!");
  }
  const plugin = launcher();
  if (!plugin) throw unavailable("expo-intent-launcher", "startActivityAsync", ANDROID_ONLY);
  const result = await plugin.startActivityAsync({ ...params, action: activityAction });
  return {
    resultCode: result.resultCode as ResultCode,
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.extra !== undefined ? { extra: result.extra } : {}),
  };
}

/**
 * Open the app with `packageName` (its launch activity).
 *
 * @param packageName The Android package (`com.google.android.gm`).
 * @throws `ERR_UNAVAILABLE` off the Android shell.
 */
export function openApplication(packageName: string): void {
  const plugin = launcher();
  if (!plugin) throw unavailable("expo-intent-launcher", "openApplication", ANDROID_ONLY);
  plugin.openApplication({ packageName }).catch((err) =>
    console.warn(`denext/expo: openApplication(${packageName}) failed: ${err}`)
  );
}

/**
 * The icon of the app with `packageName`.
 *
 * @param packageName The Android package.
 * @returns A `data:image/png;base64,` URL, or `""` when there is none.
 * @throws `ERR_UNAVAILABLE` off the Android shell.
 */
export async function getApplicationIconAsync(packageName: string): Promise<string> {
  const plugin = launcher();
  if (!plugin) throw unavailable("expo-intent-launcher", "getApplicationIconAsync", ANDROID_ONLY);
  return (await plugin.getApplicationIconAsync({ packageName })).icon ?? "";
}
