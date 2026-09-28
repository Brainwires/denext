/**
 * `expo-store-review` for denext: the same API over `denext/mobile`'s
 * {@linkcode requestReview} (the in-app review sheet: `denext mobile add app-review`).
 * `requestReview()` asks the OS for its rating sheet in the native shell and does nothing
 * elsewhere, as Expo's web build; `storeUrl()` is the Expo config's `ios.appStoreUrl` /
 * `android.playStoreUrl`, or null.
 *
 * @example
 * ```ts
 * import * as StoreReview from "denext/expo/store-review";
 *
 * if (await StoreReview.hasAction()) await StoreReview.requestReview();
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { requestReview as requestNativeReview } from "../mobile/app-review.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { expoConfigGlobal } from "./internal/common.ts";

/** Whether the shell has an in-app review plugin (`denext mobile add app-review`). */
function reviewPlugin(): boolean {
  return nativePlugin("AppReview", ["requestReview"]) !== undefined ||
    nativePlugin("InAppReview", ["requestReview"]) !== undefined;
}

/**
 * Whether the in-app review sheet can be asked for: in the iOS/Android shell with the review
 * plugin.
 *
 * @returns Whether {@linkcode requestReview} reaches the OS.
 */
export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(nativePlatform() !== "web" && reviewPlugin());
}

/**
 * Ask the OS for its in-app rating sheet (the OS decides whether it shows). Does nothing where
 * {@linkcode isAvailableAsync} is false.
 *
 * @returns Settles once asked.
 */
export async function requestReview(): Promise<void> {
  await requestNativeReview();
}

/** A string field of the Expo config's `ios` / `android` section. */
function configUrl(section: "ios" | "android", key: string): string | null {
  const value = (expoConfigGlobal()?.[section] as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The app's store page: `ios.appStoreUrl` in the iOS shell, `android.playStoreUrl` on Android
 * (from the Expo config `denext migrate` carries over), else null.
 *
 * @returns The URL, or null.
 */
export function storeUrl(): string | null {
  const platform = nativePlatform();
  if (platform === "ios") return configUrl("ios", "appStoreUrl");
  if (platform === "android") return configUrl("android", "playStoreUrl");
  return configUrl("ios", "appStoreUrl") ?? configUrl("android", "playStoreUrl");
}

/**
 * Whether there is anything to do: the review sheet, or a store page to open.
 *
 * @returns Whether {@linkcode requestReview} or {@linkcode storeUrl} can act.
 */
export async function hasAction(): Promise<boolean> {
  return (await isAvailableAsync()) || storeUrl() !== null;
}
