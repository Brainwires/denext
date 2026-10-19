// Removing cached toolchain versions: `denext toolchain uninstall <version>`, `uninstall --all` and
// `prune`. Every version denext ever ran on stays in Deno's cache — the Deno toolchain at
// `denext-deno/<version>/` (its esbuild, native TypeScript compiler and denort inside it), the
// Deno Desktop runtime at `denext-desktop-runtime/<version>/`, and beside them the managed Gleam
// (`denext-deno/gleam/<version>/`) and fastlane (`denext-deno/fastlane/<version>/`) — until one of
// these removes it.
//
// {@linkcode planToolchainRemoval} decides from a listing ({@linkcode listToolchainCache}) and the
// versions in use; {@linkcode removeToolchainEntries} deletes under each cache's Cargo-style lock
// (the `mutate` lock: no download or verification of that cache runs meanwhile).

import { join } from "@std/path";
import { acquireCacheLock } from "./project-locks.ts";
import { denoCacheDir } from "./deno-cache-dir.ts";
import { compareDenoVersions } from "./deno-version.ts";

/** What a cached entry is. */
export type ToolchainCacheKind = "deno" | "desktop-runtime" | "gleam" | "fastlane";

/** One cached version of one tool. */
export interface ToolchainCacheEntry {
  readonly kind: ToolchainCacheKind;
  readonly version: string;
  /** The version's directory. */
  readonly path: string;
  /** Its size on disk, in bytes (every file below it, links not followed). */
  readonly bytes: number;
}

/** The cache roots (injectable for tests). */
export interface ToolchainCacheRoots {
  /** `<deno cache>/denext-deno`. */
  readonly deno: string;
  /** `<deno cache>/denext-desktop-runtime`. */
  readonly desktop: string;
}

/**
 * The cache roots under Deno's cache directory (`DENO_DIR`, else the OS default).
 *
 * @param env Env reader.
 * @returns The roots.
 */
export function toolchainCacheRoots(
  env: (name: string) => string | undefined = (k) => Deno.env.get(k),
): ToolchainCacheRoots {
  const cache = denoCacheDir(env);
  return { deno: join(cache, "denext-deno"), desktop: join(cache, "denext-desktop-runtime") };
}

/** A directory name that is a version (`2.9.7-denext.22`, `3.0.0-rc.1`, `1.18.1`). */
const VERSION_DIR = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

/** The size of `path` and everything below it, links not followed; 0 when it is gone. */
export async function diskUsage(path: string): Promise<number> {
  const info = await Deno.lstat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory) return info.size;
  let total = 0;
  try {
    for await (const e of Deno.readDir(path)) total += await diskUsage(join(path, e.name));
  } catch {
    // Unreadable (or removed meanwhile): what was counted.
  }
  return total;
}

/** The version directories directly under `dir`, as entries of `kind`. */
async function versionsIn(dir: string, kind: ToolchainCacheKind): Promise<ToolchainCacheEntry[]> {
  const out: ToolchainCacheEntry[] = [];
  let names: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory && VERSION_DIR.test(e.name)) names.push(e.name);
    }
  } catch {
    return out; // no such cache
  }
  names = names.sort(compareDenoVersions);
  for (const version of names) {
    const path = join(dir, version);
    out.push({ kind, version, path, bytes: await diskUsage(path) });
  }
  return out;
}

/**
 * Every cached version: the Deno toolchain's, the desktop runtime's, Gleam's and fastlane's.
 *
 * @param roots The cache roots.
 * @returns The entries, by kind then version.
 */
export async function listToolchainCache(
  roots: ToolchainCacheRoots,
): Promise<ToolchainCacheEntry[]> {
  return [
    ...await versionsIn(roots.deno, "deno"),
    ...await versionsIn(roots.desktop, "desktop-runtime"),
    ...await versionsIn(join(roots.deno, "gleam"), "gleam"),
    ...await versionsIn(join(roots.deno, "fastlane"), "fastlane"),
  ];
}

/** The versions in use, per kind: what this denext pins, and what the project in cwd pins. */
export interface ToolchainVersionsInUse {
  /** Deno toolchain versions (a desktop runtime of the same version counts as in use too). */
  readonly deno: readonly string[];
  readonly desktopRuntime: readonly string[];
  readonly gleam: readonly string[];
  readonly fastlane: readonly string[];
}

/** What to remove. */
export type ToolchainRemovalRequest =
  | { readonly action: "uninstall"; readonly versions: readonly string[] }
  | { readonly action: "all" }
  | { readonly action: "prune" };

/** What {@linkcode planToolchainRemoval} decided. */
export interface ToolchainRemovalPlan {
  /** Entries to delete. */
  readonly remove: ToolchainCacheEntry[];
  /** Entries left in place because they are in use (refused without `force`). */
  readonly inUse: ToolchainCacheEntry[];
  /** Requested versions with nothing cached (uninstall only). */
  readonly notCached: string[];
  /** The bytes the removal frees. */
  readonly bytes: number;
}

