// Supervision for long-lived server work: `supervise({ children, strategy, intensity, period })`
// and `defineService({ start, stop })`. Inspired by Erlang/OTP supervisors, and honest about the
// difference: this gives restart semantics — a crashed service is started again, a crash loop is
// escalated, shutdown runs in reverse start order — NOT process isolation. Every service runs on
// the same event loop and heap as the app; nothing here preempts a busy loop, bounds memory, or
// contains a synchronous `while (true)`. See https://denext.dev/docs/services.
//
// Server-only. The `services/` directory convention (discovery, the root supervisor, the drain
// hook, the status snapshot) lives in `./service-loader.ts`.

import {
  backoffDelay,
  type BackoffOptions,
  defaultSupervisionLog,
  errorMessage,
  resolveBackoff,
  type ResolvedBackoff,
  RestartWindow,
  type SupervisionLog,
} from "../runtime/restart.ts";
import { runJob } from "./jobs.ts";
import { inRootContext } from "./root-context.ts";

export type { BackoffOptions, SupervisionEvent, SupervisionLog } from "../runtime/restart.ts";

/**
 * When a child that ended is started again: `"always"` (even after a clean exit), `"crash"`
 * (only after it threw — the default), or `"never"` (it stays `failed` / `stopped`).
 */
export type RestartPolicy = "always" | "crash" | "never";

/**
 * Which children restart when one crashes: `"one_for_one"` restarts just that child,
 * `"one_for_all"` stops every other child and restarts them all, `"rest_for_one"` restarts it
 * and every child started after it (they may depend on it).
 */
export type SupervisionStrategy = "one_for_one" | "one_for_all" | "rest_for_one";

/** What a service's `start` receives. */
export interface ServiceContext {
  /** The service's path in the supervision tree (`services/queue`). */
  readonly name: string;
  /**
   * Aborted when the service is being stopped (shutdown, a restart of its siblings, or its
   * supervisor giving up). Pass it to `fetch`, a queue read, a timer — stopping is cooperative.
   */
  readonly signal: AbortSignal;
  /** Resolves when {@linkcode ServiceContext.signal} aborts: `await ctx.stopped` holds a resource open. */
  readonly stopped: Promise<void>;
  /** Which run this is: `1` for the first start, `2` after the first restart, … */
  readonly attempt: number;
  /**
   * Report a crash from outside the `start` promise (an error event, a socket's `close`): the run
   * ends as if `start` had rejected with `error`.
   */
  fail(error: unknown): void;
}

/** A service definition passed to {@linkcode defineService}. */
export interface ServiceDefinition {
  /** Its name in the tree (default: the `services/` file path, or `child-<index>`). */
  name?: string;
  /**
   * The service's life. Its promise settling IS the service ending: resolving is a clean exit,
   * rejecting (or throwing) is a crash. A service that only holds a resource awaits
   * `ctx.stopped` before it returns.
   */
  start(ctx: ServiceContext): Promise<void> | void;
  /** Called after the signal aborts, to stop what the signal cannot reach. May be async. */
  stop?(): Promise<void> | void;
  /** When it is started again after it ended (default `"crash"`). */
  restart?: RestartPolicy;
  /** How long a stop may take before it is abandoned (logged), ms (default 5000). */
  shutdownMs?: number;
}

/** A service: returned by {@linkcode defineService}; the shape a `services/` file default-exports. */
export interface Service extends ServiceDefinition {
  /** Brand: distinguishes a `defineService(...)` result from a plain object. */
  readonly __denextService: true;
}

/** Where a child or supervisor is in its life. */
export type SupervisionState =
  | "idle"
  | "running"
  | "restarting"
  | "stopping"
  | "stopped"
  | "failed";

/** One child's status. */
export interface ChildStatus {
  /** Its name. */
  readonly name: string;
  /** Its path in the tree (`services/workers/queue`). */
  readonly path: string;
  /** A service, or a nested supervisor ({@linkcode SupervisorStatus}). */
  readonly kind: "service" | "supervisor";
  /** Its state. */
  readonly state: SupervisionState;
  /** How many times its supervisor has restarted it. */
  readonly restarts: number;
  /** When it entered `state` (epoch ms). */
  readonly since: number;
  /** While `restarting`: when it starts again (epoch ms). */
  readonly retryAt?: number;
  /** The last crash: the error's message and when (epoch ms). */
  readonly lastError?: { readonly message: string; readonly at: number };
}

