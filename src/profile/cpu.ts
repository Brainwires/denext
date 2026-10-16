// Aggregate a CDP `Profiler.stop` CPU profile into per-function self-time — the
// "where did the time go" table `denext profile` prints. Pure (no browser, no I/O) so
// it is unit-testable against a recorded profile fixture.
//
// The V8 sampling profiler returns a call tree (`nodes`) plus the raw sample stream
// (`samples`: the node id sampled at each tick, `timeDeltas`: microseconds since the
// previous sample). Self-time for a node is the wall time its OWN frame was on top of
// the stack — i.e. the sum of `timeDeltas[i]` where `samples[i] === node.id`. We then
// fold nodes that are the same function reached via different call paths (V8 emits a
// separate node per call site) into one row keyed by function + source location.

/** A raw V8 CPU-profile node (the subset we read). */
export interface ProfileNode {
  id: number;
  callFrame: {
    functionName?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  hitCount?: number;
}

/** The raw `Profiler.stop` payload shape (the subset we read). */
export interface RawCpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** One function's self-time in the aggregated report. */
export interface CpuFrame {
  /** Function name, or `(anonymous)` for an unnamed frame. */
  name: string;
  /** Source URL the frame came from (empty for VM/native frames). */
  url: string;
  /** 1-based line, or 0 when unknown. */
  line: number;
  /** Self-time in milliseconds. */
  selfMs: number;
  /** Share of total profiled time, 0–100. */
  pct: number;
}

/** The aggregated CPU result. */
export interface CpuProfileResult {
  /** Functions by descending self-time (capped at the requested `topN`). */
  topSelfTime: CpuFrame[];
  /** Total profiled wall time in milliseconds. */
  totalMs: number;
  /** Number of samples taken (0 when the profile carried no sample stream). */
  sampleCount: number;
}

/** A short, stable key folding same-function-same-location nodes together. */
function frameKey(n: ProfileNode): string {
  const name = n.callFrame.functionName || "(anonymous)";
  const url = n.callFrame.url ?? "";
  // lineNumber from CDP is 0-based; store as 1-based (0 → unknown/native).
  const line = url ? (n.callFrame.lineNumber ?? -1) + 1 : 0;
  return `${name}\0${url}\0${line}`;
}

/** Per-node self-time in microseconds + the sample count backing it. */
interface SelfMicros {
  byId: Map<number, number>;
  sampleCount: number;
}

/** Self-microseconds per node from the sample stream, when it's present and consistent. */
function selfMicrosFromSamples(samples: number[], deltas: number[]): SelfMicros {
  const byId = new Map<number, number>();
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    byId.set(id, (byId.get(id) ?? 0) + Math.max(0, deltas[i]));
  }
  return { byId, sampleCount: samples.length };
}

/** Self-microseconds per node from hitCount, scaled by the profile's mean sample interval. */
function selfMicrosFromHitCount(profile: RawCpuProfile): SelfMicros {
  const byId = new Map<number, number>();
  const totalHits = profile.nodes.reduce((s, n) => s + (n.hitCount ?? 0), 0);
  const spanMicros = Math.max(0, profile.endTime - profile.startTime);
  const perHit = totalHits > 0 ? spanMicros / totalHits : 0;
  let sampleCount = 0;
  for (const n of profile.nodes) {
    const hits = n.hitCount ?? 0;
    if (hits > 0) {
      byId.set(n.id, hits * perHit);
      sampleCount += hits;
    }
  }
  return { byId, sampleCount };
}

/** Fold node self-time into function-location rows, returning rows + total microseconds. */
function foldFrames(
  byId: Map<number, ProfileNode>,
  selfMicrosById: Map<number, number>,
): { rows: CpuFrame[]; totalMicros: number } {
  const byFrame = new Map<string, CpuFrame>();
  let totalMicros = 0;
  for (const [id, micros] of selfMicrosById) {
    const node = byId.get(id);
    if (!node) continue;
    totalMicros += micros;
    const existing = byFrame.get(frameKey(node));
    if (existing) {
      existing.selfMs += micros / 1000;
      continue;
    }
    const url = node.callFrame.url ?? "";
    byFrame.set(frameKey(node), {
      name: node.callFrame.functionName || "(anonymous)",
      url,
      line: url ? (node.callFrame.lineNumber ?? -1) + 1 : 0,
      selfMs: micros / 1000,
      pct: 0,
    });
  }
  return { rows: [...byFrame.values()], totalMicros };
}

/**
 * A row filter for {@linkcode aggregateSelfTime}: keeps the functions whose name or source URL
 * contains `pattern` (case-insensitive) — a component (`TodoList`), a module (`cart.tsx`) or a
 * package (`node_modules/zod`).
 *
 * @param pattern The text to look for.
 * @returns The predicate.
 */
export function frameFilter(pattern: string): (frame: CpuFrame) => boolean {
  const needle = pattern.toLowerCase();
  return (f) => f.name.toLowerCase().includes(needle) || f.url.toLowerCase().includes(needle);
}

/**
 * Aggregate a raw CDP CPU profile into per-function self-time, descending.
 *
 * @param profile The `Profiler.stop` payload.
 * @param topN Max rows to return (default 20).
 * @param keep Keep only the rows it accepts (before the `topN` cut); totals and shares stay
 *   those of the whole profile.
 */
export function aggregateSelfTime(
  profile: RawCpuProfile,
  topN = 20,
  keep?: (frame: CpuFrame) => boolean,
): CpuProfileResult {
  const byId = new Map<number, ProfileNode>();
  for (const n of profile.nodes) byId.set(n.id, n);

  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const hasStream = samples.length > 0 && deltas.length === samples.length;
  const { byId: selfMicrosById, sampleCount } = hasStream
    ? selfMicrosFromSamples(samples, deltas)
    : selfMicrosFromHitCount(profile);

  const { rows, totalMicros } = foldFrames(byId, selfMicrosById);
  const totalMs = totalMicros / 1000;
  rows.sort((a, b) => b.selfMs - a.selfMs);
  for (const r of rows) r.pct = totalMs > 0 ? (r.selfMs / totalMs) * 100 : 0;
  const kept = keep ? rows.filter(keep) : rows;
  return { topSelfTime: kept.slice(0, topN), totalMs, sampleCount };
}
