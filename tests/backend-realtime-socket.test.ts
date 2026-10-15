// Supabase Realtime's protocol in `@denext/backend`, without a database or a network: the
// Phoenix codec (vsn 1.0.0 / 2.0.0, binary user broadcasts), the bus's wire format and its
// Postgres statements against a recording fake client, the hub driven through fake sockets with a
// fake engine and an in-memory bus (joins, postgres_changes payloads, broadcast, presence,
// private channels, tokens, limits), the HTTP endpoints, the private-channel policy probe and the
// identity helpers. The same paths against the stock supabase-js client on a real Postgres are in
// tests/backend-supabase-realtime-integration.test.ts.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { SqlClient, SqlListener } from "../src/server/postgres.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { resetChannels } from "../src/runtime/channel.ts";
import { backend } from "../packages/backend/mod.ts";
import { broadcast as serverBroadcast } from "../packages/backend/server.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { installRealtime, type RealtimeEngine } from "../packages/backend/src/realtime.ts";
import type { ResolvedTable } from "../packages/backend/src/realtime-sql.ts";
import { REALTIME_BUS_CHANNEL } from "../packages/backend/src/realtime-sql.ts";
import {
  decodeFrame,
  decodeServerFrame,
  encodeBroadcast,
  encodeBroadcastPush,
  encodeMessage,
  parseVsn,
  type PhxMessage,
  reply,
  type Vsn,
} from "../packages/backend/src/realtime-phoenix.ts";
import {
  type BusBroadcast,
  type BusHandlers,
  payloadFromJson,
  payloadToJson,
  postgresBus,
  type PresenceEntry,
  type RealtimeBus,
  receiveBus,
} from "../packages/backend/src/realtime-bus.ts";
import {
  changeData,
  createHub,
  handleRealtimeRequest,
  installRealtimeHub,
  type RealtimeHub,
  type SocketLike,
  tablesFor,
  upgradeSocket,
} from "../packages/backend/src/realtime-socket.ts";
import {
  type ChannelPermissions,
  channelPermissions,
  PUBLIC_PERMISSIONS,
} from "../packages/backend/src/realtime-authz.ts";
import {
  ANON_SOCKET_IDENTITY,
  apiKeyRefusal,
  installAccessTokenVerifier,
  sessionIdentity,
  type SocketIdentity,
  subjectOf,
  tokenIdentity,
} from "../packages/backend/src/realtime-identity.ts";
import type { RlsScope } from "../packages/backend/src/rls.ts";
import {
  generateSupabaseKeys,
  installSupabaseKeys,
  resolveSupabaseKeys,
  signSupabaseJwt,
} from "../src/server/auth/gotrue/keys.ts";
import type { TableChangesFrame } from "../packages/backend/src/realtime-shared.ts";
import { fakeRealtimeClient } from "./helpers/fake-realtime-client.ts";
import { authConfig, cookieFor, settle, until } from "./helpers/realtime-harness.ts";

const A = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000a";
const B = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000b";
const load = ((path: string) => import(path)) as unknown as ModuleLoader;
const decoder = new TextDecoder();

const scopeOf = (sub: string, extra: Record<string, unknown> = {}): RlsScope => ({
  role: "authenticated",
  claims: JSON.stringify({ sub, role: "authenticated", ...extra }),
});
const userIdentity = (sub: string, expiresAt?: number): SocketIdentity =>
  expiresAt === undefined ? { scope: scopeOf(sub) } : { scope: scopeOf(sub), expiresAt };

/** A JWT (unsigned) with the given claims. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.c2ln`;
}

// ── Codec ────────────────────────────────────────────────────────────────────

/** A kind-3 frame, as realtime-js's serializer builds it. */
function pushFrame(
  parts: { joinRef: string; ref: string; topic: string; event: string; meta?: string },
  encoding: number,
  body: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder();
  const strings = [parts.joinRef, parts.ref, parts.topic, parts.event, parts.meta ?? ""].map((s) =>
    enc.encode(s)
  );
  const head = [3, ...strings.map((s) => s.byteLength), encoding];
  const out = new Uint8Array(
    head.length + strings.reduce((n, s) => n + s.byteLength, 0) + body.byteLength,
  );
  out.set(head);
  let offset = head.length;
  for (const s of strings) {
    out.set(s, offset);
    offset += s.byteLength;
  }
  out.set(body, offset);
  return out;
}

/** Decode a kind-4 frame by hand. */
function decodeUserBroadcast(frame: Uint8Array) {
  const [kind, topicLen, eventLen, metaLen, encoding] = frame;
  let offset = 5;
  const topic = decoder.decode(frame.subarray(offset, offset += topicLen));
  const event = decoder.decode(frame.subarray(offset, offset += eventLen));
  offset += metaLen;
  const body = frame.subarray(offset);
  return {
    kind,
    topic,
    event,
    encoding,
    payload: encoding === 1 ? JSON.parse(decoder.decode(body)) : [...body],
  };
}

Deno.test("phoenix codec: vsn, JSON frames both ways, binary user broadcasts", () => {
  assertEquals(parseVsn(null), "1.0.0");
  assertEquals(parseVsn("1.0.0"), "1.0.0");
  assertEquals(parseVsn("2.0.0"), "2.0.0");
  assertEquals(parseVsn("3.0.0"), null);

  const msg: PhxMessage = {
    joinRef: "1",
    ref: "2",
    topic: "realtime:x",
    event: "e",
    payload: { a: 1 },
  };
  assertEquals(decodeFrame("2.0.0", encodeMessage("2.0.0", msg)), msg);
  assertEquals(decodeFrame("1.0.0", encodeMessage("1.0.0", msg)), msg);
  assertEquals(JSON.parse(encodeMessage("2.0.0", msg)), ["1", "2", "realtime:x", "e", { a: 1 }]);
  assertEquals(decodeFrame("2.0.0", '[1, 2, "t", "e", null]'), {
    joinRef: "1",
    ref: "2",
    topic: "t",
    event: "e",
    payload: null,
  });
  assertEquals(decodeFrame("2.0.0", '[{}, null, "t", "e", 1]')?.joinRef, null);
  assertEquals(decodeFrame("2.0.0", "[1,2]"), null);
  assertEquals(decodeFrame("2.0.0", '{"topic":"t"}'), null);
  assertEquals(decodeFrame("1.0.0", "[1,2,3,4,5]"), null);
  assertEquals(decodeFrame("1.0.0", '{"topic":1,"event":"e"}'), null);
  assertEquals(decodeFrame("1.0.0", "not json"), null);
  assertEquals(
    decodeFrame("1.0.0", new Uint8Array([3, 0, 0, 0, 0, 0, 1])),
    null,
    "binary is v2 only",
  );

  // Kind 3: a JSON payload, and raw bytes.
  const json = pushFrame(
    { joinRef: "4", ref: "5", topic: "realtime:room", event: "cursor" },
    1,
    new TextEncoder().encode('{"x":1}'),
  );
  assertEquals(decodeFrame("2.0.0", json), {
    joinRef: "4",
    ref: "5",
    topic: "realtime:room",
    event: "broadcast",
    payload: { type: "broadcast", event: "cursor", payload: { x: 1 } },
  });
  const raw = pushFrame(
    { joinRef: "", ref: "", topic: "realtime:room", event: "b" },
    0,
    new Uint8Array([9, 8]),
  );
  const decoded = decodeFrame("2.0.0", raw.buffer as ArrayBuffer)!;
  assertEquals(decoded.joinRef, null);
  assertEquals(decoded.ref, null);
  assertEquals([...(decoded.payload as { payload: Uint8Array }).payload], [9, 8]);
  assertEquals(
    decodeFrame(
      "2.0.0",
      pushFrame({ joinRef: "", ref: "", topic: "t", event: "e" }, 7, new Uint8Array()),
    ),
    null,
    "unknown encoding",
  );
  assertEquals(decodeFrame("2.0.0", new Uint8Array([4, 1, 1, 0, 1])), null, "a server kind");
  assertEquals(decodeFrame("2.0.0", new Uint8Array([3, 0, 0])), null, "short header");
  assertEquals(decodeFrame("2.0.0", new Uint8Array([3, 5, 0, 0, 0, 0, 1, 65])), null, "truncated");

  // Kind 4 out.
  const out = encodeBroadcast("2.0.0", "realtime:room", "cursor", { y: 2 }) as Uint8Array;
  assertEquals(decodeUserBroadcast(out), {
    kind: 4,
    topic: "realtime:room",
    event: "cursor",
    encoding: 1,
    payload: { y: 2 },
  });
  const bytes = encodeBroadcast(
    "2.0.0",
    "realtime:room",
    "bin",
    new Uint8Array([1, 2]),
  ) as Uint8Array;
  assertEquals(decodeUserBroadcast(bytes).payload, [1, 2]);
  assertEquals(decodeUserBroadcast(bytes).encoding, 0);
  assertEquals(
    JSON.parse(encodeBroadcast("1.0.0", "realtime:room", "e", { z: 3 }) as string),
    {
      join_ref: null,
      ref: null,
      topic: "realtime:room",
      event: "broadcast",
      payload: { type: "broadcast", event: "e", payload: { z: 3 } },
    },
  );
  assertEquals(encodeBroadcast("1.0.0", "realtime:room", "e", new Uint8Array([1])), null);
  const long = "realtime:" + "t".repeat(300);
  assertEquals(typeof encodeBroadcast("2.0.0", long, "e", 1), "string", "JSON past 255 bytes");
  assertEquals(encodeBroadcast("2.0.0", long, "e", new Uint8Array([1])), null);

  assertEquals(reply({ joinRef: "1", ref: "2", topic: "t" }, "ok"), {
    joinRef: "1",
    ref: "2",
    topic: "t",
    event: "phx_reply",
    payload: { status: "ok", response: {} },
  });
});

// ── Bus ──────────────────────────────────────────────────────────────────────

