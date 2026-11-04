// A `deno` child (`deno info`, `deno check`, …) run with its stderr discarded, and once more with
// stderr piped only when it fails, for the error text (src/build/exited-output.ts
// `quietThenExplain`). On Windows a piped stream that stays quiet holds one of a small pool of
// blocking-read threads for the child's whole life; with enough such children alive at once
// (`deno test --parallel`), another child's busy stdout never gets a reader, fills its pipe and
// never exits.

import { quietThenExplain, runToExit } from "../../src/build/exited-output.ts";

/** What {@linkcode quietDeno} reports. */
export interface QuietDenoResult {
  /** The exit code. */
  readonly code: number;
  /** It exited 0. */
  readonly success: boolean;
  /** Its stdout (empty when `stdout: "null"`). */
  readonly stdout: string;
  /** Its stderr: empty unless it failed (then the re-run's). */
  readonly stderr: string;
}

/**
 * Run `Deno.execPath()` with `args` to its exit.
 *
 * @param args The arguments.
 * @param options Working directory, environment, and whether stdout is read (default: piped).
 * @returns The exit code and output.
 */
export async function quietDeno(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; stdout?: "piped" | "null" } = {},
): Promise<QuietDenoResult> {
  const stdout = options.stdout ?? "piped";
  const out = await quietThenExplain((stderr) =>
    runToExit(Deno.execPath(), { args, cwd: options.cwd, env: options.env, stdout, stderr })
  );
  const dec = new TextDecoder();
  return {
    code: out.code,
    success: out.success,
    stdout: stdout === "piped" ? dec.decode(out.stdout) : "",
    stderr: out.success ? "" : dec.decode(out.stderr),
  };
}
