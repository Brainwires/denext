import { assert, assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert";
import {
  clearTasks,
  collectSchedules,
  defineTask,
  getTask,
  isTask,
  registerTask,
  runTask,
  scheduleTasks,
  setTaskRecorder,
  taskNames,
  type TaskRunRecord,
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

/** A recorded `Deno.cron` registration. */
interface CronCall {
  name: string;
  schedule: string;
  handler: () => unknown;
}

/** Run `work` with `Deno.cron` replaced by a recorder, restoring whatever was there after. */
async function withFakeDenoCron(work: (calls: CronCall[]) => Promise<void> | void) {
  const calls: CronCall[] = [];
  const denoAny = Deno as { cron?: unknown };
  const had = "cron" in denoAny;
  const prev = denoAny.cron;
  denoAny.cron = (name: string, schedule: string, handler: () => unknown) => {
    calls.push({ name, schedule, handler });
  };
  try {
    await work(calls);
  } finally {
    if (had) denoAny.cron = prev;
    else delete denoAny.cron;
  }
}

Deno.test("scheduleTasks uses Deno.cron when available and hands it the schedule", async () => {
  reset();
  let ran = 0;
  registerTask("job", defineTask({ handler: () => ++ran }));
  await withFakeDenoCron(async (calls) => {
    const dispose = scheduleTasks([{ cron: "*/5 * * * *", task: "job" }]);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].schedule, "*/5 * * * *");
    assert(calls[0].name.includes("job"));
    // The handler must RETURN the run promise (so Deno keeps the isolate alive and serializes
    // runs) — a fire-and-forget void handler would let Deno Deploy freeze mid-task.
    const result = calls[0].handler();
    assert(typeof (result as Promise<unknown>)?.then === "function", "handler returns a promise");
    await result;
    assertEquals(ran, 1, "the returned promise resolves once the task ran");
    dispose();
  });
});

Deno.test("scheduleTasks hands Deno.cron the POSIX weekday respelled in names", async () => {
  reset();
  registerTask("job", defineTask({ handler: () => {} }));
  // Deno.cron numbers weekdays 1-7 from Sunday and rejects 0: handed `0 0 * * 1` verbatim it
  // would fire on Sunday, and `0 0 * * 0` would not register at all. The user-facing convention
  // stays POSIX (every documented example says `1` is Monday); the platform gets names.
  await withFakeDenoCron((calls) => {
    scheduleTasks([
      { cron: "0 0 * * 1", task: "job" },
      { cron: "0 0 * * 0", task: "job" },
      { cron: "0 0 * * 1-5/2", task: "job" },
      { cron: "0 3 ? * ?", task: "job" },
    ]);
    assertEquals(calls.map((c) => c.schedule), [
      "0 0 * * MON",
      "0 0 * * SUN",
      "0 0 * * MON,WED,FRI",
      "0 3 * * *",
    ]);
  });
});

