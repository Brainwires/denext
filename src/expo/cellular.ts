/**
 * `expo-cellular` for denext: what a page can know of the cellular connection. The generation
 * comes from the Network Information API's `effectiveType` (Chromium, the Android shell's
 * WebView) on a cellular connection and is `UNKNOWN` elsewhere (a desktop's speed class is not
 * a generation); the carrier, its country and its network codes are not
 * readable from a WebView or a browser, so they are null (Expo's web answers; iOS 16.4+
 * reports none of them natively either). Reading needs no permission: the permission calls
 * answer `granted`.
 *
 * @example
 * ```ts
 * import * as Cellular from "denext/expo/cellular";
 *
 * const generation = await Cellular.getCellularGenerationAsync();
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import {
  NOT_NEEDED_PERMISSION,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  PermissionStatus,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionHookOptions, PermissionResponse };

/** The cellular generation. */
export enum CellularGeneration {
  /** Unknown, or not on cellular. */
  UNKNOWN = 0,
  /** 2G. */
  CELLULAR_2G = 1,
  /** 3G. */
  CELLULAR_3G = 2,
  /** 4G. */
  CELLULAR_4G = 3,
  /** 5G. */
  CELLULAR_5G = 4,
}

/** The Network Information API's `effectiveType` → a generation. */
const GENERATIONS: Readonly<Record<string, CellularGeneration>> = {
  "slow-2g": CellularGeneration.CELLULAR_2G,
  "2g": CellularGeneration.CELLULAR_2G,
  "3g": CellularGeneration.CELLULAR_3G,
  "4g": CellularGeneration.CELLULAR_4G,
};

/**
 * The connection's generation, from the Network Information API (its `effectiveType` is the
 * connection's measured speed class, which is what Expo's web build reports too). Only a
 * cellular connection has one: a connection whose `type` says otherwise is `UNKNOWN`, and so is
 * one without a `type` (a desktop browser or Deno Desktop, where a fast wired or Wi-Fi link
 * reads `"4g"`), except in the Android shell, where the connection is the phone's.
 *
 * @returns The generation, or `UNKNOWN`.
 */
export function getCellularGenerationAsync(): Promise<CellularGeneration> {
  const nav = (globalThis as {
    navigator?: { connection?: { effectiveType?: string; type?: string } };
  }).navigator;
  const connection = nav?.connection;
  const cellular = connection?.type
    ? connection.type === "cellular"
    : connection !== undefined && nativePlatform() === "android";
  if (!connection || !cellular) return Promise.resolve(CellularGeneration.UNKNOWN);
  return Promise.resolve(GENERATIONS[connection.effectiveType ?? ""] ?? CellularGeneration.UNKNOWN);
}

/**
 * The carrier's ISO country code: not readable here.
 *
 * @returns null.
 */
export function getIsoCountryCodeAsync(): Promise<string | null> {
  return Promise.resolve(null);
}

/**
 * The carrier's name: not readable here.
 *
 * @returns null.
 */
export function getCarrierNameAsync(): Promise<string | null> {
  return Promise.resolve(null);
}

/**
 * The carrier's mobile country code: not readable here.
 *
 * @returns null.
 */
export function getMobileCountryCodeAsync(): Promise<string | null> {
  return Promise.resolve(null);
}

/**
 * The carrier's mobile network code: not readable here.
 *
 * @returns null.
 */
export function getMobileNetworkCodeAsync(): Promise<string | null> {
  return Promise.resolve(null);
}

/** The phone-state permission: none is needed here, so `granted`. */
export const getPermissionsAsync: () => Promise<PermissionResponse> = NOT_NEEDED_PERMISSION.get;

/** Ask for the phone-state permission: none is needed here, so `granted`. */
export const requestPermissionsAsync: () => Promise<PermissionResponse> =
  NOT_NEEDED_PERMISSION.request;

/** Hook form of the permission: `[response, request, get]`. */
export const usePermissions: (
  options?: PermissionHookOptions<object>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = NOT_NEEDED_PERMISSION.hook;
