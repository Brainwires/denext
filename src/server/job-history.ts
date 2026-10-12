// Job run history: one row per run, so `denext ui` can answer "what ran, and did it work?".
//
// OFF unless `denext.config.ts` says `jobs: { history: true }`. Nothing here runs, and no file
// is created, for an app that has not asked — that is the whole reason the recorder is installed
// at boot rather than being something `runJob` decides.
//
// The one rule that outranks every other: **recording must never fail or delay a run.** A job is
// the user's work; its history is bookkeeping. So the store latches itself off after an open
// failure or a short run of write failures, every call is wrapped, and the writer's busy timeout
// is deliberately tiny (see BUSY_WRITE_MS) — a lost row costs nothing, a delayed job costs the
// user something.
//
// The handle is opened lazily on the first recorded run: enabling happens in the UI process,
// which must never create files in `.denext/` on the app's behalf.

import { chmodSync, statSync } from "node:fs";
import { openSqliteFile, type SqliteDb, type SqlValue } from "./sqlite-cache.ts";
import type { JobRunRecord } from "./jobs.ts";

/** The history database, inside `ProjectPaths.outDir` — the filename is spelled once, here. */
export const JOB_HISTORY_DB = "jobs.db";

/** Runs kept per job before the oldest are dropped. */
const DEFAULT_MAX_RUNS = 500;

/** Runs older than this are pruned regardless of the per-job cap. */
const RETAIN_DAYS = 14;

/**
 * The writer's busy timeout, in ms. A deliberate departure from the 5000 the cache and session
 * stores use: they WANT to wait, because losing their write is a correctness problem. This writer
 * sits on the tail of a job run, where a five-second block would delay the user's job. 50 ms
 * clears an ordinary WAL lock handoff (microseconds) and gives up fast on a pathological one; the
 * row is then dropped by the catch, which is the correct trade.
 */
const BUSY_WRITE_MS = 50;

/** The reader has no deadline pressure and would rather return data than give up. */
const BUSY_READ_MS = 2000;

/** Consecutive write failures after which the store stops trying for this process. */
const FAILURE_LATCH = 3;

/** Inserts between amortized prunes. */
const PRUNE_EVERY = 200;

/** Minimum ms between prunes, however many rows were written. */
const PRUNE_INTERVAL_MS = 600_000;

/**
 * The schema version stamped into `PRAGMA user_version`, so a later shape has a number to
 * migrate from. 0 predates the stamp and is version 1's schema; 2 adds `attempt` and
 * `will_retry` (job retries), which an older file gains by `ALTER TABLE` on its first open by a
 * writer. Both columns default, so an older writer's `INSERT` still works on a newer file.
 */
const SCHEMA_VERSION = 2;

/** Options for {@linkcode jobHistoryRecorder} and {@linkcode readJobHistory}. */
export interface JobHistoryOptions {
  /** The database file. */
  readonly path: string;
  /** Runs kept per job (default 500). */
  readonly maxRuns?: number;
  /** Advanced/test hook: open the handle yourself instead of node:sqlite. */
  readonly openDb?: (path: string) => SqliteDb;
}

/** One job's standing, as the panel shows it. */
export interface JobHistoryRow {
  /** The job name. */
  readonly job: string;
  /** Whether its most recent run succeeded. */
  readonly lastOk: boolean;
  /** When that run started (epoch ms). */
  readonly lastRunAt: number;
  /** How long it took. */
  readonly lastDurationMs: number;
  /** Successes inside the window. */
  readonly successes: number;
  /** Failures inside the window (a failed attempt that was retried is not one). */
  readonly failures: number;
  /** Retry attempts inside the window. */
  readonly retries: number;
}

/** One run in the recent feed. */
export interface JobHistoryRun {
  /** The job name. */
  readonly job: string;
  /** What started it. */
  readonly trigger: string;
  /** When it started (epoch ms). */
  readonly startedAt: number;
  /** How long it took. */
  readonly durationMs: number;
  /** Whether it succeeded. */
  readonly ok: boolean;
  /** The error head, a string result's tail, or null. */
  readonly detail: string | null;
  /** Which attempt it was (`1` = the first run; a job without `retry` is always 1). */
  readonly attempt: number;
  /** A failed attempt that was retried. */
  readonly willRetry: boolean;
}