Deno.test("realtime bus: payload JSON round-trip and the wire messages", async () => {
  const bytes = new Uint8Array([0, 255, 7]);
  const json = payloadToJson(bytes);
  assertEquals([...(payloadFromJson(json) as Uint8Array)], [0, 255, 7]);
  assertEquals(payloadToJson(undefined), null);
  assertEquals(payloadFromJson({ a: 1 }), { a: 1 });
  assertEquals(payloadFromJson([1]), [1]);

  const got: unknown[] = [];
  const handlers: BusHandlers = {
    broadcast: (m) => got.push(["b", m]),
    presence: (d) => got.push(["p", d]),
    presenceReload: (t, pr) => got.push(["r", t, pr]),
    resync: () => got.push(["s"]),
  };
  const fetch = (id: string) =>
    Promise.resolve(
      id === "m1" ? { topic: "room", private: false, event: "big", payload: 1 } : null,
    );
  await receiveBus(
    JSON.stringify({ k: "b", t: "room", e: "e", p: json, pr: true, x: "c1" }),
    handlers,
    fetch,
  );
  await receiveBus(JSON.stringify({ k: "m", id: "m1", x: "c2" }), handlers, fetch);
  await receiveBus(JSON.stringify({ k: "m", id: "gone" }), handlers, fetch);
  await receiveBus(
    JSON.stringify({ k: "pd", t: "lobby", j: [{ r: "1", k: "p", m: { a: 1 } }, { r: 2 }], l: "x" }),
    handlers,
    fetch,
  );
  await receiveBus(JSON.stringify({ k: "pr", t: "lobby", pr: true }), handlers, fetch);
  for (
    const garbage of [
      "nope",
      "null",
      '{"k":"b","t":1}',
      '{"k":"m"}',
      '{"k":"pd"}',
      '{"k":"pr"}',
      '{"k":"zz"}',
    ]
  ) await receiveBus(garbage, handlers, fetch);
  assertEquals(got.length, 4);
  const first = got[0] as [string, BusBroadcast];
  assertEquals(first[1].exclude, "c1");
  assertEquals(first[1].private, true);
  assertEquals([...(first[1].payload as Uint8Array)], [0, 255, 7]);
  assertEquals(got[1], ["b", {
    topic: "room",
    private: false,
    event: "big",
    payload: 1,
    exclude: "c2",
    id: "m1",
  }]);
  assertEquals(got[2], ["p", {
    topic: "lobby",
    private: false,
    joins: [{ ref: "1", key: "p", meta: { a: 1 } }],
    leaves: [],
  }]);
  assertEquals(got[3], ["r", "lobby", true]);
});

/** A recording fake client for the bus. */
function busClient() {
  const statements: Array<[string, unknown[]]> = [];
  const answers = {
    dead: [] as Array<Record<string, unknown>>,
    stored: null as Record<string, unknown> | null,
    presences: [] as Array<Record<string, unknown>>,
    own: [] as Array<Record<string, unknown>>,
    replay: [] as Array<Record<string, unknown>>,
  };
  const listeners: Array<{ fn: (p: string) => void; onlisten?: () => void }> = [];
  let unlistened = 0;
  const run = (text: string, params: unknown[] = []): Array<Record<string, unknown>> => {
    statements.push([text, params]);
    if (text.startsWith("with dead as")) {
      const rows = answers.dead;
      answers.dead = [];
      return rows;
    }
    if (text.startsWith("insert into realtime.messages")) return [{ id: "m-1" }];
    if (text.startsWith("select topic, event, payload, private")) {
      return answers.stored ? [answers.stored] : [];
    }
    if (text.startsWith("select ref, key, meta")) return answers.presences;
    if (text.startsWith("select id::text as id, event, payload")) return answers.replay;
    if (text.startsWith("delete from realtime.denext_presences where instance")) return answers.own;
    return [];
  };
  const client =
    ((strings: TemplateStringsArray) =>
      Promise.resolve(run(strings.join("?")))) as unknown as SqlClient;
  client.unsafe = (<T>(text: string, params?: unknown[]) => {
    const rows = run(text, params);
    return Object.assign(Promise.resolve(rows as T[]), {
      simple: () => Promise.resolve(rows as T[]),
    });
  }) as SqlClient["unsafe"];
  client.begin = (async <T>(fn: (tx: SqlClient) => T) => await fn(client)) as SqlClient["begin"];
  client.listen = (
    channel: string,
    fn: (p: string) => void,
    onlisten?: () => void,
  ): Promise<SqlListener> => {
    statements.push([`LISTEN ${channel}`, []]);
    const sub = { fn, onlisten };
    listeners.push(sub);
    onlisten?.();
    return Promise.resolve({
      unlisten: () => {
        unlistened++;
        return Promise.resolve();
      },
    });
  };
  const notifies = () =>
    statements.filter(([t]) => t === "select pg_notify($1, $2)").map(([, p]) =>
      JSON.parse(String(p[1]))
    );
  return {
    client,
    statements,
    answers,
    listeners,
    notifies,
    get unlistened() {
      return unlistened;
    },
  };
}

Deno.test({
  name: "realtime bus on Postgres: heartbeat, listen, broadcast inline or stored, presence rows",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fake = busClient();
    const got: unknown[] = [];
    let readies = 0;
    const bus = postgresBus({
      client: () => fake.client,
      instance: "00000000-0000-4000-8000-000000000001",
      ready: () => {
        readies++;
        return Promise.resolve();
      },
      handlers: {
        broadcast: (m) => got.push(m),
        presence: (d) => got.push(d),
        presenceReload: () => {},
        resync: () => got.push("resync"),
      },
    });
    // A dead instance's presences are swept at the first heartbeat, and their leaves announced.
    fake.answers.dead = [
      { topic: "lobby", private: false, ref: "r1", key: "p", meta: '{"a":1}' },
      { topic: "lobby", private: false, ref: "r2", key: "q", meta: { b: 2 } },
      { topic: "vip", private: true, ref: "r3", key: "z", meta: null },
    ];
    await bus.start();
    await bus.start(); // memoized
    assertEquals(readies, 1);
    assert(fake.statements[0][0].startsWith("insert into realtime.denext_instances"));
    assertEquals(fake.statements.filter(([t]) => t === `LISTEN ${REALTIME_BUS_CHANNEL}`).length, 1);
    const leaves = fake.notifies();
    assertEquals(leaves.length, 2);
    assertEquals(leaves[0].l.map((e: { r: string }) => e.r), ["r1", "r2"]);
    assertEquals(leaves[1], {
      k: "pd",
      t: "vip",
      pr: true,
      j: [],
      l: [{ r: "r3", k: "z", m: {} }],
    });

    // Received messages, and a re-listen.
    fake.listeners[0].fn(JSON.stringify({ k: "b", t: "room", e: "e", p: 1 }));
    fake.answers.stored = {
      topic: "room",
      event: "big",
      payload: '{"__denext_binary":"AQI="}',
      private: null,
    };
    fake.listeners[0].fn(JSON.stringify({ k: "m", id: "m-1" }));
    fake.listeners[0].fn("garbage");
    await until(() => got.length === 2);
    assertEquals([...((got[1] as BusBroadcast).payload as Uint8Array)], [1, 2]);
    fake.listeners[0].onlisten?.();
    assertEquals(got[2], "resync");

    // A small broadcast is one NOTIFY; a large one is stored and sent by id.
    fake.statements.length = 0;
    await bus.broadcast({
      topic: "room",
      private: false,
      event: "e",
      payload: { n: 1 },
      exclude: "c",
    });
    assertEquals(fake.notifies(), [{ k: "b", t: "room", e: "e", p: { n: 1 }, pr: false, x: "c" }]);
    fake.statements.length = 0;
    await bus.broadcast({ topic: "room", private: true, event: "e", payload: "x".repeat(9_000) });
    assert(fake.statements[0][0].startsWith("insert into realtime.messages"));
    assertEquals(fake.statements[0][1][3], "true");
    assertEquals(fake.notifies(), [{ k: "m", id: "m-1" }]);

    // Presence: track (replacing), untrack, an oversized diff becomes a reload, the state.
    fake.statements.length = 0;
    const entry: PresenceEntry = { ref: "n1", key: "p", meta: { at: 1 } };
    await bus.track("lobby", false, entry, [{ ref: "o1", key: "p", meta: {} }]);
    assert(fake.statements[0][0].startsWith("delete from realtime.denext_presences where ref in"));
    assert(fake.statements[1][0].startsWith("insert into realtime.denext_presences"));
    assertEquals(fake.notifies()[0].j, [{ r: "n1", k: "p", m: { at: 1 } }]);
    fake.statements.length = 0;
    await bus.track("lobby", false, { ref: "n2", key: "p", meta: { big: "y".repeat(9_000) } }, []);
    assertEquals(fake.statements.length, 2, "no delete when nothing is replaced");
    assertEquals(fake.notifies(), [{ k: "pr", t: "lobby", pr: false }]);
    fake.statements.length = 0;
    await bus.untrack("lobby", false, []);
    assertEquals(fake.statements.length, 0);
    await bus.untrack("lobby", false, [entry]);
    assertEquals(fake.notifies()[0].l, [{ r: "n1", k: "p", m: { at: 1 } }]);
    fake.answers.presences = [{ ref: "n2", key: "p", meta: '{"x":1}' }];
    assertEquals(await bus.presenceState("lobby", false), [{
      ref: "n2",
      key: "p",
      meta: { x: 1 },
    }]);

    // Stop: own presences untracked (and announced), the instance row removed, UNLISTEN.
    fake.statements.length = 0;
    fake.answers.own = [{ topic: "lobby", private: false, ref: "n2", key: "p", meta: {} }];
    await bus.stop();
    assertEquals(fake.notifies()[0].l, [{ r: "n2", k: "p", m: {} }]);
    assert(fake.statements.some(([t]) => t.startsWith("delete from realtime.denext_instances")));
    assertEquals(fake.unlistened, 1);
    await assertRejects(() => bus.start(), Error, "shutting down");
  },
});