/** Whether `entry` is one of the versions in use. */
function isInUse(entry: ToolchainCacheEntry, inUse: ToolchainVersionsInUse): boolean {
  switch (entry.kind) {
    case "deno":
      return inUse.deno.includes(entry.version);
    case "desktop-runtime":
      return inUse.desktopRuntime.includes(entry.version) || inUse.deno.includes(entry.version);
    case "gleam":
      return inUse.gleam.includes(entry.version);
    case "fastlane":
      return inUse.fastlane.includes(entry.version);
  }
}

/**
 * Decide what a removal deletes. `uninstall <version>` takes the Deno toolchain and the desktop
 * runtime of that version (Gleam and fastlane versions are their own, so a version naming one of
 * those takes it); `all` takes every cached version; `prune` takes every version not in use.
 * A version in use is kept (listed in `inUse`) unless `force`.
 *
 * @param entries The cache listing.
 * @param request What to remove.
 * @param inUse The versions in use.
 * @param force Remove versions in use too.
 * @returns The plan.
 */
export function planToolchainRemoval(
  entries: readonly ToolchainCacheEntry[],
  request: ToolchainRemovalRequest,
  inUse: ToolchainVersionsInUse,
  force = false,
): ToolchainRemovalPlan {
  let selected: ToolchainCacheEntry[];
  const notCached: string[] = [];
  if (request.action === "uninstall") {
    selected = entries.filter((e) => request.versions.includes(e.version));
    for (const v of request.versions) {
      if (!selected.some((e) => e.version === v)) notCached.push(v);
    }
  } else {
    selected = [...entries];
  }
  const remove: ToolchainCacheEntry[] = [];
  const kept: ToolchainCacheEntry[] = [];
  for (const e of selected) {
    if (isInUse(e, inUse) && (request.action === "prune" || !force)) kept.push(e);
    else remove.push(e);
  }
  return {
    remove,
    inUse: kept,
    notCached,
    bytes: remove.reduce((n, e) => n + e.bytes, 0),
  };
}

/** One entry's outcome. */
export interface RemovalOutcome {
  readonly entry: ToolchainCacheEntry;
  /** Why it could not be deleted (a file in use on Windows, a permission), or undefined. */
  readonly error?: string;
}

/**
 * Delete `entries`, each cache's under its `mutate` lock, and then the `path-shims` links that
 * point at a binary no longer there. An entry that can't be deleted is reported, not fatal.
 *
 * @param entries What to delete (from {@linkcode planToolchainRemoval}).
 * @param roots The cache roots (the locks live there).
 * @returns Each entry's outcome.
 */
export async function removeToolchainEntries(
  entries: readonly ToolchainCacheEntry[],
  roots: ToolchainCacheRoots,
): Promise<RemovalOutcome[]> {
  const outcomes: RemovalOutcome[] = [];
  const groups: [string, string, ToolchainCacheEntry[]][] = [
    [roots.deno, "Deno toolchain cache", entries.filter((e) => e.kind !== "desktop-runtime")],
    [roots.desktop, "desktop runtime cache", entries.filter((e) => e.kind === "desktop-runtime")],
  ];
  for (const [root, descr, group] of groups) {
    if (group.length === 0) continue;
    using _lock = await acquireCacheLock(root, "mutate", descr);
    for (const entry of group) outcomes.push(await removeEntry(entry));
    if (root === roots.deno) await removeDanglingShims(join(root, "path-shims"));
  }
  return outcomes;
}

/** Delete one entry; already gone counts as removed. */
async function removeEntry(entry: ToolchainCacheEntry): Promise<RemovalOutcome> {
  try {
    await Deno.remove(entry.path, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      return { entry, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { entry };
}

/** Whether the `deno` link in shim directory `shim` still reaches a binary. */
async function liveShim(shim: string): Promise<boolean> {
  for (const name of ["deno", "deno.exe"]) {
    if (await Deno.stat(join(shim, name)).then(() => true, () => false)) return true;
  }
  return false;
}

/** Remove each `path-shims/<slug>/` whose `deno` link points at nothing any more. */
async function removeDanglingShims(dir: string): Promise<void> {
  try {
    for await (const e of Deno.readDir(dir)) {
      const shim = join(dir, e.name);
      if (!await liveShim(shim)) await Deno.remove(shim, { recursive: true }).catch(() => {});
    }
  } catch {
    // No shims.
  }
}

/**
 * A byte count for people (`1.4 GB`, `350 MB`, `12 KB`).
 *
 * @param bytes The count.
 * @returns The text.
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000;
    u++;
  }
  return u === 0 ? `${n} B` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}
