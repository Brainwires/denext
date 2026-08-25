// Shared helpers for CLI command modules: project-dir resolution, graceful
// shutdown, the app-dir gate, and the build-step error wrapper. Extracted from the
// old monolithic `cli.ts` so each command module (`src/cli/commands/*.ts`) can pull
// exactly what it needs. Re-exec (which is intrinsic to the CLI entrypoint's own
// module URL) stays in `cli.ts`.

import { resolve } from "@std/path";
import type { CommandContext } from "./command.ts";

/** Termination signals to trap for graceful shutdown (platform-dependent). */
export const SHUTDOWN_SIGNALS: Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK"]
  : ["SIGINT", "SIGTERM"];

/**
 * The project directory a command operates on: `--cwd` wins, else the first
 * positional, else the current directory — resolved to an absolute path.
 */
export function projectDir(ctx: CommandContext): string {
  return resolve(ctx.global.cwd ?? ctx.positionals[0] ?? ".");
}

/**
 * Abort `controller` on the first termination signal (and stop trapping, so the
 * process exits once the server drains). Passing the controller's signal to the
 * server makes Deno.serve stop accepting and wait for in-flight requests.
 */
export function installShutdown(controller: AbortController): void {
  const onSignal = () => {
    controller.abort();
    for (const sig of SHUTDOWN_SIGNALS) {
      try {
        Deno.removeSignalListener(sig, onSignal);
      } catch { /* not installed */ }
    }
  };
  for (const sig of SHUTDOWN_SIGNALS) {
    try {
      Deno.addSignalListener(sig, onSignal);
    } catch { /* signal unsupported on this platform */ }
  }
}

/**
 * Run a build/export step, turning a failure into a clean, `denext:`-prefixed error
 * (printed without a stack by the top-level handler) rather than dumping a raw
 * framework stack trace for what is usually a problem in the user's code. An
 * already-formatted `denext:` error (config load/validation) passes through.
 */
export async function runBuildStep<T>(step: () => Promise<T>, label: string): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("denext:")) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`denext: ${label} failed — ${detail}`, { cause: err });
  }
}

/** Exit with a clear message if `appDir` isn't a directory (no `app/` to serve). */
export async function ensureAppDir(appDir: string): Promise<void> {
  try {
    const info = await Deno.stat(appDir);
    if (!info.isDirectory) throw new Error();
  } catch {
    console.error(
      `denext: no app directory found at ${appDir}\n` +
        `Create an app/ folder with a page.tsx to get started.`,
    );
    Deno.exit(1);
  }
}
