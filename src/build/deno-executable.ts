// Which `deno` binary denext spawns. Under `deno run` that is simply `Deno.execPath()` — denext's
// runtime, since every verb re-runs itself on it or hands it over first; inside a `deno compile`d
// denext binary it is not — `Deno.execPath()` is denext itself — and the machine may have no Deno
// installed at all: the binary then runs everything on denext's Deno toolchain, which the CLI
// resolves (downloading it on first need) and hands over through `DENO_BIN` before a verb runs
// (`maybeReexecToolchain` in src/cli/self-exec.ts). denext 5.0 never looks for another Deno (a
// `~/.deno/bin/deno`, a `deno` on PATH): a compiled binary with no `DENO_BIN` refuses with the fix.

/** What {@linkcode resolveDenoExecutable} reads from the process (injectable for tests). */
export interface DenoExecutableSeams {
  /** An environment variable. */
  readonly env: (name: string) => string | undefined;
  /** `Deno.execPath()`. */
  readonly execPath: () => string;
  /** Whether this process is a compiled binary. */
  readonly standalone: boolean;
}

/** The refusal a compiled binary gives when no Deno was handed to it. */
export const NO_DENO_MESSAGE =
  "denext: there is no Deno to run — denext's Deno toolchain is not installed here.\n" +
  "  Run `denext toolchain install` (it downloads denext's Deno, SHA-256-verified), then retry.\n" +
  "  denext 5.0 runs only on denext's own Deno runtime; stock Deno is no longer supported " +
  "(DENEXT_DENO=<path> runs another build of denext's runtime).";

/**
 * The `deno` executable to spawn: `DENO_BIN` (a compiled binary sets it to denext's toolchain;
 * one a user set was verified as denext's runtime when the verb started), else this process's own
 * Deno under `deno run`. A compiled binary without `DENO_BIN` throws {@linkcode NO_DENO_MESSAGE}
 * (a `denext:` error the CLI prints without a stack).
 *
 * @param seams The process seams.
 * @returns The binary.
 */
export function resolveDenoExecutable(seams: DenoExecutableSeams): string {
  const fromEnv = seams.env("DENO_BIN");
  if (fromEnv) return fromEnv;
  if (seams.standalone) throw new Error(NO_DENO_MESSAGE);
  return seams.execPath();
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
    standalone: (Deno.build as { standalone?: boolean }).standalone === true,
  };
}

/**
 * Resolve the `deno` executable to shell out to — {@linkcode resolveDenoExecutable} for this
 * process: `DENO_BIN`, else `Deno.execPath()`. Inside a compiled denext binary (whose
 * `Deno.execPath()` is denext itself) the CLI has already pointed `DENO_BIN` at denext's Deno
 * toolchain; without it this throws a `denext:` error naming the fix.
 *
 * @returns The binary to spawn.
 */
export function denoExecutable(): string {
  return resolveDenoExecutable(processDenoSeams());
}
