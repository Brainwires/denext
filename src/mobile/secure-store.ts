/**
 * A small string key-value store for secrets (tokens, keys) for `denext/mobile`: the iOS
 * Keychain / Android Keystore through the native `SecureStorage` plugin in the shell, else
 * IndexedDB.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";

/** The store {@linkcode secureStore} implements. */
export interface SecureStore {
  /** The value stored under `key`, or `null` when there is none. */
  get(key: string): Promise<string | null>;
  /** Store `value` under `key`, replacing any earlier value. */
  set(key: string, value: string): Promise<void>;
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

/** Refuse an empty or non-string key (the native plugin rejects one too). */
function checkKey(fn: string, key: string): void {
  if (typeof key !== "string" || key === "") {
    throw new TypeError(`secureStore.${fn}: the key must be a non-empty string`);
  }
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
 * - **On the web it is NOT secret.** The fallback is a plain IndexedDB database
 *   (`denext-secure-store`) that any script on the origin, and anyone with the device's
 *   browser profile, can read. It keeps a web build working; it does not protect anything.
 *
 * Values are strings: `JSON.stringify` anything else.
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
  async get(key: string): Promise<string | null> {
    checkKey("get", key);
    const plugin = securePlugin();
    if (plugin) {
      const { data } = await plugin.internalGetItem({
        prefixedKey: NATIVE_PREFIX + key,
        sync: false,
      });
      return typeof data === "string" ? data : null;
    }
    const value = await withStore("readonly", (s) => s.get(key));
    return typeof value === "string" ? value : null;
  },
  async set(key: string, value: string): Promise<void> {
    checkKey("set", key);
    if (typeof value !== "string") {
      throw new TypeError("secureStore.set: the value must be a string (JSON.stringify it)");
    }
    const plugin = securePlugin();
    if (plugin) {
      return await plugin.internalSetItem({
        prefixedKey: NATIVE_PREFIX + key,
        data: value,
        sync: false,
        access: WHEN_UNLOCKED,
      });
    }
    await withStore("readwrite", (s) => s.put(value, key));
  },
  async delete(key: string): Promise<void> {
    checkKey("delete", key);
    const plugin = securePlugin();
    if (plugin) {
      await plugin.internalRemoveItem({ prefixedKey: NATIVE_PREFIX + key, sync: false });
      return;
    }
    await withStore("readwrite", (s) => s.delete(key));
  },
};
