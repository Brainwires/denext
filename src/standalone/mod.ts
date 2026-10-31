/**
 * The entry of an app compiled by `denext build --compile`: one executable that serves the app as
 * `denext start` does, runs its jobs and migrates its database, with the built project embedded.
 *
 * `denext build --compile` generates the binary's main module, which calls
 * {@linkcode runStandalone} with the embedded project's root. An app never imports this module
 * itself.
 *
 * ```sh
 * ./my-app                       # serve (= denext start): --port, --host, $PORT
 * ./my-app start --port 8080
 * ./my-app job cleanup --payload '{"days":7}'
 * ./my-app db migrate
 * ```
 *
 * @module
 */

import { fromFileUrl, resolve } from "@std/path";
import { CommandRegistry, type CommandSpec, verbIndex } from "../cli/command.ts";
import { installShutdown } from "../cli/shutdown.ts";
import { jobCommand } from "../cli/commands/job.ts";
import { dbCommand } from "../cli/commands/db.ts";
import { markProduction, portOf, SERVE_FLAGS } from "../cli/commands/start-options.ts";
import { startAppProdServer } from "../build/prod-server/start.ts";
import { loadEnv } from "../server/env.ts";
import { abortJobRuns } from "../server/jobs.ts";
import { setStandaloneState } from "../server/standalone.ts";
import { holdOffBakedIdleTrim } from "../build/idle-trim.ts";
import { bakedLimitsNotice } from "../build/resource-limits.ts";

/** The verbs a compiled app runs (the first is the default). */
const VERBS = ["start", "job", "db"] as const;

/** `start` inside the binary: `denext start`'s flow, on the embedded project. */
function startSpec(projectDir: string): CommandSpec {
  return {
    name: "start",
    summary: "Serve the app (the default; --port, else $PORT, else 3000)",
    flags: SERVE_FLAGS,
    run: async (ctx) => {
      const controller = new AbortController();
      installShutdown(controller);
      // Shutdown aborts every job run's signal, `runJob()` calls that passed none included.
      controller.signal.addEventListener("abort", abortJobRuns, { once: true });
      const port = portOf(ctx);
      await startAppProdServer({
        projectDir,
        port: port ?? 3000,
        hostname: ctx.flags.host as string | undefined,
        strictPort: port !== undefined,
        signal: controller.signal,
        exitAfterShutdown: true, // this process is the server's
      });
    },
  };
}

/** The binary's `--help`. */
function usage(name: string): string {
  return [
    `Usage: ${name} [start] [--port <port>] [--host <host>]`,
    `       ${name} job <name> [--payload '<json>'] | --list [--json]`,
    `       ${name} db <migrate|rollback|status|seed|…> [flags]`,
    "",
    "A denext app compiled with `denext build --compile`. It reads its environment (and the",
    ".env files) from the working directory at run time, and writes its run-time state (the",
    "page cache, the job history) under DENEXT_STATE_DIR, else ./.denext.",
  ].join("\n");
}

/** The program name to print: the executable's file name. */
function programName(): string {
  try {
    return Deno.execPath().split(/[\\/]/).pop() || "app";
  } catch {
    return "app";
  }
}

/**
 * The command line a compiled app dispatches: as given when it names a verb (`start`, `job`,
 * `db`) or asks for help, else `start` with those flags (`./app --port 8080` serves).
 *
 * @param args The binary's arguments.
 * @returns The argv for the verb registry.
 */
export function standaloneArgv(args: readonly string[]): string[] {
  const named = args.some((a) =>
    (VERBS as readonly string[]).includes(a) || a === "--help" || a === "-h" || a === "help"
  );
  return named ? [...args] : ["start", ...args];
}

/**
 * The verb a compiled app's command line runs (`start`, `job`, `db`, or `help` / `undefined` for
 * help), as {@linkcode runStandalone} dispatches it. The generated main module reads it to lift the
 * baked `start.limits` for `job` and `db` (`Deno.disarmResourceLimits()`, which only the main
 * module may call, before its evaluation ends).
 *
 * @param args The binary's arguments.
 * @returns The verb, or `undefined` when none is named (help).
 */
export function standaloneVerb(args: readonly string[]): string | undefined {
  const argv = standaloneArgv(args);
  const at = verbIndex(argv);
  return at < 0 ? undefined : argv[at];
}

/**
 * Record where a compiled app's project is embedded and where it writes, raise the production
 * signal and load the `.env` files of the working directory (production tier).
 */
async function prepareStandalone(projectDir: string): Promise<void> {
  const cwd = Deno.cwd();
  const stateDir = resolve(cwd, envOr("DENEXT_STATE_DIR", ".denext"));
  setStandaloneState({ projectDir, stateDir, dataDir: cwd });
  // A compiled app is a production artifact: every verb runs with the production signal, and
  // reads the production tier of the .env files beside it — never ones embedded in it.
  markProduction();
  await loadEnv({ dir: cwd, mode: envOr("DENEXT_ENV", envOr("NODE_ENV", "production")) });
}

/**
 * Run a compiled app: record where its project is embedded and where it writes, load the `.env`
 * files of the working directory (production tier), then dispatch `start` (the default), `job`
 * or `db` exactly as the `denext` verbs do.
 *
 * @param projectUrl The embedded project's root, as a `file:` URL.
 * @param args The command line (default `Deno.args`).
 * @param options `idleTrimBaked`: the binary was compiled with the idle trim baked in (a
 *   `DENEXT_IDLE_TRIM=0` when it runs then holds the trim off). `limitsBaked`: the `start.limits`
 *   flags baked in, which the runtime enforces on `job` and `db` too (it says so when they run).
 *   `limitsLifted`: the main module lifted them for this run (`Deno.disarmResourceLimits()`,
 *   denext's Deno from 3.0.0-denext.8), so `job` / `db` print no notice.
 */
export async function runStandalone(
  projectUrl: string | URL,
  args: readonly string[] = Deno.args,
  options: { idleTrimBaked?: boolean; limitsBaked?: readonly string[]; limitsLifted?: boolean } =
    {},
): Promise<void> {
  const projectDir = fromFileUrl(projectUrl).replace(/[\\/]$/, "");
  await prepareStandalone(projectDir);
  holdOffBakedIdleTrim(options.idleTrimBaked === true);
  const registry = new CommandRegistry();
  for (const spec of [startSpec(projectDir), jobCommand, dbCommand]) registry.register(spec);
  const outcome = registry.parse(standaloneArgv(args));
  if (outcome.kind === "error") {
    console.error(`${programName()}: ${outcome.message}\n\n${usage(programName())}`);
    Deno.exit(2);
  }
  if (outcome.kind !== "run") return console.log(usage(programName()));
  const notice = options.limitsLifted === true
    ? null
    : bakedLimitsNotice(programName(), outcome.command.name, options.limitsBaked ?? []);
  if (notice) console.error(notice);
  // `job` and `db` find the project through `--cwd`: point it at the embedded one.
  await outcome.command.run({ ...outcome.ctx, global: { ...outcome.ctx.global, cwd: projectDir } });
}

/** `Deno.env.get(name)`, else `fallback` (also when env access is not granted). */
function envOr(name: string, fallback: string): string {
  try {
    return Deno.env.get(name) || fallback;
  } catch {
    return fallback;
  }
}
