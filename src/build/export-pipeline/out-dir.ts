// The static export's output dir: where it may live, and the staging swap that replaces it.
//
// Every export (App Router, SPA and Pages Router) writes into a sibling `<out>.staging/` and
// swaps it into place only once complete. A failed export leaves the previous `out/` intact,
// and a successful one leaves exactly the current build's files — no content-hashed chunk,
// `.gz` sibling or deleted route from an earlier build lingers. Because the swap replaces the
// target wholesale, the target is validated first: it must be a dedicated directory strictly
// inside the project that neither holds nor sits inside the project's own sources, config,
// build output or dependencies.
//
// The check compares REAL locations, not spellings: every path is resolved through
// `Deno.realPath` (the deepest existing ancestor, plus the segments that do not exist yet),
// compared case-insensitively where the project's filesystem ignores case (so `.GIT` is
// `.git` on APFS), and, where both sides exist, by `dev`+`ino` as well, so a symlinked
// parent or any other alias of a protected directory is caught however it is spelled.

import { ensureDir } from "@std/fs";
import { basename, dirname, isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import type { ProjectPaths } from "../paths.ts";

/** True when absolute `child` is `parent` or lies beneath it. */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) && !isAbsolute(rel));
}

/** Project paths an export target must not be, contain, or sit inside (absolute). */
function protectedPaths(paths: ProjectPaths, root: string): string[] {
  const spa = paths.config?.mode === "spa" ? paths.config.spa : undefined;
  return [
    paths.appDir,
    paths.publicDir,
    paths.outDir, // `.denext/` build output
    join(root, "node_modules"),
    join(root, ".git"),
    ...(spa?.entry ? [resolve(root, spa.entry)] : []),
  ].map((p) => resolve(p));
}

/** `dev:ino` of the entry at `path` (symlinks followed), or null when it is absent. */
async function fileId(path: string): Promise<string | null> {
  try {
    const { dev, ino } = await Deno.stat(path);
    return ino === null ? null : `${dev}:${ino}`;
  } catch {
    return null;
  }
}

