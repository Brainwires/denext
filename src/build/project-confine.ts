// The symlink policy for the commands that write into a project they did not create —
// `denext migrate`, `init`, `upgrade`, `mobile add`, `desktop add`: those run on cloned
// third-party repositories, where a committed symlink is attacker-controlled. A write never goes
// through a symlink (to a file or to a directory) that leads out of the project, and a dangling
// symlink is never written through (that would create its target, wherever it points). A
// symlink that stays inside the project is followed, as any editor would.

import { dirname, isAbsolute, relative, resolve } from "@std/path";

/** A write refused because its path leaves the project (through `..` or a symlink). */
export class OutsideProjectError extends Error {
  /**
   * @param path The path that was to be written.
   * @param reason Why it leaves the project.
   */
  constructor(readonly path: string, reason: string) {
    super(`denext: refusing to write ${path}: ${reason}`);
    this.name = "OutsideProjectError";
  }
}

/** Whether `p` is `dir` or lies under it (both absolute). */
function under(p: string, dir: string): boolean {
  const r = relative(dir, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/**
 * The real path of `path`, or of its nearest existing ancestor with the rest re-appended;
 * `null` when the walk meets a dangling symlink (its target is unknown until it is created).
 */
async function realOrNearest(path: string): Promise<string | null> {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(await Deno.realPath(current), ...rest);
    } catch {
      if ((await Deno.lstat(current).catch(() => null))?.isSymlink) return null;
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(relative(parent, current));
      current = parent;
    }
  }
}

/**
 * Refuse a write to `path` that would land outside the project at `root`: a path outside it,
 * one under a directory symlinked out of it, a symlinked file whose target is outside it, or a
 * path through a dangling symlink.
 *
 * @param root The project directory.
 * @param path The file (or directory) about to be written or created.
 * @param options `entry: true` when the operation acts on the directory entry itself rather
 *   than what it points to (removing or renaming it): then only its parent must stay inside.
 * @throws {OutsideProjectError} When the write would leave the project.
 */
export async function assertInsideProject(
  root: string,
  path: string,
  options: { entry?: boolean } = {},
): Promise<void> {
  const base = resolve(root);
  const target = resolve(base, path);
  if (!under(target, base)) throw new OutsideProjectError(path, "it is outside the project");
  const realBase = await realOrNearest(base) ?? base;
  const real = await realOrNearest(options.entry ? dirname(target) : target);
  if (real === null) throw new OutsideProjectError(path, "a dangling symlink is on its path");
  if (!under(real, realBase)) {
    throw new OutsideProjectError(path, "a symlink on its path leads out of the project");
  }
}

/**
 * {@linkcode assertInsideProject}, then write `text` to `path`.
 *
 * @param root The project directory.
 * @param path The file to write.
 * @param text Its new content.
 * @throws {OutsideProjectError} When the write would leave the project.
 */
export async function writeTextInside(root: string, path: string, text: string): Promise<void> {
  await assertInsideProject(root, path);
  await Deno.writeTextFile(path, text);
}
