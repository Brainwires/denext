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

/** Whether `path` itself is a symlink (`lstat`, so a dangling link counts; a missing path is not). */
async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isSymlink;
  } catch {
    return false;
  }
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
  const realTarget = await realPathOf(candidate);
  return realTarget !== undefined && isWithin(realBase, realTarget);
}

/**
 * The real path of `candidate`: symlinks resolved in its deepest EXISTING ancestor, with the
 * not-yet-existing tail re-attached. `undefined` when no ancestor resolves, or when the walk meets
 * a DANGLING symlink: `realPath` fails on one, but the link exists and a write through it creates
 * the file at its target — so it is never judged by its (in-scope) parent.
 */
async function realPathOf(candidate: string): Promise<string | undefined> {
  let existing = candidate;
  for (;;) {
    let real: string;
    try {
      real = await Deno.realPath(existing);
    } catch {
      if (await isSymlink(existing)) return undefined;
      const parent = dirname(existing);
      if (parent === existing) return undefined; // filesystem root reached without an existing ancestor
      existing = parent;
      continue;
    }
    const tail = relative(existing, candidate);
    return tail && tail !== "." ? join(real, tail) : real;
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

/**
 * Sub-directories of the app-support (`data`) directory the RUNTIME owns, which a page must never
 * read, list, write, delete, trash, open or drag out:
 *
 * - `ui-updates` holds the desktop updater's verified overlay and its pointer (`current.json`). The
 *   overlay is served at launch without re-verifying it, so a page that could write there would
 *   plant a UI that persists across relaunches and outlives any signed update; trashing it would
 *   roll the app back to the older bundled UI.
 * - `CEF`, `WebKitGTK` and `WebView2` are the web engine's profile (cookies, local storage, the
 *   HTTP cache, saved credentials): reading it hands the page every session the app holds, and
 *   writing it plants state the engine trusts.
 *
 * Lower-case: names are compared case-insensitively.
 */
const RESERVED_DATA_SUBDIRS: readonly string[] = ["ui-updates", "cef", "webkitgtk", "webview2"];

/**
 * Whether a directory-entry name in the data root is a runtime-owned one (see
 * {@link RESERVED_DATA_SUBDIRS}): compared case-insensitively (macOS and Windows filesystems are),
 * ignoring what Windows ignores or reads as a stream — trailing dots and spaces, and a `:stream`
 * suffix (`CEF::$INDEX_ALLOCATION` is the `CEF` directory).
 *
 * @param name One path segment.
 * @returns Whether it names a reserved sub-directory.
 */
export function isReservedDataName(name: string): boolean {
  const bare = name.split(":")[0].replace(/[. ]+$/, "").toLowerCase();
  return RESERVED_DATA_SUBDIRS.includes(bare);
}

/** The reserved first segment of `target` under `dataDir`, if it has one. */
function reservedSegment(dataDir: string, target: string): string | undefined {
  const rel = relative(dataDir, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const first = rel.split(/[\\/]/)[0];
  return isReservedDataName(first) ? first : undefined;
}

/**
 * Refuse a path inside a runtime-owned sub-directory of `dataDir` (see
 * {@link RESERVED_DATA_SUBDIRS}), for EVERY operation. Checked on the path as given AND on its real
 * path against the real data directory, so neither another spelling of the data directory (a
 * symlinked ancestor, `/var` vs `/private/var`) nor a short (8.3) name on Windows reaches it.
 *
 * @param dataDir The app-support directory.
 * @param target The already-confined absolute path.
 */
export async function refuseReservedDataPath(dataDir: string, target: string): Promise<void> {
  let hit = reservedSegment(resolve(dataDir), resolve(target));
  if (hit === undefined) {
    const realData = await Deno.realPath(dataDir).catch(() => undefined);
    const realTarget = await realPathOf(resolve(target));
    if (realData !== undefined && realTarget !== undefined) {
      hit = reservedSegment(realData, realTarget);
    }
  }
  if (hit !== undefined) {
    throw forbidden(`"${hit}" is reserved for the desktop runtime`);
  }
}
