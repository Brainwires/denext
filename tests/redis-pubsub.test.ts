// The Redis pub/sub Live transport (`redisChannelTransport`) and cross-instance `usePresence`, on
// the in-process fake server (tests/helpers/fake-redis.ts): delivery between transports without
// an echo, AUTH before SUBSCRIBE, resubscribe after a drop, a publish that never rejects, and two
// Live replicas in two processes sharing channels and presence through it. The same two-replica
// check runs against a real Redis in tests/redis-integration.test.ts.

import { assert, assertEquals } from "@std/assert";
import { type ChannelEvent, inMemoryChannelTransport } from "../src/runtime/channel.ts";
import { redisChannelTransport } from "../src/server/redis-pubsub.ts";
import { redisClient } from "../src/server/redis.ts";
import { PRESENCE_DEAD_AFTER_MS, RemotePresence } from "../src/server/live-presence.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { liveAcrossTwoReplicas } from "./helpers/live-two-instances.ts";

const event = (key: string, instance = "i1"): ChannelEvent => ({
  kind: "publish",
  channelId: "c",
  key,
  encoded: JSON.stringify({ key }),
  seq: 1,
  instance,
});

/** Events a transport delivers, with a wait for the n-th. */
function collect(t: { subscribe(fn: (ev: ChannelEvent) => void): () => void }) {
  const seen: ChannelEvent[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  t.subscribe((ev) => {
    seen.push(ev);
    for (const w of waiters.filter((w) => seen.length >= w.n)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  });
  return {
    seen,
    count: (n: number) =>
      seen.length >= n
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ n, resolve })),
  };
}

Deno.test("redisChannelTransport: delivers to every transport once, its own events without the echo", async () => {
  const server = fakeRedis();
  const a = redisChannelTransport({ url: server.url, channel: "t1" });
  const b = redisChannelTransport({ url: server.url, channel: "t1" });
  try {
    await Promise.all([a.ready(), b.ready()]);
    const onA = collect(a);
    const onB = collect(b);
    await a.publish(event("one"));
    assertEquals(onA.seen.map((e) => e.key), ["one"], "A delivers its own event at once");
    await onB.count(1);
    await b.publish(event("two"));
    await onA.count(2);
    // Something else on the channel (not an envelope) is ignored; the next event still arrives.
    const raw = redisClient(server.url);
    await raw.command("PUBLISH", "t1", "not json");
    await raw.command("PUBLISH", "t1", JSON.stringify({ o: "x" }));
    await raw.close();
    await a.publish(event("three"));
    await onB.count(3);
    assertEquals(onA.seen.map((e) => e.key), ["one", "two", "three"], "no echo of A's own");
    assertEquals(onB.seen.map((e) => e.key), ["one", "two", "three"]);
  } finally {
    await a.close();
    await b.close();
    await a.close();
    await server.close();
  }
});

Deno.test("redisChannelTransport: AUTH before SUBSCRIBE; after a drop it resubscribes", async () => {
  const server = fakeRedis({ password: "pw" });
  const url = server.url.replace("redis://", "redis://:pw@") + "/2";
  let resynced!: () => void;
  const resync = new Promise<void>((resolve) => (resynced = resolve));
  const a = redisChannelTransport({ url, channel: "t2", onResync: () => resynced() });
  const b = redisChannelTransport({ url, channel: "t2" });
  try {
    await Promise.all([a.ready(), b.ready()]);
    const subscribe = server.log.findIndex((c) => c[0] === "SUBSCRIBE");
    assertEquals(server.log.slice(subscribe - 2, subscribe + 1), [
      ["AUTH", "pw"],
      ["SELECT", "2"],
      ["SUBSCRIBE", "t2"],
    ]);
    server.dropConnections();
    await resync;
    const onA = collect(a);
    // B's publisher reconnects on its next command; A's subscriber is back.
    await b.publish(event("after"));
    await onA.count(1);
    assertEquals(onA.seen[0].key, "after");
  } finally {
    await a.close();
    await b.close();
    await server.close();
  }
});

Deno.test("redisChannelTransport: an unreachable Redis never rejects a publish; close stops the retries", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => void warnings.push(msg);
  const t = redisChannelTransport({ url: `redis://127.0.0.1:${port}` });
  try {
    const local = collect(t);
    await t.publish(event("local"));
    assertEquals(local.seen.length, 1, "still delivered on this instance");
    await t.publish(event("again"));
    assertEquals(warnings.length, 1, "logged once");
  } finally {
    await t.close();
    console.warn = warn;
  }
});

