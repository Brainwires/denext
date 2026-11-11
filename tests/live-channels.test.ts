// The Live hub's channel half (`createChannelHub`), driven directly with fake hub primitives.

import { assert, assertEquals } from "@std/assert";
import {
  type ChannelEvent,
  channelEventDiscarded,
  createChannel,
  inMemoryChannelTransport,
  resetChannels,
  setChannelTransport,
} from "../src/runtime/channel.ts";
import { type ChannelConn, createChannelHub } from "../src/server/live-channels.ts";
import { enableLiveDevtools, liveRecords, resetLiveDevtools } from "../src/server/live-devtools.ts";

type Conn = ChannelConn & { errors: string[] };

function fakeHub() {
  const hub = createChannelHub<Conn>({
    limits: () => ({ maxChannelsPerConnection: 16, channelAuthTtlSeconds: 300 }),
    sendFrame: () => {},
    sendError: (conn, code, _reason, extra) => conn.errors.push(`${code}:${extra?.subId}`),
    refuse: (conn, decision) => conn.errors.push(decision),
    withConnContext: (_conn, fn) => Promise.resolve(fn()),
    connContext: (conn) => ({ origin: "", url: "", cookie: "", peerId: conn.peerId }),
    isConnected: () => true,
    withRenderSlot: (fn) => fn(),
    backPressured: () => false,
    armRecover: () => {},
  });
  const conn = (i: number): Conn => ({
    socket: {} as WebSocket,
    channelSubs: new Map(),
    peerId: `p${i}`,
    errors: [],
  });
  return { hub, conn };
}

Deno.test("channel hub: dropping one connection de-indexes without scanning the key's subscribers", async () => {
  resetChannels();
  createChannel<{ n: number }>({ id: "hot", authorize: () => true });
  const { hub, conn } = fakeHub();
  const conns = Array.from({ length: 500 }, (_, i) => conn(i));
  for (const c of conns) await hub.subscribe(c, { subId: "s", channelId: "hot", key: "k" });

  // Count iterations of any large Set while the one connection drops: the de-index is a Set
  // delete through the subscription's own index entry, never a walk of every subscriber on the
  // key (a mass disconnect on a hot key was O(subscribers · disconnects)).
  const proto = Set.prototype as unknown as Record<PropertyKey, unknown>;
  const originals = new Map<PropertyKey, unknown>();
  let scans = 0;
  for (const name of [Symbol.iterator, "values", "keys", "entries", "forEach"]) {
    const original = proto[name] as (this: Set<unknown>, ...args: unknown[]) => unknown;
    originals.set(name, original);
    proto[name] = function (this: Set<unknown>, ...args: unknown[]) {
      if (this.size >= 100) scans++;
      return original.apply(this, args);
    };
  }
  try {
    hub.drop(conns[250]);
  } finally {
    for (const [name, original] of originals) proto[name] = original;
  }
  assertEquals(scans, 0);
  assertEquals(conns[250].channelSubs.size, 0);

  // The index lost exactly that subscriber: a revoke reaches the other 499, not the dropped one.
  hub.deliver({ kind: "revoke", channelId: "hot", key: "k", seq: 0, instance: "other" });
  assertEquals(conns[250].errors, []);
  assertEquals(conns.filter((c) => c.errors.length === 1).length, 499);
  hub.dispose();
  resetChannels();
});

Deno.test("channel hub: authorize sees ctx.resubscribe on a subscription the client re-sends", async () => {
  resetChannels();
  const seen: (boolean | undefined)[] = [];
  createChannel<{ n: number }>({
    id: "again",
    authorize: (ctx) => {
      seen.push(ctx.resubscribe);
      return true;
    },
  });
  const { hub, conn } = fakeHub();
  const c = conn(1);
  await hub.subscribe(c, { subId: "s", channelId: "again", key: "k" });
  hub.drop(c);
  const back = conn(2);
  await hub.subscribe(back, { subId: "s", channelId: "again", key: "k", resubscribe: true });
  // Anything but `true` is no mark.
  await hub.subscribe(conn(3), { subId: "s", channelId: "again", key: "k", resubscribe: "yes" });
  assertEquals(seen, [undefined, true, undefined]);
  hub.dispose();
  resetChannels();
});

