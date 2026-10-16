// A channel's replay log (`createChannel({ history })`, src/runtime/channel-log.ts): the bounded
// in-memory log, the shared Redis log `redisChannelTransport` brings
// (src/server/redis-channel-log.ts, on the in-process fake Redis), and the Live hub's replay
// (src/server/live-channels.ts): a late subscriber passing `since` gets its key's history after
// `authorize`, never another key's or a refused one's; replay and live never double up; a burst
// is delivered whole; a back-pressured subscriber resumes from the log.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  compareCursors,
  inMemoryChannelLog,
  isCursor,
  resolveHistory,
} from "../src/runtime/channel-log.ts";
import {
  channelLog,
  createChannel,
  resetChannels,
  setChannelTransport,
} from "../src/runtime/channel.ts";
import { type ChannelConn, createChannelHub } from "../src/server/live-channels.ts";
import { redisChannelTransport } from "../src/server/redis-pubsub.ts";
import { redisChannelLog } from "../src/server/redis-channel-log.ts";
import { redisClient } from "../src/server/redis.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

const H = (size: number, ttlSeconds = 60) => ({ size, ttlSeconds });
const entry = (n: number) => ({ encoded: JSON.stringify({ n }) });

Deno.test("resolveHistory / cursors: validated retention, numeric cursor order", () => {
  assertEquals(resolveHistory(undefined), undefined);
  assertEquals(resolveHistory(5), { size: 5, ttlSeconds: 86400 });
  assertEquals(resolveHistory({ size: 2, ttlSeconds: 10 }), { size: 2, ttlSeconds: 10 });
  assertThrows(() => resolveHistory(0), TypeError);
  assertThrows(() => resolveHistory(1001), TypeError);
  assertThrows(() => resolveHistory({ size: 3, ttlSeconds: 0 }), TypeError);
  assert(compareCursors("10", "9") > 0, "by value, not by string");
  assert(compareCursors("0", "1") < 0);
  assertEquals(compareCursors("42", "42"), 0);
  assert(isCursor("0") && isCursor("1760000000000001"));
  assert(!isCursor("") && !isCursor("1e3") && !isCursor(7) && !isCursor("1".repeat(21)));
});

Deno.test("inMemoryChannelLog: per-key order and size, cursors after a cursor", async () => {
  const log = inMemoryChannelLog();
  const cursors: string[] = [];
  for (let n = 1; n <= 5; n++) cursors.push(await log.append("c", "k", entry(n), H(3)));
  await log.append("c", "other", entry(99), H(3));
  for (let i = 1; i < cursors.length; i++) assert(compareCursors(cursors[i], cursors[i - 1]) > 0);
  const all = await log.since("c", "k", "0", 3);
  assertEquals(all.map((e) => JSON.parse(e.encoded).n), [3, 4, 5], "the last `size` per key");
  assertEquals(all.map((e) => e.cursor), cursors.slice(2));
  assertEquals((await log.since("c", "k", cursors[3], 3)).map((e) => e.cursor), [cursors[4]]);
  assertEquals(await log.since("c", "k", cursors[4], 3), []);
  assertEquals((await log.since("c", "k", "0", 2)).length, 2, "`limit` keeps the newest");
  assertEquals(await log.since("c", "missing", "0", 3), []);
});

Deno.test("inMemoryChannelLog: bounded by keys, by bytes and by TTL", async () => {
  const keys = inMemoryChannelLog({ maxKeys: 2 });
  await keys.append("c", "a", entry(1), H(5));
  await keys.append("c", "b", entry(2), H(5));
  await keys.append("c", "c", entry(3), H(5)); // evicts the least recently published key, "a"
  assertEquals(await keys.since("c", "a", "0", 5), []);
  assertEquals((await keys.since("c", "c", "0", 5)).length, 1);

  const bytes = inMemoryChannelLog({ maxBytes: 200 });
  const big = { encoded: JSON.stringify("x".repeat(60)) }; // ~124 bytes as UTF-16
  await bytes.append("c", "a", big, H(5));
  await bytes.append("c", "b", big, H(5));
  assertEquals(await bytes.since("c", "a", "0", 5), [], "the older key went over the byte cap");
  assertEquals((await bytes.since("c", "b", "0", 5)).length, 1);

  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const ttl = inMemoryChannelLog();
    await ttl.append("c", "k", entry(1), H(5, 10));
    now += 5_000;
    await ttl.append("c", "k", entry(2), H(5, 10));
    now += 6_000; // the first is 11 s old, the second 6 s
    assertEquals((await ttl.since("c", "k", "0", 5)).map((e) => JSON.parse(e.encoded).n), [2]);
  } finally {
    Date.now = realNow;
  }
});

