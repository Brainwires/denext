// Unit coverage for the profiler's pure pieces — CPU self-time aggregation, the budget
// gate, the leak decision, and report formatting. The live browser path (build + serve +
// CDP) is exercised by tests/e2e/profile.e2e.test.ts (opt-in, needs Chromium).

import { assertAlmostEquals, assertEquals, assertStringIncludes } from "@std/assert";
import { aggregateSelfTime, type RawCpuProfile } from "../src/profile/cpu.ts";
import { budgetFromRun, evaluateBudget } from "../src/profile/budget.ts";
import { DEFAULT_LEAK_TOLERANCE_BYTES, type HeapResult, isLeak } from "../src/profile/heap.ts";
import { profileReportLines } from "../src/profile/report.ts";
import type { ProfileResult } from "../src/profile/types.ts";

/** A profile with two functions; `render` sampled 3× (30ms), `idle` 1× (10ms). */
function sampleProfile(): RawCpuProfile {
  return {
    startTime: 0,
    endTime: 40_000, // µs
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "" } },
      { id: 2, callFrame: { functionName: "render", url: "file:///app.js", lineNumber: 9 } },
      { id: 3, callFrame: { functionName: "idle", url: "file:///app.js", lineNumber: 40 } },
      // Same function reached via a second call site — must fold into the `render` row.
      { id: 4, callFrame: { functionName: "render", url: "file:///app.js", lineNumber: 9 } },
    ],
    samples: [2, 2, 3, 4],
    timeDeltas: [10_000, 10_000, 10_000, 10_000],
  };
}

Deno.test("aggregateSelfTime: self-time by function, folded and sorted", () => {
  const r = aggregateSelfTime(sampleProfile());
  assertEquals(r.sampleCount, 4);
  assertAlmostEquals(r.totalMs, 40, 0.001);
  // render = 3 samples across two nodes (2 + 4) = 30ms; idle = 10ms.
  assertEquals(r.topSelfTime[0].name, "render");
  assertAlmostEquals(r.topSelfTime[0].selfMs, 30, 0.001);
  assertAlmostEquals(r.topSelfTime[0].pct, 75, 0.001);
  assertEquals(r.topSelfTime[0].line, 10); // 0-based 9 → 1-based 10
  assertEquals(r.topSelfTime[1].name, "idle");
  assertAlmostEquals(r.topSelfTime[1].selfMs, 10, 0.001);
});

Deno.test("aggregateSelfTime: falls back to hitCount when no sample stream", () => {
  const r = aggregateSelfTime({
    startTime: 0,
    endTime: 20_000,
    nodes: [
      { id: 1, callFrame: { functionName: "a", url: "file:///x.js", lineNumber: 0 }, hitCount: 3 },
      { id: 2, callFrame: { functionName: "b", url: "file:///x.js", lineNumber: 1 }, hitCount: 1 },
    ],
  });
  assertEquals(r.sampleCount, 4);
  assertEquals(r.topSelfTime[0].name, "a");
  assertAlmostEquals(r.topSelfTime[0].pct, 75, 0.001);
});

Deno.test("aggregateSelfTime: topN caps the rows", () => {
  const nodes = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    callFrame: { functionName: `fn${i}`, url: "file:///x.js", lineNumber: i },
    hitCount: 30 - i,
  }));
  const r = aggregateSelfTime({ startTime: 0, endTime: 1000, nodes }, 5);
  assertEquals(r.topSelfTime.length, 5);
  assertEquals(r.topSelfTime[0].name, "fn0");
});

Deno.test("isLeak: within tolerance is not a leak; beyond is", () => {
  assertEquals(isLeak(1_000_000, 1_000_000 + DEFAULT_LEAK_TOLERANCE_BYTES - 1), false);
  assertEquals(isLeak(1_000_000, 1_000_000 + DEFAULT_LEAK_TOLERANCE_BYTES + 1), true);
  assertEquals(isLeak(1_000_000, 1_100_000, 200_000), false);
});

const CPU = {
  topSelfTime: [{ name: "render", url: "", line: 0, selfMs: 30, pct: 75 }],
  totalMs: 40,
  sampleCount: 4,
};
const HEAP: HeapResult = {
  beforeBytes: 1_000,
  afterBytes: 5_000,
  afterGcBytes: 1_200,
  leaked: false,
};

Deno.test("evaluateBudget: passes within budget", () => {
  const v = evaluateBudget({ maxHeapGrowthBytes: 10_000, maxLeakedBytes: 1_000 }, CPU, HEAP);
  assertEquals(v.passed, true);
  assertEquals(v.violations.length, 0);
});

Deno.test("evaluateBudget: flags heap growth, leak, and hot-fn breaches", () => {
  const v = evaluateBudget(
    {
      maxHeapGrowthBytes: 1_000,
      maxLeakedBytes: 100,
      hotFns: [{ name: "render", maxSelfPct: 50 }],
    },
    CPU,
    HEAP,
  );
  assertEquals(v.passed, false);
  const kinds = v.violations.map((x) => x.kind).sort();
  assertEquals(kinds, ["heap-growth", "hot-fn", "leaked"]);
});

Deno.test("budgetFromRun: applies headroom over the measured run", () => {
  const b = budgetFromRun(CPU, HEAP, 1.2);
  // growth = 4000 → ×1.2 = 4800
  assertEquals(b.maxHeapGrowthBytes, 4_800);
  // leaked = 200 → ×1.2 = 240
  assertEquals(b.maxLeakedBytes, 240);
  assertEquals(b.hotFns?.[0].name, "render");
  assertEquals(b.hotFns?.[0].maxSelfPct, 90); // ceil(75 × 1.2)
});

Deno.test("profileReportLines: renders header, CPU, heap, and budget verdict", () => {
  const result: ProfileResult = {
    route: "/",
    origin: "http://127.0.0.1:1234",
    cpu: CPU,
    heap: HEAP,
    budget: {
      passed: false,
      violations: [{ kind: "leaked", detail: "retained too much", actual: 1, limit: 0 }],
    },
    minified: false,
  };
  const text = profileReportLines(result).join("\n");
  assertStringIncludes(text, "denext profile ▸ /");
  assertStringIncludes(text, "unminified");
  assertStringIncludes(text, "render");
  assertStringIncludes(text, "Heap ▸");
  assertStringIncludes(text, "Budget ▸ ✖");
  assertStringIncludes(text, "retained too much");
});
