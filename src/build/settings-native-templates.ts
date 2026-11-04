// The native half of `openAppSettings()` (denext/mobile), embedded as text so it ships inside the
// JSR package: `denext mobile add permissions` (and every capability that asks for a permission:
// local-notifications, biometrics, geolocation) writes it into a Capacitor project.
//
// - iOS: `ios/App/App/DenextSettingsPlugin.swift`, registered by `DenextBridgeViewController`.
//   `open()` opens `UIApplication.openSettingsURLString`: the app's own page in Settings.
// - Android: `dev/denext/settings/DenextSettingsPlugin.java`, registered from `MainActivity`.
//   `open()` starts `Settings.ACTION_APPLICATION_DETAILS_SETTINGS` for the app's package;
//   `sendIntent({ action, extras? })` starts an activity for any intent action, the native half of
//   React Native mode's `Linking.sendIntent()` (React Native's `IntentModule.sendIntent`: extras
//   are `{ key, value }` with a string, number (put as a double) or boolean value).
//
// - Both: `deliveredNotifications()` lists what the notification centre shows for the app (local
//   notifications and remote pushes alike: iOS `UNUserNotificationCenter.getDeliveredNotifications`,
//   Android `NotificationManager.getActiveNotifications`) as `{ id, tag?, threadId?, title?, data?,
//   summary? }`, and `removeDeliveredNotifications({ notifications: [{ id, tag? }] })` removes
//   them; `deliveredNotifications` / `removeDeliveredNotifications` in denext/mobile select by id,
//   thread or tag in JavaScript. `local-notifications` and `push` install the plugin for these.
//
// - Both: `biometricSecretSet` / `biometricSecretGet` / `biometricSecretDelete`, the native half of
//   `secureStore.set(key, value, { requireBiometric: true })`: the OS enforces the biometric gate
//   (iOS: a Keychain item whose `SecAccessControl` is `.biometryCurrentSet` or the passcode, read
//   with an evaluated `LAContext`; Android 9+: an AES-GCM-sealed value whose key is wrapped by an
//   Android Keystore key pair requiring user authentication, unwrapped through a `BiometricPrompt`
//   `CryptoObject`). `biometrics` installs the plugin.
//
// Generation 2 added `sendIntent` (Android), generation 3 the delivered-notification methods,
// generation 4 the biometric secrets; an unedited older file is upgraded, and each bump keeps an
// older denext from rewriting the methods away.
//
// Edit these as source in native-templates/settings.ts:
// they are compiled only in an app (against Capacitor 8). Every `\``
// there is an escaped template-literal character.
//
// Every file is written through `renderSettingsTemplate`, which puts a marker line on top: the
// template generation and the SHA-256 of the rest of the file. A file whose marker still
// matches its body is an unedited denext template and is upgraded in place by a later run; an
// edited one is kept. Bump SETTINGS_TEMPLATE_VERSION when the templates change.
//
// The template texts ship packed: native-templates/settings.ts (the readable source, not published)
// is packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/** The generation of the templates, stamped into every file the installer writes. */
export const SETTINGS_TEMPLATE_VERSION = 4;

/**
 * A template as the installer writes it: a first line
 * `// denext-settings-template: <SETTINGS_TEMPLATE_VERSION> sha256=<hex>` (the SHA-256 of
 * everything after that line), then the template.
 *
 * @param template The template text.
 * @returns The file content.
 */
export function renderSettingsTemplate(template: string): Promise<string> {
  return renderMarkedTemplate("settings", SETTINGS_TEMPLATE_VERSION, template);
}

/**
 * Whether `text` is an unedited settings template: its marker line matches its body.
 *
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineSettingsTemplate(text: string): Promise<boolean> {
  return await markedTemplateIntact("settings", text) === true;
}

/** The iOS files, for `ios/App/App/`. */
export const SETTINGS_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.settings.SETTINGS_IOS_FILES;

/** The Android files, for `android/app/src/main/java/dev/denext/settings/`. */
export const SETTINGS_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.settings.SETTINGS_ANDROID_FILES;
