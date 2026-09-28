/**
 * The browser half of `denext/mobile`'s picked handles: a page-memory map from an opaque handle
 * id to the File System Access API handle (`FileSystemFileHandle` / `FileSystemDirectoryHandle`)
 * that `pickFolder`, `pickDocument` or `saveFile` got from `showDirectoryPicker` /
 * `showOpenFilePicker` / `showSaveFilePicker`. The filesystem functions resolve a
 * `{ picked: handle }` directory through it.
 *
 * Ids start with {@linkcode WEB_HANDLE_PREFIX}, so a handle the desktop runtime issued is never
 * looked up here and a page-memory handle never travels to the runtime. The map lives as long as
 * the page: a reload forgets every handle (the browser's own handles cannot be serialized into
 * a string). Internal; not re-exported.
 *
 * @module
 */

/** The prefix of every page-memory handle id. */
export const WEB_HANDLE_PREFIX = "web:";

/** The handle id → File System Access handle map (created on first use). */
let registry: Map<string, FileSystemHandle> | undefined;

/**
 * Remember `handle` for this page and return its opaque id.
 *
 * @param handle The File System Access handle a picker returned.
 * @returns The id to put in a result's `handle` field.
 */
export function registerWebHandle(handle: FileSystemHandle): string {
  registry ??= new Map();
  const id = `${WEB_HANDLE_PREFIX}${crypto.randomUUID()}`;
  registry.set(id, handle);
  return id;
}

/**
 * The File System Access handle behind `id`, if this page issued it.
 *
 * @param id A handle id.
 * @returns The handle, or `undefined` for an unknown (forged, or pre-reload) id.
 */
export function webHandle(id: string): FileSystemHandle | undefined {
  return registry?.get(id);
}

/** Forget every page-memory handle (tests). */
export function resetPickedHandlesForTesting(): void {
  registry = undefined;
}

/**
 * Whether `err` is the File System Access API's cancel rejection.
 *
 * @param err The caught value.
 * @returns `true` for an `AbortError` (the user dismissed the picker).
 */
export function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown })?.name === "AbortError";
}

/** A File System Access handle's permission methods (Chromium; absent elsewhere). */
interface PermissionedHandle {
  queryPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

/**
 * Make sure the page may write through `handle`: a picker grants read access, and the browser
 * asks for write access once (Chromium). Browsers without the permission methods let the write
 * itself decide.
 *
 * @param handle The picked handle.
 * @returns Whether write access is granted.
 */
export async function webHandleWritable(handle: FileSystemHandle): Promise<boolean> {
  const h = handle as FileSystemHandle & PermissionedHandle;
  if (typeof h.queryPermission !== "function") return true;
  if (await h.queryPermission({ mode: "readwrite" }) === "granted") return true;
  return typeof h.requestPermission === "function" &&
    await h.requestPermission({ mode: "readwrite" }) === "granted";
}

/** The `types` option of `showOpenFilePicker` / `showSaveFilePicker`. */
export interface FilePickerAcceptType {
  /** Accepted MIME types, each with its extensions (`[]`: the browser infers them). */
  readonly accept: Record<string, string[]>;
}

/**
 * MIME types as the File System Access pickers' `types` option: entries without a `/` (not a
 * MIME type) are skipped; none left means no filter.
 *
 * @param types Accepted MIME types (`"application/pdf"`, `"image/*"`).
 * @returns The `types` option, or `undefined` for any file.
 */
export function pickerTypes(
  types: readonly string[] | undefined,
): FilePickerAcceptType[] | undefined {
  const mimes = (types ?? []).filter((t) => typeof t === "string" && t.includes("/"));
  if (mimes.length === 0) return undefined;
  return [{ accept: Object.fromEntries(mimes.map((m) => [m, []])) }];
}
