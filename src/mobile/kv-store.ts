/**
 * A durable, asynchronous key-value store for `denext/mobile` (and the storage behind React
 * Native mode's `@react-native-async-storage/async-storage` and `react-native-mmkv`
 * stand-ins). Where the data lives depends on where the page runs:
 *
 * - **iOS / Android shell:** denext's native `DenextStorage` plugin (`denext mobile add
 *   storage`): one SQLite file in the app's own data folder, which the OS never evicts, unlike
 *   the WebView's `localStorage` / IndexedDB. Without it, an app that already has
 *   `@capacitor-community/sqlite` (`denext mobile add sqlite`) uses that; with neither, the
 *   store falls back to IndexedDB and warns once.
 * - **Deno Desktop:** the desktop runtime's SQLite (`denext desktop add sqlite`); until that is
 *   enabled, IndexedDB with the usual desktop fallback warning.
 * - **Browser:** IndexedDB. **SSR / tests without IndexedDB:** memory.
 *
 * Each named store is its own key space inside the one backing.
 *
 * @module
 */

import { isNativeShell, shellPlugin } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";
import { onDesktop, viaDesktop } from "./desktop-branch.ts";
import type { SqliteParams, SqliteRows } from "./sqlite-web.ts";

/**
 * Where a {@linkcode KeyValueStore} keeps its data: `"native"` (the `DenextStorage` plugin),
 * `"sqlite"` (`@capacitor-community/sqlite` in the shell), `"desktop"` (the Deno Desktop
 * runtime's SQLite), `"indexeddb"` (the browser's; evictable inside a native shell) or
 * `"memory"` (gone when the page closes).
 */
export type KeyValueBackend = "native" | "sqlite" | "desktop" | "indexeddb" | "memory";

/** A named, durable string store ({@linkcode openKeyValueStore}). */
export interface KeyValueStore {
  /** The store's name. */
  readonly name: string;
  /** Where the data lives (resolves once the backing is open). */
  backend(): Promise<KeyValueBackend>;
  /** The value of `key`, or `null`. */
  get(key: string): Promise<string | null>;
  /** The values of `keys`, in order (`null` for a missing key); one round trip. */
  getMany(keys: readonly string[]): Promise<(string | null)[]>;
  /** Store `value` under `key`. */
  set(key: string, value: string): Promise<void>;
  /** Store every `[key, value]` pair; one round trip. */
  setMany(entries: ReadonlyArray<readonly [string, string]>): Promise<void>;
  /** Remove `key` (a missing key is not an error). */
  remove(key: string): Promise<void>;
  /** Remove every key in `keys`; one round trip. */
  removeMany(keys: readonly string[]): Promise<void>;
  /** Every key in the store. */
  keys(): Promise<string[]>;
  /** Every `[key, value]` pair in the store. */
  entries(): Promise<[string, string][]>;
  /** Remove every key in the store (other stores are untouched). */
  clear(): Promise<void>;
}

/** One backing, shared by every store (`store` is the key space). Internal. */
export interface KvDriver {
  readonly kind: KeyValueBackend;
  getMany(store: string, keys: readonly string[]): Promise<(string | null)[]>;
  setMany(store: string, entries: ReadonlyArray<readonly [string, string]>): Promise<void>;
  removeMany(store: string, keys: readonly string[]): Promise<void>;
  keys(store: string): Promise<string[]>;
  clear(store: string): Promise<void>;
}

/** The SQLite file (native plugin fallback, desktop) and the IndexedDB database name. */
const DB_NAME = "denext-kv.db";
const IDB_NAME = "denext-kv";
const IDB_STORE = "kv";
/** Keys per SQL statement (well under SQLite's bound-parameter limit). */
const CHUNK = 200;

/** The JS side of the native `DenextStorage` plugin (`denext mobile add storage`). */
interface StoragePlugin {
  getMany(o: { store: string; keys: string[] }): Promise<{ values?: unknown[] }>;
  setMany(o: { store: string; entries: [string, string][] }): Promise<unknown>;
  removeMany(o: { store: string; keys: string[] }): Promise<unknown>;
  keys(o: { store: string }): Promise<{ keys?: unknown[] }>;
  clear(o: { store: string }): Promise<unknown>;
}

