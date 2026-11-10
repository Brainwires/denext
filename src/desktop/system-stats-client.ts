/**
 * The page side of the `systemStats` desktop capability (`denext desktop add system-stats`),
 * re-exported from `denext/desktop/client` as {@linkcode system}: the machine's aggregate CPU, GPU
 * and memory load, in percent.
 *
 * ```ts
 * import { system } from "denext/desktop/client";
 *
 * const now = await system.stats();
 * const stop = system.onStats((s) => setCpu(s.cpu.total), { intervalMs: 2000 });
 * ```
 *
 * Each window has its own samplers: `stats()`'s CPU figure is the load since this window's
 * previous `stats()`, and each `onStats()` samples on a sampler of its own, only while it is
 * subscribed (the runtime skips ticks while every app window is hidden). Closing the window or
 * reloading its page ends its subscriptions.
 *
 * `stats()` rejects `unavailable` off desktop or when the capability is not enabled, `unsupported`
 * under a Deno Desktop runtime without system stats (3.0.0-denext.13 and older), and `forbidden`
 * when the packaged app does not bake the capability. `onStats()` reports those to its `onError`.
 *
 * Client-safe: web APIs only, nothing runs at import.
 *
 * @module
 */

import { desktopRpc, subscribeDesktopEvent } from "./bridge-client.ts";
import {
  statsIntervalProblem,
  type SystemStats,
  type SystemStatsOptions,
  type SystemStatsSubscribeOptions,
} from "./system-stats-shape.ts";

export type { SystemStats, SystemStatsOptions, SystemStatsSubscribeOptions };

/** The capability's bridge name. */
const CAP = "systemStats";

/** The most frames kept for a subscription whose id has not come back yet. */
const MAX_EARLY_FRAMES = 8;

/** Options for {@linkcode SystemStatsClient.onStats}. */
export interface SystemStatsWatchOptions extends SystemStatsSubscribeOptions {
  /**
   * Called when the subscription could not start (`unavailable` off desktop, `unsupported`,
   * `forbidden`, …) with the `DesktopBridgeError`; no sample follows.
   */
  readonly onError?: (error: unknown) => void;
}

/** What {@linkcode system} is. */
export interface SystemStatsClient {
  /**
   * One sample. Its CPU figure is the load since this window's previous `stats()` (the first call
   * primes the sampler, ~100 ms).
   *
   * @param options `perCore` adds each core's figure.
   * @returns The sample.
   */
  stats(options?: SystemStatsOptions): Promise<SystemStats>;
  /**
   * Sample every `intervalMs` (at least 1000) until the returned function is called.
   *
   * @param callback Called with each sample.
   * @param options `intervalMs`, `perCore` and `onError`.
   * @returns The unsubscribe. Throws a `RangeError` for an `intervalMs` under 1000.
   */
  onStats(callback: (stats: SystemStats) => void, options: SystemStatsWatchOptions): () => void;
}

/** The `{ id, stats }` frame the capability pushes. */
interface StatsFrame {
  readonly id?: unknown;
  readonly stats?: SystemStats;
}

/** The bridge arguments for `perCore` (none unless it is `true`). */
function perCoreArgs(perCore: boolean | undefined): { perCore?: boolean } {
  return perCore === true ? { perCore: true } : {};
}

/** `system.onStats` (see {@linkcode SystemStatsClient.onStats}). */
function onStats(
  callback: (stats: SystemStats) => void,
  options: SystemStatsWatchOptions,
): () => void {
  const problem = statsIntervalProblem(options?.intervalMs);
  if (problem) throw new RangeError(problem);
  let id: string | undefined;
  let stopped = false;
  let lastAt = -Infinity;
  // Frames that came in before the id did (kept for the id, then dropped).
  let early: StatsFrame[] = [];
  const deliver = (stats: SystemStats | undefined) => {
    // The event stream is at-least-once: a sample seen already (same or older `at`) is dropped.
    if (!stats || typeof stats.at !== "number" || stats.at <= lastAt) return;
    lastAt = stats.at;
    callback(stats);
  };
  const off = subscribeDesktopEvent(CAP, "stats", (data) => {
    if (stopped) return;
    const frame = (data ?? {}) as StatsFrame;
    if (id === undefined) {
      if (early.length < MAX_EARLY_FRAMES) early.push(frame);
      return;
    }
    if (frame.id === id) deliver(frame.stats);
  });
  desktopRpc<{ id: string }>(CAP, "subscribe", {
    intervalMs: options.intervalMs,
    ...perCoreArgs(options.perCore),
  }).then((result) => {
    if (stopped) {
      desktopRpc(CAP, "unsubscribe", { id: result.id }).catch(() => {});
      return;
    }
    id = result.id;
    const pending = early;
    early = [];
    for (const frame of pending) if (frame.id === id) deliver(frame.stats);
  }, (err) => {
    off();
    if (!stopped) options.onError?.(err);
  });
  return () => {
    if (stopped) return;
    stopped = true;
    early = [];
    off();
    if (id !== undefined) desktopRpc(CAP, "unsubscribe", { id }).catch(() => {});
  };
}

/**
 * The machine's aggregate CPU, GPU and memory load, for the page (`denext desktop add
 * system-stats`, denext's Deno Desktop runtime from 3.0.0-denext.16).
 */
export const system: SystemStatsClient = {
  stats: async (options) =>
    await desktopRpc<SystemStats>(CAP, "stats", perCoreArgs(options?.perCore)),
  onStats,
};
