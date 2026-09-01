import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { bundleAnalysisLines, bundleSummaryLines } from "../src/build/bundle-report.ts";

Deno.test("bundleSummaryLines: a fully-static app reports 0 KB", () => {
  const lines = bundleSummaryLines(5, 5, []);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "5 route(s), 5 ship 0 KB JS");
  assertStringIncludes(lines[0], "client JS 0.0 KB in 0 chunk(s)");
});

Deno.test("bundleSummaryLines: reports the total and the largest chunks first", () => {
  const lines = bundleSummaryLines(3, 1, [
    { name: "a.js", bytes: 1024 },
    { name: "runtime.js", bytes: 4096 },
    { name: "b.js", bytes: 2048 },
  ]);
  assertStringIncludes(lines[0], "3 route(s), 1 ship 0 KB JS");
  assertStringIncludes(lines[0], "client JS 7.0 KB in 3 chunk(s)");
  assertStringIncludes(lines[1], "runtime.js — 4.0 KB"); // largest first
  assertStringIncludes(lines[2], "b.js — 2.0 KB");
});

Deno.test("bundleAnalysisLines: 0-JS app is celebrated, not an empty table", () => {
  const lines = bundleAnalysisLines([]);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "0 KB");
});

Deno.test("bundleAnalysisLines: ranks by gzip, shows share%, bars, and raw·gz totals", () => {
  const lines = bundleAnalysisLines([
    { name: "small.js", bytes: 2048, gzip: 512 },
    { name: "runtime.js", bytes: 8192, gzip: 3072 },
  ]);
  // Header carries both totals (10 KB raw, 3.5 KB gz) and the chunk count.
  assertStringIncludes(lines[0], "10.0 KB raw");
  assertStringIncludes(lines[0], "3.5 KB gz");
  assertStringIncludes(lines[0], "2 chunk(s)");
  // Ranked by gzip: the runtime chunk (3 KB gz) comes before small (0.5 KB gz).
  const runtimeRow = lines.findIndex((l) => l.includes("runtime.js"));
  const smallRow = lines.findIndex((l) => l.includes("small.js"));
  assert(runtimeRow < smallRow, "larger gzip chunk must rank first");
  // The largest chunk's bar is fully filled; every row shows a share% and raw·gz.
  assertStringIncludes(lines[runtimeRow], "█");
  assertStringIncludes(lines[runtimeRow], "%");
  assertStringIncludes(lines[runtimeRow], "gz");
});
