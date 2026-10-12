// `@denext/backend` realtime against the fake client and the real Live channel hub (driven
// without a socket): per-subscriber authorization by re-reading AS the subscriber, deletes only
// to subscribers who could see the row, filters, coalescing of a burst into one re-read per
// identity, frame splitting under the channel's payload cap, key binding to one identity, the
// reconnect resync, the service hook and revalidation, the server-side subscription, the
// unsupported path, and the root context. What only a real server shows (policies in SQL,
// NOTIFY at commit, a terminated listener reconnecting) is in
// tests/backend-realtime-integration.test.ts.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { resetChannels, setChannelPayloadCap } from "../src/runtime/channel.ts";
import { unstable_cache } from "../src/server/cache.ts";
import {
  backend,
  realtime,
  realtimeMigrations,
  type RealtimeOptions,
  realtimeSetupSql,
} from "../packages/backend/mod.ts";
import {
  onTableChange,
  RealtimeUnsupportedError,
  type TableChangeEvent,
  tableChanges,
  type TableChangesFrame,
} from "../packages/backend/server.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { RLS_SETUP } from "../packages/backend/src/rls.ts";
import {
  installRealtime,
  parseNotification,
  realtimeEngine,
  REVALIDATE_OWNER_SQL,
  splitFrame,
  toFrames,
} from "../packages/backend/src/realtime.ts";
import type { SqlClient } from "../src/server/postgres.ts";
import {
  decodeSubscriptionKey,
  encodeSubscriptionKey,
  newNonce,
  parseFilter,
} from "../packages/backend/src/realtime-shared.ts";
import { type FakeRealtimeClient, fakeRealtimeClient } from "./helpers/fake-realtime-client.ts";
import {
  authConfig,
  changesOf,
  cookieFor,
  type Harness,
  realtimeHarness,
  settle,
  until,
} from "./helpers/realtime-harness.ts";

const load = ((path: string) => import(path)) as unknown as ModuleLoader;
const A = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000a";
const B = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000b";

/** Notes: readable by their owner only (as `using (auth.uid() = owner)`). */
const ownerOnly = (claims: { sub?: string }, row: Record<string, unknown>) =>
  claims.sub !== undefined && claims.sub === row.owner;

interface Env {
  sql: FakeRealtimeClient;
  hub: Harness;
  a: string;
  b: string;
  done(): Promise<void>;
}

async function setUp(
  options: Partial<RealtimeOptions> = {},
  sql = fakeRealtimeClient({ notes: { policy: ownerOnly }, items: { key: "sku" } }),
): Promise<Env> {
  resetPlugins();
  resetChannels();
  installPostgres(undefined);
  installRealtime(undefined);
  await applyPlugins({
    projectRoot: "/tmp/x",
    appDir: "/tmp/x/app",
    config: {
      plugins: [
        denextAuth(authConfig),
        backend({
          postgres: { sql, rls: { migrate: false } },
          realtime: {
            tables: { notes: {}, items: { key: "sku", events: ["insert", "delete"] } },
            migrate: false,
            ...options,
          },
        }),
      ],
    } as DenextConfig,
    mode: "prod",
    load,
  });
  const hub = realtimeHarness();
  return {
    sql,
    hub,
    a: await cookieFor(A),
    b: await cookieFor(B),
    async done() {
      hub.dispose();
      await runPluginTeardown();
      resetPlugins();
      resetChannels();
      installPostgres(undefined);
      installRealtime(undefined);
    },
  };
}

