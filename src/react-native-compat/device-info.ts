/**
 * `react-native-device-info` for denext's React Native mode: every export of the package, over
 * `denext/mobile`'s {@linkcode deviceInfo} (`@capacitor/device`, `denext mobile add device`),
 * `denext/expo/application`'s app facts (`@capacitor/app`) and web APIs.
 *
 * - In the Capacitor shell: the model, OS name and version, emulator flag, device type, the app's
 *   name / bundle id / version / build number, the unique id (Android ID / identifierForVendor)
 *   and Apple's brand / manufacturer are real. The synchronous getters answer at once from what
 *   is already known (the user agent, the Expo config) and turn native a moment after the first
 *   call, which starts the one native read (nothing is read at import); await any async getter
 *   (or {@linkcode getUniqueId}) first for the native values.
 * - Everywhere: the package's web build — battery and power state (`navigator.getBattery`),
 *   memory (`performance.memory`, `navigator.deviceMemory`), disk (`navigator.storage`),
 *   camera presence (`enumerateDevices`), the user agent, the base OS, the referrer, and
 *   location availability.
 * - Everything else answers the package's own default for a platform without it (`"unknown"`,
 *   `-1`, `false`, `[]`, `{}`), as its web build does: the Android build fields, the carrier,
 *   the IP / MAC addresses, the device name, install times, headphones, brightness, …
 *
 * `hasNotch` / `hasDynamicIsland` are heuristics (iPhone screen size and model identifier), not
 * the package's device tables. On the web (outside the shell) the device and app getters return
 * the package's web answers (`"unknown"`), not guesses from the user agent.
 *
 * In React Native mode `import DeviceInfo from "react-native-device-info"` resolves here.
 *
 * @example
 * ```ts
 * import DeviceInfo from "react-native-device-info";
 *
 * console.log(DeviceInfo.getSystemName(), DeviceInfo.getSystemVersion(), DeviceInfo.getVersion());
 * const id = await DeviceInfo.getUniqueId();
 * ```
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useState } from "../runtime/hooks.ts";
import { deviceInfo, parseUserAgent } from "../mobile/device.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import {
  applicationId,
  applicationInfoAsync,
  applicationName,
  getAndroidId as expoAndroidId,
  getIosIdForVendorAsync,
  nativeApplicationVersion,
  nativeBuildVersion,
} from "../expo/application.ts";

/** High-level classification of the device hardware. */
export type DeviceType = "Handset" | "Tablet" | "Tv" | "Desktop" | "GamingConsole" | "unknown";

/** A battery state. */
export type BatteryState = "unknown" | "unplugged" | "charging" | "full";

/** The device's power conditions. */
export interface PowerState {
  /** 0–1. */
  batteryLevel: number;
  /** The battery state. */
  batteryState: BatteryState;
  /** Low power mode (always `false` here). */
  lowPowerMode: boolean;
  /** Anything else the platform reports (`chargingtime`, `dischargingtime` on the web). */
  [key: string]: unknown;
}

/** Which location providers are on. */
export interface LocationProviderInfo {
  /** Provider → enabled. */
  [key: string]: boolean;
}

/** What the asynchronous hooks return. */
export interface AsyncHookResult<T> {
  /** Still reading the first value. */
  loading: boolean;
  /** The value (the default while loading). */
  result: T;
}

/** Google Play's App Set ID (`{ id: "unknown", scope: -1 }` here). */
export interface AppSetIdInfo {
  /** The id. */
  id: string;
  /** Its scope. */
  scope: number;
}

// ---- the facts the shell knows ----------------------------------------------------------------

/** What is known about the device, synchronously. */
interface Facts {
  model?: string;
  osVersion?: string;
  isVirtual?: boolean;
  uniqueId?: string;
}

/** The facts read so far (starts from the user agent on the first call). */
let facts: Facts | null = null;
/** The one native read, started by the first getter. */
let reading: Promise<Facts> | null = null;

/** The page's user agent, or `""`. */
function userAgent(): string {
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "";
}

/** Whether this runs in the iOS or Android shell. */
function inShell(): boolean {
  return nativePlatform() !== "web";
}

/** The native read: the device's model / OS / emulator flag and its unique id. */
async function readNative(): Promise<Facts> {
  const [info, uniqueId] = await Promise.all([
    deviceInfo().catch(() => null),
    readUniqueId(),
  ]);
  facts = {
    ...facts,
    ...(info?.model ? { model: info.model } : {}),
    ...(info?.osVersion ? { osVersion: info.osVersion } : {}),
    ...(typeof info?.isVirtual === "boolean" ? { isVirtual: info.isVirtual } : {}),
    ...(uniqueId ? { uniqueId } : {}),
  };
  return facts;
}

/** The Android ID or identifierForVendor, or null. */
async function readUniqueId(): Promise<string | null> {
  try {
    if (nativePlatform() === "ios") return await getIosIdForVendorAsync();
    await applicationInfoAsync();
    return expoAndroidId();
  } catch {
    return null;
  }
}

/** The facts known now; the first call starts the native read (in the shell). */
function known(): Facts {
  if (facts === null) {
    facts = inShell() ? parseUserAgent(userAgent()) : {};
    if (inShell()) reading = readNative();
  }
  return facts;
}

/** The facts once the native read finished. */
async function loaded(): Promise<Facts> {
  known();
  return reading ? await reading.catch(() => facts ?? {}) : facts ?? {};
}

/** Forget what was read (tests only). */
export function resetDeviceInfoForTesting(): void {
  facts = null;
  reading = null;
}

/** An async getter that resolves `value`. */
function resolves<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

/** A sync getter that returns `value`. */
function returns<T>(value: T): () => T {
  return () => value;
}

/** `value` when it is a non-empty string, else `"unknown"`. */
function orUnknown(value: string | null | undefined): string {
  return typeof value === "string" && value !== "" ? value : "unknown";
}

// ---- identity ----------------------------------------------------------------------------------

/** The unique id (Android ID / identifierForVendor in the shell), or `"unknown"`. */
export async function getUniqueId(): Promise<string> {
  if (!inShell()) return "unknown";
  return orUnknown((await loaded()).uniqueId);
}

/** {@linkcode getUniqueId}, synchronously: `"unknown"` until the native read finished. */
export function getUniqueIdSync(): string {
  return inShell() ? orUnknown(known().uniqueId) : "unknown";
}

/** Read the unique id so {@linkcode getUniqueIdSync} has it. */
export function syncUniqueId(): Promise<string> {
  return getUniqueId();
}

/** The Android ID in the Android shell, else `"unknown"`. */
export async function getAndroidId(): Promise<string> {
  return nativePlatform() === "android" ? await getUniqueId() : "unknown";
}

/** {@linkcode getAndroidId}, synchronously. */
export function getAndroidIdSync(): string {
  return nativePlatform() === "android" ? getUniqueIdSync() : "unknown";
}

