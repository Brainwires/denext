/**
 * The sidecar supervisor: one state machine per sidecar that starts it through a
 * {@linkcode SidecarLauncher}, waits until it is ready, restarts it after a failure with an
 * exponential backoff, gives up after `maxAttempts` consecutive failed starts, and stops it with a
 * grace period. The launcher (a worker in the app's runtime, or a spawned program) and the clock are
 * injected, so every transition is tested without a real process or timer.
 *
 * States: `idle` → `starting` → `ready`; an end while `starting` / `ready` → `backoff` → `starting`
 * (or `stopped` / `failed`); `stop()` → `stopping` → `stopped`.
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import {
  SIDECAR_DEFAULTS,
  type SidecarDefinition,
  type SidecarExit,
  type SidecarInfo,
  type SidecarState,
  type SidecarStatus,
} from "./sidecar.ts";

/** One running instance of a sidecar, as a launcher hands it over. */
export interface SidecarInstance {
  /** A program's process id. */
  readonly pid?: number;
  /** Settles once the instance has ended, however it ended. */
  readonly exited: Promise<SidecarExit>;
  /**
   * Ask it to finish, and end it once `graceMs` has passed. Resolves once it has ended. Never
   * rejects.
   */
  stop(graceMs: number): Promise<void>;
}

/** What a launcher is given for one start. */
export interface SidecarLaunchContext {
  /** The definition. */
  readonly definition: SidecarDefinition;
  /** The sidecar's port, when it has one. */
  readonly port?: number;
  /** The `bootstrap` value for this start (functions already called). */
  readonly bootstrap: unknown;
  /** The secrets (per launch of the app). */
  readonly secrets: Readonly<Record<string, string>>;
  /** Each line of the sidecar's output (`stdout` / `stderr`). */
  onLine(stream: "stdout" | "stderr", line: string): void;
  /** The sidecar said it is ready (`denextSidecar.ready()`). */
  onReadySignal(): void;
}

/** Starts one instance of a sidecar. A rejection is a failed start. */
export type SidecarLauncher = (ctx: SidecarLaunchContext) => Promise<SidecarInstance>;

/** A timer id of {@linkcode SidecarClock}. */
export type SidecarTimer = ReturnType<typeof setTimeout>;

/** The clock the supervisor waits with (tests pass a fake one). */
export interface SidecarClock {
  /** Epoch milliseconds. */
  now(): number;
  /** Call `fn` after `ms`; the returned id cancels it. */
  setTimeout(fn: () => void, ms: number): SidecarTimer;
  /** Cancel a {@linkcode SidecarClock.setTimeout}. */
  clearTimeout(id: SidecarTimer): void;
}

/** The real clock. */
const REAL_CLOCK: SidecarClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/** Options for {@linkcode createSidecarSupervisor}. */
export interface SidecarSupervisorOptions {
  /** The sidecar. */
  readonly definition: SidecarDefinition;
  /** How it starts. */
  readonly launch: SidecarLauncher;
  /** Its port, when it has one (picked once per app launch). */
  readonly port?: number;
  /** Its secrets (resolved once per app launch). */
  readonly secrets?: Readonly<Record<string, string>>;
  /** The page-visible values (`expose`, secrets resolved). */
  readonly values?: Readonly<Record<string, string | number | boolean | null>>;
  /** Each output line, after the ready matcher saw it (logging). */
  readonly onLine?: (stream: "stdout" | "stderr", line: string) => void;
  /** The clock (default: the real one). */
  readonly clock?: SidecarClock;
  /** `fetch` for the `ready.http` check (default: the global one). */
  readonly fetch?: typeof fetch;
}

