/**
 * App-private files for `denext/mobile`: the native `Filesystem` plugin in the shell, the app's
 * folder in the OS app-support directory in a Deno Desktop window (`denext desktop add fs`),
 * else the Origin Private File System (OPFS) in the browser.
 *
 * On the web a {@linkcode FileDirectory} is a top-level OPFS folder of the same name, so
 * `writeFile("notes.txt", …, { directory: "data" })` is OPFS `data/notes.txt`, the file the
 * `useFile("data/notes.txt")` hook from `denext` reads.
 *
 * A file or folder the user picked (`pickFolder`, `pickDocument`, `saveFile`) is reached with
 * `{ directory: { picked: handle } }`: see {@linkcode PickedDirectory}.
 *
 * @module
 */

import { opfsSupported, resolveDir, resolveFile, splitPath } from "../utils/opfs-paths.ts";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { isNativeShell } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";
import { capabilityError, type DesktopNative, onDesktop, viaDesktop } from "./desktop-branch.ts";
import { WEB_HANDLE_PREFIX, webHandle, webHandleWritable } from "./picked-web.ts";

/**
 * An opaque handle to a file or folder the user picked in a dialog (`pickFolder`,
 * `pickDocument`, `saveFile`). It is the only authority the filesystem and shell functions
 * accept for a location outside the app's own folders: a result's `path` is for display only
 * and is never accepted back. A handle lasts for the session (a Deno Desktop launch, or the
 * page's lifetime in a browser); an unknown or expired one rejects with code `"forbidden"`.
 */
export type PickedHandle = string;

/**
 * A picked file or folder as a {@linkcode FileDirectory}: `{ picked: handle }`. For a picked
 * folder the path is relative to it (`""` for the folder itself); for a picked file the path is
 * `""`. Supported in a Deno Desktop window (the `fs` capability) and in browsers with the File
 * System Access API; inside the iOS/Android shell it rejects with code `"unavailable"`.
 */
export interface PickedDirectory {
  /** The handle a dialog returned. */
  readonly picked: PickedHandle;
}

/**
 * The app's own folders:
 *
 * - `"data"` (the default): the app's own storage, kept until the app is removed (Android's
 *   internal files folder; on iOS the plugin maps it to the app's Documents folder).
 * - `"documents"`: the app's Documents folder on iOS; on Android the shared, user-visible
 *   Documents folder, which needs storage permission on Android 10 and older.
 * - `"cache"`: storage the OS may clear when space runs low.
 */
export type AppFileDirectory = "documents" | "data" | "cache";

/**
 * Where a file lives: one of the app's own folders ({@linkcode AppFileDirectory}), or a file or
 * folder the user picked ({@linkcode PickedDirectory}).
 */
export type FileDirectory = AppFileDirectory | PickedDirectory;

/** How text is carried: `"utf8"` (plain text, the default) or `"base64"` (binary data). */
export type FileEncoding = "utf8" | "base64";

/** Options for {@linkcode readFile}. */
export interface ReadFileOptions {
  /** The folder the path is relative to. Default `"data"`. */
  readonly directory?: FileDirectory;
  /** Return the contents as text (`"utf8"`, the default) or as base64 (`"base64"`). */
  readonly encoding?: FileEncoding;
}

/** Options for {@linkcode writeFile}. */
export interface WriteFileOptions {
  /** The folder the path is relative to. Default `"data"`. */
  readonly directory?: FileDirectory;
  /** Create missing parent folders. Default `false` (a missing folder rejects). */
  readonly recursive?: boolean;
  /** How `data` is given: text (`"utf8"`, the default) or base64 (`"base64"`). */
  readonly encoding?: FileEncoding;
}

/** Options for {@linkcode deleteFile}, {@linkcode listDir} and {@linkcode downloadToFile}. */
export interface FileLocationOptions {
  /** The folder the path is relative to. Default `"data"`. */
  readonly directory?: FileDirectory;
}

/** One entry of a {@linkcode listDir} listing. */
export interface FileEntry {
  /** The entry's name within its folder. */
  readonly name: string;
  /** Whether it is a file or a folder. */
  readonly type: "file" | "directory";
  /** Its size in bytes (0 for a folder). */
  readonly size: number;
  /** When it last changed, in ms since the epoch, where the platform reports it. */
  readonly mtime?: number;
}