Deno.test({
  name: "realtime bus: a failed start is retried; a stop during start unlistens",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fake = busClient();
    let fail = true;
    const handlers: BusHandlers = {
      broadcast: () => {},
      presence: () => {},
      presenceReload: () => {},
      resync: () => {},
    };
    const bus = postgresBus({
      client: () => fake.client,
      instance: "00000000-0000-4000-8000-000000000002",
      ready: () => fail ? Promise.reject(new Error("no db")) : Promise.resolve(),
      handlers,
    });
    await assertRejects(() => bus.start(), Error, "no db");
    fail = false;
    await bus.start();
    // The stop's own SQL failing (the database gone) is swallowed.
    fake.client.unsafe = (() => {
      throw new Error("gone");
    }) as SqlClient["unsafe"];
    await bus.stop();
  },
});

// ── The hub ──────────────────────────────────────────────────────────────────

const NOTES: ResolvedTable = {
  name: "notes",
  table: "notes",
  events: ["insert", "update", "delete", "truncate"],
  key: "id",
  qualified: '"notes"',
  old: "key",
};
const ITEMS: ResolvedTable = {
  name: "items",
  table: "items",
  events: ["insert"],
  key: "sku",
  schema: "app",
  qualified: '"app"."items"',
  old: "full",
};

interface FakeBinding {
  init: Parameters<RealtimeEngine["bind"]>[0];
  stopped: boolean;
  scopes: RlsScope[];
}

function fakeEngine(options: { failStart?: boolean } = {}) {
  const binds: FakeBinding[] = [];
  const state = { refuse: false, columnsFail: false };
  const engine = {
    config: { tables: new Map([[NOTES.name, NOTES], [ITEMS.name, ITEMS]]) },
    start: () => options.failStart ? Promise.reject(new Error("no listen")) : Promise.resolve(),
    columns: () =>
      state.columnsFail
        ? Promise.reject(new Error("catalog"))
        : Promise.resolve([{ name: "id", type: "int8" }]),
    bind: (init: FakeBinding["init"]) => {
      if (state.refuse) return Promise.resolve(null);
      const rec: FakeBinding = { init, stopped: false, scopes: [init.scope] };
      binds.push(rec);
      return Promise.resolve({
        stop: () => void (rec.stopped = true),
        rescope: (scope: RlsScope) => {
          rec.scopes.push(scope);
          return true;
        },
      });
    },
  };
  return { engine: engine as unknown as RealtimeEngine, binds, state };
}

/** An in-memory bus: delivers synchronously to this hub. */
function memoryBus(handlers: BusHandlers) {
  const rows = new Map<string, PresenceEntry[]>();
  const log: string[] = [];
  const id = (topic: string, pr: boolean) => `${pr}:${topic}`;
  const stored: Array<{ topic: string; at: number; id: string; event: string; payload: unknown }> =
    [];
  const bus: RealtimeBus & {
    log: string[];
    handlers: BusHandlers;
    fail: boolean;
    stored: typeof stored;
  } = {
    log,
    handlers,
    fail: false,
    stored,
    start: () => Promise.resolve(),
    broadcast(message) {
      if (bus.fail) return Promise.reject(new Error("bus down"));
      log.push(`broadcast ${message.topic}`);
      if (message.private) {
        const id = crypto.randomUUID();
        stored.push({
          topic: message.topic,
          at: Date.now(),
          id,
          event: message.event,
          payload: message.payload,
        });
        handlers.broadcast({ ...message, id });
      } else {
        handlers.broadcast(message);
      }
      return Promise.resolve();
    },
    replay: (topic, since, limit) =>
      Promise.resolve(
        stored.filter((m) => m.topic === topic && m.at >= since).slice(0, limit)
          .map(({ id, event, payload }) => ({ id, event, payload })),
      ),
    track(topic, pr, entry, replaces) {
      if (bus.fail) return Promise.reject(new Error("bus down"));
      log.push(`track ${topic} ${entry.key}`);
      const list = (rows.get(id(topic, pr)) ?? []).filter((e) =>
        !replaces.some((r) => r.ref === e.ref)
      );
      rows.set(id(topic, pr), [...list, entry]);
      handlers.presence({ topic, private: pr, joins: [entry], leaves: replaces });
      return Promise.resolve();
    },
    untrack(topic, pr, entries) {
      log.push(`untrack ${topic} ${entries.length}`);
      rows.set(id(topic, pr), (rows.get(id(topic, pr)) ?? []).filter((e) => !entries.includes(e)));
      if (entries.length > 0) handlers.presence({ topic, private: pr, joins: [], leaves: entries });
      return Promise.resolve();
    },
    presenceState: (topic, pr) => Promise.resolve(rows.get(id(topic, pr)) ?? []),
    stop: () => {
      log.push("stop");
      return Promise.resolve();
    },
  };
  return bus;
}

class FakeSocket implements SocketLike {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  closed: { code?: number; reason?: string } | null = null;
  throwOnSend = false;
  constructor(readonly vsn: Vsn = "2.0.0") {}
  send(data: string | Uint8Array): void {
    if (this.throwOnSend) throw new Error("broken");
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  /** The JSON messages sent. */
  get messages(): PhxMessage[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) =>
      decodeFrame(this.vsn, d)!
    );
  }
  of(event: string): PhxMessage[] {
    return this.messages.filter((m) => m.event === event);
  }
  replyTo(ref: string): PhxMessage | undefined {
    return this.messages.find((m) => m.event === "phx_reply" && m.ref === ref);
  }
}

interface Rig {
  hub: RealtimeHub;
  bus: ReturnType<typeof memoryBus>;
  binds: FakeBinding[];
  engineState: { refuse: boolean; columnsFail: boolean };
  perms: Array<[RlsScope, string]>;
  permsFor: (scope: RlsScope, topic: string) => ChannelPermissions;
  open(identity?: SocketIdentity, vsn?: Vsn, limitIp?: string): Client;
}

interface Client {
  socket: FakeSocket;
  send(
    joinRef: string | null,
    ref: string | null,
    topic: string,
    event: string,
    payload: unknown,
  ): void;
  raw(data: string | Uint8Array): void;
  join(
    topic: string,
    config?: Record<string, unknown>,
    extra?: Record<string, unknown>,
  ): Promise<PhxMessage>;
  close(): void;
}

let refs = 0;

function rig(
  limits: Record<string, number> = {},
  engineOptions: { failStart?: boolean } = {},
): Rig {
  const { engine, binds, state } = fakeEngine(engineOptions);
  let bus!: ReturnType<typeof memoryBus>;
  const perms: Array<[RlsScope, string]> = [];
  const r: Rig = {
    hub: undefined as unknown as RealtimeHub,
    get bus() {
      return bus;
    },
    binds,
    engineState: state,
    perms,
    permsFor: () => PUBLIC_PERMISSIONS,
    open(identity = ANON_SOCKET_IDENTITY, vsn = "2.0.0", limitIp) {
      const socket = new FakeSocket(vsn);
      const handlers = r.hub.attach(socket, vsn, limitIp ? { limitIp } : {}, identity, null);
      const send: Client["send"] = (joinRef, ref, topic, event, payload) =>
        handlers.message(encodeMessage(vsn, { joinRef, ref, topic, event, payload }));
      return {
        socket,
        send,
        raw: (data) => handlers.message(data),
        async join(topic, config = {}, extra = {}) {
          const ref = String(++refs);
          send(ref, ref, topic, "phx_join", { config, ...extra });
          await until(() => socket.replyTo(ref) !== undefined, 15_000, `join ${topic}`);
          return socket.replyTo(ref)!;
        },
        close: () => handlers.close(),
      };
    },
  } as Rig;
  r.hub = createHub({
    engine,
    limits,
    permissions: (scope, topic) => {
      perms.push([scope, topic]);
      return Promise.resolve(r.permsFor(scope, topic));
    },
    bus: (handlers) => (bus = memoryBus(handlers)),
  });
  return r;
}

const statusOf = (m: PhxMessage) => (m.payload as { status: string }).status;
const responseOf = (m: PhxMessage) => (m.payload as { response: Record<string, unknown> }).response;

Deno.test({
  name: "realtime hub: heartbeat, join, leave, invalid and unmatched topics, channel cap",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const r = rig({ maxChannelsPerConnection: 2 });
    try {
      await r.hub.ready();
      const c = r.open();
      c.send(null, "h1", "phoenix", "heartbeat", {});
      assertEquals(statusOf(c.socket.replyTo("h1")!), "ok");

      const joined = await c.join("realtime:room");
      assertEquals(statusOf(joined), "ok");
      assertEquals(responseOf(joined), { postgres_changes: [] });
      assertEquals(c.socket.of("system").length, 0, "no system note without bindings");
      assertEquals(c.socket.of("presence_state").length, 1, "presence on by default");

      const bad = await c.join("room");
      assertStringIncludes(String(responseOf(bad).reason), "invalid topic");
      const long = await c.join("realtime:" + "x".repeat(260));
      assertEquals(statusOf(long), "error");

      // The same topic again: the previous join is closed.
      const again = await c.join("realtime:room");
      assertEquals(statusOf(again), "ok");
      assertEquals(c.socket.of("phx_close").length, 1);
      await c.join("realtime:two");
      const third = await c.join("realtime:three");
      assertStringIncludes(String(responseOf(third).reason), "Too many channels");

      // An unknown topic, a stale join ref, an unknown event.
      c.send("9", "u1", "realtime:nope", "broadcast", {});
      assertEquals(responseOf(c.socket.replyTo("u1")!).reason, "unmatched topic");
      c.send("stale", "u2", "realtime:room", "broadcast", {});
      assertEquals(responseOf(c.socket.replyTo("u2")!).reason, "unmatched topic");
      c.send(null, null, "realtime:nope", "broadcast", {});
      c.send(again.joinRef, "u3", "realtime:room", "custom", {});
      assertEquals(statusOf(c.socket.replyTo("u3")!), "ok");
      c.send(again.joinRef, null, "realtime:room", "custom", {});
      c.raw("garbage");

      // Leave: replied, then forgotten.
      c.send(again.joinRef, "l1", "realtime:room", "phx_leave", {});
      assertEquals(statusOf(c.socket.replyTo("l1")!), "ok");
      c.send(again.joinRef, "l2", "realtime:room", "broadcast", {});
      assertEquals(responseOf(c.socket.replyTo("l2")!).reason, "unmatched topic");
      assertEquals(r.hub.size, 1);
      c.close();
      assertEquals(r.hub.size, 0);
    } finally {
      await r.hub.stop();
    }
  },
});