Deno.test("RemotePresence: newest snapshot per instance wins; empty leaves; dead instances pruned", () => {
  const remote = new RemotePresence();
  const snap = (instance: string, seq: number, peers: unknown[]): ChannelEvent => ({
    kind: "presence",
    channelId: "",
    key: "room",
    encoded: JSON.stringify(peers),
    seq,
    instance,
  });
  assertEquals(remote.apply(snap("a", 2, [{ id: "p1", state: 1 }]), 10, 0), {
    room: "room",
    newcomer: true,
  });
  assertEquals(remote.apply(snap("a", 1, [{ id: "old" }]), 10, 0), undefined, "out of order");
  assertEquals(remote.apply(snap("a", 3, [{ id: "p1" }, { id: "p2" }]), 10, 0)?.newcomer, false);
  remote.apply(snap("b", 1, [{ id: "q1" }, { bad: true }, { id: "q2" }, { id: "q3" }]), 2, 1000);
  assertEquals(remote.peers("room").map((p) => p.id), ["p1", "p2", "q1", "q2"], "capped, valid");
  assertEquals(remote.apply({ ...snap("c", 1, []), encoded: "{" }, 10), undefined, "malformed");
  assertEquals(remote.prune(PRESENCE_DEAD_AFTER_MS + 500), ["room"], "a died");
  assertEquals(remote.peers("room").map((p) => p.id), ["q1", "q2"]);
  remote.apply(snap("b", 2, []), 10);
  assertEquals(remote.peers("room"), [], "b left");
  assertEquals(remote.prune(), []);
});

Deno.test("Live presence merges another instance's peers and answers a newcomer", async () => {
  const { handleLiveUpgrade, installLiveHub, uninstallLiveHub } = await import(
    "../src/server/live.ts"
  );
  const { setChannelTransport, channelInstanceId } = await import("../src/runtime/channel.ts");
  const transport = inMemoryChannelTransport();
  setChannelTransport(transport);
  const ours = collect({
    subscribe: (fn) =>
      transport.subscribe((ev) => {
        if (ev.kind === "presence" && ev.instance === channelInstanceId()) fn(ev);
      }),
  });
  installLiveHub({
    appHandler: () => Promise.resolve(new Response(null, { status: 404 })),
    originAllowed: () => true,
    config: { allowAnonymous: true },
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req) => handleLiveUpgrade(req),
  );
  const ws = new WebSocket(`ws://127.0.0.1:${(server.addr as Deno.NetAddr).port}/_denext/live`);
  const states: { peers: { id: string }[] }[] = [];
  let onState: (() => void) | undefined;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string);
    if (m.type === "presence-state") {
      states.push(m);
      onState?.();
    }
  };
  const nextState = () => new Promise<void>((resolve) => (onState = resolve));
  try {
    await new Promise((resolve) => (ws.onopen = resolve));
    let waiting = nextState();
    ws.send(JSON.stringify({ type: "presence-join", room: "doc", state: { name: "local" } }));
    await waiting;
    await ours.count(1);
    assertEquals(JSON.parse(ours.seen[0].encoded!).length, 1, "announced its own peer");
    waiting = nextState();
    transport.publish({
      kind: "presence",
      channelId: "",
      key: "doc",
      encoded: JSON.stringify([{ id: "remote-1", state: { name: "remote" } }]),
      seq: 1,
      instance: "other-instance",
    });
    await waiting;
    assertEquals(states.at(-1)!.peers.length, 2, "the remote peer is merged in");
    await ours.count(2);
    assert(ours.seen.length >= 2, "answered the newcomer with its own snapshot");
    waiting = nextState();
    transport.publish({
      kind: "presence",
      channelId: "",
      key: "doc",
      encoded: "[]",
      seq: 2,
      instance: "other-instance",
    });
    await waiting;
    assertEquals(states.at(-1)!.peers.length, 1, "the remote instance left");
  } finally {
    const closed = new Promise((resolve) => (ws.onclose = resolve));
    ws.close();
    await closed;
    uninstallLiveHub();
    await server.shutdown();
    setChannelTransport(inMemoryChannelTransport());
  }
});

Deno.test("two Live replicas share channels and presence through Redis pub/sub (fake server)", async () => {
  const server = fakeRedis();
  try {
    await liveAcrossTwoReplicas(server.url);
  } finally {
    await server.close();
  }
});
