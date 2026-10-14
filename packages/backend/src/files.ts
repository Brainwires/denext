// Listing a directory tree for the CLI actions (`db test`'s pgTAP files, `db seed`'s bucket
// objects).

import { join } from "@std/path";

/**
 * Every file under `dir` (recursively, symlinks not followed), sorted; none when it is missing.
 *
 * @param dir The directory.
 * @returns The files' paths.
 */
export async function filesUnder(dir: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop()!;
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(current));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory) pending.push(join(current, entry.name));
      else if (entry.isFile) files.push(join(current, entry.name));
    }
  }
  return files.sort();
}
