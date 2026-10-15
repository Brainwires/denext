/**
 * A {@linkcode JobHistoryStore} on Postgres: job run history shared by every replica, so
 * `denext ui`'s Cron page (and your own `read()` / `listRuns()`) see the runs of the whole fleet
 * rather than one instance's file.
 *
 * ```ts
 * // denext.config.ts
 * import { postgresJobHistoryStore } from "denext/server";
 * export default {
 *   jobs: { history: { store: postgresJobHistoryStore({ url: Deno.env.get("DATABASE_URL") }) } },
 * };
 * ```
 *
 * Runs live in `job_runs`, created by a migration (recorded in `job_history_migrations`) on
 * the first write — never by a read: `read()` and `listRuns()` send no DDL, and answer "no history
 * recorded yet" while the table does not exist (so `denext ui --read-only` changes nothing). Like the SQLite store, recording can never fail or delay a run: `record` starts the
 * insert and returns, a failed insert drops its row, and after three failures in a row the store
 * stops trying for the life of the process. Retention matches the default store: a per-job cap
 * (500 by default) and a 14-day window, applied on the first insert of a process and then every
 * 200 inserts at most every ten minutes.
 *
 * @module
 */

import {
  type PostgresConnectionOptions,
  resolveConnection,
  schemaPrefix,
  type SqlClient,
  sqlState,
  toNumber,
} from "./postgres.ts";
import type { Migration } from "./postgres-migrate.ts";
import { bootMigrate, registerBootCheck } from "./postgres-boot.ts";
import { inRootContext } from "./root-context.ts";
import type {
  JobHistory,
  JobHistoryCleared,
  JobHistoryPruneOptions,
  JobHistoryReadOptions,
  JobHistoryRow,
  JobHistoryRun,
  JobHistoryStore,
} from "./job-history.ts";
import type { JobRunRecord } from "./jobs.ts";

/** Options for {@linkcode postgresJobHistoryStore}. */
export interface PostgresJobHistoryStoreOptions extends PostgresConnectionOptions {
  /** Runs kept per job before the oldest are dropped (default 500). */
  maxRuns?: number;
  /** Apply the table's migration on first use (default `true`). */
  migrate?: boolean;
}

const DEFAULT_MAX_RUNS = 500;
const RETAIN_DAYS = 14;
const DEFAULT_RECENT = 20;
const FAILURE_LATCH = 3;
const PRUNE_EVERY = 200;
const PRUNE_INTERVAL_MS = 600_000;
const FEATURE = "postgresJobHistoryStore";
/** What a read says before the first run created the table — the SQLite store's words. */
const NOTHING_YET = "no history recorded yet";
/** SQLSTATEs for a table (or its schema) that does not exist yet. */
const MISSING = new Set(["42P01", "3F000"]);

/** The schema, as migrations. `p` qualifies a table. Integers, not booleans: `SUM(ok)` reads. */
function historyMigrations(p: string): Migration[] {
  return [{
    name: "0001_job_runs",
    sql: `
CREATE TABLE IF NOT EXISTS ${p}job_runs (
  id TEXT PRIMARY KEY, job TEXT NOT NULL, trigger TEXT NOT NULL, started_at BIGINT NOT NULL,
  duration_ms BIGINT NOT NULL, ok INTEGER NOT NULL, detail TEXT,
  attempt INTEGER NOT NULL DEFAULT 1, will_retry INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS job_runs_job_started ON ${p}job_runs (job, started_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_started ON ${p}job_runs (started_at DESC);
`,
  }];
}

/** Why a read produced nothing, in words a panel can show. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A column that may arrive as a number, a string (`int8`) or a boolean, as a number. */
const num = (value: unknown): number =>
  value === true ? 1 : value === false ? 0 : toNumber(value) ?? 0;

/** A row of `job_runs` as a feed entry. */
function toRun(row: Record<string, unknown>): JobHistoryRun {
  return {
    job: String(row.job),
    trigger: String(row.trigger),
    startedAt: num(row.started_at),
    durationMs: num(row.duration_ms),
    ok: num(row.ok) === 1,
    detail: row.detail == null ? null : String(row.detail),
    attempt: num(row.attempt),
    willRetry: num(row.will_retry) === 1,
  };
}

