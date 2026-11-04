// denext's Redis client and stores against a REAL Redis (7+) or Valkey server: the exported
// store contracts, each case under a key prefix of its own, plus what only a real server shows —
// two clients (two replicas) counting into one rate-limit window and revoking each other's
// sessions, PEXPIREAT NX/GT and SET XX PXAT as the stores use them, and ACL AUTH.
//
// Opt-in:
//
//   docker run --rm -d --name dnx-redis -p 127.0.0.1:56379:6379 redis:7-alpine
//   DENEXT_TEST_REDIS_URL=redis://127.0.0.1:56379/0 deno test -A tests/redis-integration.test.ts
//
// Without DENEXT_TEST_REDIS_URL every test here is ignored; the same suites run on every Deno
// against an in-process fake server in tests/redis-stores.test.ts. Every key a test writes
// carries a random prefix and is deleted afterwards, so a shared database is left as it was.

import { assert, assertEquals } from "@std/assert";
import { type RedisClient, redisClient, RedisError } from "../src/server/redis.ts";
import { redisCacheStore } from "../src/server/redis-cache.ts";
import { redisSessionStore } from "../packages/auth/src/redis-session-store.ts";
import { redisRateLimitStore } from "../packages/auth/src/redis-rate-limit.ts";
import { liveAcrossTwoReplicas } from "./helpers/live-two-instances.ts";
import { liveViewStoreContract } from "./helpers/live-view-store-contract.ts";
import { redisLiveViewStore } from "../src/server/live-view-stores.ts";
import {
  cacheStoreContract,
  rateLimitStoreContract,
  sessionStoreContract,
} from "../src/testing/mod.ts";

const URL_ = Deno.env.get("DENEXT_TEST_REDIS_URL") || undefined;
const ignore = !URL_;

/** A random key prefix per test, and a cleanup that deletes every key under it. */
function prefixes(client: RedisClient) {
  const root = `dnx-test:${crypto.randomUUID().slice(0, 8)}:`;
  let n = 0;
  return {
    next: () => `${root}${n++}:`,
    async cleanup() {
      let cursor = "0";
      do {
        const [next, keys] = await client.command(
          "SCAN",
          cursor,
          "MATCH",
          `${root}*`,
          "COUNT",
          500,
        ) as [
          string,
          string[],
        ];
        if (keys.length) await client.command("DEL", ...keys);
        cursor = next;
      } while (cursor !== "0");
    },
  };
}

Deno.test({
  name: "redis (real server): the store contracts",
  ignore,
  async fn(t) {
    const client = redisClient(URL_!);
    const p = prefixes(client);
    try {
      await t.step(
        "CacheStore",
        (t) => cacheStoreContract(t, () => redisCacheStore({ client, prefix: p.next() })),
      );
      await t.step(
        "SessionStore",
        (t) => sessionStoreContract(t, () => redisSessionStore({ client, prefix: p.next() })),
      );
      await t.step(
        "RateLimitStore",
        (t) => rateLimitStoreContract(t, () => redisRateLimitStore({ client, prefix: p.next() })),
      );
      await t.step(
        "LiveViewStore",
        (t) => liveViewStoreContract(t, () => redisLiveViewStore({ client, prefix: p.next() })),
      );
      await t.step("cache caps and the sweep", async () => {
        const store = redisCacheStore({
          client,
          prefix: p.next(),
          maxDataEntries: 2,
          sweepIntervalMs: 0,
        });
        for (const key of ["a", "b", "c"]) {
          await store.setData(key, { value: key, expiresAt: Infinity, tags: [] });
        }
        assertEquals(await store.getData("a"), undefined);
        await store.setData("x", { value: 1, expiresAt: Date.now() + 5, tags: [] });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await store.setData("y", { value: 1, expiresAt: Infinity, tags: [] });
        assertEquals((await store.getData("y"))?.value, 1);
        assertEquals(await store.getData("x"), undefined);
      });
    } finally {
      await p.cleanup();
      await client.close();
    }
  },
});

Deno.test({
  name: "redis (real server): two replicas share windows, sessions and invalidations",
  ignore,
  async fn() {
    const one = redisClient(URL_!);
    const two = redisClient(URL_!);
    const p = prefixes(one);
    const prefix = p.next();
    try {
      const [a, b] = [one, two].map((client) => redisRateLimitStore({ client, prefix }));
      const counts = await Promise.all(
        Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).increment("k", 60_000)),
      );
      assertEquals(counts.map((w) => w.count).sort((x, y) => x - y).at(-1), 40);
      const ttl = Number(await one.command("PTTL", `${prefix}k`));
      assert(ttl > 50_000 && ttl <= 60_000, `the window key expires with the window (${ttl})`);

      const sessions = [one, two].map((client) => redisSessionStore({ client, prefix }));
      const exp = Math.floor(Date.now() / 1000) + 3600;
      await sessions[0].create("s", { user: { id: "u" }, provider: "p", expiresAt: exp });
      assertEquals((await sessions[1].get("s"))?.user.id, "u");
      await sessions[1].deleteByUser("u");
      assertEquals(
        await sessions[0].update!("s", { user: { id: "u" }, provider: "p", expiresAt: exp }),
        false,
        "revoked on one replica, never written back by the other",
      );

      const cachePrefix = p.next();
      const [c1, c2] = [one, two].map((client) => redisCacheStore({ client, prefix: cachePrefix }));
      await c1.setData("d", { value: 1, expiresAt: Infinity, tags: ["t"] });
      await c2.deleteByTag("t");
      assertEquals(await c1.getData("d"), undefined, "invalidated on the other replica");
    } finally {
      await p.cleanup();
      await one.close();
      await two.close();
    }
  },
});

Deno.test({
  name: "redis (real server): ACL AUTH, SELECT and a wrong password",
  ignore,
  async fn() {
    const admin = redisClient(URL_!);
    const user = `dnx_${crypto.randomUUID().slice(0, 8)}`;
    try {
      await admin.command("ACL", "SETUSER", user, "on", ">pw-1", "~dnx-acl:*", "+@all");
      const url = new URL(URL_!);
      url.username = user;
      url.password = "pw-1";
      url.pathname = "/1";
      const client = redisClient(url.href);
      assertEquals(await client.command("SET", "dnx-acl:k", "v"), "OK");
      assertEquals(await client.command("GET", "dnx-acl:k"), "v");
      await client.command("DEL", "dnx-acl:k");
      await client.close();
      url.password = "wrong";
      const bad = redisClient(url.href);
      try {
        await bad.command("PING");
        throw new Error("expected WRONGPASS");
      } catch (error) {
        assert(error instanceof RedisError && error.code === "WRONGPASS", String(error));
      } finally {
        await bad.close();
      }
    } finally {
      await admin.command("ACL", "DELUSER", user);
      await admin.close();
    }
  },
});

Deno.test({
  name: "redis (real server): two Live replicas share channels and presence through pub/sub",
  ignore,
  async fn() {
    await liveAcrossTwoReplicas(URL_!);
  },
});
