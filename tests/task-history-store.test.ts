// The TaskHistoryStore seam: the shared contract on the default SQLite store and on the Postgres
// store (through the node:sqlite-backed fake client — the real server runs the same suite in
// tests/postgres-integration.test.ts), what only the Postgres store does (its latch, its
// migration, closing), the config validation of `tasks.history`, and the wiring that installs a
// store — which must never fail or delay a run, whatever the store does.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { sqliteTaskHistoryStore, type TaskHistoryStore } from "../src/server/task-history.ts";
import { postgresTaskHistoryStore } from "../src/server/postgres-task-history.ts";
import { startRunHistory } from "../src/server/task-loader.ts";
import {
  clearTasks,
  defineTask,
  registerTask,
  runTask,
  type TaskRunRecord,
} from "../src/server/tasks.ts";
import { validateTasks } from "../src/server/config-validate/server.ts";
import { fakeSqlClient } from "./helpers/fake-sql-client.ts";
import { taskHistorySuite } from "./helpers/task-history-suite.ts";

Deno.test("TaskHistoryStore contract: the default SQLite store", async (t) => {
  await taskHistorySuite(t, async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_th_store_" });
    const store = sqliteTaskHistoryStore({ path: join(dir, "tasks.db"), maxRuns: 1000 });
    return {
      store,
      async dispose() {
        await store.close?.();
        await Deno.remove(dir, { recursive: true });
      },
    };
  });
});

Deno.test("TaskHistoryStore contract: the Postgres store (fake client)", async (t) => {
  await taskHistorySuite(t, () => {
    const sql = fakeSqlClient();
    const store = postgresTaskHistoryStore({ sql, maxRuns: 1000 });
    return Promise.resolve({
      store,
      async dispose() {
        await store.close?.();
      },
    });
  });
});

/** A run, with the boring fields filled in. */
function run(over: Partial<TaskRunRecord> & { name: string }): TaskRunRecord {
  return { trigger: "schedule", startedAt: Date.now(), durationMs: 5, ok: true, ...over };
}

Deno.test("sqlite store: reading, listing, pruning and clearing create no file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_th_store_" });
  const path = join(dir, ".denext", "tasks.db");
  try {
    const store = sqliteTaskHistoryStore({ path });
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
  const store = postgresTaskHistoryStore({ sql });
  await store.record(run({ name: "a" })); // migrates, inserts
  const boom = Object.assign(new Error("connection reset"), { code: "08006" });
  for (let i = 0; i < 3; i++) {
    sql.failNext(/INSERT INTO task_runs/, boom);
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
  const store = postgresTaskHistoryStore({ sql });
  sql.failNext(/CREATE TABLE IF NOT EXISTS task_runs/, new Error("permission denied"));
  await store.record(run({ name: "a" })); // the migration fails: the row is dropped
  const read = await store.read();
  assertEquals([read.available, read.reason], [false, "no history recorded yet"]);
  await store.record(run({ name: "a" }));
  assertEquals((await store.read()).recent.length, 1, "the next write migrated");
  await store.close?.();
});

Deno.test("postgres store: reads never migrate — no table yet is no history yet", async () => {
  const sql = fakeSqlClient();
  const store = postgresTaskHistoryStore({ sql });
  const read = await store.read({ readOnly: true });
  assertEquals([read.available, read.reason, read.tasks, read.recent], [
    false,
    "no history recorded yet",
    [],
    [],
  ]);
  assertEquals(await store.listRuns("a"), []);
  assertEquals(
    sql.statements.filter((s) => /CREATE|ALTER|INSERT|task_history_migrations/i.test(s)),
    [],
    "no DDL, no migration bookkeeping, nothing written",
  );
  assertEquals(sql.raw.prepare("SELECT name FROM sqlite_master").all(), [], "nothing created");
  // A read right after a write waits for the migration that write started.
  void store.record(run({ name: "a" }));
  assertEquals((await store.read()).recent.map((r) => r.task), ["a"]);
  // Any other failure is still reported as such.
  sql.failNext(/FROM task_runs/, Object.assign(new Error("connection reset"), { code: "08006" }));
  const failed = await store.read();
  assertEquals([failed.available, failed.reason], [false, "connection reset"]);
  await store.close?.();
});

Deno.test("postgres store: migrate: false runs no DDL; a schema qualifies the table", async () => {
  const plain = fakeSqlClient();
  plain.raw.exec(
    "CREATE TABLE task_runs (id TEXT PRIMARY KEY, task TEXT NOT NULL, trigger TEXT NOT NULL, " +
      "started_at BIGINT NOT NULL, duration_ms BIGINT NOT NULL, ok INTEGER NOT NULL, detail TEXT, " +
      "attempt INTEGER NOT NULL DEFAULT 1, will_retry INTEGER NOT NULL DEFAULT 0)",
  );
  const store = postgresTaskHistoryStore({ sql: plain, migrate: false });
  await store.record(run({ name: "a" }));
  assert(!plain.statements.some((s) => /CREATE TABLE/i.test(s)), "no DDL sent");
  assertEquals((await store.listRuns("a")).length, 1);
  await store.close?.();

  const qualified = fakeSqlClient();
  const inSchema = postgresTaskHistoryStore({ sql: qualified, schema: "ops", migrate: false });
  await inSchema.listRuns("a");
  assert(qualified.statements.some((s) => s.includes('"ops".task_runs')), "schema-qualified");
});

