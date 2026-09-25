/**
 * `expo-file-system` for denext: SDK 57's object API (`File`, `Directory`, `Paths`) over
 * `denext/mobile`'s filesystem (the app's own files through `@capacitor/filesystem` in the
 * Capacitor shell, the Origin Private File System on the web).
 *
 * Expo's API is synchronous (it runs over JSI); the Capacitor bridge and OPFS are not. So:
 *
 * - `exists`, `size`, `info()`, `list()`, `create()`, `write()`, `delete()`, `copySync()`,
 *   `moveSync()` and `rename()` act at once on an index the shim keeps (in `localStorage`,
 *   so it survives a reload), and reach the real files in order, in the background;
 * - `text()`, `bytes()`, `base64()`, `arrayBuffer()` and `json()` wait for those writes, so
 *   they always see them;
 * - `textSync()`, `bytesSync()` and `base64Sync()` answer only for files written or read in
 *   this session, and throw otherwise (use the async form).
 *
 * The index only knows files written through this shim. `Paths.document` is
 * `file:///documents/` and `Paths.cache` is `file:///cache/`; any other URI (a picker's
 * `blob:` URL, `http(s):`) can be read, not written. The legacy API
 * (`expo-file-system/legacy`), file handles, streams, watchers and upload/download tasks are
 * not provided (see the manifest).
 *
 * @example
 * ```ts
 * import { Directory, File, Paths } from "denext/expo/file-system";
 *
 * const dir = new Directory(Paths.document, "drafts");
 * dir.create({ idempotent: true, intermediates: true });
 * const file = new File(dir, "note.json");
 * file.write(JSON.stringify({ text: "hi" }));
 * const note = JSON.parse(await file.text());
 * ```
 *
 * @module
 */

import { base64ToBytes, bytesToBase64 } from "../mobile/base64.ts";
import {
  appendBytes,
  backing,
  cached,
  children,
  copy,
  isRoot,
  makeDir,
  mimeType,
  parentUri,
  readBytes,
  remove,
  stat,
  writeBytes,
} from "./internal/fs.ts";

/** How {@linkcode File.write} and the readers carry text. */
export enum EncodingType {
  /** UTF-8 text. */
  UTF8 = "utf8",
  /** Base64 binary data. */
  Base64 = "base64",
}

/** A file-handle mode (file handles are not provided; kept for API compatibility). */
export enum FileMode {
  /** Read and write. */
  ReadWrite = "rw",
  /** Read only. */
  ReadOnly = "r",
  /** Write only. */
  WriteOnly = "w",
  /** Append. */
  Append = "wa",
  /** Truncate. */
  Truncate = "wt",
}

/** An upload body kind (upload tasks are not provided; kept for API compatibility). */
export enum UploadType {
  /** The file's bytes as the body. */
  BINARY_CONTENT = 0,
  /** A multipart form. */
  MULTIPART = 1,
}

/** The watcher debounce default (watchers are not provided; kept for API compatibility). */
export const DEFAULT_DEBOUNCE_MS = 100;

/** Options for {@linkcode File.create}. */
export interface FileCreateOptions {
  /** Create missing parent folders. */
  intermediates?: boolean;
  /** Replace an existing file instead of throwing. */
  overwrite?: boolean;
}

/** Options for {@linkcode Directory.create}. */
export interface DirectoryCreateOptions {
  /** Create missing parent folders. */
  intermediates?: boolean;
  /** Replace an existing folder (emptying it) instead of throwing. */
  overwrite?: boolean;
  /** Do nothing when the folder exists. */
  idempotent?: boolean;
}

/** Options for {@linkcode File.write}. */
export interface FileWriteOptions {
  /** How a string `content` is encoded (default UTF-8). */
  encoding?: EncodingType | "utf8" | "base64";
  /** Add to the end instead of replacing. */
  append?: boolean;
}

/** Options for copy and move. */
export interface RelocationOptions {
  /** Replace an existing destination instead of throwing. */
  overwrite?: boolean;
}

/** What {@linkcode File.info} reports. */
export interface FileInfo {
  /** Whether the file exists. */
  exists: boolean;
  /** Its URI. */
  uri?: string;
  /** Its size in bytes. */
  size?: number;
  /** When it last changed, in ms since the epoch. */
  modificationTime?: number;
  /** When it was created (the last change here). */
  creationTime?: number;
}

