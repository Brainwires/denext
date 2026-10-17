/**
 * `expo-brightness` for denext: the screen brightness in the Capacitor shell, through
 * `@capacitor-community/screen-brightness` and denext's `DenextBrightness` plugin beside it
 * (both installed by `denext mobile add brightness`). As in Expo, iOS sets the screen's
 * brightness while the app runs and Android sets the app window's.
 *
 * - Off Android (iOS and the web) the calls behave as Expo's do there: the system brightness is
 *   the screen's (`get/setSystemBrightnessAsync` are `get/setBrightnessAsync`), and the
 *   Android-only calls resolve: `restoreSystemBrightnessAsync` and
 *   `setSystemBrightnessModeAsync` do nothing, `isUsingSystemBrightnessAsync` is `false` and
 *   `getSystemBrightnessModeAsync` is `BrightnessMode.UNKNOWN`.
 * - On Android `restoreSystemBrightnessAsync` lets the window follow the system again, and the
 *   system setting and its mode are read and written through `DenextBrightness`. Writing needs
 *   `WRITE_SETTINGS`, which the user grants in the settings screen `requestPermissionsAsync()`
 *   opens (as in Expo); setting the system level switches the mode to manual first, and setting
 *   the mode to `UNKNOWN` is a no-op. A shell without `DenextBrightness` (a project that ran
 *   `mobile add brightness` before denext added it) rejects those with `ERR_UNAVAILABLE`.
 * - On Android `getBrightnessAsync()` reads the system level while the window follows it (`-1`
 *   without `DenextBrightness`).
 * - `addBrightnessListener` fires on iOS when the screen's brightness changes (as in Expo, it
 *   is iOS only).
 *
 * Outside the shell `isAvailableAsync()` is `false`, the level calls reject with
 * `ERR_UNAVAILABLE` and the permission is `undetermined`, as on Expo's web build.
 *
 * @example
 * ```ts
 * import * as Brightness from "denext/expo/brightness";
 *
 * await Brightness.setBrightnessAsync(1); // full brightness for a QR code
 * await Brightness.restoreSystemBrightnessAsync();
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "../mobile/plugin.ts";
import {
  createEmitter,
  createPermissionHook,
  NOT_NEEDED_PERMISSION,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
  type Subscription,
  unavailable,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionHookOptions, PermissionResponse, Subscription };

/** How the system sets the brightness (Android). */
export enum BrightnessMode {
  /** Unknown. */
  UNKNOWN = 0,
  /** Adaptive brightness. */
  AUTOMATIC = 1,
  /** Set by the user. */
  MANUAL = 2,
}

/** What a brightness listener receives. */
export interface BrightnessEvent {
  /** The new level, 0–1. */
  brightness: number;
}

/** `@capacitor-community/screen-brightness`. */
interface ScreenBrightnessPlugin {
  setBrightness(options: { brightness: number }): Promise<void>;
  getBrightness(): Promise<{ brightness: number }>;
}

