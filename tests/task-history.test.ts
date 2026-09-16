// The task run-history store: what it records, what it prunes, and — above all — that a broken
// store never breaks a run.
//
// Two shapes of test. Projections and pruning need a REAL database, because `:memory:` is
// per-connection and the whole point is that a separate reader sees the writer's rows. Failure
// modes use a stub handle, because a read-only filesystem is easier to simulate than to create.
//
// Never `Deno.chdir` here — `tests/cache-default-store.test.ts` documents why it corrupts
// parallel runs that spawn subprocesses.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { SqliteDb, SqlValue } from "../src/server/sqlite-cache.ts";
import type { TaskRunRecord } from "../src/server/tasks.ts";
import {
  clearTaskHistory,
  readTaskHistory,
  taskHistoryRecorder,
} from "../src/server/task-history.ts";

/** A run, with the boring fields filled in. */
function run(over: Partial<TaskRunRecord> & { name: string }): TaskRunRecord {
  return { trigger: "schedule", startedAt: Date.now(), durationMs: 5, ok: true, ...over };
}

/** A handle that fails in a chosen way, and counts how often it was opened. */
function stub(mode: "open-throws" | "exec-throws"): {
  open: (path: string) => SqliteDb;
  opens: () => number;
} {
  let opens = 0;
  return {
    open(_path: string): SqliteDb {
      opens += 1;
      if (mode === "open-throws") throw new Error("unable to open database file");
      return {
        exec(_sql: string, _params?: SqlValue[]): void {
          throw new Error("database is locked");
        },
        query<T>(): T[] {
          return [];
        },
        close(): void {},
      };
    },
    opens: () => opens,
  };
}

