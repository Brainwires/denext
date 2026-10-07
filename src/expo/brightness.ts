/**
 * `expo-brightness` for denext: the screen brightness in the Capacitor shell, through
 * `@capacitor-community/screen-brightness` (`denext mobile add brightness`). As in Expo, iOS
 * sets the screen's brightness while the app runs and Android sets the app window's.
 *
 * - `restoreSystemBrightnessAsync` puts back the level from before the app first changed it
 *   (iOS) or lets the window follow the system again (Android).
 * - The system-wide calls: on iOS `get/setSystemBrightnessAsync` are the screen's (as in Expo);
 *   on Android, writing the system setting and its mode (`WRITE_SETTINGS`) is not available and
 *   rejects with `ERR_UNAVAILABLE`, as do the mode calls on iOS (Android-only in Expo).
 * - On Android `getBrightnessAsync()` reads `-1` until the app sets a level (the window follows
 *   the system, whose level the plugin does not report).
 * - `addBrightnessListener` never fires (the plugin reports no changes).
 *
 * Outside the shell `isAvailableAsync()` is `false` and the calls reject with `ERR_UNAVAILABLE`,
 * as on Expo's web build.
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
  NOT_NEEDED_PERMISSION,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
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

/** The level from before the app first changed it (iOS), for the restore. */
let original: number | undefined;

/** A level clamped to 0–1. */
function level(value: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError("brightnessValue must be a number between 0 and 1");
  }
  return Math.max(0, Math.min(1, value));
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
  const value = level(brightnessValue);
  if (original === undefined && nativePlatform() === "ios") {
    original = (await p.getBrightness()).brightness;
  }
  await p.setBrightness({ brightness: value });
}

/**
 * The system brightness: the screen's on iOS (as Expo); not readable on Android.
 *
 * @returns 0–1.
 */
export async function getSystemBrightnessAsync(): Promise<number> {
  if (nativePlatform() !== "ios") {
    throw unavailable(
      "expo-brightness",
      "getSystemBrightnessAsync",
      "Android's system setting is not readable here; use getBrightnessAsync.",
    );
  }
  return await getBrightnessAsync();
}

/**
 * Set the system brightness: the screen's on iOS (as Expo); not writable on Android.
 *
 * @param brightnessValue 0–1.
 */
export async function setSystemBrightnessAsync(brightnessValue: number): Promise<void> {
  if (nativePlatform() !== "ios") {
    throw unavailable(
      "expo-brightness",
      "setSystemBrightnessAsync",
      "Android's system setting (WRITE_SETTINGS) is not writable here; use setBrightnessAsync.",
    );
  }
  await setBrightnessAsync(brightnessValue);
}

/**
 * Undo the app's brightness: the level from before the app first set one (iOS), or the window
 * following the system again (Android).
 */
export async function restoreSystemBrightnessAsync(): Promise<void> {
  const p = required("restoreSystemBrightnessAsync");
  if (nativePlatform() === "android") return await p.setBrightness({ brightness: -1 });
  if (original !== undefined) {
    await p.setBrightness({ brightness: original });
    original = undefined;
  }
}

/**
 * Whether the system's brightness applies: on Android, the window has no level of its own; on
 * iOS, the app has not changed it (or restored it).
 *
 * @returns Whether the app's own level is unset.
 */
export async function isUsingSystemBrightnessAsync(): Promise<boolean> {
  const p = required("isUsingSystemBrightnessAsync");
  if (nativePlatform() === "android") return (await p.getBrightness()).brightness < 0;
  return original === undefined;
}

/**
 * The system brightness mode: not readable here.
 *
 * @returns Never: it rejects with `ERR_UNAVAILABLE`.
 */
export function getSystemBrightnessModeAsync(): Promise<BrightnessMode> {
  return Promise.reject(
    unavailable(
      "expo-brightness",
      "getSystemBrightnessModeAsync",
      "The mode is not readable here.",
    ),
  );
}

/**
 * Set the system brightness mode: not writable here.
 *
 * @param _brightnessMode The mode.
 */
export function setSystemBrightnessModeAsync(_brightnessMode: BrightnessMode): Promise<void> {
  return Promise.reject(
    unavailable(
      "expo-brightness",
      "setSystemBrightnessModeAsync",
      "The mode is not writable here.",
    ),
  );
}

/** The system-settings permission: none is needed for what works here, so `granted`. */
export const getPermissionsAsync: () => Promise<PermissionResponse> = NOT_NEEDED_PERMISSION.get;

/** Ask for the system-settings permission: none is needed here, so `granted`. */
export const requestPermissionsAsync: () => Promise<PermissionResponse> =
  NOT_NEEDED_PERMISSION.request;

/** Hook form of the permission: `[response, request, get]`. */
export const usePermissions: (
  options?: PermissionHookOptions<object>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = NOT_NEEDED_PERMISSION.hook;

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
