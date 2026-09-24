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
  await nativePlugin<SplashScreenPlugin>("SplashScreen", ["hide"])?.hide();
}
