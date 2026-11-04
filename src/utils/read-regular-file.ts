// A project file's text read only when it is a regular file under a size cap: shared by the
// readers of a cloned project's config files (workspace manifests, Expo app configs), where a
// FIFO or device under the file's name would block the read or never end, and a huge file would
// be buffered whole.

/** The largest project file read by default; a bigger one counts as missing. */
const MAX_PROJECT_FILE_BYTES = 8 * 1024 * 1024;

/**
 * A file's text, or `null` when it is missing, over `maxBytes`, or not a regular file (a symlink
 * counts when it points at one).
 *
 * @param path The file.
 * @param maxBytes The most bytes read (default {@link MAX_PROJECT_FILE_BYTES}).
 * @returns Its text, or `null`.
 */
export async function readRegularTextFile(
  path: string,
  maxBytes: number = MAX_PROJECT_FILE_BYTES,
): Promise<string | null> {
  const link = await Deno.lstat(path).catch(() => null);
  if (link === null || !(link.isFile || link.isSymlink)) return null;
  const info = link.isSymlink ? await Deno.stat(path).catch(() => null) : link;
  if (info === null || !info.isFile || info.size > maxBytes) return null;
  return await Deno.readTextFile(path).catch(() => null);
}
