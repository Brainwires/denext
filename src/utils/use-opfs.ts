/**
 * OPFS React hooks — read, write, and *live-observe* the Origin Private File
 * System from a component. Built on {@linkcode useFileSystemObserver}: a
 * directory listing and a file's contents re-read themselves when the underlying
 * storage changes.
 *
 * - {@linkcode useOPFSRoot} — the OPFS root directory handle.
 * - {@linkcode useDirectory} — a directory's entries, auto-refreshed on change.
 * - {@linkcode useFile} — a file's contents (text / JSON / bytes) plus `write` and
 *   `remove`, auto-refreshed on change.
 *
 * All three are client-only and a graceful no-op during SSR or where OPFS is
 * unavailable (`isSupported` reports which). A path argument (`"a/b/c.json"`) is
 * resolved under the OPFS root; a handle argument is used directly, so a
 * user-picked File System Access directory works too.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from "../runtime/hooks.ts";
import { useFileSystemObserver } from "./use-file-system-observer.ts";

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Whether OPFS is reachable here (`navigator.storage.getDirectory`). */
function opfsSupported(): boolean {
  return typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function";
}

/** Split a `"a/b/c"` path into non-empty, trimmed segments. */
function splitPath(path: string): string[] {
  return path.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Walk a `"a/b"` path to a directory handle under `root`. Empty path → `root`. */
async function resolveDir(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of splitPath(path)) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

/** A resolved file plus the parent needed to remove it. */
interface ResolvedFile {
  readonly handle: FileSystemFileHandle;
  readonly parent: FileSystemDirectoryHandle;
  readonly name: string;
}

/** Walk a `"a/b/file"` path to its file handle and parent directory under `root`. */
async function resolveFile(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<ResolvedFile> {
  const parts = splitPath(path);
  const name = parts.at(-1);
  if (name === undefined) throw new Error("useFile: a file path is required");
  const parent = await resolveDir(root, parts.slice(0, -1).join("/"), create);
  const handle = await parent.getFileHandle(name, { create });
  return { handle, parent, name };
}

/** Read a directory's immediate entries, sorted by name. */
async function readEntries(dir: FileSystemDirectoryHandle): Promise<DirectoryEntry[]> {
  const out: DirectoryEntry[] = [];
  for await (const [name, handle] of dir.entries()) {
    out.push({ name, kind: handle.kind, handle });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Run an async `read` and pipe its outcome into component state, discarding the
 * result if the effect was cleaned up meanwhile. Returns the effect's cleanup.
 * Shared by {@linkcode useDirectory} and {@linkcode useFile}.
 */
function runRead<T>(
  read: () => Promise<T>,
  onData: (value: T) => void,
  setError: (error: Error | null) => void,
  setLoading: (loading: boolean) => void,
): () => void {
  let cancelled = false;
  setLoading(true);
  read().then(
    (value) => {
      if (cancelled) return;
      onData(value);
      setError(null);
      setLoading(false);
    },
    (err: unknown) => {
      if (cancelled) return;
      setError(toError(err));
      setLoading(false);
    },
  );
  return () => {
    cancelled = true;
  };
}

// ---- useOPFSRoot -----------------------------------------------------------

/** The result of {@linkcode useOPFSRoot}. */
export interface UseOPFSRootResult {
  /** The OPFS root directory handle, or `null` until it resolves (or when unsupported). */
  readonly root: FileSystemDirectoryHandle | null;
  /** Whether OPFS is available (client + browser support). */
  readonly isSupported: boolean;
  /** The error from acquiring the root, or `null`. */
  readonly error: Error | null;
}

/**
 * Acquire the OPFS root directory handle (`navigator.storage.getDirectory()`).
 *
 * @returns `{ root, isSupported, error }` — `root` is `null` until it resolves.
 */
export function useOPFSRoot(): UseOPFSRootResult {
  const isSupported = opfsSupported();
  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!isSupported) return;
    let cancelled = false;
    navigator.storage.getDirectory().then(
      (dir) => void (cancelled || setRoot(dir)),
      (err) => void (cancelled || setError(toError(err))),
    );
    return () => {
      cancelled = true;
    };
  }, [isSupported]);

  return { root, isSupported, error };
}

// ---- useDirectory ----------------------------------------------------------

/** One entry of a directory listing. */
export interface DirectoryEntry {
  /** The entry's name within its directory. */
  readonly name: string;
  /** Whether it is a file or a subdirectory. */
  readonly kind: "file" | "directory";
  /** The entry's handle. */
  readonly handle: FileSystemFileHandle | FileSystemDirectoryHandle;
}

/** Options for {@linkcode useDirectory}. */
export interface UseDirectoryOptions {
  /** Observe the whole subtree, so a change deep inside also refreshes the listing. */
  readonly recursive?: boolean;
}

/** The result of {@linkcode useDirectory}. */
export interface UseDirectoryResult {
  /** The directory's immediate entries, sorted by name. */
  readonly entries: DirectoryEntry[];
  /** Whether OPFS is available (client + browser support). */
  readonly isSupported: boolean;
  /** Whether a read is in flight. */
  readonly loading: boolean;
  /** The last read/resolve error, or `null`. */
  readonly error: Error | null;
  /** Re-read the listing now (in addition to the automatic refresh on change). */
  readonly refresh: () => void;
}

/**
 * List a directory's entries and keep the listing live: it re-reads whenever the
 * File System Observer reports a change (when that API is available).
 *
 * @param pathOrHandle - A path under the OPFS root (`"photos/2026"`) or a
 * `FileSystemDirectoryHandle` to read directly.
 * @param options - `{ recursive }` to also refresh on deep changes.
 * @returns `{ entries, isSupported, loading, error, refresh }`.
 */
export function useDirectory(
  pathOrHandle: string | FileSystemDirectoryHandle,
  options?: UseDirectoryOptions,
): UseDirectoryResult {
  const isSupported = opfsSupported();
  const path = typeof pathOrHandle === "string" ? pathOrHandle : null;
  const givenHandle = typeof pathOrHandle === "string" ? null : pathOrHandle;

  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(givenHandle);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(isSupported && !givenHandle);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Resolve a path to a handle (a handle is used directly).
  useEffect(() => {
    if (givenHandle) {
      setDir(givenHandle);
      return;
    }
    if (path == null || !isSupported) return;
    let cancelled = false;
    navigator.storage.getDirectory()
      .then((root) => resolveDir(root, path, false))
      .then(
        (resolved) => void (cancelled || setDir(resolved)),
        (err) => {
          if (cancelled) return;
          setError(toError(err));
          setLoading(false);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [path, givenHandle, isSupported]);

  // Read entries when the handle changes or a refresh ticks.
  useEffect(() => {
    if (!dir) return;
    return runRead(() => readEntries(dir), setEntries, setError, setLoading);
  }, [dir, tick]);

  useFileSystemObserver(dir, refresh, { recursive: options?.recursive });

  return { entries, isSupported, loading, error, refresh };
}

// ---- useFile ---------------------------------------------------------------

/** How {@linkcode useFile} decodes the file's contents. */
export type FileAs = "text" | "arrayBuffer" | "json";

/** Options for {@linkcode useFile}. */
export interface UseFileOptions {
  /** Decode as `"text"` (default), `"arrayBuffer"`, or `"json"` (parsed). */
  readonly as?: FileAs;
  /** Create the file (and parent directories) if missing, instead of erroring. */
  readonly create?: boolean;
}

/** The result of {@linkcode useFile}. `T` is the decoded `data` type. */
export interface UseFileResult<T> {
  /** The decoded contents, or `null` until read (or when the file is absent). */
  readonly data: T | null;
  /** Whether OPFS is available (client + browser support). */
  readonly isSupported: boolean;
  /** Whether a read is in flight. */
  readonly loading: boolean;
  /** The last read/write/remove error, or `null`. */
  readonly error: Error | null;
  /** Overwrite the file (creating it and parent dirs as needed), then refresh. */
  readonly write: (contents: FileSystemWriteChunkType) => Promise<void>;
  /** Delete the file from its parent directory, then refresh. Needs a path (not a bare handle). */
  readonly remove: () => Promise<void>;
  /** Re-read now (in addition to the automatic refresh on change). */
  readonly refresh: () => void;
}

async function readFileAs(handle: FileSystemFileHandle, as: FileAs): Promise<unknown> {
  const file = await handle.getFile();
  if (as === "arrayBuffer") return await file.arrayBuffer();
  const text = await file.text();
  return as === "json" ? JSON.parse(text) : text;
}

/**
 * The writable target for {@linkcode useFile}'s `write` (creating along the path). Returns the
 * handle plus its parent/name when resolved from a path, so `write` can adopt the freshly
 * created handle (and know its parent for a later `remove`); a bare handle has no parent.
 */
async function writableTarget(
  path: string | null,
  givenHandle: FileSystemFileHandle | null,
): Promise<
  { handle: FileSystemFileHandle; parent: FileSystemDirectoryHandle | null; name: string | null }
> {
  if (path == null) return { handle: givenHandle!, parent: null, name: null };
  const { handle, parent, name } = await resolveFile(
    await navigator.storage.getDirectory(),
    path,
    true,
  );
  return { handle, parent, name };
}

/** The parent + name needed to remove {@linkcode useFile}'s target, or `null` if unknown. */
async function removalTarget(
  cached: { parent: FileSystemDirectoryHandle; name: string } | null,
  path: string | null,
): Promise<{ parent: FileSystemDirectoryHandle; name: string } | null> {
  if (cached) return cached;
  if (path == null) return null;
  const { parent, name } = await resolveFile(await navigator.storage.getDirectory(), path, false);
  return { parent, name };
}

/** Normalized {@linkcode useFile} arguments. */
interface FileArgs {
  readonly as: FileAs;
  readonly create: boolean;
  readonly path: string | null;
  readonly givenHandle: FileSystemFileHandle | null;
}

/** Split `useFile`'s `pathOrHandle` + options into a path vs. a direct handle. */
function fileArgs(
  pathOrHandle: string | FileSystemFileHandle,
  options?: UseFileOptions,
): FileArgs {
  const isPath = typeof pathOrHandle === "string";
  return {
    as: options?.as ?? "text",
    create: options?.create ?? false,
    path: isPath ? pathOrHandle : null,
    givenHandle: isPath ? null : pathOrHandle,
  };
}

/**
 * Read a file's contents and keep them live: they re-read whenever the File
 * System Observer reports a change. Also returns `write` and `remove`.
 *
 * @param pathOrHandle - A path under the OPFS root (`"notes/todo.json"`) or a
 * `FileSystemFileHandle` to read directly (`remove` then needs a path).
 * @param options - `{ as, create }` — decode mode and whether to create on write.
 * @returns `{ data, isSupported, loading, error, write, remove, refresh }`.
 */
export function useFile(
  pathOrHandle: string | FileSystemFileHandle,
  options?: { as?: "text"; create?: boolean },
): UseFileResult<string>;
/** Read the file as an `ArrayBuffer`. See the primary overload for details. */
export function useFile(
  pathOrHandle: string | FileSystemFileHandle,
  options: { as: "arrayBuffer"; create?: boolean },
): UseFileResult<ArrayBuffer>;
/** Read and `JSON.parse` the file as `T`. See the primary overload for details. */
export function useFile<T = unknown>(
  pathOrHandle: string | FileSystemFileHandle,
  options: { as: "json"; create?: boolean },
): UseFileResult<T>;
export function useFile(
  pathOrHandle: string | FileSystemFileHandle,
  options?: UseFileOptions,
): UseFileResult<unknown> {
  const isSupported = opfsSupported();
  const { as, create, path, givenHandle } = fileArgs(pathOrHandle, options);

  const [handle, setHandle] = useState<FileSystemFileHandle | null>(givenHandle);
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(isSupported);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // The parent directory is needed for `remove`; only known when a path is given.
  const parentRef = useRef<{ parent: FileSystemDirectoryHandle; name: string } | null>(null);

  // Resolve a path to a file handle (a handle is used directly).
  useEffect(() => {
    if (givenHandle) {
      setHandle(givenHandle);
      return;
    }
    if (path == null || !isSupported) return;
    let cancelled = false;
    navigator.storage.getDirectory()
      .then((root) => resolveFile(root, path, create))
      .then(
        (resolved) => {
          if (cancelled) return;
          parentRef.current = { parent: resolved.parent, name: resolved.name };
          setHandle(resolved.handle);
        },
        (err) => {
          if (cancelled) return;
          setError(toError(err));
          setLoading(false);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [path, givenHandle, isSupported, create]);

  // Read when the handle changes or a refresh ticks.
  useEffect(() => {
    if (!handle) return;
    return runRead(() => readFileAs(handle, as), setData, setError, setLoading);
  }, [handle, as, tick]);

  useFileSystemObserver(handle, refresh);

  const write = useCallback(async (contents: FileSystemWriteChunkType) => {
    try {
      const target = await writableTarget(path, givenHandle);
      const writable = await target.handle.createWritable();
      await writable.write(contents);
      await writable.close();
      // Adopt the (possibly just-created) handle so a write to a not-yet-existent file starts
      // reading it — with default `create:false` the resolve effect never produced a handle.
      if (target.parent && target.name) {
        parentRef.current = { parent: target.parent, name: target.name };
      }
      setHandle(target.handle);
      refresh();
    } catch (err) {
      setError(toError(err));
      throw err;
    }
  }, [path, givenHandle, refresh]);

  const remove = useCallback(async () => {
    const meta = await removalTarget(parentRef.current, path);
    if (!meta) {
      throw new Error("useFile: remove() needs a path (a bare file handle has no parent).");
    }
    try {
      await meta.parent.removeEntry(meta.name);
      // The file is gone — clear the contents and detach the handle, so the observer/read don't
      // fire on a now-dead handle and resurrect a spurious NotFound error.
      setData(null);
      setError(null);
      setHandle(null);
    } catch (err) {
      setError(toError(err));
      throw err;
    }
  }, [path]);

  return { data, isSupported, loading, error, write, remove, refresh };
}
