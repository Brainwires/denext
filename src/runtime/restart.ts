// Restart and backoff: the one helper every restarting thing in denext waits with — supervised
// services (`supervise`), a sidecar's restarts (`desktop.sidecars`), a job's retries
// (`defineJob({ retry })`), a Live subscription's restarts and a channel publisher's.
//
// Pure apart from timers: no Deno APIs beyond an optional `DENEXT_LOG` read, so it is safe in a
// module the browser also loads (`channel.ts` builds a stub there and never starts a loop).

/** The longest delay a timer can hold: `setTimeout` fires at once past 2^31-1 ms (~24.8 days). */
export const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * How long to wait before restart number `n`: `initialMs`, then `factor` times that per restart,
 * capped at `maxMs`, with up to `jitter` of it taken off at random so restarts that failed
 * together do not retry together.
 */
export interface BackoffOptions {
  /** The first restart's delay in ms. */
  initialMs?: number;
  /** The longest delay in ms (at most 2^31-1, a timer's limit). */
  maxMs?: number;
  /** The growth per restart (default 2; `1` is a fixed delay). */
  factor?: number;
  /**
   * The share of each delay taken off at random, `0` to `1` (default `0.2`: a delay lands
   * between 80% and 100% of the exponential value). `0` makes the delays exact.
   */
  jitter?: number;
}

/** A validated {@link BackoffOptions}: every field present. */
export interface ResolvedBackoff {
  /** The first delay. */
  readonly initialMs: number;
  /** The cap. */
  readonly maxMs: number;
  /** The growth per restart. */
  readonly factor: number;
  /** The random share taken off. */
  readonly jitter: number;
}

/** Whether `n` is a finite, non-negative number. */
function isNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Validate a {@link BackoffOptions} over `defaults`, or throw a `TypeError` naming `label`.
 *
 * @param options What the caller passed (may be `undefined`).
 * @param defaults The values for every field it left out.
 * @param label The option's name in error messages (e.g. `"supervise: backoff"`).
 * @returns The resolved policy.
 */
export function resolveBackoff(
  options: BackoffOptions | undefined,
  defaults: ResolvedBackoff,
  label: string,
): ResolvedBackoff {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new TypeError(`${label} must be { initialMs?, maxMs?, factor?, jitter? }`);
  }
  const initialMs = options?.initialMs ?? defaults.initialMs;
  const maxMs = options?.maxMs ?? defaults.maxMs;
  const factor = options?.factor ?? defaults.factor;
  const jitter = options?.jitter ?? defaults.jitter;
  if (!isNonNegative(initialMs) || !isNonNegative(maxMs)) {
    throw new TypeError(`${label}: initialMs and maxMs must be numbers of ms (>= 0)`);
  }
  if (!isNonNegative(factor) || factor < 1) {
    throw new TypeError(`${label}: factor must be a number >= 1`);
  }
  if (!isNonNegative(jitter) || jitter > 1) {
    throw new TypeError(`${label}: jitter must be a number from 0 to 1`);
  }
  return { initialMs, maxMs: Math.min(maxMs, MAX_TIMER_DELAY), factor, jitter };
}

/**
 * The delay before restart number `attempt` (1-based): `initialMs × factor^(attempt-1)`, capped
 * at `maxMs` (and at a timer's limit), less a random share of up to `jitter`.
 *
 * @param attempt Which restart this is (`1` for the first; values below 1 count as 1).
 * @param policy The backoff.
 * @param random The random source, `[0, 1)` (default `Math.random`).
 * @returns The delay in ms, a whole number.
 */
export function backoffDelay(
  attempt: number,
  policy: ResolvedBackoff,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(
    policy.maxMs,
    policy.initialMs * policy.factor ** exponent,
    MAX_TIMER_DELAY,
  );
  if (policy.jitter === 0) return base;
  return Math.round(base * (1 - policy.jitter * random()));
}

/**
 * Wait `ms`; resolves `true` when the time passed, `false` early when `signal` aborts (at once
 * when it already has).
 *
 * @param ms The delay.
 * @param signal Ends the wait early.
 * @returns Whether the full delay passed.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
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

/**
 * The restart-intensity window: remembers when each restart happened and says how many fell
 * within the last `periodMs`. More than the allowed number in one window means a crash loop,
 * which is given up on (or, for a supervisor, escalated).
 */
