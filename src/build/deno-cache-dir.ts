// Deno's cache directory, as a dependency-light module (the CLI's startup path reads it; the
// desktop runtime and the Deno toolchain caches live under it — desktop-runtime.ts re-exports it).

import { join } from "@std/path";

/** Reads one environment variable. */
type EnvGet = (k: string) => string | undefined;

/**
 * `value` when it is an absolute path on `os`, else `undefined`: a relative `HOME` (or an empty
 * one) would put the cache under whatever directory the process runs in.
 */
function absoluteOn(value: string | undefined, os: string): string | undefined {
  if (!value) return undefined;
  return isAbsoluteOn(value, os) ? value : undefined;
}

/**
 * Whether `path` is absolute by `os`'s rules (not the host's): `/…` on POSIX; a drive (`C:\…`),
 * a UNC path or a rooted `\…` on Windows.
 *
 * @param path The path.
 * @param os The OS.
 */
export function isAbsoluteOn(path: string, os: string): boolean {
  if (os !== "windows") return path.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path);
}

/**
 * The user's home directory, from `HOME` or `USERPROFILE` when it is an absolute path.
 *
 * @param env Env reader.
 * @param os The OS.
 * @returns The directory, or `undefined` when neither names one.
 */
export function userHomeDir(
  env: EnvGet = (k) => Deno.env.get(k),
  os: string = Deno.build.os,
): string | undefined {
  return absoluteOn(env("HOME"), os) ?? absoluteOn(env("USERPROFILE"), os);
}

/**
 * Deno's cache directory: `DENO_DIR`, else the platform default Deno itself uses
 * (`~/Library/Caches/deno`, `%LOCALAPPDATA%\deno`, `$XDG_CACHE_HOME/deno` or `~/.cache/deno`).
 * Only absolute paths count: a missing or relative `HOME` / `USERPROFILE` / `LOCALAPPDATA` /
 * `XDG_CACHE_HOME` never makes it the working directory, where a checked-out repository could
 * ship a toolchain binary and a stamp that vouches for it.
 *
 * @param env Env reader.
 * @param os The OS.
 * @returns The directory.
 * @throws {Error} When no `DENO_DIR` is set and no absolute per-user directory can be found.
 */
export function denoCacheDir(
  env: EnvGet = (k) => Deno.env.get(k),
  os: string = Deno.build.os,
): string {
  const explicit = env("DENO_DIR");
  if (explicit) return explicit;
  if (os === "windows") {
    const local = absoluteOn(env("LOCALAPPDATA"), os);
    if (local) return join(local, "deno");
  } else if (os !== "darwin") {
    const xdg = absoluteOn(env("XDG_CACHE_HOME"), os);
    if (xdg) return join(xdg, "deno");
  }
  const home = userHomeDir(env, os);
  if (!home) {
    throw new Error(
      "denext: no cache directory — set DENO_DIR (or HOME" +
        (os === "windows" ? ", USERPROFILE or LOCALAPPDATA" : "") +
        ") to an absolute path. denext never keeps its Deno cache in the working directory.",
    );
  }
  if (os === "darwin") return join(home, "Library", "Caches", "deno");
  if (os === "windows") return join(home, "AppData", "Local", "deno");
  return join(home, ".cache", "deno");
}
