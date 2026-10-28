// The Live hub's channel half (`createChannelHub`), driven directly with fake hub primitives.

import { assertEquals } from "@std/assert";
import { createChannel, resetChannels } from "../src/runtime/channel.ts";
import { type ChannelConn, createChannelHub } from "../src/server/live-channels.ts";

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
