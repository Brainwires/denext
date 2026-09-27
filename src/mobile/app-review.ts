/**
 * The in-app review prompt for `denext/mobile`: the native `AppReview` plugin in the shell
 * (`@capawesome/capacitor-app-review`, installed by `denext mobile add app-review`; the
 * `InAppReview` plugin of `@capacitor-community/in-app-review` is used too when an app already
 * has it), else the store page opened in a new tab.
 *
 * @module
 */

import { nativePlatform, openExternal } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";

/** The JS side of `@capawesome/capacitor-app-review`. */
interface AppReviewPlugin {
  requestReview(): Promise<void>;
  openAppStore(options?: { appId: string }): Promise<void>;
}

/** The JS side of `@capacitor-community/in-app-review`. */
interface InAppReviewPlugin {
  requestReview(): Promise<void>;
}

/**
 * What {@linkcode requestReview} did: `"requested"` (the system was asked to show its review
 * sheet; whether it did is the OS's call and is never reported) or `"unsupported"` (not in the
 * native shell, or no review plugin installed).
 */
export type ReviewRequestResult = "requested" | "unsupported";

/** Where {@linkcode openStoreReview} sends the user. */
export interface StoreListingOptions {
  /**
   * The app's numeric App Store id (`123456789` from `https://apps.apple.com/app/id123456789`).
   * Needed on iOS and for the App Store link on the web.
   */
  readonly appStoreId?: string;
  /**
   * The Android package name (`com.example.app`). Natively the running app's own is used;
   * on the web it picks the Play Store link.
   */
  readonly androidPackage?: string;
}

/**
 * Ask the OS to show its in-app rating sheet (StoreKit's `requestReview` on iOS, the Play
 * In-App Review flow on Android).
 *
 * The OS decides whether the sheet appears: iOS shows it at most three times a year per user,
 * never in a TestFlight build, and Play applies its own quota (a sideloaded build never shows
 * it). Nothing tells the app whether it appeared or what the user chose, so ask at a natural
 * pause (after a completed task), never from a button labelled "Rate us": for that, use
 * {@linkcode openStoreReview}.
 *
 * @returns `"requested"` natively, `"unsupported"` on the web or without the plugin. It
 * rejects when the plugin fails (for example Play Services missing).
 * @example
 * ```ts
 * import { requestReview } from "denext/mobile";
 *
 * if (completedOrders >= 3 && !askedThisVersion) await requestReview();
 * ```
 */
export async function requestReview(): Promise<ReviewRequestResult> {
  const plugin = nativePlugin<AppReviewPlugin>("AppReview", ["requestReview"]) ??
    nativePlugin<InAppReviewPlugin>("InAppReview", ["requestReview"]);
  if (!plugin) return "unsupported";
  await plugin.requestReview();
  return "requested";
}

/** The App Store "write a review" page for `id`. */
function appStoreReviewUrl(id: string): string {
  return `https://apps.apple.com/app/id${encodeURIComponent(id)}?action=write-review`;
}

/** The Play Store listing for `pkg`. */
function playStoreUrl(pkg: string): string {
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}`;
}

/** The store page for `options` on the web, or throws when neither id is given. */
function webStoreUrl(options: StoreListingOptions): string {
  if (options.appStoreId) return appStoreReviewUrl(options.appStoreId);
  if (options.androidPackage) return playStoreUrl(options.androidPackage);
  throw new TypeError("openStoreReview: pass appStoreId and/or androidPackage");
}

/**
 * Open the app's page in the App Store (on the "write a review" sheet) or Play Store, for a
 * "Rate this app" button. Unlike {@linkcode requestReview} it always opens something.
 *
 * - Inside the native shell with `@capawesome/capacitor-app-review` installed, its
 *   `openAppStore` (iOS needs `appStoreId`; Android opens the running app's listing).
 * - Otherwise the store URL in a new tab (the in-app browser natively): on iOS the App
 *   Store, on Android Play when `androidPackage` is given, on the web the App Store when
 *   `appStoreId` is given, else Play.
 *
 * @param options The App Store id (iOS, and the web) and / or the Android package (the web).
 * @returns A promise that settles once the store page was handed off. It rejects with a
 * `TypeError` on iOS without `appStoreId`, or on the web without either id.
 * @example
 * ```tsx
 * "use client";
 * import { openStoreReview } from "denext/mobile";
 *
 * export function RateButton() {
 *   return (
 *     <button type="button" onClick={() => openStoreReview({ appStoreId: "123456789" })}>
 *       Rate this app
 *     </button>
 *   );
 * }
 * ```
 */
export async function openStoreReview(options: StoreListingOptions = {}): Promise<void> {
  const platform = nativePlatform();
  if (platform === "ios" && !options.appStoreId) {
    throw new TypeError("openStoreReview: iOS needs appStoreId (the numeric App Store id)");
  }
  const plugin = nativePlugin<AppReviewPlugin>("AppReview", ["openAppStore"]);
  if (plugin) {
    return await plugin.openAppStore(
      options.appStoreId ? { appId: options.appStoreId } : undefined,
    );
  }
  if (platform === "ios") return await openExternal(appStoreReviewUrl(options.appStoreId!));
  if (platform === "android" && options.androidPackage) {
    return await openExternal(playStoreUrl(options.androidPackage));
  }
  await openExternal(webStoreUrl(options));
}
