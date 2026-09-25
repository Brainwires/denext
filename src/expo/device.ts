/**
 * `expo-device` for denext: device facts from `denext/mobile`.
 *
 * Expo exposes most of them as constants, read synchronously. The Capacitor `Device`
 * plugin is asynchronous, so the constants come from the user agent (the same best-effort
 * parse `denext/mobile`'s {@linkcode deviceInfo} falls back to on the web), read once when
 * the module is first evaluated; {@linkcode getDeviceTypeAsync} and the other async
 * functions ask the plugin where there is one. Facts a web view cannot learn (brand,
 * memory, CPU, build ids) are null.
 *
 * @example
 * ```ts
 * import * as Device from "denext/expo/device";
 *
 * const tablet = Device.deviceType === Device.DeviceType.TABLET;
 * ```
 *
 * @module
 */

import { deviceInfo, parseUserAgent } from "../mobile/device.ts";
import { nativePlatform } from "../mobile/bridge.ts";

/** The kind of device. */
export enum DeviceType {
  /** Unknown. */
  UNKNOWN = 0,
  /** A phone. */
  PHONE = 1,
  /** A tablet. */
  TABLET = 2,
  /** A desktop or laptop. */
  DESKTOP = 3,
  /** A TV. */
  TV = 4,
}

/** The page's user agent, or `""` (SSR). */
function userAgent(): string {
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "";
}

/** The device kind a user agent suggests. */
function uaDeviceType(ua: string): DeviceType {
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) {
    return DeviceType.TABLET;
  }
  if (/iPhone|iPod|Android|Mobile/.test(ua)) return DeviceType.PHONE;
  return ua ? DeviceType.DESKTOP : DeviceType.UNKNOWN;
}

/** The OS name a user agent suggests. */
function uaOsName(ua: string): string | null {
  if (/iPhone|iPod/.test(ua)) return "iOS";
  if (/iPad/.test(ua)) return "iPadOS";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X/.test(ua)) return "Mac OS";
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "Chrome OS";
  return /Linux/.test(ua) ? "Linux" : null;
}

/** The user-agent facts, parsed once on first read. */
let facts: { ua: string; model?: string; osVersion?: string } | undefined;

/** The page's user agent and what it says about the device. */
function uaFacts(): { ua: string; model?: string; osVersion?: string } {
  if (facts) return facts;
  const ua = userAgent();
  return facts = { ua, ...parseUserAgent(ua) };
}

/** Whether this is a real device rather than a simulator: `true` here. */
export const isDevice = true;
/** The brand (not known to a web view): null. */
export const brand: string | null = null;
/** The manufacturer (not known to a web view): null. */
export const manufacturer: string | null = null;
/** The internal model id (not known to a web view): null. */
export const modelId: string | null = null;
/** The model name from the user agent (`"iPhone"`, `"Pixel 8"`), or null. */
export const modelName: string | null = /* @__PURE__ */ (() => uaFacts().model ?? null)();
/** The design name (not known to a web view): null. */
export const designName: string | null = null;
/** The product name (not known to a web view): null. */
export const productName: string | null = null;
/** The device kind from the user agent. */
export const deviceType: DeviceType | null = /* @__PURE__ */ uaDeviceType(uaFacts().ua);
/** The device year class (not known to a web view): null. */
export const deviceYearClass: number | null = null;
/** The total memory (not known to a web view): null. */
export const totalMemory: number | null = null;
/** The CPU architectures (not known to a web view): null. */
export const supportedCpuArchitectures: string[] | null = null;
/** The OS name from the user agent (`"iOS"`, `"Android"`, …), or null. */
export const osName: string | null = /* @__PURE__ */ uaOsName(uaFacts().ua);
/** The OS version from the user agent, or null. */
export const osVersion: string | null = /* @__PURE__ */ (() => uaFacts().osVersion ?? null)();
/** The OS build id (not known to a web view): null. */
export const osBuildId: string | null = null;
/** The internal OS build id (not known to a web view): null. */
export const osInternalBuildId: string | null = null;
/** The OS build fingerprint (not known to a web view): null. */
export const osBuildFingerprint: string | null = null;
/** The Android API level (not known to a web view): null. */
export const platformApiLevel: number | null = null;
/** The user-set device name (not known to a web view): null. */
export const deviceName: string | null = null;

/**
 * The device kind: in the native shell, a phone unless the plugin's model says iPad; else
 * the user agent's guess.
 *
 * @returns The kind.
 */
export async function getDeviceTypeAsync(): Promise<DeviceType> {
  if (nativePlatform() === "web") return uaDeviceType(userAgent());
  const { model } = await deviceInfo();
  return model && /iPad|Tablet/i.test(model) ? DeviceType.TABLET : DeviceType.PHONE;
}

/**
 * Time since boot in ms: not known to a web view; the page's uptime instead.
 *
 * @returns Milliseconds.
 */
export function getUptimeAsync(): Promise<number> {
  return Promise.resolve(Math.round(globalThis.performance?.now() ?? 0));
}

/**
 * The JS heap limit, where the browser reports it (`performance.memory`), else
 * `Number.MAX_SAFE_INTEGER` (Expo's web value).
 *
 * @returns Bytes.
 */
export function getMaxMemoryAsync(): Promise<number> {
  const memory = (globalThis.performance as { memory?: { jsHeapSizeLimit?: number } })?.memory;
  return Promise.resolve(memory?.jsHeapSizeLimit ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Whether the device is rooted / jailbroken: not observable here.
 *
 * @returns `false`.
 */
export function isRootedExperimentalAsync(): Promise<boolean> {
  return Promise.resolve(false);
}

/**
 * Whether side-loading is enabled: not observable here.
 *
 * @returns `false`.
 */
export function isSideLoadingEnabledAsync(): Promise<boolean> {
  return Promise.resolve(false);
}

/**
 * The Android system features: none are observable here.
 *
 * @returns An empty list.
 */
export function getPlatformFeaturesAsync(): Promise<string[]> {
  return Promise.resolve([]);
}

/**
 * Whether the device has an Android system feature: not observable here.
 *
 * @param _feature The feature name.
 * @returns `false`.
 */
export function hasPlatformFeatureAsync(_feature: string): Promise<boolean> {
  return Promise.resolve(false);
}
