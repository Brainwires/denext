// Make `deno` on a child's PATH the Deno denext runs it on.
//
// `deno task` already resolves a `deno` step to its own executable (deno_task_shell runs the
// current exe for `deno …`), but anything a task starts on its own — a shell script, `bash -c`,
// a Node tool, another program that spawns `deno` — looks `deno` up on PATH, and so would run
// whatever Deno the user installed instead of denext's toolchain. Prepending a directory whose
// `deno` IS the binary denext chose closes that gap for every process below the child.
//
// When the binary is already called `deno` (`deno.exe`) its own directory is prepended — the
// toolchain cache keeps it alone there with its stamp. A binary under another name (a
// `DENEXT_DENO=/opt/deno-2.9.7` override) gets a directory of its own holding a `deno` link to
// it: a symlink on Unix, a hard link on Windows (no privilege needed; a copy when the two sit
// on different volumes).

import { basename, dirname, isAbsolute, join } from "@std/path";
import { denoToolchainCacheRoot } from "../build/deno-toolchain.ts";

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
  /** Where a renamed binary's `deno` link lives (default `<toolchain cache>/path-shims`). */
  readonly shimRoot?: string;
}

/**
 * The environment to add to a child so `deno` on its PATH is `deno` — the binary denext runs
 * it on. Empty when `deno` is not an absolute path (a bare `deno` already IS the PATH lookup)
 * or when the link for a renamed binary cannot be made (the child still runs; only nested
 * `deno` lookups keep the user's PATH).
 *
 * @param deno The Deno binary the child runs on.
 * @param options Process seams.
 * @returns `{ PATH }` with the binary's directory first, or `{}`.
 */
export async function denoPathEnv(
  deno: string,
  options: DenoPathOptions = {},
): Promise<Record<string, string>> {
  if (!isAbsolute(deno)) return {};
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const os = options.os ?? Deno.build.os;
  let dir = dirname(deno);
  if (basename(deno).toLowerCase() !== exeName(os)) {
    const root = options.shimRoot ?? join(denoToolchainCacheRoot(env), "path-shims");
    dir = join(root, slug(deno));
    try {
      await writeShim(dir, deno, os);
    } catch {
      return {};
    }
  }
  const current = env("PATH") ?? "";
  const delimiter = os === "windows" ? ";" : ":";
  return { PATH: current === "" ? dir : `${dir}${delimiter}${current}` };
}