Deno.test("scheduleTasks registers under a name Deno.cron accepts, unique per (task, cron)", async () => {
  reset();
  // Deno.cron refuses a name outside [A-Za-z0-9 _-], longer than 64 characters, or already
  // taken. `task@cron` failed the first rule on every schedule (`*`, `/` and `@`), so under
  // --unstable-cron and on Deno Deploy no schedule ever registered.
  const long = "reports/" + "x".repeat(80);
  registerTask("job", defineTask({ handler: () => {} }));
  registerTask("reports/daily", defineTask({ handler: () => {} }));
  registerTask(long, defineTask({ handler: () => {} }));
  await withFakeDenoCron((calls) => {
    scheduleTasks([
      { cron: "*/5 * * * *", task: "job" },
      { cron: "*,5 * * * *", task: "job" }, // folds to the same readable text as the step
      { cron: "0 3 * * *", task: "reports/daily" },
      { cron: "0 3 * * *", task: long },
      { cron: "0 4 * * *", task: long },
    ]);
    assertEquals(calls.length, 5);
    for (const { name, schedule } of calls) {
      assert(
        /^[A-Za-z0-9 _-]+$/.test(name),
        `"${name}" (${schedule}) uses only allowed characters`,
      );
      assert(name.length <= 64, `"${name}" is at most 64 characters`);
    }
    assertEquals(new Set(calls.map((c) => c.name)).size, 5, "every pairing has its own name");
    assert(calls[2].name.startsWith("reports_daily 0 3"), "the task and schedule stay readable");
  });
  // And the same pairing gets the same name every boot, so Deno Deploy sees one cron rather
  // than a new one per deploy.
  const names: string[] = [];
  for (let boot = 0; boot < 2; boot++) {
    await withFakeDenoCron((calls) => {
      scheduleTasks([{ cron: "0 3 * * *", task: "reports/daily" }]);
      names.push(calls[0].name);
    });
  }
  assertEquals(names[0], names[1]);
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

// ---- the run-history seam --------------------------------------------------
//
// The recorder is module-global, so every test here clears it in a `finally`: a leaked one would
// silently contaminate the scheduling tests above.

/** Collect the records one block of work produces, with the recorder always removed after. */
async function recording(work: () => Promise<unknown>): Promise<TaskRunRecord[]> {
  const seen: TaskRunRecord[] = [];
  setTaskRecorder((r) => seen.push(r));
  try {
    await work().catch(() => {});
  } finally {
    setTaskRecorder(null);
  }
  return seen;
}

Deno.test("with no recorder, runTask hands back exactly what the handler produced", async () => {
  reset();
  const value = { deep: { object: 1 } };
  const boom = new Error("nope");
  registerTask("ok", defineTask({ handler: () => value }));
  registerTask(
    "bad",
    defineTask({
      handler: () => {
        throw boom;
      },
    }),
  );

  // Identity, not shape: this is what pins "the caller's value, unchanged".
  assertStrictEquals(await runTask("ok"), value);
  const err = await runTask("bad").then(() => null, (e) => e);
  assertStrictEquals(err, boom);
});

Deno.test("with a recorder, runTask STILL hands back exactly what the handler produced", async () => {
  reset();
  const value = { deep: { object: 1 } };
  const boom = new Error("nope");
  registerTask("ok", defineTask({ handler: () => value }));
  registerTask(
    "bad",
    defineTask({
      handler: () => {
        throw boom;
      },
    }),
  );
  setTaskRecorder(() => {});
  try {
    assertStrictEquals(await runTask("ok"), value);
    const err = await runTask("bad").then(() => null, (e) => e);
    assertStrictEquals(err, boom);
  } finally {
    setTaskRecorder(null);
  }
});

Deno.test("a recorder that throws disturbs neither the success nor the failure path", async () => {
  reset();
  const boom = new Error("handler failed");
  registerTask("ok", defineTask({ handler: () => "fine" }));
  registerTask(
    "bad",
    defineTask({
      handler: () => {
        throw boom;
      },
    }),
  );
  setTaskRecorder(() => {
    throw new Error("the history store is broken");
  });
  try {
    assertEquals(await runTask("ok"), "fine");
    const err = await runTask("bad").then(() => null, (e) => e);
    assertStrictEquals(err, boom, "the handler's error survives a broken recorder");
  } finally {
    setTaskRecorder(null);
  }
});

Deno.test("one record per run, carrying what happened", async () => {
  reset();
  registerTask("ok", defineTask({ handler: () => "the tail" }));
  registerTask(
    "bad",
    defineTask({
      handler: () => {
        throw new Error("kaboom");
      },
    }),
  );
  registerTask("plain", defineTask({ handler: () => ({ not: "a string" }) }));

  const seen = await recording(async () => {
    await runTask("ok");
    await runTask("bad").catch(() => {});
    await runTask("plain");
  });
  assertEquals(seen.length, 3);
  assertEquals(seen.map((r) => r.name), ["ok", "bad", "plain"]);
  assertEquals(seen.map((r) => r.ok), [true, false, true]);
  assertEquals(seen.map((r) => r.trigger), ["manual", "manual", "manual"]);
  for (const r of seen) assert(r.durationMs >= 0, "a duration is measured");
  // A string result keeps its tail; an error keeps its head; anything else carries no detail.
  assertEquals(seen[0].detail, "the tail");
  assert(seen[1].detail?.includes("kaboom"), seen[1].detail ?? "(none)");
  assertEquals(seen[2].detail, undefined);
});

Deno.test("an unknown task is not a run, so nothing is recorded for it", async () => {
  reset();
  const seen = await recording(() => runTask("nope"));
  assertEquals(seen, [], "the rejection happens before any handler — there is no run");
});

Deno.test("a handler that throws synchronously rejects — it does not throw", async () => {
  reset();
  const boom = new Error("guard clause");
  registerTask(
    "sync-bad",
    defineTask({
      handler: () => {
        throw boom;
      },
    }),
  );

  // The scheduler's own usage is `runTask(...).catch(onScheduledError)`. While a synchronous
  // throw escaped the call expression, `.catch` never ran and the error surfaced in the timer
  // tick instead — despite the declared `Promise<unknown>`.
  let caught: unknown = null;
  await runTask("sync-bad").catch((e) => {
    caught = e;
  });
  assertStrictEquals(caught, boom, "the rejection carries the handler's own error");

  // And it is recorded as a failure, which was impossible while the throw bypassed the seam.
  const seen = await recording(() => runTask("sync-bad").catch(() => {}));
  assertEquals(seen.length, 1);
  assertEquals(seen[0].ok, false);
  assert(seen[0].detail?.includes("guard clause"), seen[0].detail ?? "(no detail)");
});