Deno.test({
  name: "realtime hub: broadcast self, ack, binary, private write, size; delivered per topic",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const r = rig({ maxPayloadBytes: 100 });
    try {
      const x = r.open();
      const y = r.open(ANON_SOCKET_IDENTITY, "1.0.0");
      const z = r.open();
      const jx = await x.join("realtime:room", { broadcast: { self: false, ack: true } });
      const jy = await y.join("realtime:room");
      const jz = await z.join("realtime:room", { broadcast: { self: true } });
      await y.join("realtime:other");

      x.send(jx.joinRef, "b1", "realtime:room", "broadcast", {
        type: "broadcast",
        event: "hi",
        payload: { n: 1 },
      });
      await until(() => x.socket.replyTo("b1") !== undefined);
      assertEquals(statusOf(x.socket.replyTo("b1")!), "ok", "ack");
      assertEquals(y.socket.of("broadcast").map((m) => m.payload), [{
        type: "broadcast",
        event: "hi",
        payload: { n: 1 },
      }]);
      assertEquals(y.socket.of("broadcast")[0].topic, "realtime:room", "not other topics");
      const zFrames = z.socket.sent.filter((d): d is Uint8Array => d instanceof Uint8Array);
      assertEquals(zFrames.map((f) => decodeUserBroadcast(f).payload), [{ n: 1 }]);
      assertEquals(x.socket.sent.filter((d) => d instanceof Uint8Array).length, 0, "self: false");

      // z (self: true) hears itself; no ack requested → no reply.
      z.send(jz.joinRef, "b2", "realtime:room", "broadcast", {
        type: "broadcast",
        event: "hi",
        payload: 2,
      });
      await until(() => z.socket.sent.filter((d) => d instanceof Uint8Array).length === 2);
      assertEquals(z.socket.replyTo("b2"), undefined);

      // Binary over vsn 2: a kind-4 frame to x, nothing to y (vsn 1).
      const before = y.socket.sent.length;
      z.raw(
        pushFrame(
          { joinRef: jz.joinRef!, ref: "b3", topic: "realtime:room", event: "bin" },
          0,
          new Uint8Array([5, 6]),
        ),
      );
      await until(() => x.socket.sent.filter((d) => d instanceof Uint8Array).length === 2);
      const bin = x.socket.sent.filter((d): d is Uint8Array => d instanceof Uint8Array)[1];
      assertEquals(decodeUserBroadcast(bin).payload, [5, 6]);
      assertEquals(y.socket.sent.length, before);

      // Errors: no event, too large, the bus failing.
      x.send(jx.joinRef, "e1", "realtime:room", "broadcast", { type: "broadcast", payload: 1 });
      assertStringIncludes(String(responseOf(x.socket.replyTo("e1")!).reason), "event name");
      x.send(jx.joinRef, "e2", "realtime:room", "broadcast", {
        type: "broadcast",
        event: "e",
        payload: "x".repeat(200),
      });
      await until(() => x.socket.replyTo("e2") !== undefined);
      assertStringIncludes(String(responseOf(x.socket.replyTo("e2")!).reason), "too large");
      r.bus.fail = true;
      x.send(jx.joinRef, "e3", "realtime:room", "broadcast", {
        type: "broadcast",
        event: "e",
        payload: 1,
      });
      await until(() => x.socket.replyTo("e3") !== undefined);
      assertEquals(responseOf(x.socket.replyTo("e3")!).reason, "broadcast failed");
      r.bus.fail = false;
      assert(jy);
    } finally {
      await r.hub.stop();
    }
  },
});

Deno.test({
  name: "realtime hub: private channels follow the policies — join, read, write",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const r = rig();
    const ALL = PUBLIC_PERMISSIONS;
    const NONE = {
      readBroadcast: false,
      readPresence: false,
      writeBroadcast: false,
      writePresence: false,
    };
    const READ_ONLY = { ...NONE, readBroadcast: true };
    r.permsFor = (scope, topic) => {
      const sub = (JSON.parse(scope.claims) as { sub?: string }).sub;
      if (topic !== "secret") return NONE;
      return sub === A ? ALL : sub === B ? READ_ONLY : NONE;
    };
    try {
      const a = r.open(userIdentity(A));
      const b = r.open(userIdentity(B));
      const anon = r.open();
      const pub = r.open();
      const ja = await a.join("realtime:secret", { private: true, broadcast: { self: true } });
      assertEquals(statusOf(ja), "ok");
      const jb = await b.join("realtime:secret", { private: true });
      assertEquals(statusOf(jb), "ok");
      const refused = await anon.join("realtime:secret", { private: true });
      assertStringIncludes(String(responseOf(refused).reason), "Unauthorized");
      await pub.join("realtime:secret"); // the public topic of the same name is another topic
      assertEquals(r.perms.map(([, t]) => t), ["secret", "secret", "secret"]);

      a.send(ja.joinRef, "w1", "realtime:secret", "broadcast", {
        type: "broadcast",
        event: "e",
        payload: 1,
      });
      await until(() => b.socket.sent.some((d) => d instanceof Uint8Array));
      assert(a.socket.sent.some((d) => d instanceof Uint8Array), "self");
      assertEquals(pub.socket.sent.filter((d) => d instanceof Uint8Array).length, 0);
      b.send(jb.joinRef, "w2", "realtime:secret", "broadcast", {
        type: "broadcast",
        event: "e",
        payload: 1,
      });
      await until(() => b.socket.replyTo("w2") !== undefined);
      assertStringIncludes(String(responseOf(b.socket.replyTo("w2")!).reason), "write");
      b.send(jb.joinRef, "w3", "realtime:secret", "presence", {
        type: "presence",
        event: "track",
        payload: {},
      });
      await until(() => b.socket.replyTo("w3") !== undefined);
      assertStringIncludes(String(responseOf(b.socket.replyTo("w3")!).reason), "presence");
      // b cannot read presence: a's track reaches a, not b.
      a.send(ja.joinRef, "w4", "realtime:secret", "presence", {
        type: "presence",
        event: "track",
        payload: { u: "a" },
      });
      await until(() => a.socket.of("presence_diff").length === 1);
      assertEquals(b.socket.of("presence_diff").length, 0);
      assertEquals(b.socket.of("presence_state").length, 0);
    } finally {
      await r.hub.stop();
    }
  },
});

Deno.test({
  name: "realtime hub: presence track, re-track, untrack, state on join, gone with the socket",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const r = rig({ maxPayloadBytes: 50 });
    try {
      const p = r.open();
      const q = r.open();
      const off = r.open();
      const jp = await p.join("realtime:lobby", { presence: { key: "p", enabled: true } });
      const jq = await q.join("realtime:lobby", { presence: { key: "q" } });
      await off.join("realtime:lobby", { presence: { enabled: false } });
      assertEquals(off.socket.of("presence_state").length, 0);

      q.send(jq.joinRef, "t1", "realtime:lobby", "presence", {
        type: "presence",
        event: "track",
        payload: { at: 1 },
      });
      await until(() => q.socket.replyTo("t1") !== undefined);
      assertEquals(statusOf(q.socket.replyTo("t1")!), "ok");
      const diff = p.socket.of("presence_diff")[0].payload as {
        joins: Record<string, { metas: Array<Record<string, unknown>> }>;
      };
      assertEquals(diff.joins.q.metas[0].at, 1);
      assert(typeof diff.joins.q.metas[0].phx_ref === "string");
      assertEquals(off.socket.of("presence_diff").length, 0, "not enabled");

      // Re-track replaces (a leave of the old ref with the join).
      q.send(jq.joinRef, "t2", "realtime:lobby", "presence", {
        type: "presence",
        event: "track",
        payload: { at: 2 },
      });
      await until(() => p.socket.of("presence_diff").length === 2);
      const second = p.socket.of("presence_diff")[1].payload as { leaves: Record<string, unknown> };
      assert("q" in second.leaves);

      // A late joiner gets the state.
      const late = r.open();
      await late.join("realtime:lobby", { presence: { enabled: true } });
      await until(() => late.socket.of("presence_state").length === 1);
      const state = late.socket.of("presence_state")[0].payload as Record<
        string,
        { metas: unknown[] }
      >;
      assertEquals(Object.keys(state), ["q"]);

      q.send(jq.joinRef, "t3", "realtime:lobby", "presence", {
        type: "presence",
        event: "track",
        payload: { big: "z".repeat(80) },
      });
      await until(() => q.socket.replyTo("t3") !== undefined);
      assertStringIncludes(String(responseOf(q.socket.replyTo("t3")!).reason), "too large");
      q.send(jq.joinRef, "t4", "realtime:lobby", "presence", { type: "presence", event: "dance" });
      await until(() => q.socket.replyTo("t4") !== undefined);
      assertStringIncludes(String(responseOf(q.socket.replyTo("t4")!).reason), "track and untrack");
      q.send(jq.joinRef, "t5", "realtime:lobby", "presence", {
        type: "presence",
        event: "untrack",
      });
      await until(() => q.socket.replyTo("t5") !== undefined);
      assertEquals(p.socket.of("presence_diff").length, 3);

      // p tracks; its socket closes: untracked.
      p.send(jp.joinRef, "t6", "realtime:lobby", "presence", {
        type: "presence",
        event: "track",
        payload: {},
      });
      await until(() => p.socket.replyTo("t6") !== undefined);
      p.close();
      assert(r.bus.log.includes("untrack lobby 1"));

      // A bus failure is answered as an error.
      r.bus.fail = true;
      q.send(jq.joinRef, "t7", "realtime:lobby", "presence", {
        type: "presence",
        event: "track",
        payload: {},
      });
      await until(() => q.socket.replyTo("t7") !== undefined);
      assertEquals(responseOf(q.socket.replyTo("t7")!).reason, "presence failed");
      r.bus.fail = false;

      // A presence reload (an oversized diff elsewhere) and a bus re-listen resend the state.
      const count = late.socket.of("presence_state").length;
      r.bus.handlers.presenceReload("lobby", false);
      r.bus.handlers.resync();
      await until(() => late.socket.of("presence_state").length === count + 2);
    } finally {
      await r.hub.stop();
    }
  },
});

