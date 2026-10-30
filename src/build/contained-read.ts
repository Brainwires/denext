// The read grant for a sandboxed child that must see a project directory and nothing outside it.
//
// `--allow-read=<dir>` alone is not that: Deno checks a read against the path as WRITTEN, not
// the symlink's target (https://docs.deno.com/runtime/fundamentals/security/ — "When reading or
// writing through a symbolic link, Deno checks permissions based on the symlink's location, not
// the target it points to"). A project that commits `u -> /Users` or `p -> /proc` therefore
// hands everything behind the link to a child granted only the project. A `--deny-read` for the
// link does not close it either: the deny is matched against the spelled path, so on a
// case-insensitive file system `U/…` reaches the denied `u` without matching it.
//
// So the grant is an ALLOW list that leaves such links out: a directory with no escaping link
// anywhere under it is granted whole, and a directory with one is granted entry by entry, minus
// the link. Any spelling the list doesn't name is refused, so the list fails closed.
//
// A workspace member is contained in its workspace's root, not its own directory: pnpm links an
// app's `node_modules/<pkg>` into the root's `node_modules/.pnpm` store, and a workspace package
// is a link to a sibling member. Links that stay inside the root are followed; links out of it
// are left out as above.
//
// The project directory itself can't be granted while a link under it is left out: a grant of
// a path covers everything under it, the link included. So a config that lists `.` in such a
// project is refused; one in a project with no link out of it is granted the directory whole.

import { dirname, join, relative, resolve, SEPARATOR } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { npmWorkspaceOf, workspaceOf } from "./workspace-imports.ts";

/** {@linkcode containedReadGrants}'s answer: the paths to grant, or why none can be. */
export type ContainedReadGrants =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** A symlink found in the walk, with its fully resolved target (`null`: it resolves nowhere). */
interface FoundLink {
  readonly path: string;
  readonly target: string | null;
}

/** Whether `path` is `root` or lies under it (both canonical). */
function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(SEPARATOR) ? root : root + SEPARATOR);
}

/** The link at `path` with its fully resolved target (`null`: dangling or unresolvable). */
async function resolveLink(path: string): Promise<FoundLink> {
  try {
    return { path, target: await Deno.realPath(path) };
  } catch {
    return { path, target: null };
  }
}

/**
 * Walk `root` without following links. Returns every symlink, and the directories that could
 * not be listed (their contents are unknown, so they are never granted).
 */
async function walk(root: string): Promise<{ links: FoundLink[]; unreadable: string[] }> {
  const links: FoundLink[] = [];
  const unreadable: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    try {
      for await (const entry of Deno.readDir(dir)) {
        const full = join(dir, entry.name);
        if (entry.isSymlink) links.push(await resolveLink(full));
        else if (entry.isDirectory) pending.push(full);
      }
    } catch {
      if (dir === root) throw new Error(`can't list the project directory ${root}`);
      unreadable.push(dir);
    }
  }
  return { links, unreadable };
}

/** `root` and every directory between it and each of `paths` (exclusive of the path itself). */
function ancestors(root: string, paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    let dir = dirname(path);
    while (inside(root, dir) && !out.has(dir)) {
      out.add(dir);
      if (dir === root) break;
      dir = dirname(dir);
    }
  }
  return out;
}

/** Whether `link` resolves outside `root`, or nowhere. */
function leadsOut(root: string, link: FoundLink): boolean {
  return link.target === null || !inside(root, link.target);
}

/** Whether `link` resolves into a directory holding an excluded path, or under an excluded one. */
function reachesExcluded(link: FoundLink, excluded: Set<string>, tainted: Set<string>): boolean {
  const target = link.target;
  if (target === null) return false;
  return tainted.has(target) || [...excluded].some((path) => inside(path, target));
}

/**
 * The paths to leave out: links that resolve outside `root` (or nowhere), unlistable
 * directories, and — to a fixed point — links to a directory that holds any of those, since
 * `a -> b` with `b/u -> /Users` reaches `/Users` as `a/u`. `tainted` is every directory with
 * an excluded path somewhere under it.
 */
