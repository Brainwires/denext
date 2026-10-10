/**
 * Find a package the way Node does from a project: the first `node_modules/<name>` with a
 * `package.json`, walking up from the project directory. Shared by React Native mode's
 * resolvers (react-native-web, uniwind).
 *
 * @module
 */

import { dirname, join } from "@std/path";

/**
 * The realpath of package `name`'s directory visible from `projectDir` (walking up
 * `node_modules` like Node), or null when it is not installed. The realpath, not the symlink:
 * pnpm keeps a package's own dependencies next to its real location.
 *
 * @param projectDir Where the lookup starts.
 * @param name The package name.
 */
export async function findInstalledPackage(
  projectDir: string,
  name: string,
): Promise<string | null> {
  for (let dir = projectDir;;) {
    const candidate = join(dir, "node_modules", name);
    try {
      if ((await Deno.stat(join(candidate, "package.json"))).isFile) {
        return await Deno.realPath(candidate);
      }
    } catch { /* not here — keep walking up */ }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
