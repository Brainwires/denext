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
  /**
   * What to do when the OS secret store REFUSES the write (the desktop keychain answering
   * `backend_unavailable`: no Secret Service provider, a locked keyring nobody unlocked, or the
   * native plugin rejecting). Unset (the default) the call rejects, so the OS-protected contract
   * stays explicit. `"session"` keeps the value in the page's `sessionStorage` instead, warns
   * once with the reason, and reports `{ stored: "session" }`. **`sessionStorage` is NOT
   * secret**: any script on the origin can read it, and it ends with the tab or window (it
   * survives a reload). Ignored (the call still rejects) together with `requireBiometric`, which
   * promises a protection it cannot give.
   */
  readonly fallback?: SecureStoreFallback;
}

/** Where {@linkcode SecureStore.set} put the value. */
export interface SecureStoreSetResult {
  /**
   * `"keychain"`: the OS secret store (iOS Keychain, Android Keystore, the desktop keychain).
   * `"indexeddb"`: the web's not-secret IndexedDB database (no secret store here).
   * `"session"`: `sessionStorage`, because the OS store refused and `fallback: "session"` was
   * given; NOT secret.
   */
  readonly stored: "keychain" | "indexeddb" | "session";
}

/** The opt-in fallbacks of {@linkcode SecureStoreSetOptions.fallback}. */
export type SecureStoreFallback = "session";

/** Options for {@linkcode SecureStore.get}. */
export interface SecureStoreGetOptions {
  /** The prompt's reason when the value is biometric-gated (default "Unlock a saved secret"). */
  readonly reason?: string;
  /** Accept the device passcode too for a biometric-gated value (default `false`). */
  readonly allowDeviceCredential?: boolean;
  /**
   * `"session"`: when the OS secret store refuses the read, or answers that it holds no value for
   * the key, answer from the `sessionStorage` copy a `set(…, { fallback: "session" })` left
   * (`null` when there is none), and warn once with the reason. A value the OS store holds still
   * wins over the copy. Unset, a refusal rejects. See {@linkcode SecureStoreSetOptions.fallback}.
   */
  readonly fallback?: SecureStoreFallback;
}

/** The store {@linkcode secureStore} implements. */
export interface SecureStore {
  /**
   * The value stored under `key`, or `null` when there is none. A value stored with
   * `requireBiometric` asks for biometrics first and rejects with a `BiometricError` when the
   * user is not verified (always on the web, which has no biometrics).
   */
  get(key: string, options?: SecureStoreGetOptions): Promise<string | null>;
  /**
   * Store `value` under `key`, replacing any earlier value. Resolves with where it went (see
   * {@linkcode SecureStoreSetResult}); a caller that ignores the result is unaffected. A
   * successful OS-store write clears a `sessionStorage` copy of the same key.
   */
  set(key: string, value: string, options?: SecureStoreSetOptions): Promise<SecureStoreSetResult>;
  /** Remove `key` from the secret store and from any `sessionStorage` copy (a missing key is not an error). */
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

/** The `sessionStorage` key prefix of the opt-in `fallback: "session"` copies. */
const SESSION_PREFIX = "denext:secure-store:session:";

/** Whether the session fallback has been reported this page (once is enough). */
let warnedSessionFallback = false;

/** Re-arm the once-per-page session-fallback warning. Test seam; not re-exported. */
export function resetSecureStoreSessionWarningForTesting(): void {
  warnedSessionFallback = false;
}

/** `sessionStorage`, or `undefined` where it is missing or throws (SSR, blocked storage). */
function session(): Storage | undefined {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } catch {
    return undefined;
  }
}

/** Whether `err` is the OS store refusing (not a usage error such as a bad key or value). */
function isRefusal(err: unknown): boolean {
  return !(err instanceof TypeError);
}

/** The `sessionStorage` to fall back to for refusal `err`, when the caller opted in and it can. */
function fallbackStore(
  opted: SecureStoreFallback | undefined,
  err: unknown,
  gated = false,
): Storage | undefined {
  return opted === "session" && !gated && isRefusal(err) ? session() : undefined;
}

/** Warn once that `fn` fell back to the not-secret `sessionStorage`, naming why (`why`). */
function warnSessionFallback(fn: string, why: string): void {
  if (warnedSessionFallback) return;
  warnedSessionFallback = true;
  console.warn(
    `denext: secureStore.${fn} fell back to sessionStorage (fallback: "session"), which is NOT ` +
      `secret and ends with the tab; ${why}`,
  );
}

/** The fallback warning's reason for an OS-store refusal `err`. */
function refusedBecause(err: unknown): string {
  return `the OS secret store refused: ${err instanceof Error ? err.message : String(err)}`;
}

