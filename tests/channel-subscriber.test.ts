// `tapChannelAuthorized` (denext/plugin-kit): a server-side channel subscriber behind the
// channel's own `authorize` — the gate, context and key the Live socket applies — with lazy
// re-authorization on traffic and immediate revocation (key-wide or for the subscriber's peer).

import { assertEquals, assertRejects } from "@std/assert";
import { createChannel, resetChannels, setChannelAuthTtl } from "../src/runtime/channel.ts";
import { ChannelAccessError, tapChannelAuthorized } from "../src/server/channel-subscriber.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import type { ChannelContext } from "../src/runtime/channel.ts";

/** Run `fn` inside a request carrying `cookie`. */
function asViewer<T>(cookie: string, fn: () => T): T {
  const request = new Request("https://app.test/graphql", { headers: { cookie } });
  return runWithContext(createRequestContext(request), fn);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("tapChannelAuthorized: authorize gets Live's context + the key; a refusal throws and attaches nothing", async () => {
  resetChannels();
  const seen: [ChannelContext, string][] = [];
  const ch = createChannel<number>({
    id: "auth:ctx",
    authorize: (ctx, key) => {
      seen.push([ctx, key]);
      return key === `user:${/uid=(\w+)/.exec(ctx.cookie)?.[1]}`;
    },
  });
  const got: number[] = [];
  // A key built from a client-supplied argument naming ANOTHER user is refused.
  await assertRejects(
    () =>
      asViewer("uid=alice", () => tapChannelAuthorized(ch, "user:bob", { onPayload: () => {} })),
    ChannelAccessError,
  );
  const stop = await asViewer(
    "uid=alice",
    () => tapChannelAuthorized(ch, "user:alice", { onPayload: (n) => got.push(n), peerId: "p1" }),
  );
  assertEquals(seen[1], [
    {
      origin: "https://app.test",
      url: "https://app.test/graphql",
      cookie: "uid=alice",
      peerId: "p1",
    },
    "user:alice",
  ]);
  await ch.publish("user:bob", 1);
  await ch.publish("user:alice", 2);
  assertEquals(got, [2]);
  stop();
  await ch.publish("user:alice", 3);
  assertEquals(got, [2]);
  resetChannels();
});

Deno.test("tapChannelAuthorized: an unknown channel, a malformed key and a throwing authorize are the same refusal", async () => {
  resetChannels();
  const ch = createChannel<number>({
    id: "auth:throws",
    authorize: () => {
      throw new Error("db down");
    },
  });
  for (const [c, key] of [["no:such", "k"], [ch, "bad key!"], [ch, "k"]] as const) {
    await assertRejects(
      () => tapChannelAuthorized(c as string, key, { onPayload: () => {} }),
      ChannelAccessError,
    );
  }
  resetChannels();
});

Deno.test("tapChannelAuthorized: lazy re-authorization holds the payload, then delivers it or ends", async () => {
  resetChannels();
  let allow = true;
  let checks = 0;
  const ch = createChannel<number>({
    id: "auth:ttl",
    authTtlSeconds: 0.001,
    authorize: () => {
      checks++;
      return allow;
    },
  });
  const got: number[] = [];
  let ended = 0;
  await tapChannelAuthorized(ch, "k", { onPayload: (n) => got.push(n), onEnd: () => ended++ });
  await new Promise((r) => setTimeout(r, 5));
  await ch.publish("k", 1); // stale → re-checked (allowed) → delivered
  await tick();
  assertEquals([got, checks, ended], [[1], 2, 0]);
  allow = false;
  await new Promise((r) => setTimeout(r, 5));
  await ch.publish("k", 2); // stale → re-checked (denied) → ended, 2 never delivered
  await tick();
  await ch.publish("k", 3);
  await tick();
  assertEquals([got, checks, ended], [[1], 3, 1]);
  resetChannels();
});

Deno.test("tapChannelAuthorized: the default TTL is the hub's channelAuthTtlSeconds", async () => {
  resetChannels();
  setChannelAuthTtl(0.001);
  let checks = 0;
  const ch = createChannel<number>({ id: "auth:hub-ttl", authorize: () => ++checks > 0 });
  await tapChannelAuthorized(ch, "k", { onPayload: () => {} });
  await new Promise((r) => setTimeout(r, 5));
  await ch.publish("k", 1);
  await tick();
  assertEquals(checks, 2);
  resetChannels();
});

Deno.test("tapChannelAuthorized: revoke(key) and revoke(key, { peerId }) for this peer end it; another peer's does not", async () => {
  resetChannels();
  const ch = createChannel<number>({ id: "auth:revoke", authorize: () => true });
  const ends: string[] = [];
  await tapChannelAuthorized(ch, "k", {
    onPayload: () => {},
    peerId: "a",
    onEnd: () => ends.push("a"),
  });
  await tapChannelAuthorized(ch, "k", {
    onPayload: () => {},
    peerId: "b",
    onEnd: () => ends.push("b"),
  });
  ch.revoke("k", { peerId: "a" });
  await tick();
  assertEquals(ends, ["a"]);
  ch.revoke("k", { peerId: "zzz" });
  await tick();
  assertEquals(ends, ["a"]);
  ch.revoke("k");
  await tick();
  assertEquals(ends, ["a", "b"]);
  resetChannels();
});

Deno.test("tapChannelAuthorized: a payload published under a grant reaches the viewer only when authorize admitted them under it", async () => {
  resetChannels();
  setChannelAuthTtl(300);
  const ch = createChannel<number>({
    id: "auth:grant",
    authorize: (ctx) => ({ allow: true, grant: /g=(\w+)/.exec(ctx.cookie)![1] }),
  });
  const got: number[] = [];
  const stop = await asViewer(
    "g=one",
    () => tapChannelAuthorized(ch, "k", { onPayload: (n) => got.push(n), peerId: "p1" }),
  );
  await ch.publish("k", 1, { grant: "one" });
  await ch.publish("k", 2, { grant: "two" });
  await ch.publish("k", 3);
  assertEquals(got, [1, 3], "another grant's payload is not for them; an unstamped one is");
  // A lapsed authorization holds the payload, then checks it against the grant just recorded.
  setChannelAuthTtl(0);
  const gotLater: number[] = [];
  const later = await asViewer(
    "g=two",
    () => tapChannelAuthorized(ch, "k", { onPayload: (n) => gotLater.push(n), peerId: "p2" }),
  );
  await ch.publish("k", 4, { grant: "one" });
  await tick();
  await ch.publish("k", 5, { grant: "two" });
  await tick();
  assertEquals(gotLater, [5]);
  assertEquals(got, [1, 3, 4], "the first viewer, admitted under `one`, still gets its own");
  stop();
  later();
  setChannelAuthTtl(300);
  resetChannels();
});