function excludedPaths(
  root: string,
  links: readonly FoundLink[],
  unreadable: readonly string[],
): { excluded: Set<string>; tainted: Set<string> } {
  const excluded = new Set<string>(unreadable);
  for (const link of links.filter((l) => leadsOut(root, l))) excluded.add(link.path);
  for (;;) {
    const tainted = ancestors(root, excluded);
    const more = links.filter((l) =>
      !excluded.has(l.path) && reachesExcluded(l, excluded, tainted)
    );
    if (more.length === 0) return { excluded, tainted };
    for (const link of more) excluded.add(link.path);
  }
}

/**
 * A left-out link a `require()` would still read through, or null. Deno loads a CommonJS
 * module or JSON file under `node_modules` with no read-permission check at all, so
 * `require("pkg/config.json")` reads through `node_modules/pkg -> /anywhere` whatever the
 * grant says. Leaving such a link out of the grant is not enough: the evaluation is refused.
 */
function linkOutOfNodeModules(
  root: string,
  links: readonly FoundLink[],
  excluded: Set<string>,
): string | null {
  for (const link of links) {
    if (link.target === null || !excluded.has(link.path)) continue;
    if (relative(root, link.path).split(/[\\/]/).includes("node_modules")) return link.path;
  }
  return null;
}

/** The case- and normalization-folded form a case-insensitive file system compares names in. */
function folded(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** What {@linkcode grantsUnder} walks with: the walk's findings and the list it fills. */
interface GrantWalk {
  readonly root: string;
  /** The child's cwd, which relative grant paths are spelled against. */
  readonly cwd: string;
  readonly excluded: Set<string>;
  readonly tainted: Set<string>;
  readonly out: string[];
}

/** `path` as the child's grant names it: relative to its cwd (shorter), else absolute. */
function spelled(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel === "" ? path : rel;
}

/** `dir`'s entries, sorted by name. */
async function sortedEntries(dir: string): Promise<Deno.DirEntry[]> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dir)) entries.push(entry);
  return entries.sort((a, b) => a.name < b.name ? -1 : 1);
}

/**
 * Grant `dir`: whole when nothing under it is excluded, else entry by entry. Paths are returned
 * relative to the child's cwd to keep the command line short. A name with a comma is
 * left out (Deno reads `--allow-read` as a comma-separated list), which only makes it unreadable.
 * Returns why no safe grant exists, or `null`.
 */
async function grantsUnder(walk: GrantWalk, dir: string): Promise<string | null> {
  const { root, cwd, excluded, tainted, out } = walk;
  if (!tainted.has(dir)) {
    out.push(dir === root ? root : spelled(cwd, dir));
    return null;
  }
  const entries = await sortedEntries(dir);
  const isExcluded = (e: Deno.DirEntry) => excluded.has(join(dir, e.name));
  const left = new Set(entries.filter(isExcluded).map((e) => folded(e.name)));
  for (const entry of entries.filter((e) => !isExcluded(e))) {
    const full = join(dir, entry.name);
    // A grant matched without regard to case would also admit an excluded sibling that
    // differs only in case (two entries a case-sensitive volume can hold side by side).
    if (left.has(folded(entry.name))) {
      return `${full} differs from a link that leaves the project only in letter case`;
    }
    if (entry.name.includes(",")) continue;
    const refused = entry.isDirectory && !entry.isSymlink
      ? await grantsUnder(walk, full)
      : (out.push(spelled(cwd, full)), null);
    if (refused) return refused;
  }
  return null;
}

/**
 * The `--allow-read` paths that let a child read `root` (a canonical directory) and nothing a
 * symlink under it leads to outside it. A root with no such link is granted as `[root]`;
 * otherwise the list names every other entry along the way, relative to `cwd`.
 *
 * @param root The containment root ({@linkcode containmentRoot}), every symlink in its path
 *   resolved (`Deno.realPath`).
 * @param cwd The child's working directory, which relative grants are spelled against.
 * @returns The paths, or the reason no safe grant exists.
 */
