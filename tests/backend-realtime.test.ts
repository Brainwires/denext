// `@denext/backend` realtime against the fake client and the real Live channel hub (driven
// without a socket): per-subscriber authorization by re-reading AS the subscriber, deletes only
// to subscribers who could see the row, filters, coalescing of a burst into one re-read per
// identity, frame splitting under the channel's payload cap, key binding to one identity, the
// reconnect resync, the service hook and revalidation, the server-side subscription, the
// unsupported path, and the root context. What only a real server shows (policies in SQL,
// NOTIFY at commit, a terminated listener reconnecting) is in
// tests/backend-realtime-integration.test.ts.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../packages/auth/src/mod.ts";
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
  dropTriggersSql,
  publicationTable,
  resolveRealtime,
  triggerArgs,
} from "../packages/backend/src/realtime-sql.ts";
import {
  grantOf,
  identityOf,
  installRealtime,
  journaled,
  parseNotification,
  RAW_FRAME_BYTES,
  realtimeEngine,
  rereadQuery,
  REVALIDATE_OWNER_SQL,
  seedQuery,
  splitFrame,
  toFrames,
} from "../packages/backend/src/realtime.ts";
import type { SqlClient } from "../src/server/postgres.ts";
import {
  decodeSubscriptionKey,
  encodeSubscriptionKey,
  formatFilter,
  newNonce,
  parseFilter,
  type TableChange,
} from "../packages/backend/src/realtime-shared.ts";
import { type FakeRealtimeClient, fakeRealtimeClient } from "./helpers/fake-realtime-client.ts";
import { begin, insert, relation } from "./helpers/pgoutput.ts";
import { LogicalSource } from "../packages/backend/src/realtime-logical.ts";
import { ChangeJournal } from "../packages/backend/src/realtime-journal.ts";
import { parseCidr } from "../src/server/remote-addr.ts";
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

/** A loopback reverse proxy, listed as the trusted source of the app's limit header. */
const LOOPBACK_PROXY = [parseCidr("127.0.0.0/8")!, parseCidr("::1")!];
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
    // Every notification is in (the fake delivers them synchronously): deliver the burst now
    // instead of racing the 16 ms timer and a wall-clock deadline on a loaded machine. The
    // counts below still prove the burst was one flush with one re-read per identity.
    await engine.flush();
    // Wait for the condition itself: a loaded Windows runner took more than a minute to deliver
    // the burst. The cap only keeps a lost frame from waiting out the test's own deadline, and the
    // error says how far each subscription got.
    const counts = () =>
      `250 changes per subscription: ca ${changesOf(ca).length}, ca2 ${changesOf(ca2).length}, ` +
      `cb ${changesOf(cb).length} (flushes ${engine.stats.flushes - before.flushes}, rereads ` +
      `${engine.stats.rereads - before.rereads})`;
    await until(
      () =>
        changesOf(ca).length === 250 && changesOf(cb).length === 250 &&
        changesOf(ca2).length === 250,
      300_000,
      counts,
    );
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