/** The {@link JobHistoryStore} behind {@linkcode postgresJobHistoryStore}. */
class PostgresJobHistory implements JobHistoryStore {
  readonly #sql: SqlClient;
  readonly #owned: boolean;
  readonly #t: string;
  readonly #maxRuns: number;
  readonly #options: PostgresJobHistoryStoreOptions;
  readonly #pending = new Set<Promise<void>>();
  #migrated: Promise<unknown> | undefined;
  #disabled = false;
  #closed = false;
  #failures = 0;
  #sincePrune = 0;
  #lastPrune = 0;
  #prunedOnce = false;

  constructor(options: PostgresJobHistoryStoreOptions) {
    const prefix = schemaPrefix(options.schema, FEATURE);
    const { sql, owned } = resolveConnection(options, FEATURE);
    this.#sql = sql;
    this.#owned = owned;
    this.#t = `${prefix}job_runs`;
    this.#maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.#options = options;
    // DENEXT_BOOT_DDL=off: the server checks the table before it serves.
    if (options.migrate !== false) registerBootCheck(async () => void await this.#db());
  }

  /** The client, once the migration has run (shared by concurrent first calls). */
  async #db(): Promise<SqlClient> {
    if (this.#closed) throw new Error(`${FEATURE}: this store has been closed`);
    if (this.#options.migrate !== false) {
      // Shared by every caller, so started in the root context (see root-context.ts).
      this.#migrated ??= inRootContext(() =>
        bootMigrate(this.#sql, {
          migrations: historyMigrations(schemaPrefix(this.#options.schema, FEATURE)),
          table: "job_history_migrations",
          schema: this.#options.schema,
          feature: FEATURE,
        })
      ).catch((error) => {
        this.#migrated = undefined; // retry on the next call
        throw error;
      });
      await this.#migrated;
    }
    return this.#sql;
  }

  /**
   * The client for a read: never migrates. A migration this process already started is waited
   * for (a read right after a record sees its row); otherwise the table may not exist yet, which
   * the caller reports as {@linkcode NOTHING_YET}.
   */
  async #reader(): Promise<SqlClient> {
    if (this.#closed) throw new Error(`${FEATURE}: this store has been closed`);
    await this.#migrated?.catch(() => {});
    return this.#sql;
  }

  record(run: JobRunRecord): Promise<void> {
    if (this.#disabled || this.#closed) return Promise.resolve();
    // Started in the root context: `runJob` may be called from a request, and the insert (or
    // the pool connection it opens) must not carry that request along. Never rejects.
    const write: Promise<void> = inRootContext(() => this.#insert(run)).then(
      () => {
        this.#failures = 0;
      },
      () => {
        this.#failures += 1;
        if (this.#failures >= FAILURE_LATCH) this.#disabled = true;
      },
    ).finally(() => this.#pending.delete(write));
    this.#pending.add(write);
    return write;
  }

  async #insert(run: JobRunRecord): Promise<void> {
    const db = await this.#db();
    await db.unsafe(
      `INSERT INTO ${this.#t} (id, job, trigger, started_at, duration_ms, ok, detail, attempt, ` +
        "will_retry) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        crypto.randomUUID(),
        run.name,
        run.trigger,
        Math.trunc(run.startedAt),
        Math.trunc(run.durationMs),
        run.ok ? 1 : 0,
        run.detail ?? null,
        Math.trunc(run.attempt ?? 1),
        run.willRetry ? 1 : 0,
      ],
    );
    this.#sincePrune += 1;
    const now = Date.now();
    // The first insert of a process prunes (a one-shot `denext job` writes one row per
    // process), then the amortized cadence — the same rule as the SQLite store.
    if (!this.#prunedOnce) {
      this.#prunedOnce = true;
      await this.#prune(db, this.#maxRuns, RETAIN_DAYS);
    } else if (this.#sincePrune >= PRUNE_EVERY && now - this.#lastPrune >= PRUNE_INTERVAL_MS) {
      this.#sincePrune = 0;
      this.#lastPrune = now;
      await this.#prune(db, this.#maxRuns, RETAIN_DAYS);
    }
  }

  async #prune(db: SqlClient, maxRuns: number, retainDays: number): Promise<void> {
    await db.unsafe(`DELETE FROM ${this.#t} WHERE started_at < $1`, [
      Date.now() - retainDays * 86_400_000,
    ]);
    // Per job, so a noisy job never evicts a quiet one's history.
    await db.unsafe(
      `DELETE FROM ${this.#t} WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER ` +
        `(PARTITION BY job ORDER BY started_at DESC, id DESC) AS rn FROM ${this.#t}) ranked ` +
        "WHERE rn > $1)",
      [maxRuns],
    );
  }

  async read(options: JobHistoryReadOptions = {}): Promise<JobHistory> {
    const windowDays = options.windowDays ?? 7;
    const empty = { windowDays, jobs: [], recent: [] };
    try {
      const db = await this.#reader();
      const since = Date.now() - windowDays * 86_400_000;
      const t = this.#t;
      const rows = await db.unsafe(
        "SELECT job, " +
          `(SELECT ok FROM ${t} r2 WHERE r2.job = r1.job ORDER BY started_at DESC, id DESC LIMIT 1) AS last_ok, ` +
          "MAX(started_at) AS last_run_at, " +
          `(SELECT duration_ms FROM ${t} r3 WHERE r3.job = r1.job ORDER BY started_at DESC, id DESC LIMIT 1) AS last_duration_ms, ` +
          "SUM(ok) AS successes, " +
          "SUM(CASE WHEN ok = 0 AND will_retry = 0 THEN 1 ELSE 0 END) AS failures, " +
          "SUM(CASE WHEN attempt > 1 THEN 1 ELSE 0 END) AS retries " +
          `FROM ${t} r1 WHERE started_at >= $1 GROUP BY job ORDER BY last_run_at DESC`,
        [since],
      );
      const jobs: JobHistoryRow[] = rows.map((row) => ({
        job: String(row.job),
        lastOk: num(row.last_ok) === 1,
        lastRunAt: num(row.last_run_at),
        lastDurationMs: num(row.last_duration_ms),
        successes: num(row.successes),
        failures: num(row.failures),
        retries: num(row.retries),
      }));
      const recent = (await db.unsafe(
        `SELECT job, trigger, started_at, duration_ms, ok, detail, attempt, will_retry FROM ${t} ` +
          "ORDER BY started_at DESC, id DESC LIMIT $1",
        [Math.max(0, Math.trunc(options.recentLimit ?? DEFAULT_RECENT))],
      )).map(toRun);
      return { available: true, windowDays, jobs, recent };
    } catch (error) {
      const reason = MISSING.has(sqlState(error) ?? "") ? NOTHING_YET : reasonOf(error);
      return { available: false, reason, ...empty };
    }
  }

  async listRuns(
    job: string,
    options: { readonly limit?: number } = {},
  ): Promise<JobHistoryRun[]> {
    try {
      const db = await this.#reader();
      const rows = await db.unsafe(
        `SELECT job, trigger, started_at, duration_ms, ok, detail, attempt, will_retry FROM ${this.#t} ` +
          "WHERE job = $1 ORDER BY started_at DESC, id DESC LIMIT $2",
        [job, Math.max(0, Math.trunc(options.limit ?? DEFAULT_RECENT))],
      );
      return rows.map(toRun);
    } catch {
      return [];
    }
  }

  async prune(options: JobHistoryPruneOptions = {}): Promise<void> {
    try {
      const db = await this.#db();
      await this.#prune(db, options.maxRuns ?? this.#maxRuns, options.retainDays ?? RETAIN_DAYS);
    } catch { /* nothing pruned this time */ }
  }

  async clear(): Promise<JobHistoryCleared> {
    try {
      const db = await this.#db();
      await db.unsafe(`DELETE FROM ${this.#t}`);
      return { cleared: true };
    } catch (error) {
      return { cleared: false, reason: reasonOf(error) };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    // Let the writes already started land, then stop: no later record reaches the database.
    await Promise.all(this.#pending);
    this.#closed = true;
    if (this.#owned) await this.#sql.close();
  }
}

/**
 * Job run history on Postgres — pass it as `jobs: { history: { store } }`.
 *
 * @param options A client (`sql`) or a `postgres://` URL, an optional schema, the per-job cap
 *   and `migrate: false` when the table is created out of band.
 * @returns The store. Nothing connects until the first run is recorded (or history is read).
 * @throws {TypeError} When neither (or both) of `sql` and `url` is given.
 * @throws {PostgresUnsupportedError} For a `url` on a Deno without `Deno.SQL`.
 */
export function postgresJobHistoryStore(
  options: PostgresJobHistoryStoreOptions,
): JobHistoryStore {
  return new PostgresJobHistory(options);
}