/** The `dev:ino` of `path` (when it exists) and of every existing ancestor. */
async function idChain(path: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let p = path, prev = ""; p !== prev; prev = p, p = dirname(p)) {
    const id = await fileId(p);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The real path of `path`: `Deno.realPath` of its deepest existing ancestor with the segments
 * that do not exist yet re-appended. Null when an existing entry on the way cannot be
 * resolved (a dangling or looping symlink), since the export's writes would then land
 * somewhere this check never saw.
 */
async function realLocation(path: string): Promise<string | null> {
  const missing: string[] = [];
  for (let p = resolve(path);; p = dirname(p)) {
    try {
      return join(await Deno.realPath(p), ...missing);
    } catch {
      const present = await Deno.lstat(p).then(() => true, () => false);
      if (present || dirname(p) === p) return null;
      missing.unshift(basename(p));
    }
  }
}

/** `s` with the case of every letter flipped. */
function flipCase(s: string): string {
  return [...s].map((c) => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()).join("");
}

/**
 * Whether the filesystem holding `realRoot` ignores case: stat the case-flipped spelling and
 * compare it with the real one. Null when that is inconclusive (no letters to flip, no inode
 * numbers, or a stat error other than not-found).
 */
async function probeCaseInsensitive(realRoot: string): Promise<boolean | null> {
  const flipped = flipCase(realRoot);
  const real = await fileId(realRoot);
  if (flipped === realRoot || real === null) return null;
  try {
    const { dev, ino } = await Deno.stat(flipped);
    return `${dev}:${ino}` === real;
  } catch (err) {
    return err instanceof Deno.errors.NotFound ? false : null;
  }
}

/** Case-insensitivity per real project root, probed once. */
const caseInsensitiveRoots = new Map<string, boolean>();

/** Whether paths under `realRoot` compare case-insensitively (platform default if unknown). */
async function isCaseInsensitive(realRoot: string): Promise<boolean> {
  let known = caseInsensitiveRoots.get(realRoot);
  if (known === undefined) {
    known = (await probeCaseInsensitive(realRoot)) ??
      (Deno.build.os === "darwin" || Deno.build.os === "windows");
    caseInsensitiveRoots.set(realRoot, known);
  }
  return known;
}

/** A path's real location, in the forms the guard compares. */
interface Location {
  /** The real path, lower-cased when the filesystem ignores case. */
  key: string;
  /** `dev:ino` of the path itself, when it exists. */
  id: string | null;
  /** `dev:ino` of the path (when it exists) and of each existing ancestor. */
  chain: Set<string>;
}

/** Describe the real path `real` for comparison; `fold` normalizes its spelling. */
async function locate(real: string, fold: (s: string) => string): Promise<Location> {
  return { key: fold(real), id: await fileId(real), chain: await idChain(real) };
}

/** True when `a` and `b` are the same entry. */
function sameEntry(a: Location, b: Location): boolean {
  return a.key === b.key || (a.id !== null && a.id === b.id);
}

/** True when `a` and `b` are the same entry or one lies inside the other. */
function overlaps(a: Location, b: Location): boolean {
  return isWithin(a.key, b.key) || isWithin(b.key, a.key) ||
    (b.id !== null && a.chain.has(b.id)) || (a.id !== null && b.chain.has(a.id));
}

/** Why the target entry itself (before any resolution) may not be replaced, or null. */
async function entryReason(target: string): Promise<string | null> {
  const info = await Deno.lstat(target).catch(() => null);
  if (info?.isSymlink) return "it is a symlink (the swap would act on the link)";
  if (info && !info.isDirectory) return "it exists and is not a directory";
  return null;
}

/** Why `target` may not be replaced by an export, or null when it may. */
async function unsafeReason(target: string, paths: ProjectPaths): Promise<string | null> {
  const entry = await entryReason(target);
  if (entry) return entry;
  const realTarget = await realLocation(target);
  if (realTarget === null) return "a symlink on its path cannot be resolved";
  const lexicalRoot = resolve(paths.projectDir);
  const realRoot = await realLocation(lexicalRoot) ?? lexicalRoot;
  const fold = await isCaseInsensitive(realRoot)
    ? (s: string) => s.normalize("NFC").toLowerCase()
    : (s: string) => s;
  const root = await locate(realRoot, fold);
  const located = await locate(realTarget, fold);
  if (sameEntry(located, root)) return "that is the project root";
  if (!isWithin(located.key, root.key)) return "that is outside the project";
  for (const p of protectedPaths(paths, lexicalRoot)) {
    const hit = await locate(await realLocation(p) ?? p, fold);
    if (overlaps(located, hit)) return `it overlaps the project's ${relative(lexicalRoot, p)}`;
  }
  return null;
}

/**
 * Resolve the export's output directory (`outDir`, relative to the project, default `out`)
 * and refuse one the staging swap must not replace: the project root, a directory outside
 * the project, a symlink or an existing non-directory, or one that is, contains or sits
 * inside `app/`, `public/`, `.denext/`, `node_modules/`, `.git/` or the SPA entry. Locations
 * are compared as the filesystem sees them (symlinks resolved, case folded where the
 * filesystem ignores it, inodes matched), not as spelled.
 *
 * @param paths The resolved project.
 * @param outDir The output dir relative to the project root.
 * @returns The output dir path (`<projectDir>/<outDir>`).
 * @throws When the directory is not safe to replace wholesale.
 */
export async function resolveExportOutDir(
  paths: ProjectPaths,
  outDir = "out",
): Promise<string> {
  const finalOutDir = join(paths.projectDir, outDir);
  const reason = await unsafeReason(resolve(finalOutDir), paths);
  if (reason) {
    throw new Error(
      `denext export: refusing to write the export to ${finalOutDir} — ${reason}. The export ` +
        `replaces its output directory wholesale, so point it at a dedicated directory inside ` +
        `the project (the default is "out").`,
    );
  }
  return finalOutDir;
}

/**
 * Create an empty `<finalOutDir>.staging/` next to the target, clearing any leftover from an
 * interrupted run.
 *
 * @param finalOutDir The directory the staging dir will replace.
 * @returns The staging dir path.
 */
export async function freshStagingDir(finalOutDir: string): Promise<string> {
  const staging = `${finalOutDir}.staging`;
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  await ensureDir(staging);
  return staging;
}

/**
 * Swap a finished staging dir into place: the previous output (if any) is renamed aside,
 * the staging dir takes its name, and the old one is removed.
 *
 * @param stagingDir The complete new output.
 * @param finalOutDir The directory it replaces.
 */
export async function swapStagingDir(stagingDir: string, finalOutDir: string): Promise<void> {
  const previous = `${finalOutDir}.prev`;
  await Deno.remove(previous, { recursive: true }).catch(() => {});
  const had = await Deno.rename(finalOutDir, previous).then(() => true, () => false);
  await Deno.rename(stagingDir, finalOutDir);
  if (had) await Deno.remove(previous, { recursive: true }).catch(() => {});
}

/**
 * Write an output directory through a staging dir: `write` fills a fresh staging dir, which
 * is then swapped into `finalOutDir`. A throw removes the half-written staging dir and leaves
 * the previous output untouched.
 *
 * @param finalOutDir The directory to (re)place.
 * @param write Fills the staging dir it is given.
 */
export async function writeViaStaging(
  finalOutDir: string,
  write: (stagingDir: string) => Promise<void>,
): Promise<void> {
  const staging = await freshStagingDir(finalOutDir);
  try {
    await write(staging);
  } catch (err) {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    throw err;
  }
  await swapStagingDir(staging, finalOutDir);
}
