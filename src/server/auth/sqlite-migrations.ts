/**
 * Versioned schema migrations for {@link ./sqlite-adapter.ts | sqliteAuthAdapter}: the changes
 * the additive reconcile cannot make — renaming or dropping a column or a table.
 *
 * Every open runs them **before** the additive reconcile, so a renamed column is renamed before
 * the reconcile would otherwise add its new name empty beside the old one:
 *
 * 1. `auth_schema_migrations` (`version`, `name`, `applied_at`) is created when missing.
 * 2. When every listed version is already recorded, nothing else happens (no lock taken).
 * 3. Otherwise the runner takes SQLite's write lock (`BEGIN IMMEDIATE`, which waits out
 *    `busy_timeout` behind another writer — a second process opening the same file), reads the
 *    recorded versions again **inside** the lock, and applies each one still missing, in
 *    version order, recording it in the same transaction. A failure rolls the whole batch back,
 *    so a database is never left half-migrated, and the next open tries again.
 *
 * A migration is written against whatever shape it finds: the helpers below
 * ({@linkcode renameColumn}, {@linkcode dropColumn}, {@linkcode renameTable},
 * {@linkcode dropTable}) do nothing when the change is already made or the table does not exist
 * (a fresh database, which the reconcile then creates in its current shape). So a migration is
 * recorded as applied on a fresh database too, and running it twice changes nothing.
 *
 * @module
 */

import type { SqliteDb } from "../sqlite-cache.ts";

/** One schema change the additive reconcile can't make: a rename or a drop. */
export interface SqliteSchemaMigration {
  /** Strictly increasing across the list, never reused once released. */
  version: number;
  /** A short description, recorded beside the version. */
  name: string;
  /**
   * Make the change, inside the migration transaction. Use the idempotent helpers, so the
   * migration is a no-op on a database that already has (or never had) the old shape.
   */
  up(db: SqliteDb): void;
}

/** The bookkeeping table: one row per applied migration. */
export const MIGRATIONS_TABLE = "auth_schema_migrations";

/**
 * The adapter's own migrations, oldest first. Empty until a release renames or drops
 * something; append, never edit or reorder a released entry.
 */
export const SQLITE_AUTH_MIGRATIONS: readonly SqliteSchemaMigration[] = [];

/** Versions recorded as newer than this build knows, reported once per database path. */
const reportedUnknown = new Set<string>();

/**
 * Throw when `migrations` is not in strictly increasing version order (a duplicate included).
 *
 * @param migrations The list to check.
 */
function assertMigrationOrder(migrations: readonly SqliteSchemaMigration[]): void {
  let last = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= last) {
      throw new Error(
        `sqliteAuthAdapter: migration "${migration.name}" has version ${migration.version}, ` +
          `not above ${last} — versions are whole numbers in strictly increasing order`,
      );
    }
    last = migration.version;
  }
}

function appliedVersions(db: SqliteDb): Set<number> {
  return new Set(
    db.query<{ version: number }>(`SELECT version FROM ${MIGRATIONS_TABLE}`).map((row) =>
      Number(row.version)
    ),
  );
}

function pendingOf(
  migrations: readonly SqliteSchemaMigration[],
  applied: Set<number>,
): SqliteSchemaMigration[] {
  return migrations.filter((migration) => !applied.has(migration.version));
}

function reportUnknown(
  migrations: readonly SqliteSchemaMigration[],
  applied: Set<number>,
  label: string,
): void {
  const known = new Set(migrations.map((m) => m.version));
  const unknown = [...applied].filter((v) => !known.has(v));
  if (!unknown.length || reportedUnknown.has(label)) return;
  reportedUnknown.add(label);
  console.error(
    `sqliteAuthAdapter: the database records schema migration(s) ${unknown.join(", ")}, which ` +
      "this denext does not know — it was opened by a newer release. Columns that release " +
      "renamed or dropped may be missing here; upgrade denext again rather than running older code.",
  );
}