/** `items` in slices of at most `size`. */
function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A string, or `null` for anything else (the native wire sends `NSNull` / `JSONObject.NULL`). */
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// --- native plugin -----------------------------------------------------------------------------

/** A driver over the `DenextStorage` plugin. */
function pluginDriver(plugin: StoragePlugin): KvDriver {
  return {
    kind: "native",
    async getMany(store, keys) {
      const out = await plugin.getMany({ store, keys: [...keys] });
      const values = Array.isArray(out?.values) ? out.values : [];
      return keys.map((_, i) => str(values[i]));
    },
    async setMany(store, entries) {
      await plugin.setMany({ store, entries: entries.map(([k, v]) => [k, v]) });
    },
    async removeMany(store, keys) {
      await plugin.removeMany({ store, keys: [...keys] });
    },
    async keys(store) {
      const out = await plugin.keys({ store });
      return (Array.isArray(out?.keys) ? out.keys : []).filter((k) => typeof k === "string");
    },
    async clear(store) {
      await plugin.clear({ store });
    },
  };
}

// --- SQLite (desktop runtime, @capacitor-community/sqlite) --------------------------------------

/** The slice of a SQLite handle the driver uses. */
export interface SqlRunner {
  exec(sql: string): Promise<void>;
  run(sql: string, params: SqliteParams): Promise<unknown>;
  rows(sql: string, params: SqliteParams): Promise<SqliteRows>;
}

/** `?, ?, …` for `n` parameters. */
function marks(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** A driver over one SQLite database, table `kv`. */
export async function sqlKvDriver(db: SqlRunner, kind: KeyValueBackend): Promise<KvDriver> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS kv (store TEXT NOT NULL, key TEXT NOT NULL, " +
      "value TEXT NOT NULL, PRIMARY KEY (store, key)) WITHOUT ROWID",
  );
  return {
    kind,
    async getMany(store, keys) {
      const found = new Map<string, string>();
      for (const part of chunks([...new Set(keys)])) {
        const { rows } = await db.rows(
          `SELECT key, value FROM kv WHERE store = ? AND key IN (${marks(part.length)})`,
          [store, ...part],
        );
        for (const [k, v] of rows) found.set(String(k), String(v));
      }
      return keys.map((k) => found.get(k) ?? null);
    },
    async setMany(store, entries) {
      for (const part of chunks(entries)) {
        await db.run(
          `INSERT OR REPLACE INTO kv (store, key, value) VALUES ${
            part.map(() => "(?, ?, ?)").join(", ")
          }`,
          part.flatMap(([k, v]) => [store, k, v]),
        );
      }
    },
    async removeMany(store, keys) {
      for (const part of chunks(keys)) {
        await db.run(
          `DELETE FROM kv WHERE store = ? AND key IN (${marks(part.length)})`,
          [store, ...part],
        );
      }
    },
    async keys(store) {
      const { rows } = await db.rows("SELECT key FROM kv WHERE store = ? ORDER BY key", [store]);
      return rows.map(([k]) => String(k));
    },
    async clear(store) {
      await db.run("DELETE FROM kv WHERE store = ?", [store]);
    },
  };
}

// --- IndexedDB ---------------------------------------------------------------------------------

/** A request's result as a promise. */
function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** A transaction's completion as a promise. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Every `[store, key]` key of one store: from `[store, ""]` to `[store, []]` (arrays sort last). */
function storeRange(keyRange: typeof IDBKeyRange, store: string): IDBKeyRange {
  return keyRange.bound([store, ""], [store, []]);
}

