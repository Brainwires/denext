/**
 * A small string key-value store for secrets (tokens, keys) for `denext/mobile`: the iOS
 * Keychain / Android Keystore through the native `SecureStorage` plugin in the shell, else
 * IndexedDB.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";
import { isNativeShell } from "./bridge.ts";
import { authenticateBiometric } from "./biometrics.ts";
import { onDesktop, viaDesktop } from "./desktop-branch.ts";

/** Options for {@linkcode SecureStore.set}. */
export interface SecureStoreSetOptions {
  /**
   * Gate every later `get` of this value behind {@linkcode authenticateBiometric} (Face ID /
   * Touch ID / fingerprint; `denext mobile add biometrics`). On iOS the item is also stored
   * "when passcode set, this device only": it is not backed up or migrated, and it is deleted
   * if the passcode is removed. **The gate is enforced by denext's code, not by the Keychain
   * item:** the secure-storage plugin has no biometric access control, so native code in the
   * app could still read it. Default `false`.
   */
  readonly requireBiometric?: boolean;
}

/** Options for {@linkcode SecureStore.get}. */
export interface SecureStoreGetOptions {
  /** The prompt's reason when the value is biometric-gated (default "Unlock a saved secret"). */
  readonly reason?: string;
  /** Accept the device passcode too for a biometric-gated value (default `false`). */
  readonly allowDeviceCredential?: boolean;
}

/** The store {@linkcode secureStore} implements. */
export interface SecureStore {
  /**
   * The value stored under `key`, or `null` when there is none. A value stored with
   * `requireBiometric` asks for biometrics first and rejects with a `BiometricError` when the
   * user is not verified (always on the web, which has no biometrics).
   */
  get(key: string, options?: SecureStoreGetOptions): Promise<string | null>;
  /** Store `value` under `key`, replacing any earlier value. */
  set(key: string, value: string, options?: SecureStoreSetOptions): Promise<void>;
  /** Remove `key` (a missing key is not an error). */
  delete(key: string): Promise<void>;
}

/**
 * The native methods of `@aparajita/capacitor-secure-storage`. Its public `get`/`set` live in
 * the package's JS wrapper; the natively registered plugin exposes these `internal*` calls,
 * which take the already prefixed key.
 */
interface SecureStoragePlugin {
  internalGetItem(options: { prefixedKey: string; sync: boolean }): Promise<{ data?: unknown }>;
  internalSetItem(options: {
    prefixedKey: string;
    data: string;
    sync: boolean;
    access: number;
  }): Promise<void>;
  internalRemoveItem(options: { prefixedKey: string; sync: boolean }): Promise<unknown>;
}

/**
 * The plugin's default key prefix: keys written here are the ones its own
 * `SecureStorage.getItem`/`setItem` read and write.
 */
const NATIVE_PREFIX = "capacitor-storage_";
/** `KeychainAccess.whenUnlocked`, the plugin's default. */
const WHEN_UNLOCKED = 0;
/** `KeychainAccess.whenPasscodeSetThisDeviceOnly`, for a biometric-gated value. */
const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 4;
/**
 * The prefix a biometric-gated value is stored with, so a later `get` knows to ask first. It
 * starts with a NUL, which no ordinary string value is refused for except this exact prefix.
 */
const BIOMETRIC_PREFIX = "\u0000denext-biometric:";
/** The web fallback's IndexedDB database and object store. */
const DB_NAME = "denext-secure-store";
const STORE = "kv";

/** The native plugin, when the shell has it. */
function securePlugin(): SecureStoragePlugin | undefined {
  return nativePlugin<SecureStoragePlugin>("SecureStorage", [
    "internalGetItem",
    "internalSetItem",
    "internalRemoveItem",
  ]);
}

/** Whether the not-secret fallback has been reported this session (once is enough). */
let warnedNativeFallback = false;

/**
 * Warn ONCE when a native shell (iOS/Android) has no secure-storage plugin: the IndexedDB fallback
 * is the web's not-secret store, and inside the app it would silently hold refresh tokens in
 * WebView storage. The web itself stays quiet (the fallback is documented there).
 */
function warnNativeFallback(): void {
  if (warnedNativeFallback || !isNativeShell()) return;
  warnedNativeFallback = true;
  console.warn(
    "denext: secureStore is running in the native shell WITHOUT the secure-storage plugin " +
      "(`denext mobile add secure-store`); values fall back to WebView IndexedDB, which is NOT secret.",
  );
}

/** The key {@linkcode secureStoreIsSecret} reads to learn whether the desktop keychain answers. */
const DESKTOP_PROBE_KEY = "denext.secure-store.probe";

/**
 * Whether {@linkcode secureStore} keeps values in a secret store here: the native SecureStorage
 * plugin in the shell, or the OS keychain in a Deno Desktop window with `secure-store` enabled.
 * `false` on the web and in a shell without the plugin, where the IndexedDB fallback is NOT
 * secret. Internal: the Expo and `react-native-keychain` shims' availability answers.
 *
 * @returns Whether stored values are kept secret.
 */
export async function secureStoreIsSecret(): Promise<boolean> {
  if (securePlugin()) return true;
  if (!onDesktop()) return false;
  try {
    return (await viaDesktop("secureStore", (d) => d.secureGet(DESKTOP_PROBE_KEY))) !== undefined;
  } catch {
    return false; // the keychain refused (Windows fails closed): not a secret store
  }
}

/** Refuse an empty or non-string key (the native plugin rejects one too). */
function checkKey(fn: string, key: string): void {
  if (typeof key !== "string" || key === "") {
    throw new TypeError(`secureStore.${fn}: the key must be a non-empty string`);
  }
}

