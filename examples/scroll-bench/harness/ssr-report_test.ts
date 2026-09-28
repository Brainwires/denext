import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  cellId,
  type CellRecord,
  frameSummary,
  medians,
  METRIC_KEYS,
  renderSsrMarkdown,
  type RunMetrics,
  skippedByFailure,
  summaryCell,
  timeToInteractive,
  totalBlockingTime,
} from "./ssr-report.ts";

const run = (over: Partial<RunMetrics>): RunMetrics => {
  const base = Object.fromEntries(METRIC_KEYS.map((k) => [k, null])) as unknown as RunMetrics;
  return { ...base, findOk: null, ...over };
};

Deno.test("timeToInteractive: the end of the last long task before a 500 ms quiet window", () => {
  const longTasks = [
    { start: 100, duration: 80 }, // ends 180
    { start: 400, duration: 200 }, // starts 220 after: inside the window → ends 600
    { start: 1200, duration: 60 }, // 600 ms after 600: outside the window
  ];
  assertEquals(timeToInteractive({ fcp: 150, dcl: 50, longTasks }), 600);
  // Unsorted input is sorted first.
  assertEquals(timeToInteractive({ fcp: 150, dcl: 50, longTasks: [...longTasks].reverse() }), 600);
  // No long task: FCP, but never before DOMContentLoaded or the last hydration.
  assertEquals(timeToInteractive({ fcp: 150, dcl: 300, longTasks: [] }), 300);
  assertEquals(timeToInteractive({ fcp: 150, dcl: 50, longTasks: [], hydratedAt: 900 }), 900);
  assertEquals(timeToInteractive({ fcp: 150, dcl: 50, longTasks, quietMs: 100 }), 180);
});

Deno.test("totalBlockingTime: the part over 50 ms of each long task between FCP and TTI", () => {
  const longTasks = [
    { start: 0, duration: 90 }, // ends before FCP
    { start: 120, duration: 90 }, // 40
    { start: 300, duration: 40 }, // under 50: 0
    { start: 500, duration: 150 }, // 100
    { start: 2000, duration: 300 }, // after TTI
  ];
  assertEquals(totalBlockingTime(100, 1000, longTasks), 140);
});

Deno.test("frameSummary: rAF intervals at 60 Hz, like the SurfaceFlinger summary", () => {
  const s = frameSummary([16.7, 16.6, 16.7, 33.4, 16.7, 16.6, 16.7, 16.7, 16.6, 50, 0, 5000]);
  assertEquals(s.frames, 10); // 0 and > 1 s dropped
  assertEquals(s.missedPct, 20);
  assertEquals(s.maxMs, 50);
  assertEquals(s.p90Ms, 33.4);
});

Deno.test("medians: per metric over the runs, findOk by majority", () => {
  const m = medians([
    run({ ttiMs: 300, findOk: true }),
    run({ ttiMs: 100, findOk: false }),
    run({ ttiMs: 200, findOk: true, clickMs: 12 }),
  ]);
  assertEquals(m.ttiMs, 200);
  assertEquals(m.clickMs, 12);
  assertEquals(m.findOk, true);
  assertEquals(m.lcpMs, null);
  assertEquals(medians([run({ ttiMs: 100 }), run({ ttiMs: 201 })]).ttiMs, 150.5);
  assertEquals(medians([]).findOk, null);
});

const record = (over: Partial<CellRecord>): CellRecord => {
  const c = { impl: "static", kind: "fixed", n: 1000, profile: "desktop" as const, ...over };
  return { id: cellId(c), runs: [], failures: [], median: {}, ...c };
};

Deno.test("skippedByFailure: a failed smaller size of the same impl/kind/profile", () => {
  const failed = record({ n: 50_000, failures: ["no load event within 60 s"] });
  const ok = record({ n: 10_000, runs: [run({})] });
  const cell = { impl: "static", kind: "fixed", n: 100_000, profile: "desktop" as const };
  assertEquals(skippedByFailure(cell, [ok, failed]), "skipped: static-fixed-50k-desktop failed");
  assertEquals(skippedByFailure({ ...cell, profile: "mobile" }, [ok, failed]), null);
  assertEquals(skippedByFailure({ ...cell, n: 10_000 }, [failed]), null);
  const slow = record({ n: 10_000, runs: [run({})], median: { ttiMs: 31_400 } });
  assertEquals(skippedByFailure(cell, [slow]), null);
  assertEquals(
    skippedByFailure(cell, [slow], 30_000),
    "skipped: static-fixed-10k-desktop was unusable (time to interactive 31 s)",
  );
});

Deno.test("renderSsrMarkdown: a table per metric, failures, skips and the props payload", () => {
  const cells = [
    record({ n: 100, runs: [run({})], median: medians([run({ ttiMs: 120, findOk: true })]) }),
    record({ n: 50_000, failures: ["renderer crashed"] }),
    record({ n: 100_000, failures: ["skipped: static-fixed-50k-desktop failed"] }),
    record({
      impl: "virtual-island",
      n: 100,
      runs: [run({})],
      median: medians([run({ clickMs: 20, click2Ms: 8, frameP90Ms: 16.7, frameMissedPct: 2 })]),
      dataJsonBytes: 2048,
    }),
  ];
  const md = renderSsrMarkdown({
    date: "2026-09-27",
    machine: "test",
    chromium: "125",
    loadavgStart: "1",
    loadavgEnd: "1",
    runsPerCell: 3,
    profiles: { desktop: "d", mobile: "m" },
    notes: ["a note"],
    findings: "## Findings\n\n- static wins",
  }, cells);
  assertStringIncludes(md, "(2026-09-27)\n\n## Findings\n\n- static wins\n");
  assertStringIncludes(md, "## desktop · fixed");
  assertStringIncludes(md, "| impl | 100 | 50k | 100k |");
  assertStringIncludes(md, "| static | 120 | FAIL | skip |");
  assertStringIncludes(md, "| virtual-island | 20 / 8 |  |  |");
  assertStringIncludes(md, "| virtual-island | 17 / 2% |  |  |");
  assertStringIncludes(md, "| static | yes (— in DOM) | FAIL | skip |");
  assertStringIncludes(md, "- static-fixed-50k-desktop: renderer crashed");
  assertStringIncludes(md, "| fixed | 2 KB | — | — |");
  assert(md.includes("- a note"));
});

Deno.test("summaryCell: medians and failures, the run count instead of the runs", () => {
  const c = record({ runs: [run({}), run({})], failures: ["x"] });
  const s = summaryCell(c);
  assertEquals(s.runCount, 2);
  assertEquals("runs" in s, false);
  assertEquals(s.failures, ["x"]);
});
