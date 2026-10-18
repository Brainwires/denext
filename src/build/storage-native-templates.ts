// The native half of `openKeyValueStore()` (denext/mobile) and React Native mode's AsyncStorage
// and MMKV stand-ins, embedded as text so it ships inside the JSR package: `denext mobile add
// storage` writes it into a Capacitor project.
//
// One SQLite database in the app's own data folder, which the OS never evicts (unlike the
// WebView's localStorage / IndexedDB, which iOS and Android may clear under storage pressure):
// table `kv (store, key, value)`, keyed by (store, key). Every call is one batch.
//
// - iOS: `ios/App/App/DenextStoragePlugin.swift` (registered by `DenextBridgeViewController`)
//   over `DenextStorageStore.swift`. The file is `Library/Application Support/denext/kv.sqlite`,
//   opened with the system SQLite (no dependency), WAL, on one serial queue.
// - Android: `dev/denext/storage/DenextStoragePlugin.java`, registered from `MainActivity`. The
//   file is the app's `databases/denext-kv.db` (SQLiteOpenHelper, WAL), on one worker thread.
//
// An encrypted store (`openKeyValueStore(name, { encrypted: true })`: every call carries the
// store's `key`, which the page keeps in secureStore) is its own SQLCipher database:
// `kv-<store as hex>.cipher.sqlite` on iOS, `denext-kv-<store as hex>.cipher.db` on Android.
// `denext mobile add storage --encrypted` links SQLCipher: the SQLCipher Swift package into the
// Xcode app target, and on Android `net.zetetic:sqlcipher-android` plus
// `DenextStorageCipher.java`, which the plugin reaches by name. A build without SQLCipher (the
// system SQLite answers no `PRAGMA cipher_version`; no DenextStorageCipher class) refuses a key
// with `ENCRYPTION_UNAVAILABLE` and writes nothing; a key that does not open the store is
// `WRONG_KEY`. The first encrypted open of a store moves its rows out of the plain database
// (deleted with `secure_delete`, the WAL truncated).
//
// The JS contract (src/mobile/kv-store.ts): `getMany({ store, keys, key? })` → `{ values }` (a
// string or null per key, in order), `setMany({ store, entries: [[key, value], …], key? })`,
// `removeMany({ store, keys, key? })`, `keys({ store, key? })` → `{ keys }`,
// `clear({ store, key? })`, and `cipher()` → `{ available }`. A write batch is one transaction.
// A failure rejects with code `STORAGE_ERROR` (or the two above).
//
// Edit these as source in native-templates/storage.ts:
// they are compiled only in an app (against Capacitor 8). Every `\``
// there is an escaped template-literal character.
//
// Every file is written through `renderStorageTemplate`, which puts a marker line on top: the
// template generation and the SHA-256 of the rest of the file. A file whose marker still
// matches its body is an unedited denext template and is upgraded in place by a later run; an
// edited one is kept. Bump STORAGE_TEMPLATE_VERSION when the templates change.
//
// The template texts ship packed: native-templates/storage.ts (the readable source, not published)
// is packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/** The generation of the templates, stamped into every file the installer writes. */
export const STORAGE_TEMPLATE_VERSION = 2;

/**
 * A template as the installer writes it: a first line
 * `// denext-storage-template: <STORAGE_TEMPLATE_VERSION> sha256=<hex>` (the SHA-256 of
 * everything after that line), then the template.
 *
 * @param template The template text.
 * @returns The file content.
 */
export function renderStorageTemplate(template: string): Promise<string> {
  return renderMarkedTemplate("storage", STORAGE_TEMPLATE_VERSION, template);
}

/**
 * Whether `text` is an unedited storage template: its marker line matches its body.
 *
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineStorageTemplate(text: string): Promise<boolean> {
  return await markedTemplateIntact("storage", text) === true;
}

/** The iOS files, for `ios/App/App/`. */
export const STORAGE_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.storage.STORAGE_IOS_FILES;

/** The Android files, for `android/app/src/main/java/dev/denext/storage/`. */
export const STORAGE_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.storage.STORAGE_ANDROID_FILES;

/**
 * The Android file `--encrypted` adds beside them: `DenextStorageCipher.java`, the encrypted
 * stores' databases through SQLCipher for Android.
 */
export const STORAGE_CIPHER_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.storage.STORAGE_CIPHER_ANDROID_FILES;

/**
 * SQLCipher for Android, as `android/app/build.gradle` lists it (`--encrypted`), with the
 * `androidx.sqlite` interfaces its classes extend: its POM declares that one at runtime scope only,
 * so `DenextStorageCipher.java` would not compile without it.
 */
export const SQLCIPHER_ANDROID_DEPENDENCIES: readonly string[] = [
  "implementation 'net.zetetic:sqlcipher-android:4.19.1'",
  "implementation 'androidx.sqlite:sqlite:2.6.2'",
];

/** The SQLCipher Swift package `--encrypted` links into the Xcode app target. */
export const SQLCIPHER_SWIFT_PACKAGE = {
  url: "https://github.com/sqlcipher/SQLCipher.swift.git",
  minimumVersion: "4.14.0",
  product: "SQLCipher",
} as const;
