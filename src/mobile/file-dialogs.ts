/**
 * Save and folder dialogs for `denext/mobile`: the native save / folder panels in a Deno
 * Desktop window (`denext desktop add dialogs`), else what the browser offers. The open panel
 * is `pickDocument`.
 *
 * The desktop module loads lazily, so web and mobile bundles never fetch it.
 *
 * @module
 */

import { base64ToBytes } from "./base64.ts";
import { isNativeShell } from "./bridge.ts";
import { desktopOnlyError, onDesktop, viaDesktop } from "./desktop-branch.ts";
import type { FileEncoding } from "./filesystem.ts";

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
  /** The absolute path the user chose (desktop only; a browser download has none). */
  readonly path?: string;
}

/** A folder {@linkcode pickFolder} returned. */
export interface PickedFolder {
  /** The folder name. */
  readonly name: string;
  /** The absolute path (desktop only; the browser hides it). */
  readonly path?: string;
  /** The browser's handle to the folder (web only, where the File System Access API exists). */
  readonly handle?: unknown;
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

/**
 * Save `data` to a file the user chooses.
 *
 * - In a Deno Desktop window (`denext desktop add dialogs`), the native save panel; the
 *   desktop runtime writes the file and the result carries its absolute `path`, which is
 *   added to the session's picked-path allowlist (so `openPath` / `revealInFileManager` may
 *   use it).
 * - In a browser, a download named `suggestedName` (the browser decides where it goes).
 * - Inside the iOS/Android shell there is no save panel: it rejects with code
 *   `"unavailable"` (write with `writeFile`, then `share` the file).
 *
 * @param data The contents: text, or base64 with `encoding: "base64"`.
 * @param options `suggestedName`, `types` and `encoding`.
 * @returns What was saved, or `null` when the user cancelled the desktop panel.
 * @example
 * ```ts
 * import { saveFile } from "denext/mobile";
 *
 * const saved = await saveFile(csv, { suggestedName: "export.csv", types: ["text/csv"] });
 * if (saved?.path) console.log("saved to", saved.path);
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
  download(new Blob([encoding === "utf8" ? data : base64ToBytes(data)], { type }), name);
  return { name };
}

/** The File System Access API's folder picker, where the browser has it. */
type DirectoryPicker = () => Promise<{ name: string }>;

/**
 * Let the user choose a folder.
 *
 * - In a Deno Desktop window (`denext desktop add dialogs`), the native folder panel; the
 *   result carries the absolute `path`, added to the session's picked-path allowlist.
 * - In a browser with the File System Access API (`showDirectoryPicker`), the folder's name
 *   and its `handle`.
 * - Elsewhere (Safari, Firefox, the iOS/Android shell) it rejects with code `"unavailable"`.
 *
 * @returns The folder, or `null` when the user cancelled.
 * @example
 * ```ts
 * import { pickFolder } from "denext/mobile";
 *
 * const folder = await pickFolder();
 * if (folder?.path) await exportInto(folder.path);
 * ```
 */
export async function pickFolder(): Promise<PickedFolder | null> {
  const desktop = onDesktop() && await viaDesktop("dialogs", (d) => d.dialogPickFolder());
  if (desktop) return desktop.value;
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (isNativeShell() || typeof picker !== "function") throw desktopOnlyError("pickFolder");
  try {
    const handle = await picker();
    return { name: handle.name, handle };
  } catch (err) {
    if ((err as { name?: unknown })?.name === "AbortError") return null;
    throw err;
  }
}
