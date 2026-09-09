// Shared value types for the profiler (`denext profile` / `denext_profile`). Kept in a
// leaf module so `core.ts` (orchestration) and `report.ts` (formatting) don't cycle.

import type { CpuProfileResult } from "./cpu.ts";
import type { HeapResult } from "./heap.ts";
import type { Budget, BudgetVerdict } from "./budget.ts";

/** Options for a single profiling run. */
export interface ProfileOptions {
  /** Route path to profile (default `/`). */
  route?: string;
  /**
   * JavaScript source evaluated in the page to exercise it (e.g. `globalThis.__burst(200)`).
   * Run once per iteration, between the pre- and post-heap reads and inside the CPU window.
   */
  interact?: string;
  /** Times to repeat the interaction (default 1). */
  iterations?: number;
  /** CPU sampling interval in microseconds (default 100). */
  samplingMicros?: number;
  /** Emit a minified build instead of the default unminified (readable-name) build. */
  minify?: boolean;
  /** Max self-time rows to return (default 20). */
  topN?: number;
  /** Optional performance budget to gate the run against. */
  budget?: Budget;
  /** Abort the run (server + browser are torn down). */
  signal?: AbortSignal;
}

/** The structured result of a profiling run. */
export interface ProfileResult {
  /** The profiled route path. */
  route: string;
  /** The ephemeral origin the app was served on. */
  origin: string;
  /** CPU self-time breakdown. */
  cpu: CpuProfileResult;
  /** Heap growth + leak verdict. */
  heap: HeapResult;
  /** Budget verdict, when a budget was supplied. */
  budget?: BudgetVerdict;
  /** Whether the profiled build was minified (false = readable function names). */
  minified: boolean;
}