/** The `sessionStorage` copy of `key`, or `null` (none, or storage blocked). */
function readSession(key: string): string | null {
  try {
    return session()?.getItem(SESSION_PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

/** Drop the `sessionStorage` copy of `key`, if any. */
function clearSession(key: string): void {
  try {
    session()?.removeItem(SESSION_PREFIX + key);
  } catch { /* storage blocked: nothing to clear */ }
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

/** The web path of `set`: no OS store here, so IndexedDB (never for a biometric-gated value). */
async function setWeb(
  key: string,
  data: string,
  options: SecureStoreSetOptions | undefined,
): Promise<SecureStoreSetResult> {
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
  clearSession(key);
  return { stored: "indexeddb" };
}

/** The OS store's value for `key` (desktop keychain, then the shell plugin); `undefined` when neither exists. */
async function osGet(key: string): Promise<string | null | undefined> {
  const desktop = onDesktop() && await viaDesktop("secureStore", (d) => d.secureGet(key), true);
  if (desktop) return desktop.value;
  const plugin = securePlugin();
  if (!plugin) return undefined;
  const { data } = await plugin.internalGetItem({ prefixedKey: NATIVE_PREFIX + key, sync: false });
  return typeof data === "string" ? data : null;
}

/** Write `data` to the OS store; `false` when there is none here (the caller takes the web path). */
async function osSet(
  key: string,
  data: string,
  options: SecureStoreSetOptions | undefined,
): Promise<boolean> {
  if (onDesktop() && await viaDesktop("secureStore", (d) => d.secureSet(key, data), true)) {
    return true;
  }
  const plugin = securePlugin();
  if (!plugin) return false;
  await plugin.internalSetItem({
    prefixedKey: NATIVE_PREFIX + key,
    data,
    sync: false,
    access: options?.requireBiometric === true ? WHEN_PASSCODE_SET_THIS_DEVICE_ONLY : WHEN_UNLOCKED,
  });
  return true;
}

/**
 * A string key-value store for secrets.
 *
 * - Inside the native shell with `@aparajita/capacitor-secure-storage` installed (`denext
 *   mobile add secure-store`), values live in the iOS Keychain (accessible when the device is
 *   unlocked, not synced to iCloud) or encrypted with an Android Keystore key. Keys share the
 *   plugin's default prefix, so its own `SecureStorage.getItem`/`setItem` see the same
 *   entries.
 * - Inside a Deno Desktop window (`denext desktop add secure-store`), the OS credential store,
 *   through the desktop runtime: the macOS Keychain, the Windows `PasswordVault`, or the Secret
 *   Service on Linux (gnome-keyring or KWallet, through the runtime's libsecret). When that store
 *   is not usable (Linux without a Secret Service provider, with the keyring locked, or under a
 *   runtime without its own store) the call fails with `backend_unavailable` and says why: a real
 *   error, never `null` and never the plaintext web fallback.
 * - **On the web it is NOT secret.** The fallback is a plain IndexedDB database
 *   (`denext-secure-store`) that any script on the origin, and anyone with the device's
 *   browser profile, can read. It keeps a web build working; it does not protect anything.
 *
 * Values are strings: `JSON.stringify` anything else.
 *
 * `set(key, value, { fallback: "session" })` / `get(key, { fallback: "session" })` opt in to
 * `sessionStorage` when the OS store refuses (a locked or absent Linux keyring): the call warns
 * once and `set` resolves `{ stored: "session" }`. `get` also answers from that copy when the OS
 * store resolves with no value for the key (its own value, when present, wins). A successful OS
 * `set` clears the copy and `delete` clears both. That copy is NOT secret and ends with the tab.
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
    let raw: string | null | undefined;
    try {
      raw = await osGet(key);
    } catch (err) {
      const store = fallbackStore(options?.fallback, err);
      if (!store) throw err;
      warnSessionFallback("get", refusedBecause(err));
      return store.getItem(SESSION_PREFIX + key);
    }
    if (raw === null && options?.fallback === "session") {
      // The OS store answers but has nothing: a refused `set` may have left a session copy.
      const copy = readSession(key);
      if (copy !== null) {
        warnSessionFallback("get", "the OS secret store holds no value for the key");
        return copy;
      }
    }
    if (raw !== undefined) return await ungated(raw, options);
    warnNativeFallback();
    const value = await withStore("readonly", (s) => s.get(key));
    return await ungated(typeof value === "string" ? value : null, options);
  },
  async set(
    key: string,
    value: string,
    options?: SecureStoreSetOptions,
  ): Promise<SecureStoreSetResult> {
    checkKey("set", key);
    if (typeof value !== "string") {
      throw new TypeError("secureStore.set: the value must be a string (JSON.stringify it)");
    }
    const data = stored(value, options);
    try {
      if (await osSet(key, data, options)) {
        clearSession(key);
        return { stored: "keychain" };
      }
    } catch (err) {
      const store = fallbackStore(options?.fallback, err, options?.requireBiometric === true);
      if (!store) throw err;
      warnSessionFallback("set", refusedBecause(err));
      store.setItem(SESSION_PREFIX + key, data);
      return { stored: "session" };
    }
    return await setWeb(key, data, options);
  },
  async delete(key: string): Promise<void> {
    checkKey("delete", key);
    clearSession(key);
    if (onDesktop() && await viaDesktop("secureStore", (d) => d.secureDelete(key), true)) return;
    const plugin = securePlugin();
    if (plugin) {
      await plugin.internalRemoveItem({ prefixedKey: NATIVE_PREFIX + key, sync: false });
      return;
    }
    await withStore("readwrite", (s) => s.delete(key));
  },
};