Deno.test("channel hub: onIdle says whether the key was unsubscribed or its connection closed", async () => {
  resetChannels();
  const events: string[] = [];
  createChannel<{ n: number }>({
    id: "why",
    authorize: () => true,
    onActive: (key) => events.push(`active:${key}`),
    onIdle: (key, reason) => events.push(`idle:${key}:${reason}`),
  });
  const { hub, conn } = fakeHub();
  const [a, b] = [conn(1), conn(2)];
  await hub.subscribe(a, { subId: "s", channelId: "why", key: "k" });
  hub.unsubscribe(a, "s");
  await hub.subscribe(b, { subId: "s", channelId: "why", key: "j" });
  hub.drop(b);
  assertEquals(events, ["active:k", "idle:k:unsubscribe", "active:j", "idle:j:disconnect"]);

  // Re-subscribing the same key under the same id never takes the key through idle; a different
  // key under that id makes the old one idle (as an unsubscribe) after the new one is active.
  events.length = 0;
  await hub.subscribe(a, { subId: "s", channelId: "why", key: "k" });
  await hub.subscribe(a, { subId: "s", channelId: "why", key: "k" });
  await hub.subscribe(a, { subId: "s", channelId: "why", key: "other" });
  assertEquals(events, ["active:k", "active:other", "idle:k:unsubscribe"]);
  assertEquals(a.channelSubs.size, 1);
  hub.dispose();
  assertEquals(events.at(-1), "idle:other:disconnect");
  resetChannels();
});

Deno.test("channel hub: onActive fires for a key's first local subscriber, onIdle when its last leaves", async () => {
  resetChannels();
  const events: string[] = [];
  createChannel<{ n: number }>({
    id: "life",
    authorize: () => true,
    onActive: (key) => events.push(`active:${key}`),
    onIdle: (key) => {
      events.push(`idle:${key}`);
      throw new Error("a throwing hook is logged, not propagated");
    },
  });
  const { hub, conn } = fakeHub();
  const [a, b] = [conn(1), conn(2)];
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    await hub.subscribe(a, { subId: "s", channelId: "life", key: "k" });
    await hub.subscribe(b, { subId: "s", channelId: "life", key: "k" });
    await hub.subscribe(a, { subId: "t", channelId: "life", key: "other" });
    assertEquals(events, ["active:k", "active:other"]);
    hub.unsubscribe(a, "s");
    assertEquals(events.length, 2, "b still holds k");
    hub.drop(b);
    assertEquals(events.slice(2), ["idle:k"]);
    assertEquals(errors.length, 1);
    hub.dispose(); // the remaining key goes idle with the hub
    assertEquals(events.slice(3), ["idle:other"]);
  } finally {
    console.error = original;
    resetChannels();
  }
});

/** A hub recording each connection's `channel` frames (their `value`), in order. */
function recordingHub() {
  const frames = new Map<string, unknown[]>();
  const hub = createChannelHub<Conn>({
    limits: () => ({ maxChannelsPerConnection: 16, channelAuthTtlSeconds: 300 }),
    sendFrame: (conn, text) => {
      const msg = JSON.parse(text);
      if (msg.type !== "channel") return;
      frames.set(conn.peerId, [...frames.get(conn.peerId) ?? [], msg.value]);
    },
    sendError: (conn, code) => conn.errors.push(code),
    refuse: (conn, decision) => conn.errors.push(decision),
    withConnContext: (_conn, fn) => Promise.resolve(fn()),
    connContext: (conn) => ({ origin: "", url: "", cookie: "", peerId: conn.peerId }),
    isConnected: () => true,
    withRenderSlot: (fn) => fn(),
    backPressured: () => false,
    armRecover: () => {},
  });
  const conn = (peerId: string): Conn => ({
    socket: {} as WebSocket,
    channelSubs: new Map(),
    peerId,
    errors: [],
  });
  const publish = (channelId: string, seq: number) =>
    hub.deliver({
      kind: "publish",
      channelId,
      key: "k",
      encoded: JSON.stringify({ n: seq }),
      seq,
      instance: "i",
    });
  return { hub, conn, frames: (peerId: string) => frames.get(peerId) ?? [], publish };
}

