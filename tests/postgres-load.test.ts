// The reusable load harness from examples/postgres-load is exercised here against
// in-process tasks — no server, no database. This proves the harness's own math
// (success/failure accounting, throughput, latency percentiles, bounded
// concurrency) is correct, so the Postgres numbers it reports can be trusted.
//
// The actual Postgres-under-load run lives in the example (README) because it
// needs a real database; DATABASE.md is explicit that networked drivers are
// validated by you, not in denext's CI.

import { assert, assertEquals } from "@std/assert";
import { formatLoad, type LoadResult, runLoad } from "../examples/postgres-load/load.ts";

Deno.test("runLoad: counts successes and failures without aborting", async () => {
  // Even indices succeed, odd indices fail; index 7 throws (still counts failed).
  const result = await runLoad((i) => {
    if (i === 7) throw new Error("boom");
    return Promise.resolve(i % 2 === 0);
  }, { concurrency: 4, total: 10 });

  assertEquals(result.total, 10);
  assertEquals(result.ok, 5); // 0,2,4,6,8
  assertEquals(result.failed, 5); // 1,3,5,7(threw),9
  assert(result.wallMs >= 0);
});

Deno.test("runLoad: never runs more than `concurrency` tasks at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const result = await runLoad(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return true;
  }, { concurrency: 5, total: 50 });

  assertEquals(result.ok, 50);
  assert(peak <= 5, `peak concurrency ${peak} exceeded the limit of 5`);
  assert(peak >= 2, "the pool should actually run tasks in parallel");
});

Deno.test("runLoad: latency percentiles are ordered and throughput is positive", async () => {
  const result = await runLoad(async (i) => {
    // Monotonically increasing work so percentiles are meaningfully spread.
    await new Promise((r) => setTimeout(r, 1 + (i % 5)));
    return true;
  }, { concurrency: 8, total: 40 });

  const l = result.latency;
  assert(l.min <= l.p50, "min <= p50");
  assert(l.p50 <= l.p90, "p50 <= p90");
  assert(l.p90 <= l.p99, "p90 <= p99");
  assert(l.p99 <= l.max, "p99 <= max");
  assert(l.mean > 0, "mean latency is positive");
  assert(result.rps > 0, "throughput is positive");
});

Deno.test("runLoad: an empty run is well-defined (no NaN)", async () => {
  const result = await runLoad(() => Promise.resolve(true), { concurrency: 4, total: 0 });
  assertEquals(result.total, 0);
  assertEquals(result.ok, 0);
  assertEquals(result.rps, 0);
  assertEquals(result.latency.p50, 0);
});

Deno.test("formatLoad: renders the key metrics", () => {
  const sample: LoadResult = {
    total: 100,
    ok: 100,
    failed: 0,
    wallMs: 500,
    rps: 200,
    latency: { min: 1, mean: 3, p50: 2, p90: 5, p99: 8, max: 12 },
  };
  const text = formatLoad(sample);
  assert(text.includes("100/100 ok"));
  assert(text.includes("throughput"));
  assert(text.includes("p99"));
});
