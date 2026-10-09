// Recovering a package's ESM entry when its `module` field points at a file the tarball does not
// ship. lucide 0.564 is the case in point: `"module": "dist/esm/lucide.js"` is missing, because
// rollup's `preserveModules` wrote the entry one level deeper, at `dist/esm/lucide/src/lucide.js`
// (the common root of the package's and the shared monorepo sources). A bundler that gives up on
// `module` falls back to the CJS `main`, which esbuild cannot tree-shake: every icon of a package
// used for four. The browser resolver tries this search before `main`.

import { basename, dirname, join, normalize, relative } from "@std/path";

/** Subdirectories looked at per level; a package with more is not guessed in. */
const MAX_DIRS = 64;

/** The subdirectory names of `dir` (excluding `node_modules`), or null when `dir` is unreadable. */
async function subdirs(dir: string): Promise<string[] | null> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory && entry.name !== "node_modules") out.push(entry.name);
    }
  } catch {
    return null;
  }
  return out.length > MAX_DIRS ? null : out.sort();
}

/** Whether `path` is a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** The one existing file among `paths`, or null when none or several exist. */
async function onlyExisting(paths: string[]): Promise<string | null> {
  const found: string[] = [];
  for (const p of paths) if (await isFile(p)) found.push(p);
  return found.length === 1 ? found[0] : null;
}

/** `dir/<sub>/rel` for each of `dir`'s subdirectories (none when `dir` is unreadable). */
async function underEachSubdir(dir: string, rel: string): Promise<string[]> {
  return ((await subdirs(dir)) ?? []).map((sub) => join(dir, sub, rel));
}

/**
 * Where a preserved-modules build put the entry a missing `module` field names, as a path
 * relative to the package: the package's `source` file under the `module` directory (directly or
 * one subdirectory down: `dist/esm/<pkg>/src/lucide.js`), else a file with the `module` file's
 * name one or two subdirectories below it. Only an unambiguous match counts: two candidates of the
 * same name yield null (the caller then uses `main`).
 *
 * @param pkgDir The package directory.
 * @param moduleRel The `module` field (package-relative).
 * @param source The `source` field, when the package has one.
 * @returns The ESM entry, package-relative, or null.
 */
export async function preservedModulesEntry(
  pkgDir: string,
  moduleRel: string,
  source?: unknown,
): Promise<string | null> {
  const target = join(pkgDir, normalize(moduleRel));
  if (!/\.m?js$/.test(target) || relative(pkgDir, target).startsWith("..")) return null;
  const dir = dirname(target);
  const name = basename(target);
  if (typeof source === "string" && source.trim() !== "") {
    const src = normalize(source.replace(/^\.\//, ""));
    const hit = await onlyExisting([join(dir, src), ...await underEachSubdir(dir, src)]);
    if (hit) return relative(pkgDir, hit);
  }
  const level1 = (await subdirs(dir)) ?? [];
  const candidates = level1.map((sub) => join(dir, sub, name));
  for (const sub of level1) candidates.push(...await underEachSubdir(join(dir, sub), name));
  const hit = await onlyExisting(candidates);
  return hit ? relative(pkgDir, hit) : null;
}
