/**
 * `@react-native-async-storage/async-storage` for denext's React Native mode, over
 * `denext/mobile`'s durable {@linkcode openKeyValueStore}: in the Capacitor shell the data goes
 * to a SQLite file in the app's data folder (the `DenextStorage` plugin, `denext mobile add
 * storage`), which iOS and Android do not evict the way they may evict the WebView's
 * `localStorage`, the package's own web backing. On Deno Desktop it is the runtime's SQLite
 * (`denext desktop add sqlite`); in a browser, IndexedDB.
 *
 * The whole 2.x API (`getItem` / `setItem` / `removeItem` / `mergeItem` / `clear` /
 * `getAllKeys` / `multiGet` / `multiSet` / `multiRemove` / `multiMerge` / `flushGetRequests`,
 * the callbacks, `useAsyncStorage`) plus 3.x's `getMany` / `setMany` / `removeMany`,
 * `createAsyncStorage` and `AsyncStorageError`. `mergeItem` deep-merges objects as the native
 * modules do (arrays are replaced, not concatenated as the package's web build does).
 *
 * The first call moves what an earlier build of the app wrote with the package's web build
 * (every `localStorage` key but denext's own and `react-native-mmkv`'s) into the durable store,
 * once; the `localStorage` copies are left in place.
 *
 * @example
 * ```ts
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 *
 * await AsyncStorage.setItem("token", "abc");
 * const pairs = await AsyncStorage.multiGet(["token", "user"]);
 * ```
 *
 * @module
 */

import { type KeyValueStore, openKeyValueStore } from "../mobile/kv-store.ts";

/** A key and its value (`null` when missing), as `multiGet` returns them. */
export type KeyValuePair = [string, string | null];

/** A completion callback. */
export type Callback = (error?: Error | null) => void;

/** A completion callback with a result. */
export type CallbackWithResult<T> = (error?: Error | null, result?: T | null) => void;

/** A batch completion callback. */
export type MultiCallback = (errors?: readonly (Error | null)[] | null) => void;

/** `multiGet`'s callback. */
export type MultiGetCallback = (
  errors?: readonly (Error | null)[] | null,
  result?: readonly KeyValuePair[],
) => void;

/** What {@linkcode useAsyncStorage} returns: the item methods bound to one key. */
export interface AsyncStorageHook {
  getItem(callback?: CallbackWithResult<string>): Promise<string | null>;
  setItem(value: string, callback?: Callback): Promise<void>;
  mergeItem(value: string, callback?: Callback): Promise<void>;
  removeItem(callback?: Callback): Promise<void>;
}

/** The 3.x instance API (`createAsyncStorage`, and the default export's 3.x half). */
export interface AsyncStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getMany(keys: string[]): Promise<Record<string, string | null>>;
  setMany(entries: Record<string, string>): Promise<void>;
  removeMany(keys: string[]): Promise<void>;
  getAllKeys(): Promise<string[]>;
  clear(): Promise<void>;
}

/** The default export: the 2.x static API plus 3.x's batch methods. */
export interface AsyncStorageStatic {
  getItem(key: string, callback?: CallbackWithResult<string>): Promise<string | null>;
  setItem(key: string, value: string, callback?: Callback): Promise<void>;
  removeItem(key: string, callback?: Callback): Promise<void>;
  mergeItem(key: string, value: string, callback?: Callback): Promise<void>;
  clear(callback?: Callback): Promise<void>;
  getAllKeys(callback?: CallbackWithResult<readonly string[]>): Promise<readonly string[]>;
  flushGetRequests(): void;
  multiGet(keys: readonly string[], callback?: MultiGetCallback): Promise<readonly KeyValuePair[]>;
  multiSet(
    keyValuePairs: ReadonlyArray<readonly [string, string]>,
    callback?: MultiCallback,
  ): Promise<void>;
  multiRemove(keys: readonly string[], callback?: MultiCallback): Promise<void>;
  multiMerge(
    keyValuePairs: ReadonlyArray<readonly [string, string]>,
    callback?: MultiCallback,
  ): Promise<void>;
  getMany(keys: readonly string[]): Promise<Record<string, string | null>>;
  setMany(entries: Record<string, string>): Promise<void>;
  removeMany(keys: readonly string[]): Promise<void>;
}

/** The kinds of {@linkcode AsyncStorageError}. */
export enum AsyncStorageErrorType {
  /** The native module failed. */
  NativeModuleError = "NativeModuleError",
  /** The web storage (IndexedDB) failed. */
  WebStorageError = "WebStorageError",
  /** SQLite failed. */
  SqliteStorageError = "SqliteStorageError",
  /** Some other storage failure. */
  OtherStorageError = "OtherStorageError",
  /** Unknown. */
  UnknownError = "UnknownError",
}

/** A storage failure, as 3.x reports it (`error.type` says which kind). */
export class AsyncStorageError extends Error {
  /** The kinds, as the package exposes them (`AsyncStorageError.Type.WebStorageError`). */
  static Type = AsyncStorageErrorType;

