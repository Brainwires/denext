/**
 * Path confinement for the desktop capabilities — the security core the `fs` and `shell` caps share.
 * A page is untrusted, so a page-supplied path is confined to the app's own directories before any
 * filesystem or shell operation touches it.
 *
 * Both `..` traversal (via {@link resolve} normalization) AND symlinks (via {@link Deno.realPath} of
 * the deepest EXISTING ancestor) are resolved BEFORE the containment check, so neither a `../` escape
 * nor a symlink out of the tree slips through. TOCTOU: symlinks are resolved as they are at check
 * time; a same-user process racing a symlink swap is the Electron-equivalent local-process boundary
 * the bridge does not defend against (see `bridge.ts`) — the page itself has no symlink primitive.
 *
 * Runtime-only (imported by the desktop caps, never a client bundle).
 *
 * @module
 */

import { dirname, isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import { DesktopCapError } from "./extension.ts";

/** `p` is `base` itself or lies within it (using the platform separator). */
function isWithin(base: string, p: string): boolean {
  return p === base || p.startsWith(base + SEPARATOR);
}

/** A `forbidden` (403) capability error. */
function forbidden(message: string): DesktopCapError {
  return new DesktopCapError("forbidden", message, { status: 403 });
}

/**
 * Resolve symlinks in the deepest EXISTING ancestor of `candidate`, then re-attach the
 * not-yet-existing tail and report whether the reconstructed real path stays within `base`.
 *
 * @param base The containing directory (resolved to its real path for the comparison).
 * @param candidate The already-`resolve`d absolute path to test.
 * @returns Whether the real target is within the real `base`.
 */
async function realWithin(base: string, candidate: string): Promise<boolean> {
  const realBase = await Deno.realPath(base).catch(() => resolve(base));
  let existing = candidate;
  for (;;) {
    let real: string;
    try {
      real = await Deno.realPath(existing);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return false; // filesystem root reached without an existing ancestor
      existing = parent;
      continue;
    }
    const tail = relative(existing, candidate);
    const realTarget = tail && tail !== "." ? join(real, tail) : real;
    return isWithin(realBase, realTarget);
  }
}

/**
 * Confine a page-supplied RELATIVE path to `base`: reject an absolute path (`validation`), normalize
 * `..`, and resolve symlinks; a path that escapes is `forbidden`.
 *
 * @param base The absolute base directory.
 * @param rel The relative path from the page.
 * @returns The resolved absolute path to operate on (not the real path — the target may not exist yet).
 */
export async function confineRelative(base: string, rel: string): Promise<string> {
  if (isAbsolute(rel)) {
    throw new DesktopCapError("validation", "path must be relative to its directory");
  }
  const resolved = resolve(base, rel);
  if (!isWithin(base, resolved) || !(await realWithin(base, resolved))) {
    throw forbidden("path escapes its directory");
  }
  return resolved;
}

/**
 * Confine an ABSOLUTE path to any of `roots` (symlink-resolved): the path must lie within one of the
 * app's directories, else `forbidden`. Used by `shell` (openPath/reveal/trash operate on absolute
 * paths the page holds, e.g. an fs `download` result).
 *
 * @param abs The absolute path from the page.
 * @param roots The allowed root directories.
 * @returns The resolved absolute path.
 */
export async function confineWithinRoots(abs: string, roots: readonly string[]): Promise<string> {
  if (typeof abs !== "string" || abs.length === 0 || !isAbsolute(abs)) {
    throw new DesktopCapError("validation", "path must be an absolute path");
  }
  const resolved = resolve(abs);
  for (const root of roots) {
    const base = resolve(root);
    if (isWithin(base, resolved) && (await realWithin(base, resolved))) return resolved;
  }
  throw forbidden("path is outside the app's directories");
}