/** Wait (bounded) until `done()`. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
}

Deno.test("channel hub: an ordered channel delivers every publish of a burst, in order; others the latest", async () => {
  resetChannels();
  createChannel<{ n: number }>({ id: "deltas", authorize: () => true, ordered: true });
  createChannel<{ n: number }>({ id: "state", authorize: () => true });
  const { hub, conn, frames, publish } = recordingHub();
  const [a, b] = [conn("a"), conn("b")];
  await hub.subscribe(a, { subId: "s", channelId: "deltas", key: "k" });
  await hub.subscribe(b, { subId: "s", channelId: "state", key: "k" });
  // Three publishes inside one coalescing window (the flush timer has not run yet).
  for (const seq of [1, 2, 3]) {
    publish("deltas", seq);
    publish("state", seq);
  }
  await until(() => frames("a").length === 3 && frames("b").length === 1);
  assertEquals(frames("a"), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assertEquals(frames("b"), [{ n: 3 }], "a state channel keeps latest-wins");
  hub.dispose();
  resetChannels();
});

Deno.test("channel hub: an ordered channel's frames held for a re-authorization all go out after it", async () => {
  resetChannels();
  let gate: Promise<boolean> = Promise.resolve(true);
  createChannel<{ n: number }>({ id: "deltas", authorize: () => gate, ordered: true });
  const { hub, conn, frames, publish } = recordingHub();
  const a = conn("a");
  await hub.subscribe(a, { subId: "s", channelId: "deltas", key: "k" });
  // The TTL ran out: the next frame starts a re-authorization that is still running while more
  // frames arrive (each in its own flush).
  const { promise, resolve } = Promise.withResolvers<boolean>();
  gate = promise;
  a.channelSubs.get("s")!.authExpires = 0;
  for (const seq of [1, 2, 3]) {
    publish("deltas", seq);
    await until(() => (a.channelSubs.get("s")!.held?.length ?? 0) === seq);
  }
  assertEquals(frames("a"), [], "held while the re-authorization runs");
  resolve(true);
  await until(() => frames("a").length === 3);
  assertEquals(frames("a"), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assertEquals(a.errors, []);
  hub.dispose();
  resetChannels();
});

Deno.test("channel hub: discard drops this instance's publishes of a key not yet fanned out", async () => {
  resetChannels();
  const ch = createChannel<{ n: number }>({ id: "deltas", authorize: () => true, ordered: true });
  const { hub, conn, frames } = recordingHub();
  const transport = inMemoryChannelTransport();
  transport.subscribe((ev) => hub.deliver(ev));
  setChannelTransport(transport);
  const [a, b, c] = [conn("a"), conn("b"), conn("c")];
  await hub.subscribe(a, { subId: "s", channelId: "deltas", key: "k" });
  await hub.subscribe(c, { subId: "s", channelId: "deltas", key: "other" });
  // Published while `a` is subscribed, inside the hub's coalescing window (no flush yet)…
  await ch.publish("k", { n: 1 });
  await ch.publish("other", { n: 1 });
  // …then `a` goes, and the key's next subscriber must not get it.
  hub.drop(a);
  ch.discard("k");
  await hub.subscribe(b, { subId: "s", channelId: "deltas", key: "k" });
  await ch.publish("k", { n: 2 });
  await until(() => frames("b").length === 1 && frames("c").length === 1);
  // Only the discarded key loses its earlier publish; a later one and another key go out.
  assertEquals(frames("a"), []);
  assertEquals(frames("b"), [{ n: 2 }]);
  assertEquals(frames("c"), [{ n: 1 }]);
  // A discard of a key nothing was published on is a no-op; another instance's frame is not hit.
  ch.discard("never");
  hub.deliver({
    kind: "publish",
    channelId: "deltas",
    key: "k",
    encoded: JSON.stringify({ n: 9 }),
    seq: 1,
    instance: "elsewhere",
  });
  await until(() => frames("b").length === 2);
  assertEquals(frames("b"), [{ n: 2 }, { n: 9 }]);
  hub.dispose();
  resetChannels();
});

Deno.test("channel discard: a fence outlives the key's counter, is bounded, and needs an id", async () => {
  resetChannels();
  const seen: ChannelEvent[] = [];
  const transport = inMemoryChannelTransport();
  transport.subscribe((ev) => seen.push(ev));
  setChannelTransport(transport);
  createChannel<number>({ authorize: () => true }).discard("k"); // no id yet: a no-op
  const ch = createChannel<number>({ id: "fenced", authorize: () => true });
  await ch.publish("k", 1);
  ch.discard("k");
  assert(channelEventDiscarded(seen[0]));
  // 10 000 other keys push "k"'s counter out; its next publish still numbers past the fence.
  for (let i = 0; i < 10_000; i++) await ch.publish(`x${i}`, i);
  await ch.publish("k", 2);
  const next = seen.at(-1)!;
  assertEquals([next.key, next.seq], ["k", 2]);
  assertEquals(channelEventDiscarded(next), false);
  // The fences are bounded too: 10 000 newer ones push "k"'s out (its first publish is no longer
  // dropped), and the newest holds.
  for (let i = 0; i < 10_000; i++) {
    await ch.publish(`y${i}`, i);
    ch.discard(`y${i}`);
  }
  assertEquals(channelEventDiscarded(seen[0]), false);
  assert(channelEventDiscarded(seen.at(-2)!), "the newest fence holds");
  resetChannels();
});

Deno.test("channel hub: a malformed publish is dropped, a payload-less one is null, a peer's revoke spares the rest", async () => {
  resetChannels();
  createChannel<{ n: number }>({ id: "deltas", authorize: () => true, ordered: true });
  const { hub, conn, frames } = recordingHub();
  const [a, b] = [conn("a"), conn("b")];
  await hub.subscribe(a, { subId: "s", channelId: "deltas", key: "k" });
  await hub.subscribe(b, { subId: "s", channelId: "deltas", key: "k" });
  const ev = { kind: "publish" as const, channelId: "deltas", key: "k", instance: "i" };
  hub.deliver({ ...ev, seq: Number.NaN, encoded: "1" });
  hub.deliver({ ...ev, seq: 1, encoded: "{not json" });
  hub.deliver({ ...ev, seq: 2 });
  await until(() => frames("a").length === 1);
  assertEquals(frames("a"), [null]);
  // A revoke of a key nobody holds is a no-op; one aimed at a peer leaves the others subscribed.
  hub.deliver({ kind: "revoke", channelId: "deltas", key: "nobody", seq: 0, instance: "i" });
  hub.deliver({
    kind: "revoke",
    channelId: "deltas",
    key: "k",
    seq: 0,
    instance: "i",
    peerId: "a",
  });
  assertEquals([a.errors, b.errors], [["denied"], []]);
  assertEquals([a.channelSubs.size, b.channelSubs.size], [0, 1]);
  hub.dispose();
  resetChannels();
});

/**
 * Two hubs on one transport, `b` standing for another instance (its events arrive marked as
 * published elsewhere, as over a shared transport). `authorize` admits each connection under the
 * grant its cookie names; `frames` are the parsed values and `raw` the texts a socket would get.
 */
