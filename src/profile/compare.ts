// Compare two `denext profile` runs: the per-function self-time and heap deltas between a
// saved run (`--out`, or `--json` output) and the current one — "did this change make the
// route slower, and where". Pure: no browser, no I/O.

import type { ProfileResult } from "./types.ts";
import { retainedBytes } from "./heap.ts";

/** One function's self-time in both runs. */
export interface ProfileDeltaRow {
  /** The function name (rows are matched by name: chunk URLs change between builds). */
  name: string;
  /** Self-time in the saved run, ms (0 when it was not among that run's rows). */
  baseMs: number;
  /** Self-time in the current run, ms (0 when it is not among this run's rows). */
  nowMs: number;
  /** `nowMs − baseMs`. */
  deltaMs: number;
}

/** What changed between two runs of the same route. */
export interface ProfileComparison {
  /** The saved run's route (a different route makes the comparison meaningless; it is shown). */
  baseRoute: string;
  /** Total profiled CPU time: saved, current and the difference (ms). */
  totalMs: { base: number; now: number; delta: number };
  /** Peak heap growth during the run: saved, current and the difference (bytes). */
  heapGrowth: { base: number; now: number; delta: number };
  /** Retained growth after GC: saved, current and the difference (bytes). */
  retained: { base: number; now: number; delta: number };
  /** Every function in either run's rows, largest change first. */
  rows: ProfileDeltaRow[];
}

/** Self-time per function name (a name reached at several locations is summed). */
function byName(result: ProfileResult): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of result.cpu.topSelfTime) out.set(f.name, (out.get(f.name) ?? 0) + f.selfMs);
  return out;
}

/** Saved / current / difference of one number. */
function delta(base: number, now: number): { base: number; now: number; delta: number } {
  return { base, now, delta: now - base };
}

/**
 * Whether `value` has the shape of a saved {@linkcode ProfileResult} (what `--out` writes).
 *
 * @param value Parsed JSON.
 * @returns True when it carries the CPU rows and heap numbers a comparison reads.
 */
export function isProfileResult(value: unknown): value is ProfileResult {
  const v = value as ProfileResult | null;
  return !!v && typeof v === "object" && Array.isArray(v.cpu?.topSelfTime) &&
    typeof v.cpu.totalMs === "number" && typeof v.heap?.afterBytes === "number";
}

/**
 * Compare a saved run with the current one.
 *
 * @param base The saved run.
 * @param now The current run.
 * @returns Totals, heap and per-function deltas (largest absolute change first).
 */
export function compareProfiles(base: ProfileResult, now: ProfileResult): ProfileComparison {
  const before = byName(base);
  const after = byName(now);
  const rows: ProfileDeltaRow[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const baseMs = before.get(name) ?? 0;
    const nowMs = after.get(name) ?? 0;
    rows.push({ name, baseMs, nowMs, deltaMs: nowMs - baseMs });
  }
  rows.sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs) || a.name.localeCompare(b.name));
  const growth = (r: ProfileResult) => r.heap.afterBytes - r.heap.beforeBytes;
  return {
    baseRoute: base.route,
    totalMs: delta(base.cpu.totalMs, now.cpu.totalMs),
    heapGrowth: delta(growth(base), growth(now)),
    retained: delta(retainedBytes(base.heap), retainedBytes(now.heap)),
    rows,
  };
}