/** The handle `runDesktop`'s `sidecar(name)` returns. */
export interface SidecarHandle {
  /** The sidecar's name. */
  readonly name: string;
  /** The current status. */
  readonly status: SidecarStatus;
  /** What the page learns about it (`sidecarInfo`). */
  readonly info: SidecarInfo;
  /**
   * Call `listener` on every status change.
   *
   * @returns A function that unsubscribes.
   */
  onStatus(listener: (status: SidecarStatus) => void): () => void;
  /** Stop it (if running) and start it again, with a fresh attempt count. */
  restart(): Promise<void>;
  /** Stop it; it stays `stopped` until {@linkcode SidecarHandle.restart}. */
  stop(): Promise<void>;
  /**
   * Resolve once it is `ready`, or with its status when it is `failed` / `stopped` or `timeoutMs`
   * passed first.
   */
  whenReady(timeoutMs?: number): Promise<SidecarStatus>;
}

/** A supervisor: the handle plus the start the host calls once. */
export interface SidecarSupervisor extends SidecarHandle {
  /** Start it (from `idle` or `stopped`). */
  start(): void;
}

/** A failure that ended a start or a run: why, and what to report. */
type Outcome =
  | { readonly kind: "ready" }
  | { readonly kind: "exit"; readonly exit: SidecarExit }
  | { readonly kind: "timeout" };

/** The delay before retry number `attempt` (1-based): doubling from `base`, capped at `max`. */
export function sidecarBackoffDelay(attempt: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
}

/** Whether an end of a run counts as a failure (a crash) rather than a clean exit. */
function isFailure(exit: SidecarExit): boolean {
  return exit.error !== undefined || exit.signal !== undefined ||
    (exit.code !== undefined && exit.code !== 0);
}

/** A promise with its resolver. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => resolve = r);
  return { promise, resolve };
}

/** Run `check` every `interval` until it passes; resolve `true` then, `false` once `cancelled`. */
function poll(
  check: () => Promise<boolean>,
  interval: number,
  clock: SidecarClock,
  cancelled: () => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    const tick = async () => {
      if (cancelled()) return resolve(false);
      let ok = false;
      try {
        ok = await check();
      } catch {
        ok = false;
      }
      if (cancelled()) return resolve(false);
      if (ok) return resolve(true);
      clock.setTimeout(tick, interval);
    };
    void tick();
  });
}

/** The settled restart / shutdown / readiness numbers of a definition (its values, else defaults). */
function sidecarPolicy(def: SidecarDefinition) {
  const r = def.restart ?? {};
  return {
    restartOn: r.on ?? SIDECAR_DEFAULTS.restartOn,
    backoffMs: r.backoffMs ?? SIDECAR_DEFAULTS.backoffMs,
    maxBackoffMs: r.maxBackoffMs ?? SIDECAR_DEFAULTS.maxBackoffMs,
    maxAttempts: r.maxAttempts ?? SIDECAR_DEFAULTS.maxAttempts,
    resetAfterMs: r.resetAfterMs ?? SIDECAR_DEFAULTS.resetAfterMs,
    graceMs: def.shutdown?.graceMs ?? SIDECAR_DEFAULTS.graceMs,
    readyTimeoutMs: def.ready?.timeoutMs ?? SIDECAR_DEFAULTS.readyTimeoutMs,
    intervalMs: def.ready?.intervalMs ?? SIDECAR_DEFAULTS.readyIntervalMs,
  };
}

/**
 * Create the supervisor of one sidecar. It does nothing until {@linkcode SidecarSupervisor.start}.
 *
 * @param options The definition, the launcher, the port and secrets, and the clock.
 * @returns The supervisor.
 */