/** The JS side of `@capacitor/filesystem` (the calls these functions use). */
interface FilesystemPlugin {
  readFile(options: { path: string; directory: string; encoding?: string }): Promise<{
    data?: unknown;
  }>;
  writeFile(options: {
    path: string;
    data: string;
    directory: string;
    recursive: boolean;
    encoding?: string;
  }): Promise<unknown>;
  deleteFile(options: { path: string; directory: string }): Promise<unknown>;
  readdir(options: { path: string; directory: string }): Promise<{
    files?: Array<{ name?: string; type?: string; size?: number; mtime?: number }>;
  }>;
  downloadFile(options: {
    url: string;
    path: string;
    directory: string;
    recursive: boolean;
  }): Promise<{ path?: string }>;
}

/** {@linkcode AppFileDirectory} → the plugin's `Directory` enum value. */
const NATIVE_DIRECTORY: Record<AppFileDirectory, string> = {
  documents: "DOCUMENTS",
  data: "DATA",
  cache: "CACHE",
};

/** The native plugin, when the shell has it with `method`. */
function filesystemPlugin(method: keyof FilesystemPlugin): FilesystemPlugin | undefined {
  return nativePlugin<FilesystemPlugin>("Filesystem", [method]);
}

/** Whether `directory` is a picked handle. */
function isPicked(directory: FileDirectory): directory is PickedDirectory {
  return typeof directory === "object";
}

/** The native plugin with the plugin's name for `directory`; none for a picked handle. */
function nativeFs(
  method: keyof FilesystemPlugin,
  directory: FileDirectory,
): { plugin: FilesystemPlugin; directory: string } | undefined {
  if (isPicked(directory)) return undefined;
  const plugin = filesystemPlugin(method);
  return plugin ? { plugin, directory: NATIVE_DIRECTORY[directory] } : undefined;
}

/** The directory option, checked (a picked handle is copied, so only `picked` travels). */
function directoryOf(fn: string, directory: FileDirectory | undefined): FileDirectory {
  const dir = directory ?? "data";
  if (typeof dir === "object" && dir !== null) {
    const picked = (dir as { picked?: unknown }).picked;
    if (typeof picked !== "string" || picked === "") {
      throw new TypeError(`${fn}: a picked directory needs a non-empty handle string`);
    }
    return { picked };
  }
  if (typeof dir !== "string" || !Object.hasOwn(NATIVE_DIRECTORY, dir)) {
    throw new TypeError(
      `${fn}: unknown directory "${String(dir)}" (documents, data, cache or { picked })`,
    );
  }
  return dir;
}

/**
 * The desktop call for `directory`, when the page is in a Deno Desktop window. A picked handle
 * from this page's browser pickers never travels to the runtime; a runtime-issued one has no
 * web path, so without the `fs` capability it rejects `unavailable` instead of falling back.
 */
async function viaDesktopFs<T>(
  fn: string,
  directory: FileDirectory,
  call: (desktop: DesktopNative) => Promise<T>,
): Promise<{ value: T } | undefined> {
  if (!isPicked(directory)) return await viaDesktop("fs", call, true);
  if (directory.picked.startsWith(WEB_HANDLE_PREFIX)) return undefined;
  const out = await viaDesktop("fs", call);
  if (!out) {
    throw capabilityError(fn, "unavailable", "picked files need `denext desktop add fs`");
  }
  return out;
}

/**
 * The browser handle behind a picked directory: this page's File System Access handle.
 * Inside the native shell a (runtime) handle is `unavailable`; any other unknown handle is
 * `forbidden`. With `write`, the browser is asked for write access first.
 */
async function pickedWebHandle(
  fn: string,
  directory: PickedDirectory,
  write: boolean,
): Promise<FileSystemHandle> {
  const handle = webHandle(directory.picked);
  if (!handle) {
    if (isNativeShell()) {
      throw capabilityError(fn, "unavailable", "picked files are not supported in the shell");
    }
    throw capabilityError(fn, "forbidden", "unknown or expired picked handle");
  }
  if (write && !(await webHandleWritable(handle))) {
    throw capabilityError(fn, "forbidden", "write access to the picked item was not granted");
  }
  return handle;
}

/** The encoding option, checked. */
function encodingOf(fn: string, encoding: FileEncoding | undefined): FileEncoding {
  const enc = encoding ?? "utf8";
  if (enc !== "utf8" && enc !== "base64") {
    throw new TypeError(`${fn}: unknown encoding "${enc}" (utf8 or base64)`);
  }
  return enc;
}

