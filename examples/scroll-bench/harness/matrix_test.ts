import { assert, assertEquals } from "@std/assert";
import { cellSteps, DEFAULT_CONFIG, expandMatrix, loadConfig, renderMarkdown } from "./matrix.ts";

Deno.test("expandMatrix: every app × impl × kind × size, with catalogue skips", () => {
  const cells = expandMatrix(DEFAULT_CONFIG);
  // denext: 7 impls, rn: 4 impls; 4 kinds; 5 sizes
  assertEquals(cells.length, (7 + 4) * 4 * 5);
  const byId = new Map(cells.map((c) => [c.id, c]));
  assertEquals(byId.get("denext-dom-fixed-10k")?.plan.run, true);
  assertEquals(byId.get("denext-dom-fixed-100k")?.plan.run, false);
  assertEquals(byId.get("denext-cv-chat-100k")?.plan.run, true);
  assertEquals(byId.get("denext-cv-chat-1M")?.plan.run, false);
  assertEquals(byId.get("denext-legend-fixed-10M")?.plan.run, true);
  assertEquals(byId.get("denext-legend-chat-10M")?.plan.run, false); // 10M is fixed-only
  assertEquals(byId.get("denext-denext-fixed-1k")?.plan.run, false); // placeholder
  assertEquals(byId.get("rn-sectionlist-sections-1M")?.plan.run, true);
  assertEquals(byId.get("rn-sectionlist-chat-1k")?.plan.run, false);
});

Deno.test("cellSteps: chat flings backward first and gets append/prepend", () => {
  const cfg = loadConfig({
    flings: 2,
    drags: 1,
    jumps: [0.5],
    append: { k: 10, times: 2, kinds: ["chat"] },
  });
  const chat = expandMatrix(cfg).find((c) => c.id === "rn-flash-chat-10k")!;
  const steps = cellSteps(chat, cfg);
  assertEquals(steps[0], {
    type: "launch",
    link: "rnscrollbench://run?list=flash&kind=chat&n=10000&seed=1",
  });
  assertEquals(steps[1], { type: "fling", forward: false, count: 2 });
  assert(
    steps.some((s) =>
      s.type === "action" &&
      s.link === "rnscrollbench://action?op=scrollToIndex&i=5000"
    ),
  );
  assertEquals(
    steps.filter((s) => s.type === "action" && s.phase === "append").length,
    2,
  );
  assertEquals(
    steps.filter((s) => s.type === "action" && s.phase === "prepend").length,
    3,
  );

  const fixed = expandMatrix(cfg).find((c) => c.id === "denext-virtua-fixed-1k")!;
  const fs = cellSteps(fixed, cfg);
  assertEquals(fs[1], { type: "fling", forward: true, count: 2 });
  assertEquals(
    fs.filter((s) => s.type === "action" && s.phase !== "jump").length,
    0,
  );
  assert(
    fs.some((s) =>
      s.type === "action" &&
      s.link === "denextscrollbench://action?op=scrollToIndex&i=500"
    ),
  );
});

Deno.test("renderMarkdown: one row per cell, statuses spelled out", () => {
  const md = renderMarkdown([
    {
      id: "a",
      app: "rn",
      impl: "flash",
      kind: "chat",
      n: 1000,
      status: "ok",
      startedAt: "",
      launchToReadyMs: 812,
    },
    {
      id: "b",
      app: "denext",
      impl: "dom",
      kind: "fixed",
      n: 100000,
      status: "skipped",
      reason: "dom is capped at n=10000",
      startedAt: "",
    },
    {
      id: "c",
      app: "denext",
      impl: "legend",
      kind: "fixed",
      n: 10_000_000,
      status: "oom",
      failedPhase: "ready",
      startedAt: "",
    },
  ], "# t");
  assert(md.includes("| rn | flash | chat | 1k | ok | 812 ms |"));
  assert(md.includes("**skipped**: dom is capped at n=10000"));
  assert(md.includes("**oom** (ready)"));
});
