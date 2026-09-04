// The on-disk location of a prerendered page under `pages-static/`, shared by the
// build-time SSG writer and the runtime server so both apply the same escape guard.

import { join, resolve, SEPARATOR } from "@std/path";

/**
 * The dir for `pathname` under `staticDir`, or null when the pathname would escape it.
 * Defense-in-depth: never let a pathname escape the static dir, even if a caller decodes
 * it earlier than expected (WHATWG URL already normalizes `..`).
 */
export function staticPageDir(staticDir: string, pathname: string): string | null {
  if (pathname.includes("..") || pathname.includes("\0")) return null;
  const dir = join(staticDir, pathname === "/" ? "" : pathname);
  const rootDir = resolve(staticDir);
  const resolvedDir = resolve(dir);
  if (resolvedDir !== rootDir && !resolvedDir.startsWith(rootDir + SEPARATOR)) return null;
  return dir;
}
