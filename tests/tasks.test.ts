import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  clearTasks,
  collectSchedules,
  defineTask,
  getTask,
  isTask,
  registerTask,
  runTask,
  scheduleTasks,
  taskNames,
} from "../src/server/tasks.ts";

function reset() {
  clearTasks();
}

Deno.test("defineTask brands the task and validates its schedule up front", () => {
  const t = defineTask({ handler: () => 1, schedule: "*/5 * * * *" });
  assert(isTask(t));
  assert(!isTask({ handler: () => 1 }));
  assertThrows(() => defineTask({ handler: () => 1, schedule: "bogus" }), Error);
});

Deno.test("register / getTask / taskNames / runTask", async () => {
  reset();
  let seen: unknown = null;
  registerTask("cleanup", defineTask({ handler: (ctx) => (seen = ctx, "done") }));
  registerTask("reports/daily", defineTask({ handler: () => 42 }));
  assertEquals(taskNames(), ["cleanup", "reports/daily"]);
  assert(getTask("cleanup"));

  const out = await runTask("cleanup", { id: 7 });
  assertEquals(out, "done");
  assertEquals((seen as { name: string }).name, "cleanup");
  assertEquals((seen as { payload: unknown }).payload, { id: 7 });
  assertEquals((seen as { trigger: string }).trigger, "manual");

  assertEquals(await runTask("reports/daily"), 42);
  await assertRejects(() => runTask("nope"), Error, 'no task named "nope"');
});

Deno.test("collectSchedules merges config + per-task schedules and dedupes", () => {
  reset();
  registerTask("a", defineTask({ handler: () => {}, schedule: "0 3 * * *" }));
  registerTask("b", defineTask({ handler: () => {} }));
  const entries = collectSchedules({
    "*/15 * * * *": ["a", "b"],
    "0 0 * * 0": "b",
    "0 3 * * *": "a", // same as a's own schedule → deduped
  });
  const keys = entries.map((e) => `${e.task} ${e.cron}`).sort();
  assertEquals(keys, [
    "a */15 * * * *",
    "a 0 3 * * *",
    "b */15 * * * *",
    "b 0 0 * * 0",
  ]);
});

Deno.test("scheduleTasks uses Deno.cron when available and passes the schedule string through", () => {
  reset();
  registerTask("job", defineTask({ handler: () => {} }));
  const calls: Array<{ name: string; schedule: string }> = [];
  const denoAny = Deno as { cron?: unknown };
  const had = "cron" in denoAny;
  const prev = denoAny.cron;
  denoAny.cron = (name: string, schedule: string, _h: () => unknown) => {
    calls.push({ name, schedule });
  };
  try {
    const dispose = scheduleTasks([{ cron: "*/5 * * * *", task: "job" }]);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].schedule, "*/5 * * * *");
    assert(calls[0].name.includes("job"));
    dispose();
  } finally {
    if (had) denoAny.cron = prev;
    else delete denoAny.cron;
  }
});

Deno.test("scheduleTasks skips a bad cron and an unknown task, without throwing", () => {
  reset();
  registerTask("real", defineTask({ handler: () => {} }));
  // No Deno.cron here (2.9.6 without --unstable-cron) → the userland scheduler; just assert it
  // returns a disposer and doesn't throw on the invalid entries.
  const dispose = scheduleTasks([
    { cron: "not-a-cron", task: "real" },
    { cron: "*/5 * * * *", task: "ghost" },
    { cron: "* * * * *", task: "real" },
  ]);
  assertEquals(typeof dispose, "function");
  dispose();
});
