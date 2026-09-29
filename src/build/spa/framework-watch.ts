// SPA dev from a denext checkout (an example, or an app whose import map points `denext` at a
// local copy): the framework's own sources are watched too, so an edit to them reaches the page
// without restarting the dev server. The framework is pre-bundled once per dev server (the
// `@dep` set / the compat runtime), so such an edit drops that pre-bundle and reloads the page.
// denext served from JSR (https:// sources) has nothing local to watch.

import { fromFileUrl, SEPARATOR } from "@std/path";

/**
 * The framework's `src/` directory when denext runs from local files, else null.
 *
 * @param moduleUrl This module's URL (tests pass another).
 * @returns The directory, realpath-resolved (watch events may report realpaths).
 */
export function linkedFrameworkDir(moduleUrl: string = import.meta.url): string | null {
  const url = new URL("../../", moduleUrl);
  if (url.protocol !== "file:") return null;
  try {
    return Deno.realPathSync(fromFileUrl(url)).replace(/[\\/]$/, "");
  } catch {
    return null;
  }
}

/**
 * Whether `path` is inside the framework directory `dir`.
 *
 * @param path A changed path.
 * @param dir The framework directory, or null.
 * @returns Whether it is a framework source.
 */
export function isFrameworkPath(path: string, dir: string | null): boolean {
  return dir !== null && (path === dir || path.startsWith(dir + SEPARATOR));
}