/** What {@linkcode Directory.info} reports. */
export interface DirectoryInfo {
  /** Whether the folder exists. */
  exists: boolean;
  /** Its URI. */
  uri?: string;
  /** The total size of the files below it. */
  size?: number;
  /** When it last changed. */
  modificationTime?: number;
  /** The names of its entries. */
  files?: string[];
}

/** What {@linkcode Paths.info} reports. */
export interface PathInfo {
  /** Whether something exists at the path. */
  exists: boolean;
  /** Whether it is a folder (null when it does not exist). */
  isDirectory: boolean | null;
}

/** Options for {@linkcode File.downloadFileAsync}. */
export interface DownloadOptions {
  /** Request headers. */
  headers?: Record<string, string>;
  /** Replace an existing file instead of throwing. */
  idempotent?: boolean;
  /** Abort the download. */
  signal?: AbortSignal;
}

/** A path part: a string, or a {@linkcode File} / {@linkcode Directory}. */
type PathPart = string | File | Directory;

/** The URI a path part stands for. */
function partUri(part: PathPart): string {
  return typeof part === "string" ? part : part.uri;
}

/** Join path parts into one URI (a relative first part is taken under `Paths.document`). */
function joinUris(parts: readonly PathPart[]): string {
  const [first = "", ...rest] = parts.map(partUri);
  let uri = /^[a-z][a-z0-9+.-]*:/i.test(first) ? first : "file:///documents/" + first;
  for (const part of rest) {
    uri = uri.replace(/\/+$/, "") + "/" + part.replace(/^\/+/, "");
  }
  return uri;
}

