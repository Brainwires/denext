// `@denext/backend` queues on a scripted Postgres: the statements the typed client sends to the
// pgmq functions (and their parameters), the row mapping, name and option validation, the
// identity a queue acts as, the migration, and the consumer job (handled, failed, dead-lettered,
// batches, abort). The SQL itself runs against a real Postgres in
// tests/backend-platform-integration.test.ts.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  installQueues,
  queue,
  queueConsumer,
  QueueError,
  queues,
} from "../packages/backend/src/queues.ts";
import { queuesMigrations, queuesSetupSql } from "../packages/backend/src/queues-sql.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { type ScriptedSql, scriptedSql } from "./helpers/scripted-sql.ts";

function setUp(
  answer: (text: string, params: unknown[]) => unknown[],
  migrate = false,
): ScriptedSql {
  const sql = scriptedSql(answer);
  installPostgres({ sql, rls: { migrate: false } });
  installQueues({ migrate });
  return sql;
}

function tearDown() {
  installQueues(undefined);
  installPostgres(undefined);
}

const ROW = {
  msg_id: "7",
  read_ct: 1,
  enqueued_at: "2026-10-13T00:00:00Z",
  vt: "2026-10-13T00:00:30Z",
  message: '{"to":"a@x"}',
};

Deno.test("queue client: each call is the pgmq function, with bound parameters", async () => {
  const metricsRow = {
    queue_name: "mail",
    queue_length: "2",
    queue_visible_length: "1",
    newest_msg_age_sec: 1,
    oldest_msg_age_sec: null,
    total_messages: "9",
    scrape_time: "2026-10-13T00:00:00Z",
  };
  const answers: Array<[RegExp, unknown[]]> = [
    [/pgmq\.send\(/, [{ id: "7" }]],
    [/send_batch/, [{ id: "8" }, { id: "9" }]],
    [/pgmq\.read\(|read_with_poll/, [ROW]],
    [/pgmq\.pop/, []],
    [/pgmq\.archive|pgmq\.delete/, [{ id: "7" }]],
    [/set_vt/, [{ ...ROW, message: { to: "b@x" } }]],
    [/purge_queue/, [{ n: "3" }]],
    [/pgmq\.metrics/, [metricsRow]],
  ];
  const sql = setUp((text) => {
    const found = answers.find(([pattern]) => pattern.test(text));
    if (!found) throw new Error(text);
    return found[1];
  });
  try {
    const mail = queue<{ to: string }>("mail");
    assertEquals(mail.name, "mail");
    assertEquals(await mail.send({ to: "a@x" }, { delay: 5 }), 7);
    assertEquals(sql.calls.at(-1)!.params, ["mail", '{"to":"a@x"}', 5]);
    assertEquals(await mail.sendBatch([{ to: "a" }, { to: "b" }]), [8, 9]);
    assertEquals(sql.calls.at(-1)!.params[2], 0);
    const [read] = await mail.read({ vt: 60, qty: 5 });
    assertEquals(read.msgId, 7);
    assertEquals(read.message, { to: "a@x" });
    assert(read.enqueuedAt instanceof Date);
    assertEquals(sql.calls.at(-1)!.params, ["mail", 60, 5]);
    await mail.read({ pollSeconds: 2 });
    assertStringIncludes(sql.calls.at(-1)!.text, "read_with_poll");
    assertEquals(sql.calls.at(-1)!.params, ["mail", 30, 1, 2]);
    assertEquals(await mail.pop(), null);
    assertEquals(await mail.archive(7), [7]);
    assertEquals(sql.calls.at(-1)!.params, ["mail", ["7"]]);
    assertEquals(await mail.delete([7, 8]), [7]);
    assertEquals(sql.calls.at(-1)!.params, ["mail", ["7", "8"]]);
    assertEquals((await mail.setVt(7, 0))?.message, { to: "b@x" });
    assertEquals(await mail.purge(), 3);
    const metrics = await mail.metrics();
    assertEquals(
      [
        metrics.queueLength,
        metrics.queueVisibleLength,
        metrics.oldestMsgAgeSec,
        metrics.totalMessages,
      ],
      [2, 1, null, 9],
    );
    // Validation happens before any SQL.
    const before = sql.calls.length;
    assertThrows(() => queue("Bad-Name"), QueueError, "invalid");
    assertThrows(() => queue("x".repeat(48)), QueueError);
    await assertRejects(() => mail.send({ to: "x" }, { delay: -1 }), TypeError, "delay");
    await assertRejects(() => mail.read({ vt: 1.5 }), TypeError, "vt");
    await assertRejects(() => mail.archive(1.5), TypeError, "integers");
    assertEquals(sql.calls.length, before);
  } finally {
    tearDown();
  }
});

Deno.test("queue client: setVt and pop map a row; null when gone", async () => {
  setUp((text) => (text.includes("set_vt") ? [] : [ROW]));
  try {
    assertEquals(await queue("mail").setVt(1, 5), null);
    assertEquals((await queue("mail").pop())?.msgId, 7);
  } finally {
    tearDown();
  }
});

Deno.test("queues: create, create unlogged, drop, list", async () => {
  const sql = setUp((text) => {
    if (text.includes("drop_queue")) return [{ dropped: true }];
    if (text.includes("list_queues")) {
      return [{ queue_name: "mail", is_unlogged: false, created_at: "2026-10-13T00:00:00Z" }];
    }
    return [];
  });
  try {
    await queues.create("mail");
    assertStringIncludes(sql.calls.at(-1)!.text, "pgmq.create($1)");
    await queues.create("fast", { unlogged: true });
    assertStringIncludes(sql.calls.at(-1)!.text, "create_unlogged");
    assertEquals(await queues.drop("mail"), true);
    const [listed] = await queues.list();
    assertEquals([listed.queueName, listed.isUnlogged], ["mail", false]);
    await assertRejects(() => queues.create("no way"), QueueError);
  } finally {
    tearDown();
  }
});

Deno.test("queues: the migration runs once before the first call, then not again", async () => {
  const sql = setUp(() => [], true);
  try {
    await queues.list();
    await queues.list();
    const created = sql.calls.filter((c) => c.text.includes("pgmq_public.send"));
    assertEquals(created.length, 1, "the migration's SQL was sent once");
  } finally {
    tearDown();
  }
});

Deno.test("queues: not configured is a clear error", async () => {
  installQueues(undefined);
  await assertRejects(() => queues.list(), QueueError, "not configured");
});

Deno.test("queues: the migration carries pgmq's API and Supabase's pgmq_public wrappers", () => {
  const [migration] = queuesMigrations();
  assertEquals(migration.name, "backend_queues_0001");
  for (
    const fn of [
      "pgmq.create(",
      "pgmq.send(",
      "pgmq.send_batch(",
      "pgmq.read(",
      "pgmq.read_with_poll(",
      "pgmq.pop(",
      "pgmq.archive(",
      "pgmq.delete(",
      "pgmq.set_vt(",
      "pgmq.metrics(",
      "pgmq.metrics_all(",
      "pgmq.purge_queue(",
      "pgmq.drop_queue(",
      "pgmq.list_queues(",
      "pgmq_public.send(",
      "pgmq_public.send_batch(",
      "pgmq_public.read(",
      "pgmq_public.pop(",
      "pgmq_public.archive(",
      "pgmq_public.delete(",
    ]
  ) assertStringIncludes(migration.sql, fn);
  assertStringIncludes(migration.sql, "extname = 'pgmq'");
  assertStringIncludes(queuesSetupSql(), "-- backend_queues_0001");
});

Deno.test("queueConsumer: handles, leaves failures for a retry, archives the dead", async () => {
  const messages = [
    { ...ROW, msg_id: "1", message: { n: 1 } },
    { ...ROW, msg_id: "2", message: { n: 2 } },
    { ...ROW, msg_id: "3", read_ct: 4, message: { n: 3 } },
  ];
  let reads = 0;
  const sql = setUp((text) => {
    if (text.includes("pgmq.read(")) return reads++ === 0 ? messages : [];
    if (text.includes("pgmq.archive") || text.includes("pgmq.delete")) return [];
    throw new Error(text);
  });
  const errors: unknown[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const job = queueConsumer<{ n: number }>({
      queue: "work",
      batchSize: 3,
      maxAttempts: 3,
      handler: ({ message }) => {
        if (message.n === 2) throw new Error("nope");
      },
    });
    assertEquals(job.description, "drain the work queue");
    const ctx = {
      name: "w",
      trigger: "manual" as const,
      signal: new AbortController().signal,
      attempt: 1,
    };
    assertEquals(await job.handler(ctx), { handled: 1, failed: 1, dead: 1 });
    const settled = sql.calls.filter((c) => /archive|delete/.test(c.text)).map((c) => c.params[1]);
    assertEquals(settled, [["1"], ["3"]], "1 handled, 3 dead");
    assertEquals(reads, 2, "a full batch reads again");
    assertEquals(errors.length, 2);
    // onSuccess: "delete", and an aborted run reads nothing.
    reads = 0;
    const deleting = queueConsumer({ queue: "work", onSuccess: "delete", handler: () => {} });
    await deleting.handler(ctx);
    assert(sql.calls.at(-1)!.text.includes("pgmq.delete"));
    const aborted = new AbortController();
    aborted.abort();
    reads = 0;
    assertEquals(await deleting.handler({ ...ctx, signal: aborted.signal }), {
      handled: 0,
      failed: 0,
      dead: 0,
    });
    assertEquals(reads, 0);
    assertThrows(() => queueConsumer({ queue: "BAD", handler: () => {} }), QueueError);
  } finally {
    console.error = consoleError;
    tearDown();
  }
});

Deno.test("queue client: { as } runs the call scoped to that identity", async () => {
  const sql = setUp((text) => (text.includes("pgmq.send(") ? [{ id: "1" }] : []));
  try {
    await queue("mail", { as: { id: "6d1c4c6e-7a1e-4d43-9a0f-3c1f0c0a0001" } }).send({});
    const setup = sql.calls.find((c) => c.text.includes("set_config('role'"));
    assertEquals(setup?.params[0], "authenticated");
    await queue("mail", { as: "anon" }).send({});
    assertEquals(
      sql.calls.filter((c) => c.text.includes("set_config('role'")).at(-1)?.params[0],
      "anon",
    );
  } finally {
    tearDown();
  }
});