/** What a read returns — including why there is nothing, which is itself an answer. */
export interface JobHistory {
  /** False when the database could not be read at all; `reason` says why. */
  readonly available: boolean;
  /** Why nothing is available, when it is not. */
  readonly reason?: string;
  /** The window the counts cover, in days. */
  readonly windowDays: number;
  /** One row per job that has run inside the window. */
  readonly jobs: readonly JobHistoryRow[];
  /** The most recent runs, newest first. */
  readonly recent: readonly JobHistoryRun[];
}

/** Options for {@linkcode JobHistoryStore.read}. */
export interface JobHistoryReadOptions {
  /** How many days the per-job counts cover (default 7). */
  readonly windowDays?: number;
  /** How many runs the recent feed holds (default 20). */
  readonly recentLimit?: number;
  /**
   * The reader may not change anything (`denext ui --read-only`). A read never should — create a
   * table, migrate, prune — and the built-in stores never do; a store of your own can check this
   * to skip anything it would otherwise do on the way.
   */
  readonly readOnly?: boolean;
}

/** Options for {@linkcode JobHistoryStore.prune}. */
export interface JobHistoryPruneOptions {
  /** Runs kept per job (default: the store's own `maxRuns`, else 500). */
  readonly maxRuns?: number;
  /** Runs older than this many days are dropped (default 14). */
  readonly retainDays?: number;
}

/**
 * Where job run history is kept — the seam behind `jobs: { history }`.
 *
 * denext records one row per completed run: its start (`startedAt`), how it ended (`ok`: it
 * finished; `!ok`: it threw, with the error's head in `detail`) and, for a job with `retry`,
 * the attempt. The default store is a SQLite file in `.denext/` ({@linkcode
 * sqliteJobHistoryStore}); {@linkcode postgresJobHistoryStore} keeps it in Postgres, shared by
 * every replica. Any object with these methods works:
 *
 * ```ts
 * // denext.config.ts
 * import { postgresJobHistoryStore } from "denext/server";
 * export default {
 *   jobs: { history: { store: postgresJobHistoryStore({ url: Deno.env.get("DATABASE_URL") }) } },
 * };
 * ```
 *
 * The contract a store must keep: **recording never fails or delays a run.** `record` is
 * called on the tail of every run and never awaited; it must not throw (a returned promise must
 * not reject), and a store that cannot write drops the row. The readers never throw either:
 * an unreadable store is `{ available: false, reason }`.
 */
export interface JobHistoryStore {
  /**
   * Record one completed run. Called on the run's tail, never awaited: must not throw, and a
   * returned promise must not reject.
   */
  record(run: JobRunRecord): void | Promise<void>;
  /**
   * The panel summary: per-job standing inside the window, and the recent feed (newest first).
   * Reads only: no table is created or migrated to answer (nothing recorded yet is
   * `{ available: false, reason }`).
   */
  read(options?: JobHistoryReadOptions): Promise<JobHistory>;
  /** One job's runs, newest first (default: the 20 most recent). Never throws: `[]` instead. */
  listRuns(job: string, options?: { readonly limit?: number }): Promise<JobHistoryRun[]>;
  /** Drop runs past the per-job cap and the retention window. Never throws. */
  prune(options?: JobHistoryPruneOptions): Promise<void>;
  /** Delete every recorded run, keeping the store itself. Never throws. */
  clear(): Promise<JobHistoryCleared>;
  /** Release what the store holds (a file handle, a pool it opened). */
  close?(): void | Promise<void>;
}

/**
 * Apply pragmas and create the schema. Each pragma is applied on its own: a refused one keeps the
 * default rather than failing the open. WAL is the one that matters — it is what lets the UI read
 * the file while the app writes it.
 */
