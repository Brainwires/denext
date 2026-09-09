// Real-browser e2e for `denext profile` / `profileApp`: build examples/islands unminified,
// serve it, drive headless Chromium via the CDP Profiler + HeapProfiler domains, and assert
// the whole pipeline produces a well-formed result — CPU self-time with readable (unminified)
// function names, a heap growth + leak reading, and a budget gate that fires on a breach.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run). Excluded from
// `deno task check`. This is the only test that exercises the live CDP capture path; the
// pure aggregation/budget/report pieces are covered by tests/profile-core.test.ts.

import { assert, assertEquals } from "@std/assert";
import { profileApp } from "../../src/profile/core.ts";

const EXAMPLE = new URL("../../examples/islands", import.meta.url).pathname;

Deno.test({
  name: "e2e: profileApp builds unminified, captures CPU self-time + heap, and gates a budget",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const result = await profileApp(EXAMPLE, { route: "/", iterations: 2, topN: 15 });

  // Built unminified so the profile carries real function names, not mangled ones.
  assertEquals(result.minified, false);
  assert(result.origin.startsWith("http://127.0.0.1:"), `origin: ${result.origin}`);

  // A CPU profile was captured; when samples landed, at least one frame has a source name.
  assert(result.cpu.totalMs >= 0, "totalMs should be non-negative");
  if (result.cpu.sampleCount > 0) {
    assert(result.cpu.topSelfTime.length > 0, "expected self-time rows for a rendered app");
    const named = result.cpu.topSelfTime.some((f) => f.name && f.name !== "(anonymous)");
    assert(named, "expected at least one named frame (unminified build)");
  }

  // Heap was measured (precise-memory flag → non-zero) and the leak flag is a boolean.
  assert(result.heap.beforeBytes > 0, "expected a measurable heap baseline");
  assertEquals(typeof result.heap.leaked, "boolean");

  // A deliberately impossible budget must be flagged as exceeded.
  const gated = await profileApp(EXAMPLE, {
    route: "/",
    iterations: 1,
    budget: { maxLeakedBytes: -1 }, // any retained byte breaches
  });
  assert(gated.budget, "expected a budget verdict");
  assertEquals(gated.budget?.passed, false);
  assert(
    gated.budget!.violations.some((v) => v.kind === "leaked"),
    "expected a leaked-budget violation",
  );
});
