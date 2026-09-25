/**
 * `expo-file-system/legacy` for denext: the promise-based API Expo apps used before SDK 54
 * (`readAsStringAsync`, `writeAsStringAsync`, `getInfoAsync`, …), over the same files as
 * `denext/expo/file-system`'s object API — the app's own files through
 * `@capacitor/filesystem` in the Capacitor shell, the Origin Private File System on the web.
 * A file written through one API is read by the other.
 *
 * `documentDirectory` is `file:///documents/` and `cacheDirectory` is `file:///cache/`; only
 * URIs under them can be written. Any other URI (a picker's `blob:` URL, `http(s):`) can be
 * read and copied from. Every call resolves once its change has reached the real files.
 *
 * Differences from Expo: `getInfoAsync` never reports `md5` (WebCrypto has no MD5), missing
 * parent folders are created on write, and the disk-space calls report the origin's storage
 * quota (`navigator.storage.estimate()`). Resumable downloads, uploads, the Storage Access
 * Framework and content URIs are Android/native features: those exports are stand-ins that
 * throw (or reject) with an error naming denext.
 *
 * @example
 * ```ts
 * import * as FileSystem from "denext/expo/file-system/legacy";
 *
 * const uri = FileSystem.documentDirectory + "notes/today.md";
 * await FileSystem.makeDirectoryAsync(FileSystem.documentDirectory + "notes", {
 *   intermediates: true,
 * });
 * await FileSystem.writeAsStringAsync(uri, "# Today");
 * const text = await FileSystem.readAsStringAsync(uri);
 * ```
 *
 * @module
 */

import { bytesToBase64 } from "../mobile/base64.ts";
import { EncodingType } from "./file-system.ts";
import {
  appendBytes,
  backing,
  baseName,
  children,
  copy,
  type IndexEntry,
  isRoot,
  makeDir,
  mimeType,
  readBytes,
  remove,
  settled,
  stat,
  toBytes,
  writeBytes,
} from "./internal/fs.ts";

export { EncodingType };

/** The session a native network task runs in (native tasks are not provided here). */
export enum FileSystemSessionType {
  /** A background URL session. */
  BACKGROUND = 0,
  /** A foreground URL session. */
  FOREGROUND = 1,
}

/** How {@linkcode uploadAsync} sends the file. */
export enum FileSystemUploadType {
  /** The file's bytes as the body. */
  BINARY_CONTENT = 0,
  /** A multipart form. */
  MULTIPART = 1,
}

/** Options for {@linkcode downloadAsync}. */
export type DownloadOptions = {
  /** Ask for the MD5 digest (not computed here). */
  md5?: boolean;
  /** Allow a cached response (ignored). */
  cache?: boolean;
  /** Request headers. */
  headers?: Record<string, string>;
  /** The native session type (ignored). */
  sessionType?: FileSystemSessionType;
};

/** The HTTP part of a download or upload result. */
export type FileSystemHttpResult = {
  /** The response headers. */
  headers: Record<string, string>;
  /** The HTTP status code. */
  status: number;
  /** The response's `content-type`, or null. */
  mimeType: string | null;
};

/** What {@linkcode downloadAsync} resolves with. */
export type FileSystemDownloadResult = FileSystemHttpResult & {
  /** The file the body was written to. */
  uri: string;
  /** The MD5 digest (never set here). */
  md5?: string;
};

/** @deprecated Use {@linkcode FileSystemDownloadResult}. */
export type DownloadResult = FileSystemDownloadResult;

/** Options for {@linkcode uploadAsync} (uploads are not provided here). */
export type FileSystemUploadOptions = (UploadOptionsBinary | UploadOptionsMultipart) & {
  /** Request headers. */
  headers?: Record<string, string>;
  /** The HTTP method. */
  httpMethod?: FileSystemAcceptedUploadHttpMethod;
  /** The native session type. */
  sessionType?: FileSystemSessionType;
};

/** A binary upload. */
export type UploadOptionsBinary = {
  /** {@linkcode FileSystemUploadType.BINARY_CONTENT}. */
  uploadType?: FileSystemUploadType;
};

/** A multipart upload. */
export type UploadOptionsMultipart = {
  /** {@linkcode FileSystemUploadType.MULTIPART}. */
  uploadType: FileSystemUploadType;
  /** The form field holding the file. */
  fieldName?: string;
  /** The file part's MIME type. */
  mimeType?: string;
  /** Extra form fields. */
  parameters?: Record<string, string>;
};

