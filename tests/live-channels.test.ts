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
