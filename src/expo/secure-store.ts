/**
 * `expo-secure-store` for denext: the async API over `denext/mobile`'s
 * {@linkcode secureStore} (the iOS Keychain / Android Keystore through
 * `@aparajita/capacitor-secure-storage` in the Capacitor shell; a plain IndexedDB database on
 * the web, which is NOT secret).
 *
 * The synchronous `getItem` / `setItem` are not provided: the Capacitor bridge is
 * asynchronous. `keychainService` namespaces the key; the other options (biometric prompts,
 * accessibility classes, access groups) are accepted and ignored.
 *
 * @example
 * ```ts
 * import * as SecureStore from "denext/expo/secure-store";
 *
 * await SecureStore.setItemAsync("token", token);
 * const saved = await SecureStore.getItemAsync("token");
 * ```
 *
 * @module
 */

import { secureStore } from "../mobile/secure-store.ts";

/** A Keychain accessibility class (accepted and ignored here). */
export type KeychainAccessibilityConstant = number;

/** Accessible after the first unlock following a restart. */
export const AFTER_FIRST_UNLOCK: KeychainAccessibilityConstant = 0;
/** As `AFTER_FIRST_UNLOCK`, not migrated to a new device. */
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: KeychainAccessibilityConstant = 1;
/** Always accessible. @deprecated Use an accessibility class that protects the item. */
export const ALWAYS: KeychainAccessibilityConstant = 2;
/** Only while a passcode is set, on this device. */
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: KeychainAccessibilityConstant = 3;
/** As `ALWAYS`, on this device. @deprecated Use an accessibility class that protects the item. */
export const ALWAYS_THIS_DEVICE_ONLY: KeychainAccessibilityConstant = 4;
/** Only while the device is unlocked. */
export const WHEN_UNLOCKED: KeychainAccessibilityConstant = 5;
/** As `WHEN_UNLOCKED`, on this device. */
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY: KeychainAccessibilityConstant = 6;

/** Options every call takes. */
export interface SecureStoreOptions {
  /** A namespace: the same key under another service is a different item. */
  keychainService?: string;
  /** Ask for biometrics on access (ignored here). */
  requireAuthentication?: boolean;
  /** The biometric prompt (ignored here). */
  authenticationPrompt?: string;
  /** The Keychain accessibility class (ignored here). */
  keychainAccessible?: KeychainAccessibilityConstant;
  /** The iOS access group (ignored here). */
  accessGroup?: string;
}

/** Expo's key rule: letters, digits, `.`, `-` and `_`. */
const VALID_KEY = /^[\w.-]+$/;

/** The store key for `key` under `options.keychainService`. */
function storeKey(fn: string, key: string, options?: SecureStoreOptions): string {
  if (typeof key !== "string" || !VALID_KEY.test(key)) {
    throw new Error(
      `${fn}: invalid key "${String(key)}" (use letters, digits, ".", "-" and "_")`,
    );
  }
  return options?.keychainService ? `${options.keychainService}:${key}` : key;
}

/**
 * Whether the store is available: always, here (the web fallback is IndexedDB).
 *
 * @returns `true`.
 */
export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(true);
}

/**
 * The value stored under `key`.
 *
 * @param key The key.
 * @param options `keychainService` namespaces it.
 * @returns The value, or null when there is none.
 */
export async function getItemAsync(
  key: string,
  options?: SecureStoreOptions,
): Promise<string | null> {
  return await secureStore.get(storeKey("getItemAsync", key, options));
}

/**
 * Store `value` under `key`.
 *
 * @param key The key.
 * @param value The value (a string).
 * @param options `keychainService` namespaces it.
 * @returns A promise that settles once stored.
 */
export async function setItemAsync(
  key: string,
  value: string,
  options?: SecureStoreOptions,
): Promise<void> {
  if (typeof value !== "string") {
    throw new Error("setItemAsync: the value must be a string (JSON.stringify it)");
  }
  await secureStore.set(storeKey("setItemAsync", key, options), value);
}

/**
 * Delete `key` (a missing key is not an error).
 *
 * @param key The key.
 * @param options `keychainService` namespaces it.
 * @returns A promise that settles once deleted.
 */
export async function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void> {
  await secureStore.delete(storeKey("deleteItemAsync", key, options));
}

/**
 * Whether items can be protected with biometrics: not here.
 *
 * @returns `false`.
 */
export function canUseBiometricAuthentication(): boolean {
  return false;
}