/** Android's instance id: `"unknown"`. */
export const getInstanceId: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's instance id: `"unknown"`. */
export const getInstanceIdSync: () => string = /* @__PURE__ */ returns("unknown");
/** The serial number: `"unknown"`. */
export const getSerialNumber: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** The serial number: `"unknown"`. */
export const getSerialNumberSync: () => string = /* @__PURE__ */ returns("unknown");
/** Google Play's App Set ID: `{ id: "unknown", scope: -1 }`. */
export function getAppSetId(): Promise<AppSetIdInfo> {
  return Promise.resolve({ id: "unknown", scope: -1 });
}
/** The IP address: `"unknown"`. */
export const getIpAddress: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** The IP address: `"unknown"`. */
export const getIpAddressSync: () => string = /* @__PURE__ */ returns("unknown");

/** The MAC address: iOS's fixed `"02:00:00:00:00:00"`, else `"unknown"`. */
export function getMacAddressSync(): string {
  return nativePlatform() === "ios" ? "02:00:00:00:00:00" : "unknown";
}
/** {@linkcode getMacAddressSync}, asynchronously. */
export function getMacAddress(): Promise<string> {
  return Promise.resolve(getMacAddressSync());
}
/** The DeviceCheck token: `"unknown"`. */
export const getDeviceToken: () => Promise<string> = /* @__PURE__ */ resolves("unknown");

// ---- the device ----------------------------------------------------------------------------------

/** The model identifier in the shell (`"iPhone15,2"`, `"Pixel 8"`), else `"unknown"`. */
export function getDeviceId(): string {
  return inShell() ? orUnknown(known().model) : "unknown";
}

/** The model in the shell (the identifier, not a marketing name), else `"unknown"`. */
export function getModel(): string {
  return getDeviceId();
}

/** `"Apple"` in the iOS shell, else `"unknown"`. */
export function getBrand(): string {
  return nativePlatform() === "ios" ? "Apple" : "unknown";
}

/** {@linkcode getManufacturer}, synchronously: `"Apple"` in the iOS shell, else `"unknown"`. */
export function getManufacturerSync(): string {
  return getBrand();
}
/** The manufacturer: `"Apple"` in the iOS shell, else `"unknown"`. */
export function getManufacturer(): Promise<string> {
  return Promise.resolve(getManufacturerSync());
}

/** `"iOS"` / `"iPadOS"` / `"Android"` in the shell, else `"unknown"`. */
export function getSystemName(): string {
  const platform = nativePlatform();
  if (platform === "android") return "Android";
  if (platform !== "ios") return "unknown";
  return /iPad/.test(userAgent()) ? "iPadOS" : "iOS";
}

/** The OS version in the shell (`"17.5"`), else `"unknown"`. */
export function getSystemVersion(): string {
  return inShell() ? orUnknown(known().osVersion) : "unknown";
}

/** `"Handset"` / `"Tablet"` in the shell, else `"unknown"`. */
export function getDeviceTypeSync(): DeviceType {
  if (!inShell()) return "unknown";
  const ua = userAgent();
  return /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
    ? "Tablet"
    : "Handset";
}
/** {@linkcode getDeviceTypeSync} (the package's getter is synchronous too). */
export function getDeviceType(): DeviceType {
  return getDeviceTypeSync();
}

/** Whether the shell runs on a tablet. */
export function isTablet(): boolean {
  return getDeviceTypeSync() === "Tablet";
}

/** The screen's long side in CSS px, or 0. */
function screenLongSide(): number {
  const screen = (globalThis as { screen?: { width?: number; height?: number } }).screen;
  return Math.max(screen?.width ?? 0, screen?.height ?? 0);
}

/** An iPhone model identifier's major number (`iPhone15,2` → 15), or 0. */
function iphoneMajor(): number {
  const m = /^iPhone(\d+),(\d+)$/.exec(known().model ?? "");
  return m ? Number(m[1]) : 0;
}

/** Whether the iOS shell runs on an iPhone with a notch or Dynamic Island (screen ≥ 812 pt). */
export function hasNotch(): boolean {
  return nativePlatform() === "ios" && !/iPad/.test(userAgent()) && screenLongSide() >= 812;
}

/**
 * Whether the iOS shell runs on an iPhone with a Dynamic Island: iPhone 14 Pro and later by
 * model identifier (`iPhone15,2`+, except iPhone 14 / 14 Plus and 16e).
 */
export function hasDynamicIsland(): boolean {
  if (nativePlatform() !== "ios") return false;
  const model = known().model ?? "";
  if (model === "iPhone17,5") return false;
  return iphoneMajor() >= 15;
}

/** Whether the shell runs in a simulator or emulator (`false` elsewhere). */
export async function isEmulator(): Promise<boolean> {
  return inShell() ? (await loaded()).isVirtual === true : false;
}
/** {@linkcode isEmulator}, synchronously: `false` until the native read finished. */
export function isEmulatorSync(): boolean {
  return inShell() ? known().isVirtual === true : false;
}

