/**
 * App Tracking Transparency for `denext/mobile`: ask iOS for permission to track the user
 * across other companies' apps and websites (the IDFA, cross-app attribution), through
 * `capacitor-plugin-app-tracking-transparency` (installed by `denext mobile add tracking`,
 * which also writes `NSUserTrackingUsageDescription`). ATT exists only on iOS 14+: on Android
 * and the web these report `"unavailable"`, and whatever consent rules apply there (GDPR,
 * Play's policies) are the app's own.
 *
 * @module
 */

import { nativePlatform } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";

/**
 * The ATT status:
 *
 * - `authorized`: the user allowed tracking.
 * - `denied`: the user refused (or turned "Allow Apps to Request to Track" off); only the
 *   Settings app can change it.
 * - `restricted`: tracking is blocked by the device (parental controls, a managed device).
 * - `not-determined`: never asked; {@linkcode requestTrackingPermission} shows the prompt.
 * - `unavailable`: not iOS, or the plugin is not installed.
 */
export type TrackingStatus =
  | "authorized"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unavailable";

/** The JS side of `capacitor-plugin-app-tracking-transparency` (3.x). */
interface TrackingPlugin {
  getStatus(): Promise<{ status?: string }>;
  requestPermission(): Promise<{ status?: string }>;
}

/** The plugin's status, named. */
function toStatus(raw: { status?: string } | undefined): TrackingStatus {
  switch (raw?.status) {
    case "authorized":
      return "authorized";
    case "denied":
      return "denied";
    case "restricted":
      return "restricted";
    case "notDetermined":
      return "not-determined";
    default:
      return "unavailable";
  }
}

/** The plugin on iOS, else undefined. */
function trackingPlugin(): TrackingPlugin | undefined {
  return nativePlatform() === "ios"
    ? nativePlugin<TrackingPlugin>("AppTrackingTransparency", ["getStatus", "requestPermission"])
    : undefined;
}

/**
 * Read the ATT status without prompting.
 *
 * @returns The status; `"unavailable"` off iOS or without the plugin.
 * @example
 * ```ts
 * import { getTrackingStatus } from "denext/mobile";
 * if ((await getTrackingStatus()) === "authorized") analytics.enableAdAttribution();
 * ```
 */
export async function getTrackingStatus(): Promise<TrackingStatus> {
  const plugin = trackingPlugin();
  return plugin ? toStatus(await plugin.getStatus()) : "unavailable";
}

/**
 * Show iOS's "Allow … to track your activity" prompt (once: after an answer iOS only reports
 * it). App Store guideline 5.1.2 requires this before any tracking, and the prompt shows
 * `NSUserTrackingUsageDescription` as its reason. iOS ignores the request while the app is not
 * active, so call it after launch settles (for example from the first screen's effect), not
 * during startup.
 *
 * @returns The status after the prompt; `"unavailable"` off iOS or without the plugin.
 * @example
 * ```ts
 * import { requestTrackingPermission } from "denext/mobile";
 * const status = await requestTrackingPermission();
 * if (status === "authorized") ads.personalize();
 * ```
 */
export async function requestTrackingPermission(): Promise<TrackingStatus> {
  const plugin = trackingPlugin();
  return plugin ? toStatus(await plugin.requestPermission()) : "unavailable";
}