Deno.test({
  name: "realtime hub: postgres_changes bindings, their payloads, and refusals",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const r = rig();
    try {
      const c = r.open(userIdentity(A));
      const joined = await c.join("realtime:db", {
        postgres_changes: [
          { event: "*", schema: "public", table: "notes" },
          { event: "INSERT", schema: "public", table: "notes", filter: "id=gte.5", select: ["id"] },
          { event: "UPDATE", schema: "*" },
        ],
      });
      assertEquals(statusOf(joined), "ok");
      const echoed = responseOf(joined).postgres_changes as Array<Record<string, unknown>>;
      assertEquals(echoed.map((e) => e.event), ["*", "INSERT", "UPDATE"]);
      assertEquals(echoed[1].filter, "id=gte.5");
      assertEquals(echoed[1].select, ["id"]);
      assert(echoed.every((e) => typeof e.id === "number"));
      assertEquals(r.binds.length, 4, "the wildcard binds both tables");
      assertEquals(r.binds[1].init.filter, { column: "id", op: "gte", value: "5" });
      assertEquals([...r.binds[1].init.events], ["insert"]);
      assertEquals(r.binds[0].init.owner, `authenticated:${A}`);
      assertEquals(c.socket.of("system")[0].payload, {
        extension: "postgres_changes",
        status: "ok",
        message: "Subscribed to PostgreSQL",
        channel: "db",
      });

      const deliver = (i: number, frame: TableChangesFrame) => r.binds[i].init.onFrame(frame);
      deliver(0, {
        seq: 1,
        changes: [
          { op: "insert", key: "1", row: { id: 1 }, ts: 1_000 } as never,
          { op: "update", key: "2", oldKey: "1", row: { id: 2 } },
          { op: "delete", key: "3", old: { id: 3, body: "x" } },
          { op: "truncate" },
          { op: "insert", key: "4", truncated: true },
        ],
      });
      const changes = c.socket.of("postgres_changes").map((m) =>
        m.payload as { ids: number[]; data: Record<string, unknown> }
      );
      assertEquals(changes.length, 5);
      assert(changes.every((ch) => ch.ids[0] === echoed[0].id));
      assertEquals(changes[0].data, {
        schema: "public",
        table: "notes",
        commit_timestamp: new Date(1_000).toISOString(),
        type: "INSERT",
        columns: [{ name: "id", type: "int8" }],
        record: { id: 1 },
        errors: null,
      });
      assertEquals(changes[1].data.old_record, { id: "1" });
      assertEquals(changes[2].data.old_record, { id: 3, body: "x" });
      assertEquals(changes[3].data.type, "TRUNCATE");
      assertEquals(changes[4].data.record, { id: "4" });
      assertEquals(changes[4].data.errors, ["Error 413: Payload Too Large"]);
      deliver(0, { seq: 2, resync: true });
      assertEquals((c.socket.of("system")[1].payload as { status: string }).status, "error");

      // Refusals.
      for (
        const [spec, reason] of [
          [{ event: "SELECT", table: "notes" }, "invalid postgres_changes event"],
          [{ event: "*", schema: "public", table: "nope" }, "Unable to subscribe"],
          [{ event: "*", schema: "*", filter: "id=eq.1" }, "one table"],
          [{ event: "*", table: "notes", filter: 5 }, "invalid filter"],
          [{ event: "*", table: "notes", filter: "id=like.1" }, "realtime filter"],
        ] as const
      ) {
        const refused = await c.join("realtime:bad", { postgres_changes: [spec] });
        assertStringIncludes(String(responseOf(refused).reason), reason);
      }
      const many = await c.join("realtime:many", {
        postgres_changes: Array.from({ length: 101 }, () => ({ event: "*", table: "notes" })),
      });
      assertStringIncludes(String(responseOf(many).reason), "at most 100");
      r.engineState.refuse = true;
      r.engineState.columnsFail = true;
      const capped = await c.join("realtime:capped", {
        postgres_changes: [{ event: "*", table: "notes" }],
      });
      assertStringIncludes(String(responseOf(capped).reason), "Too many postgres_changes");
      r.engineState.refuse = false;

      // Leaving stops the bindings.
      c.send(joined.joinRef, "x", "realtime:db", "phx_leave", {});
      assert(r.binds.slice(0, 4).every((b) => b.stopped));
      // A frame after the channel closed is ignored.
      deliver(0, { seq: 3, changes: [{ op: "truncate" }] });
      assertEquals(c.socket.of("postgres_changes").length, 5);
    } finally {
      await r.hub.stop();
    }
  },
});

Deno.test({
  name: "realtime hub: access tokens — expired, refreshed, another user, expiry",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const r = rig();
    const sessions: Record<string, SocketIdentity> = {
      "user-a": userIdentity(A),
      "user-a2": { scope: scopeOf(A, { refreshed: true }) },
      "user-b": userIdentity(B),
      "user-short": userIdentity(B, Date.now() + 60),
    };
    installAccessTokenVerifier((token) => Promise.resolve(sessions[token] ?? null));
    const now = Math.floor(Date.now() / 1000);
    const expired = jwt({ sub: A, exp: now - 30 });
    try {
      const c = r.open();
      // Refused at the join.
      const refused = await c.join("realtime:t0", {}, { access_token: expired });
      assertStringIncludes(String(responseOf(refused).reason), "Token has expired");

      const joined = await c.join("realtime:t1", {
        private: true,
        postgres_changes: [{ event: "*", table: "notes" }],
      }, { access_token: "user-a" });
      assertEquals(statusOf(joined), "ok");
      assertEquals(r.binds[0].init.scope, scopeOf(A));
      const permsBefore = r.perms.length;

      // The same subject: rescoped in place.
      c.send(joined.joinRef, null, "realtime:t1", "access_token", { access_token: "user-a2" });
      await until(() => r.binds[0].scopes.length === 2);
      assertEquals(r.binds.length, 1);

      // Another subject: the bindings are re-created as them, the policies evaluated again.
      c.send(joined.joinRef, null, "realtime:t1", "access_token", { access_token: "user-b" });
      await until(() => r.binds.length === 2);
      assert(r.binds[0].stopped);
      assertEquals(r.binds[1].init.scope, scopeOf(B));
      assertEquals(r.perms.length, permsBefore + 1);

      // An expired token closes the channel, with a system message.
      c.send(joined.joinRef, null, "realtime:t1", "access_token", { access_token: expired });
      await until(() => c.socket.of("phx_close").length === 1);
      assertStringIncludes(
        JSON.stringify(c.socket.of("system").at(-1)!.payload),
        "Token has expired",
      );

      // A token that expires while joined closes its channel when it does.
      const short = await c.join("realtime:t2", {}, { access_token: "user-short" });
      assertEquals(statusOf(short), "ok");
      await until(() => c.socket.of("phx_close").length === 2, 15_000, "the expiry");

      // Another subject whose policies refuse: closed. A failing re-bind: closed.
      r.permsFor = (scope) =>
        (JSON.parse(scope.claims) as { sub?: string }).sub === A ? PUBLIC_PERMISSIONS : {
          readBroadcast: false,
          readPresence: false,
          writeBroadcast: false,
          writePresence: false,
        };
      const t3 = await c.join("realtime:t3", { private: true }, { access_token: "user-a" });
      c.send(t3.joinRef, null, "realtime:t3", "access_token", { access_token: "user-b" });
      await until(() => c.socket.of("phx_close").length === 3);
      const t4 = await c.join(
        "realtime:t4",
        { postgres_changes: [{ event: "*", table: "notes" }] },
        {
          access_token: "user-a",
        },
      );
      r.engineState.refuse = true;
      c.send(t4.joinRef, null, "realtime:t4", "access_token", { access_token: "user-b" });
      await until(() => c.socket.of("phx_close").length === 4);
      r.engineState.refuse = false;
    } finally {
      installAccessTokenVerifier(undefined);
      await r.hub.stop();
    }
  },
});

Deno.test({
  name: "realtime hub: limits — rate, frame size, slow consumers, connections per address",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const r = rig({
      maxEventsPerSecond: 3,
      maxConnections: 3,
      maxConnectionsPerAddress: 2,
      maxPayloadBytes: 10,
    });
    try {
      const c = r.open(ANON_SOCKET_IDENTITY, "2.0.0", "203.0.113.0");
      for (let i = 0; i < 5; i++) c.send(null, `h${i}`, "phoenix", "heartbeat", {});
      assertEquals(c.socket.of("phx_reply").length, 3, "past the rate: dropped");
      assertEquals(c.socket.closed, null);
      for (let i = 0; i < 3; i++) c.send(null, null, "phoenix", "heartbeat", {});
      assertEquals(c.socket.closed?.code, 1008, "twice the rate: closed");

      const big = r.open(ANON_SOCKET_IDENTITY, "2.0.0", "203.0.113.0");
      big.raw("x".repeat(70 * 1024));
      assertEquals(big.socket.closed?.code, 1009);

      assertEquals(r.hub.full("203.0.113.0"), null);
      r.open(ANON_SOCKET_IDENTITY, "2.0.0", "203.0.113.0");
      r.open(ANON_SOCKET_IDENTITY, "2.0.0", "203.0.113.0");
      assertEquals(r.hub.full("203.0.113.0")?.status, 429);
      r.open();
      assertEquals(r.hub.full(undefined)?.status, 503);

      // A consumer that cannot keep up is closed rather than buffered for.
      const r2 = rig();
      const slow = r2.open();
      slow.socket.bufferedAmount = 9 * 1024 * 1024;
      slow.send(null, "h", "phoenix", "heartbeat", {});
      assertEquals(slow.socket.closed?.code, 1013);
      const broken = r2.open();
      broken.socket.throwOnSend = true;
      broken.send(null, "h", "phoenix", "heartbeat", {});
      assertEquals(broken.socket.closed?.code, 1011);
      // A closed socket's writes are dropped.
      const done = r2.open();
      done.socket.readyState = 3;
      done.send(null, "h", "phoenix", "heartbeat", {});
      assertEquals(done.socket.sent.length, 0);
      await r2.hub.stop();
      await assertRejects(() => r2.hub.ready(), Error, "shutting down");
    } finally {
      await r.hub.stop();
    }
  },
});

