// The app's own SQL migrations — `migrations/*.sql`, the directory `denext generate migration`
// writes and `jobs/migrate.ts` applies, tracked in `_migrations` — through denext's runner
// (`migratePostgres` / `postgresMigrationStatus`). Applying hands the runner a guarded client, so
// each migration's transaction carries a statement timeout like every other query here.

import { join } from "@std/path";
import { migratePostgres, postgresMigrationStatus } from "../../server/postgres-migrate.ts";
import type { SqlClient } from "../../server/postgres.ts";
import {
  DB_MIGRATE_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS,
  type DbMigration,
  type DbReplies,
} from "../../ui/database/protocol.ts";
import { guardedClient } from "./connection.ts";
import { assertWritable } from "./tables.ts";

/** The directory, relative to the project. */
const DIR = "migrations";

/** The most SQL a preview carries, per migration. */
const MAX_PREVIEW_CHARS = 64 * 1024;

/** Whether the project has a `migrations/` directory. */
async function hasDir(dir: string): Promise<boolean> {
  try {
    return (await Deno.stat(dir)).isDirectory;
  } catch {
    return false;
  }
}

/** The SQL of each pending migration (cut at {@linkcode MAX_PREVIEW_CHARS}). */
async function pendingSql(dir: string, names: string[]): Promise<{ name: string; sql: string }[]> {
  const out: { name: string; sql: string }[] = [];
  for (const name of names) {
    const sql = await Deno.readTextFile(join(dir, name));
    out.push({
      name,
      sql: sql.length > MAX_PREVIEW_CHARS ? `${sql.slice(0, MAX_PREVIEW_CHARS)}\n-- …cut` : sql,
    });
  }
  return out;
}

/**
 * Each migration's state, and what applying would run.
 *
 * @param sql The client.
 * @param projectDir The project.
 * @returns The status.
 */
export async function migrationStatus(
  sql: SqlClient,
  projectDir: string,
): Promise<DbReplies["migrations"]> {
  const dir = join(projectDir, DIR);
  if (!await hasDir(dir)) return { dir: DIR, migrations: [], unknown: [], pendingSql: [] };
  const status = await postgresMigrationStatus(
    guardedClient(sql, { readOnly: true, timeoutMs: DB_STATEMENT_TIMEOUT_MS }),
    { dir },
  );
  const migrations: DbMigration[] = status.migrations.map((m) => ({
    name: m.name,
    state: !m.applied ? "pending" : m.changed ? "changed" : "applied",
    ...(m.appliedAt ? { appliedAt: m.appliedAt.toISOString() } : {}),
  }));
  return {
    dir: DIR,
    migrations,
    unknown: status.unknown,
    pendingSql: await pendingSql(dir, status.pending),
  };
}

/**
 * Preview or apply every pending migration.
 *
 * @param sql The client.
 * @param projectDir The project.
 * @param confirm Apply (otherwise a dry run).
 * @param readOnly `--read-only`: refused.
 * @returns What was pending, what was applied, and the pending SQL.
 */
export async function migrate(
  sql: SqlClient,
  projectDir: string,
  confirm: boolean,
  readOnly: boolean,
): Promise<DbReplies["migrate"]> {
  assertWritable(readOnly);
  const dir = join(projectDir, DIR);
  if (!await hasDir(dir)) return { pending: [], applied: [], pendingSql: [] };
  const client = guardedClient(sql, { readOnly: false, timeoutMs: DB_MIGRATE_TIMEOUT_MS });
  const result = await migratePostgres(client, { dir, dryRun: !confirm });
  return {
    pending: result.pending,
    applied: result.applied,
    pendingSql: await pendingSql(dir, result.pending),
  };
}