Deno.test("realtime: a change reaches only the subscribers whose policies can SELECT the row", async () => {
  const env = await setUp();
  try {
    const ca = env.hub.conn(env.a);
    const cb = env.hub.conn(env.b);
    const anon = env.hub.conn();
    assert((await env.hub.subscribe(ca, "notes")).ok);
    assert((await env.hub.subscribe(cb, "notes")).ok);
    assert((await env.hub.subscribe(anon, "notes")).ok);
    assertEquals(env.sql.statements.filter((s) => s.startsWith("LISTEN")).length, 1);

    env.sql.insert("notes", { id: 1, owner: A, body: "a's" });
    await until(() => ca.frames.length === 1, 3_000, "A's frame");
    await settle();
    assertEquals(changesOf(ca), [{
      op: "insert",
      key: "1",
      row: { id: 1, owner: A, body: "a's" },
    }]);
    assertEquals(changesOf(cb), [], "B cannot see A's note");
    assertEquals(changesOf(anon), [], "anon cannot see it");

    env.sql.insert("notes", { id: 2, owner: B, body: "b's" });
    await until(() => cb.frames.length === 1, 3_000, "B's frame");
    await settle();
    assertEquals(changesOf(cb), [{
      op: "insert",
      key: "2",
      row: { id: 2, owner: B, body: "b's" },
    }]);
    assertEquals(changesOf(ca).length, 1, "A did not get B's note");
    assertEquals(ca.frames.map((f) => f.seq), [1]);
    assertEquals(cb.frames.map((f) => f.seq), [1]);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: visibility changes on update; deletes reach only those who could see the row", async () => {
  const env = await setUp();
  try {
    // A's note exists before anyone subscribes: the seed query tracks it for A only.
    env.sql.tables.get("notes")!.set("7", { id: 7, owner: A, body: "old" });
    const ca = env.hub.conn(env.a);
    const cb = env.hub.conn(env.b);
    await env.hub.subscribe(ca, "notes");
    await env.hub.subscribe(cb, "notes");

    env.sql.update("notes", "7", { body: "edited" });
    await until(() => ca.frames.length === 1);
    assertEquals(changesOf(ca), [{
      op: "update",
      key: "7",
      row: { id: 7, owner: A, body: "edited" },
    }]);

    // Handed to B: it leaves A's view (a delete for A), enters B's (an insert for B).
    env.sql.update("notes", "7", { owner: B });
    await until(() => ca.frames.length === 2 && cb.frames.length === 1);
    assertEquals(ca.frames[1].changes, [{ op: "delete", key: "7" }]);
    assertEquals(cb.frames[0].changes, [{
      op: "insert",
      key: "7",
      row: { id: 7, owner: B, body: "edited" },
    }]);

    // Deleted: only B (who can see it now) is told; A no longer tracks it.
    env.sql.remove("notes", "7");
    await until(() => cb.frames.length === 2);
    await settle();
    assertEquals(cb.frames[1].changes, [{ op: "delete", key: "7" }]);
    assertEquals(ca.frames.length, 2, "A is not told about a row it cannot see");

    // A delete of a row nobody was ever sent reaches nobody.
    env.sql.tables.get("notes")!.set("8", { id: 8, owner: A, body: "unseen" });
    env.sql.remove("notes", "8");
    await settle(120);
    assertEquals([ca.frames.length, cb.frames.length], [2, 2]);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: a key change on update arrives with oldKey; a delete of the old key is not sent", async () => {
  const env = await setUp();
  try {
    env.sql.tables.get("notes")!.set("1", { id: 1, owner: A, body: "x" });
    const ca = env.hub.conn(env.a);
    await env.hub.subscribe(ca, "notes");
    env.sql.update("notes", "1", { id: 10 });
    await until(() => ca.frames.length === 1);
    assertEquals(changesOf(ca), [{
      op: "update",
      key: "10",
      oldKey: "1",
      row: { id: 10, owner: A, body: "x" },
    }]);
    // Renamed out of view: both keys are judged; the old one is no longer tracked.
    env.sql.update("notes", "10", { id: 11, owner: B });
    await until(() => ca.frames.length === 2);
    assertEquals(ca.frames[1].changes, [{ op: "delete", key: "10" }]);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: a filter narrows the rows; a row updated out of the filter is a delete", async () => {
  const env = await setUp();
  try {
    const ca = env.hub.conn(env.a);
    await env.hub.subscribe(ca, "notes", { filter: { list: 1 } });
    env.sql.insert("notes", { id: 1, owner: A, list: 1, body: "in" });
    env.sql.insert("notes", { id: 2, owner: A, list: 2, body: "out" });
    await until(() => ca.frames.length === 1);
    await settle();
    assertEquals(changesOf(ca).map((c) => c.key), ["1"]);
    env.sql.update("notes", "1", { list: 2 });
    await until(() => ca.frames.length === 2);
    assertEquals(ca.frames[1].changes, [{ op: "delete", key: "1" }]);
    // The Supabase string form is the same filter.
    assertEquals(parseFilter("list=eq.1"), { column: "list", value: "1" });
  } finally {
    await env.done();
  }
});

Deno.test("realtime: a burst of 500 inserts is coalesced into one re-read per identity", async () => {
  const env = await setUp();
  try {
    const ca = env.hub.conn(env.a);
    const ca2 = env.hub.conn(env.a); // A's second tab: same identity, same group
    const cb = env.hub.conn(env.b);
    await env.hub.subscribe(ca, "notes");
    await env.hub.subscribe(ca2, "notes");
    await env.hub.subscribe(cb, "notes");
    const engine = realtimeEngine();
    const before = { ...engine.stats };
    for (let i = 1; i <= 500; i++) {
      env.sql.insert("notes", { id: i, owner: i % 2 ? A : B, body: `note ${i} ${"x".repeat(60)}` });
    }
    await until(() => changesOf(ca).length === 250 && changesOf(cb).length === 250, 5_000);
    await until(() => changesOf(ca2).length === 250);
    const stats = engine.stats;
    assertEquals(stats.notifications - before.notifications, 500);
    assertEquals(stats.flushes - before.flushes, 1, "one burst");
    // Three subscriptions, two identities (A's two tabs share a session, so the same claims):
    // two re-reads for the whole burst.
    assertEquals(stats.rereads - before.rereads, 2);
    // Every key in commit order, split into frames under the payload cap, numbered 1…n.
    assertEquals(changesOf(ca).map((c) => Number(c.key)), [...Array(250)].map((_, i) => 2 * i + 1));
    assert(ca.frames.length > 1, "split into several frames");
    assertEquals(ca.frames.map((f) => f.seq), ca.frames.map((_, i) => i + 1));
    console.log(
      `coalescing: 500 notifications → ${stats.flushes - before.flushes} flush, ` +
        `${stats.rereads - before.rereads} re-reads, ${
          ca.frames.length + ca2.frames.length + cb.frames.length
        } frames`,
    );
  } finally {
    await env.done();
  }
});

Deno.test("realtime: a subscription key is bound to one identity; malformed or unknown keys are refused", async () => {
  const env = await setUp();
  try {
    const ca = env.hub.conn(env.a);
    const { key } = await env.hub.subscribe(ca, "notes");
    // B presenting A's key (a leaked nonce) is refused; anon too.
    const cb = env.hub.conn(env.b);
    assertEquals((await env.hub.subscribe(cb, "notes", { key })).ok, false);
    assertEquals(cb.errors, ["deny"]);
    const anon = env.hub.conn();
    assertEquals((await env.hub.subscribe(anon, "notes", { key })).ok, false);
    // A second connection of A's (a reconnect) may resume it.
    const ca2 = env.hub.conn(env.a);
    assert((await env.hub.subscribe(ca2, "notes", { key })).ok);
    // Not configured, malformed, a short nonce.
    for (const bad of [`users|${newNonce()}`, "notes", "notes|short", `notes|${newNonce()}|x`]) {
      assertEquals((await env.hub.subscribe(ca, "notes", { key: bad, subId: "x" })).ok, false);
    }
  } finally {
    await env.done();
  }
});

Deno.test("realtime: an idle subscription costs no re-read, resumes within its grace, and a re-listen resyncs", async () => {
  const env = await setUp();
  try {
    const ca = env.hub.conn(env.a);
    const { key } = await env.hub.subscribe(ca, "notes");
    env.hub.drop(ca); // the socket closed
    const engine = realtimeEngine();
    const rereads = engine.stats.rereads;
    env.sql.insert("notes", { id: 1, owner: A, body: "while away" });
    await settle(120);
    assertEquals(engine.stats.rereads, rereads, "no subscriber, no query");
    assertEquals(engine.size, 1, "kept for a reconnect");

    const back = env.hub.conn(env.a);
    assert((await env.hub.subscribe(back, "notes", { key })).ok);
    env.sql.reconnect(); // the listening connection was lost and is back
    await until(() => back.frames.length === 1);
    assertEquals(back.frames[0], { seq: 1, resync: true });

    env.sql.insert("notes", { id: 2, owner: A, body: "after" });
    await until(() => back.frames.length === 2);
    assertEquals(back.frames[1].changes?.[0].key, "2");
    // An unsubscribe ends it: nothing more is sent, and it is forgotten at once.
    env.hub.unsubscribe(back);
    assertEquals(engine.size, 0);
    env.sql.insert("notes", { id: 3, owner: A, body: "gone" });
    await settle(120);
    assertEquals(back.frames.length, 2);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: frames respect the channel's payload cap; an oversized row is sent truncated", async () => {
  const env = await setUp();
  setChannelPayloadCap(2_000);
  try {
    const ca = env.hub.conn(env.a);
    await env.hub.subscribe(ca, "notes");
    for (let i = 1; i <= 4; i++) {
      env.sql.insert("notes", { id: i, owner: A, body: "y".repeat(700) });
    }
    env.sql.insert("notes", { id: 5, owner: A, body: "z".repeat(20_000) });
    await until(() => changesOf(ca).length === 5, 5_000);
    assert(ca.frames.length >= 3, `split to fit 2 000 bytes (${ca.frames.length} frames)`);
    assertEquals(ca.frames.map((f) => f.seq), ca.frames.map((_, i) => i + 1));
    assertEquals(changesOf(ca)[4], { op: "insert", key: "5", truncated: true });
  } finally {
    setChannelPayloadCap(16 * 1024);
    await env.done();
  }
});

Deno.test("realtime: onTableChange runs in the root context; revalidate re-pushes table:<name>", async () => {
  const env = await setUp({ revalidate: true });
  try {
    const seen: Array<TableChangeEvent & { inRequest: boolean }> = [];
    type Bridge = { __denextCurrentRequestContext?: () => unknown };
    const stop = onTableChange("notes", (event) => {
      const ctx = (globalThis as Bridge).__denextCurrentRequestContext?.();
      seen.push({ ...event, inRequest: ctx !== undefined });
    });
    let computed = 0;
    const cached = unstable_cache(() => Promise.resolve(++computed), ["count"], {
      tags: ["table:notes"],
    });
    await cached();
    await cached();
    assertEquals(computed, 1);
    // The write happens inside a request: the notification must not inherit it.
    await runWithContext(createRequestContext(new Request("https://app.test/")), async () => {
      await realtimeEngine().start();
      env.sql.insert("notes", { id: 1, owner: A, body: "x" });
      env.sql.update("notes", "1", { body: "y" });
    });
    await until(() => seen.length === 1);
    assertEquals(seen[0].op, "insert", "an insert then an update in one burst stays an insert");
    assertEquals([seen[0].table, seen[0].key, seen[0].inRequest], ["notes", "1", false]);
    await until(() => computed === 2 || (void cached(), false), 2_000, "revalidation");
    stop();
    env.sql.remove("notes", "1");
    await settle(120);
    assertEquals(seen.length, 1, "unsubscribed");
    assertThrows(() => onTableChange("nope", () => {}), TypeError, "not in realtime");
  } finally {
    await env.done();
  }
});

/** A reserved connection whose owner-lock answer the test steers, recording what it was sent. */
function lockConnection(log: string[], answer: () => boolean | Error) {
  return () => {
    log.push("reserve");
    const conn = Object.assign(() => Promise.resolve([]), {
      unsafe: (text: string) => {
        log.push(text === REVALIDATE_OWNER_SQL ? "owner?" : text);
        const result = text === REVALIDATE_OWNER_SQL ? answer() : true;
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve([{ owner: result }]);
      },
      begin: () => Promise.reject(new Error("unused")),
      close: () => Promise.resolve(),
      release: () => void log.push("release"),
    }) as unknown as SqlClient & { release(): void };
    return Promise.resolve(conn);
  };
}

Deno.test("realtime: revalidate { owner: 'one' } revalidates only while this instance holds the lock", async () => {
  const sql = fakeRealtimeClient({ notes: { policy: ownerOnly }, items: { key: "sku" } });
  const log: string[] = [];
  let owner: boolean | Error = false;
  sql.reserve = lockConnection(log, () => owner);
  const env = await setUp({ revalidate: { owner: "one" } }, sql);
  try {
    const engine = realtimeEngine();
    const hooks: string[] = [];
    onTableChange("notes", (event) => hooks.push(event.key ?? ""));
    await engine.start();
    // Not the owner: the hooks run here, the revalidation is another instance's.
    env.sql.insert("notes", { id: 1, owner: A, body: "x" });
    await until(() => hooks.length === 1 && log.includes("owner?"));
    await settle(30);
    assertEquals(engine.stats.revalidations, 0);
    // The owner: it revalidates, on the same reserved connection.
    owner = true;
    env.sql.insert("notes", { id: 2, owner: A, body: "y" });
    await until(() => engine.stats.revalidations === 1, 2_000, "the owner's revalidation");
    assertEquals(log.filter((l) => l === "reserve").length, 1, "one connection, reused");
    // The connection died (its lock with it): this burst is not revalidated here, the
    // connection is returned, and the next burst checks on a fresh one.
    owner = new Error("connection terminated");
    env.sql.insert("notes", { id: 3, owner: A, body: "z" });
    await until(() => log.includes("release"), 2_000, "the dead connection released");
    assertEquals(engine.stats.revalidations, 1);
    owner = true;
    env.sql.insert("notes", { id: 4, owner: A, body: "w" });
    await until(() => engine.stats.revalidations === 2, 2_000, "revalidation after failover");
    assertEquals(log.filter((l) => l === "reserve").length, 2);
    // Stopping gives the lock up before the connection goes back to the pool.
    log.length = 0;
    await engine.stop();
    assertEquals(log, ["select pg_advisory_unlock(1684369016, 1)", "release"]);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: revalidate { owner: 'one' } without reserve() warns and revalidates everywhere", async () => {
  const env = await setUp({ revalidate: { owner: "one" } });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    const engine = realtimeEngine();
    await engine.start();
    env.sql.insert("notes", { id: 1, owner: A, body: "x" });
    await until(() => engine.stats.revalidations === 1, 2_000, "revalidation");
    env.sql.insert("notes", { id: 2, owner: A, body: "y" });
    await until(() => engine.stats.revalidations === 2, 2_000, "revalidation");
    assertEquals(warnings.length, 1, "warned once");
    assert(warnings[0].includes("reserve()"));
  } finally {
    console.warn = warn;
    await env.done();
  }
});

Deno.test("realtime: tableChanges() subscribes on the server as an identity", async () => {
  const env = await setUp();
  try {
    const frames: TableChangesFrame[] = [];
    const stop = await tableChanges("notes", {
      as: { id: B },
      filter: "list=eq.3",
      onChange: (frame) => frames.push(frame),
    });
    env.sql.insert("notes", { id: 1, owner: A, list: 3, body: "a" });
    env.sql.insert("notes", { id: 2, owner: B, list: 3, body: "b" });
    env.sql.insert("notes", { id: 3, owner: B, list: 4, body: "c" });
    await until(() => frames.length === 1);
    await settle();
    assertEquals(frames, [{
      seq: 1,
      changes: [{ op: "insert", key: "2", row: { id: 2, owner: B, list: 3, body: "b" } }],
    }]);
    stop();
    env.sql.insert("notes", { id: 4, owner: B, list: 3, body: "d" });
    await settle(120);
    assertEquals(frames.length, 1);
    await assertRejects(() => tableChanges("nope", { onChange: () => {} }), TypeError);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: without listen() it is unsupported, clearly", async () => {
  const env = await setUp({}, fakeRealtimeClient({ notes: {} }, false));
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    const error = assertThrows(() => onTableChange("notes", () => {}), RealtimeUnsupportedError);
    assertEquals(error.code, "unsupported");
    await assertRejects(
      () => tableChanges("notes", { onChange: () => {} }),
      RealtimeUnsupportedError,
    );
    const ca = env.hub.conn(env.a);
    assertEquals((await env.hub.subscribe(ca, "notes")).ok, false);
    await env.hub.subscribe(ca, "notes", { subId: "again" });
    assertEquals(errors.length, 1, "logged once");
    assert(String(errors[0]).includes("no listen()"));
  } finally {
    console.error = original;
    await env.done();
  }
});

Deno.test("realtime: the subscription cap refuses more subscribers", async () => {
  const env = await setUp({ maxSubscribers: 2 });
  const original = console.warn;
  console.warn = () => {};
  try {
    const ca = env.hub.conn(env.a);
    assert((await env.hub.subscribe(ca, "notes", { subId: "1" })).ok);
    assert((await env.hub.subscribe(ca, "notes", { subId: "2" })).ok);
    assertEquals((await env.hub.subscribe(ca, "notes", { subId: "3" })).ok, false);
  } finally {
    console.warn = original;
    await env.done();
  }
});

Deno.test("realtime: an unsubscribed key is forgotten at once, so churn holds nothing", async () => {
  const env = await setUp({ maxSubscribers: 5 });
  const original = console.warn;
  console.warn = () => {};
  try {
    // One signed-out connection subscribing with a fresh key and unsubscribing, over and over:
    // each key used to be kept 15 s, so twenty of them filled the instance's five slots.
    const anon = env.hub.conn();
    for (let i = 0; i < 20; i++) {
      assert((await env.hub.subscribe(anon, "notes")).ok, `subscribe ${i}`);
      env.hub.unsubscribe(anon);
    }
    assertEquals(realtimeEngine().size, 0);
    assert((await env.hub.subscribe(env.hub.conn(env.a), "notes")).ok, "others still get in");
  } finally {
    console.warn = original;
    await env.done();
  }
});

Deno.test("realtime: subscriptions are capped per identity — a user, or one signed-out connection", async () => {
  const env = await setUp({ maxSubscriptionsPerIdentity: 3 });
  try {
    const engine = realtimeEngine();
    // A, across two connections (two tabs): three subscriptions — three filters, three re-read
    // groups — and no more.
    const [ca, ca2] = [env.hub.conn(env.a), env.hub.conn(env.a)];
    for (const [conn, list] of [[ca, 1], [ca, 2], [ca2, 3]] as const) {
      assert((await env.hub.subscribe(conn, "notes", { filter: { list }, subId: `l${list}` })).ok);
    }
    assertEquals((await env.hub.subscribe(ca2, "notes", { subId: "l4" })).ok, false);
    assertEquals(ca2.errors, ["deny"]);
    // B is not affected by A's quota.
    assert((await env.hub.subscribe(env.hub.conn(env.b), "notes")).ok);
    // Signed out, the quota is per connection.
    const [anon, anon2] = [env.hub.conn(), env.hub.conn()];
    for (const subId of ["1", "2", "3"]) {
      assert((await env.hub.subscribe(anon, "notes", { subId })).ok);
    }
    assertEquals((await env.hub.subscribe(anon, "notes", { subId: "4" })).ok, false);
    assert((await env.hub.subscribe(anon2, "notes")).ok);
    assertEquals(engine.size, 3 + 1 + 3 + 1);

    // A's first tab closes: its two subscriptions are kept for a reconnect, but count — and give
    // way (oldest first) when A subscribes anew rather than refusing it.
    env.hub.drop(ca);
    assertEquals(engine.size, 8);
    assert((await env.hub.subscribe(ca2, "notes", { subId: "l5" })).ok);
    assertEquals(engine.size, 8, "one kept subscription made room");
    assert((await env.hub.subscribe(ca2, "notes", { subId: "l6" })).ok);
    assertEquals((await env.hub.subscribe(ca2, "notes", { subId: "l7" })).ok, false);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: signed out, the quota is per client address — across that address's connections", async () => {
  const env = await setUp({ maxSubscriptionsPerIdentity: 2 });
  try {
    // Two tabs (two Live connections) from one address share one quota…
    const [tab1, tab2] = [env.hub.conn("", "198.51.100.7"), env.hub.conn("", "198.51.100.7")];
    assert((await env.hub.subscribe(tab1, "notes", { subId: "1" })).ok);
    assert((await env.hub.subscribe(tab2, "notes", { subId: "2" })).ok);
    assertEquals((await env.hub.subscribe(tab2, "notes", { subId: "3" })).ok, false);
    assertEquals(tab2.errors, ["deny"]);
    // …which another address does not touch, nor a signed-in user at the same address.
    assert((await env.hub.subscribe(env.hub.conn("", "198.51.100.8"), "notes")).ok);
    assert((await env.hub.subscribe(env.hub.conn(env.a, "198.51.100.7"), "notes")).ok);
    assertEquals(realtimeEngine().size, 4);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: signed out behind an untrusted proxy-looking address, the quota is per connection", async () => {
  const env = await setUp({ maxSubscriptionsPerIdentity: 1 });
  try {
    // Every visitor behind a reverse proxy (no trustForwardedHeaders) arrives from its loopback
    // or private address: keying the quota on it would make one quota site-wide.
    for (const proxy of ["127.0.0.1", "10.1.2.3", "::1", "::ffff:192.168.0.9", "fd00::7"]) {
      const [tab1, tab2] = [env.hub.conn("", proxy), env.hub.conn("", proxy)];
      assert((await env.hub.subscribe(tab1, "notes", { subId: "1" })).ok, proxy);
      assert((await env.hub.subscribe(tab2, "notes", { subId: "1" })).ok, `${proxy}: own quota`);
      assertEquals((await env.hub.subscribe(tab2, "notes", { subId: "2" })).ok, false, proxy);
    }
  } finally {
    await env.done();
  }
});

Deno.test("realtime: at the instance cap a disconnected subscription gives way; live ones refuse", async () => {
  const env = await setUp({ maxSubscribers: 2 });
  const original = console.warn;
  console.warn = () => {};
  try {
    const engine = realtimeEngine();
    const ca = env.hub.conn(env.a);
    assert((await env.hub.subscribe(ca, "notes")).ok);
    assert((await env.hub.subscribe(env.hub.conn(env.b), "notes")).ok);
    assertEquals((await env.hub.subscribe(env.hub.conn(), "notes")).ok, false, "both live");
    env.hub.drop(ca); // kept for a reconnect…
    assert((await env.hub.subscribe(env.hub.conn(), "notes")).ok, "…until the room is needed");
    assertEquals(engine.size, 2);
  } finally {
    console.warn = original;
    await env.done();
  }
});

Deno.test("realtime: subscribe-time seed queries are bounded — a few at once, a budget per identity", async () => {
  const env = await setUp();
  try {
    // Ten subscriptions at once: at most four seed queries run together.
    env.sql.delay.seed = 30;
    const ca = env.hub.conn(env.a);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => env.hub.subscribe(ca, "notes", { subId: `p${i}` })),
    );
    assert(results.every((r) => r.ok));
    assertEquals(env.sql.inFlight.maxSeed, 4);
    env.sql.delay.seed = 0;

    // A signed-out connection opening (and closing) subscriptions as fast as it can: a burst of
    // 32, then about 8 a second.
    const anon = env.hub.conn();
    let admitted = 0;
    for (let i = 0; i < 48; i++) {
      if ((await env.hub.subscribe(anon, "notes")).ok) admitted++;
      env.hub.unsubscribe(anon);
    }
    assert(admitted >= 32 && admitted < 40, `admitted ${admitted}`);
    assertEquals((await env.hub.subscribe(anon, "notes")).ok, false);
    assert((await env.hub.subscribe(env.hub.conn(), "notes")).ok, "another connection's budget");
  } finally {
    await env.done();
  }
});

Deno.test("realtime: re-reads compare keys and filters in the column's type, under a statement timeout", async () => {
  const sql = fakeRealtimeClient({
    notes: { policy: ownerOnly, types: { id: "bigint", owner: "uuid", list: "integer" } },
    items: { key: "sku" },
  });
  const env = await setUp({ queryTimeoutMs: 1_234 }, sql);
  try {
    const ca = env.hub.conn(env.a);
    assert((await env.hub.subscribe(ca, "notes", { filter: { list: 1 } })).ok);
    env.sql.insert("notes", { id: 1, owner: A, list: 1, body: "in" });
    await until(() => ca.frames.length === 1);
    const { statements, parameters } = env.sql;
    // The column types are read once, by the table's (quoted) name.
    const lookups = statements.flatMap((s, i) => /pg_attribute/.test(s) ? [parameters[i]] : []);
    assertEquals(lookups, [['"notes"']]);
    const seed = statements.find((s) =>
      /^select to_jsonb\(t\."id"\) #>> '\{\}' as k from/.test(s)
    )!;
    assertEquals(
      seed,
      `select to_jsonb(t."id") #>> '{}' as k from "notes" t where t."list" = $2::text::integer limit $1`,
    );
    const reread = statements.findIndex((s) => /to_jsonb\(t\)::text as r/.test(s));
    assertEquals(
      statements[reread],
      `select to_jsonb(t."id") #>> '{}' as k, to_jsonb(t)::text as r from "notes" t where t."id" = ` +
        'any(array(select jsonb_array_elements_text($1::jsonb)::bigint)) and t."list" = $2::text::integer',
    );
    // In its own transaction: the RLS setup, then the timeout, then the re-read.
    assertEquals(statements.slice(reread - 3, reread), [
      "BEGIN",
      RLS_SETUP,
      "select set_config('statement_timeout', $1, true)",
    ]);
    assertEquals(parameters[reread - 1], ["1234"]);
    assertEquals(statements[reread + 1], "COMMIT");
    // A table whose types are unknown (items: none reported) is still compared as text.
    const cb = env.hub.conn(env.b);
    assert((await env.hub.subscribe(cb, "items")).ok);
    env.sql.insert("items", { sku: "x1" });
    await until(() => cb.frames.length === 1);
    assert(
      statements.some((s) =>
        s.includes('where t."sku"::text in (select jsonb_array_elements_text($1::jsonb))')
      ),
    );
  } finally {
    await env.done();
  }
});

Deno.test("realtime: flushes are single-flight — bursts during a slow re-read coalesce into the next", async () => {
  const env = await setUp();
  try {
    const ca = env.hub.conn(env.a);
    await env.hub.subscribe(ca, "notes");
    const engine = realtimeEngine();
    const flushes = engine.stats.flushes;
    env.sql.delay.reread = 120;
    env.sql.insert("notes", { id: 1, owner: A, body: "first" });
    await until(() => env.sql.inFlight.reread === 1, 3_000, "the first re-read");
    env.sql.insert("notes", { id: 2, owner: A, body: "second" });
    await settle(40); // its flush is due while the first still runs
    env.sql.insert("notes", { id: 3, owner: A, body: "third" });
    await until(() => changesOf(ca).length === 3, 5_000, "all three");
    assertEquals(env.sql.inFlight.maxReread, 1, "never two re-reads at once");
    assertEquals(engine.stats.flushes - flushes, 2, "the two later bursts went out together");
    assertEquals(changesOf(ca).map((c) => c.key), ["1", "2", "3"]);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: a malformed notification is ignored; an overflow or keyless one is a resync", async () => {
  const env = await setUp();
  try {
    const ca = env.hub.conn(env.a);
    await env.hub.subscribe(ca, "notes");
    env.sql.notify("not json");
    env.sql.notify(JSON.stringify({ table: "elsewhere", op: "insert", key: "1" }));
    env.sql.notify(JSON.stringify({ table: "notes", op: "truncate", key: "1" }));
    await settle(80);
    assertEquals(ca.frames.length, 0);
    env.sql.notify(JSON.stringify({ table: "notes", op: "insert", overflow: true }));
    await until(() => ca.frames.length === 1);
    assertEquals(ca.frames[0], { seq: 1, resync: true });
  } finally {
    await env.done();
  }
});

Deno.test("realtime: a failed re-read becomes a resync for that group", async () => {
  let fail = false;
  const sql = fakeRealtimeClient({
    notes: {
      policy: (claims, row) => {
        if (fail) throw new Error("permission denied for table notes");
        return ownerOnly(claims, row);
      },
    },
  });
  const env = await setUp({}, sql);
  const original = console.error;
  console.error = () => {};
  try {
    const ca = env.hub.conn(env.a);
    await env.hub.subscribe(ca, "notes");
    fail = true;
    env.sql.insert("notes", { id: 1, owner: A, body: "x" });
    await until(() => ca.frames.length === 1);
    assertEquals(ca.frames[0], { seq: 1, resync: true });
  } finally {
    console.error = original;
    await env.done();
  }
});

Deno.test("realtime(): options are validated; backend() needs postgres for it", () => {
  assertThrows(() => realtime({ tables: {} }), TypeError, "names no table");
  assertThrows(
    () => realtime({ tables: { notes: {} }, maxSubscriptionsPerIdentity: 0 }),
    TypeError,
    "maxSubscriptionsPerIdentity must be a positive integer",
  );
  assertThrows(
    () => realtime({ tables: { notes: {} }, queryTimeoutMs: 1.5 }),
    TypeError,
    "queryTimeoutMs must be a positive integer",
  );
  assertThrows(() => realtime({ tables: { "bad name": {} } }), TypeError, "plain identifier");
  assertThrows(
    () => realtime({ tables: { t: { events: ["upsert" as "insert"] } } }),
    TypeError,
    "unknown event",
  );
  assertThrows(() => realtime({ tables: { t: { events: [] } } }), TypeError, "events");
  assertThrows(() => realtime({ tables: { t: { key: "a-b" } } }), TypeError, "key");
  assertThrows(() => realtime({ tables: { t: { schema: "1x" } } }), TypeError, "schema");
  assertThrows(() => realtime({ tables: { t: {} }, maxSubscribers: 0 }), TypeError);
  assertThrows(
    () => realtime({ tables: { t: {} }, revalidate: { owner: "all" as "one" } }),
    TypeError,
    'revalidate.owner must be "every" or "one"',
  );
  assertThrows(
    () => realtime({ tables: { t: {} }, revalidate: "yes" as unknown as boolean }),
    TypeError,
    "revalidate must be",
  );
  assertThrows(() => backend({ realtime: { tables: { t: {} } } }), TypeError, "needs `postgres`");
  const options = { tables: { t: {} } };
  assertEquals(realtime(options), options);
});

Deno.test("realtimeMigrations: one trigger function, then one trigger per table named by its SQL", () => {
  const migrations = realtimeMigrations({
    tables: { notes: {}, items: { key: "sku", events: ["delete", "insert"], schema: "app" } },
  });
  assertEquals(migrations.length, 3);
  assertEquals(migrations[0].name, "backend_realtime_0001");
  assert(migrations[0].sql.includes("pg_notify('denext_realtime', body)"));
  assert(
    migrations[0].sql.includes("octet_length(body) > 7900"),
    "an oversized key never fails the write",
  );
  assert(!/to_jsonb\(NEW\)\s*[,)]/.test(migrations[0].sql), "keys only, never the row");
  assert(/^backend_realtime_t_notes_[0-9a-f]{8}$/.test(migrations[1].name));
  assert(
    migrations[1].sql.includes(
      `CREATE TRIGGER denext_realtime AFTER INSERT OR UPDATE OR DELETE ON "notes"`,
    ),
  );
  assert(migrations[2].sql.includes(`AFTER INSERT OR DELETE ON "app"."items"`));
  assert(migrations[2].sql.includes("denext_realtime_notify('items', 'sku')"));
  // Another event set is another migration name (it replaces the trigger).
  const changed = realtimeMigrations({ tables: { notes: { events: ["insert"] } } });
  assert(changed[1].name !== migrations[1].name);
  const sql = realtimeSetupSql({ tables: { notes: {} } });
  assert(sql.startsWith("-- @denext/backend realtime"));
  assert(sql.includes("CREATE OR REPLACE FUNCTION denext_realtime_notify()"));
});

Deno.test("realtime: with migrate on, the triggers are installed before the first LISTEN", async () => {
  const env = await setUp({ migrate: true });
  try {
    await realtimeEngine().start();
    const statements = env.sql.statements;
    const fn = statements.findIndex((s) =>
      s.includes("CREATE OR REPLACE FUNCTION denext_realtime_notify")
    );
    const listen = statements.findIndex((s) => s.startsWith("LISTEN"));
    assert(fn >= 0 && listen > fn, "migration first");
    assert(
      statements.some((s) =>
        s.includes(`CREATE TRIGGER denext_realtime AFTER INSERT OR UPDATE OR DELETE ON "notes"`)
      ),
    );
  } finally {
    await env.done();
  }
});

Deno.test("realtime keys, filters and notifications parse strictly", () => {
  const nonce = newNonce();
  assert(/^[A-Za-z0-9_-]{22}$/.test(nonce));
  const key = encodeSubscriptionKey({
    table: "notes",
    nonce,
    filter: { column: "tag", value: "a|b c" },
  });
  assertEquals(decodeSubscriptionKey(key), {
    table: "notes",
    nonce,
    filter: { column: "tag", value: "a|b c" },
  });
  assertEquals(decodeSubscriptionKey(`notes|${nonce}`), { table: "notes", nonce });
  assertEquals(decodeSubscriptionKey(`notes|${nonce}|bad col|x`), null);
  assertEquals(decodeSubscriptionKey(`notes|${nonce}|c|%E0%A4%A`), null);
  assertEquals(decodeSubscriptionKey("x".repeat(200)), null);
  assertThrows(
    () =>
      encodeSubscriptionKey({
        table: "notes",
        nonce,
        filter: { column: "c", value: "v".repeat(120) },
      }),
    RangeError,
  );
  assertEquals(parseFilter(undefined), undefined);
  assertEquals(parseFilter({ done: false }), { column: "done", value: "false" });
  assertThrows(() => parseFilter({ a: 1, b: 2 }), TypeError, "one column");
  assertThrows(() => parseFilter({ "a;drop": 1 }), TypeError, "plain column");
  assertThrows(() => parseFilter({ a: {} as unknown as string }), TypeError, "string, number");
  assertThrows(() => parseFilter("a=gt.1"), TypeError, "column=eq.value");

  assertEquals(
    parseNotification(JSON.stringify({ table: "t", op: "update", key: "2", old_key: "1", ts: 5 })),
    {
      table: "t",
      op: "update",
      key: "2",
      oldKey: "1",
      ts: 5,
    },
  );
  assertEquals(parseNotification(JSON.stringify({ table: "t", op: "delete", key: null })), {
    table: "t",
    op: "resync",
  });
  assertEquals(parseNotification("[1]"), null);
  assertEquals(parseNotification("x".repeat(9_000)), null);
});

Deno.test("realtime frames: split by size, truncate an oversized row, halve on refusal", () => {
  const big = { op: "insert" as const, key: "1", row: { body: "x".repeat(13_000) } };
  const small = (i: number) => ({
    op: "update" as const,
    key: String(i),
    row: { body: "y".repeat(5_000) },
  });
  const frames = toFrames([small(1), small(2), small(3), big, { op: "delete", key: "9" }]);
  assertEquals(frames.map((f) => f.changes!.length), [2, 3]);
  assertEquals(frames[1].changes![1], { op: "insert", key: "1", truncated: true });
  assertEquals(
    splitFrame({ seq: 3, changes: [small(1), small(2), small(3)] }).map((f) => f.changes!.length),
    [2, 1],
  );
  assertEquals(splitFrame({ seq: 3, changes: [small(1)] }), [{
    seq: 0,
    changes: [{ op: "update", key: "1", truncated: true }],
  }]);
  assertEquals(splitFrame({ seq: 3, changes: [{ op: "delete", key: "1" }] }), [{
    seq: 0,
    resync: true,
  }]);
});