type Conn = ChannelConn & { frames: Record<string, unknown>[]; errors: string[] };

/** A channel hub over fake primitives that records every frame it sends. */
function fakeHub(opts: { pressured?: () => boolean } = {}) {
  let recover: (() => void) | null = null;
  const hub = createChannelHub<Conn>({
    limits: () => ({ maxChannelsPerConnection: 16, channelAuthTtlSeconds: 300 }),
    sendFrame: (conn, text) => conn.frames.push(JSON.parse(text)),
    sendError: (conn, code, _reason, extra) => conn.errors.push(`${code}:${extra?.subId}`),
    refuse: (conn, decision) => conn.errors.push(decision),
    withConnContext: (_conn, fn) => Promise.resolve(fn()),
    connContext: (conn) => ({ origin: "", url: "", cookie: "", peerId: conn.peerId }),
    isConnected: () => true,
    withRenderSlot: (fn) => fn(),
    backPressured: () => opts.pressured?.() ?? false,
    armRecover: (conn) => (recover = () => hub.replayPending(conn)),
  });
  const conn = (peerId: string): Conn => ({
    socket: {} as WebSocket,
    channelSubs: new Map(),
    peerId,
    frames: [],
    errors: [],
  });
  return { hub, conn, drain: () => recover?.() };
}

/** The payloads of `conn`'s channel frames. */
const values = (conn: Conn) =>
  conn.frames.filter((f) => f.type === "channel").map((f) => (f.value as { n: number }).n);

/** Feed every publish on the installed transport to `hub`, and let the 16 ms flush run. */
function wire(hub: ReturnType<typeof fakeHub>["hub"]) {
  const transport = {
    publish: (ev: Parameters<typeof hub.deliver>[0]) => hub.deliver(ev),
    subscribe: () => () => {},
  };
  setChannelTransport(transport);
  return () => new Promise((resolve) => setTimeout(resolve, 40));
}

Deno.test("channel replay: a late subscriber with `since` gets its key's history, then live", async () => {
  resetChannels();
  const { hub, conn } = fakeHub();
  const flush = wire(hub);
  const ch = createChannel<{ n: number }>({ id: "log", authorize: () => true, history: 3 });
  for (let n = 1; n <= 5; n++) await ch.publish("k", { n });
  await ch.publish("other", { n: 99 });
  await flush();

  const late = conn("late");
  await hub.subscribe(late, { subId: "s", channelId: "log", key: "k", since: "0" });
  assertEquals(values(late), [3, 4, 5], "the retained history of ITS key, oldest first");
  assertEquals(late.frames[0].type, "channel-ready", "registered before the replay");
  const cursors = late.frames.filter((f) => f.type === "channel").map((f) => f.cursor as string);
  assert(cursors.every(isCursor));

  // Without `since`: no replay (the old contract).
  const plain = conn("plain");
  await hub.subscribe(plain, { subId: "s", channelId: "log", key: "k" });
  assertEquals(values(plain), []);

  // From a cursor: only what came after it.
  const resumed = conn("resumed");
  await hub.subscribe(resumed, { subId: "s", channelId: "log", key: "k", since: cursors[1] });
  assertEquals(values(resumed), [5]);

  // Live pushes follow — every publish of a burst, each once.
  await ch.publish("k", { n: 6 });
  await ch.publish("k", { n: 7 });
  await flush();
  assertEquals(values(late), [3, 4, 5, 6, 7]);
  assertEquals(values(plain), [6, 7], "a logged burst is not coalesced to its latest");
  hub.dispose();
  resetChannels();
});

Deno.test("channel replay: authorization gates it — a refused subscriber replays nothing", async () => {
  resetChannels();
  const { hub, conn } = fakeHub();
  const flush = wire(hub);
  const ch = createChannel<{ n: number }>({
    id: "secret",
    authorize: (ctx, key) => key === `user:${ctx.peerId}`,
    history: 10,
  });
  await ch.publish("user:alice", { n: 1 });
  await ch.publish("user:bob", { n: 2 });
  await flush();
  const mallory = conn("mallory");
  await hub.subscribe(mallory, { subId: "s", channelId: "secret", key: "user:alice", since: "0" });
  assertEquals(values(mallory), []);
  assertEquals(mallory.errors, ["deny"]);
  const alice = conn("alice");
  await hub.subscribe(alice, { subId: "s", channelId: "secret", key: "user:alice", since: "0" });
  assertEquals(values(alice), [1], "only her own key's entries");
  // A malformed `since` is no replay, not an error.
  const odd = conn("alice");
  await hub.subscribe(odd, { subId: "s", channelId: "secret", key: "user:alice", since: "x" });
  assertEquals(values(odd), []);
  assertEquals(odd.errors, []);
  hub.dispose();
  resetChannels();
});

