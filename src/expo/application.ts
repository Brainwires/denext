/**
 * `expo-application` for denext: the app's name, id, version and build over `@capacitor/app`'s
 * `getInfo()`, and the vendor / Android ids over `@capacitor/device`'s `getId()` (`denext
 * mobile add device`; `@capacitor/app` comes with `deep-links` or `back`).
 *
 * Expo's constants are synchronous (JSI); the Capacitor bridge is not. In the shell they start
 * from the Expo app config (`globalThis.__DENEXT_EXPO_CONFIG__`: `name`, `version`,
 * `ios.bundleIdentifier` / `android.package`, `ios.buildNumber` / `android.versionCode`) and
 * are replaced by the native values once `getInfo()` answers, a moment after this module
 * loads. They are live bindings, so a read after that sees the native values; await
 * {@linkcode applicationInfoAsync} to be sure. On the web they are `null`, as in Expo's web
 * build.
 *
 * Install and update times, the install referrer and the push environment are not
 * observable through the plugins: those calls reject with `ERR_UNAVAILABLE`.
 *
 * @example
 * ```ts
 * import * as Application from "denext/expo/application";
 *
 * await Application.applicationInfoAsync();
 * console.log(Application.applicationId, Application.nativeApplicationVersion);
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { expoConfigGlobal, unavailable } from "./internal/common.ts";

/** How an iOS build was distributed. */
export enum ApplicationReleaseType {
  /** Not known (the only answer here outside a simulator). */
  UNKNOWN = 0,
  /** A simulator build. */
  SIMULATOR = 1,
  /** An enterprise build. */
  ENTERPRISE = 2,
  /** A development build. */
  DEVELOPMENT = 3,
  /** An ad hoc build. */
  AD_HOC = 4,
  /** An App Store build. */
  APP_STORE = 5,
}

/** The APNs environment of an iOS build. */
export type PushNotificationServiceEnvironment = "development" | "production" | null;

/** The JS side of `@capacitor/app` (the call read here). */
interface AppPlugin {
  getInfo(): Promise<{ name?: string; id?: string; build?: string; version?: string }>;
}

/** The JS side of `@capacitor/device` (the calls read here). */
interface DevicePlugin {
  getId(): Promise<{ identifier?: string }>;
  getInfo(): Promise<{ isVirtual?: boolean }>;
}

/** The app's human-readable name (`CFBundleDisplayName` / the Android label), or null. */
export let applicationName: string | null = null;
/** The bundle id (iOS) or application id (Android), or null. */
export let applicationId: string | null = null;
/** The version string (`CFBundleShortVersionString` / `versionName`), or null. */
export let nativeApplicationVersion: string | null = null;
/** The build (`CFBundleVersion` / `versionCode`), or null. */
export let nativeBuildVersion: string | null = null;

/** The Android id, once `@capacitor/device` has answered. */
let androidId: string | null = null;

/** The four constants, as {@linkcode applicationInfoAsync} reports them. */
export interface ApplicationInfo {
  /** {@linkcode applicationName}. */
  applicationName: string | null;
  /** {@linkcode applicationId}. */
  applicationId: string | null;
  /** {@linkcode nativeApplicationVersion}. */
  nativeApplicationVersion: string | null;
  /** {@linkcode nativeBuildVersion}. */
  nativeBuildVersion: string | null;
}

/** A string, or null for anything else (a number build code becomes its string). */
function text(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value !== "" ? value : null;
}

