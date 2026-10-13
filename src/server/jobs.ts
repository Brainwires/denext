// Scheduled/background jobs — the runtime core (registry, `defineJob`, `runJob`, and the
// scheduler). Server-only. A job is a named unit of work a project defines in `jobs/<name>.ts`
// (`export default defineJob({ handler })`); it runs on a cron schedule (declared per-job or in
// `denext.config.ts`'s `scheduledJobs`) and/or on demand (`runJob(name)` from app code, or
// `denext job <name>` from the CLI). Scheduling uses the platform's managed `Deno.cron` when it
// is available (Deno Deploy, or a self-host started with `--unstable-cron`) and falls back to a
// dependency-free minute-tick scheduler otherwise. File discovery lives in `./job-loader.ts` so
// this module — which user job files import `defineJob` from — stays lean.

import { cronError, type CronExpr, cronMatches, parseCron, toDenoCron } from "../runtime/cron.ts";
import { detachedFromRequest } from "../runtime/root-context-bridge.ts";

/** Context passed to a job's handler. */
export interface JobContext {
  /** The job's name (its path under `jobs/`, e.g. `cleanup` or `reports/daily`). */
  readonly name: string;
  /** Payload from an on-demand run (`runJob(name, payload)` / `denext job <name> --payload`). */
  readonly payload?: unknown;
  /** How this run was triggered. */
  readonly trigger: "schedule" | "manual";
  /** Aborted on server shutdown (best-effort). */
  readonly signal: AbortSignal;
  /** Which attempt this is: `1` for the first run, `2` for the first retry, … */
  readonly attempt: number;
}

/**
 * How long to wait before a retry: a number is a fixed delay in ms; the object form picks a
 * strategy (default `"exponential"`: `delayMs`, then twice that, … capped at `maxDelayMs`).
 */
export type JobBackoff = number | {
  /** `"fixed"` waits `delayMs` every time; `"exponential"` doubles it per retry. */
  strategy?: "fixed" | "exponential";
  /** The first retry's delay in ms (default 1000). */
  delayMs?: number;
  /** The longest delay in ms (default 300000 — five minutes; at most 2^31-1, a timer's limit). */
  maxDelayMs?: number;
};

/** A job's retry policy ({@linkcode JobDefinition.retry}). */
export interface JobRetry {
  /**
   * How many times a failed run is retried (`3` → up to four runs in all). A whole number,
   * 0 to 100.
   */
  attempts: number;
  /** The wait before each retry (default exponential from 1 s, capped at 5 min). */
  backoff?: JobBackoff;
}

/** A job definition passed to {@linkcode defineJob}. */
export interface JobDefinition<R = unknown> {
  /** The work to run. May be async; its resolved value is returned by {@linkcode runJob}. */
  handler: (ctx: JobContext) => R | Promise<R>;
  /** Cron schedule(s) for this job, in addition to any `scheduledJobs` config entry. */
  schedule?: string | string[];
  /** One-line description (shown by `denext job --list`). */
  description?: string;
  /**
   * Retry a failed run: the handler runs again after the backoff, up to `attempts` more times,
   * and the run settles with the last attempt's outcome. Every attempt is one row in the run
   * history (`jobs.history`). A scheduled run that is still retrying counts as running, so the
   * next matching minute does not start a second copy. A retry wait ends early, with the last
   * error, when the run's signal aborts (shutdown).
   */
  retry?: JobRetry;
}

/** A job descriptor. Returned by {@linkcode defineJob}; the shape a `jobs/` file default-exports. */
export interface Job<R = unknown> extends JobDefinition<R> {
  /** Brand: distinguishes a `defineJob(...)` result from a plain object (see {@linkcode isJob}). */
  readonly __denextJob: true;
}

/** Normalize `undefined | string | string[]` into a string array. */
function schedulesOf(schedule: string | string[] | undefined): string[] {
  return schedule == null ? [] : Array.isArray(schedule) ? schedule : [schedule];
}

/**
 * Define a scheduled/background job. Validates any declared `schedule` up front (throws on a
 * malformed cron expression). Place the result as the default export of a `jobs/<name>.ts` file,
 * or register it programmatically with {@linkcode registerJob}.
 */
export function defineJob<R>(def: JobDefinition<R>): Job<R> {
  for (const s of schedulesOf(def.schedule)) {
    const err = cronError(s);
    if (err) throw new Error(`defineJob: ${err}`);
  }
  if (def.retry !== undefined) retryPolicy(def.retry); // validate up front
  return { ...def, __denextJob: true };
}

