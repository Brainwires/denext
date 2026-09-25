/**
 * The store behind the `expo-file-system` shim: Expo's synchronous file API on top of
 * `denext/mobile`'s asynchronous filesystem (the app's own files through
 * `@capacitor/filesystem` in the shell, the Origin Private File System on the web).
 *
 * - A synchronous **index** of every file and folder the shim created (URI → kind, size,
 *   modification time), kept in `localStorage`, answers `exists`, `size`, `info()` and
 *   `list()` at once, across reloads.
 * - A **content cache** holds the bytes written (or read) in this session, so a `write()`
 *   followed by `textSync()` works.
 * - Every change to the real files goes through one **queue**, in order; the async readers
 *   wait for it first, so a read always sees the writes before it.
 *
 * URIs look like Expo's: `file:///documents/…` and `file:///cache/…`. Any other URI (a
 * `blob:` / `data:` URL from a picker, an `http(s):` or `capacitor:` URL) is read with
 * `fetch` and cannot be written. Internal: not a `denext/expo/*` entrypoint.
 *
 * @module
 */

import { base64ToBytes, bytesToBase64 } from "../../mobile/base64.ts";
import { deleteFile, type FileDirectory, readFile, writeFile } from "../../mobile/filesystem.ts";

/** One indexed file or folder. */
export interface IndexEntry {
  /** A folder, or a file. */
  readonly dir: boolean;
  /** The file's size in bytes (0 for a folder). */
  readonly size: number;
  /** When it last changed, in ms since the epoch. */
  readonly mtime: number;
}

/** The URI prefix of each backed root, and the `denext/mobile` folder it lives in. */
const ROOTS: Readonly<Record<string, FileDirectory>> = {
  "file:///documents/": "documents",
  "file:///cache/": "cache",
};

/** The `localStorage` key of the index. */
const INDEX_KEY = "denext-expo-file-system";

let index: Map<string, IndexEntry> | undefined;
let contents: Map<string, Uint8Array> | undefined;
let queue: Promise<void> | undefined;

/** The content cache, created on first use (nothing runs at import time). */
function cacheMap(): Map<string, Uint8Array> {
  return contents ??= new Map();
}

/** The index, loaded from `localStorage` on first use. */
function entries(): Map<string, IndexEntry> {
  if (index) return index;
  index = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(INDEX_KEY);
    for (const [uri, entry] of raw ? JSON.parse(raw) as [string, IndexEntry][] : []) {
      index.set(uri, entry);
    }
  } catch { /* unreadable or blocked storage: start empty */ }
  return index;
}

/** Save the index to `localStorage` (best effort). */
function saveIndex(): void {
  try {
    globalThis.localStorage?.setItem(INDEX_KEY, JSON.stringify([...entries()]));
  } catch { /* quota or blocked storage: the index lives for this session only */ }
}

/** Run `op` after every change queued before it; a failure is logged, not thrown. */
function enqueue(op: () => Promise<unknown>): void {
  queue = (queue ?? Promise.resolve()).then(op).then(
    () => {},
    (err) => console.warn("[denext/expo/file-system] could not persist a change:", err),
  );
}

/** Wait until every queued change has reached the real files. */
export function settled(): Promise<void> {
  return queue ?? Promise.resolve();
}

/** The backed root of `uri`, and its path inside that root, or null for any other URI. */
export function backing(uri: string): { directory: FileDirectory; rel: string } | null {
  for (const [prefix, directory] of Object.entries(ROOTS)) {
    if (uri.startsWith(prefix)) return { directory, rel: uri.slice(prefix.length) };
  }
  return null;
}

/** Whether `uri` is one of the root folders. */
export function isRoot(uri: string): boolean {
  return Object.hasOwn(ROOTS, uri);
}

/** The folder URI containing `uri` (with a trailing slash). */
export function parentUri(uri: string): string {
  const trimmed = uri.endsWith("/") ? uri.slice(0, -1) : uri;
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
}

