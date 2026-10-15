// The JobHistoryStore seam: the shared contract on the default SQLite store and on the Postgres
// store (through the node:sqlite-backed fake client — the real server runs the same suite in
// tests/postgres-integration.test.ts), what only the Postgres store does (its latch, its
// migration, closing), the config validation of `jobs.history`, and the wiring that installs a
// store — which must never fail or delay a run, whatever the store does.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type JobHistoryStore, sqliteJobHistoryStore } from "../src/server/job-history.ts";
import { postgresJobHistoryStore } from "../src/server/postgres-job-history.ts";
import { startRunHistory } from "../src/server/job-loader.ts";
import {
  clearJobs,
  defineJob,
  type JobRunRecord,
  registerJob,
  runJob,
} from "../src/server/jobs.ts";
import { validateJobs } from "../src/server/config-validate/server.ts";
import { fakeSqlClient } from "./helpers/fake-sql-client.ts";
import { jobHistorySuite } from "./helpers/job-history-suite.ts";

Deno.test("JobHistoryStore contract: the default SQLite store", async (t) => {
  await jobHistorySuite(t, async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_th_store_" });
    const store = sqliteJobHistoryStore({ path: join(dir, "jobs.db"), maxRuns: 1000 });
    return {
      store,
      async dispose() {
        await store.close?.();
        await Deno.remove(dir, { recursive: true });
      },
    };
  });
});

Deno.test("JobHistoryStore contract: the Postgres store (fake client)", async (t) => {
  await jobHistorySuite(t, () => {
    const sql = fakeSqlClient();
    const store = postgresJobHistoryStore({ sql, maxRuns: 1000 });
    return Promise.resolve({
      store,
      async dispose() {
        await store.close?.();
      },
    });
  });
});

/** A run, with the boring fields filled in. */
function run(over: Partial<JobRunRecord> & { name: string }): JobRunRecord {
  return { trigger: "schedule", startedAt: Date.now(), durationMs: 5, ok: true, ...over };
}