/** The most retries a job may ask for. */
const MAX_RETRIES = 100;
/** Default first retry delay, ms. */
const DEFAULT_RETRY_DELAY = 1000;
/** Default longest retry delay, ms. */
const DEFAULT_MAX_RETRY_DELAY = 300_000;
/** The longest delay a timer can hold: `setTimeout` fires at once past 2^31-1 ms (~24.8 days). */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** A validated retry policy: how many retries, and the wait before retry `n` (1-based). */
interface RetryPolicy {
  readonly retries: number;
  readonly delay: (retry: number) => number;
}

/** Whether `n` is a finite, non-negative number of ms. */
function isDelay(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** Throw a `defineJob: retry.…` error. */
function retryError(why: string): never {
  throw new Error(`defineJob: retry.${why}`);
}

/**
 * Validate a {@link JobRetry} into a policy, or throw.
 *
 * @param retry The job's `retry` option.
 * @returns The policy.
 */
function retryPolicy(retry: JobRetry): RetryPolicy {
  if (typeof retry !== "object" || retry === null) retryError("must be { attempts, backoff? }");
  const { attempts } = retry;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > MAX_RETRIES) {
    retryError(`attempts must be a whole number 0..${MAX_RETRIES}`);
  }
  return { retries: attempts, delay: backoffDelay(retry.backoff) };
}

/** The wait before retry `n` (1-based) for a {@link JobBackoff}, validated. */
function backoffDelay(backoff: JobBackoff | undefined): (retry: number) => number {
  if (typeof backoff === "number") {
    if (!isDelay(backoff)) retryError("backoff must be a delay in ms (>= 0)");
    return () => Math.min(backoff, MAX_TIMER_DELAY);
  }
  if (backoff !== undefined && (typeof backoff !== "object" || backoff === null)) {
    retryError("backoff must be a number of ms or { strategy, delayMs, maxDelayMs }");
  }
  const { strategy = "exponential", delayMs = DEFAULT_RETRY_DELAY } = backoff ?? {};
  const max = backoff?.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY;
  if (strategy !== "fixed" && strategy !== "exponential") {
    retryError('backoff.strategy must be "fixed" or "exponential"');
  }
  if (!isDelay(delayMs) || !isDelay(max)) retryError("backoff delays must be numbers of ms (>= 0)");
  // A longer cap would overflow the timer and retry at once, not after the wait.
  const cap = Math.min(max, MAX_TIMER_DELAY);
  return strategy === "fixed"
    ? () => Math.min(delayMs, cap)
    : (n) => Math.min(delayMs * 2 ** (n - 1), cap);
}

/** True if `value` came from {@linkcode defineJob}. */
export function isJob(value: unknown): value is Job {
  return typeof value === "object" && value !== null &&
    (value as { __denextJob?: unknown }).__denextJob === true;
}

// ---- Registry --------------------------------------------------------------

const registry = new Map<string, Job>();

/** Register (or replace) a job by name — used by the `jobs/` loader and by app code. */
export function registerJob(name: string, job: Job): void {
  registry.set(name, job);
}

/** The registered job for `name`, or undefined. */
export function getJob(name: string): Job | undefined {
  return registry.get(name);
}

/** Every registered job name, sorted. */
export function jobNames(): string[] {
  return [...registry.keys()].sort();
}

/** Clear the registry (test isolation; a dev-server re-discovery). */
export function clearJobs(): void {
  registry.clear();
}

// ---- Run history seam ------------------------------------------------------
//
// Off by default, and "off" means the ORIGINAL code path: with no recorder installed, `runJob`
// runs exactly the line it always did — no timing calls, no extra promise link, nothing an
// upgraded app can observe. `bootScheduledJobs` installs one only when the project's config asks
// for it, which is why this is a seam here rather than a decision `runJob` makes.

/** One completed run, as the recorder receives it. */
export interface JobRunRecord {
  /** The job's registered name. */
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
  /** Which attempt this was (`1` = the first run); present only for a job with `retry`. */
  readonly attempt?: number;
  /** A failed attempt that will be retried; present only for a job with `retry`. */
  readonly willRetry?: boolean;
}

/** How much of an error or a string result is kept. */
const DETAIL_MAX = 2048;

let recorder: ((record: JobRunRecord) => void) | null = null;

/**
 * Install (or clear) the sink that receives one record per completed run.
 *
 * Deliberately NOT re-exported from `server/mod.ts`: re-exporting would promise apps a stable
 * extension point forever, for a feature whose whole point is to be invisible. `scheduleJobs`
 * and `clearJobs` are exported here and absent there for the same reason.
 *
 * @param fn The sink, or `null` to record nothing.
 */
