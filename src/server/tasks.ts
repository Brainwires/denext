// Scheduled/background tasks — the runtime core (registry, `defineTask`, `runTask`, and the
// scheduler). Server-only. A task is a named unit of work a project defines in `tasks/<name>.ts`
// (`export default defineTask({ handler })`); it runs on a cron schedule (declared per-task or in
// `denext.config.ts`'s `scheduledTasks`) and/or on demand (`runTask(name)` from app code, or
// `denext task <name>` from the CLI). Scheduling uses the platform's managed `Deno.cron` when it
// is available (Deno Deploy, or a self-host started with `--unstable-cron`) and falls back to a
// dependency-free minute-tick scheduler otherwise. File discovery lives in `./task-loader.ts` so
// this module — which user task files import `defineTask` from — stays lean.

import { cronError, type CronExpr, cronMatches, parseCron, toDenoCron } from "../runtime/cron.ts";

/** Context passed to a task's handler. */
export interface TaskContext {
  /** The task's name (its path under `tasks/`, e.g. `cleanup` or `reports/daily`). */
  readonly name: string;
  /** Payload from an on-demand run (`runTask(name, payload)` / `denext task <name> --payload`). */
  readonly payload?: unknown;
  /** How this run was triggered. */
  readonly trigger: "schedule" | "manual";
  /** Aborted on server shutdown (best-effort). */
  readonly signal: AbortSignal;
}

/** A task definition passed to {@linkcode defineTask}. */
export interface TaskDefinition<R = unknown> {
  /** The work to run. May be async; its resolved value is returned by {@linkcode runTask}. */
  handler: (ctx: TaskContext) => R | Promise<R>;
  /** Cron schedule(s) for this task, in addition to any `scheduledTasks` config entry. */
  schedule?: string | string[];
  /** One-line description (shown by `denext task --list`). */
  description?: string;
}

/** A task descriptor. Returned by {@linkcode defineTask}; the shape a `tasks/` file default-exports. */
export interface Task<R = unknown> extends TaskDefinition<R> {
  /** Brand: distinguishes a `defineTask(...)` result from a plain object (see {@linkcode isTask}). */
  readonly __denextTask: true;
}

/** Normalize `undefined | string | string[]` into a string array. */
function schedulesOf(schedule: string | string[] | undefined): string[] {
  return schedule == null ? [] : Array.isArray(schedule) ? schedule : [schedule];
}

/**
 * Define a scheduled/background task. Validates any declared `schedule` up front (throws on a
 * malformed cron expression). Place the result as the default export of a `tasks/<name>.ts` file,
 * or register it programmatically with {@linkcode registerTask}.
 */
export function defineTask<R>(def: TaskDefinition<R>): Task<R> {
  for (const s of schedulesOf(def.schedule)) {
    const err = cronError(s);
    if (err) throw new Error(`defineTask: ${err}`);
  }
  return { ...def, __denextTask: true };
}

/** True if `value` came from {@linkcode defineTask}. */
export function isTask(value: unknown): value is Task {
  return typeof value === "object" && value !== null &&
    (value as { __denextTask?: unknown }).__denextTask === true;
}

// ---- Registry --------------------------------------------------------------

const registry = new Map<string, Task>();

/** Register (or replace) a task by name — used by the `tasks/` loader and by app code. */
export function registerTask(name: string, task: Task): void {
  registry.set(name, task);
}

/** The registered task for `name`, or undefined. */
export function getTask(name: string): Task | undefined {
  return registry.get(name);
}

/** Every registered task name, sorted. */
export function taskNames(): string[] {
  return [...registry.keys()].sort();
}

/** Clear the registry (test isolation; a dev-server re-discovery). */
export function clearTasks(): void {
  registry.clear();
}

// ---- Run history seam ------------------------------------------------------
//
// Off by default, and "off" means the ORIGINAL code path: with no recorder installed, `runTask`
// runs exactly the line it always did — no timing calls, no extra promise link, nothing an
// upgraded app can observe. `bootScheduledTasks` installs one only when the project's config asks
// for it, which is why this is a seam here rather than a decision `runTask` makes.

/** One completed run, as the recorder receives it. */
export interface TaskRunRecord {
  /** The task's registered name. */
  readonly name: string;
  /** What started it. */
  readonly trigger: "schedule" | "manual";
  /** When it started (epoch ms). */
  readonly startedAt: number;
  /** How long the handler took. */
  readonly durationMs: number;
  /** Whether it settled successfully. */
  readonly ok: boolean;
  /** An error's head, a string result's tail, or absent. */
  readonly detail?: string;
}

/** How much of an error or a string result is kept. */
const DETAIL_MAX = 2048;

let recorder: ((record: TaskRunRecord) => void) | null = null;