/** A driver over IndexedDB: one object store keyed by `[store, key]`. */
export async function idbKvDriver(
  factory: IDBFactory,
  keyRange: typeof IDBKeyRange,
): Promise<KvDriver> {
  const open = factory.open(IDB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(IDB_STORE)) open.result.createObjectStore(IDB_STORE);
  };
  const db = await done(open);
  const tx = (mode: IDBTransactionMode) => db.transaction(IDB_STORE, mode);
  const range = (store: string) => storeRange(keyRange, store);
  return {
    kind: "indexeddb",
    async getMany(store, keys) {
      const t = tx("readonly");
      const os = t.objectStore(IDB_STORE);
      const values = await Promise.all(keys.map((k) => done(os.get([store, k]))));
      return values.map(str);
    },
    async setMany(store, entries) {
      const t = tx("readwrite");
      const os = t.objectStore(IDB_STORE);
      for (const [k, v] of entries) os.put(v, [store, k]);
      await committed(t);
    },
    async removeMany(store, keys) {
      const t = tx("readwrite");
      const os = t.objectStore(IDB_STORE);
      for (const k of keys) os.delete([store, k]);
      await committed(t);
    },
    async keys(store) {
      const all = await done(tx("readonly").objectStore(IDB_STORE).getAllKeys(range(store)));
      return all.map((k) => String((k as unknown[])[1]));
    },
    async clear(store) {
      const t = tx("readwrite");
      t.objectStore(IDB_STORE).delete(range(store));
      await committed(t);
    },
  };
}

// --- memory ------------------------------------------------------------------------------------

/** A driver over plain maps (SSR, tests, no IndexedDB). */
function memoryDriver(): KvDriver {
  const stores = new Map<string, Map<string, string>>();
  const of = (store: string) => {
    let map = stores.get(store);
    if (!map) stores.set(store, map = new Map());
    return map;
  };
  return {
    kind: "memory",
    getMany: (store, keys) => Promise.resolve(keys.map((k) => of(store).get(k) ?? null)),
    setMany: (store, entries) => {
      for (const [k, v] of entries) of(store).set(k, v);
      return Promise.resolve();
    },
    removeMany: (store, keys) => {
      for (const k of keys) of(store).delete(k);
      return Promise.resolve();
    },
    keys: (store) => Promise.resolve([...of(store).keys()].sort()),
    clear: (store) => {
      stores.delete(store);
      return Promise.resolve();
    },
  };
}

// --- selection ---------------------------------------------------------------------------------

/** The page's one backing (opened on first use). */
let driver: Promise<KvDriver> | null = null;
/** Whether the shell's evictable-fallback warning was printed. */
let warnedEvictable = false;

/** The native plugin, when the shell has it. */
function storagePlugin(): StoragePlugin | undefined {
  return nativePlugin<StoragePlugin>("DenextStorage", [
    "getMany",
    "setMany",
    "removeMany",
    "keys",
    "clear",
  ]);
}

/** A {@linkcode SqlRunner} over a SQLite handle whose row query is `rows`. */
function runner(
  db: {
    exec(sql: string): Promise<void>;
    run(sql: string, params: SqliteParams): Promise<unknown>;
  },
  rows: SqlRunner["rows"],
): SqlRunner {
  return { exec: (sql) => db.exec(sql), run: (sql, params) => db.run(sql, params), rows };
}

/** `@capacitor-community/sqlite` in the shell, when the app has it. */
async function communitySqlite(): Promise<KvDriver | null> {
  if (!shellPlugin("CapacitorSQLite")) return null;
  try {
    const { openSqlite } = await import("./sqlite.ts");
    const db = await openSqlite(DB_NAME);
    return await sqlKvDriver(runner(db, (sql, params) => db.queryRows(sql, params)), "sqlite");
  } catch {
    return null;
  }
}

/** The desktop runtime's SQLite, when `denext desktop add sqlite` enabled it. */
async function desktopSqlite(): Promise<KvDriver | null> {
  const opened = await viaDesktop("sqlite", (d) => d.openDesktopSqlite(DB_NAME), true);
  if (!opened) return null;
  const db = opened.value;
  return await sqlKvDriver(runner(db, (sql, params) => db.query(sql, params)), "desktop");
}

