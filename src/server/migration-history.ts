// Where a database records which migrations ran, and how one is applied or reverted there. Three
// histories, one interface, so `denext migration up|down|list|repair` and the runners share one
// set of operations (src/server/migration-ops.ts):
//
// - `_migrations (name, checksum, applied_at)` on Postgres — denext's own, the table
//   `migratePostgres` and the generated `jobs/migrate.ts` write. Keyed by file name.
// - `supabase_migrations.schema_migrations (version, name, statements)` on Postgres — the Supabase
//   CLI's, so a Supabase project's history carries over (and back). Keyed by version.
// - `_migrations (name, applied_at)` on SQLite (`node:sqlite`) — what `jobs/migrate.ts` writes.
//
// Every Postgres change runs in one transaction holding the runner's advisory lock; on SQLite
// each runs in a transaction unless the script manages its own (`BEGIN;` … `COMMIT;`).

import { type MigrationFile, versionOf } from "./migration-files.ts";
import {
  applyPostgresMigration,
  assertNoOwnTransaction,
  checksum,
  lockedMigrationTx,
  recorded,
  runMigrationScript,
  setUpTrackingTable,
  trackingTable,
} from "./postgres-migrate.ts";
import { type SqlClient, sqlState } from "./postgres.ts";

/** One row of a history. */
export interface AppliedMigration {
  /** What the history is keyed by: the file name (`_migrations`) or the version (Supabase). */
  key: string;
  /** The migration's version. */
  version: string;
  /** Its name, when the history records one. */
  name?: string;
  /** When it was applied, when the history records it. */
  appliedAt?: Date;
  /** The checksum recorded with it (`_migrations` on Postgres). */
  checksum?: string;
}

/** A migration the Supabase history holds, with the SQL it recorded. */
export interface RecordedStatements {
  /** The version. */
  version: string;
  /** The name part. */
  name: string;
  /** The statements, as recorded. */
  statements: string[];
}

/** A database's migration history. */
export interface MigrationHistory {
  /** `denext` (`_migrations`) or `supabase` (`supabase_migrations.schema_migrations`). */
  readonly format: "denext" | "supabase";
  /** The database. */
  readonly dialect: "postgres" | "sqlite";
  /** The table, for messages. */
  readonly table: string;
  /** The key a migration file is recorded under. */
  keyOf(file: Pick<MigrationFile, "name" | "version">): string;
  /** Every recorded migration. */
  applied(): Promise<AppliedMigration[]>;
  /** Run a migration's up script and record it; false when it was already recorded. */
  apply(file: MigrationFile): Promise<boolean>;
  /** Run a migration's down script and remove its record. */
  revert(file: MigrationFile): Promise<void>;
  /** Record a migration as applied without running it (`repair --status applied`). */
  record(file: MigrationFile): Promise<void>;
  /** Remove a migration's record without running anything (`repair --status reverted`). */
  forget(row: AppliedMigration): Promise<void>;
  /** The SQL each migration recorded (Supabase's history only). */
  statements?(): Promise<RecordedStatements[]>;
}

/** Options for {@linkcode postgresHistory}. */
export interface PostgresHistoryOptions {
  /** The tracking table (default `_migrations`). */
  table?: string;
  /** Its schema (default: the search path). */
  schema?: string;
}

/**
 * denext's `_migrations` history on Postgres.
 *
 * @param sql The client.
 * @param options The tracking table.
 * @returns The history.
 */
export function postgresHistory(
  sql: SqlClient,
  options: PostgresHistoryOptions = {},
): MigrationHistory {
  const table = trackingTable(options);
  const setup = (tx: SqlClient) => setUpTrackingTable(tx, table, options.schema);
  return {
    format: "denext",
    dialect: "postgres",
    table,
    keyOf: (file) => file.name,
    async applied() {
      const rows = await recorded(sql, table);
      return [...rows].map(([name, row]) => ({
        key: name,
        name,
        version: versionOf(name).version,
        appliedAt: row.appliedAt,
        checksum: row.checksum,
      }));
    },
    async apply(file) {
      assertNoOwnTransaction(file.name, file.up);
      return await applyPostgresMigration(
        sql,
        { name: file.name, sql: file.up },
        table,
        options.schema,
      );
    },
    async revert(file) {
      const down = requireDown(file);
      assertNoOwnTransaction(file.name, down);
      await lockedMigrationTx(sql, table, setup, async (tx) => {
        await runMigrationScript(tx, file.name, down, "down");
        await tx.unsafe(`DELETE FROM ${table} WHERE name = $1`, [file.name]);
      });
    },
    async record(file) {
      const sum = await checksum(file.up);
      await lockedMigrationTx(sql, table, setup, async (tx) => {
        await tx.unsafe(
          `INSERT INTO ${table} (name, checksum, applied_at) VALUES ($1, $2, $3) ` +
            "ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum",
          [file.name, sum, new Date()],
        );
      });
    },
    async forget(row) {
      await lockedMigrationTx(sql, table, setup, async (tx) => {
        await tx.unsafe(`DELETE FROM ${table} WHERE name = $1`, [row.key]);
      });
    },
  };
}