/** The path, checked: relative and without `..` (it must stay inside its directory). */
function pathOf(fn: string, path: string): string {
  const parts = splitPath(String(path));
  if (parts.includes("..") || parts.includes(".") || String(path).startsWith("/")) {
    throw new TypeError(`${fn}: "${path}" must be a relative path without "." or ".." segments`);
  }
  return parts.join("/");
}

/**
 * The browser folder a {@linkcode FileDirectory} maps to: the OPFS folder of that name, or a
 * picked folder. It rejects when there is no OPFS, and for a picked file.
 */
async function webDirectory(
  fn: string,
  directory: FileDirectory,
  create: boolean,
  write: boolean,
): Promise<FileSystemDirectoryHandle> {
  if (isPicked(directory)) {
    const handle = await pickedWebHandle(fn, directory, write);
    if (handle.kind !== "directory") {
      throw new TypeError(`${fn}: the picked handle is a file, not a folder`);
    }
    return handle as FileSystemDirectoryHandle;
  }
  if (!opfsSupported()) {
    throw new Error(`${fn}: no filesystem here (OPFS needs a secure context; none during SSR)`);
  }
  return await resolveDir(await navigator.storage.getDirectory(), directory, create);
}

/** A browser file resolved for an operation, with the way to delete it. */
interface WebFile {
  readonly handle: FileSystemFileHandle;
  remove(): Promise<void>;
}

/** Delete a picked file through its own handle (`FileSystemHandle.remove`, Chromium). */
async function removeFileHandle(fn: string, handle: FileSystemFileHandle): Promise<void> {
  const remove = (handle as { remove?: () => Promise<void> }).remove;
  if (typeof remove !== "function") {
    throw capabilityError(fn, "unavailable", "this browser cannot delete a picked file");
  }
  await remove.call(handle);
}

/**
 * The browser file at `rel` under `directory` (OPFS or a picked folder), or the picked file
 * itself (whose path must be `""`). `create` creates the file (and the top OPFS folder);
 * `write` asks for write access to a picked item; `createDirs` creates the folders on the way.
 */
async function webFile(
  fn: string,
  directory: FileDirectory,
  rel: string,
  create: boolean,
  write: boolean = create,
  createDirs: boolean = create,
): Promise<WebFile> {
  let root: FileSystemDirectoryHandle;
  if (isPicked(directory)) {
    const handle = await pickedWebHandle(fn, directory, write);
    if (handle.kind === "file") {
      if (rel !== "") throw new TypeError(`${fn}: a picked file takes the path "" (got "${rel}")`);
      const file = handle as FileSystemFileHandle;
      return { handle: file, remove: () => removeFileHandle(fn, file) };
    }
    root = handle as FileSystemDirectoryHandle;
  } else {
    root = await webDirectory(fn, directory, create, write);
  }
  const { handle, parent, name } = await resolveFile(root, rel, create, createDirs);
  return { handle, remove: () => parent.removeEntry(name) };
}

/**
 * Read a file.
 *
 * - Inside the native shell with `@capacitor/filesystem` installed (`denext mobile add
 *   filesystem`), the app's own files on the device.
 * - Otherwise the browser's Origin Private File System, where `directory` is a top-level
 *   folder of that name.
 *
 * @param path The file's path inside `directory` (`"notes/today.md"`); no `..` segments.
 * @param options `directory` (default `"data"`) and `encoding`: `"utf8"` (the default) for
 * text, `"base64"` for binary data.
 * @returns The contents, as text or base64. It rejects when the file does not exist.
 * @example
 * ```ts
 * import { readFile } from "denext/mobile";
 *
 * const draft = await readFile("drafts/post.md").catch(() => "");
 * const avatar = await readFile("avatar.png", { encoding: "base64" });
 * ```
 */
