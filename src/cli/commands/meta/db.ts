// The help text of `denext db` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../db.ts. Edit it
// here, then run `deno task gen:command-table` (or `deno task regen`). Not published:
// scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the verb's spec
// reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { DB_ACTIONS } from "../db.ts";
import { MIGRATION_FLAGS } from "./migration.ts";

/** `denext db`. */
export const dbMeta: CommandMeta = {
  name: "db",
  summary: "Migrate, roll back, push, reset, seed, diff, lint, inspect and test the app's database",
  loadsModules: true,
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
};
