/**
 * `react-native-mmkv` for denext's React Native mode: MMKV's synchronous API over an in-memory
 * mirror, written through to `denext/mobile`'s durable {@linkcode openKeyValueStore} (the
 * `DenextStorage` plugin's SQLite file in the Capacitor shell, `denext mobile add storage`;
 * the desktop runtime's SQLite; IndexedDB in a browser).
 *
 * A WebView has no JSI, so no synchronous native read exists. The mirror is seeded
 * synchronously from `localStorage` (the package's own web build format, `<id>\<key>`, which
 * every write keeps current) and then reconciled with the durable store in the background:
 * reads are synchronous and right from the first render in the usual case. The gap is a
 * relaunch after the OS evicted the WebView's storage: until {@linkcode mmkvReady} resolves,
 * reads see what `localStorage` still had, and each key the durable store restores then fires
 * the value-changed listeners (so the `useMMKV*` hooks re-render). Await `mmkvReady()` before
 * the first render when that matters. A write is in memory and `localStorage` at once and in
 * the durable store a moment later (not before the call returns).
 *
 * Both APIs: 4.x (`createMMKV`, `remove`, `existsMMKV`, `deleteMMKV`, `useMMKVKeys`) and 3.x
 * (`new MMKV()`, `delete`, `Mode`). `encryptionKey` is refused (the backing is not encrypted;
 * keep secrets in `secureStore`); `path` and `mode` are accepted and ignored.
 *
 * @example
 * ```ts
 * import { createMMKV } from "react-native-mmkv";
 *
 * const storage = createMMKV();
 * storage.set("user.name", "Ada");
 * storage.getString("user.name"); // "Ada", synchronously
 * ```
 *
 * @module
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "../runtime/hooks.ts";
import { type KeyValueStore, openKeyValueStore } from "../mobile/kv-store.ts";

/** 3.x's process mode (accepted and ignored). */
export enum Mode {
  /** One process. */
  SINGLE_PROCESS = 1,
  /** Several processes (app extensions). */
  MULTI_PROCESS = 2,
}

/** An instance's configuration. */
export interface Configuration {
  /** The instance id (default `"mmkv.default"`). */
  id?: string;
  /** Accepted and ignored (the durable store has one location). */
  path?: string;
  /** Refused: the backing is not encrypted. */
  encryptionKey?: string;
  /** Refused with `encryptionKey`. */
  encryptionType?: "AES-128" | "AES-256";
  /** Accepted and ignored. */
  mode?: Mode | "single-process" | "multi-process";
  /** Refuse writes. */
  readOnly?: boolean;
  /** Skip a write whose value is unchanged. */
  compareBeforeSet?: boolean;
  /** Accepted and ignored. */
  recoveryStrategy?: "discard-on-error" | "recover-on-error";
}

/** A listener handle. */
export interface Listener {
  remove(): void;
}

/** A stored value. */
type Value = boolean | string | number | ArrayBuffer;

/** An MMKV instance. */
export interface MMKV {
  readonly id: string;
  readonly length: number;
  readonly size: number;
  readonly byteSize: number;
  readonly isReadOnly: boolean;
  readonly isEncrypted: boolean;
  set(key: string, value: Value): void;
  getBoolean(key: string): boolean | undefined;
  getString(key: string): string | undefined;
  getNumber(key: string): number | undefined;
  getBuffer(key: string): ArrayBuffer | undefined;
  contains(key: string): boolean;
  /** 4.x: remove `key`; whether it was there. */
  remove(key: string): boolean;
  /** 3.x's name for {@linkcode MMKV.remove}. */
  delete(key: string): void;
  getAllKeys(): string[];
  clearAll(): void;
  recrypt(key: string | undefined): void;
  encrypt(key: string, encryptionType?: "AES-128" | "AES-256"): void;
  decrypt(): void;
  trim(): void;
  checkContentChanged(): void;
  addOnValueChangedListener(onValueChanged: (key: string) => void): Listener;
  importAllFrom(other: MMKV): number;
}

