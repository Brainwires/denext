// `denext profile --filter / --out / --compare`: the CPU row filter, saving a run and comparing
// a later one with it (src/profile/compare.ts, the report lines and the CLI's finishing step).

import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aggregateSelfTime, frameFilter, type RawCpuProfile } from "../src/profile/cpu.ts";
import { compareProfiles, isProfileResult } from "../src/profile/compare.ts";
import { comparisonLines, profileReportLines } from "../src/profile/report.ts";
import type { ProfileResult } from "../src/profile/types.ts";
import { finishProfileRun } from "../src/cli/commands/profile.ts";

/** `TodoList` 30ms, `zodParse` (from a package) 20ms, `idle` 10ms. */
function profile(): RawCpuProfile {
  return {
    startTime: 0,
    endTime: 60_000,
    nodes: [
      { id: 1, callFrame: { functionName: "TodoList", url: "file:///app/list.js", lineNumber: 1 } },
      {
        id: 2,
        callFrame: {
          functionName: "zodParse",
          url: "file:///node_modules/zod/x.js",
          lineNumber: 4,
        },
      },
      { id: 3, callFrame: { functionName: "idle", url: "file:///app/main.js", lineNumber: 9 } },
    ],
    samples: [1, 1, 1, 2, 2, 3],
    timeDeltas: [10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
  };
}

Deno.test("aggregateSelfTime: a filter keeps matching rows by name or source; totals stay whole", () => {
  const byName = aggregateSelfTime(profile(), 20, frameFilter("todo"));
  assertEquals(byName.topSelfTime.map((f) => f.name), ["TodoList"]);
  assertAlmostEquals(byName.totalMs, 60, 0.001);
  assertAlmostEquals(byName.topSelfTime[0].pct, 50, 0.001);
  const bySource = aggregateSelfTime(profile(), 20, frameFilter("NODE_MODULES/zod"));
  assertEquals(bySource.topSelfTime.map((f) => f.name), ["zodParse"]);
  // The filter applies before the topN cut.
  assertEquals(aggregateSelfTime(profile(), 1, frameFilter("idle")).topSelfTime[0].name, "idle");
});

/** A saved-shaped run over `rows` (name → self ms) with the given heap numbers. */
function run(rows: Record<string, number>, heap: [number, number, number]): ProfileResult {
  const total = Object.values(rows).reduce((a, b) => a + b, 0);
  return {
    route: "/",
    origin: "http://127.0.0.1:1",
    cpu: {
      topSelfTime: Object.entries(rows).map(([name, selfMs]) => ({
        name,
        url: `file:///chunk-${name}.js`,
        line: 1,
        selfMs,
        pct: (selfMs / total) * 100,
      })),
      totalMs: total,
      sampleCount: 10,
    },
    heap: { beforeBytes: heap[0], afterBytes: heap[1], afterGcBytes: heap[2], leaked: false },
    minified: false,
  };
}

Deno.test("compareProfiles: per-function deltas by name, largest first, plus totals and heap", () => {
  const before = run({ render: 30, parse: 10, gone: 5 }, [1000, 3000, 1100]);
  const after = run({ render: 32, parse: 25, fresh: 4 }, [1000, 6000, 1500]);
  const cmp = compareProfiles(before, after);
  assertEquals(cmp.rows.map((r) => [r.name, r.deltaMs]), [
    ["parse", 15],
    ["gone", -5],
    ["fresh", 4],
    ["render", 2],
  ]);
  assertEquals(cmp.totalMs, { base: 45, now: 61, delta: 16 });
  assertEquals(cmp.heapGrowth, { base: 2000, now: 5000, delta: 3000 });
  assertEquals(cmp.retained, { base: 100, now: 500, delta: 400 });
  const text = comparisonLines(cmp).join("\n");
  assertStringIncludes(text, "Compare ▸ saved run of /");
  assertStringIncludes(text, "45.0ms → 61.0ms  (+16.0ms)");
  assertStringIncludes(text, "+15.0ms");
  assertStringIncludes(text, "-5.0ms");
  assertStringIncludes(text, "(+400 B)");
});

Deno.test("profileReportLines: the header names the filter", () => {
  const r = { ...run({ render: 1 }, [0, 0, 0]), filter: "Todo" };
  assertStringIncludes(profileReportLines(r)[0], 'filter "Todo"');
});

Deno.test("finishProfileRun: --out saves a run that --compare reads back", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_profile_cmp_" });
  try {
    const out = join(dir, "run.json");
    const budget = join(dir, "budget.json");
    const first = run({ render: 30 }, [1000, 2000, 1000]);
    assertEquals(await finishProfileRun(first, { out, writeBudget: budget }), undefined);
    const saved = JSON.parse(await Deno.readTextFile(out));
    assert(isProfileResult(saved), "the saved file is a run");
    assert(JSON.parse(await Deno.readTextFile(budget)).maxHeapGrowthBytes > 0);
    const cmp = await finishProfileRun(run({ render: 20 }, [1000, 2000, 1000]), {
      out: "",
      writeBudget: "",
      saved,
    });
    assertEquals(cmp?.rows[0], { name: "render", baseMs: 30, nowMs: 20, deltaMs: -10 });
    assert(!isProfileResult({ cpu: {} }));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
