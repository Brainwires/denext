/**
 * Desktop shell integration for `denext/mobile`: open a file or folder with its default app,
 * reveal it in the file manager, move it to the trash. These run only in a Deno Desktop
 * window with the `shell` capability enabled (`denext desktop add shell`); everywhere else
 * they reject with code `"unavailable"` (browsers and mobile webviews have no file paths).
 *
 * The desktop module loads lazily, so web and mobile bundles never fetch it. The runtime runs
 * the OS tool itself (`open` / `explorer` / `xdg-open`, `gio trash`, …) with an argument
 * vector, never a shell string, and only for paths inside the app's own folders, or for a
 * file or folder the user picked in a native dialog this session, named by its `handle`.
 *
 * @module
 */

import { runtimePlatform } from "./bridge.ts";
import { desktopOnlyError } from "./desktop-branch.ts";
import type { PickedHandle } from "./filesystem.ts";

/**
 * What {@linkcode openPath}, {@linkcode revealInFileManager} and {@linkcode moveToTrash} act on:
 * an absolute path inside the app's own folders (from `downloadToFile`), or `{ handle }` for a
 * file or folder the user picked (`pickDocument`, `pickFolder` and `saveFile` results carry
 * one, so the result itself can be passed). A picked item's `path` is display-only: pass its
 * handle.
 */
export type ShellItem = string | { readonly handle: PickedHandle };

/** The checked target: `{ path }` for a non-empty path, `{ handle }` for a handle, else a `TypeError`. */
function checkItem(fn: string, item: ShellItem): { path: string } | { handle: PickedHandle } {
  if (typeof item === "object" && item !== null) {
    const handle = (item as { handle?: unknown }).handle;
    if (typeof handle !== "string" || handle === "") {
      throw new TypeError(`${fn}: the handle must be a non-empty string`);
    }
    return { handle };
  }
  if (typeof item !== "string" || item === "" || item.includes("\u0000")) {
    throw new TypeError(`${fn}: the path must be a non-empty string`);
  }
  return { path: item };
}

/** The desktop module, or the `unavailable` rejection off desktop. */
async function desktop(fn: string) {
  if (runtimePlatform() !== "desktop") throw desktopOnlyError(fn);
  return await import("../desktop/native.ts");
}

/**
 * Open a file or folder with the OS default app (Finder / Explorer for a folder).
 *
 * @param item An absolute path inside the app's folders (from `downloadToFile` on desktop), or
 * `{ handle }` for a picked file or folder (a `pickDocument` / `pickFolder` / `saveFile`
 * result).
 * @returns A promise that settles once the OS took it. It rejects with code `"unavailable"`
 * off desktop or without the `shell` capability, and with `"forbidden"` when the runtime refuses
 * the path or the handle (unknown, or from an earlier launch).
 * @example
 * ```ts
 * import { downloadToFile, openPath } from "denext/mobile";
 *
 * const { path } = await downloadToFile("https://example.com/report.pdf", "report.pdf");
 * await openPath(path);
 * ```
 */
export async function openPath(item: ShellItem): Promise<void> {
  const target = checkItem("openPath", item);
  await (await desktop("openPath")).shellOpenPath(target);
}

/**
 * Show a file or folder selected in Finder, Explorer or the Linux file manager.
 *
 * @param item An absolute path inside the app's folders, or `{ handle }` for a picked item.
 * @returns A promise that settles once the file manager was asked. It rejects with code
 * `"unavailable"` off desktop or without the `shell` capability (`reveal: true`), and
 * `"forbidden"` for a path or handle the runtime refuses.
 * @example
 * ```ts
 * import { revealInFileManager, saveFile } from "denext/mobile";
 *
 * const saved = await saveFile(csv, { suggestedName: "export.csv" });
 * if (saved?.handle) await revealInFileManager({ handle: saved.handle });
 * ```
 */
export async function revealInFileManager(item: ShellItem): Promise<void> {
  const target = checkItem("revealInFileManager", item);
  await (await desktop("revealInFileManager")).shellReveal(target);
}

/**
 * Move a file or folder to the Trash (macOS), Recycle Bin (Windows) or the freedesktop trash
 * (Linux), so the user can restore it.
 *
 * @param item An absolute path inside the app's folders, or `{ handle }` for a picked item
 * (trashing one needs write access: a `saveFile` or `pickFolder` handle).
 * @returns A promise that settles once it is in the trash. It rejects with code
 * `"unavailable"` off desktop or without the `shell` capability (`trash: true`), and
 * `"forbidden"` for a path or handle the runtime refuses.
 * @example
 * ```ts
 * import { moveToTrash, pickFolder } from "denext/mobile";
 *
 * const folder = await pickFolder();
 * if (folder) await moveToTrash(folder);
 * ```
 */
export async function moveToTrash(item: ShellItem): Promise<void> {
  const target = checkItem("moveToTrash", item);
  await (await desktop("moveToTrash")).shellTrash(target);
}
