// denext's zero-npm Redis client and its stores against an in-process fake server
// (tests/helpers/fake-redis.ts: real RESP2 over TCP), so they run on every Deno: the client's
// protocol, AUTH / SELECT / URL handling, pipelining, MULTI/EXEC, errors and reconnects, and the
// Redis cache, session and rate-limit stores through the exported contract suites plus what is
// specific to them (caps, sweeps, stale index members, ownership). The same suites run against a
// real Redis in tests/redis-integration.test.ts.

import { assert, assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import {
  encodeCommand,
  redisClient,
  RedisConnectionError,
  RedisError,
  resolveRedisTarget,
  RespReader,
} from "../src/server/redis.ts";
import { redisCacheStore } from "../src/server/redis-cache.ts";
import { redisSessionStore } from "../src/server/auth/redis-session-store.ts";
import { redisRateLimitStore } from "../src/server/auth/redis-rate-limit.ts";
import {
  cacheStoreContract,
  rateLimitStoreContract,
  sessionStoreContract,
} from "../src/testing/mod.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { liveViewStoreContract } from "./helpers/live-view-store-contract.ts";
import { redisLiveViewStore } from "../src/server/live-view-stores.ts";

/** Run `fn` with a fake server and a client on it, closing both. */
async function withRedis(
  fn: (ctx: { server: ReturnType<typeof fakeRedis>; prefix: () => string }) => Promise<void>,
) {
  const server = fakeRedis();
  let n = 0;
  try {
    await fn({ server, prefix: () => `t${n++}:` });
  } finally {
    await server.close();
  }
}

Deno.test("Redis stores pass the store contracts (fake server)", async (t) => {
  await withRedis(async ({ server, prefix }) => {
    const client = redisClient(server.url);
    try {
      await t.step(
        "CacheStore",
        (t) => cacheStoreContract(t, () => redisCacheStore({ client, prefix: prefix() })),
      );
      await t.step(
        "SessionStore",
        (t) => sessionStoreContract(t, () => redisSessionStore({ client, prefix: prefix() })),
      );
      await t.step(
        "RateLimitStore",
        (t) => rateLimitStoreContract(t, () => redisRateLimitStore({ client, prefix: prefix() })),
      );
      await t.step(
        "LiveViewStore",
        (t) => liveViewStoreContract(t, () => redisLiveViewStore({ client, prefix: prefix() })),
      );
    } finally {
      await client.close();
    }
  });
});

Deno.test("RespReader: replies split across chunks, nested arrays, nils, errors", () => {
  const reader = new RespReader();
  const bytes = new TextEncoder().encode(
    "+OK\r\n:42\r\n$5\r\nhé\r\n\r\n$-1\r\n*3\r\n$1\r\na\r\n*1\r\n:-1\r\n*-1\r\n-ERR bad thing\r\n",
  );
  // One byte at a time: nothing is taken before a reply is whole.
  const replies: unknown[] = [];
  for (const byte of bytes) {
    reader.feed(Uint8Array.of(byte));
    for (let r = reader.next(); r; r = reader.next()) replies.push(r.value);
  }
  assertEquals(replies.slice(0, 5), ["OK", 42, "hé\r\n", null, ["a", [-1], null]]);
  assertInstanceOf(replies[5], RedisError);
  assertEquals((replies[5] as RedisError).code, "ERR");
  // An EXEC reply with a failed command surfaces that command's error.
  reader.feed(new TextEncoder().encode("*2\r\n+OK\r\n-WRONGTYPE nope\r\n"));
  assertEquals((reader.next()?.value as RedisError).code, "WRONGTYPE");
  reader.feed(new TextEncoder().encode("?what\r\n"));
  assertThrows(() => reader.next(), RedisConnectionError, "unexpected reply type");
});

Deno.test("encodeCommand counts bytes, not UTF-16 units", () => {
  assertEquals(
    new TextDecoder().decode(encodeCommand(["SET", "k", "é", 7])),
    "*4\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n$1\r\n7\r\n",
  );
});

Deno.test("resolveRedisTarget: URL parts, overrides, TLS and refusals", () => {
  const t = resolveRedisTarget({ url: "rediss://us%40r:p%3Ass@cache.example:6380/3" });
  assertEquals(
    [t.hostname, t.port, t.tls, t.username, t.password, t.db],
    ["cache.example", 6380, true, "us@r", "p:ss", 3],
  );
  const plain = resolveRedisTarget({ url: "redis://h", db: 2, password: "x", port: 1 });
  assertEquals([plain.port, plain.tls, plain.db, plain.password, plain.username], [
    1,
    false,
    2,
    "x",
    undefined,
  ]);
  const ca = resolveRedisTarget({ url: "redis://[::1]:7000", tls: { caCerts: ["PEM"] } });
  assertEquals([ca.hostname, ca.tls, ca.caCerts], ["::1", true, ["PEM"]]);
  assertThrows(() => resolveRedisTarget({ url: "http://h" }), TypeError, "redis://");
  assertThrows(() => resolveRedisTarget({ url: "redis://h/x" }), TypeError, "database");
});

Deno.test("client: AUTH with a password, or an ACL user, before any command; SELECT", async () => {
  const server = fakeRedis({ password: "s3cret", username: "app" });
  try {
    const url = new URL(server.url);
    url.username = "app";
    url.password = "s3cret";
    url.pathname = "/4";
    const client = redisClient(url.href);
    await client.command("SET", "k", "v");
    await client.close();
    assertEquals(server.log.slice(0, 3), [["AUTH", "app", "s3cret"], ["SELECT", "4"], [
      "SET",
      "k",
      "v",
    ]]);
    assertEquals(server.peek("k", 4)?.type, "string", "written to database 4");
    assertEquals(server.peek("k", 0), undefined);

    const wrong = redisClient({ url: server.url, username: "app", password: "nope" });
    const error = await assertRejects(() => wrong.command("PING"), RedisError);
    assertEquals(error.code, "WRONGPASS");
    await wrong.close();

    const none = redisClient(server.url);
    assertEquals((await assertRejects(() => none.command("GET", "k"), RedisError)).code, "NOAUTH");
    await none.close();
  } finally {
    await server.close();
  }
});

Deno.test("client: pipelined replies stay in order; a transaction is one MULTI block", async () => {
  await withRedis(async ({ server }) => {
    const client = redisClient(server.url);
    try {
      // Many concurrent callers on one connection each get their own reply.
      const replies = await Promise.all(
        Array.from({ length: 50 }, (_, i) => client.command("HINCRBY", "h", "n", i)),
      );
      assertEquals(replies.at(-1), (49 * 50) / 2);
      assertEquals(await client.pipeline([["SET", "a", "1"], ["GET", "a"], ["GET", "zz"]]), [
        "OK",
        "1",
        null,
      ]);
      assertEquals(await client.pipeline([]), []);
      assertEquals(await client.transaction([]), []);
      assertEquals(await client.transaction([["SET", "b", "2"], ["GET", "b"]]), ["OK", "2"]);
      // A runtime error inside EXEC rejects the transaction with that error…
      const wrongType = await assertRejects(
        () => client.transaction([["SET", "c", "1"], ["HGET", "c", "f"]]),
        RedisError,
      );
      assertEquals(wrongType.code, "WRONGTYPE");
      // …and a command refused while queueing aborts it.
      await assertRejects(() => client.transaction([["NOPE"]]), RedisError, "unknown command");
      const failed = await assertRejects(
        () => client.pipeline([["SET", "d", "1"], ["NOPE"], ["GET", "d"]]),
        RedisError,
      );
      assertEquals(failed.code, "ERR");
      assertEquals(await client.command("GET", "d"), "1", "the rest of the pipeline still ran");
    } finally {
      await client.close();
    }
  });
});

Deno.test("client: a dropped connection rejects in-flight commands and reconnects on the next", async () => {
  await withRedis(async ({ server }) => {
    const client = redisClient(server.url);
    try {
      await client.command("SET", "k", "1");
      server.dropConnections();
      // The drop is noticed by the reader; the next command opens a new connection.
      let reply: unknown;
      for (let i = 0; i < 3 && reply === undefined; i++) {
        try {
          reply = await client.command("GET", "k");
        } catch (error) {
          assertInstanceOf(error, RedisConnectionError);
        }
      }
      assertEquals(reply, "1");
    } finally {
      await client.close();
      await client.close();
    }
    await assertRejects(() => client.command("PING"), RedisConnectionError, "closed");
  });
});

Deno.test("client: an unreachable server is a RedisConnectionError, then a retry", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const client = redisClient({ url: `redis://127.0.0.1:${port}`, connectTimeoutMs: 2000 });
  const error = await assertRejects(() => client.command("PING"), RedisConnectionError);
  assert(!error.message.includes("@"), "no credentials in the message");
  await assertRejects(() => client.command("PING"), RedisConnectionError, "cannot connect");
  await client.close();
});