Deno.test({
  name: "realtime hub: a binding's select keeps only those columns; REST calls are rate limited",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const r = rig({ maxEventsPerSecond: 2 });
    try {
      const c = r.open(userIdentity(A));
      await c.join("realtime:picked", {
        postgres_changes: [{ event: "*", schema: "public", table: "notes", select: ["id"] }],
      });
      r.binds[0].init.onFrame({
        seq: 1,
        changes: [
          { op: "update", key: "5", row: { id: 5, body: "secret-ish" }, old: { id: 5, body: "o" } },
        ],
      });
      const [message] = c.socket.of("postgres_changes");
      const data = (message.payload as { data: Record<string, unknown> }).data;
      assertEquals(data.record, { id: 5 });
      assertEquals(data.old_record, { id: 5 });
      assertEquals(data.columns, [{ name: "id", type: "int8" }]);
      c.close();
      // Two a second per address, and an unknown address is not limited.
      assertEquals([r.hub.admitRest("198.51.100.1"), r.hub.admitRest("198.51.100.1")], [
        true,
        true,
      ]);
      assertEquals(r.hub.admitRest("198.51.100.1"), false);
      assertEquals(r.hub.admitRest("198.51.100.2"), true);
      assertEquals(r.hub.admitRest(undefined), true);
    } finally {
      await r.hub.stop();
    }
  },
});

