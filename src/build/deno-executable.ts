// Which `deno` binary denext spawns. Under `deno run` that is simply `Deno.execPath()`; inside a
// `deno compile`d denext binary it is not — `Deno.execPath()` is denext itself — and the machine
// may have no Deno installed at all: the binary then runs everything on denext's Deno toolchain,
// which the CLI resolves (downloading it on first need) and hands over through `DENO_BIN` before a
// verb runs (`maybeReexecToolchain` in src/cli/self-exec.ts). This module only picks from what is
// already on the machine, synchronously, and refuses with the fix when there is nothing to run.

import { basename } from "@std/path";

/** What {@linkcode resolveDenoExecutable} reads from the process (injectable for tests). */
export interface DenoExecutableSeams {
  /** An environment variable. */
  readonly env: (name: string) => string | undefined;
  /** `Deno.execPath()`. */
  readonly execPath: () => string;
  /** The OS (`Deno.build.os`). */
  readonly os: string;
  /** Whether this process is a compiled binary. */
  readonly standalone: boolean;
  /** Whether a regular file exists at `path`. */
  readonly isFile: (path: string) => boolean;
}

/** The refusal a compiled binary gives when the machine has no Deno to run. */
export const NO_DENO_MESSAGE =
  "denext: there is no Deno to run — denext's Deno toolchain is not installed here and no " +
  "`deno` is on PATH.\n" +
  "  Run `denext toolchain install` (it downloads denext's Deno, SHA-256-verified), then retry.\n" +
  "  If that fails (offline, an unsupported host), install Deno from https://deno.com, or point " +
  "DENO_BIN / DENEXT_DENO at a deno binary. (DENEXT_DENO=stock turns the toolchain off.)";

/**
 * `dir` and the names below it, joined with `seams.os`'s separator (never the host's: the seams
 * may describe another OS).
 */
function joinFor(seams: DenoExecutableSeams, dir: string, ...names: string[]): string {
  const sep = seams.os === "windows" ? "\\" : "/";
  return [dir.replace(/[\\/]+$/, ""), ...names].join(sep);
}

/** The first `deno` on `path` (Windows: `deno.exe`), or null. */
function denoOnPath(seams: DenoExecutableSeams): string | null {
  const windows = seams.os === "windows";
  const delimiter = windows ? ";" : ":";
  const path = seams.env("PATH") ?? (windows ? seams.env("Path") : undefined) ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = joinFor(seams, dir, windows ? "deno.exe" : "deno");
    if (seams.isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The `deno` executable to spawn. Resolution order:
 *
 *   1. `DENO_BIN` (an explicit override; a compiled binary sets it to denext's toolchain);
 *   2. `Deno.execPath()` when it is actually `deno` (any `deno run`);
 *   3. the standard install location `~/.deno/bin/deno`;
 *   4. `deno` on PATH.
 *
 * A compiled binary with none of them throws {@linkcode NO_DENO_MESSAGE} (a `denext:` error the CLI
 * prints without a stack) rather than spawning a `deno` that does not exist.
 *
 * @param seams The process seams.
 * @returns The binary, absolute — or the bare `deno` (a PATH lookup) outside a compiled binary.
 */
export function resolveDenoExecutable(seams: DenoExecutableSeams): string {
  const fromEnv = seams.env("DENO_BIN");
  if (fromEnv) return fromEnv;
  const exec = seams.execPath();
  if (basename(exec).toLowerCase().replace(/\.exe$/, "") === "deno") return exec;
  const home = seams.env("HOME") ?? seams.env("USERPROFILE");
  if (home) {
    const candidate = joinFor(
      seams,
      home,
      ".deno",
      "bin",
      seams.os === "windows" ? "deno.exe" : "deno",
    );
    if (seams.isFile(candidate)) return candidate;
  }
  if (!seams.standalone) return "deno";
  const found = denoOnPath(seams);
  if (found !== null) return found;
  throw new Error(NO_DENO_MESSAGE);
}

/** {@linkcode DenoExecutableSeams} for this process. */
function processDenoSeams(): DenoExecutableSeams {
  return {
    env: (name) => {
      try {
        return Deno.env.get(name);
      } catch {
        return undefined; // no env permission
      }
    },
    execPath: () => Deno.execPath(),
    os: Deno.build.os,
    standalone: (Deno.build as { standalone?: boolean }).standalone === true,
    isFile: (path) => {
      try {
        return Deno.statSync(path).isFile;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Resolve the `deno` executable to shell out to — {@linkcode resolveDenoExecutable} for this
 * process: `DENO_BIN`, else `Deno.execPath()` when it is `deno`, else `~/.deno/bin/deno`, else
 * `deno` on PATH. Inside a compiled denext binary (whose `Deno.execPath()` is denext itself) the
 * CLI has already pointed `DENO_BIN` at denext's Deno toolchain; with no Deno at all it throws a
 * `denext:` error naming the fix.
 *
 * @returns The binary to spawn.
 */
export function denoExecutable(): string {
  return resolveDenoExecutable(processDenoSeams());
}