/** The last path segment of `uri`. */
function baseName(uri: string): string {
  const trimmed = uri.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Refuse to replace `uri` unless `overwrite`. */
function checkFree(uri: string, overwrite: boolean | undefined, what: string): void {
  if (stat(uri) && !overwrite) throw new Error(`${what} ${uri} already exists`);
}

/** `content` as bytes, decoding base64 when asked. */
function toBytes(content: string | Uint8Array, encoding?: string): Uint8Array {
  if (typeof content !== "string") return content;
  return encoding === "base64" ? base64ToBytes(content) : new TextEncoder().encode(content);
}

/** The destination URI for relocating `source` into (or onto) `destination`. */
function destinationUri(source: string, destination: File | Directory, folder: boolean): string {
  if (destination instanceof Directory) {
    return destination.uri + baseName(source) + (folder ? "/" : "");
  }
  return destination.uri;
}

/** What {@linkcode File} and {@linkcode Directory} share: the URI, copy and move. */
export abstract class FileSystemEntry {
  /** The URI (a move or rename updates it). */
  uri: string;
  /** Whether this entry is a folder. */
  protected abstract readonly folder: boolean;

  /**
   * Create it.
   *
   * @param uri The entry's URI.
   */
  constructor(uri: string) {
    this.uri = uri;
  }

  /** Copy it to `destination` (a file, or a folder to copy it into). */
  copySync(destination: Directory | File, options: RelocationOptions = {}): void {
    const target = destinationUri(this.uri, destination, this.folder);
    checkFree(target, options.overwrite, this.folder ? "Folder" : "File");
    copy(this.uri, target);
  }

  /** Async form of {@linkcode FileSystemEntry.copySync}. */
  copy(destination: Directory | File, options?: RelocationOptions): Promise<void> {
    return Promise.resolve().then(() => this.copySync(destination, options));
  }

  /** Move it to `destination` (a file, or a folder to move it into). */
  moveSync(destination: Directory | File, options: RelocationOptions = {}): void {
    const target = destinationUri(this.uri, destination, this.folder);
    this.copySync(destination, options);
    remove(this.uri);
    this.uri = target;
  }

  /** Async form of {@linkcode FileSystemEntry.moveSync}. */
  move(destination: Directory | File, options?: RelocationOptions): Promise<void> {
    return Promise.resolve().then(() => this.moveSync(destination, options));
  }
}

/** A file. The instance is a path: it need not exist. */
export class File extends FileSystemEntry {
  /** A file, not a folder. */
  protected readonly folder = false;

  /**
   * Create it.
   *
   * @param uris The file's URI, or a folder plus names to join (`new File(dir, "a.json")`).
   */
  constructor(...uris: PathPart[]) {
    super(joinUris(uris).replace(/\/+$/, ""));
  }

  /** Download `url` to `destination` (a file, or a folder to put it in). */
  static async downloadFileAsync(
    url: string,
    destination: Directory | File,
    options: DownloadOptions = {},
  ): Promise<File> {
    const response = await fetch(url, { headers: options.headers, signal: options.signal });
    if (!response.ok) throw new Error(`Download of ${url} failed: HTTP ${response.status}`);
    const name = baseName(new URL(url).pathname) || "download";
    const file = destination instanceof Directory ? new File(destination, name) : destination;
    if (!options.idempotent) checkFree(file.uri, false, "File");
    writeBytes(file.uri, new Uint8Array(await response.arrayBuffer()));
    return file;
  }

  /** Whether the file exists (a non-file URI, such as a `blob:` URL, reads as existing). */
  get exists(): boolean {
    return backing(this.uri) ? stat(this.uri)?.dir === false : true;
  }

  /** Its size in bytes (0 when unknown). */
  get size(): number {
    return stat(this.uri)?.size ?? cached(this.uri)?.byteLength ?? 0;
  }

  /** Its MIME type, from the extension. */
  get type(): string {
    return mimeType(this.uri);
  }

  /** When it last changed, or null. */
  get modificationTime(): number | null {
    return stat(this.uri)?.mtime ?? null;
  }

  /** Same as {@linkcode File.modificationTime}. */
  get lastModified(): number | null {
    return this.modificationTime;
  }

  /** When it was created (the last change here), or null. */
  get creationTime(): number | null {
    return this.modificationTime;
  }

  /** The MD5 digest (not computed here: always null). */
  get md5(): string | null {
    return null;
  }

  /** The folder the file is in. */
  get parentDirectory(): Directory {
    return new Directory(parentUri(this.uri));
  }

  /** The file name. */
  get name(): string {
    return baseName(this.uri);
  }

  /** The extension, dot included (`".json"`), or `""`. */
  get extension(): string {
    return /\.[^./]+$/.exec(this.name)?.[0] ?? "";
  }

  /** Check the URI is usable (a no-op here). */
  validatePath(): void {}

  /** Create the file, empty. */
  create(options: FileCreateOptions = {}): void {
    checkFree(this.uri, options.overwrite, "File");
    if (!options.intermediates && !stat(parentUri(this.uri))?.dir) {
      throw new Error(`The parent folder of ${this.uri} does not exist`);
    }
    writeBytes(this.uri, new Uint8Array());
  }

  /** Write `content` (text, base64 text, or bytes), replacing or appending. */
  write(content: string | Uint8Array, options: FileWriteOptions = {}): void {
    const bytes = toBytes(content, options.encoding);
    if (options.append) appendBytes(this.uri, bytes);
    else writeBytes(this.uri, bytes);
  }

  /** Delete the file. */
  delete(): void {
    if (!this.exists) throw new Error(`File ${this.uri} does not exist`);
    if (backing(this.uri)) remove(this.uri);
  }

  /** Facts about the file. */
  info(): FileInfo {
    const entry = stat(this.uri);
    if (!entry || entry.dir) return { exists: false, uri: this.uri };
    return {
      exists: true,
      uri: this.uri,
      size: entry.size,
      modificationTime: entry.mtime,
      creationTime: entry.mtime,
    };
  }

  /** The contents as bytes. */
  bytes(): Promise<Uint8Array> {
    return readBytes(this.uri);
  }

  /** The contents as an `ArrayBuffer`. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.bytes()).slice().buffer as ArrayBuffer;
  }

  /** The contents as UTF-8 text. */
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  /** The contents as base64. */
  async base64(): Promise<string> {
    return bytesToBase64(await this.bytes());
  }

  /** The contents parsed as JSON. */
  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  /** The contents as bytes, from this session's cache; throws when not loaded. */
  bytesSync(): Uint8Array {
    const bytes = cached(this.uri);
    if (!bytes) {
      throw new Error(
        `${this.uri} is not loaded in this session: the sync readers need a file written or ` +
          "read here first (use the async form, e.g. text())",
      );
    }
    return bytes;
  }

  /** The contents as UTF-8 text, from this session's cache. */
  textSync(): string {
    return new TextDecoder().decode(this.bytesSync());
  }

  /** The contents as base64, from this session's cache. */
  base64Sync(): string {
    return bytesToBase64(this.bytesSync());
  }

  /** Rename the file inside its folder. */
  rename(newName: string): void {
    this.moveSync(new File(parentUri(this.uri) + newName));
  }
}

/** A folder (its URI ends with `/`). The instance is a path: it need not exist. */
export class Directory extends FileSystemEntry {
  /** A folder. */
  protected readonly folder = true;

  /**
   * Create it.
   *
   * @param uris The folder's URI, or a parent plus names to join.
   */
  constructor(...uris: PathPart[]) {
    super(joinUris(uris).replace(/\/*$/, "/"));
  }

  /** Whether the folder exists. */
  get exists(): boolean {
    return stat(this.uri)?.dir === true;
  }

  /** The total size of the files below it. */
  get size(): number | null {
    return this.list().reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  }

  /** The folder containing this one. */
  get parentDirectory(): Directory {
    return new Directory(parentUri(this.uri));
  }

  /** The folder name. */
  get name(): string {
    return baseName(this.uri);
  }

  /** Check the URI is usable (a no-op here). */
  validatePath(): void {}

  /** Create the folder. */
  create(options: DirectoryCreateOptions = {}): void {
    if (this.exists) {
      if (options.idempotent) return;
      if (!options.overwrite) throw new Error(`Folder ${this.uri} already exists`);
      remove(this.uri);
    }
    if (!isRoot(this.uri)) makeDir(this.uri, options.intermediates === true);
  }

  /** Delete the folder and everything in it. */
  delete(): void {
    if (!this.exists) throw new Error(`Folder ${this.uri} does not exist`);
    remove(this.uri);
  }

  /** The files and folders directly inside it. */
  list(): (Directory | File)[] {
    return children(this.uri).map((uri) => stat(uri)?.dir ? new Directory(uri) : new File(uri));
  }

  /** {@linkcode Directory.list} as plain records. */
  listAsRecords(): { isDirectory: boolean; uri: string }[] {
    return children(this.uri).map((uri) => ({ isDirectory: stat(uri)?.dir === true, uri }));
  }

  /** Facts about the folder. */
  info(): DirectoryInfo {
    if (!this.exists) return { exists: false, uri: this.uri };
    return {
      exists: true,
      uri: this.uri,
      size: this.size ?? 0,
      modificationTime: stat(this.uri)?.mtime,
      files: this.list().map((entry) => entry.name),
    };
  }

  /** Create an empty file named `name` inside it. */
  createFile(name: string, _mimeType: string | null): File {
    const file = new File(this, name);
    file.create();
    return file;
  }

  /** Create a folder named `name` inside it. */
  createDirectory(name: string): Directory {
    const dir = new Directory(this, name);
    dir.create();
    return dir;
  }

  /** Rename the folder inside its parent. */
  rename(newName: string): void {
    const target = parentUri(this.uri) + newName.replace(/\/*$/, "/");
    checkFree(target, false, "Folder");
    copy(this.uri, target);
    remove(this.uri);
    this.uri = target;
  }
}

/** The app's standard folders, and path helpers. */
export class Paths {
  /** The cache folder (`file:///cache/`); the OS may clear it. */
  static get cache(): Directory {
    return new Directory("file:///cache/");
  }

  /** The documents folder (`file:///documents/`). */
  static get document(): Directory {
    return new Directory("file:///documents/");
  }

  /** The app bundle (the page's own origin; read-only). */
  static get bundle(): Directory {
    const href = (globalThis as { location?: { href?: string } }).location?.href;
    return new Directory(href ? new URL("./", href).href : "file:///bundle/");
  }

  /** iOS app-group containers: none here. */
  static get appleSharedContainers(): Record<string, Directory> {
    return {};
  }

  /** The disk size (not known synchronously here: 0). */
  static get totalDiskSpace(): number {
    return 0;
  }

  /** The free disk space (not known synchronously here: 0). */
  static get availableDiskSpace(): number {
    return 0;
  }

  /** Whether each path exists, and whether it is a folder (answers for the first path). */
  static info(...uris: string[]): PathInfo {
    const entry = stat(joinUris(uris)) ?? stat(joinUris(uris).replace(/\/*$/, "/"));
    return { exists: entry !== undefined, isDirectory: entry ? entry.dir : null };
  }

  /** Join path parts into one path. */
  static join(...paths: PathPart[]): string {
    return joinUris(paths);
  }

  /** The folder part of `path`. */
  static dirname(path: PathPart): string {
    return parentUri(partUri(path)).replace(/\/$/, "");
  }

  /** The last segment of `path`, without `ext` when it ends with it. */
  static basename(path: PathPart, ext?: string): string {
    const base = baseName(partUri(path));
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  }

  /** The extension of `path`, dot included. */
  static extname(path: PathPart): string {
    return /\.[^./]+$/.exec(baseName(partUri(path)))?.[0] ?? "";
  }

  /** Whether `path` is an absolute URI or path. */
  static isAbsolute(path: PathPart): boolean {
    return /^([a-z][a-z0-9+.-]*:|\/)/i.test(partUri(path));
  }
}
