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
 * `openKeyValueStore(name, { encrypted: true })` keeps the store in its own SQLCipher database
 * (`denext mobile add storage --encrypted`), keyed with a random key kept in
 * {@linkcode secureStore} (`denext mobile add secure-store`). Anywhere that cannot encrypt (the
 * browser, Deno Desktop, the fallbacks above, a build without SQLCipher, a secureStore that is not
 * secret) refuses with {@linkcode KeyValueStoreError} `ENCRYPTION_UNAVAILABLE` and writes nothing.
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

/** Options for {@linkcode openKeyValueStore}. */
export interface KeyValueStoreOptions {
  /**
   * Keep the store encrypted at rest: its own SQLCipher database in the iOS / Android app
   * (`denext mobile add storage --encrypted`), keyed with a random 256-bit key that is created on
   * first use and kept in {@linkcode secureStore} (the Keychain / Keystore; `denext mobile add
   * secure-store`). The store's plain rows from before move into it on the first open. Where
   * that is not possible every call rejects with `ENCRYPTION_UNAVAILABLE` and nothing is
   * written: the browser, Deno Desktop, `@capacitor-community/sqlite` or IndexedDB backings, a
   * build without SQLCipher, or a secureStore that is not secret.
   */
  readonly encrypted?: boolean;
}

/** Why an encrypted store refused a call ({@linkcode KeyValueStoreError.code}). */
export type KeyValueStoreErrorCode = "ENCRYPTION_UNAVAILABLE" | "WRONG_KEY";

/**
 * A refusal from an encrypted store: `ENCRYPTION_UNAVAILABLE` (nothing here can encrypt it, so
 * nothing was written) or `WRONG_KEY` (the key in secureStore does not open the store's file).
 */
export class KeyValueStoreError extends Error {
  /** Why. */
  readonly code: KeyValueStoreErrorCode;

  /**
   * A refusal with its code.
   *
   * @param code Why.
   * @param message What happened and what to do.
   */
  constructor(code: KeyValueStoreErrorCode, message: string) {
    super(message);
    this.name = "KeyValueStoreError";
    this.code = code;
  }
}

/** A named, durable string store ({@linkcode openKeyValueStore}). */
export interface KeyValueStore {
  /** The store's name. */
  readonly name: string;
  /** Whether it was opened `encrypted` ({@linkcode KeyValueStoreOptions.encrypted}). */
  readonly encrypted: boolean;
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

/**
 * One backing, shared by every store (`store` is the key space). Internal. `key` is an encrypted
 * store's key: only a driver with `cipher` is ever given one.
 */
export interface KvDriver {
  readonly kind: KeyValueBackend;
  getMany(store: string, keys: readonly string[], key?: string): Promise<(string | null)[]>;
  setMany(
    store: string,
    entries: ReadonlyArray<readonly [string, string]>,
    key?: string,
  ): Promise<void>;
  removeMany(store: string, keys: readonly string[], key?: string): Promise<void>;
  keys(store: string, key?: string): Promise<string[]>;
  clear(store: string, key?: string): Promise<void>;
  /** Whether it can keep an encrypted store (the native plugin with SQLCipher linked). */
  cipher?(): Promise<boolean>;
  /**
   * Re-encrypt encrypted store `store` from `key` to `newKey` (SQLCipher's `PRAGMA rekey`); absent
   * where the plugin predates it.
   */
  rekey?(store: string, key: string, newKey: string): Promise<void>;
}

/** The SQLite file (native plugin fallback, desktop) and the IndexedDB database name. */
const DB_NAME = "denext-kv.db";
const IDB_NAME = "denext-kv";
const IDB_STORE = "kv";
/** Keys per SQL statement (well under SQLite's bound-parameter limit). */
const CHUNK = 200;

/** An encrypted store's key on the wire (absent for a plain store). */
type Keyed = { key?: string };

/** The JS side of the native `DenextStorage` plugin (`denext mobile add storage`). */
interface StoragePlugin {
  getMany(o: { store: string; keys: string[] } & Keyed): Promise<{ values?: unknown[] }>;
  setMany(o: { store: string; entries: [string, string][] } & Keyed): Promise<unknown>;
  removeMany(o: { store: string; keys: string[] } & Keyed): Promise<unknown>;
  keys(o: { store: string } & Keyed): Promise<{ keys?: unknown[] }>;
  clear(o: { store: string } & Keyed): Promise<unknown>;
  /** Whether SQLCipher is linked (templates from denext 4.5 on; older ones lack it). */
  cipher?(): Promise<{ available?: unknown }>;
  /** Re-encrypt a store under `newKey` (templates from denext 4.8.1 on; older ones lack it). */
  rekey?(o: { store: string; key: string; newKey: string }): Promise<unknown>;
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

/** `{ key }` for an encrypted store's call, nothing for a plain one (the wire stays as it was). */
function keyed(key: string | undefined): Keyed {
  return key === undefined ? {} : { key };
}

/** A plugin rejection, as a {@linkcode KeyValueStoreError} when it carries one of its codes. */
async function coded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === "ENCRYPTION_UNAVAILABLE" || code === "WRONG_KEY") {
      throw new KeyValueStoreError(code, String((err as Error).message ?? err));
    }
    throw err;
  }
}