Deno.test("postgres store: close waits for started writes, never closes a client it was handed", async () => {
  const sql = fakeSqlClient();
  const store = postgresTaskHistoryStore({ sql });
  void store.record(run({ name: "a" }));
  await store.close?.();
  assertEquals(sql.closes, 0, "the caller's client stays open");
  assertEquals(
    sql.raw.prepare("SELECT COUNT(*) AS n FROM task_runs").get(),
    { n: 1 },
    "the write started before close landed",
  );
  await store.record(run({ name: "b" })); // after close: dropped, no throw
  assertEquals(sql.raw.prepare("SELECT COUNT(*) AS n FROM task_runs").get(), { n: 1 });
});

Deno.test("postgres store: needs exactly one of sql and url", () => {
  for (const options of [{}, { sql: fakeSqlClient(), url: "postgres://x/y" }]) {
    let threw = false;
    try {
      postgresTaskHistoryStore(options);
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, JSON.stringify(Object.keys(options)));
  }
});

Deno.test("config: tasks.history takes a boolean or { store, maxRuns }", () => {
  const problems = (tasks: unknown): string[] => {
    const out: string[] = [];
    const fail = (field: string, message: string) => void out.push(`${field}: ${message}`);
    validateTasks(tasks as never, fail as never);
    return out;
  };
  const store = sqliteTaskHistoryStore({ path: ":memory:" });
  assertEquals(problems({ history: true }), []);
  assertEquals(problems({ history: {} }), []);
  assertEquals(problems({ history: { store, maxRuns: 10 } }), []);
  assertEquals(problems({ history: "yes" }), [
    "tasks.history: must be a boolean or { store?, maxRuns? }",
  ]);
  assertEquals(problems({ history: { maxRuns: 0 } }).length, 1);
  assertEquals(problems({ history: { store: { record() {} } } }), [
    "tasks.history.store: must be a TaskHistoryStore (missing read, listRuns, prune, clear)",
  ]);
});

/** A store that records into an array, optionally misbehaving. */
function memoryStore(mode: "ok" | "throws" | "rejects" | "slow" = "ok") {
  const runs: TaskRunRecord[] = [];
  let closed = 0;
  const store: TaskHistoryStore = {
    record(r) {
      if (mode === "throws") throw new Error("store exploded");
      if (mode === "rejects") return Promise.reject(new Error("store rejected"));
      if (mode === "slow") {
        return new Promise((resolve) => setTimeout(() => (runs.push(r), resolve()), 50));
      }
      runs.push(r);
    },
    read: () => Promise.resolve({ available: true, windowDays: 7, tasks: [], recent: [] }),
    listRuns: () => Promise.resolve([]),
    prune: () => Promise.resolve(),
    clear: () => Promise.resolve({ cleared: true }),
    close() {
      closed++;
    },
  };
  return { store, runs, closed: () => closed };
}

Deno.test("wiring: a configured store records every run and is not closed by the server", async () => {
  clearTasks();
  const mem = memoryStore();
  registerTask("th-store-job", defineTask({ handler: () => "done" }));
  const stop = startRunHistory({ tasks: { history: { store: mem.store } } }, "/nonexistent");
  try {
    await runTask("th-store-job", undefined, { trigger: "manual" });
    assertEquals(
      mem.runs.filter((r) => r.name === "th-store-job").map((r) => [r.name, r.ok, r.trigger]),
      [["th-store-job", true, "manual"]],
    );
  } finally {
    await stop();
    clearTasks();
  }
  assertEquals(mem.closed(), 0, "a dev re-boot installs the same store again");
});

Deno.test("wiring: a store that throws, rejects or is slow never fails or delays a run", async () => {
  for (const mode of ["throws", "rejects", "slow"] as const) {
    clearTasks();
    const mem = memoryStore(mode);
    registerTask("th-store-job", defineTask({ handler: () => "done" }));
    const stop = startRunHistory(
      { tasks: { history: { store: mem.store } } },
      "/nonexistent",
      { closeCustom: true },
    );
    try {
      const started = performance.now();
      assertEquals(await runTask("th-store-job"), "done", mode);
      assert(performance.now() - started < 40, `${mode}: the run did not wait on the store`);
    } finally {
      await stop(); // closeCustom: waits for the slow write, then closes
      clearTasks();
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
    clearTasks();
    registerTask("th-store-job", defineTask({ handler: () => "done" }));
    let stop = startRunHistory({ tasks: { history: false } }, dir);
    await runTask("th-store-job");
    await stop();
    assertEquals([...Deno.readDirSync(dir)], [], "history off: no file");
    stop = startRunHistory({ tasks: { history: { maxRuns: 3 } } }, dir);
    for (let i = 0; i < 5; i++) await runTask("th-store-job");
    await stop();
    // The next process's first insert prunes to the cap.
    stop = startRunHistory({ tasks: { history: { maxRuns: 3 } } }, dir);
    await runTask("th-store-job");
    await stop();
    const runs = await sqliteTaskHistoryStore({ path: join(dir, "tasks.db") }).listRuns(
      "th-store-job",
      { limit: 100 },
    );
    assertEquals(runs.length, 3, "{ maxRuns } capped the default store on its first insert");
  } finally {
    clearTasks();
    await Deno.remove(dir, { recursive: true });
  }
});