Deno.test("realtime hub helpers: tablesFor and changeData", () => {
  const tables = [NOTES, ITEMS];
  assertEquals(tablesFor(tables, "public", "notes"), [NOTES]);
  assertEquals(tablesFor(tables, "app", undefined), [ITEMS]);
  assertEquals(tablesFor(tables, "*", "*"), tables);
  assertEquals(tablesFor(tables, null, null), tables);
  assertEquals(tablesFor(tables, "public", "items"), []);
  const data = changeData(ITEMS, [], {
    op: "update",
    key: "k",
    row: { sku: "k" },
    oldOverflow: true,
  });
  assertEquals(data.schema, "app");
  assertEquals(data.old_record, { sku: "k" });
  assertEquals(data.errors, ["Error 413: Payload Too Large"]);
  const ins = changeData(NOTES, [], { op: "insert", key: "1" });
  assertEquals(ins.record, { id: "1" });
  assertEquals(ins.errors, ["Error 413: Payload Too Large"]);
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

const ORIGIN = "https://app.test";
const CROSS = { origin: "https://elsewhere.test" };

Deno.test({
  name: "realtime HTTP: routing, upgrade refusals, REST broadcast",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    installRealtimeHub(undefined);
    assertEquals(handleRealtimeRequest(new Request(`${ORIGIN}/realtime/v1/websocket`)), null);
    await assertRejects(() => serverBroadcast("room", "e", 1), Error, "not configured");
    const r = rig();
    installRealtimeHub(r.hub);
    try {
      assertEquals(handleRealtimeRequest(new Request(`${ORIGIN}/elsewhere`)), null);
      assertEquals(
        (await handleRealtimeRequest(new Request(`${ORIGIN}/realtime/v1/websocket`)))!.status,
        426,
      );
      const upgrade = { upgrade: "websocket" };
      const badVsn = await upgradeSocket(
        r.hub,
        new Request(`${ORIGIN}/realtime/v1/websocket?vsn=9`, { headers: upgrade }),
      );
      assertEquals(badVsn.status, 400);

      // REST.
      const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
        handleRealtimeRequest(
          new Request(`${ORIGIN}/realtime/v1/api/broadcast${path}`, {
            method: "POST",
            body,
            headers: { ...CROSS, "content-type": "application/json", ...headers },
          }),
        )!;
      const options = await handleRealtimeRequest(
        new Request(`${ORIGIN}/realtime/v1/api/broadcast`, { method: "OPTIONS" }),
      )!;
      assertEquals(options.status, 204);
      assertEquals(options.headers.get("access-control-allow-origin"), "*");
      assertEquals(
        (await handleRealtimeRequest(new Request(`${ORIGIN}/realtime/v1/api/broadcast`))!).status,
        405,
      );

      const listener = r.open();
      await listener.join("realtime:room");
      const ok = await post(
        "",
        JSON.stringify({ messages: [{ topic: "room", event: "e", payload: { n: 1 } }] }),
      );
      assertEquals(ok.status, 202);
      assertEquals(listener.socket.sent.filter((d) => d instanceof Uint8Array).length, 1);
      const single = await post("/room/events/ping", JSON.stringify({ n: 2 }));
      assertEquals(single.status, 202);
      const bytes = await post("/room/events/bin", new Uint8Array([1, 2, 3]), {
        "content-type": "application/octet-stream",
      });
      assertEquals(bytes.status, 202);
      const frames = listener.socket.sent.filter((d): d is Uint8Array => d instanceof Uint8Array);
      assertEquals(frames.map((f) => decodeUserBroadcast(f).event), ["e", "ping", "bin"]);
      assertEquals(decodeUserBroadcast(frames[2]).payload, [1, 2, 3]);

      // Private: the caller (anon, cross-site) may not write.
      r.permsFor = () => ({ ...PUBLIC_PERMISSIONS, writeBroadcast: false });
      assertEquals((await post("/room/events/ping?private=true", "{}")).status, 403);
      assertEquals(
        (await post(
          "",
          JSON.stringify({ messages: [{ topic: "room", event: "e", private: true }] }),
        )).status,
        403,
      );
      const expired = jwt({ sub: A, exp: Math.floor(Date.now() / 1000) - 5 });
      assertEquals((await post("", "{}", { authorization: `Bearer ${expired}` })).status, 401);
      assertEquals((await post("", "nope")).status, 400);
      assertEquals((await post("", JSON.stringify({ messages: [] }))).status, 400);
      assertEquals((await post("/a/b", "{}")).status, 400);
      assertEquals(
        (await post(
          "",
          JSON.stringify({
            messages: Array.from({ length: 101 }, () => ({ topic: "r", event: "e" })),
          }),
        ))
          .status,
        400,
      );
      assertEquals(
        (await post("", JSON.stringify({ messages: [{ topic: "", event: "e" }] }))).status,
        400,
      );
      assertEquals(
        (await post("", JSON.stringify({ messages: [{ topic: "r", event: "" }] }))).status,
        400,
      );
      assertEquals(
        (await post("/room/events/big", JSON.stringify("x".repeat(300_000)))).status,
        413,
      );
      assertEquals(
        (await post("", "{}", { "content-length": String(2 * 1024 * 1024) })).status,
        413,
      );
      r.bus.fail = true;
      assertEquals((await post("/room/events/e", "1")).status, 503);
      r.bus.fail = false;

      // The server API.
      await serverBroadcast("room", "server", { from: "server" });
      assertEquals(listener.socket.sent.filter((d) => d instanceof Uint8Array).length, 4);
    } finally {
      installRealtimeHub(undefined);
      await r.hub.stop();
    }

    // Upgrade refusals that need the hub's state: full, and realtime unavailable.
    const full = rig({ maxConnections: 1 });
    full.open();
    const refusedFull = await upgradeSocket(
      full.hub,
      new Request(`${ORIGIN}/realtime/v1/websocket?vsn=2.0.0`, {
        headers: { upgrade: "websocket" },
      }),
    );
    assertEquals(refusedFull.status, 503);
    await full.hub.stop();
    const down = rig({}, { failStart: true });
    const original = console.error;
    console.error = () => {};
    try {
      const refusedDown = await upgradeSocket(
        down.hub,
        new Request(`${ORIGIN}/realtime/v1/websocket`, { headers: { upgrade: "websocket" } }),
      );
      assertEquals(refusedDown.status, 503);
    } finally {
      console.error = original;
      await down.hub.stop();
    }
  },
});

// ── Private-channel policy probe ─────────────────────────────────────────────

function probeClient(options: { deny?: string[]; hide?: string[]; failBegin?: Error } = {}) {
  const statements: string[] = [];
  let role = "";
  const tx = {
    unsafe: (text: string, params: unknown[] = []) => {
      statements.push(text);
      if (
        text.startsWith(
          "insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true), ",
        )
      ) {
        return Promise.resolve([{ id: "b", extension: "broadcast" }, {
          id: "p",
          extension: "presence",
        }]);
      }
      if (text.startsWith("select set_config('role'")) role = String(params[0]);
      if (text.startsWith("select extension from realtime.messages")) {
        if (options.hide?.includes("*")) return Promise.reject(new Error("permission denied"));
        return Promise.resolve(
          ["broadcast", "presence"].filter((e) => !options.hide?.includes(e)).map((extension) => ({
            extension,
          })),
        );
      }
      if (
        text.startsWith(
          "insert into realtime.messages (topic, extension, private) values ($1, $2, true)",
        )
      ) {
        return options.deny?.includes(String(params[1]))
          ? Promise.reject(new Error("new row violates row-level security policy"))
          : Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
  };
  const client = {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (options.failBegin) throw options.failBegin;
      statements.push("BEGIN");
      try {
        const out = await fn(tx);
        statements.push("COMMIT");
        return out;
      } catch (error) {
        statements.push("ROLLBACK");
        throw error;
      }
    },
  } as unknown as SqlClient;
  return { client, statements, role: () => role };
}

Deno.test("channelPermissions: the policies, probed as the user, always rolled back", async () => {
  const all = probeClient();
  assertEquals(await channelPermissions(all.client, scopeOf(A), "room", 1_234), PUBLIC_PERMISSIONS);
  assertEquals(all.role(), "authenticated");
  assertEquals(all.statements.at(-1), "ROLLBACK");
  assertEquals(all.statements.filter((s) => s === "savepoint denext_realtime_probe").length, 3);
  assert(all.statements.includes("select set_config('realtime.topic', $1, true)"));

  const some = probeClient({ deny: ["presence"], hide: ["broadcast"] });
  assertEquals(await channelPermissions(some.client, scopeOf(A), "room"), {
    readBroadcast: false,
    readPresence: true,
    writeBroadcast: true,
    writePresence: false,
  });
  assert(some.statements.includes("rollback to savepoint denext_realtime_probe"));

  const none = probeClient({ hide: ["*"], deny: ["broadcast", "presence"] });
  assertEquals(await channelPermissions(none.client, scopeOf(A), "room"), {
    readBroadcast: false,
    readPresence: false,
    writeBroadcast: false,
    writePresence: false,
  });
  await assertRejects(
    () =>
      channelPermissions(probeClient({ failBegin: new Error("no db") }).client, scopeOf(A), "r"),
    Error,
    "no db",
  );
});

// ── Identity ─────────────────────────────────────────────────────────────────

Deno.test({
  name: "realtime identity: tokens, subjects, the session",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fallback = userIdentity(A);
    assertEquals(await tokenIdentity(undefined, fallback), fallback);
    assertEquals(await tokenIdentity("", fallback), fallback);
    assertEquals(await tokenIdentity("not-a-jwt", fallback), fallback);
    assertEquals(await tokenIdentity("a.%%%.c", fallback), fallback);
    assertEquals(await tokenIdentity(`a.${btoa("1")}.c`, fallback), fallback, "not an object");
    const now = 1_700_000_000_000;
    assertEquals(await tokenIdentity(jwt({ exp: now / 1000 - 42 }), fallback, now), {
      expired: true,
      agoSeconds: 42,
      reason: "Token has expired 42 seconds ago",
    });
    assertEquals(await tokenIdentity(jwt({ exp: now / 1000 + 60 }), fallback, now), fallback);
    installAccessTokenVerifier((token) =>
      Promise.resolve(token === "good" ? userIdentity(B) : null)
    );
    try {
      assertEquals(await tokenIdentity("good", fallback), userIdentity(B));
      assertEquals(await tokenIdentity("bad", fallback), fallback);
    } finally {
      installAccessTokenVerifier(undefined);
    }
    assertEquals(subjectOf(ANON_SOCKET_IDENTITY), "anon");
    assertEquals(subjectOf(fallback), `authenticated:${A}`);
    assertEquals(subjectOf({ scope: { role: "authenticated", claims: "{" } }), "authenticated:?");

    // The session: anon outside a request; the signed-in user (with the session's expiry) inside.
    resetPlugins();
    resetChannels();
    installPostgres(undefined);
    installRealtime(undefined);
    const sql = fakeRealtimeClient({ notes: {} });
    await applyPlugins({
      projectRoot: "/tmp/x",
      appDir: "/tmp/x/app",
      config: {
        plugins: [
          denextAuth(authConfig),
          backend({ postgres: { sql, rls: { migrate: false } } }),
        ],
      } as DenextConfig,
      mode: "prod",
      load,
    });
    try {
      assertEquals((await sessionIdentity()).scope.role, "anon");
      const cookie = await cookieFor(A);
      const ctx = createRequestContext(new Request(`${ORIGIN}/`, { headers: { cookie } }));
      const identity = await runWithContext(ctx, () => sessionIdentity());
      assertEquals(subjectOf(identity), `authenticated:${A}`);
      assert(typeof identity.expiresAt === "number" && identity.expiresAt > Date.now());
      await settle(1);
    } finally {
      await runPluginTeardown();
      resetPlugins();
      installPostgres(undefined);
    }
  },
});

Deno.test("realtime identity with installed Supabase keys: tokens and API keys verified", async () => {
  const g = await generateSupabaseKeys({ legacy: true });
  const keys = await resolveSupabaseKeys({
    publishableKey: g.publishableKey,
    secretKey: g.secretKey,
    jwtSecret: g.jwtSecret,
    signingKeys: g.signingKey,
  });
  installSupabaseKeys(keys);
  try {
    const fallback = userIdentity(B);
    const now = Math.floor(Date.now() / 1000);
    const token = await signSupabaseJwt(keys, {
      sub: A,
      role: "authenticated",
      aud: "authenticated",
      iat: now,
      exp: now + 600,
    });
    const user = await tokenIdentity(token, fallback);
    assert(!("expired" in user));
    assertEquals(subjectOf(user), `authenticated:${A}`);
    assertEquals(user.expiresAt, (now + 600) * 1000);
    // An API key means "no user": the socket's own identity; the secret key is the service role.
    assertEquals(await tokenIdentity(g.publishableKey, fallback), fallback);
    assertEquals(await tokenIdentity(g.anonKey!, fallback), fallback);
    assertEquals(await tokenIdentity("opaque-value", fallback), fallback);
    assertEquals(
      subjectOf(await tokenIdentity(g.secretKey, fallback) as SocketIdentity),
      "service_role",
    );
    assertEquals(
      subjectOf(await tokenIdentity(g.serviceRoleKey!, fallback) as SocketIdentity),
      "service_role",
    );
    // Refused: a forged signature, an unknown sb_ key.
    const forged = await tokenIdentity(token.replace(/\.[^.]+$/, ".AAAA"), fallback);
    assert("expired" in forged && forged.agoSeconds === 0);
    assert("expired" in await tokenIdentity("sb_secret_nope", fallback));
    // The socket's apikey.
    assertEquals(await apiKeyRefusal(g.publishableKey), null);
    assertEquals(await apiKeyRefusal(g.anonKey!), null);
    assertEquals(await apiKeyRefusal(null), "No API key found in request");
    assert(await apiKeyRefusal("sb_publishable_nope"));
    assertEquals(await apiKeyRefusal("not-a-key"), "Invalid API key");
    // A cross-origin upgrade without a valid apikey is refused before the socket opens.
    const r = rig();
    try {
      for (const query of ["", "&apikey=sb_publishable_nope"]) {
        const refused = await upgradeSocket(
          r.hub,
          new Request(`${ORIGIN}/realtime/v1/websocket?vsn=1.0.0${query}`, {
            headers: { upgrade: "websocket", origin: "https://elsewhere.test" },
          }),
        );
        assertEquals(refused.status, 401, query);
        assert((await refused.json()).error);
      }
    } finally {
      await r.hub.stop();
    }
  } finally {
    installSupabaseKeys(undefined);
  }
  assertEquals(await apiKeyRefusal(null), null, "no keys installed: nothing to check");
});

// ── Round 2: server frames, stored broadcasts, replay, replication_ready, keyless same-origin ──

Deno.test("phoenix codec: server frames decoded; a broadcast's meta in both serializers", () => {
  const json = encodeBroadcast("2.0.0", "realtime:r", "e", { n: 1 }, { id: "m1" }) as Uint8Array;
  assertEquals(decodeServerFrame("2.0.0", json), {
    joinRef: null,
    ref: null,
    topic: "realtime:r",
    event: "broadcast",
    payload: { type: "broadcast", event: "e", payload: { n: 1 }, meta: { id: "m1" } },
  });
  const raw = encodeBroadcast("2.0.0", "realtime:r", "b", new Uint8Array([9, 8])) as Uint8Array;
  const decoded = decodeServerFrame("2.0.0", raw.buffer as ArrayBuffer)!;
  assertEquals([...((decoded.payload as { payload: Uint8Array }).payload)], [9, 8]);
  assertEquals((decoded.payload as { meta?: unknown }).meta, undefined);
  // vsn 1.0.0 carries meta in the JSON payload; text frames decode as either serializer.
  const v1 = encodeBroadcast("1.0.0", "realtime:r", "e", 1, { replayed: true, id: "x" }) as string;
  assertEquals(decodeServerFrame("1.0.0", v1)!.payload, {
    type: "broadcast",
    event: "e",
    payload: 1,
    meta: { replayed: true, id: "x" },
  });
  const v2 = encodeMessage("2.0.0", {
    joinRef: "1",
    ref: "2",
    topic: "phoenix",
    event: "phx_reply",
    payload: {},
  });
  assertEquals(decodeServerFrame("2.0.0", v2)!.event, "phx_reply");
  // Meta over 255 bytes cannot ride a binary frame: JSON instead.
  const big = encodeBroadcast("2.0.0", "realtime:r", "e", 1, { id: "x".repeat(300) });
  assertEquals(typeof big, "string");
  // Malformed: another kind, a short or truncated frame, bad JSON.
  assertEquals(decodeServerFrame("2.0.0", new Uint8Array([3, 0, 0, 0, 1])), null);
  assertEquals(decodeServerFrame("2.0.0", new Uint8Array([4, 1])), null);
  assertEquals(decodeServerFrame("2.0.0", new Uint8Array([4, 9, 9, 0, 1, 65])), null);
  assertEquals(decodeServerFrame("2.0.0", new Uint8Array([4, 1, 1, 0, 1, 65, 66, 123])), null);
});

Deno.test({
  name:
    "realtime bus on Postgres: a private broadcast is stored (inline id or by id); replay reads",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fake = busClient();
    const bus = postgresBus({
      client: () => fake.client,
      instance: "00000000-0000-4000-8000-000000000009",
      ready: () => Promise.resolve(),
      handlers: {
        broadcast: () => {},
        presence: () => {},
        presenceReload: () => {},
        resync: () => {},
      },
    });
    await bus.broadcast({
      topic: "priv",
      private: true,
      event: "e",
      payload: { n: 1 },
      exclude: "c",
    });
    const inserts = fake.statements.filter(([t]) => t.startsWith("insert into realtime.messages"));
    assertEquals(inserts.length, 1, "stored even though it fits a notification");
    assertEquals(fake.notifies().at(-1), {
      k: "b",
      t: "priv",
      e: "e",
      p: { n: 1 },
      pr: true,
      x: "c",
      id: "m-1",
    });
    await bus.broadcast({ topic: "priv", private: true, event: "big", payload: "x".repeat(9_000) });
    assertEquals(fake.notifies().at(-1), { k: "m", id: "m-1" });
    // A public broadcast that fits is not stored.
    await bus.broadcast({ topic: "pub", private: false, event: "e", payload: 1 });
    assertEquals(
      fake.statements.filter(([t]) => t.startsWith("insert into realtime.messages")).length,
      2,
    );
    fake.answers.replay = [
      { id: "a", event: "one", payload: '{"n":1}' },
      { id: "b", event: null, payload: { __denext_binary: "AQI=" } },
    ];
    const replayed = await bus.replay("priv", 1_700_000_000_000, 25);
    assertEquals(replayed[0], { id: "a", event: "one", payload: { n: 1 } });
    assertEquals(replayed[1].event, "");
    assertEquals([...(replayed[1].payload as Uint8Array)], [1, 2]);
    const [, params] = fake.statements.find(([t]) => t.startsWith("select id::text as id"))!;
    assertEquals(params, ["priv", 1_700_000_000_000, 25]);
    // receiveBus passes a stored message's id along.
    const got: BusBroadcast[] = [];
    await receiveBus(
      JSON.stringify({ k: "b", t: "priv", e: "e", p: 1, pr: true, id: "z" }),
      {
        broadcast: (m) => got.push(m),
        presence: () => {},
        presenceReload: () => {},
        resync: () => {},
      },
      () => Promise.resolve(null),
    );
    assertEquals(got[0].id, "z");
  },
});

