/**
 * `system.stats` / `system.onStats` for code in the desktop app's own Deno process (an extension,
 * `desktop.ts`), served from `denext/desktop`: aggregate CPU, GPU and memory load straight from
 * the runtime's `Deno.desktop.systemStats`, with no bridge. The page's twin is in
 * `denext/desktop/client` (`./system-stats-client.ts`), over the `systemStats` capability
 * (`./caps/system-stats.ts`), which shares this module's runtime lookup and error mapping.
 *
 * `stats()` uses one sampler for the module, so its CPU figure is the load since the previous
 * `stats()` call; each `onStats()` gets a sampler of its own, closed when it unsubscribes.
 *
 * Runtime-only (no page bundle imports it). Nothing runs at import: the runtime is looked up at
 * each call.
 *
 * @module
 */

import { DesktopCapError } from "./extension.ts";
import { type DesktopAppApi, desktopAppApi } from "./launch-events.ts";
import {
  type DenoSystemStatsApi,
  type DenoSystemStatsSampler,
  statsIntervalProblem,
  type SystemStats,
  type SystemStatsOptions,
  type SystemStatsSubscribeOptions,
} from "./system-stats-shape.ts";

export type { SystemStats, SystemStatsOptions, SystemStatsSubscribeOptions };

/** Why `systemStats` cannot run under this runtime. */
const NO_RUNTIME_REASON =
  "this Deno Desktop runtime has no Deno.desktop.systemStats (denext's Deno Desktop runtime from 3.0.0-denext.16 has it)";

/** Why `systemStats` cannot run on this OS. */
const NO_OS_REASON = "this Deno Desktop runtime has no system stats on this OS";

/** `Deno.desktop.systemStats`, or the `unsupported` (501) error naming what is missing. */
function systemStatsApi(api: DesktopAppApi | undefined): DenoSystemStatsApi {
  const s = (api as { systemStats?: Partial<DenoSystemStatsApi> } | undefined)?.systemStats;
  if (typeof s?.createSampler !== "function") {
    throw new DesktopCapError(
      "unsupported",
      `system stats are not available: ${NO_RUNTIME_REASON}`,
      {
        status: 501,
        data: { reason: NO_RUNTIME_REASON },
      },
    );
  }
  if (s.supported !== true) {
    throw new DesktopCapError("unsupported", `system stats are not available: ${NO_OS_REASON}`, {
      status: 501,
      data: { reason: NO_OS_REASON },
    });
  }
  return s as DenoSystemStatsApi;
}

/**
 * A runtime failure as a {@linkcode DesktopCapError}: its `NotCapable` (the app does not bake the
 * capability) is `forbidden`, a `RangeError` is `validation`, anything else a fixed `failed` (the
 * runtime's own message stays in the process).
 *
 * @param err What the runtime threw or rejected with.
 * @returns The error to throw.
 */
export function systemStatsError(err: unknown): DesktopCapError {
  if (err instanceof DesktopCapError) return err;
  const name = err instanceof Error ? err.name : "";
  if (name === "NotCapable") {
    return new DesktopCapError(
      "forbidden",
      "system stats are not enabled for this app: set desktop.capabilities.systemStats " +
        "(`denext desktop add system-stats`) and package the app again",
      { status: 403 },
    );
  }
  if (name === "RangeError") {
    return new DesktopCapError("validation", err instanceof Error ? err.message : "out of range");
  }
  return new DesktopCapError("failed", "the runtime could not sample the system", { status: 500 });
}

/** A new runtime sampler, its failures mapped. */
export function createStatsSampler(api: DesktopAppApi | undefined): DenoSystemStatsSampler {
  const stats = systemStatsApi(api);
  try {
    return stats.createSampler();
  } catch (err) {
    throw systemStatsError(err);
  }
}

/** The runtime's sample options for `perCore` (none unless it is `true`). */
export function sampleOptions(perCore: boolean | undefined): { perCore?: boolean } | undefined {
  return perCore === true ? { perCore: true } : undefined;
}

/** What `system` is: the aggregate machine load. */
export interface SystemStatsApi {
  /**
   * One sample. Its CPU figure is the load since this caller's previous `stats()` (the first call
   * primes the sampler, ~100 ms).
   *
   * @param options `perCore` adds each core's figure.
   * @returns The sample. Rejects `unsupported` under a runtime without system stats, `forbidden`
   * when the app does not enable `desktop.capabilities.systemStats`.
   */
  stats(options?: SystemStatsOptions): Promise<SystemStats>;
  /**
   * Sample every `intervalMs` (at least 1000) until the returned function is called; the runtime
   * skips ticks while every app window is hidden.
   *
   * @param callback Called with each sample.
   * @param options `intervalMs` and `perCore`.
   * @returns The unsubscribe. Throws a `RangeError` for an `intervalMs` under 1000, and the
   * `unsupported` / `forbidden` errors {@linkcode SystemStatsApi.stats} rejects with.
   */
  onStats(callback: (stats: SystemStats) => void, options: SystemStatsSubscribeOptions): () => void;
}

/**
 * `system` over a given `Deno.desktop` (tests pass a fake; {@linkcode system} uses the runtime's).
 *
 * @param api `Deno.desktop`, looked up at each call.
 * @returns The API.
 */
export function createSystemStats(api: () => DesktopAppApi | undefined): SystemStatsApi {
  let shared: DenoSystemStatsSampler | undefined;
  return {
    async stats(options) {
      shared ??= createStatsSampler(api());
      try {
        return await shared.stats(sampleOptions(options?.perCore));
      } catch (err) {
        throw systemStatsError(err);
      }
    },
    onStats(callback, options) {
      const problem = statsIntervalProblem(options?.intervalMs);
      if (problem) throw new RangeError(problem);
      const sampler = createStatsSampler(api());
      let off: () => void;
      try {
        off = sampler.onStats(callback, {
          intervalMs: options.intervalMs,
          ...sampleOptions(options.perCore),
        });
      } catch (err) {
        sampler.close();
        throw systemStatsError(err);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        try {
          off();
        } finally {
          sampler.close();
        }
      };
    },
  };
}

/**
 * The machine's aggregate CPU, GPU and memory load, for the desktop app's own process
 * (`denext/desktop`). Needs `desktop.capabilities.systemStats` (`denext desktop add
 * system-stats`) and denext's Deno Desktop runtime from 3.0.0-denext.16.
 *
 * @example
 * ```ts
 * import { system } from "denext/desktop";
 *
 * const { cpu, memory } = await system.stats();
 * const stop = system.onStats((s) => console.log(s.cpu.total), { intervalMs: 2000 });
 * ```
 */
export const system: SystemStatsApi = createSystemStats(desktopAppApi);
