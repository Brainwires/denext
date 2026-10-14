/**
 * The SQLite migration runner, on Deno's built-in `node:sqlite`: the same `migrations/*.sql`
 * files {@linkcode migratePostgres} applies, in file-name order, each inside a transaction
 * (one that manages its own — a `BEGIN;` / `COMMIT;` of the file's — runs as written), recorded
 * in a `_migrations (name, applied_at)` table so each runs once.
 *
 * ```ts
 * import { DatabaseSync } from "node:sqlite";
 * import { migrateSqlite } from "denext/server";
 * await migrateSqlite(new DatabaseSync("app.db"), { dir: new URL("../migrations/", import.meta.url) });
 * ```
 *
 * A file's `-- migrate:down` section (or a `<name>.down.sql` beside it) is its down script:
 * `denext migration down` runs it; this runner never does.
 *
 * @module
 */

import { readMigrationFiles } from "./migration-files.ts";
import { sqliteHistory, type SqliteMigrationDb } from "./migration-history.ts";
import { listMigrations, migrateUp, planUp } from "./migration-ops.ts";
import type { MigrateResult, MigrationStatus } from "./postgres-migrate.ts";

export type { SqliteMigrationDb } from "./migration-history.ts";

/** Options for {@linkcode migrateSqlite} and {@linkcode sqliteMigrationStatus}. */
export interface SqliteMigrateOptions {
  /** The directory of `*.sql` files (a path or a `file:` URL). */
  dir: string | URL;
  /** The tracking table (default `_migrations`). */
  table?: string;
  /** List what would run, and run nothing. */
  dryRun?: boolean;
}

/**
 * Apply every pending migration in `dir`, in file-name order.
 *
 * @param db The database (`new DatabaseSync(path)`).
 * @param options The directory, the tracking table and `dryRun`.
 * @returns What was (or, for a dry run, would be) applied.
 */
export async function migrateSqlite(
  db: SqliteMigrationDb,
  options: SqliteMigrateOptions,
): Promise<MigrateResult> {
  const history = sqliteHistory(db, options.table);
  const files = await readMigrationFiles(options.dir);
  const pending = (await planUp(history, files, { includeAll: true })).map((file) => file.name);
  if (options.dryRun) return { applied: [], pending, dryRun: true };
  const applied = await migrateUp(history, files, { includeAll: true });
  return { applied, pending, dryRun: false };
}

/**
 * Which migrations in `dir` are applied, which are pending, and which applied ones have no file.
 *
 * @param db The database.
 * @param options The directory and the tracking table.
 * @returns The status.
 */
export async function sqliteMigrationStatus(
  db: SqliteMigrationDb,
  options: Omit<SqliteMigrateOptions, "dryRun">,
): Promise<MigrationStatus> {
  const rows = await listMigrations(
    sqliteHistory(db, options.table),
    await readMigrationFiles(options.dir),
  );
  const migrations = rows.filter((row) => row.local).map((row) => ({
    name: row.name!,
    applied: row.remote,
    ...(row.appliedAt ? { appliedAt: new Date(row.appliedAt) } : {}),
  }));
  return {
    migrations,
    pending: migrations.filter((m) => !m.applied).map((m) => m.name),
    unknown: rows.filter((row) => !row.local).map((row) => row.name ?? row.version),
  };
}