/** What an upload resolves with. */
export type FileSystemUploadResult = FileSystemHttpResult & {
  /** The response body. */
  body: string;
};

/** A network task's progress callback. */
export type FileSystemNetworkTaskProgressCallback<
  T extends DownloadProgressData | UploadProgressData,
> = (data: T) => void;

/** A download's progress callback. */
export type DownloadProgressCallback = FileSystemNetworkTaskProgressCallback<
  DownloadProgressData
>;

/** Download progress. */
export type DownloadProgressData = {
  /** Bytes written so far. */
  totalBytesWritten: number;
  /** Bytes expected in all. */
  totalBytesExpectedToWrite: number;
};

/** Upload progress. */
export type UploadProgressData = {
  /** Bytes sent so far. */
  totalBytesSent: number;
  /** Bytes expected in all. */
  totalBytesExpectedToSend: number;
};

/** A paused download's saved state. */
export type DownloadPauseState = {
  /** The remote URL. */
  url: string;
  /** The destination file. */
  fileUri: string;
  /** The download options. */
  options: DownloadOptions;
  /** The data to resume from. */
  resumeData?: string;
};

/** What {@linkcode getInfoAsync} reports. */
export type FileInfo =
  | {
    /** Something exists at the URI. */
    exists: true;
    /** The URI. */
    uri: string;
    /** Its size in bytes (a folder: the files below it). */
    size: number;
    /** Whether it is a folder. */
    isDirectory: boolean;
    /** When it last changed, in seconds since the epoch. */
    modificationTime: number;
    /** The MD5 digest (never set here). */
    md5?: string;
  }
  | {
    /** Nothing exists at the URI. */
    exists: false;
    /** The URI. */
    uri: string;
    /** Always false. */
    isDirectory: false;
  };

/** The HTTP methods an upload may use. */
export type FileSystemAcceptedUploadHttpMethod = "POST" | "PUT" | "PATCH";

/** Options for {@linkcode readAsStringAsync}. */
export type ReadingOptions = {
  /** How the contents are returned (default UTF-8). */
  encoding?: EncodingType | "utf8" | "base64";
  /** Bytes to skip; used with `encoding: "base64"` and a `length`. */
  position?: number;
  /** Bytes to read; used with `encoding: "base64"`. */
  length?: number;
};

/** Options for {@linkcode writeAsStringAsync}. */
export type WritingOptions = {
  /** How `contents` is encoded (default UTF-8). */
  encoding?: EncodingType | "utf8" | "base64";
  /** Add to the end of the file instead of replacing it. */
  append?: boolean;
};

/** Options for {@linkcode deleteAsync}. */
export type DeletingOptions = {
  /** Resolve instead of rejecting when nothing exists at the URI. */
  idempotent?: boolean;
};

/** Options for {@linkcode getInfoAsync}. */
export type InfoOptions = {
  /** Ask for the MD5 digest (not computed here). */
  md5?: boolean;
};

/** The source and destination of {@linkcode moveAsync} and {@linkcode copyAsync}. */
export type RelocatingOptions = {
  /** The source URI. */
  from: string;
  /** The destination URI. */
  to: string;
};

/** Options for {@linkcode makeDirectoryAsync}. */
export type MakeDirectoryOptions = {
  /** Create missing parent folders (and accept an existing folder). */
  intermediates?: boolean;
};

/** A native progress event. */
export type ProgressEvent<T> = {
  /** The task id. */
  uuid: string;
  /** The progress. */
  data: T;
};

/** What the Storage Access Framework's permission request resolves with. */
export type FileSystemRequestDirectoryPermissionsResult =
  | {
    /** Not granted. */
    granted: false;
  }
  | {
    /** Granted. */
    granted: true;
    /** The granted folder's SAF URI. */
    directoryUri: string;
  };

/** The app's documents folder (`file:///documents/`). */
export const documentDirectory: string | null = "file:///documents/";

/** The app's cache folder (`file:///cache/`); the OS may clear it. */
export const cacheDirectory: string | null = "file:///cache/";

