// `denext migration <action>` — the Supabase CLI's `migration` group, on Postgres and on SQLite
// (node:sqlite), with or without `@denext/backend`:
//
//   new <name> [--stdin]        migrations/<stamp>_<name>.sql with up and down sections
//   list                        local and applied versions side by side (--json)
//   up [--to v] [--include-all] apply the pending migrations (also `denext db migrate`)
//   down [--steps n | --to v]   run the newest applied migrations' down scripts (`db rollback`);
//        [--force-reset --yes]  or reset the database and re-apply up to the target
//   repair --status s <v…>      mark versions applied or reverted without running SQL
//   squash [--version v]        fold local migrations into one file
//   fetch [--force]             write the Supabase history's SQL to supabase/migrations/
//
// `denext migrate` is the framework migrator (Next.js / Vite / Expo / Remix → denext), not this.

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { runPluginTeardown } from "../../plugin/mod.ts";
import {
  downAction,
  fetchAction,
  listAction,
  type MigrationRun,
  newAction,
  repairAction,
  squashAction,
  upAction,
} from "../db/migrations.ts";
import { type DbIo, setUpProject } from "../db/project.ts";
import { readEnv } from "../db/target.ts";
import { commandMeta } from "../command-meta.ts";

/** The console. */
const consoleDbIo: DbIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** Read stdin whole. */
async function readStdin(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
}

/** Ask on the terminal (`[y/N]`). */
function askYesNo(question: string): Promise<boolean> {
  return Promise.resolve(globalThis.confirm(question));
}

/** The actions of `denext migration`. */
export const MIGRATION_ACTIONS: Record<string, (run: MigrationRun) => Promise<void>> = {
  new: newAction,
  list: listAction,
  up: (run) => upAction(run),
  down: downAction,
  repair: repairAction,
  squash: squashAction,
  fetch: fetchAction,
};

/**
 * Set the project up, run one action, report a failure as `denext <verb> <action>: …` and exit
 * (a plugin may leave a pool or a timer behind).
 *
 * @param verb The verb, for messages.
 * @param ctx The invocation.
 * @param action The action.
 * @param io Where to print.
 * @returns The exit code.
 */
async function runDbAction(
  verb: string,
  ctx: CommandContext,
  action: (run: MigrationRun) => Promise<void>,
  io: DbIo = consoleDbIo,
): Promise<number> {
  const projectDir = resolve(ctx.global.cwd ?? ".");
  try {
    await setUpProject(projectDir);
    await action({
      ctx,
      projectDir,
      io,
      env: readEnv,
      stdin: readStdin,
      ...(Deno.stdin.isTerminal() ? { confirm: askYesNo } : {}),
    });
    return 0;
  } catch (error) {
    io.error(`denext ${verb} ${ctx.positionals[0] ?? ""}: ${(error as Error)?.message ?? error}`);
    return 1;
  } finally {
    await runPluginTeardown();
  }
}

/** Dispatch `ctx.positionals[0]` among `actions`, or explain the choices. */
export async function dispatchDb(
  verb: string,
  ctx: CommandContext,
  actions: Record<string, (run: MigrationRun) => Promise<void>>,
): Promise<void> {
  const name = ctx.positionals[0] ?? "";
  const action = actions[name];
  if (!action) {
    console.error(
      `denext ${verb}: ${name ? `unknown action "${name}"` : "no action"} (expected ${
        Object.keys(actions).join(" | ")
      })`,
    );
    Deno.exit(1);
  }
  Deno.exit(await runDbAction(verb, ctx, action));
}

export const migrationCommand: CommandSpec = {
  ...commandMeta("migration"),
  moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
  run: (ctx) => dispatchDb("migration", ctx, MIGRATION_ACTIONS),
};
