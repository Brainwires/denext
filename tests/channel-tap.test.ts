// `tapChannel`: the server-side observer of a channel's pushes (the plugin-kit seam a
// protocol bridge such as @denext/graphql subscriptions consumes).

import { assertEquals, assertThrows } from "@std/assert";
import {
  createChannel,
  inMemoryChannelTransport,
  setChannelTransport,
  tapChannel,
} from "../src/runtime/channel.ts";

type Ev = { at: Date; n: number };

Deno.test("tapChannel: receives decoded payloads for its key only, in seq order; disposer stops it", async () => {
  setChannelTransport(inMemoryChannelTransport());
  const ch = createChannel<Ev>({ id: "tap:orders", authorize: () => true });
  const other = createChannel<Ev>({ id: "tap:other", authorize: () => true });
  const seen: [Ev, number][] = [];
  const stop = tapChannel(ch, "k1", { onPayload: (p, seq) => seen.push([p, seq]) });
  const when = new Date("2026-09-06T00:00:00Z");
  await ch.publish("k1", { at: when, n: 1 });
  await ch.publish("k2", { at: when, n: 2 }); // another key
  await other.publish("k1", { at: when, n: 3 }); // another channel
  await ch.publish("k1", { at: when, n: 4 });
  assertEquals(seen.map(([p, seq]) => [p.n, seq]), [[1, 1], [4, 2]]);
  assertEquals(seen[0][0].at instanceof Date, true, "codec tags are decoded (Date survives)");
  assertEquals(seen[0][0].at.getTime(), when.getTime());
  stop();
  await ch.publish("k1", { at: when, n: 5 });
  assertEquals(seen.length, 2, "nothing after dispose");
});

Deno.test("tapChannel: a key-wide revoke is reported, a peer-scoped one is not; follows a transport swap", async () => {
  setChannelTransport(inMemoryChannelTransport());
  const ch = createChannel<number>({ id: "tap:revoke", authorize: () => true });
  let revoked = 0;
  const got: number[] = [];
  const stop = tapChannel<number>("tap:revoke", "r", {
    onPayload: (p) => got.push(p),
    onRevoke: () => revoked++,
  });
  ch.revoke("r", { peerId: "someone" });
  ch.revoke("r");
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(revoked, 1);
  // A new transport is installed (e.g. broadcastChannelTransport at startup): the tap re-binds.
  setChannelTransport(inMemoryChannelTransport());
  await ch.publish("r", 7);
  assertEquals(got, [7]);
  stop();
  setChannelTransport(inMemoryChannelTransport());
});

Deno.test("tapChannel: a channel without an id is refused with a guided error", () => {
  const anon = createChannel<number>({ authorize: () => true });
  assertThrows(
    () => tapChannel(anon, "k", { onPayload: () => {} }),
    Error,
    "the channel has no id",
  );
});
