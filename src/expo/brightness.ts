/**
 * `expo-brightness` for denext: the screen brightness in the Capacitor shell, through
 * `@capacitor-community/screen-brightness` (`denext mobile add brightness`). As in Expo, iOS
 * sets the screen's brightness while the app runs and Android sets the app window's.
 *
 * - Off Android (iOS and the web) the calls behave as Expo's do there: the system brightness is
 *   the screen's (`get/setSystemBrightnessAsync` are `get/setBrightnessAsync`), and the
 *   Android-only calls resolve: `restoreSystemBrightnessAsync` and
 *   `setSystemBrightnessModeAsync` do nothing, `isUsingSystemBrightnessAsync` is `false` and
 *   `getSystemBrightnessModeAsync` is `BrightnessMode.UNKNOWN`.
 * - On Android `restoreSystemBrightnessAsync` lets the window follow the system again; writing
 *   the system setting and reading or writing its mode (`WRITE_SETTINGS`) is not available and
 *   rejects with `ERR_UNAVAILABLE` (setting the mode to `UNKNOWN` is a no-op, as in Expo).
 * - On Android `getBrightnessAsync()` reads `-1` until the app sets a level (the window follows
 *   the system, whose level the plugin does not report).
 * - `addBrightnessListener` never fires (the plugin reports no changes).
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
import { nativePlugin } from "../mobile/plugin.ts";
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
 * The current brightness: the screen's (iOS) or the app window's (Android; `-1` while it
 * follows the system).
 *
 * @returns 0–1 (or `-1`, see above).
 */
export async function getBrightnessAsync(): Promise<number> {
  return (await required("getBrightnessAsync").getBrightness()).brightness;
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
 * The system brightness: off Android the screen's, as Expo (`getBrightnessAsync`); Android's
 * system setting is not readable here.
 *
 * @returns 0–1.
 */
export async function getSystemBrightnessAsync(): Promise<number> {
  if (!onAndroid()) return await getBrightnessAsync();
  throw unavailable(
    "expo-brightness",
    "getSystemBrightnessAsync",
    "Android's system setting is not readable here; use getBrightnessAsync.",
  );
}

/**
 * Set the system brightness: off Android the screen's, as Expo (`setBrightnessAsync`); Android's
 * system setting is not writable here.
 *
 * @param brightnessValue 0–1.
 */
export async function setSystemBrightnessAsync(brightnessValue: number): Promise<void> {
  const value = level(brightnessValue, "setSystemBrightnessAsync");
  if (!onAndroid()) return await setBrightnessAsync(value);
  throw unavailable(
    "expo-brightness",
    "setSystemBrightnessAsync",
    "Android's system setting (WRITE_SETTINGS) is not writable here; use setBrightnessAsync.",
  );
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
 * The system brightness mode: off Android `BrightnessMode.UNKNOWN`, as in Expo; Android's is not
 * readable here (it rejects with `ERR_UNAVAILABLE`).
 *
 * @returns The mode.
 */
export function getSystemBrightnessModeAsync(): Promise<BrightnessMode> {
  if (!onAndroid()) return Promise.resolve(BrightnessMode.UNKNOWN);
  return Promise.reject(
    unavailable(
      "expo-brightness",
      "getSystemBrightnessModeAsync",
      "The mode is not readable here.",
    ),
  );
}

/**
 * Set the system brightness mode: off Android, or for `UNKNOWN`, it does nothing, as in Expo;
 * Android's is not writable here (it rejects with `ERR_UNAVAILABLE`).
 *
 * @param brightnessMode The mode.
 */
export function setSystemBrightnessModeAsync(brightnessMode: BrightnessMode): Promise<void> {
  if (!onAndroid() || brightnessMode === BrightnessMode.UNKNOWN) return Promise.resolve();
  return Promise.reject(
    unavailable(
      "expo-brightness",
      "setSystemBrightnessModeAsync",
      "The mode is not writable here.",
    ),
  );
}

/**
 * The system-settings permission: `granted` in the shell (none is needed for what works there),
 * `undetermined` on the web, as Expo's web build.
 */
function brightnessPermission(): Promise<PermissionResponse> {
  return nativePlatform() === "web"
    ? Promise.resolve(permissionResponse(PermissionStatus.UNDETERMINED))
    : NOT_NEEDED_PERMISSION.get();
}

/** The system-settings permission: `granted` in the shell, `undetermined` on the web. */
export const getPermissionsAsync: () => Promise<PermissionResponse> = brightnessPermission;

/** Ask for the system-settings permission: as {@linkcode getPermissionsAsync}. */
export const requestPermissionsAsync: () => Promise<PermissionResponse> = brightnessPermission;

/** Hook form of the permission: `[response, request, get]`. */
export const usePermissions: (
  options?: PermissionHookOptions<object>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = createPermissionHook({ getMethod: brightnessPermission, requestMethod: brightnessPermission });

/** The brightness listeners (the plugin reports no changes, so none is ever called). */
const listeners = createEmitter<BrightnessEvent>();

/**
 * Call `listener` when the brightness changes: never, since the plugin reports no changes.
 *
 * @param listener The listener.
 * @returns A subscription to remove.
 */
export function addBrightnessListener(listener: (event: BrightnessEvent) => void): Subscription {
  return listeners.subscribe(listener);
}