function twoInstances() {
  type GrantConn = ChannelConn & { errors: string[]; cookie: string };
  const frames = new Map<string, unknown[]>();
  const raw = new Map<string, string[]>();
  const make = () =>
    createChannelHub<GrantConn>({
      limits: () => ({ maxChannelsPerConnection: 16, channelAuthTtlSeconds: 300 }),
      sendFrame: (conn, text) => {
        raw.set(conn.peerId, [...raw.get(conn.peerId) ?? [], text]);
        const msg = JSON.parse(text);
        if (msg.type !== "channel") return;
        frames.set(conn.peerId, [...frames.get(conn.peerId) ?? [], msg.value]);
      },
      sendError: (conn, code) => conn.errors.push(code),
      refuse: (conn, decision) => conn.errors.push(decision),
      withConnContext: (_conn, fn) => Promise.resolve(fn()),
      connContext: (conn) => ({ origin: "", url: "", cookie: conn.cookie, peerId: conn.peerId }),
      isConnected: () => true,
      withRenderSlot: (fn) => fn(),
      backPressured: () => false,
      armRecover: () => {},
    });
  const a = make();
  const b = make();
  const transport = inMemoryChannelTransport();
  transport.subscribe((ev) => a.deliver(ev));
  transport.subscribe((ev) => b.deliver({ ...ev, instance: "elsewhere" }));
  setChannelTransport(transport);
  const conn = (peerId: string, cookie: string): GrantConn => ({
    socket: {} as WebSocket,
    channelSubs: new Map(),
    peerId,
    cookie,
    errors: [],
  });
  return {
    a,
    b,
    conn,
    frames: (peerId: string) => frames.get(peerId) ?? [],
    raw: (peerId: string) => raw.get(peerId) ?? [],
    dispose: () => {
      a.dispose();
      b.dispose();
    },
  };
}

