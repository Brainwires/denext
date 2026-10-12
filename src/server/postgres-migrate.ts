/**
 * The Postgres migration runner: applies forward-only SQL migrations in name order, each in
 * its own transaction, recording every one in a table (`_migrations` by default) so it runs
 * once. A transaction-scoped advisory lock serializes runners: two instances deploying at once
 * take turns, and the one that waited sees the other's work and skips it.
 *
 * ```ts
 * import { migratePostgres, postgresClient } from "denext/server";
 * const sql = postgresClient(Deno.env.get("DATABASE_URL"));
 * await migratePostgres(sql, { dir: new URL("../migrations/", import.meta.url) });
 * ```
 *
 * `denext generate migration <name>` writes `migrations/<stamp>_<name>.sql` and a
 * `tasks/migrate.ts` that calls this when `DATABASE_URL` is a `postgres://` URL
 * (`denext task migrate`). denext's own Postgres stores (the auth adapter, the cache store)
 * create their tables through the same runner, each with a tracking table of its own.
 *
 * @module
 */

import { runScript, schemaPrefix, type SqlClient, sqlState } from "./postgres.ts";

/** One migration: a unique, ordered name and its SQL (one or more statements). */
export interface Migration {
  /** The name it is recorded under (a file name, for a directory). Applied in name order. */
  name: string;
  /** The SQL to run, inside the runner's transaction. */
  sql: string;
}

/** Options for {@linkcode migratePostgres} and {@linkcode postgresMigrationStatus}. */
export interface PostgresMigrateOptions {
  /** A directory of `*.sql` files (a path or a `file:` URL), applied in file-name order. */
  dir?: string | URL;
  /** Migrations to apply, instead of (or besides) a directory. */
  migrations?: Migration[];
  /** The tracking table (default `_migrations`). */
  table?: string;
  /** The schema holding the tracking table (created when missing); default: the search path. */
  schema?: string;
  /** List what would run, and run nothing. */
  dryRun?: boolean;
}

/** One migration's state, as {@linkcode postgresMigrationStatus} reports it. */
export interface MigrationState {
  /** The migration's name. */
  name: string;
  /** Whether it has been applied. */
  applied: boolean;
  /** When it was applied. */
  appliedAt?: Date;
  /** Applied, but its SQL has changed since (the checksum differs). It is not re-run. */
  changed?: boolean;
}

/** What {@linkcode postgresMigrationStatus} found. */
export interface MigrationStatus {
  /** Every known migration, in name order. */
  migrations: MigrationState[];
  /** The names still to apply. */
  pending: string[];
  /** Recorded as applied, but no longer among the known migrations. */
  unknown: string[];
}

/** What {@linkcode migratePostgres} did. */
export interface MigrateResult {
  /** The migrations applied by this call (none for a dry run). */
  applied: string[];
  /** The migrations that were pending when it started (what a dry run would apply). */
  pending: string[];
  /** Whether this was a dry run. */
  dryRun: boolean;
}

const DEFAULT_TABLE = "_migrations";

/** SQLSTATEs that mean "the tracking table (or its schema) does not exist yet". */
const MISSING = new Set(["42P01", "3F000"]);

/**
 * A statement of the file's own that ends or starts a transaction. The runner wraps each
 * migration in one, so such a file is refused rather than letting its COMMIT end ours early.
 */
const OWN_TRANSACTION =
  /^\s*(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION|COMMIT(?:\s+(?:WORK|TRANSACTION))?|END(?:\s+(?:WORK|TRANSACTION))?|ROLLBACK(?:\s+(?:WORK|TRANSACTION))?)\s*;/im;

