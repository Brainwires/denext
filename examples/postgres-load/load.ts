// A small, dependency-free concurrent load harness. `runLoad` drives a fixed
// number of tasks through a fixed-size worker pool and reports throughput and
// latency percentiles — the numbers you need to answer "does my Postgres pool
// hold up under load?" honestly.
//
// It's deliberately generic (a task is just `(i) => Promise<boolean>`), so the
// harness itself is unit-tested against in-process tasks (no server, no database)
// while the CLI at the bottom points it at a running denext endpoint.
//
// CLI (against a running `deno task start` on port 3005):
//   deno run -A load.ts http://localhost:3005/api/hit
//   CONCURRENCY=100 REQUESTS=5000 deno run -A load.ts

/** How much load to apply. */
export interface LoadOptions {
  /** Number of tasks in flight at once (the pool of virtual users). */
  concurrency: number;
  /** Total tasks to run. */
  total: number;
}

/** Latency distribution in milliseconds. */
export interface Latency {
  /** Fastest task. */
  min: number;
  /** Arithmetic mean. */
  mean: number;
  /** Median (50th percentile). */
  p50: number;
  /** 90th percentile. */
  p90: number;
  /** 99th percentile. */
  p99: number;
  /** Slowest task. */
  max: number;
}

/** The outcome of a {@linkcode runLoad} run. */
export interface LoadResult {
  /** Tasks attempted. */
  total: number;
  /** Tasks that reported success. */
  ok: number;
  /** Tasks that reported failure or threw. */
  failed: number;
  /** Wall-clock duration of the whole run, in milliseconds. */
  wallMs: number;
  /** Successful tasks per second (throughput). */
  rps: number;
  /** Per-task latency percentiles. */
  latency: Latency;
}

/**
 * Run `total` tasks through a pool of `concurrency` workers, measuring each
 * task's latency. A task resolves `true` for success, `false` (or throws) for
 * failure; failures never abort the run.
 *
 * @param task Produces the i-th task's promise.
 * @param opts Concurrency and total count.
 * @returns A {@linkcode LoadResult} with throughput and latency percentiles.
 */
export async function runLoad(
  task: (i: number) => Promise<boolean>,
  opts: LoadOptions,
): Promise<LoadResult> {
  const latencies: number[] = [];
  let ok = 0;
  let failed = 0;
  let next = 0;

  const start = performance.now();
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= opts.total) return;
      const t0 = performance.now();
      let good = false;
      try {
        good = await task(i);
      } catch {
        good = false;
      }
      latencies.push(performance.now() - t0);
      if (good) ok++;
      else failed++;
    }
  };

  const width = Math.max(1, Math.min(opts.concurrency, opts.total));
  await Promise.all(Array.from({ length: width }, worker));
  const wallMs = performance.now() - start;

  latencies.sort((a, b) => a - b);
  const pct = (p: number): number =>
    latencies.length === 0 ? 0 : latencies[
      Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))
    ];
  const mean = latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length;

  return {
    total: opts.total,
    ok,
    failed,
    wallMs,
    rps: wallMs > 0 ? (ok / wallMs) * 1000 : 0,
    latency: {
      min: latencies[0] ?? 0,
      mean,
      p50: pct(50),
      p90: pct(90),
      p99: pct(99),
      max: latencies[latencies.length - 1] ?? 0,
    },
  };
}

/** Round to one decimal place for display. */
const r1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);

/**
 * Render a {@linkcode LoadResult} as a compact human-readable block.
 *
 * @param result The result to format.
 * @returns A multi-line string.
 */
export function formatLoad(result: LoadResult): string {
  const l = result.latency;
  return [
    `  requests   ${result.ok}/${result.total} ok` +
    (result.failed ? `  (${result.failed} failed)` : ""),
    `  wall       ${r1(result.wallMs)} ms`,
    `  throughput ${r1(result.rps)} req/s`,
    `  latency    min ${r1(l.min)}  p50 ${r1(l.p50)}  p90 ${r1(l.p90)}  ` +
    `p99 ${r1(l.p99)}  max ${r1(l.max)} ms`,
  ].join("\n");
}

if (import.meta.main) {
  const url = Deno.args[0] ?? Deno.env.get("TARGET_URL") ??
    "http://localhost:3005/api/hit";
  const concurrency = Number(Deno.env.get("CONCURRENCY") ?? "50");
  const total = Number(Deno.env.get("REQUESTS") ?? "2000");

  console.log(
    `\n  load: ${total} POSTs @ concurrency ${concurrency}  ▸  ${url}\n`,
  );
  const result = await runLoad(async () => {
    const res = await fetch(url, { method: "POST" });
    await res.body?.cancel();
    return res.ok;
  }, { concurrency, total });
  console.log(formatLoad(result));
  console.log(
    result.failed === 0
      ? "\n  PASS — every request succeeded; the pool absorbed the concurrency.\n"
      : `\n  ${result.failed} request(s) failed — inspect the pool size vs. concurrency.\n`,
  );
  if (result.failed > 0) Deno.exit(1);
}