/** A supervisor's status: its own, plus its children's, in start order. */
export interface SupervisorStatus extends ChildStatus {
  /** Always `"supervisor"`. */
  readonly kind: "supervisor";
  /** Its strategy. */
  readonly strategy: SupervisionStrategy;
  /** Restarts allowed within {@linkcode SupervisorStatus.period} before it fails. */
  readonly intensity: number;
  /** The intensity window, ms. */
  readonly period: number;
  /** Its children. */
  readonly children: readonly (ChildStatus | SupervisorStatus)[];
}

/** The options of {@linkcode supervise}. */
export interface SuperviseOptions {
  /** Its name in the tree (default `"supervisor"`). */
  name?: string;
  /** What it supervises, started in this order and stopped in the reverse. */
  children: readonly (Service | Supervisor)[];
  /** Which children restart when one crashes (default `"one_for_one"`). */
  strategy?: SupervisionStrategy;
  /**
   * How many restarts (of all its children together) it allows within `period` (default 3).
   * One more and it gives up: it stops every child and fails, which its own supervisor sees as a
   * crash — or, at the top of the tree, the app's error reporting does.
   */
  intensity?: number;
  /** The intensity window in milliseconds (default 5000). */
  period?: number;
  /**
   * The wait before a child starts again, growing per restart of that child within `period`
   * (default: 100 ms doubling to 30 s, with 20% jitter).
   */
  backoff?: BackoffOptions;
  /** When nested: whether its supervisor restarts it after it failed (default `"crash"`). */
  restart?: RestartPolicy;
  /** When nested: how long its supervisor waits for it to stop, ms (default 30000). */
  shutdownMs?: number;
  /**
   * At the top of the tree: called with the {@linkcode SupervisorError} when it gives up (besides
   * the log and the `instrumentation.ts` `onServiceError` hook). A throw from it is logged.
   */
  onError?: (error: SupervisorError) => void;
  /** Where its events go: `false` silences them; a function replaces the default log. */
  log?: false | SupervisionLog;
}

/** A supervisor: returned by {@linkcode supervise}; nest it as another supervisor's child. */
export interface Supervisor {
  /** Brand: distinguishes a `supervise(...)` result. */
  readonly __denextSupervisor: true;
  /** Its name. */
  readonly name: string;
  /**
   * Start every child, in order. On a supervisor that is not a child of another, this also
   * registers it for {@linkcode supervisionStatus} and the server's drain. A no-op while running.
   */
  start(): Promise<void>;
  /** Stop every child in reverse start order, each within its `shutdownMs`. Resolves when done. */
  stop(): Promise<void>;
  /** A snapshot of its status and its children's. */
  status(): SupervisorStatus;
  /**
   * Call `listener` after any state change in its tree.
   *
   * @returns Unsubscribes.
   */
  onStatus(listener: () => void): () => void;
  /**
   * Settles when the current run ends: resolves on {@linkcode Supervisor.stop}, rejects with a
   * {@linkcode SupervisorError} when it gave up.
   */
  readonly done: Promise<void>;
}

/** Thrown (as `done`'s rejection, and to `onError`) when a supervisor exceeds its intensity. */
export class SupervisorError extends Error {
  /** The supervisor's path in the tree. */
  readonly path: string;
  /**
   * Build the error a supervisor fails with.
   *
   * @param path The supervisor's path.
   * @param cause The crash that tipped it over.
   * @param intensity Its intensity.
   * @param period Its period, ms.
   */
  constructor(path: string, cause: unknown, intensity: number, period: number) {
    super(
      `supervisor ${path} gave up: more than ${intensity} restart(s) within ${period} ms ` +
        `(last: ${errorMessage(cause)})`,
      { cause },
    );
    this.name = "SupervisorError";
    this.path = path;
  }
}

// ---- Services ---------------------------------------------------------------

const RESTART_POLICIES: readonly RestartPolicy[] = ["always", "crash", "never"];

/** Throw unless `value` is a restart policy. */
function checkRestart(value: unknown, label: string): void {
  if (value !== undefined && !RESTART_POLICIES.includes(value as RestartPolicy)) {
    throw new TypeError(`${label}: restart must be "always", "crash" or "never"`);
  }
}

