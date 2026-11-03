// Helper programs denext runs (the OS's `ip` / `route`, the GitHub CLI) by an absolute path from
// a fixed list of install locations, never a program of that name found through PATH or the
// working directory: a planted `ip` or `gh` earlier on PATH does not run.

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
 * which any program the user runs can write); elsewhere Homebrew, /usr/local/bin, the distro
 * package, Linuxbrew or snap.
 *
 * @param os The OS (default: this one).
 * @param isFile Checks a path (default: `Deno.statSync`).
 * @param env Reads an environment variable (default: `Deno.env.get`).
 * @returns Its absolute path, or `null` when it is in none of those places.
 */
export function ghPath(
  os: string = Deno.build.os,
  isFile: IsFile = isFileSync,
  env: (name: string) => string | undefined = envOf,
): string | null {
  if (os === "windows") {
    const programFiles = windowsDir(env, "ProgramFiles", "C:\\Program Files");
    return firstFile([`${programFiles}\\GitHub CLI\\gh.exe`], isFile);
  }
  return firstFile(POSIX_GH_DIRS.map((dir) => `${dir}/gh`), isFile);
}
