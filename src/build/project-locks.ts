// The project's build locks — Cargo's build-dir / artifact-dir split over denext's directories.
//
// | Lock                        | Lock file                          | Rank | Taken by                  |
// | --------------------------- | ---------------------------------- | ---- | ------------------------- |
// | package output (`dist/…`)   | `.denext/.denext-lock-<dir>`       | 0    | desktop package, mobile build |
// | build directory (`.denext`) | `.denext/.denext-lock`             | 1    | build, export, analyze, dev (per rebuild), content build; doctor shared |
// | output directory (`out`, `coverage`) | `.denext/.denext-lock-<dir>` | 2 | export, desktop build/run's export, test --coverage |
// | desktop runtime cache       | `<DENO_DIR>/denext-desktop-runtime/.package-cache-mutate`, `.package-cache` | 3, 4 | the runtime downloader |
//
// Ranks are the acquisition order (see file-lock.ts). Package outputs come FIRST because the
// verbs that write them spawn a `denext export` child that takes the build directory: the parent
// holds rank 0 and the child takes 1 and 2, the same increasing order a single process uses, so no
// two invocations can each hold what the other waits for. A process never holds a lock its own
// child needs.
//
// Every project lock file lives in `.denext/`, which no denext command deletes (builds replace
// subdirectories by rename): a lock file inside `out/` would be swapped away by the export's
// staging rename and shipped with the site. `.denext/` is already git-ignored by every scaffold.
//
// When an output directory IS the build directory, it is locked once (Cargo PR #16385).

import { isAbsolute, join, relative, resolve } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import type { CommandLocks } from "../cli/command.ts";
import { acquireFileLock, type FileLock, lockGroup, type LockMode } from "./file-lock.ts";

/** The acquisition order of every denext lock (lower first). */
export const LOCK_RANK = {
  /** Output dirs of verbs that spawn a `denext export` child (`dist/`, `dist/mobile/`). */
  packageOutput: 0,
  /** The build directory, `.denext/`. */
  buildDir: 1,
  /** Output (artifact) directories: `out/`, `coverage/`. */
  outputDir: 2,
  /** A shared cache's mutate lock (Cargo's `.package-cache-mutate`). */
  cacheMutate: 3,
  /** A shared cache's download lock (Cargo's `.package-cache`). */
  cacheDownload: 4,
} as const;

/** The build directory's lock file name (Cargo's is `.cargo-lock`). */
export const BUILD_DIR_LOCK = ".denext-lock";

/** What a command locks in one project (the CLI's {@linkcode CommandLocks}). */
export type ProjectLockRequest = CommandLocks;

/** The build directory of `projectDir`. */
function buildDirOf(projectDir: string): string {
  return join(resolve(projectDir), ".denext");
}

/** The build directory's lock file. */
export function buildDirLockPath(projectDir: string): string {
  return join(buildDirOf(projectDir), BUILD_DIR_LOCK);
}

/**
 * The lock file for output directory `dir` of `projectDir`: `.denext/.denext-lock-<slug>`, the
 * slug being the project-relative path (`out`, `dist-mobile`), or `ext-<hash>` for a directory
 * outside the project (keyed by its absolute location).
 */
export async function outputLockPath(projectDir: string, dir: string): Promise<string> {
  const root = resolve(projectDir);
  const abs = resolve(root, dir);
  const rel = relative(root, abs);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const slug = inside
    ? rel.replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9._-]/g, "_")
    : `ext-${await shortHash(abs)}`;
  return join(buildDirOf(root), `${BUILD_DIR_LOCK}-${slug}`);
}

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return encodeHex(new Uint8Array(digest)).slice(0, 16);
}

/** How a directory reads in the Blocking line: project-relative when inside the project. */
function displayDir(projectDir: string, dir: string): string {
  const rel = relative(resolve(projectDir), resolve(projectDir, dir));
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? resolve(projectDir, dir) : rel;
}

/** One lock to take, before ordering. */
interface Planned {
  readonly path: string;
  readonly mode: LockMode;
  readonly rank: number;
  readonly description: string;
}

/** Whether `dir` (of `projectDir`) is the build directory itself. */
function isBuildDir(projectDir: string, dir: string): boolean {
  return resolve(projectDir, dir) === buildDirOf(projectDir);
}

async function outputLocks(
  projectDir: string,
  dirs: readonly string[] | undefined,
  rank: number,
): Promise<Planned[]> {
  const planned: Planned[] = [];
  for (const dir of dirs ?? []) {
    if (isBuildDir(projectDir, dir)) continue; // the build-dir lock covers it
    planned.push({
      path: await outputLockPath(projectDir, dir),
      mode: "exclusive",
      rank,
      description: `output directory ${displayDir(projectDir, dir)}`,
    });
  }
  return planned;
}

