/**
 * Splash-screen control for `denext/mobile`.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";

/** The JS side of `@capacitor/splash-screen` (the half used here). */
interface SplashScreenPlugin {
  hide(): Promise<void>;
}

/**
 * Whether the splash still waits for the app's first frame (`pending`), was held by
 * {@linkcode preventAutoHideSplash} until the app hides it, or is hidden (or being hidden).
 */
let autoHide: "pending" | "prevented" | "done" = "pending";

/**
 * Hide the native launch splash screen, through `@capacitor/splash-screen` inside the shell
 * (`denext mobile add splash`). Call it once the first screen has rendered, when the plugin
 * is configured with `launchAutoHide: false`. On the web, and when the plugin is not
 * installed, it does nothing.
 *
 * @returns A promise that settles once the splash is hidden (at once off the shell).
 * @example
 * ```tsx
 * "use client";
 * import { useEffect } from "denext";
 * import { hideSplash } from "denext/mobile";
 *
 * export function AppReady() {
 *   useEffect(() => void hideSplash(), []);
 *   return null;
 * }
 * ```
 */
export async function hideSplash(): Promise<void> {
  autoHide = "done";
  await nativePlugin<SplashScreenPlugin>("SplashScreen", ["hide"])?.hide();
}

/**
 * Keep the native splash up after the app's first frame, until the app calls
 * {@linkcode hideSplash} (expo-splash-screen's `preventAutoHideAsync`). Call it before the
 * first render commits.
 *
 * @returns Whether it held the splash (false once it is hidden or already held).
 */
export function preventAutoHideSplash(): boolean {
  if (autoHide !== "pending") return false;
  autoHide = "prevented";
  return true;
}

/**
 * Hide the native splash once the frame holding the app's first commit has painted, unless
 * the app holds it ({@linkcode preventAutoHideSplash}) or already hid it: React Native mode
 * calls this after its root's first commit, as Expo's native splash hides at the app's first
 * frame. With `SplashScreen.launchAutoHide: false` (which `denext migrate --from expo` writes)
 * the launch screen therefore stays until the app has drawn, never a blank page.
 */
export function hideSplashAfterFirstFrame(): void {
  if (autoHide !== "pending") return;
  autoHide = "done";
  const hide = () => void hideSplash().catch(() => {});
  // rAF runs before the next paint; the macrotask after it runs once that frame is drawn.
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => setTimeout(hide, 0));
  } else hide();
}

/** Back to the launch state (tests). */
export function resetSplashAutoHide(): void {
  autoHide = "pending";
}