Deno.test("sqlite store: reading, listing, pruning and clearing create no file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_th_store_" });
  const path = join(dir, ".denext", "jobs.db");
  try {
    const store = sqliteJobHistoryStore({ path });
    const read = await store.read();
    assertEquals([read.available, read.reason], [false, "no history recorded yet"]);
    assertEquals(await store.listRuns("x"), []);
    await store.prune();
    assertEquals(await store.clear(), { cleared: false, reason: "no history recorded yet" });
    let present = true;
    try {
      await Deno.stat(join(dir, ".denext"));
    } catch {
      present = false;
    }
    assert(!present, "no directory, no file");
    await store.close?.();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("postgres store: a failing database drops rows, latches after three, never rejects", async () => {
  const sql = fakeSqlClient();
  const store = postgresJobHistoryStore({ sql });
  await store.record(run({ name: "a" })); // migrates, inserts
  const boom = Object.assign(new Error("connection reset"), { code: "08006" });
  for (let i = 0; i < 3; i++) {
    sql.failNext(/INSERT INTO job_runs/, boom);
    await store.record(run({ name: "a" })); // resolves, row dropped
  }
  const before = sql.statements.length;
  await store.record(run({ name: "a" }));
  assertEquals(sql.statements.length, before, "latched: no statement after three failures");
  assertEquals((await store.listRuns("a")).length, 1, "only the first row landed");
  await store.close?.();
});

Deno.test("postgres store: a failed migration is retried by the next write", async () => {
  const sql = fakeSqlClient();
  const store = postgresJobHistoryStore({ sql });
  sql.failNext(/CREATE TABLE IF NOT EXISTS job_runs/, new Error("permission denied"));
  await store.record(run({ name: "a" })); // the migration fails: the row is dropped
  const read = await store.read();
  assertEquals([read.available, read.reason], [false, "no history recorded yet"]);
  await store.record(run({ name: "a" }));
  assertEquals((await store.read()).recent.length, 1, "the next write migrated");
  await store.close?.();
});

Deno.test("postgres store: reads never migrate — no table yet is no history yet", async () => {
  const sql = fakeSqlClient();
  const store = postgresJobHistoryStore({ sql });
  const read = await store.read({ readOnly: true });
  assertEquals([read.available, read.reason, read.jobs, read.recent], [
    false,
    "no history recorded yet",
    [],
    [],
  ]);
  assertEquals(await store.listRuns("a"), []);
  assertEquals(
    sql.statements.filter((s) => /CREATE|ALTER|INSERT|job_history_migrations/i.test(s)),
    [],
    "no DDL, no migration bookkeeping, nothing written",
  );
  assertEquals(sql.raw.prepare("SELECT name FROM sqlite_master").all(), [], "nothing created");
  // A read right after a write waits for the migration that write started.
  void store.record(run({ name: "a" }));
  assertEquals((await store.read()).recent.map((r) => r.job), ["a"]);
  // Any other failure is still reported as such.
  sql.failNext(/FROM job_runs/, Object.assign(new Error("connection reset"), { code: "08006" }));
  const failed = await store.read();
  assertEquals([failed.available, failed.reason], [false, "connection reset"]);
  await store.close?.();
});

Deno.test("postgres store: migrate: false runs no DDL; a schema qualifies the table", async () => {
  const plain = fakeSqlClient();
  plain.raw.exec(
    "CREATE TABLE job_runs (id TEXT PRIMARY KEY, job TEXT NOT NULL, trigger TEXT NOT NULL, " +
      "started_at BIGINT NOT NULL, duration_ms BIGINT NOT NULL, ok INTEGER NOT NULL, detail TEXT, " +
      "attempt INTEGER NOT NULL DEFAULT 1, will_retry INTEGER NOT NULL DEFAULT 0)",
  );
  const store = postgresJobHistoryStore({ sql: plain, migrate: false });
  await store.record(run({ name: "a" }));
  assert(!plain.statements.some((s) => /CREATE TABLE/i.test(s)), "no DDL sent");
  assertEquals((await store.listRuns("a")).length, 1);
  await store.close?.();

  const qualified = fakeSqlClient();
  const inSchema = postgresJobHistoryStore({ sql: qualified, schema: "ops", migrate: false });
  await inSchema.listRuns("a");
  assert(qualified.statements.some((s) => s.includes('"ops".job_runs')), "schema-qualified");
});

Deno.test("postgres store: close waits for started writes, never closes a client it was handed", async () => {
  const sql = fakeSqlClient();
  const store = postgresJobHistoryStore({ sql });
  void store.record(run({ name: "a" }));
  await store.close?.();
  assertEquals(sql.closes, 0, "the caller's client stays open");
  assertEquals(
    sql.raw.prepare("SELECT COUNT(*) AS n FROM job_runs").get(),
    { n: 1 },
    "the write started before close landed",
  );
  await store.record(run({ name: "b" })); // after close: dropped, no throw
  assertEquals(sql.raw.prepare("SELECT COUNT(*) AS n FROM job_runs").get(), { n: 1 });
});

Deno.test("postgres store: needs exactly one of sql and url", () => {
  for (const options of [{}, { sql: fakeSqlClient(), url: "postgres://x/y" }]) {
    let threw = false;
    try {
      postgresJobHistoryStore(options);
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, JSON.stringify(Object.keys(options)));
  }
});

Deno.test("config: jobs.history takes a boolean or { store, maxRuns }", () => {
  const problems = (jobs: unknown): string[] => {
    const out: string[] = [];
    const fail = (field: string, message: string) => void out.push(`${field}: ${message}`);
    validateJobs(jobs as never, fail as never);
    return out;
  };
  const store = sqliteJobHistoryStore({ path: ":memory:" });
  assertEquals(problems({ history: true }), []);
  assertEquals(problems({ history: {} }), []);
  assertEquals(problems({ history: { store, maxRuns: 10 } }), []);
  assertEquals(problems({ history: "yes" }), [
    "jobs.history: must be a boolean or { store?, maxRuns? }",
  ]);
  assertEquals(problems({ history: { maxRuns: 0 } }).length, 1);
  assertEquals(problems({ history: { store: { record() {} } } }), [
    "jobs.history.store: must be a JobHistoryStore (missing read, listRuns, prune, clear)",
  ]);
});

/** A store that records into an array, optionally misbehaving. */
function memoryStore(mode: "ok" | "throws" | "rejects" | "slow" = "ok") {
  const runs: JobRunRecord[] = [];
  let closed = 0;
  // A "slow" store's write lands only when the test releases it — an event, not a clock.
  const slowWrite = Promise.withResolvers<void>();
  const store: JobHistoryStore = {
    record(r) {
      if (mode === "throws") throw new Error("store exploded");
      if (mode === "rejects") return Promise.reject(new Error("store rejected"));
      if (mode === "slow") return slowWrite.promise.then(() => void runs.push(r));
      runs.push(r);
    },
    read: () => Promise.resolve({ available: true, windowDays: 7, jobs: [], recent: [] }),
    listRuns: () => Promise.resolve([]),
    prune: () => Promise.resolve(),
    clear: () => Promise.resolve({ cleared: true }),
    close() {
      closed++;
    },
  };
  return { store, runs, closed: () => closed, releaseSlowWrite: () => slowWrite.resolve() };
}

Deno.test("wiring: a configured store records every run and is not closed by the server", async () => {
  clearJobs();
  const mem = memoryStore();
  registerJob("th-store-job", defineJob({ handler: () => "done" }));
  const stop = startRunHistory({ jobs: { history: { store: mem.store } } }, "/nonexistent");
  try {
    await runJob("th-store-job", undefined, { trigger: "manual" });
    assertEquals(
      mem.runs.filter((r) => r.name === "th-store-job").map((r) => [r.name, r.ok, r.trigger]),
      [["th-store-job", true, "manual"]],
    );
  } finally {
    await stop();
    clearJobs();
  }
  assertEquals(mem.closed(), 0, "a dev re-boot installs the same store again");
});

Deno.test("wiring: a store that throws, rejects or is slow never fails or delays a run", async () => {
  for (const mode of ["throws", "rejects", "slow"] as const) {
    clearJobs();
    const mem = memoryStore(mode);
    registerJob("th-store-job", defineJob({ handler: () => "done" }));
    const stop = startRunHistory(
      { jobs: { history: { store: mem.store } } },
      "/nonexistent",
      { closeCustom: true },
    );
    // Only a deadlock breaker: a run that waited on the slow write would resolve once this
    // releases it — with the row already landed, which the assertion below then reports.
    const breaker = setTimeout(mem.releaseSlowWrite, 20_000);
    try {
      assertEquals(await runJob("th-store-job"), "done", mode);
      if (mode === "slow") {
        assertEquals(mem.runs.length, 0, "slow: the run resolved before its write landed");
      }
    } finally {
      clearTimeout(breaker);
      mem.releaseSlowWrite();
      await stop(); // closeCustom: waits for the slow write, then closes
      clearJobs();
    }
    if (mode === "slow") {
      assertEquals(
        mem.runs.filter((r) => r.name === "th-store-job").length,
        1,
        "the slow write landed before close",
      );
    }
    assertEquals(mem.closed(), 1, `${mode}: closed by a one-shot process's disposer`);
  }
});

Deno.test("wiring: history off installs nothing; { maxRuns } is the default store", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_th_store_" });
  try {
    clearJobs();
    registerJob("th-store-job", defineJob({ handler: () => "done" }));
    let stop = startRunHistory({ jobs: { history: false } }, dir);
    await runJob("th-store-job");
    await stop();
    assertEquals([...Deno.readDirSync(dir)], [], "history off: no file");
    stop = startRunHistory({ jobs: { history: { maxRuns: 3 } } }, dir);
    for (let i = 0; i < 5; i++) await runJob("th-store-job");
    await stop();
    // The next process's first insert prunes to the cap.
    stop = startRunHistory({ jobs: { history: { maxRuns: 3 } } }, dir);
    await runJob("th-store-job");
    await stop();
    const runs = await sqliteJobHistoryStore({ path: join(dir, "jobs.db") }).listRuns(
      "th-store-job",
      { limit: 100 },
    );
    assertEquals(runs.length, 3, "{ maxRuns } capped the default store on its first insert");
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});