Deno.test({
  name: "realtime hub: replay to a private channel, replication_ready, stored ids as meta",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const r = rig();
    try {
      const sender = r.open(userIdentity(A));
      const joined = await sender.join("realtime:priv", { private: true });
      assertEquals(statusOf(joined), "ok");
      const since = Date.now() - 1;
      for (const n of [1, 2]) {
        sender.send(joined.joinRef, String(100 + n), "realtime:priv", "broadcast", {
          type: "broadcast",
          event: `e${n}`,
          payload: { n },
        });
      }
      await until(() => r.bus.stored.length === 2);

      // vsn 1.0.0, limit 1, replication_ready.
      const one = r.open(userIdentity(A), "1.0.0");
      await one.join("realtime:priv", {
        private: true,
        broadcast: { replay: { since, limit: 1 }, replication_ready: true },
      });
      await until(() => one.socket.of("broadcast").length === 1);
      const replayed = one.socket.of("broadcast")[0].payload as {
        event: string;
        meta: { replayed: boolean; id: string };
      };
      assertEquals([replayed.event, replayed.meta.replayed], ["e1", true]);
      assertEquals(replayed.meta.id, r.bus.stored[0].id);
      assert(
        one.socket.of("system").some((m) =>
          (m.payload as { message: string }).message === "Replication connection established"
        ),
      );

      // vsn 2.0.0: binary frames with meta; a limit over 25 is capped.
      for (let i = 0; i < 30; i++) {
        r.bus.stored.push({
          topic: "priv",
          at: Date.now(),
          id: `s${i}`,
          event: "bulk",
          payload: i,
        });
      }
      const two = r.open(userIdentity(A));
      await two.join("realtime:priv", {
        private: true,
        broadcast: { replay: { since, limit: 99 } },
      });
      const binaries = () =>
        two.socket.sent.filter((d): d is Uint8Array => d instanceof Uint8Array).map((f) =>
          decodeServerFrame("2.0.0", f)!.payload as {
            event: string;
            meta?: Record<string, unknown>;
          }
        );
      await until(() => binaries().length === 25);
      assert(binaries().every((b) => b.meta?.replayed === true));
      // A live private broadcast carries its stored id, not `replayed`.
      sender.send(joined.joinRef, "200", "realtime:priv", "broadcast", {
        type: "broadcast",
        event: "live",
        payload: 1,
      });
      await until(() => binaries().length === 26);
      assertEquals(binaries()[25].meta, { id: r.bus.stored.at(-1)!.id });

      // No replay: a public channel, or a private one that may not read broadcasts.
      const pub = r.open(userIdentity(A));
      await pub.join("realtime:priv", { broadcast: { replay: { since } } });
      r.permsFor = () => ({ ...PUBLIC_PERMISSIONS, readBroadcast: false });
      const blind = r.open(userIdentity(A));
      await blind.join("realtime:priv", { private: true, broadcast: { replay: { since } } });
      const noLimit = r.open(userIdentity(A));
      r.permsFor = () => PUBLIC_PERMISSIONS;
      await noLimit.join("realtime:priv", { private: true, broadcast: { replay: { since: "x" } } });
      await settle(30);
      for (const c of [pub, blind, noLimit]) {
        assertEquals(c.socket.sent.filter((d) => d instanceof Uint8Array).length, 0);
      }
    } finally {
      await r.hub.stop();
    }
  },
});

Deno.test({
  name: "realtime upgrade with Supabase keys: a same-origin socket may omit the apikey",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const g = await generateSupabaseKeys();
    installSupabaseKeys(
      await resolveSupabaseKeys({
        publishableKey: g.publishableKey,
        secretKey: g.secretKey,
        signingKeys: g.signingKey,
      }),
    );
    resetPlugins();
    installPostgres(undefined);
    await applyPlugins({
      projectRoot: "/tmp/x",
      appDir: "/tmp/x/app",
      config: {
        plugins: [backend({ postgres: { sql: fakeRealtimeClient({}), rls: { migrate: false } } })],
      } as DenextConfig,
      mode: "prod",
      load,
    });
    const r = rig();
    try {
      const upgrade = (query: string, headers: Record<string, string> = {}) =>
        upgradeSocket(
          r.hub,
          new Request(`${ORIGIN}/realtime/v1/websocket?vsn=1.0.0${query}`, {
            headers: { upgrade: "websocket", host: "app.test", ...headers },
          }),
        );
      // Past the key check, a plain Request cannot really be upgraded: 400 means "accepted".
      assertEquals((await upgrade("")).status, 400, "same origin (no Origin), no key");
      assertEquals((await upgrade("", { origin: ORIGIN })).status, 400, "same origin, no key");
      assertEquals((await upgrade("", CROSS)).status, 401, "cross-origin needs the key");
      assertEquals((await upgrade(`&apikey=${g.publishableKey}`, CROSS)).status, 400);
      assertEquals(
        (await upgrade("&apikey=sb_publishable_nope")).status,
        401,
        "a bad key: refused",
      );
    } finally {
      installSupabaseKeys(undefined);
      await r.hub.stop();
      await runPluginTeardown();
      resetPlugins();
      installPostgres(undefined);
    }
  },
});

Deno.test("phoenix codec: a client's binary broadcast push round-trips through the server decoder", () => {
  const bytes = encodeBroadcastPush("1", "2", "realtime:r", "bin", new Uint8Array([1, 2]));
  assertEquals(decodeFrame("2.0.0", bytes), {
    joinRef: "1",
    ref: "2",
    topic: "realtime:r",
    event: "broadcast",
    payload: { type: "broadcast", event: "bin", payload: new Uint8Array([1, 2]) },
  });
  const json = encodeBroadcastPush("1", "3", "realtime:r", "j", { a: 1 });
  assertEquals((decodeFrame("2.0.0", json)!.payload as { payload: unknown }).payload, { a: 1 });
  assertThrows(
    () => encodeBroadcastPush("1", "2", "realtime:" + "x".repeat(260), "e", 1),
    RangeError,
  );
});

Deno.test({
  name: "realtime hub: the admin snapshot — channels, subscribers, bindings; presence keys apart",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const r = rig();
    try {
      const a = r.open(userIdentity(A));
      const b = r.open();
      await a.join("realtime:db", {
        postgres_changes: [
          { event: "INSERT", schema: "public", table: "notes", filter: "id=gte.5" },
        ],
      });
      const jb = await b.join("realtime:lobby", { presence: { key: "visitor-1" } });
      await r.open().join("realtime:lobby");
      b.send(jb.joinRef, "t1", "realtime:lobby", "presence", {
        type: "presence",
        event: "track",
        payload: { secret: "do-not-list" },
      });
      await until(() => b.socket.replyTo("t1") !== undefined);
      const state = r.hub.adminState();
      assertEquals(state.connections, 3);
      assertEquals(state.channels, [
        { topic: "db", private: false, subscribers: 1 },
        { topic: "lobby", private: false, subscribers: 2 },
      ]);
      assertEquals(state.bindings, [
        { topic: "db", tables: ["notes"], filter: "id=gte.5", events: ["insert"] },
      ]);
      // Keys only: a tracked payload never travels with them.
      const keys = await r.hub.presenceKeys("lobby", false);
      assertEquals(keys, { "visitor-1": 1 });
      assert(!JSON.stringify(state).includes("do-not-list"));
      // An operator expanding that one key gets its payload.
      assertEquals(await r.hub.presenceOf("lobby", false, "visitor-1"), [{
        secret: "do-not-list",
      }]);
      assertEquals(await r.hub.presenceOf("lobby", false, "nobody"), []);
    } finally {
      await r.hub.stop();
    }
  },
});