Deno.test("store options: client XOR url; a store closes only a client it opened", async () => {
  const client = redisClient("redis://127.0.0.1:1");
  for (
    const make of [
      () => redisCacheStore({ client, url: "redis://h" }),
      () => redisSessionStore({ client, url: "redis://h" }),
      () => redisRateLimitStore({ client, url: "redis://h" }),
    ]
  ) assertThrows(make, TypeError, "not both");
  await withRedis(async ({ server }) => {
    const mine = redisClient(server.url);
    for (const store of [redisCacheStore({ client: mine }), redisSessionStore({ client: mine })]) {
      await store.close();
    }
    await redisRateLimitStore({ client: mine }).close();
    assertEquals(await mine.command("PING"), "PONG", "the app's client is still open");
    await mine.close();
    for (
      const store of [
        redisCacheStore({ url: server.url }),
        redisSessionStore({ url: server.url }),
        redisRateLimitStore({ url: server.url }),
      ]
    ) {
      await store.close();
    }
  });
  await client.close();
});

Deno.test("redis cache: the oldest-written entries go past the cap; expired ones are swept", async () => {
  await withRedis(async ({ server }) => {
    const store = redisCacheStore({
      url: server.url,
      maxDataEntries: 2,
      maxPageEntries: 1,
      sweepIntervalMs: 0,
    });
    try {
      for (const key of ["a", "b", "c"]) {
        await store.setData(key, { value: key, expiresAt: Infinity, tags: ["t"] });
      }
      assertEquals(await store.getData("a"), undefined, "evicted");
      assertEquals((await store.getData("c"))?.value, "c");
      assertEquals(server.peek("denext:cache:tag:t")?.value, new Set(["d:b", "d:c"]));
      const page = { body: "x", status: 200, expiresAt: Infinity, tags: [] };
      await store.setPage("p1", { ...page, path: "/1" });
      await store.setPage("p2", { ...page, path: "/2" });
      assertEquals(await store.getPage("p1"), undefined);
      assertEquals(server.peek("denext:cache:path:/1"), undefined, "its path index went too");
      await store.setData("x", { value: 1, expiresAt: Date.now() + 5, tags: [] });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await store.setData("y", { value: 1, expiresAt: Infinity, tags: [] }); // sweeps x
      assertEquals(server.peek("denext:cache:d:x"), undefined);
    } finally {
      await store.close();
    }
  });
});