Deno.test("realtime: frames sent while a re-authorization runs all arrive, in order", async () => {
  // The Live hub re-authorizes a subscription when its TTL has run out and holds its frames
  // meanwhile. It kept only the latest one, so a burst re-read during a slow re-authorization (a
  // loaded server) lost whole frames of changes: 180 of 250 arrived, and the rest never came.
  const env = await setUp();
  try {
    const ca = env.hub.conn(env.a);
    await env.hub.subscribe(ca, "notes");
    const engine = realtimeEngine();
    const before = engine.stats.frames;
    const release = env.hub.holdAuth();
    ca.channelSubs.get("s1")!.authExpires = 0; // the TTL ran out
    for (let i = 1; i <= 250; i++) {
      env.sql.insert("notes", { id: i, owner: A, body: `note ${i} ${"x".repeat(60)}` });
    }
    await engine.flush();
    // Every frame of the burst has gone to the hub while the re-authorization is still held.
    await until(() => engine.stats.frames - before >= 4, 30_000, "the burst's frames sent");
    await settle();
    assertEquals(changesOf(ca).length, 0, "held until the re-authorization answers");
    release();
    await until(
      () => changesOf(ca).length === 250,
      30_000,
      () => `250 changes, got ${changesOf(ca).length} in ${ca.frames.length} frames`,
    );
    assertEquals(changesOf(ca).map((c) => Number(c.key)), [...Array(250)].map((_, i) => i + 1));
    assertEquals(ca.frames.map((f) => f.seq), ca.frames.map((_, i) => i + 1));
    assertEquals(ca.errors, []);
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

Deno.test("realtime: an idle subscription costs no re-read, is replayed on its return, and a re-listen resyncs", async () => {
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
    await until(() => back.frames.length === 2);
    assertEquals(back.frames[0], { seq: 1, resumed: true });
    assertEquals(back.frames[1].changes?.map((c) => c.key), ["1"], "replayed once it is back");
    assertEquals(engine.stats.rereads, rereads + 1);
    env.sql.reconnect(); // the listening connection was lost and is back
    await until(() => back.frames.length === 3);
    assertEquals(back.frames[2], { seq: 3, resync: true });

    env.sql.insert("notes", { id: 2, owner: A, body: "after" });
    await until(() => back.frames.length === 4);
    assertEquals(back.frames[3].changes?.[0].key, "2");
    // An unsubscribe ends it: nothing more is sent, and it is forgotten at once.
    env.hub.unsubscribe(back);
    assertEquals(engine.size, 0);
    env.sql.insert("notes", { id: 3, owner: A, body: "gone" });
    await settle(120);
    assertEquals(back.frames.length, 4);
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

Deno.test("realtime: a failed owner check gives the lock up before its connection goes back to the pool", async () => {
  const sql = fakeRealtimeClient({ notes: { policy: ownerOnly }, items: { key: "sku" } });
  const log: string[] = [];
  let owner: boolean | Error = true;
  sql.reserve = lockConnection(log, () => owner);
  const env = await setUp({ revalidate: { owner: "one" } }, sql);
  try {
    const engine = realtimeEngine();
    await engine.start();
    env.sql.insert("notes", { id: 1, owner: A, body: "x" });
    await until(() => engine.stats.revalidations === 1, 2_000, "the owner's revalidation");
    // The check fails while the session lives (a statement timeout, a cancel): the session may
    // still hold the lock, and a pooled connection must never carry it to its next borrower.
    owner = new Error("canceling statement due to statement timeout");
    env.sql.insert("notes", { id: 2, owner: A, body: "y" });
    await until(() => log.includes("release"), 2_000, "the connection returned");
    assertEquals(log.slice(-2), ["select pg_advisory_unlock_all()", "release"]);
    // Once stopped, a late burst reserves nothing (no connection left out of the pool).
    await engine.stop();
    const reserves = log.filter((l) => l === "reserve").length;
    env.sql.insert("notes", { id: 3, owner: A, body: "z" });
    await settle(60);
    assertEquals(log.filter((l) => l === "reserve").length, reserves);
  } finally {
    await env.done();
  }
});

Deno.test("realtime source logical: a failed read drops its slot and resets the session before the connection goes back", async () => {
  const conns: string[][] = [];
  let failNext = true;
  const answer = (rows: unknown[]) => {
    const p = Promise.resolve(rows);
    return { then: p.then.bind(p), simple: () => p };
  };
  const client = {
    reserve: () => {
      const log: string[] = [];
      conns.push(log);
      return Promise.resolve({
        unsafe: (text: string) => {
          log.push(text);
          if (text === "show wal_level") return answer([{ wal_level: "logical" }]);
          if (text.includes("pg_logical_slot_get_binary_changes") && failNext) {
            failNext = false;
            // The session is alive: the error is the statement's (a decode, a timeout).
            return Promise.reject(new Error("canceling statement due to statement timeout"));
          }
          return answer([]);
        },
        release: () => void log.push("release"),
      });
    },
  } as unknown as SqlClient;
  const error = console.error;
  console.error = () => {};
  const source = new LogicalSource({
    client: () => client,
    publications: () => ["p"],
    tableOf: () => null,
    emit: () => {},
    resync: () => {},
    pollMs: 5,
    maxChanges: 10,
  });
  try {
    await source.start();
    await until(() => conns.length === 2 && conns[1].some((s) => s.includes("get_binary")));
    const first = conns[0];
    const released = first.indexOf("release");
    assert(released > 0, "the first connection was returned");
    const drop = first.findIndex((s) => s.includes("pg_drop_replication_slot"));
    const reset = first.indexOf("reset TimeZone");
    assert(drop >= 0 && drop < released, "its temporary slot dropped before it went back");
    assert(reset >= 0 && reset < released, "its session TimeZone reset before it went back");
  } finally {
    await source.stop();
    console.error = error;
  }
  const second = conns[1];
  assert(second.indexOf("reset TimeZone") < second.indexOf("release"), "stop() resets it too");
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

Deno.test("realtime: signed out over IPv6, the quota is per /64 — rotating within it buys none", async () => {
  const env = await setUp({ maxSubscriptionsPerIdentity: 2 });
  try {
    // One client's /64 allocation: any host half, and any spelling of the prefix, is one quota.
    const inPrefix = ["2001:db8:1:2::a", "2001:db8:1:2:ffff::1", "2001:0DB8:0001:0002:0:0:0:b"];
    const [c1, c2, c3] = inPrefix.map((ip) => env.hub.conn("", ip));
    assert((await env.hub.subscribe(c1, "notes", { subId: "1" })).ok);
    assert((await env.hub.subscribe(c2, "notes", { subId: "2" })).ok);
    assertEquals((await env.hub.subscribe(c3, "notes", { subId: "3" })).ok, false);
    assertEquals(c3.errors, ["deny"]);
    // The neighbouring /64 is another client.
    assert((await env.hub.subscribe(env.hub.conn("", "2001:db8:1:3::a"), "notes")).ok);
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

Deno.test("realtime: signed out, the app's rateLimitHeader / rateLimitLocalAddresses key the quota as the Live hub does", async () => {
  const env = await setUp({ maxSubscriptionsPerIdentity: 1 });
  try {
    // Behind a loopback proxy that names each client: the quota is that client's (an IPv6 one's
    // /64, an IPv4-mapped one's IPv4), shared across its tabs.
    const named = (client: string) =>
      env.hub.conn("", "127.0.0.1", {
        headers: { "cf-connecting-ip": client },
        policy: { header: "cf-connecting-ip", trustedProxies: LOOPBACK_PROXY },
      });
    for (
      const [first, second] of [
        ["198.51.100.60", "198.51.100.60"],
        ["2001:db8:7:8::1", "2001:db8:7:8::2"],
        ["::ffff:198.51.100.61", "198.51.100.61"],
      ]
    ) {
      assert((await env.hub.subscribe(named(first), "notes", { subId: "1" })).ok, first);
      assertEquals((await env.hub.subscribe(named(second), "notes", { subId: "2" })).ok, false);
    }
    // A LAN client counted by its own private address: two tabs share one quota.
    const lan = () => env.hub.conn("", "10.1.2.3", { policy: { localAddresses: true } });
    assert((await env.hub.subscribe(lan(), "notes", { subId: "1" })).ok);
    assertEquals((await env.hub.subscribe(lan(), "notes", { subId: "2" })).ok, false);
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
    // 32, then 8 a second. The clock is held still, so a slow host's loop refills nothing.
    const anon = env.hub.conn();
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const burst = async (n: number) => {
        let admitted = 0;
        for (let i = 0; i < n; i++) {
          if ((await env.hub.subscribe(anon, "notes")).ok) admitted++;
          env.hub.unsubscribe(anon);
        }
        return admitted;
      };
      assertEquals(await burst(48), 32);
      assertEquals((await env.hub.subscribe(anon, "notes")).ok, false);
      clock += 1000;
      assertEquals(await burst(12), 8, "a second refills eight");
      assert((await env.hub.subscribe(env.hub.conn(), "notes")).ok, "another connection's budget");
    } finally {
      Date.now = realNow;
    }
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
    const lookups = statements.flatMap((s, i) =>
      /from pg_attribute a .*where a\.attrelid/s.test(s) ? [parameters[i]] : []
    );
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
    env.sql.notify(JSON.stringify({ table: "notes", op: "upsert", key: "1" }));
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
  assertThrows(() => realtime({ tables: {}, publication: false }), TypeError, "names no table");
  // With the publication (the default) the tables may all come from it.
  assertEquals(realtime({}).tables, undefined);
  assertThrows(() => realtime({ publication: "bad name" }), TypeError, "publication");
  assertThrows(
    () => realtime({ source: "wal" as "logical" }),
    TypeError,
    'source must be "notify" or "logical"',
  );
  assertThrows(() => realtime({ logical: { pollMs: 0 } }), TypeError, "logical.pollMs");
  assertThrows(() => realtime({ logical: { maxChanges: 1.5 } }), TypeError, "logical.maxChanges");
  const resolved = resolveRealtime({ source: "logical", publication: "pub_x" });
  assertEquals(
    [resolved.source, resolved.publication, resolved.logical],
    ["logical", "pub_x", { pollMs: 50, maxChanges: 10_000 }],
  );
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

Deno.test("realtimeMigrations: the trigger function (then its UTC-key replacement), then one trigger per table named by its SQL", () => {
  const all = realtimeMigrations({
    tables: { notes: {}, items: { key: "sku", events: ["delete", "insert"], schema: "app" } },
  });
  assertEquals(all.map((m) => m.name).slice(0, 7), [
    "backend_realtime_0001",
    "backend_realtime_0002",
    "backend_realtime_0003",
    "backend_realtime_0004",
    "backend_realtime_0005",
    "backend_realtime_0006",
    "backend_realtime_pub_supabase_realtime",
  ]);
  // 0006: send() with the stored message's id inline; the publication, created if absent.
  assert(all[5].sql.includes("'id', message_id"));
  assert(all[5].sql.includes("messages_topic_idx"));
  assert(all[6].sql.includes("CREATE PUBLICATION supabase_realtime"));
  assert(all[6].sql.includes("WHEN insufficient_privilege"));
  // Without the publication, the order the rest of this test indexes into.
  const migrations = realtimeMigrations({
    tables: { notes: {}, items: { key: "sku", events: ["delete", "insert"], schema: "app" } },
    publication: false,
  }).filter((m) => m.name !== "backend_realtime_0006");
  assertEquals(migrations.length, 7);
  for (const fn of migrations.slice(0, 3)) {
    assert(fn.sql.startsWith("CREATE OR REPLACE FUNCTION denext_realtime_notify()"));
    assert(fn.sql.includes("pg_notify('denext_realtime', body)"));
    assert(fn.sql.includes("octet_length(body) > 7900"), "an oversized key never fails the write");
    assert(!/to_jsonb\(NEW\)\s*[,)]/.test(fn.sql), "keys only, never the new row");
  }
  // 0002 spells a timestamptz key in UTC, the column's type read from the catalog.
  assert(migrations[1].sql.includes("'pg_catalog.timestamptz'::pg_catalog.regtype"));
  assert(migrations[1].sql.includes("new_key::timestamptz AT TIME ZONE 'UTC'"));
  // 0003 carries the old row only for a table that asks (its third argument), and TRUNCATE.
  assert(migrations[2].sql.includes("TG_NARGS > 2 AND TG_ARGV[2] = 'full'"));
  assert(migrations[2].sql.includes("'old_overflow', true"));
  assert(migrations[2].sql.includes("CREATE OR REPLACE FUNCTION denext_realtime_truncate()"));
  // 0004: Supabase's realtime schema surface; 0005: the shared presence tables.
  assert(migrations[3].sql.includes("CREATE TABLE IF NOT EXISTS realtime.messages"));
  assert(migrations[3].sql.includes("ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY"));
  assert(migrations[3].sql.includes("FUNCTION realtime.send("));
  assert(migrations[3].sql.includes("FUNCTION realtime.broadcast_changes("));
  assert(migrations[3].sql.includes("FUNCTION realtime.topic()"));
  assert(migrations[4].sql.includes("realtime.denext_presences"));
  assert(/^backend_realtime_t_notes_[0-9a-f]{8}$/.test(migrations[5].name));
  assert(
    migrations[5].sql.includes(
      `CREATE TRIGGER denext_realtime AFTER INSERT OR UPDATE OR DELETE ON "notes"`,
    ),
  );
  assert(migrations[5].sql.includes(`AFTER TRUNCATE ON "notes"`));
  assert(migrations[6].sql.includes(`AFTER INSERT OR DELETE ON "app"."items"`));
  assert(migrations[6].sql.includes("denext_realtime_notify('items', 'sku')"));
  assert(!migrations[6].sql.includes("CREATE TRIGGER denext_realtime_truncate"));
  // Another event set is another migration name (it replaces the trigger); so is `old`.
  const noPub = { publication: false as const };
  const changed = realtimeMigrations({ tables: { notes: { events: ["insert"] } }, ...noPub })
    .filter((m) => m.name !== "backend_realtime_0006");
  assert(changed[5].name !== migrations[5].name);
  const full = realtimeMigrations({ tables: { notes: { old: "full" } }, ...noPub })
    .filter((m) => m.name !== "backend_realtime_0006");
  assert(full[5].name !== migrations[5].name);
  assert(full[5].sql.includes("denext_realtime_notify('notes', 'id', 'full')"));
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
  assertThrows(() => parseFilter({ a: {} as unknown as string }), TypeError, "one operator");
  assertThrows(() => parseFilter({ a: [1] as unknown as string }), TypeError, "string, number");
  assertThrows(() => parseFilter("a=like.1"), TypeError, "column=op.value");
  assertEquals(parseFilter("a=gt.1"), { column: "a", op: "gt", value: "1" });
  assertEquals(parseFilter({ a: { lte: 3 } }), { column: "a", op: "lte", value: "3" });
  assertEquals(parseFilter('s=in.(x,"y,z",w)'), {
    column: "s",
    op: "in",
    value: '["x","y,z","w"]',
    values: ["x", "y,z", "w"],
  });
  assertEquals(parseFilter({ s: { in: ["x", 2] } })?.values, ["x", "2"]);
  assertThrows(() => parseFilter({ a: { gt: 1, lt: 2 } }), TypeError, "one operator");
  assertThrows(() => parseFilter({ a: { gt: [1, 2] } }), TypeError, "one value");
  assertThrows(() => parseFilter("a=in.1"), TypeError, "a list");
  assertThrows(
    () => parseFilter({ a: { in: [...Array(101).keys()] } }),
    TypeError,
    "1 to 100",
  );
  const gtKey = encodeSubscriptionKey({ table: "notes", nonce, filter: parseFilter("n=gte.5") });
  assertEquals(decodeSubscriptionKey(gtKey)?.filter, { column: "n", op: "gte", value: "5" });
  const inKey = encodeSubscriptionKey({ table: "notes", nonce, filter: parseFilter("n=in.(1,2)") });
  assertEquals(decodeSubscriptionKey(inKey)?.filter?.values, ["1", "2"]);
  assertEquals(decodeSubscriptionKey(`notes|${nonce}|n|eq|1`), null, "eq has the short form");
  assertEquals(decodeSubscriptionKey(`notes|${nonce}|n|like|1`), null);
  assertEquals(decodeSubscriptionKey(`notes|${nonce}|n|in|%5B1%5D`), null, "in lists strings");
  assertEquals(formatFilter(parseFilter('s=in.(a,"b\\"c")')!), 's=in.("a","b\\"c")');
  assertEquals(formatFilter(parseFilter("n=neq.4")!), "n=neq.4");
  assertEquals(
    parseNotification(JSON.stringify({ table: "t", op: "truncate", ts: 9 })),
    { table: "t", op: "truncate", ts: 9 },
  );
  assertEquals(
    parseNotification(JSON.stringify({ table: "t", op: "delete", key: "1", old: { id: 1 } })),
    { table: "t", op: "delete", key: "1", old: { id: 1 } },
  );
  assertEquals(
    parseNotification(JSON.stringify({ table: "t", op: "delete", key: "1", old_overflow: true })),
    { table: "t", op: "delete", key: "1", oldOverflow: true },
  );

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

Deno.test("realtime: a timestamptz key is spelled in UTC by the re-read and the seed; other types as JSON", () => {
  const { tables } = resolveRealtime({ tables: { stamps: { key: "at" } } });
  const table = tables.get("stamps")!;
  const tz = new Map([["at", "timestamp with time zone"]]);
  const utc = `to_jsonb(t."at" AT TIME ZONE 'UTC') #>> '{}' as k`;
  assert(
    rereadQuery(table, undefined, ["2026-01-02T01:04:05.5"], tz).text.startsWith(`select ${utc}, `),
  );
  assertEquals(seedQuery(table, undefined, 10, tz).text, `select ${utc} from "stamps" t limit $1`);
  // The index-served match is unchanged: the column against keys cast to its own type.
  assert(
    rereadQuery(table, undefined, [], tz).text.includes(
      `t."at" = any(array(select jsonb_array_elements_text($1::jsonb)::timestamp with time zone))`,
    ),
  );
  const plain = new Map([["at", "timestamp without time zone"]]);
  assertEquals(
    seedQuery(table, undefined, 10, plain).text,
    `select to_jsonb(t."at") #>> '{}' as k from "stamps" t limit $1`,
  );
});

// ── Raw mode (Supabase postgres_changes), truncate, old rows, operators ─────

const rawScope = (sub: string) => ({
  role: "authenticated" as const,
  claims: JSON.stringify({ sub, role: "authenticated" }),
});
const ALL_EVENTS = new Set(["insert", "update", "delete", "truncate"] as const);

Deno.test("realtime raw mode: the database's operations, under the subscriber's policies", async () => {
  const sql = fakeRealtimeClient({
    notes: {
      policy: ownerOnly,
      types: { id: "bigint", owner: "uuid" },
      udts: { id: "int8", owner: "uuid" },
    },
    items: { key: "sku" },
  });
  const env = await setUp({}, sql);
  try {
    const engine = realtimeEngine();
    const notes = engine.table("notes");
    assertEquals(await engine.columns(notes), [
      { name: "id", type: "int8" },
      { name: "owner", type: "uuid" },
    ]);
    const frames: TableChangesFrame[] = [];
    const inserts: TableChangesFrame[] = [];
    const binding = (await engine.bind({
      table: notes,
      scope: rawScope(A),
      owner: `authenticated:${A}`,
      events: ALL_EVENTS,
      onFrame: (frame) => frames.push(frame),
    }))!;
    await engine.bind({
      table: notes,
      scope: rawScope(A),
      owner: `authenticated:${A}`,
      events: new Set(["insert"]),
      onFrame: (frame) => inserts.push(frame),
    });
    const all = () => frames.flatMap((f) => f.changes ?? []);
    env.sql.insert("notes", { id: 1, owner: A, body: "mine" });
    env.sql.insert("notes", { id: 2, owner: B, body: "theirs" });
    await until(() => all().length === 1);
    assertEquals(all()[0].op, "insert");
    assert(typeof (all()[0] as { ts?: number }).ts === "number");
    // B's row handed to A: an UPDATE (what the database ran), not an insert.
    env.sql.update("notes", "2", { owner: A });
    await until(() => all().length === 2, 3_000, `2 changes: ${JSON.stringify(all())}`);
    assertEquals([all()[1].op, all()[1].key], ["update", "2"]);
    // Handed back: silent (A cannot see it now), and its delete is not sent either.
    env.sql.update("notes", "2", { owner: B });
    await settle(80);
    env.sql.remove("notes", "2");
    await settle(80);
    // A's own delete, with the old row the trigger carried.
    env.sql.tables.get("notes")!.delete("1");
    env.sql.notify(
      JSON.stringify({ table: "notes", op: "delete", key: "1", old: { id: 1, owner: A }, ts: 7 }),
    );
    await until(() => all().length === 3, 3_000, `3 changes: ${JSON.stringify(all())}`);
    await settle(80);
    assertEquals(all()[2] as unknown, { op: "delete", key: "1", ts: 7, old: { id: 1, owner: A } });
    assertEquals(inserts.flatMap((f) => f.changes ?? []).map((c) => c.op), ["insert"], "events");
    // An update whose old row did not fit.
    env.sql.insert("notes", { id: 3, owner: A, body: "x" });
    await until(() => all().length === 4, 3_000, `4 changes: ${JSON.stringify(all())}`);
    env.sql.tables.get("notes")!.set("3", { id: 3, owner: A, body: "y" });
    env.sql.notify(JSON.stringify({ table: "notes", op: "update", key: "3", old_overflow: true }));
    await until(() => all().length === 5, 3_000, `5 changes: ${JSON.stringify(all())}`);
    assertEquals((all()[4] as { oldOverflow?: true }).oldOverflow, true);
    // Rescope: the same identity only.
    assertEquals(binding.rescope(rawScope(A)), true);
    assertEquals(binding.rescope(rawScope(B)), false);
    binding.stop();
    env.sql.insert("notes", { id: 4, owner: A, body: "z" });
    await settle(120);
    assertEquals(all().length, 5);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: truncate reaches the subscribers who could see rows; old rows on view changes", async () => {
  const env = await setUp();
  try {
    const engine = realtimeEngine();
    const raw: TableChangesFrame[] = [];
    const empty: TableChangesFrame[] = [];
    await engine.bind({
      table: engine.table("notes"),
      scope: rawScope(A),
      owner: "x",
      events: ALL_EVENTS,
      onFrame: (frame) => raw.push(frame),
    });
    await engine.bind({
      table: engine.table("notes"),
      scope: rawScope(B),
      owner: "y",
      events: ALL_EVENTS,
      onFrame: (frame) => empty.push(frame),
    });
    const ca = env.hub.conn(env.a);
    assert((await env.hub.subscribe(ca, "notes")).ok);
    env.sql.insert("notes", { id: 1, owner: A, body: "a" });
    await until(() => raw.length === 1 && ca.frames.length === 1);
    // A view-mode update carries the old row.
    env.sql.tables.get("notes")!.set("1", { id: 1, owner: A, body: "b" });
    env.sql.notify(
      JSON.stringify({ table: "notes", op: "update", key: "1", old: { id: 1, body: "a" } }),
    );
    await until(() => ca.frames.length === 2);
    assertEquals((changesOf(ca)[1] as { old?: unknown }).old, { id: 1, body: "a" });
    // A pending change before the truncate is moot; one after it follows it.
    env.sql.insert("notes", { id: 2, owner: A, body: "gone" });
    env.sql.notify(JSON.stringify({ table: "notes", op: "truncate", ts: 9 }));
    env.sql.tables.get("notes")!.clear();
    await until(() => raw.length === 3 && ca.frames.length === 3);
    assertEquals(raw[2].changes, [{ op: "truncate", ts: 9 } as never]);
    assertEquals(changesOf(ca).at(-1), { op: "truncate" });
    assertEquals(empty.length, 0, "B saw no rows: nothing to clear");
    // After the truncate the view starts empty: a delete of an old key is not sent.
    env.sql.notify(JSON.stringify({ table: "notes", op: "delete", key: "1", old: { id: 1 } }));
    await settle(80);
    assertEquals(ca.frames.length, 3);
    // A view delete carries the old row.
    env.sql.insert("notes", { id: 5, owner: A, body: "e" });
    await until(() => ca.frames.length === 4);
    env.sql.tables.get("notes")!.delete("5");
    env.sql.notify(
      JSON.stringify({ table: "notes", op: "delete", key: "5", old: { id: 5, body: "e" } }),
    );
    await until(() => ca.frames.length === 5);
    assertEquals(changesOf(ca).at(-1), { op: "delete", key: "5", old: { id: 5, body: "e" } });
  } finally {
    await env.done();
  }
});

Deno.test("realtime: a change of a kind the table does not send is dropped, whatever the source", async () => {
  const env = await setUp();
  try {
    const engine = realtimeEngine();
    const ca = env.hub.conn(env.a);
    assert((await env.hub.subscribe(ca, "items")).ok);
    env.sql.insert("items", { sku: "a", label: "x" });
    await until(() => ca.frames.length === 1);
    // What the logical source decodes from the WAL, for `items` (events: insert, delete): its
    // update and its TRUNCATE are not sent, as its triggers would not have fired for them.
    env.sql.tables.get("items")!.set("a", { sku: "a", label: "y" });
    engine.ingest({ table: "items", op: "update", key: "a" });
    engine.ingest({ table: "items", op: "truncate", ts: 1 });
    await settle(80);
    assertEquals(ca.frames.length, 1);
    env.sql.tables.get("items")!.delete("a");
    engine.ingest({ table: "items", op: "delete", key: "a" });
    await until(() => ca.frames.length === 2);
    assertEquals(changesOf(ca).at(-1), { op: "delete", key: "a" });
  } finally {
    await env.done();
  }
});

Deno.test("realtime: operator filters narrow the re-read; a raw row over 1 MiB is truncated", async () => {
  const env = await setUp();
  try {
    const engine = realtimeEngine();
    const seen = new Map<string, string[]>();
    for (const filter of ["list=neq.1", "list=lt.3", "list=gte.3", "list=in.(1,4)"]) {
      seen.set(filter, []);
      await engine.bind({
        table: engine.table("notes"),
        filter: parseFilter(filter),
        scope: rawScope(A),
        owner: "z",
        events: ALL_EVENTS,
        onFrame: (frame) =>
          seen.get(filter)!.push(...(frame.changes ?? []).map((c) => String(c.key))),
      });
    }
    for (let id = 1; id <= 4; id++) env.sql.insert("notes", { id, owner: A, list: id, body: "b" });
    await until(() => seen.get("list=in.(1,4)")!.length === 2);
    await settle(80);
    assertEquals(seen.get("list=neq.1"), ["2", "3", "4"]);
    assertEquals(seen.get("list=lt.3"), ["1", "2"]);
    assertEquals(seen.get("list=gte.3"), ["3", "4"]);
    assertEquals(seen.get("list=in.(1,4)"), ["1", "4"]);
    const big = toFrames(
      [{ op: "insert", key: "9", row: { body: "x".repeat(RAW_FRAME_BYTES) } }],
      RAW_FRAME_BYTES,
    );
    assertEquals(big[0].changes, [{ op: "insert", key: "9", truncated: true }]);
    const update = toFrames([{
      op: "update",
      key: "9",
      row: { b: "x".repeat(200) },
      old: { a: 1 },
    }], 50);
    assertEquals(update[0].changes, [{ op: "update", key: "9", truncated: true }]);
    const del = toFrames([{ op: "delete", key: "9", old: { b: "x".repeat(200) } }], 50);
    assertEquals(del[0].changes, [{ op: "delete", key: "9" }]);
    assertEquals(toFrames([{ op: "truncate" }], 1)[0].changes, [{ op: "truncate" }]);
    assertEquals(splitFrame({ seq: 1, changes: [{ op: "truncate" }] }), [{ seq: 0, resync: true }]);
  } finally {
    await env.done();
  }
});

// ── The supabase_realtime publication, the trigger switch, the logical source, raw steps ────

/** Capture the engine's 10-second publication re-read while `fn` starts it. */
async function captureTick(fn: () => Promise<unknown>): Promise<() => void> {
  const real = globalThis.setInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((handler: () => void, ms?: number) => {
    if (ms === 10_000) tick = handler;
    return real(handler, ms);
  }) as typeof setInterval;
  try {
    await fn();
  } finally {
    globalThis.setInterval = real;
  }
  assert(tick, "the publication re-read is armed");
  return tick;
}

Deno.test({
  name: "realtime publication: its tables join the registry, with triggers, and leave it",
  async fn() {
    const sql = fakeRealtimeClient({
      notes: { policy: ownerOnly },
      items: { key: "sku" },
      pubnotes: {},
      things: {},
    });
    sql.catalog.publication.push(
      { schema: "public", table: "pubnotes", pk: "id", ident: "d", rls: false },
      { schema: "app", table: "things", pk: "id", ident: "f", rls: false },
      { schema: "public", table: "notes", pk: "id", ident: "f", rls: true }, // configured: wins
      { schema: "public", table: "multi", pk: "a,b", ident: "d", rls: false },
      { schema: "public", table: "nopk", pk: null, ident: "d", rls: false },
      { schema: "my-schema", table: "odd", pk: "id", ident: "d", rls: false },
    );
    // pubnotes' triggers are there already, with the same arguments: not recreated.
    sql.catalog.triggers.set(
      "pubnotes",
      new Map([
        ["denext_realtime", { args: "pubnotes\\000id\\000", enabled: "O" }],
        ["denext_realtime_truncate", { args: "pubnotes\\000", enabled: "O" }],
      ]),
    );
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => void warnings.push(String(message));
    const env = await setUp({}, sql);
    try {
      const engine = realtimeEngine();
      const tick = await captureTick(() => engine.start());
      const names = [...engine.config.tables.keys()].sort();
      assertEquals(names, ["app.things", "items", "notes", "pubnotes"]);
      assertEquals(engine.lookup("app.things")?.old, "full", "replica identity full, no RLS");
      assertEquals(engine.lookup("pubnotes")?.old, "key");
      assertEquals(engine.lookup("public.pubnotes")?.name, "pubnotes");
      assertEquals(engine.lookup("things"), undefined, "not in public");
      assertEquals(engine.lookup("notes")?.fromPublication, undefined, "the configured one");
      assertEquals(warnings.length, 3, "multi, nopk, my-schema.odd skipped once each");
      assert(warnings.some((w) => w.includes("one-column primary key")));
      assert(warnings.some((w) => w.includes("plain (unquoted) identifiers")));
      const creates = sql.statements.filter((s) => s.startsWith("CREATE TRIGGER"));
      assertEquals(creates.length, 2, "only app.things' two triggers were made");
      assertEquals(
        sql.catalog.triggers.get("app.things")?.get("denext_realtime")?.args,
        "app.things\\000id\\000full\\000",
      );

      // A subscriber of a publication table, by `schema.table`, and on the server by `schema`.
      const ca = env.hub.conn(env.a);
      assert((await env.hub.subscribe(ca, "app.things")).ok);
      const served: TableChangesFrame[] = [];
      const stop = await tableChanges("things", {
        schema: "app",
        as: { id: A },
        onChange: (frame) => served.push(frame),
      });
      sql.tables.get("things")!.set("1", { id: 1, label: "a" });
      sql.notify(JSON.stringify({ table: "app.things", op: "insert", key: "1", ts: Date.now() }));
      await until(() => ca.frames.length === 1 && served.length === 1);
      assertEquals((changesOf(ca)[0] as { row?: unknown }).row, { id: 1, label: "a" });
      stop();
      await assertRejects(() => tableChanges("nothing", { onChange: () => {} }), TypeError);

      // The next read: things left (triggers dropped), pubnotes became REPLICA IDENTITY FULL.
      sql.catalog.publication.splice(1, 1);
      sql.catalog.publication[0].ident = "f";
      warnings.length = 0;
      tick();
      await until(() => !engine.config.tables.has("app.things"));
      await settle(50);
      assertEquals(warnings, [], "a skipped table is warned about once");
      assertEquals(sql.catalog.triggers.get("app.things")?.size ?? 0, 0);
      assertEquals(engine.lookup("pubnotes")?.old, "full");
      assertEquals(
        sql.catalog.triggers.get("pubnotes")?.get("denext_realtime")?.args,
        "pubnotes\\000id\\000full\\000",
      );
    } finally {
      console.warn = warn;
      await env.done();
    }
  },
});

Deno.test({
  name: "realtime: a key naming a publication table is admitted once the publication is read",
  async fn() {
    const sql = fakeRealtimeClient({
      notes: { policy: ownerOnly },
      items: { key: "sku" },
      late: {},
    });
    sql.catalog.publication.push({
      schema: "public",
      table: "late",
      pk: "id",
      ident: "d",
      rls: false,
    });
    const env = await setUp({}, sql);
    try {
      const ca = env.hub.conn(env.a);
      // Not started yet: authorize() reads the publication first.
      assert((await env.hub.subscribe(ca, "late")).ok);
      assert(!(await env.hub.subscribe(ca, "missing")).ok);
    } finally {
      await env.done();
    }
  },
});

Deno.test({
  name: "realtime: the notify source turns realtime triggers on; the logical one turns them off",
  async fn() {
    const sql = fakeRealtimeClient({ notes: { policy: ownerOnly }, items: { key: "sku" } });
    sql.catalog.triggers.set(
      "notes",
      new Map([["denext_realtime", { args: "notes\\000id\\000", enabled: "D" }]]),
    );
    sql.catalog.triggers.set(
      "unrelated",
      new Map([["denext_realtime", { args: "x\\000id\\000", enabled: "D" }]]),
    );
    const env = await setUp({ publication: false }, sql);
    try {
      await realtimeEngine().start();
      assertEquals(sql.catalog.triggers.get("notes")!.get("denext_realtime")!.enabled, "O");
      assertEquals(
        sql.catalog.triggers.get("unrelated")!.get("denext_realtime")!.enabled,
        "D",
        "not a realtime table of this app",
      );
      assert(sql.statements.includes("ALTER TABLE notes ENABLE TRIGGER denext_realtime"));
    } finally {
      await env.done();
    }
  },
});

/** The advisory lock every boot migration of the backend takes (`backend_migrations`'). */
const MIGRATION_LOCK = 'denext:migrate:"backend_migrations"';

/** Assert the first statement `match` finds ran in a transaction holding the migration lock. */
function assertUnderMigrationLock(sql: FakeRealtimeClient, match: RegExp): void {
  const at = sql.statements.findIndex((s) => match.test(s));
  assert(at >= 0, `${match} was sent`);
  for (let i = at - 1; i >= 0; i--) {
    const s = sql.statements[i];
    if (s === "BEGIN" || s === "COMMIT") break;
    if (/pg_advisory_xact_lock/.test(s) && sql.parameters[i][0] === MIGRATION_LOCK) return;
  }
  throw new Error(`${match} ran outside the backend's migration lock`);
}

Deno.test({
  name: "realtime DDL at startup runs under the backend's migration lock",
  async fn() {
    const sql = fakeRealtimeClient({ notes: { policy: ownerOnly }, items: { key: "sku" } });
    sql.catalog.publication.push({
      schema: "app",
      table: "things",
      pk: "id",
      ident: "d",
      rls: false,
    });
    // A realtime trigger left disabled (by a logical-source run): the notify source enables it.
    sql.catalog.triggers.set(
      "notes",
      new Map([["denext_realtime", { args: "notes\\000id\\000", enabled: "D" }]]),
    );
    const env = await setUp({}, sql);
    try {
      const engine = realtimeEngine();
      const tick = await captureTick(() => engine.start());
      assertUnderMigrationLock(sql, /^DROP TRIGGER IF EXISTS denext_realtime ON "app"."things"/);
      assertUnderMigrationLock(sql, /^CREATE TRIGGER denext_realtime AFTER .* ON "app"."things"/s);
      assertUnderMigrationLock(sql, /^ALTER TABLE notes ENABLE TRIGGER denext_realtime$/);
      // Leaving the publication drops its triggers, under the lock too.
      sql.catalog.publication.length = 0;
      const before = sql.statements.length;
      tick();
      await until(() => !engine.config.tables.has("app.things"));
      await settle(20);
      const after = { ...sql, statements: sql.statements.slice(before) } as FakeRealtimeClient;
      Object.assign(after, { parameters: sql.parameters.slice(before) });
      assertUnderMigrationLock(after, /^DROP TRIGGER IF EXISTS denext_realtime ON "app"."things"/);
    } finally {
      await env.done();
    }
  },
});

/** A reserved connection answering the slot statements, fed from `batches`. */
function fakeSlot(sql: FakeRealtimeClient, batches: Uint8Array[][]) {
  const statements: string[] = [];
  const answer = (rows: unknown[]) => {
    const p = Promise.resolve(rows);
    return { then: p.then.bind(p), simple: () => p };
  };
  (sql as unknown as { reserve: () => Promise<unknown> }).reserve = () =>
    Promise.resolve({
      unsafe: (text: string) => {
        statements.push(text);
        if (text === "show wal_level") return answer([{ wal_level: "logical" }]);
        if (text.includes("pg_logical_slot_get_binary_changes")) {
          return answer((batches.shift() ?? []).map((data) => ({ data })));
        }
        return answer([]);
      },
      release: () => {},
    });
  return statements;
}

Deno.test({
  name:
    "realtime source logical: no trigger migrations, the denext_realtime publication, WAL events",
  async fn() {
    const sql = fakeRealtimeClient({ notes: { policy: ownerOnly }, items: { key: "sku" } });
    sql.catalog.triggers.set(
      "notes",
      new Map([["denext_realtime", { args: "notes\\000id\\000", enabled: "O" }]]),
    );
    const batches: Uint8Array[][] = [];
    const slot = fakeSlot(sql, batches);
    const env = await setUp({ source: "logical", migrate: true, logical: { pollMs: 5 } }, sql);
    try {
      const ca = env.hub.conn(env.a);
      assert((await env.hub.subscribe(ca, "notes")).ok);
      assert(
        !sql.statements.some((s) => s.includes("CREATE TRIGGER denext_realtime AFTER")),
        "the logical source installs no row triggers",
      );
      assert(sql.statements.some((s) => s.includes("CREATE PUBLICATION denext_realtime")));
      assertUnderMigrationLock(sql, /CREATE PUBLICATION denext_realtime/);
      assertUnderMigrationLock(sql, /^ALTER PUBLICATION denext_realtime SET TABLE/);
      assert(
        sql.statements.includes('ALTER PUBLICATION denext_realtime SET TABLE "notes", "items"'),
      );
      assertEquals(sql.catalog.triggers.get("notes")!.get("denext_realtime")!.enabled, "D");
      assert(slot.some((s) => s.includes("pg_create_logical_replication_slot")));
      assert(
        sql.statements.every((s) => !s.startsWith("LISTEN denext_realtime\n")),
        "no NOTIFY listener for changes",
      );
      // A change read from the slot reaches the subscriber, re-read under A's policies.
      sql.tables.get("notes")!.set("7", { id: 7, owner: A, body: "from the WAL" });
      batches.push([
        begin(Date.now()),
        relation(1, "public", "notes", [["id", 20], ["owner", 2950], ["body", 25]]),
        insert(1, ["7", A, "from the WAL"]),
      ]);
      await until(() => ca.frames.length === 1, 5_000);
      assertEquals((changesOf(ca)[0] as { row?: unknown }).row, {
        id: 7,
        owner: A,
        body: "from the WAL",
      });
    } finally {
      await env.done();
    }
    assert(slot.some((s) => s.includes("pg_drop_replication_slot")), "dropped on stop");
  },
});

Deno.test("realtime raw mode: every step of a key in one burst, judged by the row as it is now", async () => {
  const sql = fakeRealtimeClient({
    notes: { policy: ownerOnly },
    items: { key: "sku" },
  });
  const env = await setUp({ publication: false }, sql);
  try {
    const engine = realtimeEngine();
    const frames: TableChangesFrame[] = [];
    await engine.bind({
      table: engine.table("notes"),
      scope: rawScope(A),
      owner: "steps",
      events: ALL_EVENTS,
      onFrame: (frame) => frames.push(frame),
    });
    const ops = () => frames.flatMap((f) => f.changes ?? []).map((c) => `${c.op}:${c.key}`);
    // Inserted and updated in one burst: both reach the subscriber, with the row as it is now.
    sql.insert("notes", { id: 1, owner: A, body: "a" });
    sql.update("notes", "1", { body: "b" });
    await until(() => ops().length === 2);
    assertEquals(ops(), ["insert:1", "update:1"]);
    assertEquals(
      frames.flatMap((f) => f.changes!).map((c) => (c as { row?: { body?: string } }).row?.body),
      [
        "b",
        "b",
      ],
    );
    // Inserted and deleted in one burst: gone before it could be checked — nothing.
    sql.insert("notes", { id: 2, owner: A, body: "x" });
    sql.remove("notes", "2");
    await settle(120);
    assertEquals(ops().length, 2);
    // Deleted and inserted again in one burst: the delete (it was known), then the insert.
    sql.remove("notes", "1");
    sql.insert("notes", { id: 1, owner: A, body: "c" });
    await until(() => ops().length === 4);
    assertEquals(ops().slice(2), ["delete:1", "insert:1"]);
  } finally {
    await env.done();
  }
});

Deno.test("realtime raw mode: an old row reaches only a subscriber who could see the row before", async () => {
  const sql = fakeRealtimeClient({ notes: { policy: ownerOnly } });
  const env = await setUp({ publication: false }, sql);
  try {
    const engine = realtimeEngine();
    const bob: TableChangesFrame[] = [];
    const alice: TableChangesFrame[] = [];
    for (const [sub, frames] of [[B, bob], [A, alice]] as const) {
      await engine.bind({
        table: engine.table("notes"),
        scope: rawScope(sub),
        owner: `authenticated:${sub}`,
        events: ALL_EVENTS,
        onFrame: (frame) => frames.push(frame),
      });
    }
    const changes = (frames: TableChangesFrame[]) =>
      frames.flatMap((f) => f.changes ?? []) as Array<TableChange & { old?: unknown }>;
    const update = (row: Record<string, unknown>, old: Record<string, unknown>) => {
      sql.tables.get("notes")!.set(String(row.id), row);
      sql.notify(JSON.stringify({ table: "notes", op: "update", key: String(row.id), old }));
    };
    // Alice's private row: Alice sees it, Bob does not.
    const draft = { id: 7, owner: A, body: "alice-private-draft" };
    sql.insert("notes", draft);
    await until(() => changes(alice).length === 1);
    // Handed to Bob, the trigger carrying the full old row (`old: "full"`): Bob gets the
    // UPDATE, but never Alice's row as it was — `old_record` is the key alone for him.
    update({ id: 7, owner: B, body: "public" }, draft);
    await until(() => changes(bob).length === 1, 3_000, JSON.stringify(changes(bob)));
    assertEquals(changes(bob)[0].op, "update");
    assertEquals("old" in changes(bob)[0], false, JSON.stringify(changes(bob)[0]));
    // Bob saw it now: his next update carries the row as he saw it.
    const seen = { id: 7, owner: B, body: "public" };
    update({ id: 7, owner: B, body: "v2" }, seen);
    await until(() => changes(bob).length === 2);
    assertEquals(changes(bob)[1].old, seen);
    // Two steps in one burst: the second's old row is an intermediate state (here Alice's,
    // which Bob never saw) — only the first step carries one.
    const secret = { id: 7, owner: A, body: "alice-again" };
    update(secret, { id: 7, owner: B, body: "v2" });
    update({ id: 7, owner: B, body: "v3" }, secret);
    await until(() => changes(bob).length === 4, 3_000, JSON.stringify(changes(bob)));
    assertEquals(changes(bob)[2].old, { id: 7, owner: B, body: "v2" });
    assertEquals("old" in changes(bob)[3], false, JSON.stringify(changes(bob)[3]));
  } finally {
    await env.done();
  }
});

Deno.test("publicationTable / triggerArgs / dropTriggersSql: a catalog row as a realtime table", () => {
  assertEquals(
    publicationTable({ schema: "public", table: "notes", pk: "id", ident: "f", rls: false }),
    {
      name: "notes",
      table: "notes",
      fromPublication: true,
      events: ["insert", "update", "delete", "truncate"],
      key: "id",
      schema: "public",
      qualified: '"public"."notes"',
      old: "full",
    },
  );
  const app = publicationTable({ schema: "app", table: "t", pk: "k", ident: "f", rls: true });
  assert(typeof app !== "string");
  assertEquals([app.name, app.old], ["app.t", "key"], "under RLS the old row is the key");
  assertEquals(triggerArgs(app), ["app.t", "k"]);
  assertEquals(triggerArgs({ ...app, old: "full" }), ["app.t", "k", "full"]);
  assertEquals(
    dropTriggersSql(app),
    'DROP TRIGGER IF EXISTS denext_realtime ON "app"."t";\n' +
      'DROP TRIGGER IF EXISTS denext_realtime_truncate ON "app"."t";',
  );
  assertStringIncludes(
    publicationTable({ schema: "public", table: "x", pk: "a,b", ident: "d", rls: false }) as string,
    "one-column primary key (has 2)",
  );
  assertStringIncludes(
    publicationTable({ schema: "public", table: "x", pk: null, ident: "d", rls: false }) as string,
    "(has none)",
  );
  assertStringIncludes(
    publicationTable({
      schema: "public",
      table: "We ird",
      pk: "id",
      ident: "d",
      rls: false,
    }) as string,
    "plain (unquoted) identifiers",
  );
});

// ── Replay after a reconnect, and fan-out ───────────────────────────────────────────────────

/** Every frame of `conns`, in order, without their `seq`. */
const unnumbered = (frames: TableChangesFrame[]) => frames.map(({ seq: _seq, ...rest }) => rest);

Deno.test("realtime replay: a reconnecting subscriber gets what it missed, re-read under its policies", async () => {
  const env = await setUp();
  try {
    // A could see 7 and 10 when it subscribed (tracked); 8 is B's.
    const notes = env.sql.tables.get("notes")!;
    notes.set("7", { id: 7, owner: A, body: "old" });
    notes.set("8", { id: 8, owner: B, body: "b's" });
    notes.set("10", { id: 10, owner: A, body: "doomed" });
    const ca = env.hub.conn(env.a);
    const cb = env.hub.conn(env.b);
    const { key } = await env.hub.subscribe(ca, "notes");
    await env.hub.subscribe(cb, "notes");
    env.sql.insert("notes", { id: 1, owner: A, body: "before the drop" });
    await until(() => ca.frames.length === 1);
    env.hub.drop(ca); // the socket closed
    const engine = realtimeEngine();
    const rereads = engine.stats.rereads;

    env.sql.insert("notes", { id: 2, owner: A, body: "while away" });
    env.sql.insert("notes", { id: 3, owner: B, body: "b's, while away" });
    env.sql.update("notes", "7", { body: "edited" });
    env.sql.remove("notes", "8"); // B's: never A's to hear about
    env.sql.remove("notes", "10"); // A's: A could see it
    env.sql.insert("notes", { id: 4, owner: A, body: "brief" });
    env.sql.remove("notes", "4"); // came and went: nothing to say
    await engine.flush();
    await until(() => changesOf(cb).length === 2, 3_000, "B's live changes");
    assertEquals(engine.stats.rereads - rereads, 1, "only B's live group re-read while A was away");

    const back = env.hub.conn(env.a);
    assert((await env.hub.subscribe(back, "notes", { key })).ok);
    await until(() => back.frames.length === 2, 3_000, "resumed + replay");
    assertEquals(unnumbered(back.frames), [
      { resumed: true },
      {
        changes: [
          { op: "insert", key: "2", row: { id: 2, owner: A, body: "while away" } },
          { op: "update", key: "7", row: { id: 7, owner: A, body: "edited" } },
          { op: "delete", key: "10" },
        ],
      },
    ]);
    // Numbered on from the frame before the drop: no gap, nothing to re-read.
    assertEquals(back.frames.map((f) => f.seq), [2, 3]);
    assertEquals(engine.stats.replays, 1);

    // Live again afterwards.
    env.sql.insert("notes", { id: 5, owner: A, body: "after" });
    await until(() => back.frames.length === 3);
    assertEquals(back.frames[2].changes?.map((c) => c.key), ["5"]);
    assertEquals(back.frames[2].seq, 4);
  } finally {
    await env.done();
  }
});

Deno.test("realtime replay: a truncate while away clears the subscriber's rows before what followed", async () => {
  const env = await setUp();
  try {
    env.sql.tables.get("notes")!.set("7", { id: 7, owner: A, body: "old" });
    const ca = env.hub.conn(env.a);
    const { key } = await env.hub.subscribe(ca, "notes");
    env.hub.drop(ca);
    env.sql.insert("notes", { id: 1, owner: A, body: "gone with the truncate" });
    env.sql.tables.get("notes")!.clear();
    env.sql.notify(JSON.stringify({ table: "notes", op: "truncate", ts: 1 }));
    env.sql.insert("notes", { id: 2, owner: A, body: "after it" });
    await realtimeEngine().flush();
    const back = env.hub.conn(env.a);
    assert((await env.hub.subscribe(back, "notes", { key })).ok);
    await until(() => back.frames.length === 3, 3_000, "resumed, truncate, insert");
    assertEquals(unnumbered(back.frames), [
      { resumed: true },
      { changes: [{ op: "truncate" }] },
      { changes: [{ op: "insert", key: "2", row: { id: 2, owner: A, body: "after it" } }] },
    ]);
  } finally {
    await env.done();
  }
});

Deno.test("realtime replay: a gap the journal no longer covers, or a lost listener, is an explicit resync", async () => {
  const env = await setUp({ replay: { maxChangesPerTable: 2 } });
  try {
    const engine = realtimeEngine();
    const ca = env.hub.conn(env.a);
    const { key } = await env.hub.subscribe(ca, "notes");
    env.hub.drop(ca);
    for (let i = 1; i <= 3; i++) env.sql.insert("notes", { id: i, owner: A, body: `n${i}` });
    await engine.flush();
    assertEquals(engine.journalSize, 2, "the journal keeps maxChangesPerTable");
    const back = env.hub.conn(env.a);
    assert((await env.hub.subscribe(back, "notes", { key })).ok);
    await until(() => back.frames.length === 1);
    assertEquals(unnumbered(back.frames), [{ resync: true }]);
    // Live from there on.
    env.sql.insert("notes", { id: 9, owner: A, body: "after" });
    await until(() => back.frames.length === 2);
    assertEquals(back.frames[1].changes?.map((c) => c.key), ["9"]);

    // The listening connection lost while the subscriber is away: its changes may be gone.
    env.hub.drop(back);
    env.sql.reconnect();
    await engine.flush();
    const again = env.hub.conn(env.a);
    assert((await env.hub.subscribe(again, "notes", { key })).ok);
    await until(() => again.frames.length === 2, 3_000, "resumed, then the resync");
    assertEquals(unnumbered(again.frames), [{ resumed: true }, { resync: true }]);
  } finally {
    await env.done();
  }
});

Deno.test("realtime replay: off, a reconnect is a resync; on, a disconnected subscription is kept for the retention", async () => {
  const off = await setUp({ replay: false });
  try {
    const ca = off.hub.conn(off.a);
    const { key } = await off.hub.subscribe(ca, "notes");
    off.hub.drop(ca);
    off.sql.insert("notes", { id: 1, owner: A, body: "missed" });
    await realtimeEngine().flush();
    assertEquals(realtimeEngine().journalSize, 0, "no journal");
    const back = off.hub.conn(off.a);
    assert((await off.hub.subscribe(back, "notes", { key })).ok);
    await until(() => back.frames.length === 1);
    assertEquals(unnumbered(back.frames), [{ resync: true }]);
  } finally {
    await off.done();
  }
  assertEquals(resolveRealtime({ tables: { t: {} } }).replay, {
    retentionSeconds: 60,
    maxChangesPerTable: 10_000,
  });
  assertEquals(resolveRealtime({ tables: { t: {} }, replay: false }).replay, null);
  assertThrows(
    () => realtime({ tables: { t: {} }, replay: { retentionSeconds: 0 } }),
    TypeError,
    "replay.retentionSeconds must be a positive integer",
  );
  assertThrows(
    () => realtime({ tables: { t: {} }, replay: "yes" as unknown as boolean }),
    TypeError,
    "replay must be",
  );
});

Deno.test("ChangeJournal: positions across tables, coverage by count and by age, compaction", () => {
  let now = 1_000;
  const journal = new ChangeJournal<{ table: string; n: number }>(10_000, 3, () => now);
  assertEquals([journal.head, journal.covers("a", 0), journal.since("a", 0, 0)], [0, true, []]);
  for (let n = 1; n <= 5; n++) journal.append({ table: n % 2 ? "a" : "b", n });
  // a: 1, 3, 5; b: 2, 4.
  assertEquals(journal.since("a", 0, 5)?.map((e) => e.event.n), [1, 3, 5]);
  assertEquals(journal.since("a", 1, 3)?.map((e) => e.pos), [3], "after, up to");
  journal.append({ table: "a", n: 7 }); // a holds 3 at most: 1 is dropped
  assertEquals([journal.covers("a", 0), journal.covers("a", 1)], [false, true]);
  assertEquals(journal.since("a", 0, 9), null);
  assertEquals(journal.since("a", 1, 9)?.map((e) => e.event.n), [3, 5, 7]);
  assertEquals(journal.size, 5);
  now += 10_001; // everything is past the retention
  assertEquals([journal.covers("b", 2), journal.covers("b", 4)], [false, true]);
  assertEquals(journal.size, 3, "a's expired entries are held until a prune");
  journal.prune();
  assertEquals(journal.size, 0);
  // Many entries: dropped ones are compacted away, positions keep counting.
  const big = new ChangeJournal<{ table: string }>(60_000, 10);
  for (let i = 0; i < 5_000; i++) big.append({ table: "t" });
  assertEquals([big.head, big.size], [5_000, 10]);
  assertEquals(big.since("t", 4_990, 5_000)?.length, 10);
  big.clear();
  assertEquals(big.size, 0);
});

/** Wait for a fan-out subscription's rows: every list's (unfiltered), or its list's; all the user's. */
async function ownRows(
  conn: ReturnType<Harness["conn"]>,
  user: string,
  list: number | undefined,
  lists: number,
): Promise<void> {
  const want = list === undefined ? lists : 1;
  await until(() => changesOf(conn).length === want, 5_000, `${want} rows`);
  const rows = changesOf(conn).map((c) => (c as { row?: { owner: string; list: number } }).row!);
  assert(rows.every((row) => row.owner === user && (list === undefined || row.list === list)));
}

Deno.test("realtime fan-out: one identity's subscriptions share one re-read per burst, whatever their filters", async () => {
  const sql = fakeRealtimeClient({
    notes: { policy: ownerOnly, types: { id: "bigint", owner: "uuid", list: "integer" } },
  });
  const env = await setUp({}, sql);
  try {
    const LISTS = 16;
    const conns: Array<{ user: string; list?: number; conn: ReturnType<Harness["conn"]> }> = [];
    for (const [user, cookie] of [[A, env.a], [B, env.b]] as const) {
      // Each user: an unfiltered subscription, one per list, and a second tab on list 0.
      for (const list of [undefined, ...Array.from({ length: LISTS }, (_, i) => i), 0]) {
        const conn = env.hub.conn(cookie);
        const filter = list === undefined ? undefined : { list };
        assert((await env.hub.subscribe(conn, "notes", { filter })).ok);
        conns.push({ user, list, conn });
      }
    }
    const engine = realtimeEngine();
    const before = engine.stats.rereads;
    let id = 0;
    for (let list = 0; list < LISTS; list++) {
      for (const owner of [A, B]) env.sql.insert("notes", { id: ++id, owner, list, body: "x" });
    }
    await engine.flush();
    const rereads = engine.stats.rereads - before;
    // Every subscription received exactly its own rows.
    for (const { user, list, conn } of conns) await ownRows(conn, user, list, LISTS);
    // 36 subscriptions, 17 distinct filters per identity, two identities: two re-reads (it was
    // one per identity AND filter: 34).
    assertEquals(rereads, 2);
    console.log(
      `fan-out: ${conns.length} subscriptions, ${
        LISTS + 1
      } filters × 2 identities, ${id} rows → ${rereads} re-reads (one per identity)`,
    );
  } finally {
    await env.done();
  }
});

Deno.test("realtime fan-out: a combined re-read that fails is retried filter by filter", async () => {
  const sql = fakeRealtimeClient({ notes: { policy: ownerOnly } });
  const env = await setUp({}, sql);
  const original = console.error;
  console.error = () => {};
  try {
    const good = env.hub.conn(env.a);
    const bad = env.hub.conn(env.a);
    await env.hub.subscribe(good, "notes", { filter: { list: 1 } });
    await env.hub.subscribe(bad, "notes", { filter: { list: "boom" } });
    // The database refuses the "boom" value (as a cast to the column's type would).
    env.sql.failWhen = (_text, params) => params.includes("boom");
    env.sql.insert("notes", { id: 1, owner: A, list: 1, body: "x" });
    await until(() => good.frames.length === 1 && bad.frames.length === 1);
    assertEquals(changesOf(good).map((c) => c.key), ["1"]);
    assertEquals(unnumbered(bad.frames), [{ resync: true }]);
  } finally {
    console.error = original;
    await env.done();
  }
});

// ── Replay is bound to the subscriber's grant; the journal stays small (audit 4.8) ─────────────

Deno.test("realtime replay: a reconnect under other claims drops what was kept and is a resync", async () => {
  // Rows are visible by a claim other than the subject (a team, a tenant, a role).
  const byEmail = (claims: Record<string, unknown>, row: Record<string, unknown>) =>
    claims.email !== undefined && claims.email === row.email;
  const sql = fakeRealtimeClient({ notes: { policy: byEmail } });
  const env = await setUp({}, sql);
  try {
    const engine = realtimeEngine();
    const first = env.hub.conn(await cookieFor(A, "one@x.test"));
    const { key } = await env.hub.subscribe(first, "notes");
    // A burst of many frames: the subscriber drops after the first, the rest are kept for it.
    const body = "x".repeat(500);
    for (let i = 1; i <= 800; i++) env.sql.insert("notes", { id: i, email: "one@x.test", body });
    await engine.flush();
    await until(() => first.frames.length >= 1, 5_000, "the first frame");
    env.hub.drop(first);
    // A frame already handed to the Live hub before the drop is fanned out on the hub's next
    // flush (a few ms): let that window pass, as any real reconnect does.
    await settle(100);
    env.sql.insert("notes", { id: 900, email: "one@x.test", body: "while away" });
    env.sql.insert("notes", { id: 950, email: "two@x.test", body: "theirs under the new claims" });
    await engine.flush();

    // The same user (same subject) is back, but with other claims: nothing read under the old
    // ones (the kept frames, the replay's starting point) reaches it — it re-reads.
    const back = env.hub.conn(await cookieFor(A, "two@x.test"));
    assert((await env.hub.subscribe(back, "notes", { key })).ok, "the same subject may come back");
    await until(() => back.frames.length >= 1, 3_000, "the answer to the reconnect");
    await settle(150);
    assertEquals(unnumbered(back.frames), [{ resync: true }]);
    assertEquals(changesOf(back), [], "no row read under the old claims");

    // The keys tracked under the old claims are gone: deleting a row only they could see sends
    // nothing (no `delete` with its old image), while a row the new claims see is tracked anew.
    env.sql.remove("notes", "1");
    env.sql.remove("notes", "900");
    env.sql.remove("notes", "950");
    await engine.flush();
    await until(() => changesOf(back).length >= 1, 3_000, "the delete the new grant may see");
    await settle(150);
    assertEquals(changesOf(back).map((c) => [c.op, c.key]), [["delete", "950"]]);
  } finally {
    await env.done();
  }
});

Deno.test("realtime: a subscription's identity and grant — a token without a subject is its own identity", () => {
  const scope = (claims: Record<string, unknown>) => ({
    role: "authenticated" as const,
    claims: JSON.stringify(claims),
  });
  // Two tokens without `sub`: before, both were `authenticated:undefined` (one identity).
  assert(identityOf(scope({ tenant: 1 })) !== identityOf(scope({ tenant: 2 })));
  assertEquals(identityOf(scope({ sub: "u1", tenant: 1 })), "authenticated:u1");
  assertEquals(identityOf(scope({ sub: "u1", tenant: 2 })), "authenticated:u1");
  assertEquals(identityOf({ role: "anon", claims: '{"role":"anon"}' }), "anon");
  // A refresh (exp, iat, nbf, jti) or a key order change is the same grant; another claim is not.
  assertEquals(
    grantOf(scope({ sub: "u1", exp: 1, iat: 1, app_metadata: { a: 1, b: [1, { c: 2, d: 3 }] } })),
    grantOf(
      scope({
        app_metadata: { b: [1, { d: 3, c: 2 }], a: 1 },
        iat: 9,
        nbf: 5,
        jti: "j",
        sub: "u1",
      }),
    ),
  );
  assert(grantOf(scope({ sub: "u1", role: "x" })) !== grantOf(scope({ sub: "u1", role: "y" })));
  assert(grantOf(scope({ sub: "u1" })) !== grantOf({ role: "anon", claims: '{"sub":"u1"}' }));
});

Deno.test("realtime replay: the journal keeps keys only; an oversized key is journaled as a resync", async () => {
  // Keys only: never the old row an `old: "full"` table's notification carries.
  assertEquals(
    journaled({
      table: "notes",
      op: "update",
      key: "1",
      oldKey: "0",
      ts: 5,
      old: { id: 0, secret: "x".repeat(4_000) },
    }),
    { table: "notes", op: "update", key: "1", oldKey: "0", ts: 5 },
  );
  assertEquals(journaled({ table: "notes", op: "delete", key: "k", oldOverflow: true }), {
    table: "notes",
    op: "delete",
    key: "k",
  });
  assertEquals(journaled({ table: "notes", op: "insert", key: "k".repeat(1_025) }), {
    table: "notes",
    op: "resync",
  });
  assertEquals(journaled({ table: "notes", op: "update", key: "1", oldKey: "o".repeat(1_025) }), {
    table: "notes",
    op: "resync",
  });

  const env = await setUp();
  try {
    const engine = realtimeEngine();
    const ca = env.hub.conn(env.a);
    const { key } = await env.hub.subscribe(ca, "notes");
    env.hub.drop(ca);
    // A write with a very long key (the logical source does not bound keys) while A is away.
    env.sql.notify(JSON.stringify({ table: "notes", op: "insert", key: "k".repeat(2_000) }));
    await engine.flush();
    const back = env.hub.conn(env.a);
    assert((await env.hub.subscribe(back, "notes", { key })).ok);
    await until(() => back.frames.length === 2, 3_000, "resumed, then the resync");
    assertEquals(unnumbered(back.frames), [{ resumed: true }, { resync: true }]);
  } finally {
    await env.done();
  }
});

Deno.test("realtime replay: a table that went quiet does not keep its journal past the retention", async () => {
  const env = await setUp({ replay: { retentionSeconds: 1 } });
  try {
    const engine = realtimeEngine();
    assert((await env.hub.subscribe(env.hub.conn(env.a), "notes")).ok); // the listener starts
    for (let i = 1; i <= 5; i++) env.sql.insert("notes", { id: i, owner: A, body: "x" });
    await engine.flush();
    assertEquals(engine.journalSize, 5);
    await settle(1_100); // notes' entries are now past the retention; notes stays quiet
    env.sql.insert("items", { sku: "s1" });
    await engine.flush();
    assertEquals(engine.journalSize, 1, "only the new items change is held");
  } finally {
    await env.done();
  }
});
