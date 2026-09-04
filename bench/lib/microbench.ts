// A tiny, portable timing harness that runs identically under Deno and Node
// (both use V8 and expose `performance.now()`). Using the SAME harness on both
// sides — rather than Deno.bench on one and node:test on the other — is what
// makes the ns/op numbers directly comparable.
//
// Method: auto-calibrate a batch size so one batch runs ~`batchMs`, warm up,
// then time `samples` batches and report the MEDIAN ns/op (robust to GC pauses
// and scheduler jitter) alongside the full sample spread.

export interface BenchResult {
  name: string;
  /** Median nanoseconds per operation across sample batches. */
  nsPerOp: number;
  opsPerSec: number;
  /** 25th/75th percentile ns/op — the interquartile band around the median. */
  p25NsPerOp: number;
  p75NsPerOp: number;
  /** Min / max ns/op observed — the full spread. */
  minNsPerOp: number;
  maxNsPerOp: number;
  /** Iterations per timed batch (auto-calibrated). */
  batchIters: number;
  /** Number of timed batches. */
  samples: number;
}

export interface BenchOptions {
  /** Target wall time per timed batch, ms. Bigger = less timer noise. */
  batchMs?: number;
  /** Number of timed batches; the median is reported. */
  samples?: number;
  /** Warmup batches (let JIT settle) before timing. */
  warmupBatches?: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Linear-interpolated percentile of an unsorted sample. */
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// If the runtime exposes gc() (Deno: --v8-flags=--expose-gc, Node: --expose-gc),
// collect between timed batches so each batch starts from a clean heap. This is
// the standard way to keep GC pauses from being charged unpredictably to one
// batch and blowing out the variance — without hiding GC that a single batch
// genuinely triggers under its own allocation load.
// deno-lint-ignore no-explicit-any
const gc: (() => void) | undefined = (globalThis as any).gc;

/** Run `fn` `iters` times, awaiting each; return elapsed ms. */
async function timeBatch(fn: () => unknown, iters: number): Promise<number> {
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) await fn();
  return performance.now() - t0;
}

export async function microbench(
  name: string,
  fn: () => unknown,
  opts: BenchOptions = {},
): Promise<BenchResult> {
  const batchMs = opts.batchMs ?? 200;
  const samples = opts.samples ?? 12;
  const warmupBatches = opts.warmupBatches ?? 3;

  // Calibrate: grow the batch until it spans at least batchMs.
  let iters = 1;
  // Prime once so the first measurement isn't a cold call.
  await fn();
  for (;;) {
    const ms = await timeBatch(fn, iters);
    if (ms >= batchMs || iters >= 1 << 30) break;
    // Scale toward the target, capped at 8x growth per step.
    const factor = Math.min(
      8,
      Math.max(2, Math.ceil(batchMs / Math.max(ms, 0.01))),
    );
    iters *= factor;
  }

  for (let i = 0; i < warmupBatches; i++) await timeBatch(fn, iters);

  // Collect the warmup garbage ONCE (if gc is exposed) so timed batches run on a
  // settled heap, then let the heap stay warm across batches — forcing GC before
  // every batch was found to inflate the median by preventing steady state.
  gc?.();

  const perOp: number[] = [];
  for (let s = 0; s < samples; s++) {
    const ms = await timeBatch(fn, iters);
    perOp.push((ms * 1e6) / iters); // ms -> ns, per op
  }

  const nsPerOp = median(perOp);
  return {
    name,
    nsPerOp,
    opsPerSec: 1e9 / nsPerOp,
    p25NsPerOp: percentile(perOp, 25),
    p75NsPerOp: percentile(perOp, 75),
    minNsPerOp: Math.min(...perOp),
    maxNsPerOp: Math.max(...perOp),
    batchIters: iters,
    samples,
  };
}
