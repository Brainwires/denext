// Heap-measurement result + the leak decision for `denext profile`. The capture
// itself (reading `performance.memory` across a forced GC) lives in `core.ts` next to
// the browser; this module holds the pure shape + verdict so `budget.ts` and tests can
// depend on it without pulling astral in.

/** JS-heap bytes measured across a profiled interaction. */
export interface HeapResult {
  /** Used JS heap before the interaction (after a settling GC). */
  beforeBytes: number;
  /** Used JS heap right after the interaction (pre-GC peak). */
  afterBytes: number;
  /** Used JS heap after a forced GC — what the interaction actually retained. */
  afterGcBytes: number;
  /**
   * Interaction mode with 2+ iterations: the used heap after the FIRST iteration and a forced
   * GC — the leak baseline. The first run pays one-time costs that are not leaks (lazily loaded
   * route chunks and their compiled code, first-visit data caches); growth that repeats on the
   * later runs is. Absent for a single iteration and in startup mode.
   */
  warmBytes?: number;
  /** True when the post-GC heap didn't return near baseline (a retained-growth signal). */
  leaked: boolean;
}

/**
 * Bytes retained after GC relative to the leak baseline: the warm heap ({@link
 * HeapResult.warmBytes}) when measured, otherwise the pre-interaction heap.
 */
export function retainedBytes(heap: HeapResult): number {
  return heap.afterGcBytes - (heap.warmBytes ?? heap.beforeBytes);
}

/** Default retained-growth tolerance (bytes) below which post-GC growth isn't a leak. */
export const DEFAULT_LEAK_TOLERANCE_BYTES = 512 * 1024;

/**
 * Decide whether an interaction leaked: the heap failed to return within `tolerance`
 * bytes of its pre-interaction baseline after a forced GC. `usedJSHeapSize` is coarse
 * even with `--enable-precise-memory-info`, so the tolerance guards against calling
 * ordinary allocation noise a leak.
 */
export function isLeak(
  beforeBytes: number,
  afterGcBytes: number,
  tolerance = DEFAULT_LEAK_TOLERANCE_BYTES,
): boolean {
  return afterGcBytes - beforeBytes > tolerance;
}