export function setJobRecorder(fn: ((record: JobRunRecord) => void) | null): void {
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

// Aborted by {@link abortJobRuns} (server shutdown): every run's signal follows it, so a run
// started with no signal of its own (`runJob(name)` from a route handler) still sees shutdown.
let shutdown = new AbortController();

/**
 * Abort every in-flight job run's signal (server shutdown), then start afresh for runs that
 * begin later (a dev server re-boot). Not re-exported from `server/mod.ts`: denext's own wiring.
 */
export function abortJobRuns(): void {
  const current = shutdown;
  shutdown = new AbortController();
  current.abort();
}

/**
 * Run a job by name and return its handler's result. Throws if no such job is registered.
 * Callable from app code (a route handler, an action) to trigger work on demand. The handler's
 * `signal` aborts when `opts.signal` does and when the server shuts down.
 */
export function runJob(
  name: string,
  payload?: unknown,
  opts?: { trigger?: "schedule" | "manual"; signal?: AbortSignal },
): Promise<unknown> {
  const job = registry.get(name);
  if (!job) {
    return Promise.reject(
      new Error(`runJob: no job named "${name}" (known: ${jobNames().join(", ") || "none"})`),
    );
  }
  const signal = opts?.signal ? AbortSignal.any([opts.signal, shutdown.signal]) : shutdown.signal;
  const trigger = opts?.trigger ?? "manual";
  // A handler that throws SYNCHRONOUSLY (a guard clause before its first await) used to throw
  // straight out of `runJob`, despite the declared `Promise<unknown>` — so the scheduler's
  // `.catch(onScheduledError)` never saw it, and it escaped into the timer tick. It also meant a
  // whole class of failure could never be recorded. Converting it to a rejection here makes the
  // function honour its own type.
  const run = (attempt = 1): Promise<unknown> => {
    try {
      return Promise.resolve(job.handler({ name, payload, trigger, signal, attempt }));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  // No recorder and no retry — the default: the handler runs and its promise is returned.
  if (!recorder && !job.retry) return run();
  if (!job.retry) return recordAttempt(name, trigger, run, undefined);
  let policy: RetryPolicy;
  try {
    policy = retryPolicy(job.retry); // a job registered without `defineJob` is checked here
  } catch (err) {
    return Promise.reject(err);
  }
  return runWithRetries(name, trigger, signal, run, policy);
}

/** Whether an attempt is tagged in the record (`undefined` for a job without `retry`). */
interface AttemptTag {
  readonly attempt: number;
  /**
   * Decides, for a failed attempt, whether it will be retried — after the backoff wait, so an
   * abort during the wait is recorded as the end of the run, never as a retry that didn't come.
   */
  readonly willRetry: () => Promise<boolean>;
}

/**
 * Run one attempt, writing its record when a recorder is installed. The promise settles with
 * exactly the handler's value or exactly its error.
 */
function recordAttempt(
  name: string,
  trigger: "schedule" | "manual",
  run: (attempt?: number) => Promise<unknown>,
  tag: AttemptTag | undefined,
): Promise<unknown> {
  if (!recorder && !tag) return run();
  const startedAt = Date.now();
  const began = performance.now();
  const write = (
    ok: boolean,
    detail: string | undefined,
    willRetry: boolean,
    durationMs = Math.round(performance.now() - began),
  ): void => {
    try {
      recorder?.({
        name,
        trigger,
        startedAt,
        durationMs,
        ok,
        ...(detail === undefined ? {} : { detail }),
        ...(tag ? { attempt: tag.attempt, willRetry } : {}),
      });
    } catch { /* a run is never worth failing over its own bookkeeping */ }
  };
  // `.then(onFulfilled, onRejected)` — not `.catch`, not `.finally`. The two-argument form cannot
  // turn a rejection into a resolution, so the promise still settles with exactly the handler's
  // value or exactly its error.
  return run(tag?.attempt).then(
    (result) => {
      write(true, typeof result === "string" ? outputTail(result) : undefined, false);
      return result;
    },
    async (err) => {
      const durationMs = Math.round(performance.now() - began); // the attempt, not the wait
      const willRetry = tag ? await tag.willRetry() : false;
      write(false, errorHead(err), willRetry, durationMs);
      throw err;
    },
  );
}

/**
 * Run a job with its retry policy: attempt, and on failure wait the backoff and attempt again,
 * until one succeeds or the retries run out (the last error is thrown). An abort of `signal`
 * stops retrying — the pending wait ends at once with the last error.
 */
async function runWithRetries(
  name: string,
  trigger: "schedule" | "manual",
  signal: AbortSignal,
  run: (attempt?: number) => Promise<unknown>,
  policy: RetryPolicy,
): Promise<unknown> {
  for (let attempt = 1;; attempt++) {
    let retry = false;
    // Runs when the attempt fails: wait the backoff, unless retries are spent or it aborts.
    const willRetry = async () => {
      retry = attempt <= policy.retries && !signal.aborted &&
        await waitUnlessAborted(policy.delay(attempt), signal);
      return retry;
    };
    try {
      return await recordAttempt(name, trigger, run, { attempt, willRetry });
    } catch (err) {
      if (!retry) throw err;
    }
  }
}

/** Wait `ms`; resolves `false` early when `signal` aborts. */
function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---- Scheduling ------------------------------------------------------------

/** One (cron, job) pairing to schedule. */
export interface ScheduledEntry {
  cron: string;
  job: string;
}

/**
 * The full schedule: every `scheduledJobs` config entry (`{ cron: job | job[] }`) plus every
 * registered job's own `schedule`. Deduped by (cron, job).
 */
export function collectSchedules(
  configScheduled?: Record<string, string | string[]>,
): ScheduledEntry[] {
  const seen = new Set<string>();
  const out: ScheduledEntry[] = [];
  const add = (cron: string, job: string) => {
    const key = `${job}\0${cron}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ cron, job });
  };
  for (const [cron, jobs] of Object.entries(configScheduled ?? {})) {
    for (const job of Array.isArray(jobs) ? jobs : [jobs]) add(cron, job);
  }
  for (const [name, job] of registry) {
    for (const cron of schedulesOf(job.schedule)) add(cron, name);
  }
  return out;
}

/** Log helper: a scheduled run's rejection must never crash the process. */
function onScheduledError(name: string): (err: unknown) => void {
  return (err) => console.error(`denext: scheduled job "${name}" failed:`, err);
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
 * The name one (job, cron) pairing is registered under with `Deno.cron`.
 *
 * `Deno.cron` refuses a name outside `[A-Za-z0-9 _-]`, longer than 64 characters, or already
 * registered — and `*`, `/` and `,` are most of a cron expression, so `job@cron` was refused
 * every time. The readable part keeps the job and expression with each run of other characters
 * folded to `_`; the fingerprint keeps two schedules that fold alike (a step and a list at the
 * same position) from colliding, and stays the same across restarts so Deno Deploy sees one cron.
 *
 * @param job The job's registered name.
 * @param cron The schedule as the user wrote it.
 * @returns A name `Deno.cron` accepts, unique to the pairing.
 */
function denoCronName(job: string, cron: string): string {
  const fingerprint = fnv1a(`${job}\0${cron}`);
  const readable = `${job} ${cron}`.replace(/[^A-Za-z0-9 _-]+/g, "_");
  return `${readable.slice(0, DENO_CRON_NAME_MAX - fingerprint.length - 1)} ${fingerprint}`;
}

/**
 * Register every valid entry with the scheduler and return a disposer. Entries with a malformed
 * cron or an unknown job name are skipped with an error (never fatal). Uses `Deno.cron` when
 * available (managed, survives isolate cycling on Deno Deploy); otherwise a userland minute tick.
 */
export function scheduleJobs(entries: ScheduledEntry[]): () => void {
  const valid = entries.filter((e) => {
    const err = cronError(e.cron);
    if (err) {
      console.error(`denext: ignoring schedule for "${e.job}" — ${err}`);
      return false;
    }
    if (!registry.has(e.job)) {
      console.error(`denext: scheduled job "${e.job}" is not defined (skipping its schedule)`);
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
        // mid-job and run overlapping copies of a job that overruns its interval.
        //
        // The schedule goes through `toDenoCron`: Deno.cron numbers weekdays 1-7 from Sunday and
        // rejects `0`, so a POSIX `0 0 * * 1` (Monday) handed over verbatim would fire on Sunday.
        cron(
          denoCronName(e.job, e.cron),
          toDenoCron(e.cron),
          // A scheduled run belongs to no request, whatever context the runtime fires it in.
          () =>
            detachedFromRequest(() => runJob(e.job, undefined, { trigger: "schedule" }))
              .catch(onScheduledError(e.job)),
        );
      } catch (err) {
        console.error(`denext: Deno.cron rejected schedule for "${e.job}":`, err);
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
 * NOT overlap a job with itself. Returns a disposer that stops the tick and aborts in-flight runs.
 */
function startUserlandScheduler(entries: ScheduledEntry[]): () => void {
  const parsed: Array<{ job: string; expr: CronExpr; running: boolean }> = entries.map((e) => ({
    job: e.job,
    expr: parseCron(e.cron),
    running: false,
  }));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Seed to the boot minute so a restart during a matching minute doesn't re-fire (Deno.cron
  // never fires on registration; a crash-loop must not run a `0 3 * * *` job once per restart).
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
        void detachedFromRequest(() =>
          runJob(p.job, undefined, { trigger: "schedule", signal: controller.signal })
        )
          .catch(onScheduledError(p.job))
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
