// Helper programs denext runs (the OS's `ip` / `route`, the GitHub CLI) by an absolute path from
// a fixed list of install locations, never a program of that name found through PATH or the
// working directory: a planted `ip` or `gh` earlier on PATH does not run. Some of those locations
// (Homebrew's /opt/homebrew/bin, /usr/local/bin) can belong to a user other than root, so a `gh`
// there runs only when no other user can have replaced it ({@link trustedProgram}).

import { dirname } from "@std/path";

/** Whether `path` is a regular file (following a symlink, as Homebrew's and Linuxbrew's are). */
export type IsFile = (path: string) => boolean;

function isFileSync(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function envOf(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Where the OS keeps its own POSIX tools (`ip`, `route`). */
const POSIX_SYSTEM_DIRS = ["/usr/sbin", "/sbin", "/usr/bin", "/bin"];

/** Where the GitHub CLI's installers put `gh` (Homebrew, Linuxbrew, the distro package, snap). */
const POSIX_GH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/home/linuxbrew/.linuxbrew/bin",
  "/snap/bin",
];

/** What {@linkcode trustedProgram} reads of a path (`Deno.statSync`'s fields). */
export interface ProgramStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly uid: number | null;
  readonly gid: number | null;
  readonly mode: number | null;
}

/** The file system {@linkcode trustedProgram} reads (tests stub it). */
export interface ProgramFs {
  /** Stats a path, following symlinks; throws when it does not exist. */
  stat(path: string): ProgramStat;
  /** The path with every symlink resolved. */
  realPath(path: string): string;
  /** This process's user id, or `null` when it can't be read. */
  uid(): number | null;
}

const realProgramFs: ProgramFs = {
  stat: (path) => Deno.statSync(path),
  realPath: (path) => Deno.realPathSync(path),
  uid: () => Deno.uid(),
};

/** Group ids whose members can already become root on macOS (`wheel`, `admin`). */
const MACOS_ROOT_EQUIVALENT_GIDS = new Set([0, 80]);

/** Whether `path` itself (a file or a folder) can be changed only by root or `uid`. */
function ownedSafely(info: ProgramStat, uid: number, os: string): boolean {
  if (info.uid === null || info.mode === null) return false;
  if (info.uid !== 0 && info.uid !== uid) return false;
  // A sticky folder (/tmp) lets a user remove or rename only their own entries.
  const sticky = info.isDirectory && (info.mode & 0o1000) !== 0;
  if ((info.mode & 0o002) !== 0 && !sticky) return false;
  if ((info.mode & 0o020) === 0 || sticky) return true;
  // Group-writable: only by a group whose members can become root anyway (macOS's admin, which
  // Homebrew's folders belong to).
  return os === "darwin" && info.gid !== null && MACOS_ROOT_EQUIVALENT_GIDS.has(info.gid);
}

/** `path` and every folder above it, ending at `/`. */
function selfAndAncestors(path: string): string[] {
  const out = [path];
  for (let dir = dirname(path); dir !== out[out.length - 1]; dir = dirname(dir)) out.push(dir);
  return out;
}

/**
 * Whether the program at `path` can be changed only by root and this user: it is a regular file,
 * and it, the folders above it and the folders above the link that led to it (a Homebrew `gh` is a
 * symlink into its Cellar) are each owned by root or this user and writable by no other user
 * (macOS's admin group excepted; a sticky folder such as /tmp is fine). A program another user
 * could have swapped is not run as this user. POSIX only.
 *
 * @param path An absolute path.
 * @param os The OS (default: this one).
 * @param fs The file system (default: the real one).
 * @returns `true` when it may run.
 */
export function trustedProgram(
  path: string,
  os: string = Deno.build.os,
  fs: ProgramFs = realProgramFs,
): boolean {
  try {
    const uid = fs.uid();
    if (uid === null) return false;
    const real = fs.realPath(path);
    if (!fs.stat(real).isFile) return false;
    const paths = new Set([
      ...selfAndAncestors(real),
      ...selfAndAncestors(fs.realPath(dirname(path))),
    ]);
    for (const p of paths) if (!ownedSafely(fs.stat(p), uid, os)) return false;
    return true;
  } catch {
    return false;
  }
}

/** An absolute Windows directory from an environment variable, else `fallback`. */
function windowsDir(env: (name: string) => string | undefined, name: string, fallback: string) {
  const value = (env(name) ?? "").replace(/[\\/]+$/, "");
  // Only an absolute drive path counts; anything else falls back to the default install.
  return /^[A-Za-z]:\\/.test(value) ? value : fallback;
}

/**
 * The first of `candidates` that is a regular file, or `null`.
 *
 * @param candidates Absolute paths, in order of preference.
 * @param isFile Checks a path (default: `Deno.statSync`).
 * @returns The path to run.
 */
function firstFile(candidates: readonly string[], isFile: IsFile): string | null {
  return candidates.find((path) => isFile(path)) ?? null;
}

/**
 * The OS's own copy of a system tool: `%SystemRoot%\System32\<name>.exe` on Windows, else the
 * first of /usr/sbin, /sbin, /usr/bin and /bin that has it.
 *
 * @param name The tool (`ip`, `route`).
 * @param os The OS (default: this one).
 * @param isFile Checks a path (default: `Deno.statSync`).
 * @param env Reads an environment variable (default: `Deno.env.get`).
 * @returns Its absolute path, or `null` when none of those places has it.
 */
export function systemToolPath(
  name: string,
  os: string = Deno.build.os,
  isFile: IsFile = isFileSync,
  env: (name: string) => string | undefined = envOf,
): string | null {
  if (os === "windows") {
    return firstFile(
      [`${windowsDir(env, "SystemRoot", "C:\\Windows")}\\System32\\${name}.exe`],
      isFile,
    );
  }
  return firstFile(POSIX_SYSTEM_DIRS.map((dir) => `${dir}/${name}`), isFile);
}

/**
 * The GitHub CLI where its installers put it: on Windows `%ProgramFiles%\GitHub CLI\gh.exe` (the
 * MSI and winget, an admin-only folder; never the per-user install under `%LOCALAPPDATA%\Programs`,
 * which any program the user runs can write); elsewhere the first of Homebrew, /usr/local/bin, the
 * distro package, Linuxbrew or snap whose `gh` no other user can have replaced
 * ({@link trustedProgram}).
 *
 * @param os The OS (default: this one).
 * @param isFile Checks a path (default: `Deno.statSync`).
 * @param env Reads an environment variable (default: `Deno.env.get`).
 * @param trusted Whether a POSIX candidate may run (default: {@link trustedProgram}).
 * @returns Its absolute path, or `null` when none of those places has one that may run.
 */
export function ghPath(
  os: string = Deno.build.os,
  isFile: IsFile = isFileSync,
  env: (name: string) => string | undefined = envOf,
  trusted: (path: string) => boolean = (path) => trustedProgram(path, os),
): string | null {
  if (os === "windows") {
    const programFiles = windowsDir(env, "ProgramFiles", "C:\\Program Files");
    return firstFile([`${programFiles}\\GitHub CLI\\gh.exe`], isFile);
  }
  return firstFile(
    POSIX_GH_DIRS.map((dir) => `${dir}/gh`),
    (path) => isFile(path) && trusted(path),
  );
}
