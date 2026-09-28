/**
 * `expo-screen-capture` for denext: over `denext/mobile`'s {@linkcode setPrivacyScreen}
 * (`@capacitor/privacy-screen`: `denext mobile add privacy-screen`). In the Android shell
 * `preventScreenCaptureAsync` blocks screenshots and screen recording (`FLAG_SECURE`, which also
 * hides the recents thumbnail) until every key that asked is released; on iOS it hides the app
 * in the app switcher but cannot block a screenshot. `enableAppSwitcherProtectionAsync` hides
 * the app switcher snapshot under a blur. The screenshot listener never fires (the plugin
 * reports no screenshots), and the permission reads granted. Outside the shell every call does
 * nothing and `isAvailableAsync()` is false, as Expo's web build.
 *
 * @example
 * ```ts
 * import * as ScreenCapture from "denext/expo/screen-capture";
 *
 * await ScreenCapture.preventScreenCaptureAsync("payment");
 * // …
 * await ScreenCapture.allowScreenCaptureAsync("payment");
 * ```
 *
 * @module
 */

import { useEffect } from "../runtime/hooks.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { setPrivacyScreen } from "../mobile/privacy-screen.ts";
import {
  createPermissionHook,
  type PermissionHookOptions,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
  type Subscription,
  subscription,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionHookOptions, PermissionResponse, Subscription };

/** The key {@linkcode preventScreenCaptureAsync} uses when given none. */
const DEFAULT_KEY = "default";

/** The keys preventing capture now (made on first use). */
let keys: Set<string> | undefined;
/** The app switcher blur, when protection is on. */
let switcherBlur: "light" | "dark" | "none" | null = null;

/** Apply the current state to the plugin. */
async function apply(): Promise<void> {
  const preventing = (keys?.size ?? 0) > 0;
  const on = preventing || switcherBlur !== null;
  await setPrivacyScreen(on, {
    preventScreenshots: preventing,
    ...(switcherBlur ? { iosBlur: switcherBlur } : {}),
  });
}

/**
 * Whether the privacy-screen plugin is in this shell.
 *
 * @returns Whether the calls do anything.
 */
export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(nativePlugin("PrivacyScreen", ["enable", "disable"]) !== undefined);
}

/**
 * Block screen capture until {@linkcode allowScreenCaptureAsync} releases `key` (and every
 * other key that asked).
 *
 * @param key Who is asking (default `"default"`).
 * @returns Settles once applied.
 */
export async function preventScreenCaptureAsync(key: string = DEFAULT_KEY): Promise<void> {
  (keys ??= new Set()).add(key);
  await apply();
}

/**
 * Release `key`'s block; capture is allowed again once no key holds one.
 *
 * @param key Who is releasing (default `"default"`).
 * @returns Settles once applied.
 */
export async function allowScreenCaptureAsync(key: string = DEFAULT_KEY): Promise<void> {
  if (!keys?.delete(key)) return;
  await apply();
}

/**
 * Block screen capture while the component is mounted.
 *
 * @param key Who is asking (default `"default"`).
 */
export function usePreventScreenCapture(key: string = DEFAULT_KEY): void {
  useEffect(() => {
    preventScreenCaptureAsync(key).catch(() => {});
    return () => void allowScreenCaptureAsync(key).catch(() => {});
  }, [key]);
}

/**
 * Hide the app switcher snapshot under a blur (iOS; Android hides the recents thumbnail).
 *
 * @param blurIntensity 0–1: under 0.5 a light blur, else a dark one (default 0.5).
 * @returns Settles once applied.
 */
export async function enableAppSwitcherProtectionAsync(blurIntensity = 0.5): Promise<void> {
  switcherBlur = blurIntensity <= 0 ? "none" : blurIntensity < 0.5 ? "light" : "dark";
  await apply();
}

/**
 * Stop hiding the app switcher snapshot.
 *
 * @returns Settles once applied.
 */
export async function disableAppSwitcherProtectionAsync(): Promise<void> {
  switcherBlur = null;
  await apply();
}

/**
 * Listen for screenshots: never fires here (the plugin reports none).
 *
 * @param _listener Never called.
 * @returns A subscription.
 */
export function addScreenshotListener(_listener: () => void): Subscription {
  return subscription(() => {});
}

/**
 * Remove a screenshot listener.
 *
 * @param sub What {@linkcode addScreenshotListener} returned.
 */
export function removeScreenshotListener(sub: Subscription): void {
  sub.remove();
}

/**
 * Listen for screenshots while mounted: never fires here.
 *
 * @param listener Never called.
 */
export function useScreenshotListener(listener: () => void): void {
  useEffect(() => {
    const sub = addScreenshotListener(listener);
    return () => sub.remove();
  }, [listener]);
}

/**
 * The screenshot-detection permission: granted (nothing to ask for).
 *
 * @returns Granted.
 */
export function getPermissionsAsync(): Promise<PermissionResponse> {
  return Promise.resolve(permissionResponse(PermissionStatus.GRANTED));
}

/**
 * Ask for the screenshot-detection permission: granted.
 *
 * @returns Granted.
 */
export function requestPermissionsAsync(): Promise<PermissionResponse> {
  return getPermissionsAsync();
}

/** Hook form of the permission: `[response, request, get]`. */
export const usePermissions: (
  options?: PermissionHookOptions<object>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = /* @__PURE__ */ createPermissionHook({
  getMethod: getPermissionsAsync,
  requestMethod: requestPermissionsAsync,
});