/** The Supabase CLI's history table. */
export const SUPABASE_HISTORY = "supabase_migrations.schema_migrations";

/** SQLSTATEs for "the schema or table is not there yet". */
const MISSING = new Set(["42P01", "3F000"]);

/** The Supabase CLI's own DDL for its history (it adds the columns the same way). */
async function setUpSupabase(tx: SqlClient): Promise<void> {
  await tx.unsafe("CREATE SCHEMA IF NOT EXISTS supabase_migrations");
  await tx.unsafe(
    `CREATE TABLE IF NOT EXISTS ${SUPABASE_HISTORY} (version text NOT NULL PRIMARY KEY)`,
  );
  await tx.unsafe(`ALTER TABLE ${SUPABASE_HISTORY} ADD COLUMN IF NOT EXISTS statements text[]`);
  await tx.unsafe(`ALTER TABLE ${SUPABASE_HISTORY} ADD COLUMN IF NOT EXISTS name text`);
}

/** A script as the one statement Supabase's history records for it (trailing `;` dropped). */
function recordedScript(text: string): string {
  return text.trim().replace(/;\s*$/, "");
}

/**
 * The Supabase CLI's history (`supabase_migrations.schema_migrations`) on Postgres, keyed by
 * version: a project migrated with `supabase db push` keeps its history, and `supabase` keeps
 * working after denext has applied migrations.
 *
 * @param sql The client.
 * @returns The history.
 */
export function supabaseHistory(sql: SqlClient): MigrationHistory {
  const lock = SUPABASE_HISTORY;
  const insert = (tx: SqlClient, file: MigrationFile) =>
    tx.unsafe(
      `INSERT INTO ${SUPABASE_HISTORY} (version, name, statements) VALUES ($1, $2, ARRAY[$3]::text[])`,
      [file.version, file.label, recordedScript(file.up)],
    );
  const rows = async () => {
    try {
      return await sql.unsafe<{ version: string; name: string | null; statements: string | null }>(
        `SELECT version, name, array_to_json(statements)::text AS statements FROM ${SUPABASE_HISTORY}`,
      );
    } catch (error) {
      if (MISSING.has(sqlState(error) ?? "")) return [];
      throw error;
    }
  };
  return {
    format: "supabase",
    dialect: "postgres",
    table: SUPABASE_HISTORY,
    keyOf: (file) => file.version,
    async applied() {
      return (await rows()).map((row) => ({
        key: row.version,
        version: row.version,
        ...(row.name ? { name: row.name } : {}),
      }));
    },
    async apply(file) {
      assertNoOwnTransaction(file.name, file.up);
      return await lockedMigrationTx(sql, lock, setUpSupabase, async (tx) => {
        const seen = await tx.unsafe(
          `SELECT 1 AS hit FROM ${SUPABASE_HISTORY} WHERE version = $1`,
          [
            file.version,
          ],
        );
        if (seen.length) return false;
        await runMigrationScript(tx, file.name, file.up);
        await insert(tx, file);
        return true;
      });
    },
    async revert(file) {
      const down = requireDown(file);
      assertNoOwnTransaction(file.name, down);
      await lockedMigrationTx(sql, lock, setUpSupabase, async (tx) => {
        await runMigrationScript(tx, file.name, down, "down");
        await tx.unsafe(`DELETE FROM ${SUPABASE_HISTORY} WHERE version = $1`, [file.version]);
      });
    },
    async record(file) {
      await lockedMigrationTx(sql, lock, setUpSupabase, async (tx) => {
        await tx.unsafe(`DELETE FROM ${SUPABASE_HISTORY} WHERE version = $1`, [file.version]);
        await insert(tx, file);
      });
    },
    async forget(row) {
      await lockedMigrationTx(sql, lock, setUpSupabase, async (tx) => {
        await tx.unsafe(`DELETE FROM ${SUPABASE_HISTORY} WHERE version = $1`, [row.key]);
      });
    },
    async statements() {
      return (await rows()).map((row) => ({
        version: row.version,
        name: row.name ?? "",
        statements: row.statements ? JSON.parse(row.statements) as string[] : [],
      }));
    },
  };
}

