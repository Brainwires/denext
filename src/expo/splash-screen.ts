/**
 * `expo-splash-screen` for denext: over `denext/mobile`'s {@linkcode hideSplash}
 * (`@capacitor/splash-screen` in the Capacitor shell; nothing to hide on the web, where the
 * SPA's boot shell plays the splash).
 *
 * As in Expo, the native splash hides by itself once the app's first frame is drawn (React
 * Native mode hides it after the root's first commit), and `preventAutoHideAsync` keeps it up
 * until `hideAsync`. The Capacitor plugin (`denext mobile add splash`) must be configured with
 * `launchAutoHide: false` for either to decide, which `denext migrate --from expo` writes.
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

import { hideSplash, preventAutoHideSplash } from "../mobile/splash.ts";

/** Options for {@linkcode setOptions}. */
export interface SplashScreenOptions {
  /** The fade-out duration in ms (ignored here). */
  duration?: number;
  /** Whether to fade out (ignored here). */
  fade?: boolean;
}

/**
 * Keep the splash screen up after the app's first frame, until {@linkcode hideAsync}. Call it
 * at module scope, before the first render.
 *
 * @returns Whether it held the splash (`false` once the splash is hidden, as in Expo).
 */
export function preventAutoHideAsync(): Promise<boolean> {
  return Promise.resolve(preventAutoHideSplash());
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
