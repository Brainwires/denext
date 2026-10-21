// One spelling per file for the build's path-prefix tests.
//
// A project reached through a symlink (macOS `/var` → `/private/var`, so any `$TMPDIR` project; a
// symlinked home or workspace folder) has two spellings for every file: the one the caller passed
// and the real one Deno resolves imports to (it reads `deno.json` and resolves import-map entries
// from their real location). A `startsWith` test between the two always fails, so "is this module
// the app's own?" and "is this the framework's source?" both answered no, and every build-time
// feature scan read the whole framework and installed every gated runtime. Canonicalise both sides.

import { basename, dirname, join, normalize, resolve } from "@std/path";

/**
 * The real, absolute spelling of a local path: symlinks resolved, `.` / `..` and doubled
 * separators removed. For a path that does not exist (an extensionless import base, a file not
 * written yet) its nearest existing ancestor is resolved and the rest appended, so the result is
 * always comparable with another canonical path.
 *
 * @param path A local file or directory path, absolute or relative to the working directory.
 * @returns The path's canonical spelling.
 */
export function canonicalPath(path: string): string {
  const abs = normalize(resolve(path));
  const tail: string[] = [];
  for (let dir = abs;;) {
    try {
      return join(Deno.realPathSync(dir), ...tail);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return abs; // nothing on the way up exists (or is readable)
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}