/** The default instance's id. */
const DEFAULT_ID = "mmkv.default";
/** The package's web build separator between id and key in `localStorage`. */
const SEP = "\\";
/** How a buffer is kept as a string (lossless, unlike the web build's text decoding). */
const BUFFER_TAG = "\u0000denext-b64:";

/** `localStorage`, when reachable. */
function local(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return undefined;
  }
}

/** Every `<id>\<key>` entry `localStorage` holds for `id`. */
function localEntries(id: string): Map<string, string> {
  const out = new Map<string, string>();
  const storage = local();
  if (!storage) return out;
  try {
    const prefix = id + SEP;
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k === null || !k.startsWith(prefix)) continue;
      const v = storage.getItem(k);
      if (v !== null) out.set(k.slice(prefix.length), v);
    }
  } catch {
    // Unreachable storage: the durable store fills the mirror.
  }
  return out;
}

/** Write (or with `null`, remove) one mirrored key, best effort (quota, private mode). */
function mirror(id: string, key: string, value: string | null): void {
  try {
    const storage = local();
    if (value === null) storage?.removeItem(id + SEP + key);
    else storage?.setItem(id + SEP + key, value);
  } catch {
    // The durable store still has it.
  }
}

/** Bytes as base64. */
function toBase64(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Base64 as bytes. */
function fromBase64(text: string): ArrayBuffer {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/** A value as the string the mirror and the store keep. */
function encode(value: Value): string {
  if (value instanceof ArrayBuffer) return BUFFER_TAG + toBase64(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return BUFFER_TAG + toBase64(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
    );
  }
  return String(value);
}

/** Refuse a key the package refuses. */
function checkKey(key: string): void {
  if (key === "") throw new Error("Cannot set a value for an empty key!");
  if (key.includes(SEP)) {
    throw new Error("MMKV: `key` cannot contain the backslash character (`\\`)!");
  }
}

/** The per-id state every instance of that id shares (one mirror, one write queue). */
interface Space {
  readonly id: string;
  readonly values: Map<string, string>;
  readonly listeners: Set<(key: string) => void>;
  readonly store: KeyValueStore;
  /** Keys written in this page before hydration finished (they win over the durable copy). */
  readonly touched: Set<string>;
  /** The durable writes, in order. */
  queue: Promise<void>;
  ready: Promise<void>;
}

/** Every id's space, created on first use. */
const spaces = new Map<string, Space>();
/** Where a space records that its `localStorage` data was copied to the durable store. */
const META_STORE = "denext-meta";

/** Notify `space`'s listeners that `key` changed. */
function changed(space: Space, key: string): void {
  for (const fn of [...space.listeners]) fn(key);
}

/** Queue a durable write after the ones before it (a failure is reported, the chain goes on). */
function persist(space: Space, work: (store: KeyValueStore) => Promise<void>): void {
  space.queue = space.queue.then(() => work(space.store)).catch((err) => {
    console.warn(`react-native-mmkv (${space.id}): a durable write failed:`, err);
  });
}

/**
 * Reconcile the mirror with the durable store: the first time, copy what only `localStorage`
 * had into the store; afterwards the store wins for every key this page has not written yet.
 */
async function hydrate(space: Space): Promise<void> {
  const meta = openKeyValueStore(META_STORE);
  const marker = `mmkv:${space.id}:migrated`;
  const durable = new Map(await space.store.entries());
  const migrated = await meta.get(marker) !== null;
  if (!migrated) {
    const missing = [...space.values].filter(([k]) => !durable.has(k) && !space.touched.has(k));
    if (missing.length > 0) await space.store.setMany(missing);
    for (const [k, v] of missing) durable.set(k, v);
    if (await space.store.backend() !== "memory") await meta.set(marker, "1");
  }
  for (const [k, v] of durable) {
    if (space.touched.has(k) || space.values.get(k) === v) continue;
    space.values.set(k, v);
    mirror(space.id, k, v);
    changed(space, k);
  }
  for (const k of [...space.values.keys()]) {
    if (durable.has(k) || space.touched.has(k)) continue;
    space.values.delete(k);
    mirror(space.id, k, null);
    changed(space, k);
  }
}

/** `id`'s space: seeded from `localStorage` now, reconciled with the durable store after. */
function spaceFor(id: string): Space {
  let space = spaces.get(id);
  if (space) return space;
  space = {
    id,
    values: localEntries(id),
    listeners: new Set(),
    store: openKeyValueStore(`mmkv:${id}`),
    touched: new Set(),
    queue: Promise.resolve(),
    ready: Promise.resolve(),
  };
  spaces.set(id, space);
  const s = space;
  s.ready = hydrate(s).catch((err) => {
    console.warn(`react-native-mmkv (${id}): could not read the durable store:`, err);
  });
  s.queue = s.ready;
  return s;
}

/** Record a local change to `key` (before hydration, it wins over the durable copy). */
function touch(space: Space, key: string): void {
  space.touched.add(key);
}

/** An instance over `config.id`'s space. */
function instance(config: Configuration = {}): MMKV {
  if (config.encryptionKey != null || config.encryptionType != null) {
    throw new Error(
      "MMKV: encryption is not supported in denext's React Native mode (the durable store is " +
        "not encrypted); keep secrets in secureStore from denext/mobile (expo-secure-store).",
    );
  }
  const id = config.id ?? DEFAULT_ID;
  if (id.includes(SEP)) {
    throw new Error("MMKV: `id` cannot contain the backslash character (`\\`)!");
  }
  const space = spaceFor(id);
  const readOnly = config.readOnly === true;
  const writable = () => {
    if (readOnly) throw new Error(`MMKV (${id}) is read-only`);
  };
  const raw = (key: string) => space.values.get(key);
  const self: MMKV = {
    id,
    get length() {
      return space.values.size;
    },
    get size() {
      return self.byteSize;
    },
    get byteSize() {
      let n = 0;
      for (const [k, v] of space.values) n += k.length + v.length;
      return n;
    },
    isReadOnly: readOnly,
    isEncrypted: false,
    set(key, value) {
      writable();
      checkKey(key);
      const text = encode(value);
      if (config.compareBeforeSet && raw(key) === text) return;
      touch(space, key);
      space.values.set(key, text);
      mirror(id, key, text);
      persist(space, (store) => store.set(key, text));
      changed(space, key);
    },
    getString: (key) => raw(key),
    getNumber: (key) => {
      const v = raw(key);
      return v === undefined ? undefined : Number(v);
    },
    getBoolean: (key) => {
      const v = raw(key);
      return v === undefined ? undefined : v === "true";
    },
    getBuffer: (key) => {
      const v = raw(key);
      if (v === undefined) return undefined;
      if (v.startsWith(BUFFER_TAG)) return fromBase64(v.slice(BUFFER_TAG.length));
      return new TextEncoder().encode(v).buffer as ArrayBuffer;
    },
    contains: (key) => space.values.has(key),
    remove(key) {
      writable();
      if (!space.values.has(key)) return false;
      touch(space, key);
      space.values.delete(key);
      mirror(id, key, null);
      persist(space, (store) => store.remove(key));
      changed(space, key);
      return true;
    },
    delete(key) {
      self.remove(key);
    },
    getAllKeys: () => [...space.values.keys()],
    clearAll() {
      writable();
      const keys = [...space.values.keys()];
      for (const k of keys) {
        touch(space, k);
        mirror(id, k, null);
      }
      space.values.clear();
      persist(space, (store) => store.clear());
      for (const k of keys) changed(space, k);
    },
    recrypt: () => {
      throw new Error("MMKV: encryption is not supported in denext's React Native mode");
    },
    encrypt: () => {
      throw new Error("MMKV: encryption is not supported in denext's React Native mode");
    },
    decrypt: () => {},
    trim: () => {},
    checkContentChanged: () => {},
    addOnValueChangedListener(fn) {
      space.listeners.add(fn);
      return { remove: () => void space.listeners.delete(fn) };
    },
    importAllFrom(other) {
      let n = 0;
      for (const key of other.getAllKeys()) {
        const v = other.getString(key);
        if (v === undefined) continue;
        self.set(key, v);
        n++;
      }
      return n;
    },
  };
  return self;
}

/**
 * 3.x's constructor: `new MMKV({ id })`. The instance shares its id's data with every other
 * instance of that id.
 */
export const MMKV = function MMKV(this: unknown, config?: Configuration): MMKV {
  return instance(config);
} as unknown as { new (config?: Configuration): MMKV; (config?: Configuration): MMKV };

/**
 * 4.x's factory: the instance for `config.id` (default `"mmkv.default"`).
 *
 * @param config The instance's configuration.
 * @returns The instance.
 */
export function createMMKV(config?: Configuration): MMKV {
  return instance(config);
}

/**
 * Whether instance `id` holds data.
 *
 * @param id The instance id.
 * @returns `true` when it has a key.
 */
export function existsMMKV(id: string): boolean {
  return (spaces.get(id)?.values.size ?? localEntries(id).size) > 0;
}

/**
 * Delete instance `id`'s data (memory, `localStorage` and the durable store).
 *
 * @param id The instance id.
 * @returns Whether it had data.
 */
export function deleteMMKV(id: string): boolean {
  const had = existsMMKV(id);
  instance({ id }).clearAll();
  return had;
}

/**
 * denext's addition: resolves once instance `id`'s mirror is reconciled with the durable store
 * (see the module docs). Await it before the first render when a read must not miss data the
 * OS evicted from `localStorage`.
 *
 * @param idOrInstance An instance, or an id (default `"mmkv.default"`).
 * @returns When the durable data is in the mirror.
 */
export async function mmkvReady(idOrInstance: string | MMKV = DEFAULT_ID): Promise<void> {
  const id = typeof idOrInstance === "string" ? idOrInstance : idOrInstance.id;
  await spaceFor(id).ready;
}

/** The default instance, created on first use. */
let defaultInstance: MMKV | null = null;

/** The default instance. */
function defaultMMKV(): MMKV {
  return defaultInstance ??= instance();
}

/**
 * The default instance, or one for `configuration` (kept while the configuration is equal).
 *
 * @param configuration The instance's configuration.
 * @returns The instance.
 */
export function useMMKV(configuration?: Configuration): MMKV {
  const ref = useRef<{ key: string; mmkv: MMKV } | null>(null);
  if (configuration == null) return defaultMMKV();
  const key = JSON.stringify(configuration);
  if (ref.current?.key !== key) ref.current = { key, mmkv: instance(configuration) };
  return ref.current.mmkv;
}

/**
 * Call `fn` with each key of `instance` (default: the default instance) that changes.
 *
 * @param fn The listener.
 * @param instance The instance.
 */
export function useMMKVListener(fn: (key: string) => void, instance?: MMKV): void {
  const ref = useRef(fn);
  ref.current = fn;
  const mmkv = instance ?? defaultMMKV();
  useEffect(() => {
    const listener = mmkv.addOnValueChangedListener((key) => ref.current(key));
    return () => listener.remove();
  }, [mmkv]);
}

/** A value hook's setter: a value, or an updater of the current one (`undefined` removes). */
export type MMKVSetter<T> = (
  value: T | undefined | ((current: T | undefined) => T | undefined),
) => void;

/** The value at `key` through `getter`, kept current, and its setter (the package's `createMMKVHook`). */
function useMMKVValue<T>(
  getter: (mmkv: MMKV, key: string) => T | undefined,
  key: string,
  instance: MMKV | undefined,
): [T | undefined, MMKVSetter<T>] {
  const mmkv = instance ?? defaultMMKV();
  const subscribe = useCallback((onChange: () => void) => {
    const listener = mmkv.addOnValueChangedListener((k) => k === key && onChange());
    return () => listener.remove();
  }, [key, mmkv]);
  const read = useCallback(() => getter(mmkv, key), [key, mmkv]);
  const value = useSyncExternalStore(subscribe, read, read);
  const set = useCallback((v: T | undefined | ((current: T | undefined) => T | undefined)) => {
    const next = typeof v === "function"
      ? (v as (current: T | undefined) => T | undefined)(getter(mmkv, key))
      : v;
    if (next === undefined) mmkv.remove(key);
    else mmkv.set(key, next as unknown as Value);
  }, [key, mmkv]);
  return [value, set];
}

/**
 * The string at `key`, and its setter (`undefined` removes it).
 *
 * @param key The key.
 * @param instance The instance (default: the default instance).
 * @returns The value and its setter.
 */
export function useMMKVString(
  key: string,
  instance?: MMKV,
): [string | undefined, MMKVSetter<string>] {
  return useMMKVValue((m, k) => m.getString(k), key, instance);
}

/**
 * The number at `key`, and its setter.
 *
 * @param key The key.
 * @param instance The instance (default: the default instance).
 * @returns The value and its setter.
 */
export function useMMKVNumber(
  key: string,
  instance?: MMKV,
): [number | undefined, MMKVSetter<number>] {
  return useMMKVValue((m, k) => m.getNumber(k), key, instance);
}

/**
 * The boolean at `key`, and its setter.
 *
 * @param key The key.
 * @param instance The instance (default: the default instance).
 * @returns The value and its setter.
 */
export function useMMKVBoolean(
  key: string,
  instance?: MMKV,
): [boolean | undefined, MMKVSetter<boolean>] {
  return useMMKVValue((m, k) => m.getBoolean(k), key, instance);
}

/**
 * The buffer at `key`, and its setter.
 *
 * @param key The key.
 * @param instance The instance (default: the default instance).
 * @returns The value and its setter.
 */
export function useMMKVBuffer(
  key: string,
  instance?: MMKV,
): [ArrayBuffer | undefined, MMKVSetter<ArrayBuffer>] {
  return useMMKVValue((m, k) => m.getBuffer(k), key, instance);
}

/**
 * The JSON object at `key`, and its setter (`undefined` removes it).
 *
 * @param key The key.
 * @param instance The instance (default: the default instance).
 * @returns The value and its setter.
 */
export function useMMKVObject<T>(
  key: string,
  instance?: MMKV,
): [T | undefined, (value: T | undefined | ((prev: T | undefined) => T | undefined)) => void] {
  const [json, setJson] = useMMKVString(key, instance);
  const value = useMemo(() => (json == null ? undefined : JSON.parse(json) as T), [json]);
  const setValue = useCallback((v: T | undefined | ((prev: T | undefined) => T | undefined)) => {
    if (typeof v === "function") {
      setJson((current) => {
        const next = (v as (prev: T | undefined) => T | undefined)(
          current != null ? JSON.parse(current) as T : undefined,
        );
        return next != null ? JSON.stringify(next) : undefined;
      });
    } else {
      setJson(v != null ? JSON.stringify(v) : undefined);
    }
  }, [setJson]);
  return [value, setValue];
}

/**
 * Every key of `instance`, kept current as keys are added and removed.
 *
 * @param instance The instance (default: the default instance).
 * @returns The keys.
 */
export function useMMKVKeys(instance?: MMKV): string[] {
  const mmkv = instance ?? defaultMMKV();
  const [keys, setKeys] = useState<string[]>(() => mmkv.getAllKeys());
  useMMKVListener((key) => {
    setKeys((current) =>
      current.includes(key) === mmkv.contains(key) ? current : mmkv.getAllKeys()
    );
  }, mmkv);
  return keys;
}

/** Forget every instance (tests). */
export function resetMMKVForTesting(): void {
  spaces.clear();
  defaultInstance = null;
}