/** `value` with its biometric prefix removed after the user is verified, else `value`. */
async function ungated(value: string | null, options: SecureStoreGetOptions | undefined) {
  if (value === null || !value.startsWith(BIOMETRIC_PREFIX)) return value;
  await authenticateBiometric({
    reason: options?.reason ?? "Unlock a saved secret",
    allowDeviceCredential: options?.allowDeviceCredential === true,
  });
  return value.slice(BIOMETRIC_PREFIX.length);
}

/** The stored form of `value`: prefixed when biometric-gated; refuses a value that looks gated. */
function stored(value: string, options: SecureStoreSetOptions | undefined): string {
  if (options?.requireBiometric === true) return BIOMETRIC_PREFIX + value;
  if (value.startsWith(BIOMETRIC_PREFIX)) {
    throw new TypeError(
      "secureStore.set: the value starts with denext's reserved biometric prefix",
    );
  }
  return value;
}

/** A request's result, as a promise. */
function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Open the fallback database, creating its store on first use. */
function openDb(): Promise<IDBDatabase> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    return Promise.reject(new Error("secureStore: no IndexedDB here (called during SSR?)"));
  }
  const request = idb.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  return done(request);
}

/**
 * Run `op` against the fallback store in a `mode` transaction; for a write, settle once the
 * transaction commits.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const result = await done(op(tx.objectStore(STORE)));
    if (mode === "readwrite") await committed;
    else committed.catch(() => {});
    return result;
  } finally {
    db.close();
  }
}

/**
 * A string key-value store for secrets.
 *
 * - Inside the native shell with `@aparajita/capacitor-secure-storage` installed (`denext
 *   mobile add secure-store`), values live in the iOS Keychain (accessible when the device is
 *   unlocked, not synced to iCloud) or encrypted with an Android Keystore key. Keys share the
 *   plugin's default prefix, so its own `SecureStorage.getItem`/`setItem` see the same
 *   entries.
 * - Inside a Deno Desktop window (`denext desktop add secure-store`), the OS keychain: the
 *   macOS Keychain or libsecret, through the desktop runtime. Windows is not supported yet:
 *   there the capability fails closed (a real error, never the plaintext web fallback).
 * - **On the web it is NOT secret.** The fallback is a plain IndexedDB database
 *   (`denext-secure-store`) that any script on the origin, and anyone with the device's
 *   browser profile, can read. It keeps a web build working; it does not protect anything.
 *
 * Values are strings: `JSON.stringify` anything else.
 *
 * `set(key, value, { requireBiometric: true })` gates the value: every `get` asks for Face ID /
 * Touch ID / a fingerprint first (`denext mobile add biometrics`) and rejects with a
 * `BiometricError` when the user is not verified, including always on the web. The gate is in
 * denext's code, not in the Keychain item (see {@linkcode SecureStoreSetOptions}).
 *
 * @example
 * ```ts
 * import { secureStore } from "denext/mobile";
 *
 * await secureStore.set("refreshToken", token);
 * const saved = await secureStore.get("refreshToken"); // string | null
 * await secureStore.delete("refreshToken"); // sign out
 * ```
 */
export const secureStore: SecureStore = {
  async get(key: string, options?: SecureStoreGetOptions): Promise<string | null> {
    checkKey("get", key);
    const desktop = onDesktop() && await viaDesktop("secureStore", (d) => d.secureGet(key), true);
    if (desktop) return await ungated(desktop.value, options);
    const plugin = securePlugin();
    if (plugin) {
      const { data } = await plugin.internalGetItem({
        prefixedKey: NATIVE_PREFIX + key,
        sync: false,
      });
      return await ungated(typeof data === "string" ? data : null, options);
    }
    warnNativeFallback();
    const value = await withStore("readonly", (s) => s.get(key));
    return await ungated(typeof value === "string" ? value : null, options);
  },
  async set(key: string, value: string, options?: SecureStoreSetOptions): Promise<void> {
    checkKey("set", key);
    if (typeof value !== "string") {
      throw new TypeError("secureStore.set: the value must be a string (JSON.stringify it)");
    }
    const data = stored(value, options);
    if (onDesktop() && await viaDesktop("secureStore", (d) => d.secureSet(key, data), true)) return;
    const plugin = securePlugin();
    if (plugin) {
      return await plugin.internalSetItem({
        prefixedKey: NATIVE_PREFIX + key,
        data,
        sync: false,
        access: options?.requireBiometric === true
          ? WHEN_PASSCODE_SET_THIS_DEVICE_ONLY
          : WHEN_UNLOCKED,
      });
    }
    // A gated value promises protection the plaintext fallback cannot give: refuse it.
    if (options?.requireBiometric === true) {
      throw new TypeError(
        "secureStore.set: requireBiometric needs a secret store (the shell's secure-storage " +
          "plugin or the desktop keychain); the web fallback is plain IndexedDB, so the value " +
          "was not stored",
      );
    }
    warnNativeFallback();
    await withStore("readwrite", (s) => s.put(data, key));
  },
  async delete(key: string): Promise<void> {
    checkKey("delete", key);
    if (onDesktop() && await viaDesktop("secureStore", (d) => d.secureDelete(key), true)) return;
    const plugin = securePlugin();
    if (plugin) {
      await plugin.internalRemoveItem({ prefixedKey: NATIVE_PREFIX + key, sync: false });
      return;
    }
    await withStore("readwrite", (s) => s.delete(key));
  },
};
