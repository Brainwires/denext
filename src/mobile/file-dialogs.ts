/**
 * Save and folder dialogs for `denext/mobile`: the native save / folder panels in a Deno
 * Desktop window (`denext desktop add dialogs`), else what the browser offers (the File System
 * Access API's pickers where it exists). The open panel is `pickDocument`.
 *
 * A picked item comes back with an opaque `handle` (a {@linkcode PickedHandle}): pass
 * `{ picked: handle }` as the filesystem functions' `directory`, or the result to `openPath` /
 * `revealInFileManager` / `moveToTrash`. Its `path` is for display only.
 *
 * The desktop module loads lazily, so web and mobile bundles never fetch it.
 *
 * @module
 */

import { base64ToBytes } from "./base64.ts";
import { isNativeShell } from "./bridge.ts";
import { desktopOnlyError, onDesktop, viaDesktop } from "./desktop-branch.ts";
import type { FileEncoding, PickedHandle } from "./filesystem.ts";
import {
  type FilePickerAcceptType,
  isAbortError,
  pickerTypes,
  registerWebHandle,
} from "./picked-web.ts";

/** Options for {@linkcode saveFile}. */
export interface SaveFileOptions {
  /** The file name the dialog proposes (`"report.csv"`). */
  readonly suggestedName?: string;
  /** Accepted MIME types, which the desktop panel turns into its type filter. */
  readonly types?: readonly string[];
  /** How `data` is given: text (`"utf8"`, the default) or base64 (`"base64"`). */
  readonly encoding?: FileEncoding;
}

/** A file {@linkcode saveFile} wrote. */
export interface SavedFile {
  /** The file name. */
  readonly name: string;
  /**
   * The absolute path the user chose, for display only (desktop only; the browser hides it and
   * a download has none).
   */
  readonly path?: string;
  /**
   * The saved file's handle (read and write): `{ picked: handle }` with the path `""` reaches
   * it through `readFile` / `writeFile`. On desktop, and in browsers with
   * `showSaveFilePicker`; a plain download has none.
   */
  readonly handle?: PickedHandle;
}

/** A folder {@linkcode pickFolder} returned. */
export interface PickedFolder {
  /** The folder name. */
  readonly name: string;
  /** The absolute path, for display only (desktop only; the browser hides it). */
  readonly path?: string;
  /**
   * The folder's handle: `{ picked: handle }` as the `directory` of `readFile` / `writeFile` /
   * `deleteFile` / `listDir` / `downloadToFile`, with paths relative to the folder.
   */
  readonly handle: PickedHandle;
}

/** The slice of `document` the browser download uses. */
interface DownloadDocument {
  createElement(tag: "a"): HTMLAnchorElement;
  body?: { appendChild(node: unknown): unknown } | null;
}

/** Hand `blob` to the browser as a download named `name`. */
function download(blob: Blob, name: string): void {
  const doc = (globalThis as { document?: DownloadDocument }).document;
  if (typeof doc?.createElement !== "function" || !doc.body) {
    throw new Error("saveFile: no document to download from (called during SSR?)");
  }
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The File System Access API's save picker, where the browser has it. */
type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}) => Promise<FileSystemFileHandle>;