/** The parts of `node:sqlite`'s `DatabaseSync` the SQLite history uses. */
export interface SqliteMigrationDb {
  /** Run SQL (one statement or a script). */
  exec(sql: string): void;
  /** Prepare a statement. */
  prepare(sql: string): {
    all(...params: (string | number | null)[]): unknown[];
    run(...params: (string | number | null)[]): unknown;
  };
}

/** A SQLite statement that begins or ends a transaction of the script's own. */
const SQLITE_OWN_TRANSACTION =
  /^\s*(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?|COMMIT(?:\s+TRANSACTION)?|END\s+TRANSACTION)\s*;/im;

/** A plain SQLite table name. */
const SQLITE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Run `script` then `record` in one transaction — or, for a script that manages its own (a
 * `BEGIN;` / `COMMIT;` of its own: SQLite cannot nest one), run it as written, then record.
 */
function sqliteTx(db: SqliteMigrationDb, name: string, script: string, record: () => void): void {
  const own = SQLITE_OWN_TRANSACTION.test(script);
  if (!own) db.exec("BEGIN");
  try {
    db.exec(script);
    record();
    if (!own) db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch { /* the script's own transaction already ended */ }
    throw new Error(`migration ${name} failed: ${(error as Error)?.message ?? error}`, {
      cause: error,
    });
  }
}

/**
 * The `_migrations (name, applied_at)` history on SQLite — the table the generated
 * `jobs/migrate.ts` writes.
 *
 * @param db The database (`new DatabaseSync(path)` from `node:sqlite`).
 * @param table The tracking table (default `_migrations`).
 * @returns The history.
 */
export function sqliteHistory(db: SqliteMigrationDb, table = "_migrations"): MigrationHistory {
  if (!SQLITE_TABLE.test(table)) {
    throw new TypeError(`sqliteHistory: ${JSON.stringify(table)} is not a plain table name`);
  }
  const setup = () =>
    db.exec(
      `CREATE TABLE IF NOT EXISTS "${table}" (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
    );
  const insert = (name: string) =>
    db.prepare(`INSERT OR REPLACE INTO "${table}" (name, applied_at) VALUES (?, ?)`)
      .run(name, new Date().toISOString());
  const remove = (name: string) => db.prepare(`DELETE FROM "${table}" WHERE name = ?`).run(name);
  return {
    format: "denext",
    dialect: "sqlite",
    table,
    keyOf: (file) => file.name,
    async applied() {
      await Promise.resolve();
      setup();
      const rows = db.prepare(`SELECT name, applied_at FROM "${table}"`).all() as {
        name: string;
        applied_at: string;
      }[];
      return rows.map((row) => ({
        key: String(row.name),
        name: String(row.name),
        version: versionOf(String(row.name)).version,
        appliedAt: new Date(row.applied_at),
      }));
    },
    async apply(file) {
      await Promise.resolve();
      setup();
      const seen = db.prepare(`SELECT 1 AS hit FROM "${table}" WHERE name = ?`).all(file.name);
      if (seen.length) return false;
      sqliteTx(db, file.name, file.up, () => insert(file.name));
      return true;
    },
    async revert(file) {
      await Promise.resolve();
      setup();
      sqliteTx(db, `${file.name} (down)`, requireDown(file), () => remove(file.name));
    },
    async record(file) {
      await Promise.resolve();
      setup();
      insert(file.name);
    },
    async forget(row) {
      await Promise.resolve();
      setup();
      remove(row.key);
    },
  };
}

/**
 * A migration's down script.
 *
 * @param file The migration.
 * @returns Its down SQL.
 * @throws {Error} When it has none.
 */
function requireDown(file: MigrationFile): string {
  if (file.down === undefined) throw new NoDownScriptError([file.name]);
  return file.down;
}

/** One or more migrations to roll back have no down script. */
export class NoDownScriptError extends Error {
  /**
   * Build the error.
   *
   * @param names The migrations without one.
   */
  constructor(readonly names: string[]) {
    super(
      `no down script for ${names.join(", ")}: add a "-- migrate:down" section (or a ` +
        "<name>.down.sql file), or reset and re-apply up to the target instead (--force-reset)",
    );
    this.name = "NoDownScriptError";
  }
}