/** Throw unless `value` is a positive number of ms (or absent). */
function checkMs(value: unknown, label: string, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label}: ${field} must be a positive number of ms`);
  }
}

/**
 * Define a supervised service: a long-lived piece of server work (a queue consumer, a socket to
 * an upstream, a cache warmer) that a supervisor starts, restarts when it crashes, and stops on
 * shutdown. Default-export it from `services/<name>.ts`, or pass it to {@linkcode supervise}.
 *
 * @param def `start(ctx)` (its promise is the service's life), and optionally `stop()`,
 *   `restart`, `shutdownMs` and `name`.
 * @returns The service.
 * @throws TypeError when `start` is not a function or an option is malformed.
 */
export function defineService(def: ServiceDefinition): Service {
  if (typeof def?.start !== "function") {
    throw new TypeError("defineService: `start(ctx)` is required");
  }
  if (def.stop !== undefined && typeof def.stop !== "function") {
    throw new TypeError("defineService: `stop` must be a function");
  }
  checkRestart(def.restart, "defineService");
  checkMs(def.shutdownMs, "defineService", "shutdownMs");
  return { ...def, __denextService: true };
}

/** True if `value` came from {@linkcode defineService}. */
export function isService(value: unknown): value is Service {
  return typeof value === "object" && value !== null &&
    (value as { __denextService?: unknown }).__denextService === true;
}

/** True if `value` came from {@linkcode supervise}. */
export function isSupervisor(value: unknown): value is Supervisor {
  return typeof value === "object" && value !== null &&
    (value as { __denextSupervisor?: unknown }).__denextSupervisor === true;
}

/** Options shared by the adapters that turn existing primitives into services. */
export interface ServiceAdapterOptions {
  /** Its name in the tree. */
  name?: string;
  /** When it is started again after it ended (default `"crash"`). */
  restart?: RestartPolicy;
  /** How long a stop may take, ms (default 5000). */
  shutdownMs?: number;
}

/**
 * Supervise a job: a `jobs/<name>.ts` job whose handler is a long-running loop (a queue
 * consumer, a change-feed tail) runs as a service. Its handler's `signal` aborts when the service
 * stops; a throw (after the job's own `retry`, if any) is a crash.
 *
 * @param job The job's registered name.
 * @param options `payload` for the handler, plus the service options (name default `job:<job>`).
 * @returns The service.
 */
export function jobService(
  job: string,
  options: ServiceAdapterOptions & { payload?: unknown } = {},
): Service {
  return defineService({
    name: options.name ?? `job:${job}`,
    restart: options.restart,
    shutdownMs: options.shutdownMs,
    start: async ({ signal }) => {
      await runJob(job, options.payload, { signal });
    },
  });
}

/** The part of a Deno Desktop sidecar handle ({@linkcode sidecarService}) a supervisor uses. */
export interface SupervisableSidecar {
  /** The sidecar's name. */
  readonly name: string;
  /** Its current status. */
  readonly status: {
    readonly state: string;
    readonly lastExit?: {
      readonly error?: string;
      readonly code?: number;
      readonly signal?: string;
    };
  };
  /** Call `listener` on every status change; returns an unsubscribe. */
  onStatus(listener: (status: SupervisableSidecar["status"]) => void): () => void;
  /** Stop it (if running) and start it again. */
  restart(): Promise<void>;
  /** Stop it. */
  stop(): Promise<void>;
}

/** The sidecar states in which it is up or on its way up (its own restarts included). */
const SIDECAR_LIVE = new Set(["starting", "ready", "backoff"]);

/** Why a sidecar ended, as an Error. */
function sidecarFailure(sidecar: SupervisableSidecar): Error {
  const exit = sidecar.status.lastExit;
  const why = exit?.error ??
    (exit?.signal ? `signal ${exit.signal}` : exit?.code !== undefined ? `code ${exit.code}` : "");
  return new Error(`sidecar ${sidecar.name} failed${why ? `: ${why}` : ""}`);
}

/**
 * Supervise a Deno Desktop sidecar (`app.sidecar(name)` from `runDesktop`). The sidecar keeps its
 * own restart-with-backoff; the supervisor steps in once that gives up (`failed`): it counts as a
 * crash, so the strategy and intensity apply, and a restart starts it with a fresh attempt count.
 *
 * @param sidecar The handle.
 * @param options The service options (name default `sidecar:<name>`).
 * @returns The service.
 */
export function sidecarService(
  sidecar: SupervisableSidecar,
  options: ServiceAdapterOptions = {},
): Service {
  return defineService({
    name: options.name ?? `sidecar:${sidecar.name}`,
    restart: options.restart,
    shutdownMs: options.shutdownMs,
    start: async ({ signal }) => {
      if (!SIDECAR_LIVE.has(sidecar.status.state)) await sidecar.restart();
      await new Promise<void>((resolve, reject) => {
        const settle = (fn: () => void) => {
          off();
          signal.removeEventListener("abort", onAbort);
          fn();
        };
        const check = (status: SupervisableSidecar["status"]) => {
          if (status.state === "failed") settle(() => reject(sidecarFailure(sidecar)));
          else if (status.state === "stopped") settle(resolve);
        };
        const onAbort = () => settle(resolve);
        const off = sidecar.onStatus(check);
        signal.addEventListener("abort", onAbort, { once: true });
        check(sidecar.status);
      });
    },
    stop: () => sidecar.stop(),
  });
}

// ---- The supervisor ----------------------------------------------------------

/** The defaults of {@linkcode SuperviseOptions}. */
const DEFAULTS = {
  intensity: 3,
  period: 5_000,
  serviceShutdownMs: 5_000,
  supervisorShutdownMs: 30_000,
  backoff: { initialMs: 100, maxMs: 30_000, factor: 2, jitter: 0.2 } satisfies ResolvedBackoff,
} as const;

const STRATEGIES: readonly SupervisionStrategy[] = ["one_for_one", "one_for_all", "rest_for_one"];

/** How a child runs, whatever it is. */
interface Driver {
  readonly name: string;
  readonly kind: "service" | "supervisor";
  readonly restart: RestartPolicy;
  readonly shutdownMs: number;
  /** One run: settles when the child ends (rejects on a crash). */
  run(path: string, signal: AbortSignal, attempt: number): Promise<void>;
  /** The cooperative stop beyond the signal. */
  stop(): Promise<void> | void;
  /** The nested supervisor, for its status. */
  readonly nested?: SupervisorImpl;
}

/** A crash, or a clean end (`crashed: false`). */
interface Exit {
  readonly crashed: boolean;
  readonly error?: unknown;
}

/** One child as its supervisor tracks it. */
interface ChildRecord {
  readonly driver: Driver;
  readonly index: number;
  state: SupervisionState;
  since: number;
  restarts: number;
  attempt: number;
  retryAt?: number;
  lastError?: { message: string; at: number };
  /** Bumped by every launch and stop: an exit of an older run is ignored. */
  gen: number;
  abort?: AbortController;
  /** The current run, settled either way (what a stop waits for). */
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  /** This child's restarts within the period: how far its backoff has grown. */
  readonly window: RestartWindow;
}

/** A promise with its settlers. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  const d = Promise.withResolvers<void>();
  d.promise.catch(() => {}); // a top-level supervisor's `done` may have no listener
  return d;
}

/** The driver of a service. */
function serviceDriver(service: Service, index: number): Driver {
  return {
    name: service.name ?? `child-${index}`,
    kind: "service",
    restart: service.restart ?? "crash",
    shutdownMs: service.shutdownMs ?? DEFAULTS.serviceShutdownMs,
    run: (path, signal, attempt) => runService(service, path, signal, attempt),
    stop: () => service.stop?.(),
  };
}

/** One run of a service, in the root context: its `start` promise raced against `ctx.fail`. */
function runService(
  service: Service,
  path: string,
  signal: AbortSignal,
  attempt: number,
): Promise<void> {
  const failed = Promise.withResolvers<never>();
  failed.promise.catch(() => {});
  const stopped = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const ctx: ServiceContext = {
    name: path,
    signal,
    stopped,
    attempt,
    fail: (error) => failed.reject(error),
  };
  // A service serves the process, not whichever request happened to start the server's boot.
  const started = inRootContext(() => Promise.resolve().then(() => service.start(ctx)));
  return Promise.race([started, failed.promise]).then(() => {});
}

/** The driver of a nested supervisor. */
function supervisorDriver(sup: SupervisorImpl): Driver {
  return {
    name: sup.name,
    kind: "supervisor",
    restart: sup.restartPolicy,
    shutdownMs: sup.shutdownMs,
    run: async () => {
      await sup.start();
      await sup.done;
    },
    stop: () => sup.stop(),
    nested: sup,
  };
}

/** Whether a child that ended this way is started again under `policy`. */
function restarts(policy: RestartPolicy, exit: Exit): boolean {
  return policy === "always" || (policy === "crash" && exit.crashed);
}

/** Wait for `p` up to `ms`; resolves whether it settled in time. */
function settledWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([p.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

/** The process-wide list of started top-level supervisors (shared across module copies). */
const REGISTRY = Symbol.for("denext.supervisors");

function topLevel(): SupervisorImpl[] {
  const holder = globalThis as { [REGISTRY]?: SupervisorImpl[] };
  return holder[REGISTRY] ??= [];
}

/** The hook a top-level supervisor reports its failure to (`instrumentation.ts` `onServiceError`). */
let reporter: ((error: SupervisorError) => void | Promise<void>) | null = null;

/**
 * Install (or clear) the process-wide failure reporter — denext's boot passes the project's
 * `onServiceError` instrumentation hook. Not re-exported from `server/mod.ts`.
 *
 * @param fn The reporter, or `null`.
 */
export function setSupervisionReporter(
  fn: ((error: SupervisorError) => void | Promise<void>) | null,
): void {
  reporter = fn;
}

/** Validate {@linkcode SuperviseOptions}, or throw. */
function checkOptions(options: SuperviseOptions): void {
  if (!options || !Array.isArray(options.children)) {
    throw new TypeError("supervise: `children` must be an array of services and supervisors");
  }
  if (options.strategy !== undefined && !STRATEGIES.includes(options.strategy)) {
    throw new TypeError(`supervise: strategy must be one of ${STRATEGIES.join(", ")}`);
  }
  const { intensity } = options;
  if (intensity !== undefined && (!Number.isInteger(intensity) || intensity < 0)) {
    throw new TypeError("supervise: intensity must be a whole number >= 0");
  }
  checkMs(options.period, "supervise", "period");
  checkMs(options.shutdownMs, "supervise", "shutdownMs");
  checkRestart(options.restart, "supervise");
}

class SupervisorImpl implements Supervisor {
  readonly __denextSupervisor = true as const;
  #name: string;
  /** Whether `name` was given (a `services/` file names a supervisor that has none). */
  readonly #named: boolean;
  readonly strategy: SupervisionStrategy;
  readonly intensity: number;
  readonly period: number;
  readonly backoff: ResolvedBackoff;
  readonly restartPolicy: RestartPolicy;
  readonly shutdownMs: number;
  readonly #onError?: (error: SupervisorError) => void;
  readonly #log?: false | SupervisionLog;
  readonly #children: ChildRecord[];
  readonly #window: RestartWindow;
  readonly #listeners = new Set<() => void>();
  #parent: SupervisorImpl | null = null;
  #state: SupervisionState = "idle";
  #since = Date.now();
  #done = deferred();
  #ending: Promise<void> | null = null;
  #lastError?: { message: string; at: number };

  constructor(options: SuperviseOptions) {
    checkOptions(options);
    this.#name = options.name ?? "supervisor";
    this.#named = options.name !== undefined;
    this.strategy = options.strategy ?? "one_for_one";
    this.intensity = options.intensity ?? DEFAULTS.intensity;
    this.period = options.period ?? DEFAULTS.period;
    this.backoff = resolveBackoff(options.backoff, DEFAULTS.backoff, "supervise: backoff");
    this.restartPolicy = options.restart ?? "crash";
    this.shutdownMs = options.shutdownMs ?? DEFAULTS.supervisorShutdownMs;
    this.#onError = options.onError;
    this.#log = options.log;
    this.#window = new RestartWindow(this.period);
    this.#children = options.children.map((child, index) => this.#record(child, index));
    const names = new Set<string>();
    for (const { driver } of this.#children) {
      if (names.has(driver.name)) {
        throw new TypeError(`supervise: two children of "${this.name}" are named "${driver.name}"`);
      }
      names.add(driver.name);
    }
  }

  /** Wrap one child in its record (adopting a nested supervisor). */
  #record(child: Service | Supervisor, index: number): ChildRecord {
    let driver: Driver;
    if (child instanceof SupervisorImpl) {
      if (child.#parent) throw new TypeError(`supervise: "${child.name}" already has a supervisor`);
      child.#parent = this;
      driver = supervisorDriver(child);
    } else if (isService(child)) {
      driver = serviceDriver(child, index);
    } else {
      throw new TypeError(
        `supervise: child ${index} is neither defineService(...) nor supervise(...)`,
      );
    }
    return {
      driver,
      index,
      state: "idle",
      since: Date.now(),
      restarts: 0,
      attempt: 0,
      gen: 0,
      window: new RestartWindow(this.period),
    };
  }

  get name(): string {
    return this.#name;
  }

  /** Name it after its `services/` file, unless its options named it. */
  adoptName(name: string): void {
    if (!this.#named && this.#state === "idle") this.#name = name;
  }

  /** Its path: its supervisor's path, then its name. */
  get path(): string {
    return this.#parent ? `${this.#parent.path}/${this.name}` : this.name;
  }

  get done(): Promise<void> {
    return this.#done.promise;
  }

  /** Emit an event to the configured log (inherited from its supervisor). */
  #emit(event: Parameters<SupervisionLog>[0]): void {
    const log = this.#logSink();
    if (!log) return;
    try {
      log(event);
    } catch { /* a log sink never breaks supervision */ }
  }

  #logSink(): SupervisionLog | null {
    if (this.#log === false) return null;
    if (this.#log) return this.#log;
    return this.#parent ? this.#parent.#logSink() : defaultSupervisionLog;
  }

  /** Tell listeners (here and up the tree) that something changed. */
  #changed(): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn();
      } catch { /* a listener never breaks supervision */ }
    }
    if (this.#parent) this.#parent.#changed();
  }

  #setState(state: SupervisionState): void {
    this.#state = state;
    this.#since = Date.now();
    this.#changed();
  }

  #setChild(rec: ChildRecord, state: SupervisionState, retryAt?: number): void {
    rec.state = state;
    rec.since = Date.now();
    rec.retryAt = retryAt;
    this.#changed();
  }

  onStatus(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.#state === "running" || this.#state === "stopping") return Promise.resolve();
    this.#done = deferred();
    this.#ending = null;
    this.#window.reset();
    if (!this.#parent && !topLevel().includes(this)) topLevel().push(this);
    this.#setState("running");
    this.#emit({ event: "start", path: this.path });
    for (const rec of this.#children) {
      rec.window.reset();
      this.#launch(rec);
    }
    return Promise.resolve();
  }

  /** Start one run of a child. */
  #launch(rec: ChildRecord): void {
    const gen = ++rec.gen;
    const abort = new AbortController();
    rec.abort = abort;
    rec.attempt++;
    if (rec.timer !== undefined) clearTimeout(rec.timer);
    rec.timer = undefined;
    this.#setChild(rec, "running");
    const path = `${this.path}/${rec.driver.name}`;
    const run = Promise.resolve().then(() => rec.driver.run(path, abort.signal, rec.attempt));
    rec.running = run.then(() => {}, () => {});
    run.then(
      () => this.#onExit(rec, gen, { crashed: false }),
      (error) => this.#onExit(rec, gen, { crashed: true, error }),
    );
  }

  /** A child's run ended: restart it (and its strategy's siblings), leave it, or give up. */
  #onExit(rec: ChildRecord, gen: number, exit: Exit): void {
    if (gen !== rec.gen || this.#state !== "running") return; // stopped on purpose, or stale
    rec.abort?.abort(); // whatever it left running is told to stop
    const path = this.#noteExit(rec, exit);
    if (!restarts(rec.driver.restart, exit)) {
      this.#setChild(rec, exit.crashed ? "failed" : "stopped");
      return;
    }
    if (this.#window.record(Date.now()) > this.intensity) {
      void this.#escalate(exit.crashed ? exit.error : new Error(`${path} kept exiting`));
      return;
    }
    const delay = backoffDelay(rec.window.record(Date.now()), this.backoff);
    void this.#restart(rec, delay);
  }

  /** Record and log how a child's run ended; returns its path. */
  #noteExit(rec: ChildRecord, exit: Exit): string {
    const path = `${this.path}/${rec.driver.name}`;
    if (!exit.crashed) {
      this.#emit({ event: "exit", path, restarts: rec.restarts });
      return path;
    }
    rec.lastError = { message: errorMessage(exit.error), at: Date.now() };
    this.#emit({ event: "crash", path, restarts: rec.restarts, error: rec.lastError.message });
    return path;
  }

  /** The children a crash of `rec` restarts, per the strategy. */
  #restartSet(rec: ChildRecord): ChildRecord[] {
    if (this.strategy === "one_for_one") return [rec];
    if (this.strategy === "one_for_all") return [...this.#children];
    return this.#children.slice(rec.index);
  }

  /** Stop the siblings the strategy names (reverse order), then start them all after `delay`. */
  async #restart(rec: ChildRecord, delay: number): Promise<void> {
    const set = this.#restartSet(rec);
    this.#setChild(rec, "restarting");
    rec.gen++;
    const siblings = set.filter((r) => r !== rec).reverse();
    for (const sibling of siblings) await this.#stopChild(sibling);
    if (this.#state !== "running") return;
    const retryAt = Date.now() + delay;
    for (const r of set) {
      // A `restart: "never"` sibling stopped for the group stays stopped (OTP's temporary child).
      if (r !== rec && r.driver.restart === "never") continue;
      r.restarts++;
      this.#emit({
        event: "restart",
        path: `${this.path}/${r.driver.name}`,
        restarts: r.restarts,
        delayMs: delay,
      });
      this.#setChild(r, "restarting", retryAt);
      if (r.timer !== undefined) clearTimeout(r.timer);
      // In order, with one delay: timers of equal delay fire in the order they were set, so the
      // group restarts in start order.
      r.timer = setTimeout(() => {
        r.timer = undefined;
        if (this.#state === "running" && r.state === "restarting") this.#launch(r);
      }, delay);
    }
  }

  /** Stop one child: abort its signal, call its `stop`, wait up to its `shutdownMs`. */
  async #stopChild(rec: ChildRecord): Promise<void> {
    if (rec.timer !== undefined) clearTimeout(rec.timer);
    rec.timer = undefined;
    rec.gen++;
    if (rec.state !== "running") {
      if (rec.state === "restarting") this.#setChild(rec, "stopped");
      return;
    }
    this.#setChild(rec, "stopping");
    rec.abort?.abort();
    const path = `${this.path}/${rec.driver.name}`;
    try {
      await rec.driver.stop();
    } catch (error) {
      this.#emit({ event: "crash", path, restarts: rec.restarts, error: errorMessage(error) });
    }
    const inTime = await settledWithin(rec.running ?? Promise.resolve(), rec.driver.shutdownMs);
    if (!inTime) {
      this.#emit({
        event: "give-up",
        path,
        restarts: rec.restarts,
        error: `did not stop within ${rec.driver.shutdownMs} ms; abandoned`,
      });
    }
    this.#setChild(rec, "stopped");
    this.#emit({ event: "stop", path, restarts: rec.restarts });
  }

  /** Stop every child, last-started first. */
  async #stopAll(): Promise<void> {
    for (const rec of [...this.#children].reverse()) await this.#stopChild(rec);
  }

  stop(): Promise<void> {
    if (this.#ending) return this.#ending;
    if (this.#state !== "running") return Promise.resolve();
    this.#setState("stopping");
    this.#ending = this.#stopAll().then(() => {
      this.#setState("stopped");
      this.#emit({ event: "stop", path: this.path });
      this.#unregister();
      this.#done.resolve();
    });
    return this.#ending;
  }

  /** More than `intensity` restarts within `period`: stop everything and fail upward. */
  #escalate(cause: unknown): Promise<void> {
    if (this.#ending) return this.#ending;
    const error = new SupervisorError(this.path, cause, this.intensity, this.period);
    this.#lastError = { message: error.message, at: Date.now() };
    this.#setState("stopping");
    this.#emit({ event: "escalate", path: this.path, error: error.message });
    this.#ending = this.#stopAll().then(() => {
      this.#setState("failed");
      if (!this.#parent) this.#report(error);
      this.#done.reject(error);
    });
    return this.#ending;
  }

  /** At the top of the tree: hand the failure to `onError` and the instrumentation hook. */
  #report(error: SupervisorError): void {
    for (const fn of [this.#onError, reporter]) {
      if (!fn) continue;
      try {
        const result = inRootContext(() => fn(error));
        if (result && typeof (result as Promise<void>).then === "function") {
          (result as Promise<void>).catch((e) =>
            console.error("denext: a supervision error reporter failed", e)
          );
        }
      } catch (e) {
        console.error("denext: a supervision error reporter failed", e);
      }
    }
  }

  #unregister(): void {
    const list = topLevel();
    const i = list.indexOf(this);
    if (i >= 0) list.splice(i, 1);
  }

  status(): SupervisorStatus {
    return {
      name: this.name,
      path: this.path,
      kind: "supervisor",
      state: this.#state,
      restarts: this.#parent ? this.#parent.#restartsOf(this) : 0,
      since: this.#since,
      ...(this.#lastError ? { lastError: { ...this.#lastError } } : {}),
      strategy: this.strategy,
      intensity: this.intensity,
      period: this.period,
      children: this.#children.map((rec) => this.#childStatus(rec)),
    };
  }

  #restartsOf(child: SupervisorImpl): number {
    return this.#children.find((r) => r.driver.nested === child)?.restarts ?? 0;
  }

  #childStatus(rec: ChildRecord): ChildStatus | SupervisorStatus {
    if (rec.driver.nested) {
      // Its own state while it runs; while its parent holds it (restarting, stopped, failed for
      // good), the parent's view of it.
      const nested = rec.driver.nested.status();
      if (rec.state === "running") return nested;
      return {
        ...nested,
        state: rec.state,
        since: rec.since,
        ...(rec.retryAt !== undefined ? { retryAt: rec.retryAt } : {}),
      };
    }
    return {
      name: rec.driver.name,
      path: `${this.path}/${rec.driver.name}`,
      kind: "service",
      state: rec.state,
      restarts: rec.restarts,
      since: rec.since,
      ...(rec.retryAt !== undefined ? { retryAt: rec.retryAt } : {}),
      ...(rec.lastError ? { lastError: { ...rec.lastError } } : {}),
    };
  }
}

