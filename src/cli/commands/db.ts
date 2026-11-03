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
import { dispatchDb } from "./migration.ts";
import { commandMeta } from "../command-meta.ts";

/** The actions `@denext/backend` implements (run through its hooks). */
const BACKEND_DB_ACTIONS = ["diff", "dump", "pull", "lint", "inspect", "test", "types"];

/** Every `denext db` action. */
export const DB_ACTIONS: Record<string, (run: MigrationRun) => Promise<void>> = {
  migrate: (run) => upAction(run),
  rollback: downAction,
  status: listAction,
  push: (run) => upAction(run, { seed: run.ctx.flags["include-seed"] === true, verb: "push" }),
  reset: (run) => resetAction(run),
  seed: seedAction,
  link: linkAction,
  ...Object.fromEntries(
    BACKEND_DB_ACTIONS.map((name) => [name, (run: MigrationRun) => backendAction(run, name)]),
  ),
};

export const dbCommand: CommandSpec = {
  ...commandMeta("db"),
  moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
  run: (ctx) => dispatchDb("db", ctx, DB_ACTIONS),
};