  /**
   * @param errorMessage The message.
   * @param type The kind.
   */
  constructor(public errorMessage: string, public type: AsyncStorageErrorType) {
    super(errorMessage);
    this.name = "AsyncStorageError";
  }

  /** An error from JS code (the package's factory). */
  static jsError(error: string, type: AsyncStorageErrorType): AsyncStorageError {
    return new AsyncStorageError(error, type);
  }

  /** An error from a native call (the package's factory). */
  static nativeError(e: unknown): AsyncStorageError {
    if (e instanceof AsyncStorageError) return e;
    const message = (e as { message?: unknown })?.message;
    return new AsyncStorageError(
      typeof message === "string" ? message : `Unknown error ${String(e)}`,
      AsyncStorageErrorType.UnknownError,
    );
  }
}

/** The durable store behind the default export (2.x's one global storage). */
const DEFAULT_STORE = "async-storage";
/** Where the one-time `localStorage` migration is recorded. */
const META_STORE = "denext-meta";
const MIGRATED_KEY = "async-storage:local-storage-migrated";

/** The default store, opened on first use. */
let defaultStore: KeyValueStore | null = null;
/** The migration, run once per page before the default store's first call. */
let migration: Promise<void> | null = null;

/** Whether a `localStorage` key belongs to AsyncStorage's web build (not denext, not MMKV). */
function isAppKey(key: string): boolean {
  return !key.startsWith("denext:") && !key.startsWith("__denext") && !key.includes("\\");
}

/** Every AsyncStorage-web `localStorage` entry, or none when storage is out of reach. */
function legacyEntries(): [string, string][] {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return [];
    const out: [string, string][] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null || !isAppKey(key)) continue;
      const value = storage.getItem(key);
      if (value !== null) out.push([key, value]);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Copy what the package's web build left in `localStorage` into `store`, once: keys the store
 * already has keep their value. Skipped (and retried next launch) while the backing is memory.
 */
async function migrateLocalStorage(store: KeyValueStore): Promise<void> {
  if (await store.backend() === "memory") return;
  const meta = openKeyValueStore(META_STORE);
  if (await meta.get(MIGRATED_KEY) !== null) return;
  const legacy = legacyEntries();
  if (legacy.length > 0) {
    const present = await store.getMany(legacy.map(([k]) => k));
    await store.setMany(legacy.filter((_, i) => present[i] === null));
  }
  await meta.set(MIGRATED_KEY, new Date().toISOString());
}

/** The default store, with the migration done. */
async function ready(): Promise<KeyValueStore> {
  const store = defaultStore ??= openKeyValueStore(DEFAULT_STORE);
  migration ??= migrateLocalStorage(store).catch((err) => {
    migration = null;
    throw err;
  });
  await migration;
  return store;
}

/** `value` as a string, warning as the package does when it is not one. */
function asValue(key: string, value: unknown): string {
  if (typeof value === "string") return value;
  console.warn(
    `[AsyncStorage] The value for key "${key}" is not a string. This can lead to unexpected ` +
      "behavior/errors. Consider stringifying it.",
  );
  return String(value);
}

/** Refuse a non-string key, as the package does. */
function asKey(key: unknown): string {
  if (typeof key !== "string") {
    console.warn(
      `[AsyncStorage] Using ${typeof key} type for key is not supported. This can lead to ` +
        "unexpected behavior/errors. Use string instead.",
    );
    return String(key);
  }
  return key;
}

/** The storage failure as the package's error. */
function toError(e: unknown): AsyncStorageError {
  if (e instanceof AsyncStorageError) return e;
  const message = (e as { message?: unknown })?.message;
  return new AsyncStorageError(
    typeof message === "string" ? message : String(e),
    AsyncStorageErrorType.OtherStorageError,
  );
}

/** Run `work`, settling `callback` the package's way (error first, then the result). */
async function withCallback<T>(
  work: () => Promise<T>,
  callback?: (error?: Error | null, result?: T | null) => void,
): Promise<T> {
  try {
    const result = await work();
    callback?.(null, result);
    return result;
  } catch (e) {
    const err = toError(e);
    callback?.(err);
    throw err;
  }
}

/** Run a batch `work`, settling a batch `callback` (an error array, or `null`). */
async function withMultiCallback<T>(
  work: () => Promise<T>,
  callback?: (errors?: readonly (Error | null)[] | null, result?: T) => void,
): Promise<T> {
  try {
    const result = await work();
    callback?.(null, result);
    return result;
  } catch (e) {
    const err = toError(e);
    callback?.([err]);
    throw err;
  }
}

/** Whether `v` is a plain object (merged key by key; anything else replaces). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `next` into `prev` as the native modules do: objects merge, all else replaces. */
function deepMerge(prev: unknown, next: unknown): unknown {
  if (!isPlainObject(prev) || !isPlainObject(next)) return next;
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue;
    out[k] = deepMerge(prev[k], v);
  }
  return out;
}

