// Deno's cache directory, as a dependency-light module (the CLI's startup path reads it; the
// desktop runtime and the Deno toolchain caches live under it — desktop-runtime.ts re-exports it).

import { join } from "@std/path";

/** Reads one environment variable. */
type EnvGet = (k: string) => string | undefined;

/**
 * Deno's cache directory: `DENO_DIR`, else the platform default Deno itself uses
 * (`~/Library/Caches/deno`, `%LOCALAPPDATA%\deno`, `$XDG_CACHE_HOME/deno` or `~/.cache/deno`).
 *
 * @param env Env reader.
 * @param os The OS.
 * @returns The directory.
 */
export function denoCacheDir(
  env: EnvGet = (k) => Deno.env.get(k),
  os: string = Deno.build.os,
): string {
  const explicit = env("DENO_DIR");
  if (explicit) return explicit;
  const home = env("HOME") ?? env("USERPROFILE") ?? ".";
  if (os === "darwin") return join(home, "Library", "Caches", "deno");
  if (os === "windows") return join(env("LOCALAPPDATA") ?? join(home, "AppData", "Local"), "deno");
  return join(env("XDG_CACHE_HOME") ?? join(home, ".cache"), "deno");
}
