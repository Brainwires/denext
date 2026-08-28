import { assertEquals, assertStringIncludes } from "@std/assert";
import { bundleSummaryLines } from "../src/build/bundle-report.ts";

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