/**
 * Install (or clear) the sink that receives one record per completed run.
 *
 * Deliberately NOT re-exported from `server/mod.ts`: re-exporting would promise apps a stable
 * extension point forever, for a feature whose whole point is to be invisible. `scheduleTasks`
 * and `clearTasks` are exported here and absent there for the same reason.
 *
 * @param fn The sink, or `null` to record nothing.
 */
export function setTaskRecorder(fn: ((record: TaskRunRecord) => void) | null): void {
  recorder = fn;
}

/** An error's head — for a failure, the message and first frames are where the news is. */
function errorHead(err: unknown): string {
  const text = err instanceof Error
    ? `${err.name}: ${err.message}\n${err.stack ?? ""}`.trim()
    : String(err);
  return text.length <= DETAIL_MAX ? text : text.slice(0, DETAIL_MAX);
}

/** A string result's tail — for output, the end is where the news is. */
function outputTail(text: string): string {
  return text.length <= DETAIL_MAX ? text : text.slice(text.length - DETAIL_MAX);
}

/**
 * Run a task by name and return its handler's result. Throws if no such task is registered.
 * Callable from app code (a route handler, an action) to trigger work on demand.
 */
export function runTask(
  name: string,
  payload?: unknown,
  opts?: { trigger?: "schedule" | "manual"; signal?: AbortSignal },
): Promise<unknown> {
  const task = registry.get(name);
  if (!task) {
    return Promise.reject(
      new Error(`runTask: no task named "${name}" (known: ${taskNames().join(", ") || "none"})`),
    );
  }
  const signal = opts?.signal ?? new AbortController().signal;
  const trigger = opts?.trigger ?? "manual";
  // A handler that throws SYNCHRONOUSLY (a guard clause before its first await) used to throw
  // straight out of `runTask`, despite the declared `Promise<unknown>` — so the scheduler's
  // `.catch(onScheduledError)` never saw it, and it escaped into the timer tick. It also meant a
  // whole class of failure could never be recorded. Converting it to a rejection here makes the
  // function honour its own type.
  const run = (): Promise<unknown> => {
    try {
      return Promise.resolve(task.handler({ name, payload, trigger, signal }));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  // No recorder — the default: the handler runs and its promise is returned, nothing more.
  if (!recorder) return run();

  const startedAt = Date.now();
  const began = performance.now();
  const write = (ok: boolean, detail: string | undefined): void => {
    try {
      recorder?.({
        name,
        trigger,
        startedAt,
        durationMs: Math.round(performance.now() - began),
        ok,
        ...(detail === undefined ? {} : { detail }),
      });
    } catch { /* a run is never worth failing over its own bookkeeping */ }
  };
  // `.then(onFulfilled, onRejected)` — not `.catch`, not `.finally`. The two-argument form cannot
  // turn a rejection into a resolution, so the promise still settles with exactly the handler's
  // value or exactly its error.
  return run().then(
    (result) => {
      write(true, typeof result === "string" ? outputTail(result) : undefined);
      return result;
    },
    (err) => {
      write(false, errorHead(err));
      throw err;
    },
  );
}

// ---- Scheduling ------------------------------------------------------------

/** One (cron, task) pairing to schedule. */
export interface ScheduledEntry {
  cron: string;
  task: string;
}

/**
 * The full schedule: every `scheduledTasks` config entry (`{ cron: task | task[] }`) plus every
 * registered task's own `schedule`. Deduped by (cron, task).
 */
export function collectSchedules(
  configScheduled?: Record<string, string | string[]>,
): ScheduledEntry[] {
  const seen = new Set<string>();
  const out: ScheduledEntry[] = [];
  const add = (cron: string, task: string) => {
    const key = `${task}\0${cron}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ cron, task });
  };
  for (const [cron, tasks] of Object.entries(configScheduled ?? {})) {
    for (const task of Array.isArray(tasks) ? tasks : [tasks]) add(cron, task);
  }
  for (const [name, task] of registry) {
    for (const cron of schedulesOf(task.schedule)) add(cron, name);
  }
  return out;
}

/** Log helper: a scheduled run's rejection must never crash the process. */
function onScheduledError(name: string): (err: unknown) => void {
  return (err) => console.error(`denext: scheduled task "${name}" failed:`, err);
}

/** The `Deno.cron` reference when the runtime exposes it (Deno Deploy / `--unstable-cron`), else null. */
function denoCron():
  | ((name: string, schedule: string, handler: () => unknown) => void)
  | null {
  const c = (Deno as { cron?: unknown }).cron;
  return typeof c === "function"
    ? c as (name: string, schedule: string, handler: () => unknown) => void
    : null;
}

/** What `Deno.cron` allows in a registration name: `[A-Za-z0-9 _-]`, at most this many characters. */
const DENO_CRON_NAME_MAX = 64;

/** FNV-1a over a string, as 8 hex digits — a cheap, synchronous fingerprint for a name. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The name one (task, cron) pairing is registered under with `Deno.cron`.
 *
 * `Deno.cron` refuses a name outside `[A-Za-z0-9 _-]`, longer than 64 characters, or already
 * registered — and `*`, `/` and `,` are most of a cron expression, so `task@cron` was refused
 * every time. The readable part keeps the task and expression with each run of other characters
 * folded to `_`; the fingerprint keeps two schedules that fold alike (a step and a list at the
 * same position) from colliding, and stays the same across restarts so Deno Deploy sees one cron.
 *
 * @param task The task's registered name.
 * @param cron The schedule as the user wrote it.
 * @returns A name `Deno.cron` accepts, unique to the pairing.
 */
function denoCronName(task: string, cron: string): string {
  const fingerprint = fnv1a(`${task}\0${cron}`);
  const readable = `${task} ${cron}`.replace(/[^A-Za-z0-9 _-]+/g, "_");
  return `${readable.slice(0, DENO_CRON_NAME_MAX - fingerprint.length - 1)} ${fingerprint}`;
}

/**
 * Register every valid entry with the scheduler and return a disposer. Entries with a malformed
 * cron or an unknown task name are skipped with an error (never fatal). Uses `Deno.cron` when
 * available (managed, survives isolate cycling on Deno Deploy); otherwise a userland minute tick.
 */
export function scheduleTasks(entries: ScheduledEntry[]): () => void {
  const valid = entries.filter((e) => {
    const err = cronError(e.cron);
    if (err) {
      console.error(`denext: ignoring schedule for "${e.task}" — ${err}`);
      return false;
    }
    if (!registry.has(e.task)) {
      console.error(`denext: scheduled task "${e.task}" is not defined (skipping its schedule)`);
      return false;
    }
    return true;
  });
  if (valid.length === 0) return () => {};

  const cron = denoCron();
  if (cron) {
    for (const e of valid) {
      try {
        // RETURN the promise: Deno.cron keeps the isolate alive until it settles and uses it to
        // serialize runs (no overlap). A void handler would let Deno Deploy freeze the isolate
        // mid-task and run overlapping copies of a task that overruns its interval.
        //
        // The schedule goes through `toDenoCron`: Deno.cron numbers weekdays 1-7 from Sunday and
        // rejects `0`, so a POSIX `0 0 * * 1` (Monday) handed over verbatim would fire on Sunday.
        cron(
          denoCronName(e.task, e.cron),
          toDenoCron(e.cron),
          () => runTask(e.task, undefined, { trigger: "schedule" }).catch(onScheduledError(e.task)),
        );
      } catch (err) {
        console.error(`denext: Deno.cron rejected schedule for "${e.task}":`, err);
      }
    }
    return () => {}; // Deno.cron registrations live for the process; nothing to dispose.
  }
  return startUserlandScheduler(valid);
}

/**
 * Fallback scheduler: a self-rescheduling tick (every ~15 s, so a drifted timer still catches the
 * minute) that fires each entry once per matching minute. UTC, minute granularity — matching
 * `Deno.cron` (which schedules in UTC). Like `Deno.cron` it does NOT fire on registration and does
 * NOT overlap a task with itself. Returns a disposer that stops the tick and aborts in-flight runs.
 */
function startUserlandScheduler(entries: ScheduledEntry[]): () => void {
  const parsed: Array<{ task: string; expr: CronExpr; running: boolean }> = entries.map((e) => ({
    task: e.task,
    expr: parseCron(e.cron),
    running: false,
  }));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Seed to the boot minute so a restart during a matching minute doesn't re-fire (Deno.cron
  // never fires on registration; a crash-loop must not run a `0 3 * * *` task once per restart).
  let lastMinute = Math.floor(Date.now() / 60000);
  const tick = () => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60000);
    // Strictly later, not merely different: a wall clock stepped BACKWARDS (an NTP correction)
    // would otherwise re-fire a minute that already ran. Like Deno.cron, a minute fires at most
    // once — after a backwards step nothing fires until the clock passes the last fired minute.
    if (minute > lastMinute) {
      lastMinute = minute;
      for (const p of parsed) {
        if (!cronMatches(p.expr, now)) continue;
        if (p.running) continue; // overlap guard: a still-in-flight run is not started again
        p.running = true;
        void runTask(p.task, undefined, { trigger: "schedule", signal: controller.signal })
          .catch(onScheduledError(p.task))
          .finally(() => {
            p.running = false;
          });
      }
    }
    timer = setTimeout(tick, 15000 - (Date.now() % 15000));
  };
  tick();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller.abort(); // best-effort drain of in-flight scheduled runs
  };
}
