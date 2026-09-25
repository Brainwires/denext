/**
 * `expo-splash-screen` for denext: over `denext/mobile`'s {@linkcode hideSplash}
 * (`@capacitor/splash-screen` in the Capacitor shell; nothing to hide on the web, where the
 * SPA's boot shell plays the splash).
 *
 * For `preventAutoHideAsync` to hold the native splash, configure the Capacitor plugin with
 * `launchAutoHide: false` (`denext mobile add splash`); the call itself only records intent.
 *
 * @example
 * ```ts
 * import * as SplashScreen from "denext/expo/splash-screen";
 *
 * void SplashScreen.preventAutoHideAsync();
 * // … once the first screen has rendered:
 * SplashScreen.hide();
 * ```
 *
 * @module
 */

import { hideSplash } from "../mobile/splash.ts";

/** Options for {@linkcode setOptions}. */
export interface SplashScreenOptions {
  /** The fade-out duration in ms (ignored here). */
  duration?: number;
  /** Whether to fade out (ignored here). */
  fade?: boolean;
}

/**
 * Keep the splash screen up until {@linkcode hideAsync}. The native hold comes from the
 * plugin's `launchAutoHide: false`; this call has nothing to change.
 *
 * @returns `true`.
 */
export function preventAutoHideAsync(): Promise<boolean> {
  return Promise.resolve(true);
}

/**
 * Hide the splash screen.
 *
 * @returns A promise that settles once it is hidden.
 */
export async function hideAsync(): Promise<void> {
  await hideSplash();
}

/** Hide the splash screen, without waiting. */
export function hide(): void {
  hideSplash().catch(() => {});
}

/**
 * Set the fade options. The Capacitor plugin takes them from its config, so this does
 * nothing.
 *
 * @param _options Ignored.
 */
export function setOptions(_options: SplashScreenOptions): void {}