/**
 * Apply every migration `db` has not recorded yet, under SQLite's write lock (see the module
 * doc). Idempotent: a second run — or a run that lost the race to another process — applies
 * nothing.
 *
 * @param db The open handle (`busy_timeout` already set, so the lock waits for a writer).
 * @param migrations The list, oldest first.
 * @param options `now` (epoch seconds) for `applied_at`, and a `label` naming the database
 *   in the one-time downgrade warning.
 * @returns The versions this call applied.
 */
export function runSchemaMigrations(
  db: SqliteDb,
  migrations: readonly SqliteSchemaMigration[] = SQLITE_AUTH_MIGRATIONS,
  options: { now?: () => number; label?: string } = {},
): number[] {
  assertMigrationOrder(migrations);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} ` +
      "(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const seen = appliedVersions(db);
  reportUnknown(migrations, seen, options.label ?? "");
  if (!pendingOf(migrations, seen).length) return [];
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  db.exec("BEGIN IMMEDIATE");
  try {
    // Read again under the lock: another process may have applied them since the check above.
    const pending = pendingOf(migrations, appliedVersions(db));
    for (const migration of pending) {
      migration.up(db);
      db.exec(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
        [migration.version, migration.name, now()],
      );
    }
    db.exec("COMMIT");
    return pending.map((m) => m.version);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch { /* the failed statement may already have ended the transaction */ }
    throw error;
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`sqliteAuthAdapter: bad identifier ${name}`);
  return name;
}

function tableExists(db: SqliteDb, table: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
    .length > 0;
}

function columnsOf(db: SqliteDb, table: string): Set<string> {
  return new Set(
    db.query<{ name: string }>(`PRAGMA table_info(${ident(table)})`).map((row) => row.name),
  );
}

/**
 * Rename a column — a no-op when the table is missing or already has the new name and not the
 * old one. Both names present is refused (the migration would lose one of them).
 *
 * @param db The handle (inside the migration transaction).
 * @param table The table.
 * @param from The current name.
 * @param to The new name.
 */
export function renameColumn(db: SqliteDb, table: string, from: string, to: string): void {
  if (!tableExists(db, table)) return;
  const columns = columnsOf(db, table);
  if (!columns.has(from)) return;
  if (columns.has(to)) {
    throw new Error(
      `sqliteAuthAdapter: cannot rename ${table}.${from} to ${to}: both columns exist`,
    );
  }
  db.exec(`ALTER TABLE ${ident(table)} RENAME COLUMN ${ident(from)} TO ${ident(to)}`);
}

/**
 * Drop a column — a no-op when the table or the column is missing. An index over the column
 * must be dropped first (`DROP INDEX IF EXISTS …` in the same migration).
 *
 * @param db The handle (inside the migration transaction).
 * @param table The table.
 * @param column The column.
 */
export function dropColumn(db: SqliteDb, table: string, column: string): void {
  if (!tableExists(db, table) || !columnsOf(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${ident(table)} DROP COLUMN ${ident(column)}`);
}

/**
 * Rename a table — a no-op when the old one is missing. Both present is refused.
 *
 * @param db The handle (inside the migration transaction).
 * @param from The current name.
 * @param to The new name.
 */
export function renameTable(db: SqliteDb, from: string, to: string): void {
  if (!tableExists(db, from)) return;
  if (tableExists(db, to)) {
    throw new Error(`sqliteAuthAdapter: cannot rename table ${from} to ${to}: both exist`);
  }
  db.exec(`ALTER TABLE ${ident(from)} RENAME TO ${ident(to)}`);
}

/**
 * Drop a table, if it exists.
 *
 * @param db The handle (inside the migration transaction).
 * @param table The table.
 */
export function dropTable(db: SqliteDb, table: string): void {
  db.exec(`DROP TABLE IF EXISTS ${ident(table)}`);
}
