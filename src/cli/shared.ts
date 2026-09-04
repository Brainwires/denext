// Shared helpers for CLI command modules: project-dir resolution, graceful
// shutdown, the app-dir gate, and the build-step error wrapper. Extracted from the
// old monolithic `cli.ts` so each command module (`src/cli/commands/*.ts`) can pull
// exactly what it needs. Re-exec (which is intrinsic to the CLI entrypoint's own
// module URL) stays in `cli.ts`.

import { join, resolve } from "@std/path";
import { denoExecutable } from "../build/bundle.ts";
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
export async function runBuildStep<T>(
  step: () => Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("denext:")) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`denext: ${label} failed — ${detail}`, { cause: err });
  }
}

/**
 * Spawn `deno <args>` in `cwd` (default: the real cwd) inheriting stdio, then exit
 * with the child's status code. The shared engine behind the verbs that delegate to
 * Deno (`test`/`lint`/`fmt`/`check`, `add`/`remove`/`update`). Never returns.
 */
export async function spawnDenoAndExit(
  args: string[],
  cwd?: string,
): Promise<never> {
  const child = new Deno.Command(denoExecutable(), {
    args,
    cwd: cwd ?? Deno.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const { code } = await child.status;
  Deno.exit(code);
}

/** cwd for a verb whose positionals are forwarded args (not a project dir). */
export function commandCwd(ctx: CommandContext): string {
  return ctx.global.cwd ? resolve(ctx.global.cwd) : Deno.cwd();
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/**
 * Exit with a clear message unless the project has a routable tree: an `app/`
 * directory (App Router) or — when `projectDir` is given — a `pages/` / `src/pages/`
 * tree (Pages Router, served by the `@denext/pages-router` plugin). SPA mode skips
 * this gate at the call site.
 */
export async function ensureAppDir(
  appDir: string,
  projectDir?: string,
): Promise<void> {
  if (await isDir(appDir)) return;
  if (
    projectDir &&
    (await isDir(join(projectDir, "pages")) ||
      await isDir(join(projectDir, "src", "pages")))
  ) {
    return; // Pages Router app — the pages-router plugin handles routing.
  }
  console.error(
    `denext: no app directory found at ${appDir}\n` +
      `Create an app/ folder with a page.tsx (App Router), or a pages/ folder ` +
      `(Pages Router) to get started.`,
  );
  Deno.exit(1);
}