/** The last path segment of `uri`. */
export function baseName(uri: string): string {
  const trimmed = uri.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** `content` as bytes, decoding base64 when asked. */
export function toBytes(content: string | Uint8Array, encoding?: string): Uint8Array {
  if (typeof content !== "string") return content;
  return encoding === "base64" ? base64ToBytes(content) : new TextEncoder().encode(content);
}

/** The index entry for `uri` (a root counts as a folder), or undefined. */
export function stat(uri: string): IndexEntry | undefined {
  if (isRoot(uri)) return { dir: true, size: 0, mtime: 0 };
  return entries().get(uri);
}

/** Record `uri` in the index. */
function record(uri: string, entry: IndexEntry): void {
  entries().set(uri, entry);
  saveIndex();
}

/**
 * Make sure every folder above `uri` is indexed. With `create` false a missing parent is an
 * error (Expo's `intermediates: false`).
 */
function ensureParents(uri: string, create: boolean): void {
  const parent = parentUri(uri);
  if (!backing(parent) || stat(parent)?.dir) return;
  if (!create) throw new Error(`The parent folder of ${uri} does not exist`);
  ensureParents(parent, true);
  record(parent, { dir: true, size: 0, mtime: Date.now() });
}

/** The URIs indexed directly inside the folder `dirUri`. */
export function children(dirUri: string): string[] {
  return [...entries().keys()].filter((uri) => parentUri(uri) === dirUri);
}

/** Every indexed URI at or below `uri`. */
function subtree(uri: string): string[] {
  const folder = uri.endsWith("/");
  return [...entries().keys()].filter((u) => u === uri || (folder && u.startsWith(uri)));
}

/** Write `bytes` to the real file behind `uri`. */
function persist(uri: string, bytes: Uint8Array): Promise<void> {
  const target = backing(uri)!;
  return writeFile(target.rel, bytesToBase64(bytes), {
    directory: target.directory,
    recursive: true,
    encoding: "base64",
  });
}

/** Cache and index `bytes` as the contents of `uri`. */
function remember(uri: string, bytes: Uint8Array): void {
  cacheMap().set(uri, bytes);
  record(uri, { dir: false, size: bytes.byteLength, mtime: Date.now() });
}

/** Write `bytes` to the file `uri` now (index + cache) and to the real file in order. */
export function writeBytes(uri: string, bytes: Uint8Array): void {
  if (!backing(uri)) {
    throw new Error(
      `Cannot write to ${uri}: only file:///documents/ and file:///cache/ are writable`,
    );
  }
  ensureParents(uri, true);
  remember(uri, bytes);
  enqueue(() => persist(uri, bytes));
}

/**
 * Index `uri` as a copy of `source` (or `source` plus `extra`) now, and move the bytes in
 * order: they are read from disk inside the queue, after every earlier change.
 */
function deferredWrite(uri: string, source: string, size: number, extra?: Uint8Array): void {
  ensureParents(uri, true);
  record(uri, { dir: false, size, mtime: Date.now() });
  enqueue(async () => {
    const base = await readBacking(source);
    const bytes = extra ? concat(base, extra) : base;
    cacheMap().set(uri, bytes);
    await persist(uri, bytes);
  });
}

/** Append `bytes` to the file `uri`, reading what it holds first when it is not cached. */
export function appendBytes(uri: string, bytes: Uint8Array): void {
  const known = cacheMap().get(uri);
  const entry = stat(uri);
  if (known || !entry) return writeBytes(uri, concat(known ?? new Uint8Array(), bytes));
  deferredWrite(uri, uri, entry.size + bytes.byteLength, bytes);
}

/** `a` then `b`. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

/** Index an empty folder at `uri`. */
export function makeDir(uri: string, intermediates: boolean): void {
  ensureParents(uri, intermediates);
  record(uri, { dir: true, size: 0, mtime: Date.now() });
}

/** Remove `uri` (and, for a folder, everything below it) from the index, cache and disk. */
export function remove(uri: string): void {
  for (const target of subtree(uri)) {
    const entry = entries().get(target);
    entries().delete(target);
    cacheMap().delete(target);
    const where = backing(target);
    if (entry && !entry.dir && where) {
      enqueue(() => deleteFile(where.rel, { directory: where.directory }).catch(() => {}));
    }
  }
  saveIndex();
}

/** Copy the file or folder `from` to `to` (index now, bytes in order). */
export function copy(from: string, to: string): void {
  if (!backing(from)) return copyExternal(from, to);
  for (const source of subtree(from)) {
    const target = to + source.slice(from.length);
    const entry = entries().get(source)!;
    if (entry.dir) {
      makeDir(target, true);
      continue;
    }
    const known = cacheMap().get(source);
    if (known) {
      writeBytes(target, known);
      continue;
    }
    deferredWrite(target, source, entry.size);
  }
}

/** Copy a URI that is not a backed file (a `blob:` URL, `http(s):`) to the file `to`. */
function copyExternal(from: string, to: string): void {
  ensureParents(to, true);
  record(to, { dir: false, size: 0, mtime: Date.now() });
  enqueue(async () => {
    const bytes = new Uint8Array(await (await fetch(from)).arrayBuffer());
    remember(to, bytes);
    await persist(to, bytes);
  });
}

/** Read the bytes of a backed file from disk (no cache, no queue wait). */
async function readBacking(uri: string): Promise<Uint8Array> {
  const where = backing(uri)!;
  return base64ToBytes(
    await readFile(where.rel, { directory: where.directory, encoding: "base64" }),
  );
}

/** The bytes cached for `uri` in this session, or undefined. */
export function cached(uri: string): Uint8Array | undefined {
  return cacheMap().get(uri);
}

/**
 * The bytes at `uri`: a backed file (after the queued writes; from the cache when it has
 * them), or anything `fetch` can read.
 */
export async function readBytes(uri: string): Promise<Uint8Array> {
  await settled();
  const known = cacheMap().get(uri);
  if (known) return known;
  if (!backing(uri)) return new Uint8Array(await (await fetch(uri)).arrayBuffer());
  if (!stat(uri)) throw new Error(`File ${uri} does not exist`);
  const bytes = await readBacking(uri);
  cacheMap().set(uri, bytes);
  return bytes;
}

/**
 * A URL an `<img>`, `<audio>` or `<video>` can load for `uri`: a `blob:` URL for a backed
 * file, the URI itself for anything else.
 */
export async function displayUrl(uri: string): Promise<string> {
  if (!backing(uri)) return uri;
  const blob = new Blob([await readBytes(uri) as Uint8Array<ArrayBuffer>], {
    type: mimeType(uri),
  });
  return URL.createObjectURL(blob);
}

/** Common extensions → MIME types. */
const MIME: Readonly<Record<string, string>> = {
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  webm: "video/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/** The MIME type for `uri`'s extension (`application/octet-stream` when unknown). */
export function mimeType(uri: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(uri)?.[1]?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/** Forget the index, cache and queue (tests only). */
export function resetFileSystemForTesting(): void {
  index = undefined;
  contents = undefined;
  queue = undefined;
}
