/**
 * A {@linkcode TaskHistoryStore} on Postgres: task run history shared by every replica, so
 * `denext ui`'s Cron page (and your own `read()` / `listRuns()`) see the runs of the whole fleet
 * rather than one instance's file.
 *
 * ```ts
 * // denext.config.ts
 * import { postgresTaskHistoryStore } from "denext/server";
 * export default {
 *   tasks: { history: { store: postgresTaskHistoryStore({ url: Deno.env.get("DATABASE_URL") }) } },
 * };
 * ```
 *
 * Runs live in `task_runs`, created by a migration (recorded in `task_history_migrations`) on
 * first use. Like the SQLite store, recording can never fail or delay a run: `record` starts the
 * insert and returns, a failed insert drops its row, and after three failures in a row the store
 * stops trying for the life of the process. Retention matches the default store: a per-task cap
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
  toNumber,
} from "./postgres.ts";
import { migratePostgres, type Migration } from "./postgres-migrate.ts";
import { inRootContext } from "./root-context.ts";
import type {
  TaskHistory,
  TaskHistoryCleared,
  TaskHistoryPruneOptions,
  TaskHistoryReadOptions,
  TaskHistoryRow,
  TaskHistoryRun,
  TaskHistoryStore,
} from "./task-history.ts";
import type { TaskRunRecord } from "./tasks.ts";

/** Options for {@linkcode postgresTaskHistoryStore}. */
export interface PostgresTaskHistoryStoreOptions extends PostgresConnectionOptions {
  /** Runs kept per task before the oldest are dropped (default 500). */
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
const FEATURE = "postgresTaskHistoryStore";

/** The schema, as migrations. `p` qualifies a table. Integers, not booleans: `SUM(ok)` reads. */
function historyMigrations(p: string): Migration[] {
  return [{
    name: "0001_task_runs",
    sql: `
CREATE TABLE IF NOT EXISTS ${p}task_runs (
  id TEXT PRIMARY KEY, task TEXT NOT NULL, trigger TEXT NOT NULL, started_at BIGINT NOT NULL,
  duration_ms BIGINT NOT NULL, ok INTEGER NOT NULL, detail TEXT,
  attempt INTEGER NOT NULL DEFAULT 1, will_retry INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS task_runs_task_started ON ${p}task_runs (task, started_at DESC);
CREATE INDEX IF NOT EXISTS task_runs_started ON ${p}task_runs (started_at DESC);
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

/** A row of `task_runs` as a feed entry. */
function toRun(row: Record<string, unknown>): TaskHistoryRun {
  return {
    task: String(row.task),
    trigger: String(row.trigger),
    startedAt: num(row.started_at),
    durationMs: num(row.duration_ms),
    ok: num(row.ok) === 1,
    detail: row.detail == null ? null : String(row.detail),
    attempt: num(row.attempt),
    willRetry: num(row.will_retry) === 1,
  };
}

/** The {@link TaskHistoryStore} behind {@linkcode postgresTaskHistoryStore}. */
class PostgresTaskHistory implements TaskHistoryStore {
  readonly #sql: SqlClient;
  readonly #owned: boolean;
  readonly #t: string;
  readonly #maxRuns: number;
  readonly #options: PostgresTaskHistoryStoreOptions;
  readonly #pending = new Set<Promise<void>>();
  #migrated: Promise<unknown> | undefined;
  #disabled = false;
  #closed = false;
  #failures = 0;
  #sincePrune = 0;
  #lastPrune = 0;
  #prunedOnce = false;

  constructor(options: PostgresTaskHistoryStoreOptions) {
    const prefix = schemaPrefix(options.schema, FEATURE);
    const { sql, owned } = resolveConnection(options, FEATURE);
    this.#sql = sql;
    this.#owned = owned;
    this.#t = `${prefix}task_runs`;
    this.#maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.#options = options;
  }

  /** The client, once the migration has run (shared by concurrent first calls). */
  async #db(): Promise<SqlClient> {
    if (this.#closed) throw new Error(`${FEATURE}: this store has been closed`);
    if (this.#options.migrate !== false) {
      // Shared by every caller, so started in the root context (see root-context.ts).
      this.#migrated ??= inRootContext(() =>
        migratePostgres(this.#sql, {
          migrations: historyMigrations(schemaPrefix(this.#options.schema, FEATURE)),
          table: "task_history_migrations",
          schema: this.#options.schema,
        })
      ).catch((error) => {
        this.#migrated = undefined; // retry on the next call
        throw error;
      });
      await this.#migrated;
    }
    return this.#sql;
  }

  record(run: TaskRunRecord): Promise<void> {
    if (this.#disabled || this.#closed) return Promise.resolve();
    // Started in the root context: `runTask` may be called from a request, and the insert (or
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

  async #insert(run: TaskRunRecord): Promise<void> {
    const db = await this.#db();
    await db.unsafe(
      `INSERT INTO ${this.#t} (id, task, trigger, started_at, duration_ms, ok, detail, attempt, ` +
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
    // The first insert of a process prunes (a one-shot `denext task` writes one row per
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
    // Per task, so a noisy task never evicts a quiet one's history.
    await db.unsafe(
      `DELETE FROM ${this.#t} WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER ` +
        `(PARTITION BY task ORDER BY started_at DESC, id DESC) AS rn FROM ${this.#t}) ranked ` +
        "WHERE rn > $1)",
      [maxRuns],
    );
  }

  async read(options: TaskHistoryReadOptions = {}): Promise<TaskHistory> {
    const windowDays = options.windowDays ?? 7;
    const empty = { windowDays, tasks: [], recent: [] };
    try {
      const db = await this.#db();
      const since = Date.now() - windowDays * 86_400_000;
      const t = this.#t;
      const rows = await db.unsafe(
        "SELECT task, " +
          `(SELECT ok FROM ${t} r2 WHERE r2.task = r1.task ORDER BY started_at DESC, id DESC LIMIT 1) AS last_ok, ` +
          "MAX(started_at) AS last_run_at, " +
          `(SELECT duration_ms FROM ${t} r3 WHERE r3.task = r1.task ORDER BY started_at DESC, id DESC LIMIT 1) AS last_duration_ms, ` +
          "SUM(ok) AS successes, " +
          "SUM(CASE WHEN ok = 0 AND will_retry = 0 THEN 1 ELSE 0 END) AS failures, " +
          "SUM(CASE WHEN attempt > 1 THEN 1 ELSE 0 END) AS retries " +
          `FROM ${t} r1 WHERE started_at >= $1 GROUP BY task ORDER BY last_run_at DESC`,
        [since],
      );
      const tasks: TaskHistoryRow[] = rows.map((row) => ({
        task: String(row.task),
        lastOk: num(row.last_ok) === 1,
        lastRunAt: num(row.last_run_at),
        lastDurationMs: num(row.last_duration_ms),
        successes: num(row.successes),
        failures: num(row.failures),
        retries: num(row.retries),
      }));
      const recent = (await db.unsafe(
        `SELECT task, trigger, started_at, duration_ms, ok, detail, attempt, will_retry FROM ${t} ` +
          "ORDER BY started_at DESC, id DESC LIMIT $1",
        [Math.max(0, Math.trunc(options.recentLimit ?? DEFAULT_RECENT))],
      )).map(toRun);
      return { available: true, windowDays, tasks, recent };
    } catch (error) {
      return { available: false, reason: reasonOf(error), ...empty };
    }
  }

  async listRuns(
    task: string,
    options: { readonly limit?: number } = {},
  ): Promise<TaskHistoryRun[]> {
    try {
      const db = await this.#db();
      const rows = await db.unsafe(
        `SELECT task, trigger, started_at, duration_ms, ok, detail, attempt, will_retry FROM ${this.#t} ` +
          "WHERE task = $1 ORDER BY started_at DESC, id DESC LIMIT $2",
        [task, Math.max(0, Math.trunc(options.limit ?? DEFAULT_RECENT))],
      );
      return rows.map(toRun);
    } catch {
      return [];
    }
  }

  async prune(options: TaskHistoryPruneOptions = {}): Promise<void> {
    try {
      const db = await this.#db();
      await this.#prune(db, options.maxRuns ?? this.#maxRuns, options.retainDays ?? RETAIN_DAYS);
    } catch { /* nothing pruned this time */ }
  }

  async clear(): Promise<TaskHistoryCleared> {
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
 * Task run history on Postgres — pass it as `tasks: { history: { store } }`.
 *
 * @param options A client (`sql`) or a `postgres://` URL, an optional schema, the per-task cap
 *   and `migrate: false` when the table is created out of band.
 * @returns The store. Nothing connects until the first run is recorded (or history is read).
 * @throws {TypeError} When neither (or both) of `sql` and `url` is given.
 * @throws {PostgresUnsupportedError} For a `url` on a Deno without `Deno.SQL`.
 */
export function postgresTaskHistoryStore(
  options: PostgresTaskHistoryStoreOptions,
): TaskHistoryStore {
  return new PostgresTaskHistory(options);
}