export async function readFile(path: string, options: ReadFileOptions = {}): Promise<string> {
  const rel = pathOf("readFile", path);
  const directory = directoryOf("readFile", options.directory);
  const encoding = encodingOf("readFile", options.encoding);
  const desktop = onDesktop() &&
    await viaDesktopFs("readFile", directory, (d) => d.fsReadFile(rel, directory, encoding));
  if (desktop) return desktop.value;
  const native = nativeFs("readFile", directory);
  if (native) {
    const { data } = await native.plugin.readFile({
      path: rel,
      directory: native.directory,
      // No encoding asks the plugin for base64.
      ...(encoding === "utf8" ? { encoding: "utf8" } : {}),
    });
    return typeof data === "string" ? data : "";
  }
  const file = await (await webFile("readFile", directory, rel, false)).handle.getFile();
  return encoding === "utf8"
    ? await file.text()
    : bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/** Write `bytes` (or text) to a browser file under `directory` (OPFS or picked), replacing it. */
async function writeWeb(
  fn: string,
  directory: FileDirectory,
  rel: string,
  contents: string | Uint8Array<ArrayBuffer>,
  recursive: boolean,
): Promise<void> {
  const { handle } = await webFile(fn, directory, rel, true, true, recursive);
  const writable = await handle.createWritable();
  try {
    await writable.write(contents);
  } finally {
    await writable.close();
  }
}

/**
 * Write a file, replacing it when it exists.
 *
 * - Inside the native shell with `@capacitor/filesystem` installed (`denext mobile add
 *   filesystem`), the app's own files on the device.
 * - Otherwise the browser's Origin Private File System, where `directory` is a top-level
 *   folder of that name.
 *
 * @param path The file's path inside `directory`; no `..` segments.
 * @param data The contents: text, or base64 with `encoding: "base64"`.
 * @param options `directory` (default `"data"`), `recursive` (create missing parent folders;
 * default `false`) and `encoding` (`"utf8"`, the default, or `"base64"`).
 * @returns A promise that settles once the file is written. It rejects when a parent folder is
 * missing without `recursive`, or when there is no filesystem (SSR, an insecure context).
 * @example
 * ```ts
 * import { writeFile } from "denext/mobile";
 *
 * await writeFile("drafts/post.md", markdown, { recursive: true });
 * await writeFile("avatar.png", pngBase64, { encoding: "base64" });
 * ```
 */
export async function writeFile(
  path: string,
  data: string,
  options: WriteFileOptions = {},
): Promise<void> {
  const rel = pathOf("writeFile", path);
  const directory = directoryOf("writeFile", options.directory);
  const encoding = encodingOf("writeFile", options.encoding);
  const recursive = options.recursive === true;
  const write = (d: DesktopNative) => d.fsWriteFile(rel, data, directory, encoding, recursive);
  if (onDesktop() && await viaDesktopFs("writeFile", directory, write)) return;
  const native = nativeFs("writeFile", directory);
  if (native) {
    await native.plugin.writeFile({
      path: rel,
      data,
      directory: native.directory,
      recursive,
      // No encoding tells the plugin `data` is base64.
      ...(encoding === "utf8" ? { encoding: "utf8" } : {}),
    });
    return;
  }
  const contents = encoding === "utf8" ? data : base64ToBytes(data);
  await writeWeb("writeFile", directory, rel, contents, recursive);
}

/**
 * Delete a file.
 *
 * - Inside the native shell with `@capacitor/filesystem` installed (`denext mobile add
 *   filesystem`), the app's own files on the device.
 * - Otherwise the browser's Origin Private File System.
 *
 * @param path The file's path inside `directory`; no `..` segments.
 * @param options `directory` (default `"data"`).
 * @returns A promise that settles once the file is gone. It rejects when it does not exist.
 * @example
 * ```ts
 * import { deleteFile } from "denext/mobile";
 *
 * await deleteFile("drafts/post.md");
 * ```
 */
export async function deleteFile(path: string, options: FileLocationOptions = {}): Promise<void> {
  const rel = pathOf("deleteFile", path);
  const directory = directoryOf("deleteFile", options.directory);
  const remove = (d: DesktopNative) => d.fsDeleteFile(rel, directory);
  if (onDesktop() && await viaDesktopFs("deleteFile", directory, remove)) return;
  const native = nativeFs("deleteFile", directory);
  if (native) {
    await native.plugin.deleteFile({ path: rel, directory: native.directory });
    return;
  }
  await (await webFile("deleteFile", directory, rel, false, true)).remove();
}

/** A native `FileInfo` as a {@linkcode FileEntry}. */
function fromNativeEntry(
  info: { name?: string; type?: string; size?: number; mtime?: number },
): FileEntry {
  const entry: FileEntry = {
    name: String(info.name ?? ""),
    type: info.type === "directory" ? "directory" : "file",
    size: typeof info.size === "number" ? info.size : 0,
  };
  return typeof info.mtime === "number" ? { ...entry, mtime: info.mtime } : entry;
}

/** An OPFS directory's entries as {@linkcode FileEntry} values. */
async function opfsEntries(dir: FileSystemDirectoryHandle): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "directory") {
      out.push({ name, type: "directory", size: 0 });
    } else {
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({ name, type: "file", size: file.size, mtime: file.lastModified });
    }
  }
  return out;
}