Deno.test("what was recorded is what comes back", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_task_history_" });
  const path = join(dir, "tasks.db");
  try {
    const store = taskHistoryRecorder({ path });
    const t0 = Date.now();
    store.record(run({ name: "cleanup", startedAt: t0 - 3000, durationMs: 412, ok: true }));
    store.record(run({ name: "cleanup", startedAt: t0 - 2000, ok: false, detail: "boom" }));
    store.record(run({ name: "digest", startedAt: t0 - 1000, durationMs: 9, ok: true }));
    store.close();

    const history = readTaskHistory({ path });
    assert(history.available, history.reason ?? "");
    assertEquals(history.tasks.length, 2);

    const cleanup = history.tasks.find((t) => t.task === "cleanup")!;
    // Last status is the most recent run, not a summary of all of them.
    assertEquals(cleanup.lastOk, false);
    assertEquals(cleanup.successes, 1);
    assertEquals(cleanup.failures, 1);

    // The feed is newest first, and carries the detail.
    assertEquals(history.recent.map((r) => r.task), ["digest", "cleanup", "cleanup"]);
    assertEquals(history.recent[1].detail, "boom");
    assertEquals(history.recent[1].ok, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a quiet task's history is never evicted by a noisy one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_task_history_" });
  const path = join(dir, "tasks.db");
  try {
    const store = taskHistoryRecorder({ path, maxRuns: 10 });
    store.record(run({ name: "daily" })); // the quiet task, recorded once
    // The noisy task crosses the prune threshold. A GLOBAL cap would evict `daily` here and
    // silently corrupt its counts; a per-task cap cannot.
    for (let i = 0; i < 250; i++) store.record(run({ name: "noisy" }));
    store.close();

    const history = readTaskHistory({ path });
    assert(history.available, history.reason ?? "");
    const daily = history.tasks.find((t) => t.task === "daily");
    assert(daily, "the quiet task still has history");
    assertEquals(daily.successes, 1);
    // The cap is enforced by an amortised prune, not on every insert, so it is deliberately not
    // a hard ceiling between prunes: 250 inserts prune once at 200 (down to 10) and the rest
    // accumulate. What matters is that pruning happened at all — and that it touched only
    // the task whose run triggered it.
    const noisy = history.tasks.find((t) => t.task === "noisy")!;
    assert(noisy.successes < 250, `the noisy task was pruned, got ${noisy.successes}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a store that cannot open gives up once, and never throws", () => {
  const s = stub("open-throws");
  const store = taskHistoryRecorder({ path: "/nowhere/tasks.db", openDb: s.open });
  for (let i = 0; i < 5; i++) store.record(run({ name: "cleanup" }));
  // The latch: one failed open, then it stops trying for the life of the process.
  assertEquals(s.opens(), 1);
  store.close();
});

Deno.test("a store that cannot write gives up after a few tries, and never throws", () => {
  const s = stub("exec-throws");
  // The schema DDL itself throws, so this latches on the open path rather than the write path —
  // either way the caller sees nothing.
  const store = taskHistoryRecorder({ path: "/nowhere/tasks.db", openDb: s.open });
  for (let i = 0; i < 10; i++) store.record(run({ name: "cleanup" }));
  assertEquals(s.opens(), 1);
  store.close();
});

Deno.test("a genuinely impossible path latches, with no stub involved", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_task_history_" });
  // The PARENT is a file, so mkdir and open both fail for real — exercising node:sqlite rather
  // than a mock, on every platform.
  const blocker = join(dir, "blocker");
  await Deno.writeTextFile(blocker, "not a directory");
  try {
    const store = taskHistoryRecorder({ path: join(blocker, "tasks.db") });
    store.record(run({ name: "cleanup" })); // must not throw
    store.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("no database yet is an ordinary answer, not an error message", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_task_history_" });
  try {
    const history = readTaskHistory({ path: join(dir, "tasks.db") });
    assertEquals(history.available, false);
    // node:sqlite reports a missing file as "unable to open database file: <absolute path>".
    // The panel must say the ordinary thing instead, and must not put a filesystem path on screen.
    assertEquals(history.reason, "no history recorded yet");
    assert(!(history.reason ?? "").includes(dir), "no filesystem path reaches the reason");
    assertEquals(history.tasks, []);
    assertEquals(history.recent, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an enabled store with nothing recorded is distinguishable from a missing one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_task_history_" });
  const path = join(dir, "tasks.db");
  try {
    // Opening the writer creates the file and the schema without recording anything.
    const store = taskHistoryRecorder({ path });
    store.record(run({ name: "cleanup", startedAt: Date.now() - 40 * 86_400_000 }));
    store.close();
    // The row is far outside the 7-day window: readable, but nothing to show.
    const history = readTaskHistory({ path });
    assertEquals(history.available, true, "the database is readable");
    assertEquals(history.tasks, [], "and simply has nothing inside the window");
    assertEquals(history.recent.length, 1, "while the feed still shows it");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Whether a path exists. */
async function present(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("clearing removes every run and keeps the database itself", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_task_history_" });
  const path = join(dir, "tasks.db");
  try {
    const store = taskHistoryRecorder({ path });
    store.record(run({ name: "cleanup" }));
    store.record(run({ name: "digest", ok: false, detail: "boom" }));
    store.close();

    assertEquals(clearTaskHistory({ path }).cleared, true);

    // A DELETE, not an unlink: the app process may hold this file open with live -wal/-shm
    // siblings, and removing it out from under that handle is the failure mode this avoids.
    assert(await present(path), "the database survives being cleared");
    const after = readTaskHistory({ path });
    assertEquals(after.available, true, "still readable");
    assertEquals(after.recent, []);
    assertEquals(after.tasks, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clearing a history that never existed is an ordinary answer", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_task_history_" });
  try {
    const done = clearTaskHistory({ path: join(dir, "tasks.db") });
    assertEquals(done.cleared, false);
    // Not a raw SQLite string with a filesystem path in it.
    assertEquals(done.reason, "no history recorded yet");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a store that cannot be opened is reported, never thrown", () => {
  const s = stub("open-throws");
  const done = clearTaskHistory({ path: "/nowhere/tasks.db", openDb: s.open });
  assertEquals(done.cleared, false);
  assert((done.reason ?? "").length > 0, "it says why");
});
