// Make `deno` on a child's PATH the Deno denext runs it on — and change nothing else about it.
//
// `deno task` already resolves a `deno` step to its own executable (deno_task_shell runs the
// current exe for `deno …`), but anything a task starts on its own — a shell script, `bash -c`,
// a Node tool, another program that spawns `deno` — looks `deno` up on PATH, and so would run
// whatever Deno the user installed instead of denext's toolchain.
//
// The rule keeps every other lookup (node, python, npm) exactly as the user's PATH has it:
//
//   - the chosen binary is already what PATH resolves `deno` to → no PATH change at all;
//   - it is denext's toolchain binary (alone in its cache directory with its stamp) → that
//     directory goes first, since it holds nothing but `deno`;
//   - anything else (a `DENEXT_DENO=<path>` build of denext's runtime)
//     → a dedicated directory holding only a `deno` link to it goes first: a symlink on Unix, a
//     hard link on Windows (no privilege needed; a copy across volumes). Prepending the binary's
//     own directory would put every other program in it ahead of the user's PATH.

import { basename, dirname, isAbsolute, join, relative } from "@std/path";
import {
  denoToolchainCacheRoot,
  resolveDenoToolchain,
  TOOLCHAIN_ACTIVE_ENV,
} from "../build/deno-toolchain.ts";

/** The executable's file name on this OS. */
function exeName(os: string): string {
  return os === "windows" ? "deno.exe" : "deno";
}

/** A short, stable directory name for one binary path (FNV-1a, hex). */
function slug(path: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Whether `path` already names `target` (the same file, or a link to it). */
async function linksTo(path: string, target: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([Deno.stat(path), Deno.stat(target)]);
    if (a.ino !== null && b.ino !== null) return a.ino === b.ino && a.dev === b.dev;
    return a.size === b.size && a.mtime?.getTime() === b.mtime?.getTime();
  } catch {
    return false;
  }
}

/** Create (or keep) `<dir>/deno` pointing at `deno`. */
async function writeShim(dir: string, deno: string, os: string): Promise<void> {
  const link = join(dir, exeName(os));
  if (await linksTo(link, deno)) return;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.remove(link).catch(() => {});
  if (os !== "windows") return await Deno.symlink(deno, link);
  try {
    await Deno.link(deno, link);
  } catch {
    await Deno.copyFile(deno, link);
  }
}

/** The process seams {@linkcode denoPathEnv} reads (injectable for tests). */
export interface DenoPathOptions {
  /** An environment variable (default `Deno.env.get`). */
  readonly env?: (name: string) => string | undefined;
  /** The OS (default `Deno.build.os`). */
  readonly os?: string;
  /** denext's toolchain cache (default `<DENO_DIR>/denext-deno`). */
  readonly cacheRoot?: string;
  /** Where a `deno` link to any other binary lives (default `<toolchain cache>/path-shims`). */
  readonly shimRoot?: string;
}

/** Where `name` resolves on `path` (the first directory holding it), or null. */
function onPath(path: string, name: string, delimiter: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    try {
      if (Deno.statSync(join(dir, name)).isFile) return join(dir, name);
    } catch { /* not here */ }
  }
  return null;
}

/** Whether two paths name the same file (both resolved through links). */
function sameFile(a: string, b: string): boolean {
  try {
    return Deno.realPathSync(a) === Deno.realPathSync(b);
  } catch {
    return false;
  }
}

/** Whether `dir` lies inside `root`. */
function inside(dir: string, root: string): boolean {
  const rel = relative(root, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The environment to add to a child so `deno` on its PATH is `deno` — the binary denext runs it
 * on — with every other PATH lookup unchanged (see the module header). Empty when `deno` is not
 * an absolute path (a bare `deno` already IS the PATH lookup), when PATH already resolves `deno`
 * to it, or when the link for it cannot be made (the child still runs; only nested `deno`
 * lookups keep the user's PATH).
 *
 * @param deno The Deno binary the child runs on.
 * @param options Process seams.
 * @returns `{ PATH }` with a directory whose `deno` is that binary first, or `{}`.
 */
export async function denoPathEnv(
  deno: string,
  options: DenoPathOptions = {},
): Promise<Record<string, string>> {
  if (!isAbsolute(deno)) return {};
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const os = options.os ?? Deno.build.os;
  const delimiter = os === "windows" ? ";" : ":";
  const current = env("PATH") ?? "";
  const found = onPath(current, exeName(os), delimiter);
  if (found !== null && sameFile(found, deno)) return {};
  const cacheRoot = options.cacheRoot ?? denoToolchainCacheRoot(env);
  let dir = dirname(deno);
  if (basename(deno).toLowerCase() !== exeName(os) || !inside(dir, cacheRoot)) {
    dir = join(options.shimRoot ?? join(cacheRoot, "path-shims"), slug(deno));
    try {
      await writeShim(dir, deno, os);
    } catch {
      return {};
    }
  }
  return { PATH: current === "" ? dir : `${dir}${delimiter}${current}` };
}

/** The Deno a forwarded verb runs on, and the environment its child gets. */
export interface ForwardedDeno {
  /** The binary. */
  readonly deno: string;
  /** `{ PATH }` ({@linkcode denoPathEnv}) plus the toolchain marker when it is the toolchain. */
  readonly env: Record<string, string>;
  /** The automatic switch's one warning, when it has one. */
  readonly warning?: string;
}

/**
 * The Deno a forwarded Deno verb or `deno task` runs on — the automatic switch's choice (denext's
 * toolchain, or the `DENEXT_DENO=<path>` / `DENO_BIN` build of denext's runtime the user named)
 * — with the child environment that
 * makes every nested `deno` that same binary. Shared by the CLI (`denext task`, `denext compile`,
 * …) and `denext ui`'s Tasks page.
 *
 * @returns The binary, its child environment and any warning.
 * @throws {DenoToolchainRequiredError} When the toolchain can't be had (the message names the fix).
 */
export async function forwardedDeno(): Promise<ForwardedDeno> {
  const choice = await resolveDenoToolchain();
  return {
    deno: choice.deno,
    env: { ...await denoPathEnv(choice.deno), [TOOLCHAIN_ACTIVE_ENV]: choice.version },
    ...(choice.warning ? { warning: choice.warning } : {}),
  };
}