/** SHA-256 hex of a migration's SQL, recorded so a later edit can be reported. */
async function checksum(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `*.sql` files of `dir`, as migrations in name order. */
async function readDir(dir: string | URL): Promise<Migration[]> {
  const base = typeof dir === "string" ? dir.replace(/\/?$/, "/") : dir;
  const names: string[] = [];
  for await (const entry of Deno.readDir(base)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();
  const out: Migration[] = [];
  for (const name of names) {
    const path = typeof base === "string"
      ? `${base}${name}`
      // Encoded: a `#`, `?` or `%` in a file name is part of the name, not URL syntax.
      : new URL(encodeURIComponent(name), base);
    out.push({ name, sql: await Deno.readTextFile(path) });
  }
  return out;
}

/** Every known migration, sorted by name, refusing duplicates. */
async function collect(options: PostgresMigrateOptions): Promise<Migration[]> {
  const all = [...(options.migrations ?? []), ...(options.dir ? await readDir(options.dir) : [])];
  all.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (let i = 1; i < all.length; i++) {
    if (all[i].name === all[i - 1].name) {
      throw new Error(`migratePostgres: two migrations are named ${JSON.stringify(all[i].name)}`);
    }
  }
  return all;
}

/** The qualified tracking table, validated. */
function trackingTable(options: PostgresMigrateOptions): string {
  const table = options.table ?? DEFAULT_TABLE;
  schemaPrefix(table, "migratePostgres"); // the same plain-identifier rule as a schema
  return `${schemaPrefix(options.schema, "migratePostgres")}"${table}"`;
}

/** The recorded rows, or none when the tracking table does not exist yet. */
async function recorded(
  sql: SqlClient,
  table: string,
): Promise<Map<string, { checksum: string; appliedAt: Date }>> {
  try {
    const rows = await sql.unsafe<{ name: string; checksum: string; applied_at: unknown }>(
      `SELECT name, checksum, applied_at FROM ${table}`,
    );
    return new Map(rows.map((row) => [row.name, {
      checksum: row.checksum,
      appliedAt: new Date(row.applied_at as string | number | Date),
    }]));
  } catch (error) {
    if (MISSING.has(sqlState(error) ?? "")) return new Map();
    throw error;
  }
}

/**
 * Which migrations are applied, which are pending, and which applied ones are no longer known.
 * Read-only: it creates nothing, not even the tracking table.
 *
 * @param sql The client.
 * @param options Where the migrations are, and the tracking table.
 * @returns The status.
 */
export async function postgresMigrationStatus(
  sql: SqlClient,
  options: PostgresMigrateOptions = {},
): Promise<MigrationStatus> {
  const known = await collect(options);
  const done = await recorded(sql, trackingTable(options));
  const migrations: MigrationState[] = [];
  for (const migration of known) {
    const row = done.get(migration.name);
    if (!row) {
      migrations.push({ name: migration.name, applied: false });
      continue;
    }
    const changed = row.checksum !== await checksum(migration.sql);
    migrations.push({
      name: migration.name,
      applied: true,
      appliedAt: row.appliedAt,
      ...(changed ? { changed } : {}),
    });
  }
  const names = new Set(known.map((m) => m.name));
  return {
    migrations,
    pending: migrations.filter((m) => !m.applied).map((m) => m.name),
    unknown: [...done.keys()].filter((name) => !names.has(name)).sort(),
  };
}

/**
 * SQLSTATEs the setup statements (`CREATE SCHEMA` / `CREATE TABLE IF NOT EXISTS`) can raise when
 * another runner created the object first: the waiting transaction began before that commit,
 * and an advisory lock does not refresh the catalog cache the way a table lock does. A fresh
 * transaction sees the object, so the attempt is simply retried.
 */
const SETUP_RACE = new Set(["23505", "42P06", "42P07"]);

/** How many fresh transactions a setup race gets before its error is final. */
const SETUP_ATTEMPTS = 3;

/** A setup statement lost a creation race (see {@link SETUP_RACE}). */
class SetupRace extends Error {}

/** Create the schema and the tracking table, inside the locked transaction. */
async function setUp(tx: SqlClient, table: string, schema: string | undefined): Promise<void> {
  try {
    if (schema) await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS ${table} (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, ` +
        "applied_at TIMESTAMPTZ NOT NULL)",
    );
  } catch (error) {
    if (SETUP_RACE.has(sqlState(error) ?? "")) throw new SetupRace("setup race", { cause: error });
    throw error;
  }
}

/**
 * Apply one migration under the advisory lock, unless another runner applied it meanwhile.
 *
 * @returns Whether this call applied it.
 */
async function applyOne(
  sql: SqlClient,
  migration: Migration,
  table: string,
  options: PostgresMigrateOptions,
): Promise<boolean> {
  const sum = await checksum(migration.sql);
  const attempt = () =>
    sql.begin(async (tx) => {
      // Held until this transaction ends: a second runner waits here, then re-reads below.
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`denext:migrate:${table}`]);
      await setUp(tx, table, options.schema);
      const seen = await tx.unsafe(`SELECT 1 AS hit FROM ${table} WHERE name = $1`, [
        migration.name,
      ]);
      if (seen.length) return false;
      try {
        await runScript(tx, migration.sql);
      } catch (error) {
        throw new Error(
          `migration ${migration.name} failed: ${error instanceof Error ? error.message : error}`,
          { cause: error },
        );
      }
      await tx.unsafe(`INSERT INTO ${table} (name, checksum, applied_at) VALUES ($1, $2, $3)`, [
        migration.name,
        sum,
        new Date(),
      ]);
      return true;
    });
  for (let n = 1;; n++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof SetupRace)) throw error;
      if (n >= SETUP_ATTEMPTS) throw error.cause;
    }
  }
}

/**
 * Apply every pending migration, in name order, each in its own transaction under a
 * transaction-scoped advisory lock (so concurrent runners never apply one twice). A failing
 * migration rolls back on its own and stops the run; the ones before it stay applied.
 *
 * A migration that issues its own `BEGIN` / `COMMIT` is refused: it would end the runner's
 * transaction early, so its record and its changes could part ways.
 *
 * @param sql The client.
 * @param options Where the migrations are, the tracking table, and `dryRun`.
 * @returns What was (or, for a dry run, would be) applied.
 */
export async function migratePostgres(
  sql: SqlClient,
  options: PostgresMigrateOptions = {},
): Promise<MigrateResult> {
  const known = await collect(options);
  for (const migration of known) {
    if (OWN_TRANSACTION.test(migration.sql)) {
      throw new Error(
        `migration ${migration.name} manages its own transaction (BEGIN / COMMIT): remove ` +
          "those statements — each migration already runs in a transaction of its own",
      );
    }
  }
  const table = trackingTable(options);
  const done = await recorded(sql, table);
  const pending = known.filter((m) => !done.has(m.name));
  const result: MigrateResult = {
    applied: [],
    pending: pending.map((m) => m.name),
    dryRun: options.dryRun === true,
  };
  if (result.dryRun) return result;
  for (const migration of pending) {
    if (await applyOne(sql, migration, table, options)) result.applied.push(migration.name);
  }
  return result;
}