export class RestartWindow {
  #times: number[] = [];
  /**
   * Start an empty window.
   *
   * @param periodMs How far back a restart still counts.
   */
  constructor(readonly periodMs: number) {}

  /**
   * Record a restart at `now` and forget the ones older than the window.
   *
   * @param now The current time (epoch ms).
   * @returns How many restarts the window now holds, this one included.
   */
  record(now: number): number {
    this.#times.push(now);
    const floor = now - this.periodMs;
    while (this.#times.length > 0 && this.#times[0] <= floor) this.#times.shift();
    return this.#times.length;
  }

  /** Forget every restart (a fresh start). */
  reset(): void {
    this.#times = [];
  }
}

/** One thing that happened to a supervised piece of work, for logs and `onEvent`. */
export interface SupervisionEvent {
  /** What happened. */
  readonly event: "start" | "exit" | "crash" | "restart" | "give-up" | "escalate" | "stop";
  /** Where: the supervisor path and child, `/`-joined (`services/queue`, `channel:orders/user:1`). */
  readonly path: string;
  /** How many times it has been restarted so far. */
  readonly restarts?: number;
  /** For `restart`: the delay before it starts again, in ms. */
  readonly delayMs?: number;
  /** For `crash` / `give-up` / `escalate`: the error's message. */
  readonly error?: string;
}

/** A sink for {@link SupervisionEvent}s. */
export type SupervisionLog = (event: SupervisionEvent) => void;

/** Whether `DENEXT_LOG=json` asks for one JSON object per log line. */
function jsonLogs(): boolean {
  try {
    const deno = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno;
    return (deno?.env?.get("DENEXT_LOG") ?? "").toLowerCase() === "json";
  } catch {
    return false; // env not permitted
  }
}

/** Whether `DENEXT_LOG` is set at all (the quiet events — start, stop, a clean exit — print then). */
function verboseLogs(): boolean {
  try {
    const deno = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno;
    return (deno?.env?.get("DENEXT_LOG") ?? "") !== "";
  } catch {
    return false;
  }
}

/** The events worth printing even when `DENEXT_LOG` is unset. */
const LOUD = new Set<SupervisionEvent["event"]>(["crash", "restart", "give-up", "escalate"]);

/**
 * The default supervision log: crashes, restarts and give-ups always (`console.error` /
 * `console.warn`); starts, stops and clean exits only when `DENEXT_LOG` is set. With
 * `DENEXT_LOG=json` each line is one JSON object (`{ level, msg: "supervision", event, path, … }`),
 * the same shape as the request log.
 *
 * @param e The event.
 */
export function defaultSupervisionLog(e: SupervisionEvent): void {
  if (!LOUD.has(e.event) && !verboseLogs()) return;
  const level = e.event === "give-up" || e.event === "escalate" || e.event === "crash"
    ? "error"
    : e.event === "restart"
    ? "warn"
    : "info";
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (jsonLogs()) {
    sink(JSON.stringify({ level, msg: "supervision", ...e }));
    return;
  }
  const parts = [`[denext] ${e.path}: ${e.event}`];
  if (e.restarts !== undefined) parts.push(`restarts=${e.restarts}`);
  if (e.delayMs !== undefined) parts.push(`in ${e.delayMs}ms`);
  if (e.error !== undefined) parts.push(`— ${e.error}`);
  sink(parts.join(" "));
}

/** An error's message for a log line (never the stack: that goes to `onError` / `lastError`). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** How a {@link restartLoop} ended. */
export type RestartLoopOutcome = "finished" | "stopped" | "gave-up";

/** Options for {@link restartLoop}. */
export interface RestartLoopOptions {
  /** The log path (`channel:orders/user:1`). */
  readonly path: string;
  /** The work: resolves when it is done, rejects when it crashed. */
  readonly run: (signal: AbortSignal, attempt: number) => unknown;
  /** Stops the loop: aborts the run's signal and ends a pending backoff wait. */
  readonly signal: AbortSignal;
  /** How often it may restart, and how long it waits before each restart. */
  readonly policy: ResolvedRestart;
  /** Where events go (default {@link defaultSupervisionLog}). */
  readonly log?: SupervisionLog;
}

/**
 * A crash happened: log it, count it in `window`, and say how long to wait before the restart —
 * or `null` (logged as a give-up) when it is one restart too many within the policy's period.
 *
 * @param crash Where it crashed, how many restarts came before, and the error.
 * @param window The restarts within the period (this one is recorded).
 * @param policy The restart policy.
 * @param log Where the events go.
 * @returns The backoff delay in ms, or `null` to give up.
 */
export function nextRestart(
  crash: { readonly path: string; readonly restarts: number; readonly error: unknown },
  window: RestartWindow,
  policy: ResolvedRestart,
  log: SupervisionLog,
): number | null {
  const { path, restarts } = crash;
  const error = errorMessage(crash.error);
  log({ event: "crash", path, restarts, error });
  const recent = window.record(Date.now());
  if (recent > policy.maxRestarts) {
    log({ event: "give-up", path, restarts, error });
    return null;
  }
  const delayMs = backoffDelay(recent, policy.backoff);
  log({ event: "restart", path, restarts: restarts + 1, delayMs });
  return delayMs;
}

/**
 * Run `run` and restart it with backoff each time it throws, until it finishes, `signal` aborts,
 * or it crashes more than `policy.maxRestarts` times within `policy.period` (then it gives up).
 * A single piece of work's supervision, without a supervisor: what a Live channel publisher runs
 * under.
 *
 * @param options The work, its stop signal and its restart policy.
 * @returns How it ended. Never rejects.
 */
export async function restartLoop(options: RestartLoopOptions): Promise<RestartLoopOutcome> {
  const { path, signal, policy } = options;
  const log = options.log ?? defaultSupervisionLog;
  const window = new RestartWindow(policy.period);
  for (let attempt = 1; !signal.aborted; attempt++) {
    try {
      await options.run(signal, attempt);
      return signal.aborted ? "stopped" : "finished";
    } catch (error) {
      if (signal.aborted) break;
      const delayMs = nextRestart({ path, restarts: attempt - 1, error }, window, policy, log);
      if (delayMs === null) return "gave-up";
      if (!(await sleepUnlessAborted(delayMs, signal))) break;
    }
  }
  return "stopped";
}

/** A restart policy for one piece of work (a Live subscription's resolver, a channel publisher). */
export interface RestartOptions {
  /** Restarts allowed within `period` before it gives up (default 5). */
  maxRestarts?: number;
  /** The window, ms (default 60000). */
  period?: number;
  /** The wait before each restart. */
  backoff?: BackoffOptions;
}

/** A validated {@link RestartOptions}. */
export interface ResolvedRestart {
  /** Restarts allowed within `period`. */
  readonly maxRestarts: number;
  /** The window, ms. */
  readonly period: number;
  /** The wait before each restart. */
  readonly backoff: ResolvedBackoff;
}

/** The defaults of {@link RestartOptions} for Live work: 5 restarts a minute, 250 ms doubling to 10 s. */
export const LIVE_RESTART_DEFAULTS: ResolvedRestart = {
  maxRestarts: 5,
  period: 60_000,
  backoff: { initialMs: 250, maxMs: 10_000, factor: 2, jitter: 0.2 },
};

/**
 * Validate a `restart` option: `true` takes the defaults, `false` / `undefined` turn restarting
 * off (`null`), an object overrides the defaults field by field.
 *
 * @param options The option as given.
 * @param defaults The defaults.
 * @param label The option's name in error messages.
 * @returns The policy, or `null` when off.
 * @throws TypeError when it is malformed.
 */
export function resolveRestart(
  options: boolean | RestartOptions | undefined,
  defaults: ResolvedRestart,
  label: string,
): ResolvedRestart | null {
  if (options === undefined || options === false) return null;
  if (options === true) return defaults;
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`${label} must be true or { maxRestarts?, period?, backoff? }`);
  }
  const maxRestarts = options.maxRestarts ?? defaults.maxRestarts;
  const period = options.period ?? defaults.period;
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0) {
    throw new TypeError(`${label}: maxRestarts must be a whole number >= 0`);
  }
  if (!isNonNegative(period) || period === 0) {
    throw new TypeError(`${label}: period must be a positive number of ms`);
  }
  return {
    maxRestarts,
    period,
    backoff: resolveBackoff(options.backoff, defaults.backoff, `${label}: backoff`),
  };
}
