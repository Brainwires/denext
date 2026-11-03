// The help text of `denext migration` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../migration.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import type { FlagSpec } from "../../command.ts";
import { MIGRATION_ACTIONS } from "../migration.ts";

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
  {
    name: "yes",
    type: "boolean",
    help: "Confirm without asking: reset / down --force-reset anywhere; up / down / push / " +
      "repair / squash on a remote database",
  },
  { name: "no-seed", type: "boolean", help: "reset: skip the seed" },
  {
    name: "status",
    type: "string",
    valueName: "<applied|reverted>",
    help: "repair: mark the versions applied or reverted",
  },
  { name: "stdin", type: "boolean", help: "new: read the up SQL from stdin" },
  {
    name: "force",
    type: "boolean",
    help: "fetch: overwrite existing files; seed: re-run unchanged seed files",
  },
  ...TARGET_FLAGS,
];

/** `denext migration`. */
export const migrationMeta: CommandMeta = {
  name: "migration",
  summary: "Create, list, apply, roll back and repair SQL migrations (Postgres or SQLite)",
  loadsModules: true,
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
};