/** Save through `showSaveFilePicker`: the handle (registered), or `null` when cancelled. */
async function saveWithPicker(
  picker: SaveFilePicker,
  contents: Blob,
  options: SaveFileOptions,
): Promise<SavedFile | null> {
  let handle: FileSystemFileHandle;
  try {
    const types = pickerTypes(options.types);
    handle = await picker({
      ...(options.suggestedName !== undefined ? { suggestedName: options.suggestedName } : {}),
      ...(types ? { types } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) return null;
    throw err;
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(contents);
  } finally {
    await writable.close();
  }
  return { name: handle.name, handle: registerWebHandle(handle) };
}

/**
 * Save `data` to a file the user chooses.
 *
 * - In a Deno Desktop window (`denext desktop add dialogs`), the native save panel; the
 *   desktop runtime writes the file and the result carries a `handle` for it (read and write,
 *   and for `openPath` / `revealInFileManager` / `moveToTrash`) plus its absolute `path` for
 *   display.
 * - In a browser with the File System Access API (`showSaveFilePicker`), the browser's save
 *   dialog; the result carries a `handle` for this page.
 * - In other browsers, a download named `suggestedName` (the browser decides where it goes).
 * - Inside the iOS/Android shell there is no save panel: it rejects with code
 *   `"unavailable"` (write with `writeFile`, then `share` the file).
 *
 * @param data The contents: text, or base64 with `encoding: "base64"`.
 * @param options `suggestedName`, `types` and `encoding`.
 * @returns What was saved, or `null` when the user cancelled the save dialog.
 * @example
 * ```ts
 * import { readFile, saveFile } from "denext/mobile";
 *
 * const saved = await saveFile(csv, { suggestedName: "export.csv", types: ["text/csv"] });
 * if (saved?.handle) console.log(await readFile("", { directory: { picked: saved.handle } }));
 * ```
 */
export async function saveFile(
  data: string,
  options: SaveFileOptions = {},
): Promise<SavedFile | null> {
  if (typeof data !== "string") {
    throw new TypeError("saveFile: data must be a string (text, or base64 with encoding)");
  }
  const encoding = options.encoding ?? "utf8";
  if (encoding !== "utf8" && encoding !== "base64") {
    throw new TypeError(`saveFile: unknown encoding "${encoding}" (utf8 or base64)`);
  }
  const name = options.suggestedName ?? "download";
  const desktop = onDesktop() && await viaDesktop(
    "dialogs",
    (d) => d.dialogSaveFile(data, encoding, options.suggestedName, options.types),
  );
  if (desktop) return desktop.value;
  if (isNativeShell()) throw desktopOnlyError("saveFile");
  const type = options.types?.[0] ?? "application/octet-stream";
  const blob = new Blob([encoding === "utf8" ? data : base64ToBytes(data)], { type });
  const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (typeof picker === "function") return await saveWithPicker(picker, blob, options);
  download(blob, name);
  return { name };
}

/** The File System Access API's folder picker, where the browser has it. */
type DirectoryPicker = () => Promise<FileSystemDirectoryHandle>;

/**
 * Let the user choose a folder.
 *
 * - In a Deno Desktop window (`denext desktop add dialogs`), the native folder panel; the
 *   runtime issues a `handle` for the folder (read and write, recursive) for this launch, and
 *   the result carries its absolute `path` for display.
 * - In a browser with the File System Access API (`showDirectoryPicker`), the browser's folder
 *   dialog; the `handle` lasts until the page unloads (the browser asks once before the first
 *   write).
 * - Elsewhere (Safari, Firefox, the iOS/Android shell) it rejects with code `"unavailable"`.
 *
 * @returns The folder, or `null` when the user cancelled.
 * @example
 * ```ts
 * import { listDir, pickFolder, writeFile } from "denext/mobile";
 *
 * const folder = await pickFolder();
 * if (folder) {
 *   const directory = { picked: folder.handle };
 *   await writeFile("export/notes.md", markdown, { directory, recursive: true });
 *   console.log((await listDir("", { directory })).map((e) => e.name));
 * }
 * ```
 */
export async function pickFolder(): Promise<PickedFolder | null> {
  const desktop = onDesktop() && await viaDesktop("dialogs", (d) => d.dialogPickFolder());
  if (desktop) return desktop.value;
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (isNativeShell() || typeof picker !== "function") throw desktopOnlyError("pickFolder");
  try {
    const handle = await picker();
    return { name: handle.name, handle: registerWebHandle(handle) };
  } catch (err) {
    if (isAbortError(err)) return null;
    throw err;
  }
}
