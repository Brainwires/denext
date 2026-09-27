/**
 * Hide the app's content from the app switcher (and, on Android, from screenshots and screen
 * recording) for `denext/mobile`, through the official `PrivacyScreen` plugin
 * (`@capacitor/privacy-screen`, installed by `denext mobile add privacy-screen`). There is no
 * web equivalent: a browser owns its tab snapshots, so on the web these calls do nothing.
 *
 * @module
 */

import { useEffect } from "../runtime/hooks.ts";
import { nativePlugin } from "./plugin.ts";

/** How the app looks while hidden. */
export interface PrivacyScreenOptions {
  /** iOS: the blur over the app-switcher snapshot. Default `"dark"`; `"none"` shows a plain cover. */
  readonly iosBlur?: "light" | "dark" | "none";
  /** Android: dim the recents thumbnail instead of showing the splash screen. Default `false`. */
  readonly androidDim?: boolean;
  /**
   * Android: also block screenshots and screen recording (`FLAG_SECURE`). Default `true`,
   * the plugin's own default; `false` keeps screenshots working and hides only the recents
   * thumbnail.
   */
  readonly preventScreenshots?: boolean;
}

/** The JS side of `@capacitor/privacy-screen` (2.x, Capacitor 8). */
interface PrivacyScreenPlugin {
  enable(config?: {
    android?: { dimBackground?: boolean; preventScreenshots?: boolean };
    ios?: { blurEffect?: "light" | "dark" | "none" };
  }): Promise<unknown>;
  disable(): Promise<unknown>;
}

/** The plugin, when the shell has it. */
function privacyPlugin(): PrivacyScreenPlugin | undefined {
  return nativePlugin<PrivacyScreenPlugin>("PrivacyScreen", ["enable", "disable"]);
}

/** The plugin's `enable` config for `options`. */
function enableConfig(options: PrivacyScreenOptions) {
  return {
    android: {
      dimBackground: options.androidDim === true,
      preventScreenshots: options.preventScreenshots !== false,
    },
    ios: { blurEffect: options.iosBlur ?? "dark" },
  };
}

/**
 * Turn the privacy screen on or off for the whole app.
 *
 * @param enabled Whether the app's content is hidden in the app switcher.
 * @param options The iOS blur, the Android dim and screenshot blocking.
 * @returns `true` when the native plugin applied it, `false` on the web or without the plugin.
 * It rejects when the plugin fails.
 * @example
 * ```ts
 * import { setPrivacyScreen } from "denext/mobile";
 * await setPrivacyScreen(true, { iosBlur: "light" });
 * ```
 */
export async function setPrivacyScreen(
  enabled: boolean,
  options: PrivacyScreenOptions = {},
): Promise<boolean> {
  const plugin = privacyPlugin();
  if (!plugin) return false;
  if (enabled) await plugin.enable(enableConfig(options));
  else await plugin.disable();
  return true;
}

/** How many mounted {@linkcode usePrivacyScreen} calls hold the screen hidden. */
let holders = 0;

/**
 * Hide the app from the app switcher while the component is mounted and `enabled` is true (an
 * account page, a banking screen). Several mounted callers share it: the privacy screen turns
 * off once the last one unmounts or turns `enabled` off. On the web it does nothing.
 *
 * @param enabled Whether to hide the app (default `true`).
 * @param options The iOS blur, the Android dim and screenshot blocking (read when it turns on).
 * @example
 * ```tsx
 * "use client";
 * import { usePrivacyScreen } from "denext/mobile";
 *
 * export function Statement() {
 *   usePrivacyScreen();
 *   return <Transactions />;
 * }
 * ```
 */
export function usePrivacyScreen(enabled = true, options: PrivacyScreenOptions = {}): void {
  const { iosBlur, androidDim, preventScreenshots } = options;
  useEffect(() => {
    const plugin = enabled ? privacyPlugin() : undefined;
    if (!plugin) return undefined;
    if (holders++ === 0) {
      plugin.enable(enableConfig({ iosBlur, androidDim, preventScreenshots })).catch(() => {});
    }
    return () => {
      if (--holders === 0) plugin.disable().catch(() => {});
    };
  }, [enabled, iosBlur, androidDim, preventScreenshots]);
}
