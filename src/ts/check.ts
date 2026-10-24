// The one place denext runs a type check and reads its result (the dev type-check overlay; the
// engine itself is chosen in ./engine.ts). Today it spawns the toolchain's `deno check`, which
// type-checks with the native TypeScript 7 compiler, and parses the text it prints
// (src/build/explain/parse.ts). TypeScript 7.0 has no stable program API; once 7.1's does (a
// long-lived checker answering with structured diagnostics), it slots in behind
// {@linkcode checkTypes} without its callers changing. plans/ts7-integration.md has the swap plan.
//
// Dev/CLI only: nothing here reaches a client bundle.

import { runToExit } from "../build/exited-output.ts";
import { denoExecutable } from "../build/bundle.ts";
import { parseDiagnostics, type SourceDiagnostic } from "../build/explain/parse.ts";

/** What to type-check. */
export interface TypeCheckRequest {
  /** The project directory (the check's working directory). */
  readonly projectDir: string;
  /** The project's config file; passed on when it is inside {@linkcode projectDir}. */
  readonly configPath?: string;
  /** The files to check (their imports are checked with them). */
  readonly files: readonly string[];
  /** Ends the check (a dev server stopping). */
  readonly signal?: AbortSignal;
}

/** What a check found. */
export interface TypeCheckResult {
  /** Whether it type-checked clean. */
  readonly ok: boolean;
  /** The checker's report, as printed (empty when clean). */
  readonly text: string;
  /** The diagnostics in {@linkcode text}. */
  readonly diagnostics: SourceDiagnostic[];
}

/**
 * `deno check --quiet [--config <project config>] <files>` for `request`. No `--` before the
 * files: `deno check -- <files>` ignores them and checks the whole project. A relative path that
 * starts with `-` is written `./-…` instead, so it can't read as a flag.
 *
 * @param request What to check.
 * @returns The arguments.
 */
export function typeCheckArgs(request: Omit<TypeCheckRequest, "signal">): string[] {
  const args = ["check", "--quiet"];
  if (request.configPath && request.configPath.startsWith(request.projectDir)) {
    args.push("--config", request.configPath);
  }
  return [...args, ...request.files.map((f) => f.startsWith("-") ? `./${f}` : f)];
}

/**
 * Type-check `request.files`.
 *
 * @param request What to check.
 * @returns The result, or null when the check could not run or was stopped by the signal (a
 * check never blocks the dev loop; a stopped one would otherwise outlive the server in the
 * project directory, which Windows then cannot remove).
 */
export async function checkTypes(request: TypeCheckRequest): Promise<TypeCheckResult | null> {
  try {
    const { code, stderr } = await runToExit(denoExecutable(), {
      args: typeCheckArgs(request),
      cwd: request.projectDir,
      stdout: "null",
      stderr: "piped",
      signal: request.signal,
    });
    if (request.signal?.aborted) return null;
    if (code === 0) return { ok: true, text: "", diagnostics: [] };
    const text = new TextDecoder().decode(stderr).trim();
    return { ok: false, text, diagnostics: parseDiagnostics(text, request.projectDir) };
  } catch {
    return null;
  }
}