/**
 * Give a supervisor the name of the `services/` file that exports it, unless it has its own.
 * Not re-exported from `server/mod.ts`.
 *
 * @param sup The supervisor.
 * @param name The file's path under `services/`.
 */
export function nameSupervisor(sup: Supervisor, name: string): void {
  if (sup instanceof SupervisorImpl) sup.adoptName(name);
}

/**
 * Create a supervisor: it starts its children in order, restarts a crashed one with exponential
 * backoff (and, per `strategy`, the siblings that depend on it), gives up after more than
 * `intensity` restarts within `period` — failing to its own supervisor, or at the top to the
 * app's error reporting — and stops them in reverse order on shutdown.
 *
 * Restart semantics, not isolation: children share the process, the heap and the event loop.
 *
 * @param options The children and the policy.
 * @returns The supervisor (call `start()`, or nest it in another supervisor's `children`).
 * @throws TypeError when an option or a child is malformed.
 */
export function supervise(options: SuperviseOptions): Supervisor {
  return new SupervisorImpl(options);
}

/**
 * The status of every started top-level supervisor (the `services/` tree among them), each with
 * its children: state (`running`, `restarting`, `failed`, …), restart counts, the last error.
 *
 * @returns One snapshot per top-level supervisor, in start order.
 */
export function supervisionStatus(): SupervisorStatus[] {
  return topLevel().map((sup) => sup.status());
}

/**
 * Stop every started top-level supervisor, last-started first (the server drain calls this once
 * in-flight requests have finished). Not re-exported from `server/mod.ts`: denext's own wiring.
 */
export async function stopAllSupervisors(): Promise<void> {
  for (const sup of [...topLevel()].reverse()) {
    try {
      await sup.stop();
    } catch (err) {
      console.error("denext: stopping a supervisor failed", err);
    }
  }
}

/** Forget every failed top-level supervisor still listed (tests). Running ones are kept. */
export function forgetStoppedSupervisors(): void {
  const list = topLevel();
  for (let i = list.length - 1; i >= 0; i--) {
    const state = list[i].status().state;
    if (state === "failed" || state === "stopped") list.splice(i, 1);
  }
}
