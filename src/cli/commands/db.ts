// `denext db <action>` — the Supabase CLI's database verbs. The migration ones run on Postgres or
// SQLite with no plugin; the Postgres tooling (`diff`, `dump`, `pull`, `lint`, `inspect`, `test`,
// `types`) comes from `@denext/backend` (`backend({ postgres })`), which installs it at setup.
//
//   migrate   = `denext migration up`        rollback = `denext migration down`
//   status    = `denext migration list`      push     the backend's migrations, then the app's
//   reset     drop, re-apply, seed (--yes)   seed     supabase/seed.sql + the config's buckets
//   link      store a remote database URL (--url) for --linked

import { resolve } from "@std/path";
import type { CommandSpec } from "../command.ts";
import {
  backendAction,
  downAction,
  linkAction,
  listAction,
  type MigrationRun,
  resetAction,
  seedAction,
  upAction,
} from "../db/migrations.ts";
import { dispatchDb, MIGRATION_FLAGS } from "./migration.ts";

/** The actions `@denext/backend` implements (run through its hooks). */
const BACKEND_DB_ACTIONS = ["diff", "dump", "pull", "lint", "inspect", "test", "types"];

/** Every `denext db` action. */
export const DB_ACTIONS: Record<string, (run: MigrationRun) => Promise<void>> = {
  migrate: (run) => upAction(run),
  rollback: downAction,
  status: listAction,
  push: (run) => upAction(run, { seed: run.ctx.flags["include-seed"] === true }),
  reset: (run) => resetAction(run),
  seed: seedAction,
  link: linkAction,
  ...Object.fromEntries(
    BACKEND_DB_ACTIONS.map((name) => [name, (run: MigrationRun) => backendAction(run, name)]),
  ),
};

export const dbCommand: CommandSpec = {
  name: "db",
  summary: "Migrate, roll back, push, reset, seed, diff, lint, inspect and test the app's database",
  loadsModules: true,
  moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
  usage: [
    "Usage: denext db <action> [flags]",
    "",
    "Postgres or SQLite:",
    "  migrate     Apply the pending migrations (= denext migration up; --to, --include-all)",
    "  rollback    Revert the newest applied migrations (= migration down; --steps, --to,",
    "              --force-reset --yes)",
    "  status      Local and applied migrations (= migration list; --json)",
    "  push        @denext/backend's migrations, then the app's (--dry-run, --include-seed)",
    "  reset       Drop the app's tables, re-apply everything, then seed (--yes; --version, --no-seed)",
    "  seed        Run supabase/seed.sql (or seed.sql), then create the config's buckets",
    "  link        Check a remote Postgres URL and store it in .env for --linked (--url)",
    "",
    "Postgres, through @denext/backend (backend({ postgres })):",
    "  diff        DDL for what the database has that the migrations do not (--schema, --file <name>)",
    "  pull [name] The database's schema as a new migration (like `supabase db pull`)",
    "  dump        pg_dump the database (--data-only, --schema, --file <path>)",
    "  lint        plpgsql_check when installed, plus checks for RLS, search_path and grants",
    "              (--schema, --level warning|error, --fail-on none|warning|error; --json)",
    "  inspect <report>  bloat | blocking | cache-hit | calls | index-usage | locks |",
    "              long-running-queries | outliers | replication-slots | role-connections |",
    "              seq-scans | table-sizes | total-index-size | unused-indexes | vacuum-stats …",
    "  test [files]  Run pgTAP tests (supabase/tests/**/*.sql; needs the pgtap extension)",
    "  types       TypeScript types for the database (--schema, --file <path>; `denext gen types`)",
    "",
    "The database is the project's own, or --db-url <url> / --linked (see `denext db link`).",
  ].join("\n"),
  positionals: [
    { name: "action", help: Object.keys(DB_ACTIONS).join(" | "), required: true },
    { name: "args", help: "inspect: the report; pull: a name; test: files", variadic: true },
  ],
  flags: [
    ...MIGRATION_FLAGS,
    { name: "include-seed", type: "boolean", help: "push: run the seed afterwards" },
    { name: "url", type: "string", valueName: "<url>", help: "link: the remote postgres:// URL" },
    { name: "skip-check", type: "boolean", help: "link: store the URL without connecting" },
    {
      name: "schema",
      type: "string",
      valueName: "<name>",
      repeatable: true,
      help: "diff / pull / dump / lint / types: the schema (repeatable; default public)",
    },
    {
      name: "file",
      type: "string",
      valueName: "<path>",
      help: "diff: a migration name; dump / types: an output file",
    },
    { name: "data-only", type: "boolean", help: "dump: data, not the schema" },
    {
      name: "level",
      type: "string",
      valueName: "<warning|error>",
      help: "lint: the lowest level reported (default warning)",
    },
    {
      name: "fail-on",
      type: "string",
      valueName: "<none|warning|error>",
      help: "lint: exit 1 at this level (default error)",
    },
  ],
  run: (ctx) => dispatchDb("db", ctx, DB_ACTIONS),
};
