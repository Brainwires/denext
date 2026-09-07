// `tapChannel`: the server-side observer of a channel's pushes (the plugin-kit seam a
// protocol bridge such as @denext/graphql subscriptions consumes).

import { assertEquals, assertThrows } from "@std/assert";
import {
  createChannel,
  inMemoryChannelTransport,
  resetChannels,
  setChannelTransport,
  tapChannel,
} from "../src/runtime/channel.ts";

type Ev = { at: Date; n: number };

Deno.test("tapChannel: receives decoded payloads for its key only, in seq order; disposer stops it", async () => {
  resetChannels();
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
  resetChannels();
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
  resetChannels();
});

Deno.test("tapChannel: a channel without an id is refused with a guided error", () => {
  const anon = createChannel<number>({ authorize: () => true });
  assertThrows(
    () => tapChannel(anon, "k", { onPayload: () => {} }),
    Error,
    "the channel has no id",
  );
});

Deno.test("tapChannel: a throwing consumer is logged, later subscribers still get the event, publish resolves", async () => {
  resetChannels();
  const ch = createChannel<number>({ id: "tap:throws", authorize: () => true });
  const got: number[] = [];
  const stopBad = tapChannel(ch, "k", {
    onPayload: () => {
      throw new Error("consumer bug");
    },
  });
  const stopGood = tapChannel(ch, "k", { onPayload: (p) => got.push(p) });
  const logged: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => logged.push(a);
  try {
    await ch.publish("k", 1); // does not reject
  } finally {
    console.error = orig;
  }
  assertEquals(got, [1], "the healthy subscriber still received the event");
  assertEquals(logged.length, 1, "the throw was logged once");
  stopBad();
  stopGood();
});

Deno.test("tapChannel: an id no channel registered warns once (a typo would otherwise be silent forever)", () => {
  resetChannels();
  const logged: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => logged.push(a);
  try {
    tapChannel<number>("tap:typo", "k", { onPayload: () => {} })();
    tapChannel<number>("tap:typo", "k", { onPayload: () => {} })();
  } finally {
    console.warn = orig;
  }
  assertEquals(logged.length, 1);
  assertEquals(String(logged[0][0]).includes("no channel is registered"), true);
});