/** The device name: `"unknown"`. */
export const getDeviceName: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** The device name: `"unknown"`. */
export const getDeviceNameSync: () => string = /* @__PURE__ */ returns("unknown");
/** The font scale: `-1`. */
export const getFontScale: () => Promise<number> = /* @__PURE__ */ resolves(-1);
/** The font scale: `-1`. */
export const getFontScaleSync: () => number = /* @__PURE__ */ returns(-1);
/** The OS build id: `"unknown"`. */
export const getBuildId: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** The OS build id: `"unknown"`. */
export const getBuildIdSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's API level: `-1`. */
export const getApiLevel: () => Promise<number> = /* @__PURE__ */ resolves(-1);
/** Android's API level: `-1`. */
export const getApiLevelSync: () => number = /* @__PURE__ */ returns(-1);
/** Android's bootloader: `"unknown"`. */
export const getBootloader: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's bootloader: `"unknown"`. */
export const getBootloaderSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's device: `"unknown"`. */
export const getDevice: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's device: `"unknown"`. */
export const getDeviceSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's display: `"unknown"`. */
export const getDisplay: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's display: `"unknown"`. */
export const getDisplaySync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's fingerprint: `"unknown"`. */
export const getFingerprint: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's fingerprint: `"unknown"`. */
export const getFingerprintSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's hardware: `"unknown"`. */
export const getHardware: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's hardware: `"unknown"`. */
export const getHardwareSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's host: `"unknown"`. */
export const getHost: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's host: `"unknown"`. */
export const getHostSync: () => string = /* @__PURE__ */ returns("unknown");
/** Windows' host names: `[]`. */
export function getHostNames(): Promise<string[]> {
  return Promise.resolve([]);
}
/** Windows' host names: `[]`. */
export function getHostNamesSync(): string[] {
  return [];
}
/** Android's product: `"unknown"`. */
export const getProduct: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's product: `"unknown"`. */
export const getProductSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's build tags: `"unknown"`. */
export const getTags: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's build tags: `"unknown"`. */
export const getTagsSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's build type: `"unknown"`. */
export const getType: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's build type: `"unknown"`. */
export const getTypeSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's preview SDK: `-1`. */
export const getPreviewSdkInt: () => Promise<number> = /* @__PURE__ */ resolves(-1);
/** Android's preview SDK: `-1`. */
export const getPreviewSdkIntSync: () => number = /* @__PURE__ */ returns(-1);
/** Android's security patch: `"unknown"`. */
export const getSecurityPatch: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's security patch: `"unknown"`. */
export const getSecurityPatchSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's codename: `"unknown"`. */
export const getCodename: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's codename: `"unknown"`. */
export const getCodenameSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's incremental: `"unknown"`. */
export const getIncremental: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** Android's incremental: `"unknown"`. */
export const getIncrementalSync: () => string = /* @__PURE__ */ returns("unknown");
/** Android's low-RAM flag: `false`. */
export const isLowRamDevice: () => boolean = /* @__PURE__ */ returns(false);
/** iOS's display zoom: `false`. */
export const isDisplayZoomed: () => boolean = /* @__PURE__ */ returns(false);
/** Whether a PIN or fingerprint is set: `false`. */
export const isPinOrFingerprintSet: () => Promise<boolean> = /* @__PURE__ */ resolves(false);
/** Whether a PIN or fingerprint is set: `false`. */
export const isPinOrFingerprintSetSync: () => boolean = /* @__PURE__ */ returns(false);
/** Google Mobile Services: `false`. */
export const hasGms: () => Promise<boolean> = /* @__PURE__ */ resolves(false);
/** Google Mobile Services: `false`. */
export const hasGmsSync: () => boolean = /* @__PURE__ */ returns(false);
/** Huawei Mobile Services: `false`. */
export const hasHms: () => Promise<boolean> = /* @__PURE__ */ resolves(false);
/** Huawei Mobile Services: `false`. */
export const hasHmsSync: () => boolean = /* @__PURE__ */ returns(false);
/** The carrier: `"unknown"`. */
export const getCarrier: () => Promise<string> = /* @__PURE__ */ resolves("unknown");
/** The carrier: `"unknown"`. */
export const getCarrierSync: () => string = /* @__PURE__ */ returns("unknown");
/** The supported ABIs: `[]`. */
export function supportedAbis(): Promise<string[]> {
  return Promise.resolve([]);
}
/** The supported ABIs: `[]`. */
export function supportedAbisSync(): string[] {
  return [];
}
/** The supported 32-bit ABIs: `[]`. */
export const supported32BitAbis: () => Promise<string[]> = supportedAbis;
/** The supported 32-bit ABIs: `[]`. */
export const supported32BitAbisSync: () => string[] = supportedAbisSync;
/** The supported 64-bit ABIs: `[]`. */
export const supported64BitAbis: () => Promise<string[]> = supportedAbis;
/** The supported 64-bit ABIs: `[]`. */
export const supported64BitAbisSync: () => string[] = supportedAbisSync;
/** Android's system features: `false`. */
export function hasSystemFeature(_feature: string): Promise<boolean> {
  return Promise.resolve(false);
}
/** Android's system features: `false`. */
export function hasSystemFeatureSync(_feature: string): boolean {
  return false;
}
/** Android's system features: `[]`. */
export const getSystemAvailableFeatures: () => Promise<string[]> = supportedAbis;
/** Android's system features: `[]`. */
export const getSystemAvailableFeaturesSync: () => string[] = supportedAbisSync;
/** Android's supported media types: `[]`. */
export const getSupportedMediaTypeList: () => Promise<string[]> = supportedAbis;
/** Android's supported media types: `[]`. */
export const getSupportedMediaTypeListSync: () => string[] = supportedAbisSync;
/** The location providers: `{}`. */
export function getAvailableLocationProviders(): Promise<LocationProviderInfo> {
  return Promise.resolve({});
}
/** The location providers: `{}`. */
export function getAvailableLocationProvidersSync(): LocationProviderInfo {
  return {};
}
/** Headphones: `false`. */
export const isHeadphonesConnected: () => Promise<boolean> = /* @__PURE__ */ resolves(false);
/** Headphones: `false`. */
export const isHeadphonesConnectedSync: () => boolean = /* @__PURE__ */ returns(false);
/** Wired headphones: `false`. */
export const isWiredHeadphonesConnected: () => Promise<boolean> = isHeadphonesConnected;
/** Wired headphones: `false`. */
export const isWiredHeadphonesConnectedSync: () => boolean = isHeadphonesConnectedSync;
/** Bluetooth headphones: `false`. */
export const isBluetoothHeadphonesConnected: () => Promise<boolean> = isHeadphonesConnected;
/** Bluetooth headphones: `false`. */
export const isBluetoothHeadphonesConnectedSync: () => boolean = isHeadphonesConnectedSync;
/** Windows' mouse: `false`. */
export const isMouseConnected: () => Promise<boolean> = isHeadphonesConnected;
/** Windows' mouse: `false`. */
export const isMouseConnectedSync: () => boolean = isHeadphonesConnectedSync;
/** Windows' keyboard: `false`. */
export const isKeyboardConnected: () => Promise<boolean> = isHeadphonesConnected;
/** Windows' keyboard: `false`. */
export const isKeyboardConnectedSync: () => boolean = isHeadphonesConnectedSync;
/** Windows' tablet mode: `false`. */
export const isTabletMode: () => Promise<boolean> = isHeadphonesConnected;
/** Airplane mode: `false` (no API reports it). */
export const isAirplaneMode: () => Promise<boolean> = isHeadphonesConnected;
/** Airplane mode: `false` (no API reports it). */
export const isAirplaneModeSync: () => boolean = isHeadphonesConnectedSync;
/** The screen brightness: `-1`. */
export const getBrightness: () => Promise<number> = getFontScale;
/** The screen brightness: `-1`. */
export const getBrightnessSync: () => number = getFontScaleSync;
/** The first install time: `-1`. */
export const getFirstInstallTime: () => Promise<number> = getFontScale;
/** The first install time: `-1`. */
export const getFirstInstallTimeSync: () => number = getFontScaleSync;
/** The last update time: `-1`. */
export const getLastUpdateTime: () => Promise<number> = getFontScale;
/** The last update time: `-1`. */
export const getLastUpdateTimeSync: () => number = getFontScaleSync;
/** The startup time: `-1`. */
export const getStartupTime: () => Promise<number> = getFontScale;
/** The startup time: `-1`. */
export const getStartupTimeSync: () => number = getFontScaleSync;
/** The installer package: `"unknown"`. */
export const getInstallerPackageName: () => Promise<string> = getIpAddress;
/** The installer package: `"unknown"`. */
export const getInstallerPackageNameSync: () => string = getIpAddressSync;

// ---- the app -------------------------------------------------------------------------------------

/** The app's bundle id / package name in the shell, else `"unknown"`. */
export function getBundleId(): string {
  return inShell() ? orUnknown(applicationId) : "unknown";
}

/** The app's name in the shell, else `"unknown"`. */
export function getApplicationName(): string {
  return inShell() ? orUnknown(applicationName) : "unknown";
}

/** The app's build number in the shell, else `"unknown"`. */
export function getBuildNumber(): string {
  return inShell() ? orUnknown(nativeBuildVersion) : "unknown";
}

/** The app's version in the shell, else `"unknown"`. */
export function getVersion(): string {
  return inShell() ? orUnknown(nativeApplicationVersion) : "unknown";
}

/** `<version>.<build number>`. */
export function getReadableVersion(): string {
  return getVersion() + "." + getBuildNumber();
}

