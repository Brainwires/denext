/**
 * `expo-tracking-transparency` for denext: Apple's App Tracking Transparency prompt over
 * `denext/mobile`'s {@linkcode getTrackingStatus} / {@linkcode requestTrackingPermission}
 * (`capacitor-plugin-app-tracking-transparency` 3, Capacitor 8, installed by `denext mobile
 * add tracking`, which also writes `NSUserTrackingUsageDescription` into Info.plist).
 *
 * - In the iOS shell with the plugin, the permission calls report the ATT status and
 *   {@linkcode requestTrackingPermissionsAsync} shows the system prompt (once per install,
 *   as on iOS). `restricted` reads as denied, and a denial cannot be asked again.
 * - In the iOS shell without the plugin, tracking is not determined and cannot be asked for:
 *   the calls report `undetermined` with `canAskAgain: false` and {@linkcode isAvailable} is
 *   `false`. Install the plugin before you track.
 * - On Android and the web there is no ATT: the calls report `granted`, as Expo's own
 *   Android and web builds do, and {@linkcode isAvailable} is `false`.
 *
 * {@linkcode getAdvertisingId} is always `null`: the plugin does not read the IDFA / AAID.
 *
 * @example
 * ```ts
 * import { requestTrackingPermissionsAsync } from "denext/expo/tracking-transparency";
 *
 * const { granted } = await requestTrackingPermissionsAsync();
 * if (granted) enableAttribution();
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import {
  getTrackingStatus,
  requestTrackingPermission,
  type TrackingStatus,
} from "../mobile/tracking.ts";
import {
  createPermissionHook,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionHookOptions, PermissionResponse };

/**
 * `denext/mobile`'s ATT status as Expo's permission answer. `unavailable` is Expo's `granted`
 * off iOS (no ATT there), and an undetermined status that cannot be asked in the iOS shell
 * without the plugin.
 */
function toResponse(status: TrackingStatus): PermissionResponse {
  switch (status) {
    case "authorized":
      return permissionResponse(PermissionStatus.GRANTED);
    case "not-determined":
      return permissionResponse(PermissionStatus.UNDETERMINED);
    case "denied":
    case "restricted":
      return { ...permissionResponse(PermissionStatus.DENIED), canAskAgain: false };
    default:
      return nativePlatform() === "ios"
        ? { ...permissionResponse(PermissionStatus.UNDETERMINED), canAskAgain: false }
        : permissionResponse(PermissionStatus.GRANTED);
  }
}

/**
 * The tracking permission, without prompting.
 *
 * @returns The ATT status in the iOS shell with the plugin; `undetermined` (cannot ask) in
 *   the iOS shell without it; `granted` on Android and the web.
 */
export async function getTrackingPermissionsAsync(): Promise<PermissionResponse> {
  return toResponse(await getTrackingStatus());
}

/**
 * Ask for the tracking permission: the system ATT prompt in the iOS shell (shown once per
 * install; later calls report the stored answer).
 *
 * @returns The answer; see {@linkcode getTrackingPermissionsAsync} for the other platforms.
 */
export async function requestTrackingPermissionsAsync(): Promise<PermissionResponse> {
  return toResponse(await requestTrackingPermission());
}

/** Hook form of the tracking permission: `[response, request, get]`. */
export const useTrackingPermissions: (
  options?: PermissionHookOptions<object>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = /* @__PURE__ */ createPermissionHook({
  getMethod: getTrackingPermissionsAsync,
  requestMethod: requestTrackingPermissionsAsync,
});

/**
 * Whether App Tracking Transparency can be asked for here: the iOS shell with the
 * `AppTrackingTransparency` plugin installed (Expo's call is synchronous, so this checks the
 * plugin's presence rather than asking it).
 *
 * @returns `true` only there.
 */
export function isAvailable(): boolean {
  return nativePlatform() === "ios" &&
    nativePlugin("AppTrackingTransparency", ["getStatus", "requestPermission"]) !== undefined;
}

/**
 * The advertising id (IDFA / AAID). The plugin does not read it, so this is always `null`,
 * as it is in Expo's web build and on iOS without permission.
 *
 * @returns `null`.
 */
export function getAdvertisingId(): string | null {
  return null;
}