Deno.test("channel hub: a publish stamped with a grant reaches only the subscribers admitted under it, on every instance", async () => {
  resetChannels();
  resetLiveDevtools();
  enableLiveDevtools();
  const ch = createChannel<{ n: number }>({
    id: "rows",
    authorize: (ctx) => ({ allow: true, grant: ctx.cookie }),
    ordered: true,
  });
  const { a, b, conn, frames, raw, dispose } = twoInstances();
  const [g1Here, g1There, g2There] = [conn("g1-a", "g1"), conn("g1-b", "g1"), conn("g2-b", "g2")];
  await a.subscribe(g1Here, { subId: "s", channelId: "rows", key: "k" });
  await b.subscribe(g1There, { subId: "s", channelId: "rows", key: "k" });
  await b.subscribe(g2There, { subId: "s", channelId: "rows", key: "k" });
  // Read under g1: the g1 subscribers get it, here and on the other instance; g2's does not.
  await ch.publish("k", { n: 1 }, { grant: "g1" });
  // Unstamped: everyone, as before.
  await ch.publish("k", { n: 2 });
  // Read under g2: g2's only.
  await ch.publish("k", { n: 3 }, { grant: "g2" });
  await until(() => frames("g2-b").length === 2 && frames("g1-b").length === 2);
  assertEquals(frames("g1-a"), [{ n: 1 }, { n: 2 }]);
  assertEquals(frames("g1-b"), [{ n: 1 }, { n: 2 }]);
  assertEquals(frames("g2-b"), [{ n: 2 }, { n: 3 }]);
  // The stamp is server-side: no frame carries it.
  for (const peer of ["g1-a", "g1-b", "g2-b"]) {
    for (const text of raw(peer)) assert(!text.includes("grant"), `leaked: ${text}`);
  }
  // The dev panel's record of each push says how many of the key's subscribers it was not for
  // (per hub: A holds one g1 subscriber, B one g1 and one g2); an unstamped push says nothing.
  ch.revoke("other");
  await until(() => liveRecords().channelPushes.length === 8);
  const pushes = liveRecords().channelPushes.map((p) => [p.kind, p.subscribers, p.withheld]);
  pushes.sort((x, y) => String(x).localeCompare(String(y)));
  assertEquals(pushes, [
    ["publish", 1, undefined], // n:2 on A
    ["publish", 1, 0], // n:1 (g1) on A
    ["publish", 1, 1], // n:3 (g2) on A
    ["publish", 2, undefined], // n:2 on B
    ["publish", 2, 1], // n:1 (g1) on B
    ["publish", 2, 1], // n:3 (g2) on B
    ["revoke", 0, undefined],
    ["revoke", 0, undefined],
  ]);
  resetLiveDevtools();
  dispose();
  resetChannels();
});