Deno.test("channel replay: a lapsed authorization is re-checked before replaying", async () => {
  resetChannels();
  const { hub, conn } = fakeHub();
  const flush = wire(hub);
  let allowed = true;
  const ch = createChannel<{ n: number }>({
    id: "ttl",
    authorize: () => allowed,
    authTtlSeconds: 0,
    history: 5,
  });
  await ch.publish("k", { n: 1 });
  await flush();
  const c = conn("p");
  await hub.subscribe(c, { subId: "s", channelId: "ttl", key: "k" });
  allowed = false;
  // Its drain-time resume replays from the log only if `authorize` still says yes.
  const sub = c.channelSubs.get("s")!;
  sub.cursor = "0";
  sub.pending = "{}";
  c.recoverChannels = new Set(["s"]);
  hub.replayPending(c);
  await flush();
  assertEquals(values(c), []);
  assertEquals(c.errors, ["denied:s"]);
  assertEquals(c.channelSubs.size, 0);
  hub.dispose();
  resetChannels();
});

Deno.test("channel replay: a back-pressured subscriber resumes every shed publish from the log", async () => {
  resetChannels();
  let pressured = false;
  const { hub, conn, drain } = fakeHub({ pressured: () => pressured });
  const flush = wire(hub);
  const ch = createChannel<{ n: number }>({ id: "bp", authorize: () => true, history: 10 });
  const c = conn("p");
  await hub.subscribe(c, { subId: "s", channelId: "bp", key: "k" });
  await ch.publish("k", { n: 1 });
  await flush();
  pressured = true;
  for (let n = 2; n <= 4; n++) await ch.publish("k", { n });
  await flush();
  assertEquals(values(c), [1], "held back while the socket is full");
  pressured = false;
  drain();
  await flush();
  assertEquals(values(c), [1, 2, 3, 4], "all of them, not just the latest");
  hub.dispose();
  resetChannels();
});

Deno.test("channel without history: unchanged — no cursor, latest wins in a burst", async () => {
  resetChannels();
  const { hub, conn } = fakeHub();
  const flush = wire(hub);
  const ch = createChannel<{ n: number }>({ id: "plain", authorize: () => true });
  const c = conn("p");
  await hub.subscribe(c, { subId: "s", channelId: "plain", key: "k", since: "0" });
  await ch.publish("k", { n: 1 });
  await ch.publish("k", { n: 2 });
  await flush();
  assertEquals(values(c), [2]);
  assertEquals(c.frames.at(-1)?.cursor, undefined);
  hub.dispose();
  resetChannels();
});

Deno.test("redisChannelLog: one log every replica shares, trimmed and expiring", async () => {
  const server = fakeRedis();
  const a = redisClient(server.url);
  const b = redisClient(server.url);
  try {
    const logA = redisChannelLog(a, { prefix: "t" });
    const logB = redisChannelLog(b, { prefix: "t" });
    const c1 = await logA.append("c", "k", entry(1), H(2));
    const c2 = await logB.append("c", "k", { encoded: '{"n":2}', enc: 1 }, H(2));
    const c3 = await logA.append("c", "k", entry(3), H(2));
    assert(compareCursors(c2, c1) > 0 && compareCursors(c3, c2) > 0, "one counter for all");
    assert(Number(c1) > Date.now() * 1000 - 60_000_000, "seeded from the clock");
    const seen = await logB.since("c", "k", "0", 10);
    assertEquals(seen.map((e) => e.encoded), ['{"n":2}', '{"n":3}'], "trimmed to `size`");
    assertEquals(seen[0].enc, 1);
    assertEquals((await logA.since("c", "k", c2, 10)).map((e) => e.cursor), [c3]);
    const zset = server.peek("t:c:k");
    assertEquals(zset?.type, "zset");
    assert(zset?.expireAt !== undefined, "the key expires");
  } finally {
    await a.close();
    await b.close();
    await server.close();
  }
});