/** The bundled assets: the page's own origin (read-only). */
export const bundleDirectory: string | null = (() => {
  const href = (globalThis as { location?: { href?: string } }).location?.href;
  return href ? new URL("./", href).href : "file:///bundle/";
})();

/** The error a native-only export throws. */
function unavailable(name: string, why: string): Error {
  return new Error(`expo-file-system/legacy: ${name} is not available in denext (${why})`);
}

/** `uri` as a folder URI (with one trailing slash). */
function folderUri(uri: string): string {
  return uri.replace(/\/*$/, "/");
}

/** The index entry at `uri` (a file, or a folder written with or without its slash). */
function lookup(uri: string): { uri: string; entry: IndexEntry } | null {
  const file = stat(uri);
  if (file && !uri.endsWith("/")) return { uri, entry: file };
  const dir = stat(folderUri(uri));
  return dir?.dir ? { uri: folderUri(uri), entry: dir } : null;
}

/** The total size of the files at or below the folder `dirUri`. */
function treeSize(dirUri: string): number {
  return children(dirUri).reduce((sum, child) => {
    const entry = stat(child);
    return sum + (entry?.dir ? treeSize(child) : entry?.size ?? 0);
  }, 0);
}

/** The error for a missing source or target. */
function notFound(what: string, uri: string): Error {
  return new Error(`${what} '${uri}' could not be found`);
}

/** The info for a URI outside the backed folders: readable means it exists. */
async function externalInfo(uri: string): Promise<FileInfo> {
  try {
    const bytes = await readBytes(uri);
    return { exists: true, uri, size: bytes.byteLength, isDirectory: false, modificationTime: 0 };
  } catch {
    return { exists: false, uri, isDirectory: false };
  }
}

/**
 * Facts about a file or folder.
 *
 * @param fileUri The file or folder URI.
 * @param _options `md5` is accepted and not computed.
 * @returns `{ exists: true, … }`, or `{ exists: false, isDirectory: false }`.
 */
export async function getInfoAsync(fileUri: string, _options: InfoOptions = {}): Promise<FileInfo> {
  await settled();
  if (!backing(fileUri)) return await externalInfo(fileUri);
  const found = lookup(fileUri);
  if (!found) return { exists: false, uri: fileUri, isDirectory: false };
  const { entry } = found;
  return {
    exists: true,
    uri: fileUri,
    size: entry.dir ? treeSize(found.uri) : entry.size,
    isDirectory: entry.dir,
    modificationTime: entry.mtime / 1000,
  };
}

/**
 * Read a whole file as text, or as base64.
 *
 * @param fileUri The file URI.
 * @param options `encoding` (`utf8`, the default, or `base64`); with base64 and a `length`,
 *   `position` and `length` pick a byte range.
 * @returns The contents.
 */
export async function readAsStringAsync(
  fileUri: string,
  options: ReadingOptions = {},
): Promise<string> {
  const bytes = await readBytes(fileUri);
  if (options.encoding !== "base64") return new TextDecoder().decode(bytes);
  if (options.length === undefined) return bytesToBase64(bytes);
  const start = options.position ?? 0;
  return bytesToBase64(bytes.subarray(start, start + options.length));
}

/**
 * Android content URIs do not exist here: rejects with an error naming denext.
 *
 * @param fileUri The file URI.
 */
export function getContentUriAsync(fileUri: string): Promise<string> {
  return Promise.reject(
    unavailable("getContentUriAsync", `content:// URIs are Android-only; use ${fileUri}`),
  );
}

/**
 * Write a whole file (creating missing parent folders), or append to it.
 *
 * @param fileUri A URI under {@linkcode documentDirectory} or {@linkcode cacheDirectory}.
 * @param contents The text, or base64 with `encoding: "base64"`.
 * @param options `encoding` and `append`.
 */
export async function writeAsStringAsync(
  fileUri: string,
  contents: string,
  options: WritingOptions = {},
): Promise<void> {
  const bytes = toBytes(contents, options.encoding);
  if (options.append) appendBytes(fileUri, bytes);
  else writeBytes(fileUri, bytes);
  await settled();
}

/**
 * Delete a file, or a folder and everything in it.
 *
 * @param fileUri The file or folder URI.
 * @param options `idempotent: true` resolves when nothing is there.
 */
export async function deleteAsync(fileUri: string, options: DeletingOptions = {}): Promise<void> {
  const found = backing(fileUri) ? lookup(fileUri) : null;
  if (!found) {
    if (options.idempotent) return;
    throw new Error(`File '${fileUri}' could not be deleted because it could not be found`);
  }
  remove(found.uri);
  await settled();
}

/** Android's legacy-folder cleanup: there is no such folder here, so it resolves. */
export function deleteLegacyDocumentDirectoryAndroid(): Promise<void> {
  return Promise.resolve();
}

/**
 * Copy `from` onto `to`, replacing what is there. Returns the source's URI as indexed, or
 * null when there is nothing to do (the source is the destination).
 */
function relocate(fn: string, { from, to }: RelocatingOptions): string | null {
  if (!backing(to)) throw new Error(`${fn}: cannot write to ${to}`);
  if (!backing(from)) {
    copy(from, to);
    return from;
  }
  const found = lookup(from);
  if (!found) throw notFound("File", from);
  const target = found.entry.dir ? folderUri(to) : to;
  if (target === found.uri) return null;
  const existing = lookup(target);
  if (existing) remove(existing.uri);
  copy(found.uri, target);
  return found.uri;
}

/**
 * Move a file or folder, replacing what is at the destination.
 *
 * @param options `from` and `to` URIs.
 */
export async function moveAsync(options: RelocatingOptions): Promise<void> {
  if (!backing(options.from)) throw new Error(`moveAsync: cannot move ${options.from}`);
  const source = relocate("moveAsync", options);
  if (source) remove(source);
  await settled();
}

/**
 * Copy a file or folder (or anything `fetch` can read, such as a picker's `blob:` URL),
 * replacing what is at the destination.
 *
 * @param options `from` and `to` URIs.
 */
export async function copyAsync(options: RelocatingOptions): Promise<void> {
  relocate("copyAsync", options);
  await settled();
}

/**
 * Create a folder.
 *
 * @param fileUri The folder URI.
 * @param options `intermediates: true` creates missing parents and accepts an existing folder.
 */
export async function makeDirectoryAsync(
  fileUri: string,
  options: MakeDirectoryOptions = {},
): Promise<void> {
  const uri = folderUri(fileUri);
  if (!backing(uri)) throw new Error(`makeDirectoryAsync: cannot create ${fileUri}`);
  if (isRoot(uri)) return;
  const existing = lookup(fileUri);
  if (existing?.entry.dir && options.intermediates) return;
  if (existing) throw new Error(`Directory '${fileUri}' could not be created or already exists`);
  makeDir(uri, options.intermediates === true);
  await settled();
}

/**
 * The names of a folder's entries.
 *
 * @param fileUri The folder URI.
 * @returns Each file or folder name inside it.
 */
export async function readDirectoryAsync(fileUri: string): Promise<string[]> {
  await settled();
  const found = backing(fileUri) ? lookup(folderUri(fileUri)) : null;
  if (!found?.entry.dir) throw notFound("Directory", fileUri);
  return children(found.uri).map(baseName);
}

/** The origin's storage estimate, or a rejection naming denext when there is none. */
async function estimate(fn: string): Promise<{ quota: number; usage: number }> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  if (typeof storage?.estimate !== "function") {
    throw unavailable(fn, "this browser has no navigator.storage.estimate()");
  }
  const { quota = 0, usage = 0 } = await storage.estimate();
  return { quota, usage };
}

/** The storage still free to this app: the origin's quota minus its usage. */
export async function getFreeDiskStorageAsync(): Promise<number> {
  const { quota, usage } = await estimate("getFreeDiskStorageAsync");
  return Math.max(0, quota - usage);
}

/** The storage available to this app in all: the origin's quota. */
export async function getTotalDiskCapacityAsync(): Promise<number> {
  return (await estimate("getTotalDiskCapacityAsync")).quota;
}

/** A `Headers` object as a plain record. */
function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Download a URL to a file (replacing it). As in Expo, an HTTP error status still resolves,
 * with that `status`.
 *
 * @param uri The remote URL.
 * @param fileUri A URI under {@linkcode documentDirectory} or {@linkcode cacheDirectory}.
 * @param options `headers` are sent; `md5`, `cache` and `sessionType` are ignored.
 * @returns The destination, status, headers and MIME type.
 */
export async function downloadAsync(
  uri: string,
  fileUri: string,
  options: DownloadOptions = {},
): Promise<FileSystemDownloadResult> {
  if (!backing(fileUri)) throw new Error(`downloadAsync: cannot write to ${fileUri}`);
  const response = await fetch(uri, { headers: options.headers });
  writeBytes(fileUri, new Uint8Array(await response.arrayBuffer()));
  await settled();
  return {
    uri: fileUri,
    status: response.status,
    headers: headerRecord(response.headers),
    mimeType: response.headers.get("content-type"),
  };
}

/**
 * Upload a file with `fetch`: its bytes as the body (`BINARY_CONTENT`, the default) or as the
 * `fieldName` part of a multipart form with `parameters` as extra fields (`MULTIPART`).
 * Resolves with the response even on an HTTP error, as Expo does.
 *
 * @param url The remote URL.
 * @param fileUri The file to send.
 * @param options `headers`, `httpMethod` (`POST` by default), `uploadType`, and for a
 *   multipart upload `fieldName` (default `file`), `mimeType` and `parameters`;
 *   `sessionType` is ignored.
 * @returns The status, headers, MIME type and body text.
 */
export async function uploadAsync(
  url: string,
  fileUri: string,
  options: FileSystemUploadOptions = {},
): Promise<FileSystemUploadResult> {
  const bytes = new Uint8Array(await readBytes(fileUri));
  let body: BodyInit = bytes;
  if (options.uploadType === FileSystemUploadType.MULTIPART) {
    const multipart = options as UploadOptionsMultipart;
    const form = new FormData();
    for (const [key, value] of Object.entries(multipart.parameters ?? {})) form.append(key, value);
    const type = multipart.mimeType ?? mimeType(fileUri);
    form.append(multipart.fieldName ?? "file", new Blob([bytes], { type }), baseName(fileUri));
    body = form;
  }
  const response = await fetch(url, {
    method: options.httpMethod ?? "POST",
    headers: options.headers,
    body,
  });
  return {
    status: response.status,
    headers: headerRecord(response.headers),
    mimeType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

/**
 * Not provided (native resumable downloads): throws an error naming denext. Use
 * {@linkcode downloadAsync}.
 *
 * @param _uri The remote URL.
 * @param _fileUri The destination file.
 * @param _options The download options.
 * @param _callback The progress callback.
 * @param _resumeData Saved resume data.
 */
export function createDownloadResumable(
  _uri: string,
  _fileUri: string,
  _options?: DownloadOptions,
  _callback?: FileSystemNetworkTaskProgressCallback<DownloadProgressData>,
  _resumeData?: string,
): DownloadResumable {
  throw unavailable("createDownloadResumable", "native resumable downloads; use downloadAsync");
}

/**
 * Not provided (native upload sessions): throws an error naming denext.
 *
 * @param _url The remote URL.
 * @param _fileUri The file to send.
 * @param _options The upload options.
 * @param _callback The progress callback.
 */
export function createUploadTask(
  _url: string,
  _fileUri: string,
  _options?: FileSystemUploadOptions,
  _callback?: FileSystemNetworkTaskProgressCallback<UploadProgressData>,
): UploadTask {
  throw unavailable("createUploadTask", "native upload sessions; use fetch");
}

/** A native network task. Not provided: constructing a subclass throws an error naming denext. */
export abstract class FileSystemCancellableNetworkTask<
  T extends DownloadProgressData | UploadProgressData,
> {
  /** Throws: native network tasks are not provided. */
  constructor() {
    throw unavailable(new.target.name, "native network tasks");
  }

  /** Cancel the task. */
  cancelAsync(): Promise<void> {
    return Promise.resolve();
  }

  /** The progress callback (never called). */
  protected abstract getCallback(): FileSystemNetworkTaskProgressCallback<T> | undefined;
}

/** A native upload task. Not provided: constructing it throws an error naming denext. */
export class UploadTask extends FileSystemCancellableNetworkTask<UploadProgressData> {
  /**
   * Throws.
   *
   * @param _url The remote URL.
   * @param _fileUri The file to send.
   * @param _options The upload options.
   * @param _callback The progress callback.
   */
  constructor(
    _url: string,
    _fileUri: string,
    _options?: FileSystemUploadOptions,
    _callback?: FileSystemNetworkTaskProgressCallback<UploadProgressData>,
  ) {
    super();
  }

  /** The progress callback (never called). */
  protected getCallback(): undefined {
    return undefined;
  }

  /** Run the upload (never reached: construction throws). */
  uploadAsync(): Promise<FileSystemUploadResult | undefined | null> {
    return Promise.resolve(null);
  }
}

/** A native resumable download. Not provided: constructing it throws an error naming denext. */
export class DownloadResumable extends FileSystemCancellableNetworkTask<DownloadProgressData> {
  /**
   * Throws.
   *
   * @param _url The remote URL.
   * @param _fileUri The destination file.
   * @param _options The download options.
   * @param _callback The progress callback.
   * @param _resumeData Saved resume data.
   */
  constructor(
    _url: string,
    _fileUri: string,
    _options?: DownloadOptions,
    _callback?: FileSystemNetworkTaskProgressCallback<DownloadProgressData>,
    _resumeData?: string,
  ) {
    super();
  }

  /** The progress callback (never called). */
  protected getCallback(): undefined {
    return undefined;
  }

  /** The destination file (never reached: construction throws). */
  get fileUri(): string {
    return "";
  }

  /** Run the download (never reached: construction throws). */
  downloadAsync(): Promise<FileSystemDownloadResult | undefined> {
    return Promise.resolve(undefined);
  }

  /** Pause the download (never reached: construction throws). */
  pauseAsync(): Promise<DownloadPauseState> {
    return Promise.reject(unavailable("DownloadResumable.pauseAsync", "native downloads"));
  }

  /** Resume the download (never reached: construction throws). */
  resumeAsync(): Promise<FileSystemDownloadResult | undefined> {
    return Promise.resolve(undefined);
  }

  /** The state to save (never reached: construction throws). */
  savable(): DownloadPauseState {
    return { url: "", fileUri: "", options: {} };
  }
}

/** The shape of {@linkcode StorageAccessFramework}. */
export interface StorageAccessFrameworkApi {
  /** Android only: throws an error naming denext. */
  getUriForDirectoryInRoot(folderName: string): string;
  /** Android only: rejects with an error naming denext. */
  requestDirectoryPermissionsAsync(
    initialFileUrl?: string | null,
  ): Promise<FileSystemRequestDirectoryPermissionsResult>;
  /** Android only: rejects with an error naming denext. */
  readDirectoryAsync(dirUri: string): Promise<string[]>;
  /** Android only: rejects with an error naming denext. */
  makeDirectoryAsync(parentUri: string, dirName: string): Promise<string>;
  /** Android only: rejects with an error naming denext. */
  createFileAsync(parentUri: string, fileName: string, mimeType: string): Promise<string>;
  /** {@linkcode writeAsStringAsync}. */
  writeAsStringAsync: typeof writeAsStringAsync;
  /** {@linkcode readAsStringAsync}. */
  readAsStringAsync: typeof readAsStringAsync;
  /** {@linkcode deleteAsync}. */
  deleteAsync: typeof deleteAsync;
  /** {@linkcode moveAsync}. */
  moveAsync: typeof moveAsync;
  /** {@linkcode copyAsync}. */
  copyAsync: typeof copyAsync;
}

/** The SAF error for `name`. */
function saf(name: string): Error {
  return unavailable(
    `StorageAccessFramework.${name}`,
    "the Storage Access Framework is Android-only",
  );
}

/**
 * Android's Storage Access Framework. Its own calls throw or reject with an error naming
 * denext; the aliases (`readAsStringAsync`, `writeAsStringAsync`, `deleteAsync`, `moveAsync`,
 * `copyAsync`) are the functions above, for `file://` URIs.
 */
export const StorageAccessFramework: StorageAccessFrameworkApi = {
  getUriForDirectoryInRoot: () => {
    throw saf("getUriForDirectoryInRoot");
  },
  requestDirectoryPermissionsAsync: () => Promise.reject(saf("requestDirectoryPermissionsAsync")),
  readDirectoryAsync: () => Promise.reject(saf("readDirectoryAsync")),
  makeDirectoryAsync: () => Promise.reject(saf("makeDirectoryAsync")),
  createFileAsync: () => Promise.reject(saf("createFileAsync")),
  writeAsStringAsync,
  readAsStringAsync,
  deleteAsync,
  moveAsync,
  copyAsync,
};
