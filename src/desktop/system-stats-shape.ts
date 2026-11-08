/**
 * The shapes behind `system.stats` / `system.onStats` (`denext/desktop/client` for the page,
 * `denext/desktop` for an extension): the {@linkcode SystemStats} sample, the options, the
 * runtime's `Deno.desktop.systemStats` API as denext expects it, and the interval check every side
 * runs before it reaches the runtime.
 *
 * Client-safe: types and one pure function, nothing runs at import.
 *
 * @module
 */

/**
 * One aggregate sample of the machine's load. Every percentage is 0–100; a figure the OS does not
 * report here is `null` (an optional field is left out).
 */
export interface SystemStats {
  /** When the sample was taken, in ms since the epoch. */
  readonly at: number;
  /**
   * The CPUs: `total` is the share of time every core was busy since this caller's previous
   * sample (`null` when no figure is available), `cores` the same per core (with `perCore`).
   */
  readonly cpu: { readonly total: number | null; readonly cores?: readonly number[] };
  /**
   * The GPUs: `utilization` is the busiest figure the OS reports (`null` when it reports none),
   * `devices` each GPU by name.
   */
  readonly gpu: {
    readonly utilization: number | null;
    readonly devices?: readonly { readonly name: string; readonly utilization: number | null }[];
  };
  /**
   * Memory: `pressure` is how close the machine is to running out (`null` when the OS gives no
   * figure), with the bytes in use and in all where the OS reports them.
   */
  readonly memory: {
    readonly pressure: number | null;
    readonly usedBytes?: number;
    readonly totalBytes?: number;
  };
}

/** Options for `system.stats()`. */
export interface SystemStatsOptions {
  /** Also report each core's figure (`cpu.cores`). */
  readonly perCore?: boolean;
}

/** Options for `system.onStats()`. */
export interface SystemStatsSubscribeOptions extends SystemStatsOptions {
  /** How often to sample, in ms: a finite number of at least {@linkcode MIN_STATS_INTERVAL_MS}. */
  readonly intervalMs: number;
}

/** One runtime sampler (`Deno.desktop.systemStats.createSampler()`). */
export interface DenoSystemStatsSampler {
  /** A sample; the first call primes the sampler (~100 ms) so it has a CPU figure. */
  stats(options?: { perCore?: boolean }): Promise<SystemStats>;
  /**
   * Sample every `intervalMs` (at least 1000, else a `RangeError`), skipping ticks while every app
   * window is hidden. Returns the unsubscribe.
   */
  onStats(
    callback: (stats: SystemStats) => void,
    options: { intervalMs: number; perCore?: boolean },
  ): () => void;
  /** Stop the sampler and release what it holds. */
  close(): void;
}

/**
 * `Deno.desktop.systemStats` (denext's Deno Desktop runtime after 3.0.0-denext.13). Its calls
 * reject with an error named `"NotCapable"` unless the packaged app bakes the `systemStats`
 * capability (`desktop.capabilities.systemStats`).
 */
export interface DenoSystemStatsApi {
  /** Whether this OS has the sampler. */
  readonly supported: boolean;
  /** A sampler with its own previous CPU snapshot. */
  createSampler(): DenoSystemStatsSampler;
}

/** The shortest `intervalMs` `system.onStats` takes. */
const MIN_STATS_INTERVAL_MS = 1000;

/**
 * What is wrong with an `intervalMs`, or `undefined` when it is a finite number of at least
 * {@linkcode MIN_STATS_INTERVAL_MS}.
 *
 * @param value The `intervalMs` as given.
 * @returns The problem, as a message.
 */
export function statsIntervalProblem(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_STATS_INTERVAL_MS) {
    return `intervalMs must be a finite number of at least ${MIN_STATS_INTERVAL_MS}`;
  }
  return undefined;
}