/**
 * List a folder's entries.
 *
 * - Inside the native shell with `@capacitor/filesystem` installed (`denext mobile add
 *   filesystem`), the app's own files on the device.
 * - Otherwise the browser's Origin Private File System.
 *
 * @param path The folder's path inside `directory` (`""` for the directory itself).
 * @param options `directory` (default `"data"`).
 * @returns Its immediate entries, sorted by name. It rejects when the folder does not exist.
 * @example
 * ```ts
 * import { listDir } from "denext/mobile";
 *
 * const drafts = (await listDir("drafts")).filter((e) => e.type === "file");
 * ```
 */
export async function listDir(
  path: string,
  options: FileLocationOptions = {},
): Promise<FileEntry[]> {
  const rel = pathOf("listDir", path);
  const directory = directoryOf("listDir", options.directory);
  const desktop = onDesktop() &&
    await viaDesktopFs("listDir", directory, (d) => d.fsListDir(rel, directory));
  const native = desktop ? undefined : nativeFs("readdir", directory);
  const entries = desktop
    ? desktop.value
    : native
    ? ((await native.plugin.readdir({ path: rel, directory: native.directory })).files ?? [])
      .map(fromNativeEntry)
    : await opfsEntries(
      await resolveDir(await webDirectory("listDir", directory, false, false), rel, false),
    );
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Download a URL straight into a file (missing parent folders are created).
 *
 * - Inside the native shell with `@capacitor/filesystem` installed (`denext mobile add
 *   filesystem`), the plugin's native download (`downloadFile`), which does not pass the body
 *   through the WebView and is not subject to CORS. (A plugin without `downloadFile`, which
 *   it deprecates, gets `fetch(url)` and the plugin's `writeFile` instead.)
 * - In a Deno Desktop window with the `fs` capability (`denext desktop add fs`), the runtime
 *   fetches in the Deno process and writes under the app's folder.
 * - Otherwise `fetch(url)` (CORS applies), then a write to the Origin Private File System.
 *
 * @param url The `http(s)` URL to fetch.
 * @param path The file's path inside `directory`; no `..` segments.
 * @param options `directory` (default `"data"`).
 * @returns `{ path }`: the native file path in the shell, the absolute path on desktop, the OPFS
 * path (`data/…`) on the web.
 * It rejects on a non-2xx response or a network error.
 * @example
 * ```ts
 * import { downloadToFile } from "denext/mobile";
 *
 * await downloadToFile("https://example.com/manual.pdf", "manuals/manual.pdf", {
 *   directory: "documents",
 * });
 * ```
 */
export async function downloadToFile(
  url: string,
  path: string,
  options: FileLocationOptions = {},
): Promise<{ path: string }> {
  const rel = pathOf("downloadToFile", path);
  const directory = directoryOf("downloadToFile", options.directory);
  if (!/^https?:\/\//i.test(String(url))) {
    throw new TypeError(`downloadToFile: "${url}" is not an http(s) URL`);
  }
  const desktop = onDesktop() &&
    await viaDesktopFs("downloadToFile", directory, (d) => d.fsDownload(url, rel, directory));
  if (desktop) return desktop.value;
  const native = nativeFs("downloadFile", directory);
  if (native) {
    const done = await native.plugin.downloadFile({
      url,
      path: rel,
      directory: native.directory,
      recursive: true,
    });
    return { path: typeof done?.path === "string" ? done.path : rel };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloadToFile: ${url} answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A plugin without its (deprecated) downloadFile still gets the file in native storage.
  const writer = nativeFs("writeFile", directory);
  if (writer) {
    const data = bytesToBase64(bytes);
    const done = await writer.plugin.writeFile({
      path: rel,
      data,
      directory: writer.directory,
      recursive: true,
    }) as { uri?: unknown } | undefined;
    return { path: typeof done?.uri === "string" ? done.uri : rel };
  }
  await writeWeb("downloadToFile", directory, rel, bytes, true);
  return { path: isPicked(directory) ? rel : `${directory}/${rel}` };
}