/** A nested object of the Expo config (`ios`, `android`), or an empty one. */
function section(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** Seed the constants from the Expo app config, for the shell's platform. */
function seedFromConfig(platform: "ios" | "android"): void {
  const config = expoConfigGlobal();
  if (!config) return;
  const own = section(config, platform);
  applicationName = text(config.name);
  nativeApplicationVersion = text(config.version);
  applicationId = text(platform === "ios" ? own.bundleIdentifier : own.package);
  nativeBuildVersion = text(platform === "ios" ? own.buildNumber : own.versionCode);
}

/** Read the native values (and, on Android, the Android id) into the constants. */
async function readNative(): Promise<void> {
  const app = nativePlugin<AppPlugin>("App", ["getInfo"]);
  const device = nativePlugin<DevicePlugin>("Device", ["getId"]);
  const [info, id] = await Promise.all([
    app?.getInfo().catch(() => null),
    nativePlatform() === "android" ? device?.getId().catch(() => null) : undefined,
  ]);
  if (info) {
    applicationName = text(info.name) ?? applicationName;
    applicationId = text(info.id) ?? applicationId;
    nativeApplicationVersion = text(info.version) ?? nativeApplicationVersion;
    nativeBuildVersion = text(info.build) ?? nativeBuildVersion;
  }
  if (id) androidId = text(id.identifier);
}

/** The native read, started once when this module loads inside the shell. */
let ready: Promise<void> = Promise.resolve();

/** Start over: seed and read the native values again (for tests and hot reload). */
function load(): void {
  const platform = nativePlatform();
  applicationName =
    applicationId =
    nativeApplicationVersion =
    nativeBuildVersion =
      null;
  androidId = null;
  if (platform === "web") {
    ready = Promise.resolve();
    return;
  }
  seedFromConfig(platform);
  ready = readNative();
}

load();

/**
 * The constants once the shell's `@capacitor/app` has answered (denext only; Expo's are
 * ready synchronously). Resolves at once on the web.
 *
 * @returns The name, id, version and build.
 */
export async function applicationInfoAsync(): Promise<ApplicationInfo> {
  await ready;
  return { applicationName, applicationId, nativeApplicationVersion, nativeBuildVersion };
}

/**
 * Re-read the constants for the current platform: the Expo config, then the native plugins.
 * For tests that switch between a faked shell and the web.
 *
 * @returns The constants, once read.
 */
export function reloadApplicationInfoForTesting(): Promise<ApplicationInfo> {
  load();
  return applicationInfoAsync();
}

/**
 * The Android id (`Settings.Secure.ANDROID_ID`, per app-signing key, user and device), from
 * `@capacitor/device`'s `getId()`. Android only.
 *
 * @returns The id.
 * @throws `ERR_UNAVAILABLE` off Android, and on Android before the plugin has answered (await
 *   {@linkcode applicationInfoAsync}) or without `@capacitor/device`.
 */
export function getAndroidId(): string {
  if (nativePlatform() !== "android") {
    throw unavailable("expo-application", "getAndroidId", "It exists on Android only.");
  }
  if (androidId === null) {
    throw unavailable(
      "expo-application",
      "getAndroidId",
      "It is read from @capacitor/device (`denext mobile add device`) once the app starts; " +
        "await applicationInfoAsync() first.",
    );
  }
  return androidId;
}

/**
 * The Play install referrer. No Capacitor plugin reads it.
 *
 * @returns Never resolves.
 * @throws `ERR_UNAVAILABLE`, always.
 */
export function getInstallReferrerAsync(): Promise<string> {
  return Promise.reject(
    unavailable(
      "expo-application",
      "getInstallReferrerAsync",
      "No Capacitor plugin reads the Play install referrer.",
    ),
  );
}

/** Reject off iOS with `name`'s unavailability. */
function requireIos(name: string): void {
  if (nativePlatform() !== "ios") {
    throw unavailable("expo-application", name, "It exists in the iOS shell only.");
  }
}

/**
 * The iOS `identifierForVendor`, from `@capacitor/device`'s `getId()`.
 *
 * @returns The id, or null without `@capacitor/device`.
 * @throws `ERR_UNAVAILABLE` outside the iOS shell.
 */
export async function getIosIdForVendorAsync(): Promise<string | null> {
  requireIos("getIosIdForVendorAsync");
  const device = nativePlugin<DevicePlugin>("Device", ["getId"]);
  return device ? text((await device.getId()).identifier) : null;
}

/**
 * How the iOS build was distributed: `SIMULATOR` in a simulator (from `@capacitor/device`),
 * else `UNKNOWN` (the provisioning profile is not readable from the web view).
 *
 * @returns The release type.
 * @throws `ERR_UNAVAILABLE` outside the iOS shell.
 */
export async function getIosApplicationReleaseTypeAsync(): Promise<ApplicationReleaseType> {
  requireIos("getIosApplicationReleaseTypeAsync");
  const device = nativePlugin<DevicePlugin>("Device", ["getInfo"]);
  const info = await device?.getInfo().catch(() => null);
  return info?.isVirtual === true
    ? ApplicationReleaseType.SIMULATOR
    : ApplicationReleaseType.UNKNOWN;
}

/**
 * The APNs environment of the iOS build. Not readable from the web view.
 *
 * @returns `null` (unknown).
 * @throws `ERR_UNAVAILABLE` outside the iOS shell.
 */
export async function getIosPushNotificationServiceEnvironmentAsync(): Promise<
  PushNotificationServiceEnvironment
> {
  requireIos("getIosPushNotificationServiceEnvironmentAsync");
  return await Promise.resolve(null);
}

/**
 * When the app was installed. No Capacitor plugin reports it.
 *
 * @returns Never resolves.
 * @throws `ERR_UNAVAILABLE`, always.
 */
export function getInstallationTimeAsync(): Promise<Date> {
  return Promise.reject(
    unavailable("expo-application", "getInstallationTimeAsync", "No Capacitor plugin reports it."),
  );
}

/**
 * When the app was last updated. No Capacitor plugin reports it.
 *
 * @returns Never resolves.
 * @throws `ERR_UNAVAILABLE`, always.
 */
export function getLastUpdateTimeAsync(): Promise<Date> {
  return Promise.reject(
    unavailable("expo-application", "getLastUpdateTimeAsync", "No Capacitor plugin reports it."),
  );
}
