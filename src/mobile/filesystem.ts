/**
 * App-private files for `denext/mobile`: the native `Filesystem` plugin in the shell, else the
 * Origin Private File System (OPFS) in the browser.
 *
 * On the web a {@linkcode FileDirectory} is a top-level OPFS folder of the same name, so
 * `writeFile("notes.txt", …, { directory: "data" })` is OPFS `data/notes.txt`, the file the
 * `useFile("data/notes.txt")` hook from `denext` reads.
 *
 * @module
 */

import { opfsSupported, resolveDir, resolveFile, splitPath } from "../utils/opfs-paths.ts";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { nativePlugin } from "./plugin.ts";

/**
 * Where a file lives:
 *
 * - `"data"` (the default): the app's own storage, kept until the app is removed (Android's
 *   internal files folder; on iOS the plugin maps it to the app's Documents folder).
 * - `"documents"`: the app's Documents folder on iOS; on Android the shared, user-visible
 *   Documents folder, which needs storage permission on Android 10 and older.
 * - `"cache"`: storage the OS may clear when space runs low.
 */
export type FileDirectory = "documents" | "data" | "cache";

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

/** {@linkcode FileDirectory} → the plugin's `Directory` enum value. */
const NATIVE_DIRECTORY: Record<FileDirectory, string> = {
  documents: "DOCUMENTS",
  data: "DATA",
  cache: "CACHE",
};

/** The native plugin, when the shell has it with `method`. */
function filesystemPlugin(method: keyof FilesystemPlugin): FilesystemPlugin | undefined {
  return nativePlugin<FilesystemPlugin>("Filesystem", [method]);
}

/** The directory option, checked. */
function directoryOf(fn: string, directory: FileDirectory | undefined): FileDirectory {
  const dir = directory ?? "data";
  if (!Object.hasOwn(NATIVE_DIRECTORY, dir)) {
    throw new TypeError(`${fn}: unknown directory "${dir}" (documents, data or cache)`);
  }
  return dir;
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

/** The OPFS folder a {@linkcode FileDirectory} maps to, or a rejection when there is no OPFS. */
async function opfsDirectory(fn: string, directory: FileDirectory, create: boolean) {
  if (!opfsSupported()) {
    throw new Error(`${fn}: no filesystem here (OPFS needs a secure context; none during SSR)`);
  }
  return await resolveDir(await navigator.storage.getDirectory(), directory, create);
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
  const plugin = filesystemPlugin("readFile");
  if (plugin) {
    const { data } = await plugin.readFile({
      path: rel,
      directory: NATIVE_DIRECTORY[directory],
      // No encoding asks the plugin for base64.
      ...(encoding === "utf8" ? { encoding: "utf8" } : {}),
    });
    return typeof data === "string" ? data : "";
  }
  const dir = await opfsDirectory("readFile", directory, false);
  const file = await (await resolveFile(dir, rel, false)).handle.getFile();
  return encoding === "utf8"
    ? await file.text()
    : bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/** Write `bytes` (or text) to a file under OPFS `directory`, replacing it. */
async function writeOpfs(
  fn: string,
  directory: FileDirectory,
  rel: string,
  contents: string | Uint8Array<ArrayBuffer>,
  recursive: boolean,
): Promise<void> {
  const dir = await opfsDirectory(fn, directory, true);
  const { handle } = await resolveFile(dir, rel, true, recursive);
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
  const plugin = filesystemPlugin("writeFile");
  if (plugin) {
    await plugin.writeFile({
      path: rel,
      data,
      directory: NATIVE_DIRECTORY[directory],
      recursive,
      // No encoding tells the plugin `data` is base64.
      ...(encoding === "utf8" ? { encoding: "utf8" } : {}),
    });
    return;
  }
  const contents = encoding === "utf8" ? data : base64ToBytes(data);
  await writeOpfs("writeFile", directory, rel, contents, recursive);
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
  const plugin = filesystemPlugin("deleteFile");
  if (plugin) {
    await plugin.deleteFile({ path: rel, directory: NATIVE_DIRECTORY[directory] });
    return;
  }
  const dir = await opfsDirectory("deleteFile", directory, false);
  const { parent, name } = await resolveFile(dir, rel, false);
  await parent.removeEntry(name);
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
  const plugin = filesystemPlugin("readdir");
  const entries = plugin
    ? ((await plugin.readdir({ path: rel, directory: NATIVE_DIRECTORY[directory] })).files ?? [])
      .map(fromNativeEntry)
    : await opfsEntries(
      await resolveDir(await opfsDirectory("listDir", directory, false), rel, false),
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
 * - Otherwise `fetch(url)` (CORS applies), then a write to the Origin Private File System.
 *
 * @param url The `http(s)` URL to fetch.
 * @param path The file's path inside `directory`; no `..` segments.
 * @param options `directory` (default `"data"`).
 * @returns `{ path }`: the native file path in the shell, the OPFS path (`data/…`) on the web.
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
  const plugin = filesystemPlugin("downloadFile");
  if (plugin) {
    const done = await plugin.downloadFile({
      url,
      path: rel,
      directory: NATIVE_DIRECTORY[directory],
      recursive: true,
    });
    return { path: typeof done?.path === "string" ? done.path : rel };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloadToFile: ${url} answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A plugin without its (deprecated) downloadFile still gets the file in native storage.
  const writer = filesystemPlugin("writeFile");
  if (writer) {
    const data = bytesToBase64(bytes);
    const done = await writer.writeFile({
      path: rel,
      data,
      directory: NATIVE_DIRECTORY[directory],
      recursive: true,
    }) as { uri?: unknown } | undefined;
    return { path: typeof done?.uri === "string" ? done.uri : rel };
  }
  await writeOpfs("downloadToFile", directory, rel, bytes, true);
  return { path: `${directory}/${rel}` };
}
