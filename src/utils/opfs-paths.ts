/**
 * Path helpers over the Origin Private File System, shared by the OPFS hooks
 * (`use-opfs.ts`) and `denext/mobile`'s filesystem web fallback. Internal: not re-exported.
 *
 * @module
 */

/** Whether OPFS is reachable here (`navigator.storage.getDirectory`). */
export function opfsSupported(): boolean {
  return typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function";
}

/** Split a `"a/b/c"` path into non-empty, trimmed segments. */
export function splitPath(path: string): string[] {
  return path.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Walk a `"a/b"` path to a directory handle under `root`. Empty path → `root`. */
export async function resolveDir(
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
export interface ResolvedFile {
  readonly handle: FileSystemFileHandle;
  readonly parent: FileSystemDirectoryHandle;
  readonly name: string;
}

/**
 * Walk a `"a/b/file"` path to its file handle and parent directory under `root`. `create`
 * creates the file; `createDirs` (default: `create`) creates the folders on the way.
 */
export async function resolveFile(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
  createDirs: boolean = create,
): Promise<ResolvedFile> {
  const parts = splitPath(path);
  const name = parts.at(-1);
  if (name === undefined) throw new Error("useFile: a file path is required");
  const parent = await resolveDir(root, parts.slice(0, -1).join("/"), createDirs);
  const handle = await parent.getFileHandle(name, { create });
  return { handle, parent, name };
}