/** The browser's IndexedDB, when there is one and it opens. */
async function browserStore(): Promise<KvDriver | null> {
  const g = globalThis as { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange };
  if (!g.indexedDB || !g.IDBKeyRange) return null;
  try {
    return await idbKvDriver(g.indexedDB, g.IDBKeyRange);
  } catch {
    return null;
  }
}

/** Pick the most durable backing this page has. */
async function pickDriver(): Promise<KvDriver> {
  const desktop = onDesktop() ? await desktopSqlite() : null;
  if (desktop) return desktop;
  const plugin = storagePlugin();
  if (plugin) return pluginDriver(plugin);
  const sqlite = await communitySqlite();
  if (sqlite) return sqlite;
  if (isNativeShell() && !warnedEvictable) {
    warnedEvictable = true;
    console.warn(
      "denext: no durable native store in this app (`denext mobile add storage`); " +
        "openKeyValueStore / AsyncStorage fall back to the WebView's IndexedDB, which the OS " +
        "may evict under storage pressure.",
    );
  }
  return await browserStore() ?? memoryDriver();
}

/** The page's backing, opened once (a failed open is retried on the next call). */
function backing(): Promise<KvDriver> {
  driver ??= pickDriver().catch((err) => {
    driver = null;
    throw err;
  });
  return driver;
}

/** Refuse a key that is not a string. */
function checkKey(fn: string, key: unknown): string {
  if (typeof key !== "string") throw new TypeError(`${fn}: the key must be a string`);
  return key;
}

/** Refuse a value that is not a string. */
function checkValue(fn: string, key: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`${fn}: the value of "${key}" must be a string (JSON.stringify it)`);
  }
  return value;
}

/**
 * Open the durable key-value store `name` (default `"default"`). Nothing is opened until the
 * first call; every store shares one backing, and each has its own keys.
 *
 * Inside the iOS / Android shell the data is written to a SQLite file in the app's data folder
 * by denext's `DenextStorage` plugin (`denext mobile add storage`), which the OS does not evict
 * the way it may evict a WebView's `localStorage` and IndexedDB under storage pressure.
 * `backend()` says where it went; see the module docs for the fallbacks.
 *
 * @param name The store's name (its key space).
 * @returns The store.
 * @example
 * ```ts
 * import { openKeyValueStore } from "denext/mobile";
 *
 * const prefs = openKeyValueStore("prefs");
 * await prefs.set("theme", "dark");
 * const [theme, font] = await prefs.getMany(["theme", "font"]);
 * ```
 */
export function openKeyValueStore(name = "default"): KeyValueStore {
  if (typeof name !== "string" || name === "") {
    throw new TypeError("openKeyValueStore: the name must be a non-empty string");
  }
  const store: KeyValueStore = {
    name,
    backend: async () => (await backing()).kind,
    get: async (key) => (await store.getMany([checkKey("get", key)]))[0],
    async getMany(keys) {
      const list = keys.map((k) => checkKey("getMany", k));
      return list.length === 0 ? [] : await (await backing()).getMany(name, list);
    },
    set: (key, value) => store.setMany([[key, value]]),
    async setMany(entries) {
      const list = entries.map(([k, v]): [string, string] => {
        const key = checkKey("setMany", k);
        return [key, checkValue("setMany", key, v)];
      });
      if (list.length > 0) await (await backing()).setMany(name, list);
    },
    remove: (key) => store.removeMany([key]),
    async removeMany(keys) {
      const list = keys.map((k) => checkKey("removeMany", k));
      if (list.length > 0) await (await backing()).removeMany(name, list);
    },
    keys: async () => await (await backing()).keys(name),
    async entries() {
      const keys = await store.keys();
      const values = await store.getMany(keys);
      return keys.flatMap((k, i) =>
        values[i] === null ? [] : [[k, values[i]!] as [string, string]]
      );
    },
    clear: async () => await (await backing()).clear(name),
  };
  return store;
}

/** Forget the opened backing and the warning (tests). */
export function resetKeyValueStoreForTesting(): void {
  driver = null;
  warnedEvictable = false;
}