/** The merged JSON of `stored` (may be null) and `value`. */
function mergedValue(stored: string | null, value: string): string {
  const next = JSON.parse(value);
  if (stored === null) return value;
  return JSON.stringify(deepMerge(JSON.parse(stored), next));
}

/** Merge each `[key, json]` pair into what `store` holds. */
async function mergeInto(
  store: KeyValueStore,
  pairs: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  const keys = pairs.map(([k]) => asKey(k));
  const stored = await store.getMany(keys);
  const merged = new Map<string, string>();
  pairs.forEach(([, v], i) => {
    const key = keys[i];
    merged.set(key, mergedValue(merged.get(key) ?? stored[i], asValue(key, v)));
  });
  await store.setMany([...merged]);
}

/** `keys` mapped to their values, as 3.x's `getMany` returns them. */
async function valueRecord(
  store: KeyValueStore,
  keys: readonly string[],
): Promise<Record<string, string | null>> {
  const values = await store.getMany(keys.map(asKey));
  const out: Record<string, string | null> = {};
  keys.forEach((k, i) => (out[k] = values[i]));
  return out;
}

/** The 2.x static API over the default store (plus 3.x's batch methods). */
const AsyncStorageDefault: AsyncStorageStatic = {
  getItem: (key, callback) =>
    withCallback<string | null>(async () => (await ready()).get(asKey(key)), callback),
  setItem: (key, value, callback) =>
    withCallback(async () => (await ready()).set(asKey(key), asValue(key, value)), callback),
  removeItem: (key, callback) =>
    withCallback(async () => (await ready()).remove(asKey(key)), callback),
  mergeItem: (key, value, callback) =>
    withCallback(async () => mergeInto(await ready(), [[key, value]]), callback),
  clear: (callback) => withCallback(async () => (await ready()).clear(), callback),
  getAllKeys: (callback) =>
    withCallback(async () => (await ready()).keys() as Promise<readonly string[]>, callback),
  flushGetRequests: () => undefined,
  multiGet: (keys, callback) =>
    withMultiCallback(async () => {
      const values = await (await ready()).getMany(keys.map(asKey));
      return keys.map((k, i): KeyValuePair => [k, values[i]]);
    }, callback),
  multiSet: (pairs, callback) =>
    withMultiCallback(async () => {
      const entries = pairs.map(([k, v]): [string, string] => [asKey(k), asValue(k, v)]);
      await (await ready()).setMany(entries);
    }, callback),
  multiRemove: (keys, callback) =>
    withMultiCallback(async () => (await ready()).removeMany(keys.map(asKey)), callback),
  multiMerge: (pairs, callback) =>
    withMultiCallback(async () => mergeInto(await ready(), pairs), callback),
  getMany: async (keys) => valueRecord(await ready(), keys),
  setMany: async (entries) =>
    (await ready()).setMany(Object.entries(entries).map(([k, v]) => [k, asValue(k, v)])),
  removeMany: async (keys) => (await ready()).removeMany(keys.map(asKey)),
};

/**
 * The item methods of the default storage bound to `key` (2.x's hook; it holds no state and
 * does not re-render).
 *
 * @param key The key.
 * @returns `getItem`, `setItem`, `mergeItem` and `removeItem` for that key.
 */
export function useAsyncStorage(key: string): AsyncStorageHook {
  return {
    getItem: (callback) => AsyncStorageDefault.getItem(key, callback),
    setItem: (value, callback) => AsyncStorageDefault.setItem(key, value, callback),
    mergeItem: (value, callback) => AsyncStorageDefault.mergeItem(key, value, callback),
    removeItem: (callback) => AsyncStorageDefault.removeItem(key, callback),
  };
}

/** Run `work`, rethrowing its failure as an {@linkcode AsyncStorageError}. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw toError(e);
  }
}

/**
 * A separate storage named `databaseName` (3.x): its own keys, in the same durable backing.
 *
 * @param databaseName The storage's name.
 * @returns The storage.
 */
export function createAsyncStorage(databaseName: string): AsyncStorage {
  const store = openKeyValueStore(`async-storage:${databaseName}`);
  return {
    getItem: (key) => guarded(() => store.get(asKey(key))),
    setItem: (key, value) => guarded(() => store.set(asKey(key), asValue(key, value))),
    removeItem: (key) => guarded(() => store.remove(asKey(key))),
    getMany: (keys) => guarded(() => valueRecord(store, keys)),
    setMany: (entries) =>
      guarded(() => store.setMany(Object.entries(entries).map(([k, v]) => [k, asValue(k, v)]))),
    removeMany: (keys) => guarded(() => store.removeMany(keys.map(asKey))),
    getAllKeys: () => guarded(() => store.keys()),
    clear: () => guarded(() => store.clear()),
  };
}

/** Forget the default store and the migration run (tests). */
export function resetAsyncStorageForTesting(): void {
  defaultStore = null;
  migration = null;
}

export default AsyncStorageDefault;