// ---- the package's web build ---------------------------------------------------------------------

/** The page's navigator, as the web getters read it. */
interface WebNavigator {
  userAgent?: string;
  platform?: string;
  deviceMemory?: number;
  geolocation?: unknown;
  getBattery?: () => Promise<BatteryLike>;
  storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> };
  mediaDevices?: { enumerateDevices?: () => Promise<Array<{ kind: string }>> };
}

/** The Battery Status API's manager. */
interface BatteryLike {
  level: number;
  charging: boolean;
  chargingTime?: number;
  dischargingTime?: number;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** The navigator, or `{}`. */
function nav(): WebNavigator {
  return (globalThis as { navigator?: WebNavigator }).navigator ?? {};
}

/** `performance.memory` (Chromium), or undefined. */
function heap(): { jsHeapSizeLimit?: number; usedJSHeapSize?: number } | undefined {
  return (globalThis as { performance?: { memory?: Record<string, number> } }).performance
    ?.memory;
}

/** The user agent (`"unknown"` without one). */
export function getUserAgentSync(): string {
  return orUnknown(userAgent());
}
/** The user agent (`"unknown"` without one). */
export function getUserAgent(): Promise<string> {
  return Promise.resolve(getUserAgentSync());
}

/** The base OS, from `navigator.platform` and the user agent (the package's web logic). */
export function getBaseOsSync(): string {
  const platform = nav().platform ?? "";
  if (["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(platform)) return "Mac OS";
  if (["iPhone", "iPad", "iPod"].includes(platform)) return "iOS";
  if (["Win32", "Win64", "Windows", "WinCE"].includes(platform)) return "Windows";
  if (/Android/.test(userAgent())) return "Android";
  if (!platform) return "unknown";
  return platform;
}
/** {@linkcode getBaseOsSync}, asynchronously. */
export function getBaseOs(): Promise<string> {
  return Promise.resolve(getBaseOsSync());
}

/** The referrer on the web; `"unknown"` in the shell. */
export function getInstallReferrerSync(): string {
  if (inShell()) return "unknown";
  const doc = (globalThis as { document?: { referrer?: string } }).document;
  return doc?.referrer ?? "unknown";
}
/** {@linkcode getInstallReferrerSync}, asynchronously. */
export function getInstallReferrer(): Promise<string> {
  return Promise.resolve(getInstallReferrerSync());
}

/** The JS heap limit (Chromium's `performance.memory`), or `-1`. */
export function getMaxMemorySync(): number {
  return heap()?.jsHeapSizeLimit ?? -1;
}
/** {@linkcode getMaxMemorySync}, asynchronously. */
export function getMaxMemory(): Promise<number> {
  return Promise.resolve(getMaxMemorySync());
}
/** The used JS heap (Chromium's `performance.memory`), or `-1`. */
export function getUsedMemorySync(): number {
  return heap()?.usedJSHeapSize ?? -1;
}
/** {@linkcode getUsedMemorySync}, asynchronously. */
export function getUsedMemory(): Promise<number> {
  return Promise.resolve(getUsedMemorySync());
}
/** The device memory (`navigator.deviceMemory` × 10⁹), or `-1`. */
export function getTotalMemorySync(): number {
  const gb = nav().deviceMemory;
  return typeof gb === "number" ? gb * 1_000_000_000 : -1;
}
/** {@linkcode getTotalMemorySync}, asynchronously. */
export function getTotalMemory(): Promise<number> {
  return Promise.resolve(getTotalMemorySync());
}

/** The storage estimate, or null. */
async function estimate(): Promise<{ quota?: number; usage?: number } | null> {
  const fn = nav().storage?.estimate;
  return typeof fn === "function" ? await fn.call(nav().storage).catch(() => null) : null;
}
/** The storage quota (`navigator.storage.estimate()`), or `-1`. */
export async function getTotalDiskCapacity(): Promise<number> {
  return (await estimate())?.quota ?? -1;
}
/** Not available synchronously: `-1`. */
export const getTotalDiskCapacitySync: () => number = getFontScaleSync;
/** The storage quota left (`quota - usage`), or `-1`. */
export async function getFreeDiskStorage(): Promise<number> {
  const e = await estimate();
  return e?.quota === undefined ? -1 : e.quota - (e.usage ?? 0);
}
/** Not available synchronously: `-1`. */
export const getFreeDiskStorageSync: () => number = getFontScaleSync;
/** {@linkcode getTotalDiskCapacity} (the pre-iOS-11 variant). */
export const getTotalDiskCapacityOld: () => Promise<number> = getTotalDiskCapacity;
/** Not available synchronously: `-1`. */
export const getTotalDiskCapacityOldSync: () => number = getFontScaleSync;
/** {@linkcode getFreeDiskStorage} (the pre-iOS-11 variant). */
export const getFreeDiskStorageOld: () => Promise<number> = getFreeDiskStorage;
/** Not available synchronously: `-1`. */
export const getFreeDiskStorageOldSync: () => number = getFontScaleSync;

/** Whether a camera is attached (`enumerateDevices`). */
export async function isCameraPresent(): Promise<boolean> {
  const fn = nav().mediaDevices?.enumerateDevices;
  if (typeof fn !== "function") return false;
  const devices = await fn.call(nav().mediaDevices).catch(() => []);
  return devices.some((d) => d.kind === "videoinput");
}
/** Not available synchronously: `false` (use {@linkcode isCameraPresent}). */
export const isCameraPresentSync: () => boolean = isHeadphonesConnectedSync;

/** Whether the page has a geolocation API. */
export function isLocationEnabledSync(): boolean {
  return !!nav().geolocation;
}
/** {@linkcode isLocationEnabledSync}, asynchronously. */
export function isLocationEnabled(): Promise<boolean> {
  return Promise.resolve(isLocationEnabledSync());
}

/** Whether the window is at least as wide as it is tall. */
export function isLandscapeSync(): boolean {
  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  return (g.innerWidth ?? 0) >= (g.innerHeight ?? 0);
}
/** {@linkcode isLandscapeSync}, asynchronously. */
export function isLandscape(): Promise<boolean> {
  return Promise.resolve(isLandscapeSync());
}

/** The last battery reading, for the sync getters (`null` until one was read). */
let lastBattery: PowerState | null = null;

/** A Battery Status reading as a {@linkcode PowerState}. */
function powerOf(b: BatteryLike): PowerState {
  lastBattery = {
    batteryLevel: b.level,
    lowPowerMode: false,
    batteryState: b.level === 1 ? "full" : b.charging ? "charging" : "unplugged",
    chargingtime: b.chargingTime,
    dischargingtime: b.dischargingTime,
  };
  return lastBattery;
}

/** The battery manager, or null. */
async function battery(): Promise<BatteryLike | null> {
  const fn = nav().getBattery;
  return typeof fn === "function" ? await fn.call(nav()).catch(() => null) : null;
}

/** The battery level, 0–1, or `-1`. */
export async function getBatteryLevel(): Promise<number> {
  const b = await battery();
  return b ? powerOf(b).batteryLevel : -1;
}
/** The last battery level read, or `-1`. */
export function getBatteryLevelSync(): number {
  return lastBattery?.batteryLevel ?? -1;
}
/** Whether the battery is charging. */
export async function isBatteryCharging(): Promise<boolean> {
  const b = await battery();
  return b ? b.charging : false;
}
/** Whether the battery was charging at the last reading. */
export function isBatteryChargingSync(): boolean {
  return lastBattery?.batteryState === "charging";
}
/** The power state, or `{}` without a battery API. */
export async function getPowerState(): Promise<Partial<PowerState>> {
  const b = await battery();
  return b ? powerOf(b) : {};
}
/** The power state at the last reading, or `{}`. */
export function getPowerStateSync(): Partial<PowerState> {
  return lastBattery ?? {};
}

/**
 * Whether `level` is low: under 0.15 on Android, 0.2 elsewhere.
 *
 * @param level The battery level, 0–1.
 * @returns Whether it is low.
 */
export function isLowBatteryLevel(level: number): boolean {
  return level < (nativePlatform() === "android" ? 0.15 : 0.2);
}

/** Call `fn` with every battery reading until the returned stop runs. */
function watchBattery(fn: (state: PowerState) => void): () => void {
  let stop = () => {};
  let active = true;
  battery().then((b) => {
    if (!b || !active) return;
    const update = () => fn(powerOf(b));
    b.addEventListener("levelchange", update);
    b.addEventListener("chargingchange", update);
    stop = () => {
      b.removeEventListener("levelchange", update);
      b.removeEventListener("chargingchange", update);
    };
  });
  return () => {
    active = false;
    stop();
  };
}

// ---- hooks ---------------------------------------------------------------------------------------

/** `{ loading, result }` from an async getter, read on mount. */
function useOnMount<T>(getter: () => Promise<T>, initial: T): AsyncHookResult<T> {
  const [state, setState] = useState<AsyncHookResult<T>>({ loading: true, result: initial });
  useEffect(() => {
    let live = true;
    getter().then((result) => live && setState({ loading: false, result }), () => {});
    return () => {
      live = false;
    };
  }, [getter]);
  return state;
}

/** The battery level (`null` until read), kept current. */
export function useBatteryLevel(): number | null {
  const [level, setLevel] = useState<number | null>(null);
  useEffect(() => {
    getBatteryLevel().then(setLevel, () => {});
    return watchBattery((s) => setLevel(s.batteryLevel));
  }, []);
  return level;
}

/** The battery level once it is low (`null` until then). */
export function useBatteryLevelIsLow(): number | null {
  const [level, setLevel] = useState<number | null>(null);
  useEffect(() => {
    getBatteryLevel().then((l) => isLowBatteryLevel(l) && l >= 0 && setLevel(l), () => {});
    return watchBattery((s) => isLowBatteryLevel(s.batteryLevel) && setLevel(s.batteryLevel));
  }, []);
  return level;
}

/** The power state (`{}` until read), kept current. */
export function usePowerState(): Partial<PowerState> {
  const [state, setState] = useState<Partial<PowerState>>({});
  useEffect(() => {
    getPowerState().then(setState, () => {});
    return watchBattery(setState);
  }, []);
  return state;
}

/** Headphones: `{ loading, result: false }`. */
export function useIsHeadphonesConnected(): AsyncHookResult<boolean> {
  return useOnMount(isHeadphonesConnected, false);
}
/** Wired headphones: `{ loading, result: false }`. */
export function useIsWiredHeadphonesConnected(): AsyncHookResult<boolean> {
  return useOnMount(isWiredHeadphonesConnected, false);
}
/** Bluetooth headphones: `{ loading, result: false }`. */
export function useIsBluetoothHeadphonesConnected(): AsyncHookResult<boolean> {
  return useOnMount(isBluetoothHeadphonesConnected, false);
}
/** The first install time: `{ loading, result: -1 }`. */
export function useFirstInstallTime(): AsyncHookResult<number> {
  return useOnMount(getFirstInstallTime, -1);
}
/** The device name: `{ loading, result: "unknown" }`. */
export function useDeviceName(): AsyncHookResult<string> {
  return useOnMount(getDeviceName, "unknown");
}
/** A system feature: `{ loading, result: false }`. */
export function useHasSystemFeature(feature: string): AsyncHookResult<boolean> {
  const getter = useCallback(() => hasSystemFeature(feature), [feature]);
  return useOnMount(getter, false);
}
/** Whether the shell runs in a simulator / emulator. */
export function useIsEmulator(): AsyncHookResult<boolean> {
  return useOnMount(isEmulator, false);
}
/** The manufacturer. */
export function useManufacturer(): AsyncHookResult<string> {
  return useOnMount(getManufacturer, "unknown");
}
/** The screen brightness: `null`, then `-1`. */
export function useBrightness(): number | null {
  const [value, setValue] = useState<number | null>(null);
  useEffect(() => {
    getBrightness().then(setValue, () => {});
  }, []);
  return useMemo(() => value, [value]);
}

/** The package's default export's shape: every getter and hook of this module. */
export interface DeviceInfoModule {
  /** {@linkcode getAndroidId}. */
  readonly getAndroidId: typeof getAndroidId;
  /** {@linkcode getAndroidIdSync}. */
  readonly getAndroidIdSync: typeof getAndroidIdSync;
  /** {@linkcode getApiLevel}. */
  readonly getApiLevel: typeof getApiLevel;
  /** {@linkcode getAppSetId}. */
  readonly getAppSetId: typeof getAppSetId;
  /** {@linkcode getApiLevelSync}. */
  readonly getApiLevelSync: typeof getApiLevelSync;
  /** {@linkcode getApplicationName}. */
  readonly getApplicationName: typeof getApplicationName;
  /** {@linkcode getAvailableLocationProviders}. */
  readonly getAvailableLocationProviders: typeof getAvailableLocationProviders;
  /** {@linkcode getAvailableLocationProvidersSync}. */
  readonly getAvailableLocationProvidersSync: typeof getAvailableLocationProvidersSync;
  /** {@linkcode getBaseOs}. */
  readonly getBaseOs: typeof getBaseOs;
  /** {@linkcode getBaseOsSync}. */
  readonly getBaseOsSync: typeof getBaseOsSync;
  /** {@linkcode getBatteryLevel}. */
  readonly getBatteryLevel: typeof getBatteryLevel;
  /** {@linkcode getBatteryLevelSync}. */
  readonly getBatteryLevelSync: typeof getBatteryLevelSync;
  /** {@linkcode getBootloader}. */
  readonly getBootloader: typeof getBootloader;
  /** {@linkcode getBootloaderSync}. */
  readonly getBootloaderSync: typeof getBootloaderSync;
  /** {@linkcode getBrand}. */
  readonly getBrand: typeof getBrand;
  /** {@linkcode getBuildId}. */
  readonly getBuildId: typeof getBuildId;
  /** {@linkcode getBuildIdSync}. */
  readonly getBuildIdSync: typeof getBuildIdSync;
  /** {@linkcode getBuildNumber}. */
  readonly getBuildNumber: typeof getBuildNumber;
  /** {@linkcode getBundleId}. */
  readonly getBundleId: typeof getBundleId;
  /** {@linkcode getCarrier}. */
  readonly getCarrier: typeof getCarrier;
  /** {@linkcode getCarrierSync}. */
  readonly getCarrierSync: typeof getCarrierSync;
  /** {@linkcode getCodename}. */
  readonly getCodename: typeof getCodename;
  /** {@linkcode getCodenameSync}. */
  readonly getCodenameSync: typeof getCodenameSync;
  /** {@linkcode getDevice}. */
  readonly getDevice: typeof getDevice;
  /** {@linkcode getDeviceId}. */
  readonly getDeviceId: typeof getDeviceId;
  /** {@linkcode getDeviceName}. */
  readonly getDeviceName: typeof getDeviceName;
  /** {@linkcode getDeviceNameSync}. */
  readonly getDeviceNameSync: typeof getDeviceNameSync;
  /** {@linkcode getDeviceSync}. */
  readonly getDeviceSync: typeof getDeviceSync;
  /** {@linkcode getDeviceToken}. */
  readonly getDeviceToken: typeof getDeviceToken;
  /** {@linkcode getDeviceType}. */
  readonly getDeviceType: typeof getDeviceType;
  /** {@linkcode getDisplay}. */
  readonly getDisplay: typeof getDisplay;
  /** {@linkcode getDisplaySync}. */
  readonly getDisplaySync: typeof getDisplaySync;
  /** {@linkcode getFingerprint}. */
  readonly getFingerprint: typeof getFingerprint;
  /** {@linkcode getFingerprintSync}. */
  readonly getFingerprintSync: typeof getFingerprintSync;
  /** {@linkcode getFirstInstallTime}. */
  readonly getFirstInstallTime: typeof getFirstInstallTime;
  /** {@linkcode getFirstInstallTimeSync}. */
  readonly getFirstInstallTimeSync: typeof getFirstInstallTimeSync;
  /** {@linkcode getFontScale}. */
  readonly getFontScale: typeof getFontScale;
  /** {@linkcode getFontScaleSync}. */
  readonly getFontScaleSync: typeof getFontScaleSync;
  /** {@linkcode getFreeDiskStorage}. */
  readonly getFreeDiskStorage: typeof getFreeDiskStorage;
  /** {@linkcode getFreeDiskStorageOld}. */
  readonly getFreeDiskStorageOld: typeof getFreeDiskStorageOld;
  /** {@linkcode getFreeDiskStorageSync}. */
  readonly getFreeDiskStorageSync: typeof getFreeDiskStorageSync;
  /** {@linkcode getFreeDiskStorageOldSync}. */
  readonly getFreeDiskStorageOldSync: typeof getFreeDiskStorageOldSync;
  /** {@linkcode getHardware}. */
  readonly getHardware: typeof getHardware;
  /** {@linkcode getHardwareSync}. */
  readonly getHardwareSync: typeof getHardwareSync;
  /** {@linkcode getHost}. */
  readonly getHost: typeof getHost;
  /** {@linkcode getHostSync}. */
  readonly getHostSync: typeof getHostSync;
  /** {@linkcode getHostNames}. */
  readonly getHostNames: typeof getHostNames;
  /** {@linkcode getHostNamesSync}. */
  readonly getHostNamesSync: typeof getHostNamesSync;
  /** {@linkcode getIncremental}. */
  readonly getIncremental: typeof getIncremental;
  /** {@linkcode getIncrementalSync}. */
  readonly getIncrementalSync: typeof getIncrementalSync;
  /** {@linkcode getInstallerPackageName}. */
  readonly getInstallerPackageName: typeof getInstallerPackageName;
  /** {@linkcode getInstallerPackageNameSync}. */
  readonly getInstallerPackageNameSync: typeof getInstallerPackageNameSync;
  /** {@linkcode getInstallReferrer}. */
  readonly getInstallReferrer: typeof getInstallReferrer;
  /** {@linkcode getInstallReferrerSync}. */
  readonly getInstallReferrerSync: typeof getInstallReferrerSync;
  /** {@linkcode getInstanceId}. */
  readonly getInstanceId: typeof getInstanceId;
  /** {@linkcode getInstanceIdSync}. */
  readonly getInstanceIdSync: typeof getInstanceIdSync;
  /** {@linkcode getIpAddress}. */
  readonly getIpAddress: typeof getIpAddress;
  /** {@linkcode getIpAddressSync}. */
  readonly getIpAddressSync: typeof getIpAddressSync;
  /** {@linkcode getLastUpdateTime}. */
  readonly getLastUpdateTime: typeof getLastUpdateTime;
  /** {@linkcode getLastUpdateTimeSync}. */
  readonly getLastUpdateTimeSync: typeof getLastUpdateTimeSync;
  /** {@linkcode getMacAddress}. */
  readonly getMacAddress: typeof getMacAddress;
  /** {@linkcode getMacAddressSync}. */
  readonly getMacAddressSync: typeof getMacAddressSync;
  /** {@linkcode getManufacturer}. */
  readonly getManufacturer: typeof getManufacturer;
  /** {@linkcode getManufacturerSync}. */
  readonly getManufacturerSync: typeof getManufacturerSync;
  /** {@linkcode getMaxMemory}. */
  readonly getMaxMemory: typeof getMaxMemory;
  /** {@linkcode getMaxMemorySync}. */
  readonly getMaxMemorySync: typeof getMaxMemorySync;
  /** {@linkcode getModel}. */
  readonly getModel: typeof getModel;
  /** {@linkcode getPowerState}. */
  readonly getPowerState: typeof getPowerState;
  /** {@linkcode getPowerStateSync}. */
  readonly getPowerStateSync: typeof getPowerStateSync;
  /** {@linkcode getPreviewSdkInt}. */
  readonly getPreviewSdkInt: typeof getPreviewSdkInt;
  /** {@linkcode getPreviewSdkIntSync}. */
  readonly getPreviewSdkIntSync: typeof getPreviewSdkIntSync;
  /** {@linkcode getProduct}. */
  readonly getProduct: typeof getProduct;
  /** {@linkcode getProductSync}. */
  readonly getProductSync: typeof getProductSync;
  /** {@linkcode getReadableVersion}. */
  readonly getReadableVersion: typeof getReadableVersion;
  /** {@linkcode getSecurityPatch}. */
  readonly getSecurityPatch: typeof getSecurityPatch;
  /** {@linkcode getSecurityPatchSync}. */
  readonly getSecurityPatchSync: typeof getSecurityPatchSync;
  /** {@linkcode getSerialNumber}. */
  readonly getSerialNumber: typeof getSerialNumber;
  /** {@linkcode getSerialNumberSync}. */
  readonly getSerialNumberSync: typeof getSerialNumberSync;
  /** {@linkcode getStartupTime}. */
  readonly getStartupTime: typeof getStartupTime;
  /** {@linkcode getStartupTimeSync}. */
  readonly getStartupTimeSync: typeof getStartupTimeSync;
  /** {@linkcode getSystemAvailableFeatures}. */
  readonly getSystemAvailableFeatures: typeof getSystemAvailableFeatures;
  /** {@linkcode getSystemAvailableFeaturesSync}. */
  readonly getSystemAvailableFeaturesSync: typeof getSystemAvailableFeaturesSync;
  /** {@linkcode getSystemName}. */
  readonly getSystemName: typeof getSystemName;
  /** {@linkcode getSystemVersion}. */
  readonly getSystemVersion: typeof getSystemVersion;
  /** {@linkcode getTags}. */
  readonly getTags: typeof getTags;
  /** {@linkcode getTagsSync}. */
  readonly getTagsSync: typeof getTagsSync;
  /** {@linkcode getTotalDiskCapacity}. */
  readonly getTotalDiskCapacity: typeof getTotalDiskCapacity;
  /** {@linkcode getTotalDiskCapacityOld}. */
  readonly getTotalDiskCapacityOld: typeof getTotalDiskCapacityOld;
  /** {@linkcode getTotalDiskCapacitySync}. */
  readonly getTotalDiskCapacitySync: typeof getTotalDiskCapacitySync;
  /** {@linkcode getTotalDiskCapacityOldSync}. */
  readonly getTotalDiskCapacityOldSync: typeof getTotalDiskCapacityOldSync;
  /** {@linkcode getTotalMemory}. */
  readonly getTotalMemory: typeof getTotalMemory;
  /** {@linkcode getTotalMemorySync}. */
  readonly getTotalMemorySync: typeof getTotalMemorySync;
  /** {@linkcode getType}. */
  readonly getType: typeof getType;
  /** {@linkcode getTypeSync}. */
  readonly getTypeSync: typeof getTypeSync;
  /** {@linkcode getUniqueId}. */
  readonly getUniqueId: typeof getUniqueId;
  /** {@linkcode getUniqueIdSync}. */
  readonly getUniqueIdSync: typeof getUniqueIdSync;
  /** {@linkcode getUsedMemory}. */
  readonly getUsedMemory: typeof getUsedMemory;
  /** {@linkcode getUsedMemorySync}. */
  readonly getUsedMemorySync: typeof getUsedMemorySync;
  /** {@linkcode getUserAgent}. */
  readonly getUserAgent: typeof getUserAgent;
  /** {@linkcode getUserAgentSync}. */
  readonly getUserAgentSync: typeof getUserAgentSync;
  /** {@linkcode getVersion}. */
  readonly getVersion: typeof getVersion;
  /** {@linkcode getBrightness}. */
  readonly getBrightness: typeof getBrightness;
  /** {@linkcode getBrightnessSync}. */
  readonly getBrightnessSync: typeof getBrightnessSync;
  /** {@linkcode hasGms}. */
  readonly hasGms: typeof hasGms;
  /** {@linkcode hasGmsSync}. */
  readonly hasGmsSync: typeof hasGmsSync;
  /** {@linkcode hasHms}. */
  readonly hasHms: typeof hasHms;
  /** {@linkcode hasHmsSync}. */
  readonly hasHmsSync: typeof hasHmsSync;
  /** {@linkcode hasNotch}. */
  readonly hasNotch: typeof hasNotch;
  /** {@linkcode hasDynamicIsland}. */
  readonly hasDynamicIsland: typeof hasDynamicIsland;
  /** {@linkcode hasSystemFeature}. */
  readonly hasSystemFeature: typeof hasSystemFeature;
  /** {@linkcode hasSystemFeatureSync}. */
  readonly hasSystemFeatureSync: typeof hasSystemFeatureSync;
  /** {@linkcode isAirplaneMode}. */
  readonly isAirplaneMode: typeof isAirplaneMode;
  /** {@linkcode isAirplaneModeSync}. */
  readonly isAirplaneModeSync: typeof isAirplaneModeSync;
  /** {@linkcode isBatteryCharging}. */
  readonly isBatteryCharging: typeof isBatteryCharging;
  /** {@linkcode isBatteryChargingSync}. */
  readonly isBatteryChargingSync: typeof isBatteryChargingSync;
  /** {@linkcode isCameraPresent}. */
  readonly isCameraPresent: typeof isCameraPresent;
  /** {@linkcode isCameraPresentSync}. */
  readonly isCameraPresentSync: typeof isCameraPresentSync;
  /** {@linkcode isEmulator}. */
  readonly isEmulator: typeof isEmulator;
  /** {@linkcode isEmulatorSync}. */
  readonly isEmulatorSync: typeof isEmulatorSync;
  /** {@linkcode isHeadphonesConnected}. */
  readonly isHeadphonesConnected: typeof isHeadphonesConnected;
  /** {@linkcode isHeadphonesConnectedSync}. */
  readonly isHeadphonesConnectedSync: typeof isHeadphonesConnectedSync;
  /** {@linkcode isWiredHeadphonesConnected}. */
  readonly isWiredHeadphonesConnected: typeof isWiredHeadphonesConnected;
  /** {@linkcode isWiredHeadphonesConnectedSync}. */
  readonly isWiredHeadphonesConnectedSync: typeof isWiredHeadphonesConnectedSync;
  /** {@linkcode isBluetoothHeadphonesConnected}. */
  readonly isBluetoothHeadphonesConnected: typeof isBluetoothHeadphonesConnected;
  /** {@linkcode isBluetoothHeadphonesConnectedSync}. */
  readonly isBluetoothHeadphonesConnectedSync: typeof isBluetoothHeadphonesConnectedSync;
  /** {@linkcode isLandscape}. */
  readonly isLandscape: typeof isLandscape;
  /** {@linkcode isLandscapeSync}. */
  readonly isLandscapeSync: typeof isLandscapeSync;
  /** {@linkcode isLocationEnabled}. */
  readonly isLocationEnabled: typeof isLocationEnabled;
  /** {@linkcode isLocationEnabledSync}. */
  readonly isLocationEnabledSync: typeof isLocationEnabledSync;
  /** {@linkcode isPinOrFingerprintSet}. */
  readonly isPinOrFingerprintSet: typeof isPinOrFingerprintSet;
  /** {@linkcode isPinOrFingerprintSetSync}. */
  readonly isPinOrFingerprintSetSync: typeof isPinOrFingerprintSetSync;
  /** {@linkcode isMouseConnected}. */
  readonly isMouseConnected: typeof isMouseConnected;
  /** {@linkcode isMouseConnectedSync}. */
  readonly isMouseConnectedSync: typeof isMouseConnectedSync;
  /** {@linkcode isKeyboardConnected}. */
  readonly isKeyboardConnected: typeof isKeyboardConnected;
  /** {@linkcode isKeyboardConnectedSync}. */
  readonly isKeyboardConnectedSync: typeof isKeyboardConnectedSync;
  /** {@linkcode isTabletMode}. */
  readonly isTabletMode: typeof isTabletMode;
  /** {@linkcode isTablet}. */
  readonly isTablet: typeof isTablet;
  /** {@linkcode isLowRamDevice}. */
  readonly isLowRamDevice: typeof isLowRamDevice;
  /** {@linkcode isDisplayZoomed}. */
  readonly isDisplayZoomed: typeof isDisplayZoomed;
  /** {@linkcode supported32BitAbis}. */
  readonly supported32BitAbis: typeof supported32BitAbis;
  /** {@linkcode supported32BitAbisSync}. */
  readonly supported32BitAbisSync: typeof supported32BitAbisSync;
  /** {@linkcode supported64BitAbis}. */
  readonly supported64BitAbis: typeof supported64BitAbis;
  /** {@linkcode supported64BitAbisSync}. */
  readonly supported64BitAbisSync: typeof supported64BitAbisSync;
  /** {@linkcode supportedAbis}. */
  readonly supportedAbis: typeof supportedAbis;
  /** {@linkcode supportedAbisSync}. */
  readonly supportedAbisSync: typeof supportedAbisSync;
  /** {@linkcode syncUniqueId}. */
  readonly syncUniqueId: typeof syncUniqueId;
  /** {@linkcode useBatteryLevel}. */
  readonly useBatteryLevel: typeof useBatteryLevel;
  /** {@linkcode useBatteryLevelIsLow}. */
  readonly useBatteryLevelIsLow: typeof useBatteryLevelIsLow;
  /** {@linkcode useDeviceName}. */
  readonly useDeviceName: typeof useDeviceName;
  /** {@linkcode useFirstInstallTime}. */
  readonly useFirstInstallTime: typeof useFirstInstallTime;
  /** {@linkcode useHasSystemFeature}. */
  readonly useHasSystemFeature: typeof useHasSystemFeature;
  /** {@linkcode useIsEmulator}. */
  readonly useIsEmulator: typeof useIsEmulator;
  /** {@linkcode usePowerState}. */
  readonly usePowerState: typeof usePowerState;
  /** {@linkcode useManufacturer}. */
  readonly useManufacturer: typeof useManufacturer;
  /** {@linkcode useIsHeadphonesConnected}. */
  readonly useIsHeadphonesConnected: typeof useIsHeadphonesConnected;
  /** {@linkcode useIsWiredHeadphonesConnected}. */
  readonly useIsWiredHeadphonesConnected: typeof useIsWiredHeadphonesConnected;
  /** {@linkcode useIsBluetoothHeadphonesConnected}. */
  readonly useIsBluetoothHeadphonesConnected: typeof useIsBluetoothHeadphonesConnected;
  /** {@linkcode useBrightness}. */
  readonly useBrightness: typeof useBrightness;
  /** {@linkcode getSupportedMediaTypeList}. */
  readonly getSupportedMediaTypeList: typeof getSupportedMediaTypeList;
  /** {@linkcode getSupportedMediaTypeListSync}. */
  readonly getSupportedMediaTypeListSync: typeof getSupportedMediaTypeListSync;
}

/** The package's default export: every getter and hook above. */
export const DeviceInfo: DeviceInfoModule = {
  getAndroidId,
  getAndroidIdSync,
  getApiLevel,
  getAppSetId,
  getApiLevelSync,
  getApplicationName,
  getAvailableLocationProviders,
  getAvailableLocationProvidersSync,
  getBaseOs,
  getBaseOsSync,
  getBatteryLevel,
  getBatteryLevelSync,
  getBootloader,
  getBootloaderSync,
  getBrand,
  getBuildId,
  getBuildIdSync,
  getBuildNumber,
  getBundleId,
  getCarrier,
  getCarrierSync,
  getCodename,
  getCodenameSync,
  getDevice,
  getDeviceId,
  getDeviceName,
  getDeviceNameSync,
  getDeviceSync,
  getDeviceToken,
  getDeviceType,
  getDisplay,
  getDisplaySync,
  getFingerprint,
  getFingerprintSync,
  getFirstInstallTime,
  getFirstInstallTimeSync,
  getFontScale,
  getFontScaleSync,
  getFreeDiskStorage,
  getFreeDiskStorageOld,
  getFreeDiskStorageSync,
  getFreeDiskStorageOldSync,
  getHardware,
  getHardwareSync,
  getHost,
  getHostSync,
  getHostNames,
  getHostNamesSync,
  getIncremental,
  getIncrementalSync,
  getInstallerPackageName,
  getInstallerPackageNameSync,
  getInstallReferrer,
  getInstallReferrerSync,
  getInstanceId,
  getInstanceIdSync,
  getIpAddress,
  getIpAddressSync,
  getLastUpdateTime,
  getLastUpdateTimeSync,
  getMacAddress,
  getMacAddressSync,
  getManufacturer,
  getManufacturerSync,
  getMaxMemory,
  getMaxMemorySync,
  getModel,
  getPowerState,
  getPowerStateSync,
  getPreviewSdkInt,
  getPreviewSdkIntSync,
  getProduct,
  getProductSync,
  getReadableVersion,
  getSecurityPatch,
  getSecurityPatchSync,
  getSerialNumber,
  getSerialNumberSync,
  getStartupTime,
  getStartupTimeSync,
  getSystemAvailableFeatures,
  getSystemAvailableFeaturesSync,
  getSystemName,
  getSystemVersion,
  getTags,
  getTagsSync,
  getTotalDiskCapacity,
  getTotalDiskCapacityOld,
  getTotalDiskCapacitySync,
  getTotalDiskCapacityOldSync,
  getTotalMemory,
  getTotalMemorySync,
  getType,
  getTypeSync,
  getUniqueId,
  getUniqueIdSync,
  getUsedMemory,
  getUsedMemorySync,
  getUserAgent,
  getUserAgentSync,
  getVersion,
  getBrightness,
  getBrightnessSync,
  hasGms,
  hasGmsSync,
  hasHms,
  hasHmsSync,
  hasNotch,
  hasDynamicIsland,
  hasSystemFeature,
  hasSystemFeatureSync,
  isAirplaneMode,
  isAirplaneModeSync,
  isBatteryCharging,
  isBatteryChargingSync,
  isCameraPresent,
  isCameraPresentSync,
  isEmulator,
  isEmulatorSync,
  isHeadphonesConnected,
  isHeadphonesConnectedSync,
  isWiredHeadphonesConnected,
  isWiredHeadphonesConnectedSync,
  isBluetoothHeadphonesConnected,
  isBluetoothHeadphonesConnectedSync,
  isLandscape,
  isLandscapeSync,
  isLocationEnabled,
  isLocationEnabledSync,
  isPinOrFingerprintSet,
  isPinOrFingerprintSetSync,
  isMouseConnected,
  isMouseConnectedSync,
  isKeyboardConnected,
  isKeyboardConnectedSync,
  isTabletMode,
  isTablet,
  isLowRamDevice,
  isDisplayZoomed,
  supported32BitAbis,
  supported32BitAbisSync,
  supported64BitAbis,
  supported64BitAbisSync,
  supportedAbis,
  supportedAbisSync,
  syncUniqueId,
  useBatteryLevel,
  useBatteryLevelIsLow,
  useDeviceName,
  useFirstInstallTime,
  useHasSystemFeature,
  useIsEmulator,
  usePowerState,
  useManufacturer,
  useIsHeadphonesConnected,
  useIsWiredHeadphonesConnected,
  useIsBluetoothHeadphonesConnected,
  useBrightness,
  getSupportedMediaTypeList,
  getSupportedMediaTypeListSync,
};

export default DeviceInfo;