export function createSidecarSupervisor(options: SidecarSupervisorOptions): SidecarSupervisor {
  const def = options.definition;
  const clock = options.clock ?? REAL_CLOCK;
  const fetchFn = options.fetch ?? fetch;
  const ready = def.ready ?? {};
  const {
    restartOn,
    backoffMs,
    maxBackoffMs,
    maxAttempts,
    resetAfterMs,
    graceMs,
    readyTimeoutMs,
    intervalMs,
  } = sidecarPolicy(def);
  const stdoutRe = ready.stdout !== undefined ? new RegExp(ready.stdout) : undefined;
  const secrets = options.secrets ?? {};
  const listeners = new Set<(s: SidecarStatus) => void>();

  let status: SidecarStatus = {
    name: def.name,
    state: "idle",
    attempts: 0,
    restarts: 0,
    since: clock.now(),
    ...(options.port !== undefined ? { port: options.port } : {}),
  };
  /** The running instance, while `starting` / `ready` / `stopping`. */
  let instance: SidecarInstance | undefined;
  /** Bumped on every start and stop: a callback of an older generation is ignored. */
  let generation = 0;
  let retryTimer: SidecarTimer | undefined;
  let resetTimer: SidecarTimer | undefined;
  let started = 0;
  let stopping: Promise<void> | undefined;

  const set = (patch: Partial<SidecarStatus> & { state: SidecarState }): void => {
    const next: Record<string, unknown> = { ...status, ...patch, since: clock.now() };
    if (patch.state !== "backoff") delete next.retryAt;
    if (patch.state !== "starting" && patch.state !== "ready" && patch.state !== "stopping") {
      delete next.pid;
    }
    status = next as unknown as SidecarStatus;
    for (const l of [...listeners]) {
      try {
        l(status);
      } catch (err) {
        console.error(`sidecar ${def.name}: status listener failed`, err);
      }
    }
  };

  const clearTimers = (): void => {
    if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
    if (resetTimer !== undefined) clock.clearTimeout(resetTimer);
    retryTimer = resetTimer = undefined;
  };

  const info = (): SidecarInfo => ({
    name: def.name,
    state: status.state,
    ...(options.port !== undefined
      ? { port: options.port, url: `http://127.0.0.1:${options.port}` }
      : {}),
    values: options.values ?? {},
  });

  /** The bootstrap value for one start (a function is called with the current info). */
  const bootstrapValue = async (): Promise<unknown> => {
    const b = def.bootstrap;
    return typeof b === "function" ? await (b as (i: SidecarInfo) => unknown)(info()) : b;
  };

  /** Wait for every configured ready check; resolves `true` when all passed, `false` if cancelled. */
  const readiness = (
    gen: number,
    signal: Promise<void>,
    line: Promise<void>,
  ): Promise<boolean> => {
    const live = () => gen === generation;
    const checks: Promise<boolean>[] = [];
    if (ready.signal === true) checks.push(signal.then(() => true));
    if (stdoutRe) checks.push(line.then(() => true));
    if (ready.http !== undefined && options.port !== undefined) {
      const url = `http://127.0.0.1:${options.port}${ready.http}`;
      checks.push(poll(
        async () => {
          const res = await fetchFn(url, {
            signal: AbortSignal.timeout(Math.max(1000, intervalMs)),
          });
          await res.body?.cancel();
          return res.status >= 200 && res.status < 300;
        },
        intervalMs,
        clock,
        () => !live(),
      ));
    }
    if (ready.probe) {
      const probe = ready.probe;
      checks.push(poll(async () => await probe(info()), intervalMs, clock, () => !live()));
    }
    return Promise.all(checks).then((all) => all.every(Boolean));
  };

  /**
   * After a run or a start ended: restart with backoff, or settle as stopped / failed. A clean end
   * of a run that was ready resets the attempt count; a failure adds one (a run that stayed ready
   * `resetAfterMs` was already reset to 0).
   */
  const afterEnd = (exit: SidecarExit, wasReady: boolean): void => {
    instance = undefined;
    clearTimers();
    const failure = isFailure(exit);
    const again = restartOn === "always" || (restartOn === "crash" && failure);
    const attempts = wasReady && !failure ? 0 : status.attempts + 1;
    if (!again) {
      set({ state: failure ? "failed" : "stopped", lastExit: exit, attempts });
      return;
    }
    if (attempts > maxAttempts) {
      set({ state: "failed", lastExit: exit, attempts });
      console.error(
        `sidecar ${def.name}: gave up after ${maxAttempts} failed start(s)` +
          (exit.error ? `: ${exit.error}` : ""),
      );
      return;
    }
    const delay = sidecarBackoffDelay(Math.max(1, attempts), backoffMs, maxBackoffMs);
    const gen = generation;
    set({ state: "backoff", lastExit: exit, attempts, retryAt: clock.now() + delay });
    retryTimer = clock.setTimeout(() => {
      retryTimer = undefined;
      if (gen === generation && status.state === "backoff") launchOnce(true);
    }, delay);
  };

  /** One start: launch, then race readiness against the end and the timeout. */
  const launchOnce = (isRestart: boolean): void => {
    const gen = ++generation;
    started++;
    set({
      state: "starting",
      ...(isRestart ? { restarts: status.restarts + 1 } : {}),
    });
    const signal = deferred<void>();
    const line = deferred<void>();
    void (async () => {
      let inst: SidecarInstance;
      try {
        inst = await options.launch({
          definition: def,
          ...(options.port !== undefined ? { port: options.port } : {}),
          bootstrap: await bootstrapValue(),
          secrets,
          onLine: (stream, text) => {
            if (stdoutRe?.test(text)) line.resolve();
            options.onLine?.(stream, text);
          },
          onReadySignal: () => signal.resolve(),
        });
      } catch (err) {
        if (gen !== generation) return;
        afterEnd({ error: err instanceof Error ? err.message : String(err) }, false);
        return;
      }
      if (gen !== generation) {
        // Stopped while launching: end the late instance.
        await inst.stop(0);
        return;
      }
      instance = inst;
      if (inst.pid !== undefined) set({ state: "starting", pid: inst.pid });
      const exited = inst.exited.then((exit): Outcome => ({ kind: "exit", exit }));
      const timeout = deferred<Outcome>();
      const timer = clock.setTimeout(() => timeout.resolve({ kind: "timeout" }), readyTimeoutMs);
      const outcome = await Promise.race([
        readiness(gen, signal.promise, line.promise).then((ok): Outcome =>
          ok ? { kind: "ready" } : { kind: "timeout" }
        ),
        exited,
        timeout.promise,
      ]);
      clock.clearTimeout(timer);
      if (gen !== generation) return;
      if (outcome.kind === "exit") return afterEnd(outcome.exit, false);
      if (outcome.kind === "timeout") {
        await inst.stop(graceMs);
        if (gen !== generation) return;
        return afterEnd({ error: `not ready within ${readyTimeoutMs} ms` }, false);
      }
      set({ state: "ready" });
      resetTimer = clock.setTimeout(() => {
        resetTimer = undefined;
        if (gen === generation && status.state === "ready") set({ state: "ready", attempts: 0 });
      }, resetAfterMs);
      const exit = await inst.exited;
      if (gen !== generation) return;
      afterEnd(exit, true);
    })();
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    generation++;
    clearTimers();
    const inst = instance;
    instance = undefined;
    if (!inst) {
      if (status.state !== "idle" && status.state !== "failed") set({ state: "stopped" });
      return Promise.resolve();
    }
    set({ state: "stopping" });
    stopping = inst.stop(graceMs).then(async () => {
      const exit = await inst.exited;
      stopping = undefined;
      set({ state: "stopped", lastExit: exit });
    });
    return stopping;
  };

  const onStatus = (listener: (s: SidecarStatus) => void): () => void => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const start = (): void => {
    if (status.state !== "idle" && status.state !== "stopped" && status.state !== "failed") return;
    if (status.state !== "idle") set({ state: status.state, attempts: 0 });
    launchOnce(started > 0);
  };

  return {
    name: def.name,
    get status() {
      return status;
    },
    get info() {
      return info();
    },
    onStatus,
    start,
    async restart() {
      await stop();
      set({ state: "stopped", attempts: 0 });
      launchOnce(true);
    },
    stop,
    whenReady(timeoutMs = readyTimeoutMs) {
      const settled = (s: SidecarStatus) =>
        s.state === "ready" || s.state === "failed" || s.state === "stopped";
      if (settled(status)) return Promise.resolve(status);
      return new Promise((resolve) => {
        const timer = clock.setTimeout(() => {
          off();
          resolve(status);
        }, timeoutMs);
        const off = onStatus((s) => {
          if (!settled(s)) return;
          clock.clearTimeout(timer);
          off();
          resolve(s);
        });
      });
    },
  };
}