/** denext's `DenextBrightness` (the system setting on Android, change events on iOS). */
interface DenextBrightnessPlugin {
  getSystemBrightness(): Promise<{ value: number }>;
  setSystemBrightness(options: { value: number }): Promise<void>;
  getSystemBrightnessMode(): Promise<{ mode: "automatic" | "manual" }>;
  setSystemBrightnessMode(options: { mode: "automatic" | "manual" }): Promise<void>;
  checkWriteSettings(): Promise<{ granted: boolean }>;
  requestWriteSettings(): Promise<{ granted: boolean }>;
  addListener(
    eventName: "brightnessChanged",
    listener: (event: BrightnessEvent) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** Why a call is unavailable outside the shell. */
const SHELL_ONLY = "It sets the screen brightness in the Capacitor shell (`denext mobile add " +
  "brightness`).";

/** The shell's plugin, or undefined. */
function plugin(): ScreenBrightnessPlugin | undefined {
  return nativePlugin<ScreenBrightnessPlugin>("ScreenBrightness", [
    "setBrightness",
    "getBrightness",
  ]);
}

/** The shell's plugin, or an `ERR_UNAVAILABLE` rejection naming `call`. */
function required(call: string): ScreenBrightnessPlugin {
  const p = plugin();
  if (!p) throw unavailable("expo-brightness", call, SHELL_ONLY);
  return p;
}

/** `DenextBrightness` with `method`, or undefined. */
function denext(method: keyof DenextBrightnessPlugin): DenextBrightnessPlugin | undefined {
  return nativePlugin<DenextBrightnessPlugin>("DenextBrightness", [method]);
}

/** `DenextBrightness` with `method`, or an `ERR_UNAVAILABLE` rejection naming `call`. */
function requiredDenext(
  method: keyof DenextBrightnessPlugin,
  call: string,
): DenextBrightnessPlugin {
  const p = denext(method);
  if (!p) {
    throw unavailable(
      "expo-brightness",
      call,
      "Android's system setting needs denext's DenextBrightness plugin: run `denext mobile add " +
        "brightness` again.",
    );
  }
  return p;
}

/** Whether this is the Android shell (Expo's Android-only calls do something only there). */
const onAndroid = (): boolean => nativePlatform() === "android";

/** A level clamped to 0–1, as Expo clamps it (`NaN` is its `TypeError`). */
function level(value: number, call: string): number {
  const clamped = Math.max(0, Math.min(value, 1));
  if (Number.isNaN(clamped)) throw new TypeError(`${call} cannot be called with ${value}`);
  return clamped;
}

/**
 * Whether the brightness can be changed: the shell with the plugin.
 *
 * @returns Whether the calls work here.
 */
export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(plugin() !== undefined);
}

/**
 * The current brightness: the screen's (iOS) or the app window's (Android; the system's while
 * the window follows it, as in Expo, or `-1` without `DenextBrightness`).
 *
 * @returns 0–1 (or `-1`, see above).
 */
export async function getBrightnessAsync(): Promise<number> {
  const { brightness } = await required("getBrightnessAsync").getBrightness();
  const system = onAndroid() && brightness < 0 ? denext("getSystemBrightness") : undefined;
  return system ? (await system.getSystemBrightness()).value : brightness;
}

/**
 * Set the brightness while the app runs.
 *
 * @param brightnessValue 0–1.
 */
export async function setBrightnessAsync(brightnessValue: number): Promise<void> {
  const p = required("setBrightnessAsync");
  await p.setBrightness({ brightness: level(brightnessValue, "setBrightnessAsync") });
}

/**
 * The system brightness: off Android the screen's, as Expo (`getBrightnessAsync`); on Android
 * the system setting.
 *
 * @returns 0–1.
 */
export async function getSystemBrightnessAsync(): Promise<number> {
  if (!onAndroid()) return await getBrightnessAsync();
  const p = requiredDenext("getSystemBrightness", "getSystemBrightnessAsync");
  return (await p.getSystemBrightness()).value;
}

/**
 * Set the system brightness: off Android the screen's, as Expo (`setBrightnessAsync`); on
 * Android the system setting (switching its mode to manual first, as Expo), which needs
 * `WRITE_SETTINGS` ({@linkcode requestPermissionsAsync}).
 *
 * @param brightnessValue 0–1.
 */
export async function setSystemBrightnessAsync(brightnessValue: number): Promise<void> {
  const value = level(brightnessValue, "setSystemBrightnessAsync");
  if (!onAndroid()) return await setBrightnessAsync(value);
  const p = requiredDenext("setSystemBrightness", "setSystemBrightnessAsync");
  await p.setSystemBrightness({ value });
}

/**
 * Android: let the app window follow the system brightness again. Off Android it does nothing,
 * as in Expo.
 */
export async function restoreSystemBrightnessAsync(): Promise<void> {
  if (!onAndroid()) return;
  await required("restoreSystemBrightnessAsync").setBrightness({ brightness: -1 });
}

/**
 * Android: whether the app window follows the system brightness (it has no level of its own).
 * Off Android `false`, as in Expo.
 *
 * @returns Whether the window follows the system.
 */
export async function isUsingSystemBrightnessAsync(): Promise<boolean> {
  if (!onAndroid()) return false;
  return (await required("isUsingSystemBrightnessAsync").getBrightness()).brightness < 0;
}

/**
 * The system brightness mode: off Android `BrightnessMode.UNKNOWN`, as in Expo; on Android the
 * system setting's (`AUTOMATIC` or `MANUAL`).
 *
 * @returns The mode.
 */
export async function getSystemBrightnessModeAsync(): Promise<BrightnessMode> {
  if (!onAndroid()) return BrightnessMode.UNKNOWN;
  const p = requiredDenext("getSystemBrightnessMode", "getSystemBrightnessModeAsync");
  const { mode } = await p.getSystemBrightnessMode();
  return mode === "automatic" ? BrightnessMode.AUTOMATIC : BrightnessMode.MANUAL;
}

/**
 * Set the system brightness mode: off Android, or for `UNKNOWN`, it does nothing, as in Expo; on
 * Android it writes the system setting, which needs `WRITE_SETTINGS`
 * ({@linkcode requestPermissionsAsync}).
 *
 * @param brightnessMode The mode.
 */
export async function setSystemBrightnessModeAsync(brightnessMode: BrightnessMode): Promise<void> {
  if (!onAndroid() || brightnessMode === BrightnessMode.UNKNOWN) return;
  const p = requiredDenext("setSystemBrightnessMode", "setSystemBrightnessModeAsync");
  await p.setSystemBrightnessMode({
    mode: brightnessMode === BrightnessMode.AUTOMATIC ? "automatic" : "manual",
  });
}

/**
 * Android's answer for `WRITE_SETTINGS`: granted, or denied with another ask possible (the
 * settings screen can always be opened again).
 */
function writeSettingsResponse(granted: boolean): PermissionResponse {
  return granted
    ? permissionResponse(PermissionStatus.GRANTED)
    : { ...permissionResponse(PermissionStatus.DENIED), canAskAgain: true };
}

/**
 * The system-settings permission: `undetermined` on the web, as Expo's web build; on Android
 * with `DenextBrightness`, whether the app may write the system settings (`WRITE_SETTINGS`);
 * elsewhere in the shell `granted` (nothing is needed there).
 */
async function brightnessPermission(): Promise<PermissionResponse> {
  if (nativePlatform() === "web") return permissionResponse(PermissionStatus.UNDETERMINED);
  const p = onAndroid() ? denext("checkWriteSettings") : undefined;
  if (!p) return await NOT_NEEDED_PERMISSION.get();
  return writeSettingsResponse((await p.checkWriteSettings()).granted);
}

/**
 * Ask for the system-settings permission. On Android with `DenextBrightness` it opens the
 * system screen where the user lets the app write the settings (as Expo does) and answers when
 * they come back; elsewhere as {@linkcode getPermissionsAsync}.
 */
async function requestBrightnessPermission(): Promise<PermissionResponse> {
  const p = onAndroid() ? denext("requestWriteSettings") : undefined;
  if (!p) return await brightnessPermission();
  return writeSettingsResponse((await p.requestWriteSettings()).granted);
}

/** The system-settings permission (see {@linkcode requestPermissionsAsync}). */
export const getPermissionsAsync: () => Promise<PermissionResponse> = brightnessPermission;

/**
 * Ask for the system-settings permission: on Android the system screen for `WRITE_SETTINGS`;
 * `granted` elsewhere in the shell, `undetermined` on the web.
 */
export const requestPermissionsAsync: () => Promise<PermissionResponse> =
  requestBrightnessPermission;

/** Hook form of the permission: `[response, request, get]`. */
export const usePermissions: (
  options?: PermissionHookOptions<object>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = createPermissionHook({
  getMethod: brightnessPermission,
  requestMethod: requestBrightnessPermission,
});

/** The brightness listeners: fed from `DenextBrightness`'s iOS change events while any listens. */
const listeners = createEmitter<BrightnessEvent>((emit) => {
  const p = nativePlatform() === "ios" ? denext("addListener") : undefined;
  if (!p) return () => {};
  return listenerDisposer(
    p.addListener("brightnessChanged", (event) => emit({ brightness: event?.brightness ?? 0 })),
  );
});

/**
 * Call `listener` when the screen's brightness changes (iOS, as in Expo: with `DenextBrightness`
 * from `denext mobile add brightness`; never elsewhere).
 *
 * @param listener The listener.
 * @returns A subscription to remove.
 */
export function addBrightnessListener(listener: (event: BrightnessEvent) => void): Subscription {
  return listeners.subscribe(listener);
}
