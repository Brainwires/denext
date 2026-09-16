// Task run history: one row per run, so `denext ui` can answer "what ran, and did it work?".
//
// OFF unless `denext.config.ts` says `tasks: { history: true }`. Nothing here runs, and no file
// is created, for an app that has not asked — that is the whole reason the recorder is installed
// at boot rather than being something `runTask` decides.
//
// The one rule that outranks every other: **recording must never fail or delay a run.** A task is
// the user's work; its history is bookkeeping. So the store latches itself off after an open
// failure or a short run of write failures, every call is wrapped, and the writer's busy timeout
// is deliberately tiny (see BUSY_WRITE_MS) — a lost row costs nothing, a delayed job costs the
// user something.
//
// The handle is opened lazily on the first recorded run: enabling happens in the UI process,
// which must never create files in `.denext/` on the app's behalf.

import { statSync } from "node:fs";
import { openSqliteFile, type SqliteDb } from "./sqlite-cache.ts";
import type { TaskRunRecord } from "./tasks.ts";

/** The history database, inside `ProjectPaths.outDir` — the filename is spelled once, here. */
export const TASK_HISTORY_DB = "tasks.db";

/** Runs kept per task before the oldest are dropped. */
const DEFAULT_MAX_RUNS = 500;

/** Runs older than this are pruned regardless of the per-task cap. */
const RETAIN_DAYS = 14;

/**
 * The writer's busy timeout, in ms. A deliberate departure from the 5000 the cache and session
 * stores use: they WANT to wait, because losing their write is a correctness problem. This writer
 * sits on the tail of a task run, where a five-second block would delay the user's job. 50 ms
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

/** Options for {@linkcode taskHistoryRecorder} and {@linkcode readTaskHistory}. */
export interface TaskHistoryOptions {
  /** The database file. */
  readonly path: string;
  /** Runs kept per task (default 500). */
  readonly maxRuns?: number;
  /** Advanced/test hook: open the handle yourself instead of node:sqlite. */
  readonly openDb?: (path: string) => SqliteDb;
}

/** One task's standing, as the panel shows it. */
export interface TaskHistoryRow {
  /** The task name. */
  readonly task: string;
  /** Whether its most recent run succeeded. */
  readonly lastOk: boolean;
  /** When that run started (epoch ms). */
  readonly lastRunAt: number;
  /** How long it took. */
  readonly lastDurationMs: number;
  /** Successes inside the window. */
  readonly successes: number;
  /** Failures inside the window. */
  readonly failures: number;
}

/** One run in the recent feed. */
export interface TaskHistoryRun {
  /** The task name. */
  readonly task: string;
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
}

/** What a read returns — including why there is nothing, which is itself an answer. */
export interface TaskHistory {
  /** False when the database could not be read at all; `reason` says why. */
  readonly available: boolean;
  /** Why nothing is available, when it is not. */
  readonly reason?: string;
  /** The window the counts cover, in days. */
  readonly windowDays: number;
  /** One row per task that has run inside the window. */
  readonly tasks: readonly TaskHistoryRow[];
  /** The most recent runs, newest first. */
  readonly recent: readonly TaskHistoryRun[];
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
    "CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, " +
      "trigger TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, " +
      "ok INTEGER NOT NULL, detail TEXT)",
  );
  d.exec("CREATE INDEX IF NOT EXISTS runs_task_started ON runs (task, started_at DESC)");
  d.exec("CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at DESC)");
}

/**
 * A recorder to hand {@linkcode setTaskRecorder}: it writes one row per run and can never throw.
 *
 * The handle opens on the first record, not here — enabling history must not create a file. After
 * an open failure, or {@linkcode FAILURE_LATCH} consecutive write failures, the store latches off
 * for the rest of the process and every later call returns immediately.
 *
 * @param options The database path, the per-task cap, and an optional open hook.
 * @returns A function to install as the task recorder, and a `close` for tests and disposers.
 */
