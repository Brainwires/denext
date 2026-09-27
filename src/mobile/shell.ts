/**
 * Desktop shell integration for `denext/mobile`: open a file or folder with its default app,
 * reveal it in the file manager, move it to the trash. These run only in a Deno Desktop
 * window with the `shell` capability enabled (`denext desktop add shell`); everywhere else
 * they reject with code `"unavailable"` (browsers and mobile webviews have no file paths).
 *
 * The desktop module loads lazily, so web and mobile bundles never fetch it. The runtime runs
 * the OS tool itself (`open` / `explorer` / `xdg-open`, `gio trash`, …) with an argument
 * vector, never a shell string, and only for paths its `fs` scope allows (the app's folders
 * and paths the user picked in a native dialog this session).
 *
 * @module
 */

import { runtimePlatform } from "./bridge.ts";
import { desktopOnlyError } from "./desktop-branch.ts";

/** A non-empty path string, or a `TypeError`. */
function checkPath(fn: string, path: string): string {
  if (typeof path !== "string" || path === "" || path.includes("\u0000")) {
    throw new TypeError(`${fn}: the path must be a non-empty string`);
  }
  return path;
}

/** The desktop module, or the `unavailable` rejection off desktop. */
async function desktop(fn: string) {
  if (runtimePlatform() !== "desktop") throw desktopOnlyError(fn);
  return await import("../desktop/native.ts");
}

/**
 * Open a file or folder with the OS default app (Finder / Explorer for a folder).
 *
 * @param path An absolute path (from `pickDocument`, `pickFolder`, `saveFile` or
 * `downloadToFile` on desktop).
 * @returns A promise that settles once the OS took it. It rejects with code `"unavailable"`
 * off desktop or without the `shell` capability, and when the runtime refuses the path.
 * @example
 * ```ts
 * import { downloadToFile, openPath } from "denext/mobile";
 *
 * const { path } = await downloadToFile("https://example.com/report.pdf", "report.pdf");
 * await openPath(path);
 * ```
 */
export async function openPath(path: string): Promise<void> {
  const target = checkPath("openPath", path);
  await (await desktop("openPath")).shellOpenPath(target);
}

/**
 * Show a file or folder selected in Finder, Explorer or the Linux file manager.
 *
 * @param path An absolute path.
 * @returns A promise that settles once the file manager was asked. It rejects with code
 * `"unavailable"` off desktop or without the `shell` capability (`reveal: true`).
 * @example
 * ```ts
 * import { revealInFileManager } from "denext/mobile";
 *
 * await revealInFileManager(savedPath);
 * ```
 */
export async function revealInFileManager(path: string): Promise<void> {
  const target = checkPath("revealInFileManager", path);
  await (await desktop("revealInFileManager")).shellReveal(target);
}

/**
 * Move a file or folder to the Trash (macOS), Recycle Bin (Windows) or the freedesktop trash
 * (Linux), so the user can restore it.
 *
 * @param path An absolute path.
 * @returns A promise that settles once it is in the trash. It rejects with code
 * `"unavailable"` off desktop or without the `shell` capability (`trash: true`).
 * @example
 * ```ts
 * import { moveToTrash } from "denext/mobile";
 *
 * await moveToTrash(file.path);
 * ```
 */
export async function moveToTrash(path: string): Promise<void> {
  const target = checkPath("moveToTrash", path);
  await (await desktop("moveToTrash")).shellTrash(target);
}