Deno.test("redis cache: stale or corrupt index members never purge the wrong entry", async () => {
  await withRedis(async ({ server }) => {
    const client = redisClient(server.url);
    const store = redisCacheStore({ client });
    try {
      // A tag-set member left by a racing writer: the entry no longer carries the tag.
      await store.setData("d", { value: 1, expiresAt: Infinity, tags: ["b"] });
      await client.command("SADD", "denext:cache:tag:a", "d:d", "d:gone");
      await store.deleteByTag("a");
      assertEquals((await store.getData("d"))?.value, 1);
      assertEquals(server.peek("denext:cache:tag:a"), undefined, "stale members dropped");
      await store.expireByTag!("a", { staleAt: 0, expiresAt: 1 });
      assertEquals((await store.getData("d"))?.expiresAt, Infinity, "not expired by a stale tag");
      // A partial hash (a delete raced a soft-expiry) reads as a miss.
      await client.command("HSET", "denext:cache:d:half", "e", "inf");
      assertEquals(await store.getData("half"), undefined);
      await client.command("HSET", "denext:cache:p:half", "e", "inf", "b", "x");
      assertEquals(await store.getPage("half"), undefined);
      // A corrupt value or tag list does not throw.
      await client.command("HSET", "denext:cache:d:bad", "v", "{", "e", "inf", "t", "[");
      assertEquals(await store.getData("bad"), { value: undefined, expiresAt: Infinity, tags: [] });
      await store.expireByTag!("none", { staleAt: 0, expiresAt: Infinity });
    } finally {
      await store.close();
      await client.close();
    }
  });
});

Deno.test("redis sessions: the user index; a session moved to another user is kept", async () => {
  await withRedis(async ({ server }) => {
    const client = redisClient(server.url);
    const store = redisSessionStore({ client });
    try {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      await store.create("s1", { user: { id: "alice" }, provider: "p", expiresAt: exp });
      const index = server.peek("denext:session:u:alice");
      assertEquals(index?.expireAt, exp * 1000, "the index lives as long as its sessions");
      await store.create("s2", { user: { id: "alice" }, provider: "p", expiresAt: exp + 60 });
      assertEquals(server.peek("denext:session:u:alice")?.expireAt, (exp + 60) * 1000);
      assertEquals(
        await store.update!("s2", { user: { id: "bob" }, provider: "p", expiresAt: exp }),
        true,
      );
      await client.command("SADD", "denext:session:u:alice", "s3");
      await client.command("SET", "denext:session:s:s3", "{corrupt");
      await store.deleteByUser("alice");
      assertEquals(await store.get("s1"), undefined);
      assertEquals((await store.get("s2"))?.user.id, "bob", "now bob's");
      assertEquals(await store.get("s3"), undefined, "a corrupt session is a miss, and removed");
      assertEquals(
        await store.update!("s2", { user: { id: "bob" }, provider: "p", expiresAt: 1 }),
        false,
        "an update to a past expiry is refused",
      );
    } finally {
      await store.close();
      await client.close();
    }
  });
});

Deno.test("redis rate limit: a window the server kept past its reset time starts over", async () => {
  await withRedis(async ({ server }) => {
    const client = redisClient(server.url);
    const store = redisRateLimitStore({ client });
    try {
      // The server's clock runs behind: the key outlives `r` by this process's clock.
      const past = Date.now() - 1000;
      await client.command("HSET", "denext:ratelimit:k", "c", 7, "r", past);
      const w = await store.increment("k", 60_000);
      assertEquals(w.count, 1);
      assert(w.resetAt > Date.now());
      assertEquals(server.peek("denext:ratelimit:k")?.expireAt, w.resetAt);
    } finally {
      await store.close();
      await client.close();
    }
  });
});