export function taskHistoryRecorder(
  options: TaskHistoryOptions,
): { record: (run: TaskRunRecord) => void; close: () => void } {
  const open = options.openDb ?? ((path: string) => openSqliteFile(path));
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  let db: SqliteDb | null = null;
  let disabled = false;
  let failures = 0;
  let sincePrune = 0;
  let lastPrune = 0;

  const handle = (): SqliteDb | null => {
    if (disabled) return null;
    if (db) return db;
    try {
      const opened = open(options.path);
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

  const prune = (d: SqliteDb, task: string): void => {
    const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
    d.exec("DELETE FROM runs WHERE started_at < ?", [cutoff]);
    // Per task, not global: a global cap would let a minute-cron task evict a daily task's whole
    // history and silently corrupt the quiet task's counts.
    d.exec(
      "DELETE FROM runs WHERE task = ? AND id NOT IN " +
        "(SELECT id FROM runs WHERE task = ? ORDER BY id DESC LIMIT ?)",
      [task, task, maxRuns],
    );
  };

  return {
    record(run: TaskRunRecord): void {
      const d = handle();
      if (!d) return;
      try {
        d.exec(
          "INSERT INTO runs (task, trigger, started_at, duration_ms, ok, detail) VALUES (?, ?, ?, ?, ?, ?)",
          [
            run.name,
            run.trigger,
            Math.trunc(run.startedAt),
            Math.trunc(run.durationMs),
            run.ok ? 1 : 0,
            run.detail ?? null,
          ],
        );
        failures = 0;
        sincePrune += 1;
        const now = Date.now();
        if (sincePrune >= PRUNE_EVERY && now - lastPrune >= PRUNE_INTERVAL_MS) {
          sincePrune = 0;
          lastPrune = now;
          prune(d, run.name);
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

/**
 * Read the history for a panel. Never throws: a database that is missing, unreadable or has no
 * rows yet are three different answers, and the caller has to tell them apart.
 *
 * @param options The database path and an optional open hook.
 * @param windowDays How many days the counts cover (default 7).
 * @returns The rows, the recent feed, and whether anything could be read at all.
 */
export function readTaskHistory(
  options: TaskHistoryOptions,
  windowDays = 7,
): TaskHistory {
  const open = options.openDb ?? ((path: string) => openSqliteFile(path, { readOnly: true }));
  const empty = { windowDays, tasks: [], recent: [] };
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
    const tasks = d.query<{
      task: string;
      last_ok: number;
      last_run_at: number;
      last_duration_ms: number;
      successes: number;
      failures: number;
    }>(
      "SELECT task, " +
        "(SELECT ok FROM runs r2 WHERE r2.task = r1.task ORDER BY started_at DESC LIMIT 1) AS last_ok, " +
        "MAX(started_at) AS last_run_at, " +
        "(SELECT duration_ms FROM runs r3 WHERE r3.task = r1.task ORDER BY started_at DESC LIMIT 1) AS last_duration_ms, " +
        "SUM(ok) AS successes, SUM(1 - ok) AS failures " +
        "FROM runs r1 WHERE started_at >= ? GROUP BY task ORDER BY last_run_at DESC",
      [since],
    ).map((row) => ({
      task: row.task,
      lastOk: row.last_ok === 1,
      lastRunAt: row.last_run_at,
      lastDurationMs: row.last_duration_ms,
      successes: Number(row.successes),
      failures: Number(row.failures),
    }));
    const recent = d.query<{
      task: string;
      trigger: string;
      started_at: number;
      duration_ms: number;
      ok: number;
      detail: string | null;
    }>(
      "SELECT task, trigger, started_at, duration_ms, ok, detail FROM runs ORDER BY started_at DESC LIMIT 20",
    ).map((row) => ({
      task: row.task,
      trigger: row.trigger,
      startedAt: row.started_at,
      durationMs: row.duration_ms,
      ok: row.ok === 1,
      detail: row.detail,
    }));
    return { available: true, windowDays, tasks, recent };
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
