// The exported store contract suites (`denext/testing`: cacheStoreContract,
// sessionStoreContract, rateLimitStoreContract) against denext's in-process and file stores,
// plus the suites' own behaviour: a store that breaks the contract fails with a message that
// names what it got wrong. Postgres runs them in tests/helpers/postgres-suites.ts, Redis in
// tests/redis-stores.test.ts, Deno KV in tests/deno-kv-stores.test.ts.

import { assertRejects, assertStringIncludes } from "@std/assert";
import {
  cacheStoreContract,
  rateLimitStoreContract,
  sessionStoreContract,
  StoreContractError,
} from "../src/testing/mod.ts";
import { type CacheStore, inMemoryCacheStore } from "../src/server/cache.ts";
import { sqliteCacheStore } from "../src/server/sqlite-cache.ts";
import { inMemorySessionStore, type SessionStore } from "../src/server/auth/session-store.ts";
import { sqliteSessionStore } from "../src/server/auth/sqlite-session-store.ts";
import { inMemoryRateLimitStore } from "../src/server/auth/rate-limit.ts";

/** A fresh SQLite file per case, removed when the test ends. */
function tempFiles() {
  const dir = Deno.makeTempDirSync({ prefix: "dnx-contract-" });
  let n = 0;
  return {
    next: () => `${dir}/${n++}.db`,
    cleanup: () => Deno.removeSync(dir, { recursive: true }),
  };
}

Deno.test("in-memory stores pass the store contracts", async (t) => {
  await t.step("CacheStore", (t) => cacheStoreContract(t, () => inMemoryCacheStore()));
  await t.step("SessionStore", (t) => sessionStoreContract(t, () => inMemorySessionStore()));
  await t.step("RateLimitStore", (t) => rateLimitStoreContract(t, () => inMemoryRateLimitStore()));
});

Deno.test("SQLite stores pass the store contracts", async (t) => {
  const files = tempFiles();
  try {
    await t.step(
      "CacheStore",
      (t) => cacheStoreContract(t, () => sqliteCacheStore({ path: files.next() })),
    );
    await t.step(
      "SessionStore",
      (t) => sessionStoreContract(t, () => sqliteSessionStore({ path: files.next() })),
    );
  } finally {
    files.cleanup();
  }
});

/** A fresh in-memory cache with some methods replaced. */
function cache(overrides: Partial<CacheStore>): CacheStore {
  const base = inMemoryCacheStore();
  return {
    getData: (k) => base.getData(k),
    setData: (k, e) => base.setData(k, e),
    getPage: (k) => base.getPage(k),
    setPage: (k, p) => base.setPage(k, p),
    deleteByTag: (t) => base.deleteByTag(t),
    deleteByPath: (p) => base.deleteByPath(p),
    ...overrides,
  };
}

/** A runner that collects case failures instead of failing the test. */
function collecting() {
  const failures: string[] = [];
  return {
    failures,
    async step(name: string, fn: () => Promise<void>) {
      try {
        await fn();
      } catch (error) {
        if (!(error instanceof StoreContractError)) throw error;
        failures.push(`${name}: ${error.message}`);
      }
    },
  };
}

Deno.test("a store that breaks the contract fails, naming the case and the difference", async () => {
  // A cache that never forgets a tag: deleteByTag is a no-op.
  const runner = collecting();
  await cacheStoreContract(runner, () => cache({ deleteByTag() {} }));
  assertStringIncludes(runner.failures.join("\n"), "deleteByTag purges tagged data and pages");
  assertStringIncludes(runner.failures.join("\n"), "tagged page p1: expected undefined");

  // A session store whose update upserts (resurrects a revoked session).
  const upserting = (): SessionStore => {
    const store = inMemorySessionStore();
    return { ...store, update: (id, s) => (store.create(id, s), true) };
  };
  const sessions = collecting();
  await sessionStoreContract(sessions, upserting);
  assertStringIncludes(sessions.failures.join("\n"), "write-only-if-present");

  // A rate-limit store that slides its window on every failure.
  const sliding = collecting();
  await rateLimitStoreContract(sliding, () => {
    const store = inMemoryRateLimitStore();
    return {
      ...store,
      increment: async (key, windowMs) => {
        const w = await store.increment(key, windowMs);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { ...w, resetAt: Date.now() + windowMs };
      },
    };
  });
  assertStringIncludes(sliding.failures.join("\n"), "the second failure");

  // A failure that is not a contract violation propagates as is.
  await assertRejects(
    () =>
      cacheStoreContract(
        collecting(),
        () => cache({ getData: () => Promise.reject(new TypeError("boom")) }),
      ),
    TypeError,
    "boom",
  );
});