Deno.test("channel hub: a reconnect re-admitted under another grant gets nothing another instance read under the old one", async () => {
  resetChannels();
  const ch = createChannel<{ n: number }>({
    id: "rows",
    authorize: (ctx) => ({ allow: true, grant: ctx.cookie }),
    ordered: true,
  });
  const { a, b, conn, frames, dispose } = twoInstances();
  // Instance B's hub holds what the transport hands it (its flush has not run yet).
  const held: ChannelEvent[] = [];
  const deliverB = b.deliver;
  b.deliver = (ev) => void held.push(ev);
  const first = conn("first", "g1");
  await a.subscribe(first, { subId: "s", channelId: "rows", key: "k" });
  await ch.publish("k", { n: 1 }, { grant: "g1" }); // read for `first`, under g1
  a.drop(first);
  // The subscriber is back on B with other claims (g2) before B fans out A's frame — and under
  // the same claims, which still gets it.
  const back = conn("back", "g2");
  const same = conn("same", "g1");
  await b.subscribe(back, { subId: "s", channelId: "rows", key: "k" });
  await b.subscribe(same, { subId: "s", channelId: "rows", key: "k" });
  b.deliver = deliverB;
  for (const ev of held) b.deliver(ev);
  await ch.publish("k", { n: 2 }, { grant: "g2" });
  await until(() => frames("back").length === 1 && frames("same").length === 1);
  assertEquals(frames("back"), [{ n: 2 }], "nothing read under g1");
  assertEquals(frames("same"), [{ n: 1 }], "the same grant keeps A's frame");
  assertEquals(frames("first"), []);
  dispose();
  resetChannels();
});

Deno.test("channel hub: a plain `true` admits with no grant — every unstamped publish, no stamped one; an object without `allow: true` refuses", async () => {
  resetChannels();
  const answers = new Map<string, unknown>([
    ["plain", true],
    ["granted", { allow: true, grant: "g" }],
    ["record", { id: "alice", allow: "yes" }],
    ["off", { allow: false, grant: "g" }],
  ]);
  const ch = createChannel<{ n: number }>({
    id: "rows",
    authorize: (ctx) => answers.get(ctx.cookie) as boolean,
    ordered: true,
  });
  const { a, conn, frames, dispose } = twoInstances();
  const [plain, granted, record, off] = ["plain", "granted", "record", "off"].map((c) =>
    conn(c, c)
  );
  for (const c of [plain, granted, record, off]) {
    await a.subscribe(c, { subId: "s", channelId: "rows", key: "k" });
  }
  assertEquals(
    [record.errors, off.errors],
    [["deny"], ["deny"]],
    "an object refuses unless `allow: true`",
  );
  assertEquals([plain.channelSubs.get("s")?.grant, granted.channelSubs.get("s")?.grant], [
    undefined,
    "g",
  ]);
  await ch.publish("k", { n: 1 }, { grant: "g" });
  await ch.publish("k", { n: 2 });
  await until(() => frames("granted").length === 2);
  assertEquals(frames("plain"), [{ n: 2 }]);
  assertEquals(frames("granted"), [{ n: 1 }, { n: 2 }]);
  dispose();
  resetChannels();
});

Deno.test("channel hub: a re-authorization records the grant the subscriber has now", async () => {
  resetChannels();
  let grant = "g1";
  const ch = createChannel<{ n: number }>({
    id: "rows",
    authorize: () => ({ allow: true, grant }),
    ordered: true,
  });
  const { a, conn, frames, dispose } = twoInstances();
  const c = conn("c", "");
  await a.subscribe(c, { subId: "s", channelId: "rows", key: "k" });
  const sub = c.channelSubs.get("s")!;
  assertEquals(sub.grant, "g1");
  // The claims change and the TTL lapses: the next publish is not for the grant it holds, and is
  // not sent — but it re-authorizes the subscription, which records the grant it has now.
  grant = "g2";
  sub.authExpires = 0;
  await ch.publish("k", { n: 1 }, { grant: "g2" });
  await until(() => sub.grant === "g2");
  assertEquals(frames("c"), [], "read under a grant it had not been admitted under yet");
  // From then on: what is read under g2 is for it, what is read under g1 is not.
  await ch.publish("k", { n: 2 }, { grant: "g1" });
  await ch.publish("k", { n: 3 }, { grant: "g2" });
  await until(() => frames("c").length === 1);
  assertEquals(frames("c"), [{ n: 3 }]);
  assertEquals(c.errors, []);
  dispose();
  resetChannels();
});
