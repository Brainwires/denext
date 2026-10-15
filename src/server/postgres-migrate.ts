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
 * `jobs/migrate.ts` that calls this when `DATABASE_URL` is a `postgres://` URL
 * (`denext job migrate`). denext's own Postgres stores (the auth adapter, the cache store)
 * create their tables through the same runner, each with a tracking table of its own.
 *
 * @module
 */

import { readMigrationFiles } from "./migration-files.ts";
import { runScript, schemaPrefix, type SqlClient, sqlState } from "./postgres.ts";

/** One migration: a unique, ordered name and its SQL (one or more statements). */
export interface Migration {
  /** The name it is recorded under (a file name, for a directory). Applied in name order. */
  name: string;
  /** The SQL to run, inside the runner's transaction. */
  sql: string;
  /**
   * The SQL that reverts it (a file's `-- migrate:down` section, or its `.down.sql`
   * companion): what `denext migration down` runs. Never run by {@linkcode migratePostgres}.
   */
  down?: string;
}

/** Options for {@linkcode migratePostgres} and {@linkcode postgresMigrationStatus}. */
export interface PostgresMigrateOptions {
  /**
   * A directory of `*.sql` files (a path or a `file:` URL), applied in file-name order. A file's
   * `-- migrate:down` section and a `<name>.down.sql` companion are its down script, not run here.
   */
  dir?: string | URL;
  /** Migrations to apply, instead of (or besides) a directory. */
  migrations?: Migration[];
  /** The tracking table (default `_migrations`). */
  table?: string;
  /** The schema holding the tracking table (created when missing); default: the search path. */
  schema?: string;
  /** List what would run, and run nothing. */
  dryRun?: boolean;
  /**
   * Silence the server's `NOTICE`s (`relation … already exists, skipping`) inside the runner's
   * transactions; a driver may print each one (postgres.js does by default). Default `false`.
   */
  quiet?: boolean;
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
export async function checksum(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `*.sql` files of `dir`, as migrations in name order (up scripts; down kept aside). */
async function readDir(dir: string | URL): Promise<Migration[]> {
  return (await readMigrationFiles(dir)).map((file) => ({
    name: file.name,
    sql: file.up,
    ...(file.down !== undefined ? { down: file.down } : {}),
  }));
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
export function trackingTable(options: PostgresMigrateOptions): string {
  const table = options.table ?? DEFAULT_TABLE;
  schemaPrefix(table, "migratePostgres"); // the same plain-identifier rule as a schema
  return `${schemaPrefix(options.schema, "migratePostgres")}"${table}"`;
}

/** The recorded rows, or none when the tracking table does not exist yet. */
export async function recorded(
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

/**
 * Run setup DDL (`CREATE SCHEMA` / `CREATE TABLE IF NOT EXISTS` …), turning a lost creation race
 * into {@linkcode SetupRace} so the whole transaction is retried.
 */
async function guardSetup(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (SETUP_RACE.has(sqlState(error) ?? "")) throw new SetupRace("setup race", { cause: error });
    throw error;
  }
}

/** Raise the transaction's `client_min_messages` past `NOTICE` (it ends with the transaction). */
export const QUIET_SQL = "SELECT set_config('client_min_messages', 'warning', true)";

/**
 * Take the runner's transaction-scoped advisory lock for `lock` (released when `tx` ends),
 * after silencing the transaction's notices when `quiet`.
 */
async function takeMigrationLock(tx: SqlClient, lock: string, quiet = false): Promise<void> {
  if (quiet) await tx.unsafe(QUIET_SQL);
  await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`denext:migrate:${lock}`]);
}

/** Options for {@linkcode withMigrationLock}: which runner's lock to take. */
export interface MigrationLockOptions {
  /** The tracking table whose runner's lock is taken (default `_migrations`). */
  table?: string;
  /** The tracking table's schema; default: the search path. */
  schema?: string;
  /** Silence the server's `NOTICE`s inside the transaction. Default `false`. */
  quiet?: boolean;
}

/**
 * Run `fn` in a transaction holding the same advisory lock {@linkcode migratePostgres} takes
 * for the tracking table `options` names, so DDL that is not a recorded migration (a trigger
 * created at startup, say) never races a migration run, or another instance doing the same.
 * The lock is held until the transaction ends.
 *
 * @param sql The client.
 * @param options The tracking table (and its schema) whose runner's lock to take.
 * @param fn The work, on the transaction's client.
 * @returns What `fn` returned.
 */
export async function withMigrationLock<T>(
  sql: SqlClient,
  options: MigrationLockOptions,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  const lock = trackingTable(options);
  return await sql.begin(async (tx) => {
    await takeMigrationLock(tx, lock, options.quiet);
    return await fn(tx);
  });
}

/**
 * Run `fn` in a transaction that first takes the runner's advisory lock for `lock` (held until
 * the transaction ends, so a second runner waits, then sees the first one's work) and runs
 * `setup`; a setup statement that loses a creation race retries in a fresh transaction.
 *
 * @param sql The client.
 * @param lock The lock's name (one per tracking table).
 * @param setup Create the history's schema and table (idempotent DDL).
 * @param fn The work.
 * @param quiet Silence the server's `NOTICE`s inside the transaction.
 * @returns What `fn` returned.
 */
export async function lockedMigrationTx<T>(
  sql: SqlClient,
  lock: string,
  setup: (tx: SqlClient) => Promise<unknown>,
  fn: (tx: SqlClient) => Promise<T>,
  quiet = false,
): Promise<T> {
  const attempt = () =>
    sql.begin(async (tx) => {
      await takeMigrationLock(tx, lock, quiet);
      await guardSetup(() => setup(tx));
      return await fn(tx);
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
 * Create the schema and the tracking table, inside the locked transaction.
 *
 * @param tx The transaction.
 * @param table The qualified tracking table.
 * @param schema Its schema, created when given.
 */
export async function setUpTrackingTable(
  tx: SqlClient,
  table: string,
  schema: string | undefined,
): Promise<void> {
  if (schema) await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await tx.unsafe(
    `CREATE TABLE IF NOT EXISTS ${table} (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, ` +
      "applied_at TIMESTAMPTZ NOT NULL)",
  );
}

/**
 * Run a migration's SQL, naming the migration in the error when it fails.
 *
 * @param tx The transaction.
 * @param name The migration's name.
 * @param text Its SQL.
 * @param direction `up`, or `down` for a rollback.
 */
export async function runMigrationScript(
  tx: SqlClient,
  name: string,
  text: string,
  direction: "up" | "down" = "up",
): Promise<void> {
  try {
    await runScript(tx, text);
  } catch (error) {
    throw new Error(
      `migration ${name}${direction === "down" ? " (down)" : ""} failed: ${
        error instanceof Error ? error.message : error
      }`,
      { cause: error },
    );
  }
}

/**
 * Apply one migration under the advisory lock, unless another runner applied it meanwhile.
 *
 * @param sql The client.
 * @param migration The migration.
 * @param table The qualified tracking table.
 * @param schema The tracking table's schema, if any.
 * @param quiet Silence the server's `NOTICE`s while it runs.
 * @returns Whether this call applied it.
 */
export async function applyPostgresMigration(
  sql: SqlClient,
  migration: Migration,
  table: string,
  schema: string | undefined,
  quiet = false,
): Promise<boolean> {
  const sum = await checksum(migration.sql);
  return await lockedMigrationTx(
    sql,
    table,
    (tx) => setUpTrackingTable(tx, table, schema),
    async (tx) => {
      const seen = await tx.unsafe(`SELECT 1 AS hit FROM ${table} WHERE name = $1`, [
        migration.name,
      ]);
      if (seen.length) return false;
      await runMigrationScript(tx, migration.name, migration.sql);
      await tx.unsafe(`INSERT INTO ${table} (name, checksum, applied_at) VALUES ($1, $2, $3)`, [
        migration.name,
        sum,
        new Date(),
      ]);
      return true;
    },
    quiet,
  );
}

/**
 * Refuse a migration that ends or starts a transaction of its own.
 *
 * @param name The migration's name.
 * @param text Its SQL.
 * @throws {Error} When it has a `BEGIN` / `COMMIT` statement.
 */
export function assertNoOwnTransaction(name: string, text: string): void {
  if (OWN_TRANSACTION.test(text)) {
    throw new Error(
      `migration ${name} manages its own transaction (BEGIN / COMMIT): remove ` +
        "those statements — each migration already runs in a transaction of its own",
    );
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
  for (const migration of known) assertNoOwnTransaction(migration.name, migration.sql);
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
    if (await applyPostgresMigration(sql, migration, table, options.schema, options.quiet)) {
      result.applied.push(migration.name);
    }
  }
  if (result.applied.length > 0) await notifySchemaReload(sql);
  return result;
}

/**
 * Tell running servers the schema changed: `NOTIFY pgrst, 'reload schema'`, PostgREST's own
 * signal, on which `@denext/backend`'s REST catalog (and a PostgREST in front of the same
 * database) re-reads it. Best effort: a failure never fails the migration that preceded it.
 *
 * @param sql The client the migrations ran on.
 */
export async function notifySchemaReload(sql: SqlClient): Promise<void> {
  try {
    await sql`select pg_notify('pgrst', 'reload schema')`;
  } catch {
    // A client that can't notify: the servers' throttled re-read on a miss still applies.
  }
}