export async function containedReadGrants(
  root: string,
  cwd: string = root,
): Promise<ContainedReadGrants> {
  try {
    const { links, unreadable } = await walk(root);
    const { excluded, tainted } = excludedPaths(root, links, unreadable);
    const required = linkOutOfNodeModules(root, links, excluded);
    if (required !== null) {
      return {
        ok: false,
        reason: `${required} is a link in node_modules that leads out of the project, which ` +
          "Deno's require() reads through without a permission check",
      };
    }
    const paths: string[] = [];
    const refused = await grantsUnder({ root, cwd, excluded, tainted, out: paths }, root);
    if (refused) return { ok: false, reason: refused };
    return { ok: true, paths };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** The longest single `--allow-read=` argument (Linux caps one argument at 128 KiB). */
const MAX_FLAG_CHARS = 32_000;

/**
 * `paths` as `--allow-read=` flags, comma-joined and split so no one argument grows past the
 * per-argument limit (Deno accumulates repeated `--allow-read` flags).
 *
 * @param paths Grant paths, none containing a comma.
 * @returns The flags.
 */
export function allowReadFlags(paths: readonly string[]): string[] {
  const flags: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const path of paths) {
    if (current.length > 0 && length + path.length + 1 > MAX_FLAG_CHARS) {
      flags.push(`--allow-read=${current.join(",")}`);
      current = [];
      length = 0;
    }
    current.push(path);
    length += path.length + 1;
  }
  if (current.length > 0) flags.push(`--allow-read=${current.join(",")}`);
  return flags;
}

/** Whether `dir` matches one pnpm `packages` pattern: a path, `parent/*` or `parent/**`. */
function pnpmPatternMatches(root: string, pattern: string, dir: string): boolean {
  const deep = /^(.*?)\/?\*\*$/.exec(pattern);
  if (deep) {
    const base = resolve(root, deep[1]);
    return !deep[1].includes("*") && dir !== base && inside(base, dir);
  }
  const one = /^(.*?)\/?\*$/.exec(pattern);
  if (one) return !one[1].includes("*") && dirname(dir) === resolve(root, one[1]);
  return !pattern.includes("*") && resolve(root, pattern) === dir;
}

/**
 * The pnpm workspace root (`pnpm-workspace.yaml`) that lists `dir` among its `packages`, or
 * null: the nearest such file above `dir` decides, as pnpm's does. A `!pattern` excludes.
 */
async function pnpmWorkspaceRoot(dir: string): Promise<string | null> {
  for (let up = dir;; up = dirname(up)) {
    const text = await Deno.readTextFile(join(up, "pnpm-workspace.yaml")).catch(() => null);
    if (text !== null) {
      let packages: unknown;
      try {
        packages = (parseYaml(text) as { packages?: unknown } | null)?.packages;
      } catch {
        return null;
      }
      const list = Array.isArray(packages)
        ? packages.filter((p): p is string => typeof p === "string")
        : [];
      const matches = (p: string) => pnpmPatternMatches(up, p.replace(/^\.\//, ""), dir);
      const listed = list.filter((p) => !p.startsWith("!")).some(matches) &&
        !list.filter((p) => p.startsWith("!")).some((p) => matches(p.slice(1)));
      return listed ? up : null;
    }
    if (dirname(up) === up) return null;
  }
}

/**
 * The directory a sandboxed read of the project at `dir` is contained in: the root of the
 * workspace `dir` is a member of (a deno.json `workspace`, a package.json `workspaces`, or a
 * `pnpm-workspace.yaml` that lists it), else `dir` itself. Only a workspace that names `dir` as
 * a member counts, so an unrelated file in a folder above it widens nothing.
 *
 * @param dir The project directory, every symlink in its path resolved.
 * @returns The containment root (canonical), `dir` or a directory above it.
 */
export async function containmentRoot(dir: string): Promise<string> {
  const ws = await workspaceOf(dir).catch(() => null) ??
    await npmWorkspaceOf(dir).catch(() => null);
  const root = ws?.root ?? await pnpmWorkspaceRoot(dir);
  if (root === null) return dir;
  const real = await Deno.realPath(root).catch(() => null);
  return real !== null && inside(real, dir) ? real : dir;
}