/**
 * The locks a request takes, in acquisition order: rank, then path (a fixed order inside a
 * rank too), de-duplicated.
 *
 * @param req What to lock.
 * @returns The ordered plan.
 */
export async function planProjectLocks(req: ProjectLockRequest): Promise<Planned[]> {
  const { projectDir } = req;
  // An output dir that IS the build dir upgrades the build-dir lock to exclusive instead.
  const coversBuildDir = [...req.outputDirs ?? [], ...req.packageDirs ?? []]
    .some((d) => isBuildDir(projectDir, d));
  const buildMode: LockMode | undefined = coversBuildDir ? "exclusive" : req.buildDir;
  const planned = [
    ...await outputLocks(projectDir, req.packageDirs, LOCK_RANK.packageOutput),
    ...await outputLocks(projectDir, req.outputDirs, LOCK_RANK.outputDir),
  ];
  if (buildMode) {
    planned.push({
      path: buildDirLockPath(projectDir),
      mode: buildMode,
      rank: LOCK_RANK.buildDir,
      description: `build directory ${displayDir(projectDir, ".denext")}`,
    });
  }
  const seen = new Set<string>();
  return planned
    .sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .filter((p) => !seen.has(p.path) && seen.add(p.path));
}

/**
 * Take every lock `req` names, in the fixed order. Each one tries first and, when another
 * process holds it, prints `Blocking waiting for file lock on …` once and waits.
 *
 * @param req What to lock.
 * @param onBlocking Where the Blocking line goes (default stderr).
 * @returns The held locks, released together.
 */
export async function acquireProjectLocks(
  req: ProjectLockRequest,
  onBlocking?: (line: string) => void,
): Promise<Disposable & { release(): void }> {
  const taken: FileLock[] = [];
  try {
    for (const p of await planProjectLocks(req)) {
      taken.push(await acquireFileLock(p.path, { ...p, onBlocking }));
    }
  } catch (err) {
    lockGroup(taken).release();
    throw err;
  }
  return lockGroup(taken);
}

/**
 * Run `fn` holding `req`'s locks, releasing them when it settles.
 *
 * @param req What to lock.
 * @param fn The work.
 * @returns What `fn` returns.
 */
export async function withProjectLocks<T>(
  req: ProjectLockRequest,
  fn: () => Promise<T>,
): Promise<T> {
  using _locks = await acquireProjectLocks(req);
  return await fn();
}

/**
 * Run `fn` holding the build directory exclusively — one `denext dev` rebuild's codegen (typed
 * modules, plugin prepare steps), the way Cargo locks per rebuild rather than per watch session.
 *
 * @param projectDir The project.
 * @param fn The rebuild work.
 * @returns What `fn` returns.
 */
export function withBuildDirLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return withProjectLocks({ projectDir, buildDir: "exclusive" }, fn);
}

/** Cargo's cache lock modes (`cargo::util::cache_lock::CacheLockMode`). */
export type CacheLockMode =
  /** Read the cache; excludes only {@linkcode CacheLockMode} `"mutate"`. */
  | "shared"
  /** Add new entries; one downloader at a time, readers unaffected (downloads only add files). */
  | "download"
  /** Replace or delete existing entries; excludes everyone. */
  | "mutate";

/** The download lock file in a cache root (Cargo's `.package-cache`). */
export const CACHE_DOWNLOAD_LOCK = ".package-cache";
/** The mutate lock file in a cache root (Cargo's `.package-cache-mutate`). */
export const CACHE_MUTATE_LOCK = ".package-cache-mutate";

/**
 * Lock a shared cache directory the way Cargo locks `$CARGO_HOME`: `shared` takes the mutate
 * file shared, `download` the download file exclusive, `mutate` both exclusive — mutate first,
 * then download (Cargo's order, rank 3 then 4).
 *
 * @param root The cache root (the lock files live in it).
 * @param mode The access wanted.
 * @param description What the Blocking line names (e.g. `desktop runtime cache`).
 * @returns The held lock(s).
 */
export async function acquireCacheLock(
  root: string,
  mode: CacheLockMode,
  description: string,
): Promise<Disposable & { release(): void }> {
  const mutate = (m: LockMode) =>
    acquireFileLock(join(root, CACHE_MUTATE_LOCK), {
      mode: m,
      rank: LOCK_RANK.cacheMutate,
      description,
    });
  const download = () =>
    acquireFileLock(join(root, CACHE_DOWNLOAD_LOCK), {
      mode: "exclusive",
      rank: LOCK_RANK.cacheDownload,
      description,
    });
  if (mode === "shared") return lockGroup([await mutate("shared")]);
  if (mode === "download") return lockGroup([await download()]);
  const first = await mutate("exclusive");
  try {
    return lockGroup([first, await download()]);
  } catch (err) {
    first.release();
    throw err;
  }
}
