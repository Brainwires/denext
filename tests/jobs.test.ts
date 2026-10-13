import { assert, assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert";
import {
  abortJobRuns,
  clearJobs,
  collectSchedules,
  defineJob,
  getJob,
  isJob,
  jobNames,
  type JobRunRecord,
  registerJob,
  runJob,
  scheduleJobs,
  setJobRecorder,
} from "../src/server/jobs.ts";

function reset() {
  clearJobs();
}

Deno.test("defineJob brands the job and validates its schedule up front", () => {
  const t = defineJob({ handler: () => 1, schedule: "*/5 * * * *" });
  assert(isJob(t));
  assert(!isJob({ handler: () => 1 }));
  assertThrows(() => defineJob({ handler: () => 1, schedule: "bogus" }), Error);
});

Deno.test("register / getJob / jobNames / runJob", async () => {
  reset();
  let seen: unknown = null;
  registerJob("cleanup", defineJob({ handler: (ctx) => (seen = ctx, "done") }));
  registerJob("reports/daily", defineJob({ handler: () => 42 }));
  assertEquals(jobNames(), ["cleanup", "reports/daily"]);
  assert(getJob("cleanup"));

  const out = await runJob("cleanup", { id: 7 });
  assertEquals(out, "done");
  assertEquals((seen as { name: string }).name, "cleanup");
  assertEquals((seen as { payload: unknown }).payload, { id: 7 });
  assertEquals((seen as { trigger: string }).trigger, "manual");

  assertEquals(await runJob("reports/daily"), 42);
  await assertRejects(() => runJob("nope"), Error, 'no job named "nope"');
});

Deno.test("collectSchedules merges config + per-job schedules and dedupes", () => {
  reset();
  registerJob("a", defineJob({ handler: () => {}, schedule: "0 3 * * *" }));
  registerJob("b", defineJob({ handler: () => {} }));
  const entries = collectSchedules({
    "*/15 * * * *": ["a", "b"],
    "0 0 * * 0": "b",
    "0 3 * * *": "a", // same as a's own schedule → deduped
  });
  const keys = entries.map((e) => `${e.job} ${e.cron}`).sort();
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

Deno.test("scheduleJobs uses Deno.cron when available and hands it the schedule", async () => {
  reset();
  let ran = 0;
  registerJob("job", defineJob({ handler: () => ++ran }));
  await withFakeDenoCron(async (calls) => {
    const dispose = scheduleJobs([{ cron: "*/5 * * * *", job: "job" }]);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].schedule, "*/5 * * * *");
    assert(calls[0].name.includes("job"));
    // The handler must RETURN the run promise (so Deno keeps the isolate alive and serializes
    // runs) — a fire-and-forget void handler would let Deno Deploy freeze mid-job.
    const result = calls[0].handler();
    assert(typeof (result as Promise<unknown>)?.then === "function", "handler returns a promise");
    await result;
    assertEquals(ran, 1, "the returned promise resolves once the job ran");
    dispose();
  });
});

Deno.test("scheduleJobs hands Deno.cron the POSIX weekday respelled in names", async () => {
  reset();
  registerJob("job", defineJob({ handler: () => {} }));
  // Deno.cron numbers weekdays 1-7 from Sunday and rejects 0: handed `0 0 * * 1` verbatim it
  // would fire on Sunday, and `0 0 * * 0` would not register at all. The user-facing convention
  // stays POSIX (every documented example says `1` is Monday); the platform gets names.
  await withFakeDenoCron((calls) => {
    scheduleJobs([
      { cron: "0 0 * * 1", job: "job" },
      { cron: "0 0 * * 0", job: "job" },
      { cron: "0 0 * * 1-5/2", job: "job" },
      { cron: "0 3 ? * ?", job: "job" },
    ]);
    assertEquals(calls.map((c) => c.schedule), [
      "0 0 * * MON",
      "0 0 * * SUN",
      "0 0 * * MON,WED,FRI",
      "0 3 * * *",
    ]);
  });
});

Deno.test("scheduleJobs registers under a name Deno.cron accepts, unique per (job, cron)", async () => {
  reset();
  // Deno.cron refuses a name outside [A-Za-z0-9 _-], longer than 64 characters, or already
  // taken. `job@cron` failed the first rule on every schedule (`*`, `/` and `@`), so under
  // --unstable-cron and on Deno Deploy no schedule ever registered.
  const long = "reports/" + "x".repeat(80);
  registerJob("job", defineJob({ handler: () => {} }));
  registerJob("reports/daily", defineJob({ handler: () => {} }));
  registerJob(long, defineJob({ handler: () => {} }));
  await withFakeDenoCron((calls) => {
    scheduleJobs([
      { cron: "*/5 * * * *", job: "job" },
      { cron: "*,5 * * * *", job: "job" }, // folds to the same readable text as the step
      { cron: "0 3 * * *", job: "reports/daily" },
      { cron: "0 3 * * *", job: long },
      { cron: "0 4 * * *", job: long },
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
    assert(calls[2].name.startsWith("reports_daily 0 3"), "the job and schedule stay readable");
  });
  // And the same pairing gets the same name every boot, so Deno Deploy sees one cron rather
  // than a new one per deploy.
  const names: string[] = [];
  for (let boot = 0; boot < 2; boot++) {
    await withFakeDenoCron((calls) => {
      scheduleJobs([{ cron: "0 3 * * *", job: "reports/daily" }]);
      names.push(calls[0].name);
    });
  }
  assertEquals(names[0], names[1]);
});

Deno.test("scheduleJobs skips a bad cron and an unknown job, without throwing", () => {
  reset();
  registerJob("real", defineJob({ handler: () => {} }));
  // No Deno.cron here (2.9.6 without --unstable-cron) → the userland scheduler; just assert it
  // returns a disposer and doesn't throw on the invalid entries.
  const dispose = scheduleJobs([
    { cron: "not-a-cron", job: "real" },
    { cron: "*/5 * * * *", job: "ghost" },
    { cron: "* * * * *", job: "real" },
  ]);
  assertEquals(typeof dispose, "function");
  dispose();
});

// ---- the userland scheduler (the default self-host path) --------------------
//
// The userland scheduler and the retry backoff waits are tested on Vitest's fake clock in
// tests/jobs-timers.vitest.ts.

// ---- the run-history seam --------------------------------------------------
//
// The recorder is module-global, so every test here clears it in a `finally`: a leaked one would
// silently contaminate the scheduling tests above.

/** Collect the records one block of work produces, with the recorder always removed after. */
async function recording(work: () => Promise<unknown>): Promise<JobRunRecord[]> {
  const seen: JobRunRecord[] = [];
  setJobRecorder((r) => seen.push(r));
  try {
    await work().catch(() => {});
  } finally {
    setJobRecorder(null);
  }
  return seen;
}

Deno.test("with no recorder, runJob hands back exactly what the handler produced", async () => {
  reset();
  const value = { deep: { object: 1 } };
  const boom = new Error("nope");
  registerJob("ok", defineJob({ handler: () => value }));
  registerJob(
    "bad",
    defineJob({
      handler: () => {
        throw boom;
      },
    }),
  );

  // Identity, not shape: this is what pins "the caller's value, unchanged".
  assertStrictEquals(await runJob("ok"), value);
  const err = await runJob("bad").then(() => null, (e) => e);
  assertStrictEquals(err, boom);
});

Deno.test("with a recorder, runJob STILL hands back exactly what the handler produced", async () => {
  reset();
  const value = { deep: { object: 1 } };
  const boom = new Error("nope");
  registerJob("ok", defineJob({ handler: () => value }));
  registerJob(
    "bad",
    defineJob({
      handler: () => {
        throw boom;
      },
    }),
  );
  setJobRecorder(() => {});
  try {
    assertStrictEquals(await runJob("ok"), value);
    const err = await runJob("bad").then(() => null, (e) => e);
    assertStrictEquals(err, boom);
  } finally {
    setJobRecorder(null);
  }
});

Deno.test("a recorder that throws disturbs neither the success nor the failure path", async () => {
  reset();
  const boom = new Error("handler failed");
  registerJob("ok", defineJob({ handler: () => "fine" }));
  registerJob(
    "bad",
    defineJob({
      handler: () => {
        throw boom;
      },
    }),
  );
  setJobRecorder(() => {
    throw new Error("the history store is broken");
  });
  try {
    assertEquals(await runJob("ok"), "fine");
    const err = await runJob("bad").then(() => null, (e) => e);
    assertStrictEquals(err, boom, "the handler's error survives a broken recorder");
  } finally {
    setJobRecorder(null);
  }
});

Deno.test("one record per run, carrying what happened", async () => {
  reset();
  registerJob("ok", defineJob({ handler: () => "the tail" }));
  registerJob(
    "bad",
    defineJob({
      handler: () => {
        throw new Error("kaboom");
      },
    }),
  );
  registerJob("plain", defineJob({ handler: () => ({ not: "a string" }) }));

  const seen = await recording(async () => {
    await runJob("ok");
    await runJob("bad").catch(() => {});
    await runJob("plain");
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

Deno.test("an unknown job is not a run, so nothing is recorded for it", async () => {
  reset();
  const seen = await recording(() => runJob("nope"));
  assertEquals(seen, [], "the rejection happens before any handler — there is no run");
});

Deno.test("a handler that throws synchronously rejects — it does not throw", async () => {
  reset();
  const boom = new Error("guard clause");
  registerJob(
    "sync-bad",
    defineJob({
      handler: () => {
        throw boom;
      },
    }),
  );

  // The scheduler's own usage is `runJob(...).catch(onScheduledError)`. While a synchronous
  // throw escaped the call expression, `.catch` never ran and the error surfaced in the timer
  // tick instead — despite the declared `Promise<unknown>`.
  let caught: unknown = null;
  await runJob("sync-bad").catch((e) => {
    caught = e;
  });
  assertStrictEquals(caught, boom, "the rejection carries the handler's own error");

  // And it is recorded as a failure, which was impossible while the throw bypassed the seam.
  const seen = await recording(() => runJob("sync-bad").catch(() => {}));
  assertEquals(seen.length, 1);
  assertEquals(seen[0].ok, false);
  assert(seen[0].detail?.includes("guard clause"), seen[0].detail ?? "(no detail)");
});

// ---- retries ---------------------------------------------------------------

/** A handler that fails its first `failures` attempts, then returns the attempt number. */
function flaky(failures: number) {
  const seen: number[] = [];
  const job = defineJob({
    retry: { attempts: 5, backoff: 0 },
    handler: ({ attempt }) => {
      seen.push(attempt);
      if (attempt <= failures) throw new Error(`attempt ${attempt} failed`);
      return `done on ${attempt}`;
    },
  });
  return { job, seen };
}

Deno.test("retry: a failed run is retried until it succeeds, each attempt numbered", async () => {
  reset();
  const { job, seen } = flaky(2);
  registerJob("flaky", job);
  assertEquals(await runJob("flaky"), "done on 3");
  assertEquals(seen, [1, 2, 3]);
});

Deno.test("retry: when the retries run out the LAST error is thrown", async () => {
  reset();
  registerJob(
    "never",
    defineJob({
      retry: { attempts: 2, backoff: 0 },
      handler: ({ attempt }) => {
        throw new Error(`attempt ${attempt}`);
      },
    }),
  );
  await assertRejects(() => runJob("never"), Error, "attempt 3");
});

Deno.test("retry: every attempt is recorded, with its number and whether it will retry", async () => {
  reset();
  const { job } = flaky(2);
  registerJob("flaky", job);
  registerJob("plain", defineJob({ handler: () => 1 }));
  const seen = await recording(async () => {
    await runJob("flaky");
    await runJob("plain");
  });
  assertEquals(
    seen.map((r) => [r.name, r.ok, r.attempt, r.willRetry]),
    [
      ["flaky", false, 1, true],
      ["flaky", false, 2, true],
      ["flaky", true, 3, false],
      ["plain", true, undefined, undefined],
    ],
  );
  const lastFail = await recording(() => runJob("flaky-out"));
  assertEquals(lastFail, [], "unknown job: no attempts");
  registerJob(
    "out",
    defineJob({
      retry: { attempts: 1, backoff: 0 },
      handler: () => {
        throw new Error("x");
      },
    }),
  );
  const out = await recording(() => runJob("out"));
  assertEquals(out.map((r) => [r.attempt, r.willRetry]), [[1, true], [2, false]]);
});

Deno.test("runJob with no signal of its own is still aborted on shutdown", async () => {
  reset();
  registerJob(
    "waits",
    defineJob({
      handler: ({ signal }) =>
        new Promise<string>((resolve) => {
          if (signal.aborted) resolve("aborted");
          signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        }),
    }),
  );
  const run = runJob("waits");
  abortJobRuns(); // the server's shutdown
  assertEquals(await run, "aborted");
  // Runs that start after a shutdown (a dev re-boot) get a live signal again.
  registerJob("live", defineJob({ handler: ({ signal }) => signal.aborted }));
  assertEquals(await runJob("live"), false);
});

Deno.test("retry: defineJob validates the policy up front", () => {
  for (
    const bad of [
      { attempts: -1 },
      { attempts: 1.5 },
      { attempts: 101 },
      { attempts: 1, backoff: -5 },
      { attempts: 1, backoff: { delayMs: Number.NaN } },
      { attempts: 1, backoff: { strategy: "linear" } },
      null,
    ]
  ) {
    assertThrows(
      () => defineJob({ retry: bad as never, handler: () => {} }),
      Error,
      "retry.",
      JSON.stringify(bad),
    );
  }
  defineJob({ retry: { attempts: 0 }, handler: () => {} });
});
