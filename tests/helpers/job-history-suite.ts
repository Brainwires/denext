// The JobHistoryStore contract, run against every store: the default SQLite file
// (tests/job-history-store.test.ts), Postgres through the node:sqlite-backed fake client (same
// file) and Postgres on a real server (tests/postgres-integration.test.ts). Each case gets a
// FRESH store from `make()`, so no case sees another's rows.

import { assert, assertEquals } from "@std/assert";
import type { JobHistoryStore } from "../../src/server/job-history.ts";
import type { JobRunRecord } from "../../src/server/jobs.ts";

/** A fresh store for one case, and how to dispose of it. */
export interface FreshStore {
  /** The store under test (built with `maxRuns: 1000`). */
  store: JobHistoryStore;
  /** Close it and remove whatever it left behind. */
  dispose(): Promise<void>;
}

/** A run, with the boring fields filled in. */
function run(over: Partial<JobRunRecord> & { name: string }): JobRunRecord {
  return { trigger: "schedule", startedAt: Date.now(), durationMs: 5, ok: true, ...over };
}

type Case = (store: JobHistoryStore) => Promise<void>;

const CASES: Record<string, Case> = {
  "what was recorded is what comes back, newest first": async (store) => {
    const t0 = Date.now();
    await store.record(run({ name: "cleanup", startedAt: t0 - 3000, durationMs: 412 }));
    await store.record(run({ name: "cleanup", startedAt: t0 - 2000, ok: false, detail: "boom" }));
    await store.record(run({ name: "digest", startedAt: t0 - 1000, durationMs: 9 }));
    const history = await store.read();
    assert(history.available, history.reason ?? "");
    assertEquals(history.windowDays, 7);
    assertEquals(history.jobs.map((t) => t.job), ["digest", "cleanup"]);
    const cleanup = history.jobs.find((t) => t.job === "cleanup")!;
    assertEquals(cleanup.lastOk, false, "the last run, not a summary");
    assertEquals([cleanup.successes, cleanup.failures, cleanup.retries], [1, 1, 0]);
    assertEquals(cleanup.lastRunAt, t0 - 2000);
    const digest = history.jobs.find((t) => t.job === "digest")!;
    assertEquals([digest.lastOk, digest.lastDurationMs], [true, 9]);
    assertEquals(history.recent.map((r) => r.job), ["digest", "cleanup", "cleanup"]);
    assertEquals(history.recent[1], {
      job: "cleanup",
      trigger: "schedule",
      startedAt: t0 - 2000,
      durationMs: 5,
      ok: false,
      detail: "boom",
      attempt: 1,
      willRetry: false,
    });
    assertEquals(history.recent[0].detail, null);
  },
  "retries: each attempt is a run; a retried failure is not a failure": async (store) => {
    const t0 = Date.now() - 10_000;
    await store.record(
      run({ name: "sync", startedAt: t0, ok: false, attempt: 1, willRetry: true }),
    );
    await store.record(
      run({ name: "sync", startedAt: t0 + 1, ok: false, attempt: 2, willRetry: true }),
    );
    await store.record(run({ name: "sync", startedAt: t0 + 2, ok: true, attempt: 3 }));
    const history = await store.read();
    const sync = history.jobs.find((t) => t.job === "sync")!;
    assertEquals([sync.successes, sync.failures, sync.retries], [1, 0, 2]);
    assertEquals(history.recent.map((r) => [r.attempt, r.willRetry, r.ok]), [
      [3, false, true],
      [2, true, false],
      [1, true, false],
    ]);
  },
  "the window bounds the counts, not the feed; recentLimit bounds the feed": async (store) => {
    const now = Date.now();
    await store.record(run({ name: "old", startedAt: now - 10 * 86_400_000 }));
    for (let i = 0; i < 5; i++) await store.record(run({ name: "new", startedAt: now - i * 1000 }));
    const week = await store.read();
    assertEquals(week.jobs.map((t) => t.job), ["new"], "the old run is outside 7 days");
    assertEquals(week.recent.length, 6, "the feed still shows it");
    const month = await store.read({ windowDays: 30, recentLimit: 2 });
    assertEquals(month.windowDays, 30);
    assertEquals(month.jobs.map((t) => t.job).sort(), ["new", "old"]);
    assertEquals(month.recent.map((r) => r.startedAt), [now, now - 1000]);
  },
  "listRuns is one job's runs, newest first, limited": async (store) => {
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 4; i++) await store.record(run({ name: "a", startedAt: t0 + i }));
    await store.record(run({ name: "b", startedAt: t0 + 10 }));
    assertEquals((await store.listRuns("a")).map((r) => r.startedAt), [
      t0 + 3,
      t0 + 2,
      t0 + 1,
      t0,
    ]);
    assertEquals((await store.listRuns("a", { limit: 2 })).map((r) => r.startedAt), [
      t0 + 3,
      t0 + 2,
    ]);
    assertEquals((await store.listRuns("b")).length, 1);
    assertEquals(await store.listRuns("nobody"), []);
  },
  "prune caps every job on its own, and drops runs past retention": async (store) => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) await store.record(run({ name: "noisy", startedAt: now - i }));
    await store.record(run({ name: "quiet", startedAt: now - 100 }));
    await store.record(run({ name: "ancient", startedAt: now - 3 * 86_400_000 }));
    await store.prune({ maxRuns: 5, retainDays: 2 });
    assertEquals((await store.listRuns("noisy", { limit: 100 })).map((r) => r.startedAt), [
      now,
      now - 1,
      now - 2,
      now - 3,
      now - 4,
    ], "the newest five kept");
    assertEquals((await store.listRuns("quiet")).length, 1, "a quiet job keeps its run");
    assertEquals(await store.listRuns("ancient"), [], "past retention");
  },
  "clear removes every run; the store keeps recording": async (store) => {
    await store.record(run({ name: "cleanup" }));
    await store.record(run({ name: "digest", ok: false, detail: "boom" }));
    assertEquals(await store.clear(), { cleared: true });
    const after = await store.read();
    assertEquals([after.available, after.jobs, after.recent], [true, [], []]);
    await store.record(run({ name: "cleanup" }));
    assertEquals((await store.read()).recent.length, 1);
  },
  "record never throws and never rejects": async (store) => {
    const result = store.record(run({ name: "x", detail: "a".repeat(2048) }));
    await Promise.resolve(result); // must not reject
    assertEquals((await store.listRuns("x"))[0].detail?.length, 2048);
  },
};

/**
 * Run every case against fresh stores from `make`.
 *
 * @param t The test context.
 * @param make Builds a fresh store (with `maxRuns: 1000`).
 */
export async function jobHistorySuite(
  t: Deno.TestContext,
  make: () => Promise<FreshStore>,
): Promise<void> {
  for (const [name, fn] of Object.entries(CASES)) {
    await t.step(name, async () => {
      const { store, dispose } = await make();
      try {
        await fn(store);
      } finally {
        await dispose();
      }
    });
  }
}
