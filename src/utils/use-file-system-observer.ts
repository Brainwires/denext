/**
 * `useFileSystemObserver` — a React-style hook over the **File System Observer
 * API** (`FileSystemObserver`), which reports changes to a `FileSystemHandle`:
 * files and directories in the Origin Private File System (OPFS) and in
 * user-picked File System Access handles alike.
 *
 * Client-only, and a graceful no-op during SSR or where the API is unavailable
 * (it is a recent, still-experimental browser API — Chromium-only at time of
 * writing, and absent from Deno) — `isSupported` tells you which. The `callback`
 * is held in a ref, so passing a fresh closure each render does **not**
 * re-subscribe; the subscription is torn down and rebuilt only when the observed
 * `target` handle(s) or `recursive` change, and always on unmount.
 *
 * `FileSystemObserver` is not yet in the TypeScript DOM lib, so its shape is
 * declared here (kept module-local rather than augmenting the global scope).
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from "../runtime/hooks.ts";

/**
 * The kind of change reported for a handle. Mirrors the spec's
 * `FileSystemChangeType`: `"appeared"` (created/moved-in), `"disappeared"`
 * (removed/moved-out), `"modified"` (contents changed), `"moved"` (renamed or
 * moved within an observed tree — see {@linkcode FileSystemChangeRecord.relativePathMovedFrom}),
 * `"errored"` (observation failed; the record's paths may be empty), and
 * `"unknown"` (the platform coalesced or dropped detail and a full re-read is
 * advised).
 */
export type FileSystemChangeType =
  | "appeared"
  | "disappeared"
  | "errored"
  | "modified"
  | "moved"
  | "unknown";

/** A single change reported by the observer. */
export interface FileSystemChangeRecord {
  /** The handle that was passed to `observe` and under which the change occurred. */
  readonly root: FileSystemHandle;
  /** The handle that actually changed. */
  readonly changedHandle: FileSystemHandle;
  /** Path of `changedHandle` relative to `root`, as path segments. */
  readonly relativePathComponents: readonly string[];
  /** For a `"moved"` change, the prior path relative to `root`; otherwise `null`. */
  readonly relativePathMovedFrom: readonly string[] | null;
  /** What happened. */
  readonly type: FileSystemChangeType;
}

/** Options for observing a handle. */
export interface FileSystemObserverObserveOptions {
  /** Observe the whole subtree of a directory handle (ignored for a file handle). */
  readonly recursive?: boolean;
}

/** The change callback invoked with the batch of records for an observed handle. */
export type FileSystemObserverCallback = (records: FileSystemChangeRecord[]) => void;

// ---- Ambient shape of the not-yet-in-lib global ----------------------------

interface FileSystemObserverInstance {
  observe(
    handle: FileSystemHandle,
    options?: FileSystemObserverObserveOptions,
  ): Promise<void>;
  unobserve(handle: FileSystemHandle): void;
  disconnect(): void;
}

type FileSystemObserverCtor = new (
  callback: (
    records: FileSystemChangeRecord[],
    observer: FileSystemObserverInstance,
  ) => void,
) => FileSystemObserverInstance;

/** The `FileSystemObserver` constructor if this environment has it. */
function observerCtor(): FileSystemObserverCtor | undefined {
  return (globalThis as { FileSystemObserver?: FileSystemObserverCtor })
    .FileSystemObserver;
}

/** Whether the File System Observer API is available in this environment. */
export function fileSystemObserverSupported(): boolean {
  return observerCtor() !== undefined;
}

/** The result of {@linkcode useFileSystemObserver}. */
export interface UseFileSystemObserverResult {
  /** Whether the File System Observer API is available (client + browser support). */
  readonly isSupported: boolean;
  /** The last error from `observe` (e.g. an unobservable handle), or `null`. */
  readonly error: Error | null;
  /** Tear down the subscription now. Idempotent; the hook also disconnects on unmount. */
  readonly disconnect: () => void;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Subscribe to file-system changes on one or more handles.
 *
 * @param target - The handle (or handles) to observe. `null`/`undefined` observes
 * nothing (the hook stays inert, so a handle that resolves asynchronously can be
 * passed straight through). Pass a **stable** reference — an inline array literal
 * changes identity every render and re-subscribes; memoize it or pass a single handle.
 * @param callback - Invoked with each batch of {@linkcode FileSystemChangeRecord}s.
 * Held in a ref, so a new closure each render does not re-subscribe.
 * @param options - `{ recursive }` to observe a directory's whole subtree.
 * @returns `{ isSupported, error, disconnect }`.
 */
export function useFileSystemObserver(
  target: FileSystemHandle | readonly FileSystemHandle[] | null | undefined,
  callback: FileSystemObserverCallback,
  options?: FileSystemObserverObserveOptions,
): UseFileSystemObserverResult {
  const isSupported = fileSystemObserverSupported();
  const [error, setError] = useState<Error | null>(null);

  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  const observerRef = useRef<FileSystemObserverInstance | null>(null);
  const recursive = options?.recursive ?? false;

  const disconnect = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  useEffect(() => {
    const Ctor = observerCtor();
    if (!Ctor) return;

    const handles = target == null
      ? []
      : Array.isArray(target)
      ? [...(target as readonly FileSystemHandle[])]
      : [target as FileSystemHandle];
    if (handles.length === 0) return;

    let cancelled = false;
    const observer = new Ctor((records) => callbackRef.current(records));
    observerRef.current = observer;
    setError(null);

    Promise.all(handles.map((handle) => observer.observe(handle, { recursive })))
      .catch((err: unknown) => {
        if (!cancelled) setError(toError(err));
      });

    return () => {
      cancelled = true;
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
    };
    // `target` identity gates re-subscription; the callback is read via ref.
  }, [target, recursive]);

  return { isSupported, error, disconnect };
}
