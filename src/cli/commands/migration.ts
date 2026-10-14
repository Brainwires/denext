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
import type { CommandContext, CommandSpec, FlagSpec } from "../command.ts";
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

/** The flags that pick the database. */
export const TARGET_FLAGS: readonly FlagSpec[] = [
  {
    name: "db-url",
    type: "string",
    valueName: "<url>",
    help: "The database: a postgres:// URL, or a SQLite file (sqlite:<path>, or a .db path)",
  },
  {
    name: "linked",
    type: "boolean",
    help: "The database `denext db link` stored (DENEXT_LINKED_DATABASE_URL)",
  },
  { name: "local", type: "boolean", help: "The project's own database (the default)" },
];

/** The flags of the migration actions, shared by `denext migration` and `denext db`. */
export const MIGRATION_FLAGS: readonly FlagSpec[] = [
  { name: "dry-run", type: "boolean", help: "up / down / push: list what would run" },
  {
    name: "to",
    type: "string",
    valueName: "<version>",
    help: "up: apply up to this version; down: revert everything after it",
  },
  {
    name: "version",
    type: "string",
    valueName: "<version>",
    help: "squash / reset: up to this version (also accepted by up and down)",
  },
  {
    name: "steps",
    altNames: ["last"],
    type: "number",
    valueName: "<n>",
    help: "down: how many applied migrations to revert (default 1)",
  },
  {
    name: "include-all",
    type: "boolean",
    help: "up: also apply pending migrations older than the last applied one",
  },
  {
    name: "force-reset",
    type: "boolean",
    help: "down: reset the database and re-apply up to the target (no down scripts needed)",
  },
  { name: "yes", type: "boolean", help: "reset / down --force-reset: confirm dropping the data" },
  { name: "no-seed", type: "boolean", help: "reset: skip the seed" },
  {
    name: "status",
    type: "string",
    valueName: "<applied|reverted>",
    help: "repair: mark the versions applied or reverted",
  },
  { name: "stdin", type: "boolean", help: "new: read the up SQL from stdin" },
  { name: "force", type: "boolean", help: "fetch: overwrite existing files" },
  ...TARGET_FLAGS,
];

/** The console. */
const consoleDbIo: DbIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** Read stdin whole. */
async function readStdin(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
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
    await action({ ctx, projectDir, io, env: readEnv, stdin: readStdin });
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
  name: "migration",
  summary: "Create, list, apply, roll back and repair SQL migrations (Postgres or SQLite)",
  loadsModules: true,
  moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
  usage: [
    "Usage: denext migration <action> [flags]",
    "",
    "  new <name> [--stdin]          A timestamped file with -- migrate:up / -- migrate:down sections",
    "  list                          Local and applied versions side by side (--json)",
    "  up [--to <v>] [--include-all] Apply the pending migrations (= denext db migrate)",
    "  down [--steps <n> | --to <v>] Run the newest applied migrations' down scripts (= db rollback)",
    "       [--force-reset --yes]    …or reset the database and re-apply up to the target",
    "  repair --status applied|reverted <version…>  Fix the history without running SQL",
    "  squash [--version <v>]        Fold the local migrations into one file (--linked / --db-url",
    "                                also rewrite that database's history)",
    "  fetch [--force]               Write the Supabase history's SQL to supabase/migrations/",
    "",
    "The files are migrations/*.sql (else supabase/migrations/*.sql). The database is the project's",
    "own — @denext/backend's Postgres, DATABASE_URL, else SQLite at DB_PATH (default app.db) — or",
    "--db-url / --linked. A Supabase project keeps its supabase_migrations.schema_migrations history.",
    "`denext migrate` is the framework migrator (Next.js / Vite / Expo / Remix → denext), not this.",
  ].join("\n"),
  positionals: [
    { name: "action", help: Object.keys(MIGRATION_ACTIONS).join(" | "), required: true },
    { name: "args", help: "new: the name; repair: the versions", variadic: true },
  ],
  flags: MIGRATION_FLAGS,
  run: (ctx) => dispatchDb("migration", ctx, MIGRATION_ACTIONS),
};
