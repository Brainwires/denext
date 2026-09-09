// The `--budget` gate for `denext profile`: compare a run against a recorded baseline
// and report violations. Pure (no I/O) so both the CLI (which turns a violation into a
// non-zero exit) and the MCP tool (which returns the structured verdict) share it.

import type { HeapResult } from "./heap.ts";
import type { CpuProfileResult } from "./cpu.ts";

/** A recorded performance baseline (JSON on disk). */
export interface Budget {
  /** Max allowed heap growth (afterBytes − beforeBytes) in bytes. */
  maxHeapGrowthBytes?: number;
  /** Max allowed retained-after-GC growth (afterGcBytes − beforeBytes) in bytes. */
  maxLeakedBytes?: number;
  /** Per-function self-time ceilings, keyed by function name. */
  hotFns?: { name: string; maxSelfPct: number }[];
}

/** One budget breach. */
export interface BudgetViolation {
  kind: "heap-growth" | "leaked" | "hot-fn";
  detail: string;
  /** The measured value that breached. */
  actual: number;
  /** The recorded ceiling it exceeded. */
  limit: number;
}

/** The budget verdict for a run. */
export interface BudgetVerdict {
  passed: boolean;
  violations: BudgetViolation[];
}

/** Compare a run's CPU + heap results against `budget`, returning the verdict. */
export function evaluateBudget(
  budget: Budget,
  cpu: CpuProfileResult,
  heap: HeapResult,
): BudgetVerdict {
  const violations: BudgetViolation[] = [];

  if (budget.maxHeapGrowthBytes !== undefined) {
    const growth = heap.afterBytes - heap.beforeBytes;
    if (growth > budget.maxHeapGrowthBytes) {
      violations.push({
        kind: "heap-growth",
        detail: `heap grew ${growth} B (budget ${budget.maxHeapGrowthBytes} B)`,
        actual: growth,
        limit: budget.maxHeapGrowthBytes,
      });
    }
  }

  if (budget.maxLeakedBytes !== undefined) {
    const leaked = heap.afterGcBytes - heap.beforeBytes;
    if (leaked > budget.maxLeakedBytes) {
      violations.push({
        kind: "leaked",
        detail: `retained ${leaked} B after GC (budget ${budget.maxLeakedBytes} B)`,
        actual: leaked,
        limit: budget.maxLeakedBytes,
      });
    }
  }

  for (const hot of budget.hotFns ?? []) {
    const frame = cpu.topSelfTime.find((f) => f.name === hot.name);
    const pct = frame?.pct ?? 0;
    if (pct > hot.maxSelfPct) {
      violations.push({
        kind: "hot-fn",
        detail: `${hot.name} at ${pct.toFixed(1)}% self-time (budget ${hot.maxSelfPct}%)`,
        actual: pct,
        limit: hot.maxSelfPct,
      });
    }
  }

  return { passed: violations.length === 0, violations };
}

/** Derive a baseline from a run (for `--write-budget`), with a headroom multiplier. */
export function budgetFromRun(
  cpu: CpuProfileResult,
  heap: HeapResult,
  headroom = 1.2,
): Budget {
  return {
    maxHeapGrowthBytes: Math.ceil((heap.afterBytes - heap.beforeBytes) * headroom),
    maxLeakedBytes: Math.max(0, Math.ceil((heap.afterGcBytes - heap.beforeBytes) * headroom)),
    hotFns: cpu.topSelfTime.slice(0, 5).map((f) => ({
      name: f.name,
      maxSelfPct: Math.ceil(f.pct * headroom),
    })),
  };
}