function initSchema(d: SqliteDb, busyMs: number): void {
  for (
    const pragma of [
      `PRAGMA busy_timeout = ${busyMs}`,
      "PRAGMA journal_mode = WAL",
      "PRAGMA synchronous = NORMAL",
    ]
  ) {
    try {
      d.exec(pragma);
    } catch { /* keep the default */ }
  }
  d.exec(
    "CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, " +
      "trigger TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, " +
      "ok INTEGER NOT NULL, detail TEXT, attempt INTEGER NOT NULL DEFAULT 1, " +
      "will_retry INTEGER NOT NULL DEFAULT 0)",
  );
  // A version-1 file (created before retries) gains the two columns.
  const have = new Set(columnsOf(d));
  if (!have.has("attempt")) {
    d.exec("ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1");
  }
  if (!have.has("will_retry")) {
    d.exec("ALTER TABLE runs ADD COLUMN will_retry INTEGER NOT NULL DEFAULT 0");
  }
  d.exec("CREATE INDEX IF NOT EXISTS runs_job_started ON runs (job, started_at DESC)");
  d.exec("CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at DESC)");
  // Only ever raise the stamp: a future version must never be wound back by an older writer.
  try {
    const [row] = d.query<{ user_version: number }>("PRAGMA user_version");
    if (Number(row?.user_version ?? 0) < SCHEMA_VERSION) {
      d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  } catch { /* keep going: the version is bookkeeping, not the schema */ }
}

/** The `runs` table's column names (empty when it does not exist). */
function columnsOf(d: SqliteDb): string[] {
  return d.query<{ name: string }>("PRAGMA table_info(runs)").map((c) => c.name);
}

/**
 * Make the file readable by its owner only, best-effort. The rows hold each run's returned
 * string and error text, which are the job's own output and not for every local user; SQLite
 * copies the main file's mode onto the `-wal`/`-shm` siblings it creates later, which is why
 * this runs before the first write. Windows has no POSIX mode to set; `:memory:` has no file.
 */
function restrictFileMode(path: string): void {
  if (path === ":memory:" || Deno.build.os === "windows") return;
  try {
    chmodSync(path, 0o600);
  } catch { /* a filesystem that refuses is still a filesystem that opened */ }
}

/**
 * Drop runs older than `retainDays`, then every job's runs past `maxRuns`.
 *
 * Per job, not global: a global cap would let a minute-cron job evict a daily job's whole
 * history and silently corrupt the quiet job's counts. And EVERY job, not the one whose run
 * triggered this: a job that only ever runs from `denext job <name>` gets one row per process
 * and would otherwise never be the trigger. One windowed DELETE (SQLite ≥ 3.25).
 */
function pruneRuns(d: SqliteDb, maxRuns: number, retainDays: number): void {
  const cutoff = Date.now() - retainDays * 86_400_000;
  d.exec("DELETE FROM runs WHERE started_at < ?", [cutoff]);
  d.exec(
    "DELETE FROM runs WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER " +
      "(PARTITION BY job ORDER BY started_at DESC, id DESC) AS rn FROM runs) WHERE rn > ?)",
    [maxRuns],
  );
}

/**
 * A recorder to hand {@linkcode setJobRecorder}: it writes one row per run and can never throw.
 *
 * The handle opens on the first record, not here — enabling history must not create a file. After
 * an open failure, or {@linkcode FAILURE_LATCH} consecutive write failures, the store latches off
 * for the rest of the process and every later call returns immediately.
 *
 * @param options The database path, the per-job cap, and an optional open hook.
 * @returns A function to install as the job recorder, and a `close` for tests and disposers.
 */
export function jobHistoryRecorder(
  options: JobHistoryOptions,
): { record: (run: JobRunRecord) => void; close: () => void } {
  const open = options.openDb ?? ((path: string) => openSqliteFile(path));
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  let db: SqliteDb | null = null;
  let disabled = false;
  let failures = 0;
  let sincePrune = 0;
  let lastPrune = 0;
  let prunedOnce = false;

  const handle = (): SqliteDb | null => {
    if (disabled) return null;
    if (db) return db;
    try {
      const opened = open(options.path);
      restrictFileMode(options.path);
      initSchema(opened, BUSY_WRITE_MS);
      db = opened;
      return db;
    } catch {
      // Read-only filesystem, a denied --allow-write, a corrupt file, a missing directory: all
      // mean "no history", and none of them mean "fail the run".
      disabled = true;
      return null;
    }
  };

  const prune = (d: SqliteDb): void => pruneRuns(d, maxRuns, RETAIN_DAYS);

  return {
    record(run: JobRunRecord): void {
      const d = handle();
      if (!d) return;
      try {
        d.exec(
          "INSERT INTO runs (job, trigger, started_at, duration_ms, ok, detail, attempt, " +
            "will_retry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
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
        failures = 0;
        sincePrune += 1;
        const now = Date.now();
        // The first insert of a process always prunes, outside the amortised cadence: a one-shot
        // `denext job <name>` from system cron writes ONE row per process and would never reach
        // 200 inserts, so retention would never run for it and the file would grow without
        // bound. The cadence below is untouched by it — it starts counting from the same zero.
        if (!prunedOnce) {
          prunedOnce = true;
          prune(d);
        } else if (sincePrune >= PRUNE_EVERY && now - lastPrune >= PRUNE_INTERVAL_MS) {
          sincePrune = 0;
          lastPrune = now;
          prune(d);
        }
      } catch {
        // A busy database, a full disk, a schema that went missing. Drop the row; a run is never
        // worth failing over its own bookkeeping.
        failures += 1;
        if (failures >= FAILURE_LATCH) disabled = true;
      }
    },
    close(): void {
      try {
        db?.close();
      } catch { /* already gone */ }
      db = null;
      disabled = true;
    },
  };
}

/** The recent feed's default length. */
const DEFAULT_RECENT = 20;

/**
 * Runs, newest first — every job's, or one job's with `where`. A version-1 file (read-only to
 * a reader, so never migrated by one) has no retry columns; they read as a first attempt.
 */
function queryRuns(
  d: SqliteDb,
  where: string,
  params: SqlValue[],
  limit: number,
): JobHistoryRun[] {
  const retryCols = columnsOf(d).includes("will_retry");
  const attemptCol = retryCols ? "attempt" : "1 AS attempt";
  const willRetryCol = retryCols ? "will_retry" : "0 AS will_retry";
  return d.query<{
    job: string;
    trigger: string;
    started_at: number;
    duration_ms: number;
    ok: number;
    detail: string | null;
    attempt: number;
    will_retry: number;
  }>(
    `SELECT job, trigger, started_at, duration_ms, ok, detail, ${attemptCol}, ${willRetryCol} ` +
      `FROM runs ${where} ORDER BY started_at DESC, id DESC LIMIT ?`,
    [...params, Math.max(0, Math.trunc(limit))],
  ).map((row) => ({
    job: row.job,
    trigger: row.trigger,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    ok: row.ok === 1,
    detail: row.detail,
    attempt: Number(row.attempt),
    willRetry: row.will_retry === 1,
  }));
}

/**
 * Read the history for a panel. Never throws: a database that is missing, unreadable or has no
 * rows yet are three different answers, and the caller has to tell them apart.
 *
 * @param options The database path and an optional open hook.
 * @param windowDays How many days the counts cover (default 7).
 * @param recentLimit How many runs the recent feed holds (default 20).
 * @returns The rows, the recent feed, and whether anything could be read at all.
 */
export function readJobHistory(
  options: JobHistoryOptions,
  windowDays = 7,
  recentLimit = DEFAULT_RECENT,
): JobHistory {
  const open = options.openDb ?? ((path: string) => openSqliteFile(path, { readOnly: true }));
  const empty = { windowDays, jobs: [], recent: [] };
  let d: SqliteDb;
  try {
    d = open(options.path);
  } catch (err) {
    return { available: false, reason: reasonOf(options.path, err), ...empty };
  }
  try {
    for (const pragma of [`PRAGMA busy_timeout = ${BUSY_READ_MS}`]) {
      try {
        d.exec(pragma);
      } catch { /* keep the default */ }
    }
    const since = Date.now() - windowDays * 86_400_000;
    // A version-1 file (read-only here, so never migrated by the reader) has no retry columns.
    const retryCols = columnsOf(d).includes("will_retry");
    const jobs = d.query<{
      job: string;
      last_ok: number;
      last_run_at: number;
      last_duration_ms: number;
      successes: number;
      failures: number;
      retries: number;
    }>(
      "SELECT job, " +
        "(SELECT ok FROM runs r2 WHERE r2.job = r1.job ORDER BY started_at DESC LIMIT 1) AS last_ok, " +
        "MAX(started_at) AS last_run_at, " +
        "(SELECT duration_ms FROM runs r3 WHERE r3.job = r1.job ORDER BY started_at DESC LIMIT 1) AS last_duration_ms, " +
        "SUM(ok) AS successes, " +
        (retryCols
          ? "SUM(CASE WHEN ok = 0 AND will_retry = 0 THEN 1 ELSE 0 END) AS failures, " +
            "SUM(CASE WHEN attempt > 1 THEN 1 ELSE 0 END) AS retries "
          : "SUM(1 - ok) AS failures, 0 AS retries ") +
        "FROM runs r1 WHERE started_at >= ? GROUP BY job ORDER BY last_run_at DESC",
      [since],
    ).map((row) => ({
      job: row.job,
      lastOk: row.last_ok === 1,
      lastRunAt: row.last_run_at,
      lastDurationMs: row.last_duration_ms,
      successes: Number(row.successes),
      failures: Number(row.failures),
      retries: Number(row.retries),
    }));
    const recent = queryRuns(d, "", [], recentLimit);
    return { available: true, windowDays, jobs, recent };
  } catch (err) {
    return { available: false, reason: reasonOf(options.path, err), ...empty };
  } finally {
    try {
      d.close();
    } catch { /* already gone */ }
  }
}

/**
 * Why a read produced nothing, in words a panel can show.
 *
 * "There is no database yet" is the ordinary state — history was enabled and nothing has run —
 * and it is decided by looking for the file, not by matching an error. node:sqlite reports a
 * missing file as a plain `Error` reading "unable to open database file: <absolute path>": not a
 * `Deno.errors.NotFound`, and not something to put on a page.
 */
function reasonOf(path: string, err: unknown): string {
  if (!fileExists(path)) return "no history recorded yet";
  return err instanceof Error ? err.message : String(err);
}

/** Whether the database file is there at all. */
function fileExists(path: string): boolean {
  if (path === ":memory:") return true;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** What clearing the history did, or why it could not. */
export interface JobHistoryCleared {
  /** Whether the rows were removed. */
  readonly cleared: boolean;
  /** Why not, when they were not. */
  readonly reason?: string;
}

/**
 * Delete every recorded run, keeping the database itself.
 *
 * A `DELETE`, deliberately not a file unlink: the app process may hold this database open with
 * live `-wal`/`-shm` siblings, and removing a file out from under another process's handle is
 * exactly the cross-process write this design refuses everywhere else. A `DELETE` is safe against
 * a concurrent writer; an unlink is not.
 *
 * Never throws — a history store that cannot be cleared is not worth a failed response.
 *
 * @param options The database path, and an optional open hook.
 * @returns Whether the rows went, and why not when they did not.
 */
export function clearJobHistory(options: JobHistoryOptions): JobHistoryCleared {
  const open = options.openDb ?? ((path: string) => openSqliteFile(path));
  // Checked BEFORE opening: this is a writer, and a writer open CREATES the file. Without this,
  // asking to clear a project that never recorded anything would leave behind the very database
  // the feature promises not to write unasked — and answer "no such table: runs" while doing it.
  if (options.openDb === undefined && !fileExists(options.path)) {
    return { cleared: false, reason: "no history recorded yet" };
  }
  let d: SqliteDb;
  try {
    d = open(options.path);
  } catch (err) {
    return { cleared: false, reason: reasonOf(options.path, err) };
  }
  try {
    try {
      d.exec(`PRAGMA busy_timeout = ${BUSY_READ_MS}`);
    } catch { /* keep the default */ }
    // Only a TABLE is cleared. A `DELETE` against a view runs whatever `INSTEAD OF` trigger the
    // view carries, so a database file someone else wrote could turn this one statement into
    // theirs; the schema the recorder creates has no views, and none is honoured here.
    const kind = d.query<{ type: string }>(
      "SELECT type FROM sqlite_master WHERE name = 'runs'",
    )[0]?.type;
    if (kind !== undefined && kind !== "table") {
      return { cleared: false, reason: `runs is a ${kind}, not a table — not cleared` };
    }
    d.exec("DELETE FROM runs");
    return { cleared: true };
  } catch (err) {
    return { cleared: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      d.close();
    } catch { /* already gone */ }
  }
}

/** Options for {@linkcode sqliteJobHistoryStore}. */
export interface SqliteJobHistoryStoreOptions extends JobHistoryOptions {}

/**
 * One job's runs from the file, newest first; `[]` when there is nothing to read. Opens
 * read-only, so it never creates the file.
 */
function listJobRuns(options: JobHistoryOptions, job: string, limit: number): JobHistoryRun[] {
  const open = options.openDb ?? ((path: string) => openSqliteFile(path, { readOnly: true }));
  if (options.openDb === undefined && !fileExists(options.path)) return [];
  let d: SqliteDb;
  try {
    d = open(options.path);
  } catch {
    return [];
  }
  try {
    try {
      d.exec(`PRAGMA busy_timeout = ${BUSY_READ_MS}`);
    } catch { /* keep the default */ }
    return queryRuns(d, "WHERE job = ?", [job], limit);
  } catch {
    return [];
  } finally {
    try {
      d.close();
    } catch { /* already gone */ }
  }
}

/**
 * Prune the file on demand. Never creates it: a history that does not exist has nothing to prune.
 */
function pruneFile(options: JobHistoryOptions, maxRuns: number, retainDays: number): void {
  if (options.openDb === undefined && !fileExists(options.path)) return;
  const open = options.openDb ?? ((path: string) => openSqliteFile(path));
  let d: SqliteDb;
  try {
    d = open(options.path);
  } catch {
    return;
  }
  try {
    try {
      d.exec(`PRAGMA busy_timeout = ${BUSY_READ_MS}`);
    } catch { /* keep the default */ }
    if (columnsOf(d).length > 0) pruneRuns(d, maxRuns, retainDays);
  } catch {
    /* a busy or foreign file: nothing pruned this time */
  } finally {
    try {
      d.close();
    } catch { /* already gone */ }
  }
}

/**
 * The default {@linkcode JobHistoryStore}: a SQLite file (`.denext/jobs.db` when denext
 * installs it), on Deno's built-in `node:sqlite`.
 *
 * The writer opens on the first recorded run — enabling history creates no file — and is
 * created owner-only (mode 0600). After an open failure, or three consecutive write failures,
 * it latches off for the rest of the process. The readers open the file read-only and separately
 * from the writer (WAL lets `denext ui` read while the app writes), and neither a read nor a clear
 * creates a file that is not there.
 *
 * @param options The file, the per-job cap, and an optional open hook.
 * @returns The store.
 */
export function sqliteJobHistoryStore(options: SqliteJobHistoryStoreOptions): JobHistoryStore {
  const recorder = jobHistoryRecorder(options);
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  return {
    record: (run) => recorder.record(run),
    read: (read = {}) =>
      Promise.resolve(
        readJobHistory(options, read.windowDays ?? 7, read.recentLimit ?? DEFAULT_RECENT),
      ),
    listRuns: (job, list = {}) =>
      Promise.resolve(listJobRuns(options, job, list.limit ?? DEFAULT_RECENT)),
    prune: (prune = {}) =>
      Promise.resolve(
        pruneFile(options, prune.maxRuns ?? maxRuns, prune.retainDays ?? RETAIN_DAYS),
      ),
    clear: () => Promise.resolve(clearJobHistory(options)),
    close: () => recorder.close(),
  };
}
