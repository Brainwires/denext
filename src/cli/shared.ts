// Shared helpers for CLI command modules: project-dir resolution, graceful
// shutdown, the app-dir gate, and the build-step error wrapper. Extracted from the
// old monolithic `cli.ts` so each command module (`src/cli/commands/*.ts`) can pull
// exactly what it needs. Re-exec (which is intrinsic to the CLI entrypoint's own
// module URL) stays in `cli.ts`.

import { join, resolve } from "@std/path";
import { denoExecutable } from "../build/bundle.ts";
import type { CommandContext } from "./command.ts";
import { explainBuildFailure, explainedToolOutput } from "./explain-output.ts";

/** Termination signals to trap for graceful shutdown (platform-dependent). */
export const SHUTDOWN_SIGNALS: Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK"]
  : ["SIGINT", "SIGTERM"];

/**
 * The `.env` tier the module gate loads for a verb: the process's own mode when the deployer
 * set one (`DENEXT_ENV`, else `NODE_ENV`), else the verb's declared tier, else `undefined` so
 * {@linkcode loadEnv} falls back to its default (`development`).
 *
 * @param command The verb about to run.
 * @param env The process environment (`Deno.env.get`; a read may throw under `--allow-env=X`).
 * @returns The tier, or `undefined` for the default.
 */
export function envTierFor(
  command: { readonly envTier?: "production" },
  env: (key: string) => string | undefined = (key) => Deno.env.get(key),
): string | undefined {
  try {
    return env("DENEXT_ENV") ?? env("NODE_ENV") ?? command.envTier;
  } catch {
    return command.envTier;
  }
}

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

/** Whether this invocation asked for diagnostic output (`--verbose` anywhere in argv). */
function verboseRun(): boolean {
  return Deno.args.includes("--verbose");
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
    // The cause carries the stack this message hides. A failure inside the build machinery
    // (rather than in the user's code) is unreadable without it, so `--verbose` prints it.
    if (err instanceof Error && err.stack && verboseRun()) console.error(err.stack);
    throw new Error(`denext: ${label} failed — ${detail}${explainBuildFailure(detail)}`, {
      cause: err,
    });
  }
}

/**
 * Spawn `deno <args>` in `cwd` (default: the real cwd) inheriting stdio, then exit
 * with the child's status code (`env` is added to the inherited environment). The shared engine
 * behind the verbs that delegate to Deno (`test`/`lint`/`fmt`/`check`, `add`/`remove`/`update`,
 * `denext deno`). `deno` is the binary to run (default {@linkcode denoExecutable}). Never returns.
 */
export async function spawnDenoAndExit(
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
  deno: string = denoExecutable(),
): Promise<never> {
  const child = new Deno.Command(deno, {
    args,
    cwd: cwd ?? Deno.cwd(),
    ...(env ? { env } : {}),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const { code } = await relayingSignals(child);
  Deno.exit(code);
}

/**
 * Like {@linkcode spawnDenoAndExit}, but the child's stderr — where `deno check` and
 * `deno lint` print their diagnostics — is collected and printed explained (each diagnostic
 * with a plain-language why and fix, then its original). stdout and stdin stay inherited.
 * Never returns.
 *
 * @param args The `deno` arguments.
 * @param cwd The working directory (paths in the output are shown relative to it).
 */
export async function spawnDenoExplainedAndExit(args: string[], cwd: string): Promise<never> {
  const child = new Deno.Command(denoExecutable(), {
    args,
    cwd,
    env: { NO_COLOR: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "piped",
  }).spawn();
  const [stderr, { code }] = await Promise.all([
    new Response(child.stderr).text(),
    relayingSignals(child),
  ]);
  if (stderr) console.error(explainedToolOutput(stderr, cwd).replace(/\n$/, ""));
  Deno.exit(code);
}

/** The signals {@linkcode relayingSignals} relays to the child as themselves. */
const RELAYED: readonly Deno.Signal[] = Deno.build.os === "windows" ? [] : ["SIGTERM", "SIGHUP"];

/**
 * The terminal's interrupt keys (Ctrl-C, Ctrl-Break) reach the whole foreground process group —
 * the child included — on their own. The parent only has to survive them, so the child decides
 * what an interrupt means (a REPL clears its line; a server drains).
 */
const TERMINAL: readonly Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK"]
  : ["SIGINT"];

/**
 * Await `child`, passing signals through: a `kill <pid>` (SIGTERM / SIGHUP) sent to this process
 * is relayed to the child as the same signal, and a terminal interrupt is left to the child. The
 * child's status comes back as Deno reports it — on Unix a child killed by a signal has
 * `code` 128 + its number, which is what the caller exits with, as a shell would.
 */
export async function relayingSignals(child: Deno.ChildProcess): Promise<Deno.CommandStatus> {
  const relays = RELAYED.map((sig) =>
    [sig, () => {
      try {
        child.kill(sig);
      } catch { /* already exited */ }
    }] as const
  );
  const swallow = () => {};
  const listen = (on: boolean) => {
    for (const [sig, fn] of [...relays, ...TERMINAL.map((sig) => [sig, swallow] as const)]) {
      try {
        if (on) Deno.addSignalListener(sig, fn);
        else Deno.removeSignalListener(sig, fn);
      } catch { /* unsupported here */ }
    }
  };
  listen(true);
  try {
    return await child.status;
  } finally {
    listen(false);
  }
}

/**
 * The global flags denext parsed that a forwarding verb hands back to Deno, which has them too:
 * `--config <path>` and `--quiet` always, and `--json` for a Deno subcommand that takes it
 * (`lint`, `info`). `--cwd` is applied as the child's directory instead, and `--verbose` is
 * denext's alone.
 *
 * @param ctx The parsed invocation.
 * @param options `json`: whether the Deno subcommand accepts `--json`.
 * @returns The flags, in a stable order.
 */
export function denoGlobalArgs(ctx: CommandContext, options: { json?: boolean } = {}): string[] {
  const args: string[] = [];
  if (ctx.global.config) args.push("--config", ctx.global.config);
  if (ctx.global.quiet) args.push("--quiet");
  if (options.json && ctx.global.json) args.push("--json");
  return args;
}

/** cwd for a verb whose positionals are forwarded args (not a project dir). */
export function commandCwd(ctx: CommandContext): string {
  return ctx.global.cwd ? resolve(ctx.global.cwd) : Deno.cwd();
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
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
 * tree (Pages Router, served by the `@denext/pages-router` plugin) or a TanStack Start tree
 * (`src/routes/__root.tsx`, served by `@denext/tanstack-start`). SPA mode skips this gate at the
 * call site.
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
  if (projectDir && await isFile(join(projectDir, "src", "routes", "__root.tsx"))) {
    return; // TanStack Start app — the tanstack-start plugin handles routing.
  }
  console.error(
    `denext: no app directory found at ${appDir}\n` +
      `Create an app/ folder with a page.tsx (App Router), a pages/ folder ` +
      `(Pages Router) or src/routes/__root.tsx (TanStack Start) to get started.`,
  );
  Deno.exit(1);
}