/** A driver over the `DenextStorage` plugin. */
function pluginDriver(plugin: StoragePlugin): KvDriver {
  return {
    kind: "native",
    async getMany(store, keys, key) {
      const out = await coded(() => plugin.getMany({ store, keys: [...keys], ...keyed(key) }));
      const values = Array.isArray(out?.values) ? out.values : [];
      return keys.map((_, i) => str(values[i]));
    },
    async setMany(store, entries, key) {
      const list = entries.map(([k, v]): [string, string] => [k, v]);
      await coded(() => plugin.setMany({ store, entries: list, ...keyed(key) }));
    },
    async removeMany(store, keys, key) {
      await coded(() => plugin.removeMany({ store, keys: [...keys], ...keyed(key) }));
    },
    async keys(store, key) {
      const out = await coded(() => plugin.keys({ store, ...keyed(key) }));
      return (Array.isArray(out?.keys) ? out.keys : []).filter((k) => typeof k === "string");
    },
    async clear(store, key) {
      await coded(() => plugin.clear({ store, ...keyed(key) }));
    },
    async cipher() {
      if (typeof plugin.cipher !== "function") return false;
      return (await plugin.cipher())?.available === true;
    },
    ...(typeof plugin.rekey === "function" && {
      async rekey(store: string, key: string, newKey: string) {
        await coded(() => plugin.rekey!({ store, key, newKey }));
      },
    }),
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
/** Each encrypted store's key, read (or created) once per page. */
const storeKeys = new Map<string, Promise<string>>();
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

/** The secureStore entry an encrypted store's key lives under. */
const KEY_PREFIX = "denext.kv.key.";
/**
 * The secureStore entry a rotation keeps its new key under until the store is rekeyed and the
 * key moved to {@linkcode KEY_PREFIX}: a process that dies in between leaves both, and the next
 * use finds which one opens the store ({@linkcode settledKey}).
 */
const NEXT_KEY_PREFIX = "denext.kv.next-key.";

/** Why `kind` cannot keep an encrypted store. */
function noCipher(kind: KeyValueBackend): string {
  switch (kind) {
    case "native":
      return "this app's DenextStorage plugin has no SQLCipher: run `denext mobile add storage " +
        "--encrypted`, then rebuild the app";
    case "sqlite":
      return "the store is backed by @capacitor-community/sqlite; encrypted stores need " +
        "denext's own plugin (`denext mobile add storage --encrypted`)";
    case "desktop":
      return "the Deno Desktop runtime's SQLite has no encryption";
    default:
      return "the browser's storage (IndexedDB) is not encrypted; encrypted stores run in the " +
        "iOS / Android app (`denext mobile add storage --encrypted`)";
  }
}

/** The key of encrypted store `name`: from secureStore, created there on first use. */
async function readOrCreateKey(name: string, kind: KeyValueBackend): Promise<string> {
  const { secureStore, secureStoreIsSecret } = await import("./secure-store.ts");
  const refuse = (why: string) =>
    new KeyValueStoreError(
      "ENCRYPTION_UNAVAILABLE",
      `openKeyValueStore("${name}", { encrypted: true }): ${why}. Nothing was written.`,
    );
  if (!(await secureStoreIsSecret())) {
    throw refuse(
      `secureStore is not secret here, so the store's key would sit in plain ${
        kind === "native" ? "WebView" : "browser"
      } storage (\`denext mobile add secure-store\`)`,
    );
  }
  const saved = await secureStore.get(KEY_PREFIX + name);
  if (saved) return saved;
  const key = randomKey();
  if (!(await keepKey(KEY_PREFIX + name, key))) {
    throw refuse("secureStore did not keep the key in the OS store");
  }
  return key;
}

/** A random 256-bit key, as hex. */
function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keep `key` in secureStore under `entry`; false (and nothing kept) when it is not the OS store. */
async function keepKey(entry: string, key: string): Promise<boolean> {
  const { secureStore } = await import("./secure-store.ts");
  const { stored } = await secureStore.set(entry, key);
  if (stored === "keychain") return true;
  await secureStore.delete(entry).catch(() => {});
  return false;
}

/** Whether `key` opens encrypted store `name` (a `WRONG_KEY` is false; anything else throws). */
async function opens(d: KvDriver, name: string, key: string): Promise<boolean> {
  try {
    await d.keys(name, key);
    return true;
  } catch (err) {
    if (err instanceof KeyValueStoreError && err.code === "WRONG_KEY") return false;
    throw err;
  }
}

/**
 * The key of encrypted store `name`, after finishing a rotation that a dead process left
 * half-done: with a pending new key in secureStore, the current key is kept when it still opens
 * the store (the rekey never ran; the pending key is dropped), else the pending key is promoted
 * when it opens it (the rekey ran; the move of the key did not).
 */
async function settledKey(name: string, d: KvDriver): Promise<string> {
  const { secureStore } = await import("./secure-store.ts");
  const current = await readOrCreateKey(name, d.kind);
  const next = await secureStore.get(NEXT_KEY_PREFIX + name);
  if (!next || next === current) {
    if (next) await secureStore.delete(NEXT_KEY_PREFIX + name);
    return current;
  }
  if (await opens(d, name, current)) {
    await secureStore.delete(NEXT_KEY_PREFIX + name);
    return current;
  }
  if (!(await opens(d, name, next))) {
    throw new KeyValueStoreError(
      "WRONG_KEY",
      `openKeyValueStore("${name}", { encrypted: true }): neither the store's key nor the key of ` +
        "its unfinished rotation opens it.",
    );
  }
  if (!(await keepKey(KEY_PREFIX + name, next))) {
    throw new KeyValueStoreError(
      "ENCRYPTION_UNAVAILABLE",
      `openKeyValueStore("${name}", { encrypted: true }): secureStore did not keep the key in ` +
        "the OS store.",
    );
  }
  await secureStore.delete(NEXT_KEY_PREFIX + name);
  return next;
}

/** The key of encrypted store `name`, once `d` is known to encrypt it; refuses where it cannot. */
async function checkedKey(name: string, d: KvDriver): Promise<string> {
  if (!(await d.cipher?.())) {
    throw new KeyValueStoreError(
      "ENCRYPTION_UNAVAILABLE",
      `openKeyValueStore("${name}", { encrypted: true }): ${
        noCipher(d.kind)
      }. Nothing was written.`,
    );
  }
  return await settledKey(name, d);
}

/**
 * The key an encrypted store's calls carry: checked and read once per page (a refusal is not
 * kept, so the next call asks again).
 */
function storeKey(name: string, d: KvDriver): Promise<string> {
  let key = storeKeys.get(name);
  if (!key) {
    key = checkedKey(name, d);
    storeKeys.set(name, key);
    key.catch(() => storeKeys.delete(name));
  }
  return key;
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
 * With `{ encrypted: true }` the store is encrypted at rest (SQLCipher, `denext mobile add
 * storage --encrypted`), its key kept in secureStore; anywhere that cannot encrypt it, every call
 * rejects with a {@linkcode KeyValueStoreError} (`ENCRYPTION_UNAVAILABLE`) and nothing is written.
 *
 * @param name The store's name (its key space).
 * @param options `encrypted` ({@linkcode KeyValueStoreOptions}).
 * @returns The store.
 * @example
 * ```ts
 * import { openKeyValueStore } from "denext/mobile";
 *
 * const prefs = openKeyValueStore("prefs");
 * await prefs.set("theme", "dark");
 * const [theme, font] = await prefs.getMany(["theme", "font"]);
 *
 * const vault = openKeyValueStore("vault", { encrypted: true });
 * await vault.set("pin", "4321"); // SQLCipher in the app; refused on the web
 * ```
 */
export function openKeyValueStore(
  name = "default",
  options: KeyValueStoreOptions = {},
): KeyValueStore {
  if (typeof name !== "string" || name === "") {
    throw new TypeError("openKeyValueStore: the name must be a non-empty string");
  }
  const encrypted = options?.encrypted === true;
  /** The backing and, for an encrypted store, its key (checked before every call). */
  const target = async (): Promise<[KvDriver, string | undefined]> => {
    const d = await backing();
    return [d, encrypted ? await storeKey(name, d) : undefined];
  };
  /**
   * Run `call` on the backing with the store's key. A `WRONG_KEY` from a call that took the key
   * just before a rotation ({@linkcode rekeyKeyValueStore}) changed it is retried once with the
   * new key.
   */
  const withKey = async <T>(call: (d: KvDriver, key: string | undefined) => Promise<T>) => {
    const [d, key] = await target();
    try {
      return await call(d, key);
    } catch (err) {
      if (!(err instanceof KeyValueStoreError) || err.code !== "WRONG_KEY") throw err;
      const [, latest] = await target();
      if (latest === key) throw err;
      return await call(d, latest);
    }
  };
  const store: KeyValueStore = {
    name,
    encrypted,
    backend: async () => (await backing()).kind,
    get: async (key) => (await store.getMany([checkKey("get", key)]))[0],
    async getMany(keys) {
      const list = keys.map((k) => checkKey("getMany", k));
      if (list.length === 0) return [];
      return await withKey((d, key) => d.getMany(name, list, key));
    },
    set: (key, value) => store.setMany([[key, value]]),
    async setMany(entries) {
      const list = entries.map(([k, v]): [string, string] => {
        const key = checkKey("setMany", k);
        return [key, checkValue("setMany", key, v)];
      });
      if (list.length === 0) return;
      await withKey((d, key) => d.setMany(name, list, key));
    },
    remove: (key) => store.removeMany([key]),
    async removeMany(keys) {
      const list = keys.map((k) => checkKey("removeMany", k));
      if (list.length === 0) return;
      await withKey((d, key) => d.removeMany(name, list, key));
    },
    keys: () => withKey((d, key) => d.keys(name, key)),
    async entries() {
      const keys = await store.keys();
      const values = await store.getMany(keys);
      return keys.flatMap((k, i) =>
        values[i] === null ? [] : [[k, values[i]!] as [string, string]]
      );
    },
    clear: () => withKey((d, key) => d.clear(name, key)),
  };
  return store;
}

/** Why a rotation can't run on `d`, or null when it can. */
async function rekeyRefusal(name: string, d: KvDriver): Promise<KeyValueStoreError | null> {
  const fn = `rekeyKeyValueStore("${name}")`;
  if (!(await d.cipher?.())) {
    return new KeyValueStoreError("ENCRYPTION_UNAVAILABLE", `${fn}: ${noCipher(d.kind)}.`);
  }
  if (!d.rekey) {
    return new KeyValueStoreError(
      "ENCRYPTION_UNAVAILABLE",
      `${fn}: this app's DenextStorage plugin predates key rotation: run \`denext mobile add ` +
        "storage --encrypted`, then rebuild the app.",
    );
  }
  return null;
}

/** {@linkcode rekeyKeyValueStore}'s work, once the store's current key is settled. */
async function rotate(name: string, d: KvDriver, current: string): Promise<string> {
  const { secureStore } = await import("./secure-store.ts");
  const next = randomKey();
  // The new key goes to its own entry first: the store's key stays the old one until the rekey
  // has committed, and a process that dies at any point leaves a key that opens the store.
  if (!(await keepKey(NEXT_KEY_PREFIX + name, next))) {
    throw new KeyValueStoreError(
      "ENCRYPTION_UNAVAILABLE",
      `rekeyKeyValueStore("${name}"): secureStore did not keep the new key in the OS store; ` +
        "nothing changed.",
    );
  }
  try {
    await d.rekey!(name, current, next);
  } catch (err) {
    // Settle it now (normally the old key still opens it and the new one is dropped).
    await settledKey(name, d).catch(() => {});
    throw err;
  }
  if (!(await keepKey(KEY_PREFIX + name, next))) {
    // Left in the pending entry: the next use promotes it.
    throw new KeyValueStoreError(
      "ENCRYPTION_UNAVAILABLE",
      `rekeyKeyValueStore("${name}"): the store was rekeyed, but secureStore did not move its ` +
        "key; the next use finishes the move.",
    );
  }
  await secureStore.delete(NEXT_KEY_PREFIX + name);
  return next;
}

/**
 * Rotate the key of the encrypted store `name` (`openKeyValueStore(name, { encrypted: true })`):
 * a new random 256-bit key, the store's SQLCipher database re-encrypted under it (`PRAGMA
 * rekey`, one transaction in SQLCipher), and the key in secureStore replaced. A store that has
 * no key yet is given one first, as its first use would.
 *
 * Crash safety: the new key is first kept in its own secureStore entry and the store's key stays
 * the old one until the rekey has committed; only then does the new key replace it. A process
 * that dies before the rekey commits leaves the store under the old key; one that dies after it
 * leaves the new key waiting in that entry. Either way the next use of the store tries the
 * current key, then the waiting one, and finishes the move — no data is lost.
 *
 * Calls on the store made while it rotates wait for the new key. Refused with
 * {@linkcode KeyValueStoreError} `ENCRYPTION_UNAVAILABLE` wherever encrypted stores are (the
 * browser, Deno Desktop, the fallbacks, a build without SQLCipher, a plugin from before 4.8.1,
 * a secureStore that is not secret), and `WRONG_KEY` when the stored key does not open the store.
 *
 * @param name The store's name (default `"default"`).
 * @example
 * ```ts
 * import { rekeyKeyValueStore } from "denext/mobile";
 *
 * await rekeyKeyValueStore("vault"); // e.g. after a sign-out, or on a schedule
 * ```
 */
export async function rekeyKeyValueStore(name = "default"): Promise<void> {
  if (typeof name !== "string" || name === "") {
    throw new TypeError("rekeyKeyValueStore: the name must be a non-empty string");
  }
  const d = await backing();
  const refusal = await rekeyRefusal(name, d);
  if (refusal) throw refusal;
  const previous = storeKeys.get(name);
  const rotation = (async () => {
    // Let calls that already have the key finish before the store changes under them.
    const current = await (previous ?? storeKey(name, d)).catch(() => null) ??
      await checkedKey(name, d);
    return await rotate(name, d, current);
  })();
  storeKeys.set(name, rotation);
  rotation.catch(() => {
    if (storeKeys.get(name) === rotation) storeKeys.delete(name);
  });
  await rotation;
}

/** Forget the opened backing, the store keys read and the warning (tests). */
export function resetKeyValueStoreForTesting(): void {
  driver = null;
  storeKeys.clear();
  warnedEvictable = false;
}