Deno.test("redisChannelTransport: brings the shared log; a late subscriber replays across replicas", async () => {
  const server = fakeRedis();
  const a = redisChannelTransport({ url: server.url, channel: "rl" });
  const b = redisChannelTransport({ url: server.url, channel: "rl" });
  const off = redisChannelTransport({ url: server.url, channel: "rl", log: false });
  try {
    await Promise.all([a.ready(), b.ready(), off.ready()]);
    assert(a.log && b.log);
    assertEquals(off.log, undefined, "`log: false` keeps each instance's own");
    resetChannels();
    setChannelTransport(a); // replica A publishes…
    const ch = createChannel<{ n: number }>({ id: "x", authorize: () => true, history: 5 });
    await ch.publish("k", { n: 1 });
    await ch.publish("k", { n: 2 });
    setChannelTransport(b); // …replica B's subscriber replays it
    const { hub, conn } = fakeHub();
    const c = conn("p");
    await hub.subscribe(c, { subId: "s", channelId: "x", key: "k", since: "0" });
    assertEquals(values(c), [1, 2]);
    assertEquals(channelLog(), b.log);
    hub.dispose();
  } finally {
    resetChannels();
    await a.close();
    await b.close();
    await off.close();
    await server.close();
  }
});

Deno.test("channel publish: a failing log costs the replay, never the live delivery", async () => {
  resetChannels();
  const delivered: unknown[] = [];
  setChannelTransport({
    publish: (ev) => void delivered.push(ev),
    subscribe: () => () => {},
    log: {
      append: () => Promise.reject(new Error("down")),
      since: () => Promise.resolve([]),
    },
  });
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const ch = createChannel<{ n: number }>({ id: "f", authorize: () => true, history: 2 });
    await ch.publish("k", { n: 1 });
    await ch.publish("k", { n: 2 });
    assertEquals(delivered.length, 2);
    assertEquals((delivered[0] as { cursor?: string }).cursor, undefined);
    assertEquals(warnings.length, 1, "warned once");
  } finally {
    console.warn = warn;
    resetChannels();
  }
});

// ---- the browser side: `since` on the wire, dedupe by cursor, resume on reconnect -------------

/** A stand-in browser WebSocket that records sent frames. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  subscribes() {
    return this.sent.map((s) => JSON.parse(s)).filter((f) => f.type === "channel-subscribe");
  }
}

Deno.test("subscribeChannel: sends `since`, skips a seen cursor, resumes from the last on reconnect", async () => {
  const { subscribeChannel } = await import("../src/client/live-client.ts");
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const [ws0, loc0] = [g.WebSocket, g.location];
  g.WebSocket = FakeSocket;
  g.location = { protocol: "http:", host: "localhost:8000", href: "http://localhost:8000/" };
  try {
    const got: Array<[unknown, string | undefined]> = [];
    const off = subscribeChannel(
      "ch",
      "k",
      (v, _seq, cursor) => got.push([v, cursor]),
      () => {},
      undefined,
      "0",
    );
    const ws = FakeSocket.last!;
    ws.open();
    const [first] = ws.subscribes();
    assertEquals(first.since, "0", "a replay from everything retained");
    const subId = first.subId as string;
    ws.emit({ type: "channel", subId, seq: 0, value: 1, cursor: "9" });
    ws.emit({ type: "channel", subId, seq: 0, value: 2, cursor: "10" });
    ws.emit({ type: "channel", subId, seq: 0, value: 1, cursor: "9" }); // seen: skipped
    assertEquals(got, [[1, "9"], [2, "10"]]);
    ws.open(); // a reconnect re-sends every subscription
    assertEquals(ws.subscribes().at(-1)?.since, "10", "resumes after the last cursor");
    off();

    // A plain subscription sends no `since` until a logged push gives it a cursor.
    const off2 = subscribeChannel("ch", "k", () => {}, () => {});
    const ws2 = FakeSocket.last!;
    ws2.open();
    const plain = ws2.subscribes().at(-1)!;
    assertEquals(plain.since, undefined);
    ws2.emit({ type: "channel", subId: plain.subId, seq: 1, value: 3 });
    ws2.open();
    assertEquals(ws2.subscribes().at(-1)?.since, undefined, "no cursor, no resume");
    ws2.emit({ type: "channel", subId: plain.subId, seq: 0, value: 4, cursor: "12" });
    ws2.open();
    assertEquals(ws2.subscribes().at(-1)?.since, "12");
    off2();
  } finally {
    g.WebSocket = ws0;
    if (loc0 === undefined) delete g.location;
    else g.location = loc0;
  }
});
