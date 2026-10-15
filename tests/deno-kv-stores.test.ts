// denext's Deno KV stores on a real in-memory `Deno.openKv(":memory:")` (the suite runs with
// --unstable-kv): the exported store contracts, plus chunked large values, the sweep's caps and
// expiry, ownership of a database the store opened, conflict retries, and the clear error on a
// Deno without KV.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { denoKvCacheStore } from "../src/server/deno-kv-cache.ts";
import { denoKvRateLimitStore, denoKvSessionStore } from "../src/server/auth/deno-kv-stores.ts";
import { DenoKvUnsupportedError, type KvLike, retryCommit } from "../src/server/deno-kv.ts";
import {
  cacheStoreContract,
  rateLimitStoreContract,
  sessionStoreContract,
} from "../src/testing/mod.ts";

const openKv = (Deno as unknown as { openKv: (path?: string) => Promise<KvLike> }).openKv;

/** Every key in the database, as JSON, for assertions. */
async function keys(kv: KvLike): Promise<string[]> {
  const out: string[] = [];
  for await (const e of kv.list({ prefix: [] })) out.push(JSON.stringify(e.key));
  return out;
}

Deno.test("Deno KV stores pass the store contracts", async (t) => {
  const kv = await openKv(":memory:");
  let n = 0;
  try {
    await t.step(
      "CacheStore",
      (t) => cacheStoreContract(t, () => denoKvCacheStore({ kv, prefix: [`c${n++}`] })),
    );
    await t.step(
      "SessionStore",
      (t) => sessionStoreContract(t, () => denoKvSessionStore({ kv, prefix: [`s${n++}`] })),
    );
    await t.step(
      "RateLimitStore",
      (t) => rateLimitStoreContract(t, () => denoKvRateLimitStore({ kv, prefix: [`r${n++}`] })),
    );
  } finally {
    kv.close();
  }
});

Deno.test("kv cache: a large value is chunked, and its chunks go when it is replaced", async () => {
  const kv = await openKv(":memory:");
  const store = denoKvCacheStore({ kv });
  try {
    const big = "x".repeat(200_000);
    await store.setData("big", { value: big, expiresAt: Infinity, tags: [] });
    const chunks = (await keys(kv)).filter((k) => k.includes('"chunk"'));
    assertEquals(chunks.length, 4, "200 KB in 60 KB chunks");
    assertEquals((await store.getData("big"))?.value, big);
    await store.setData("big", { value: "small", expiresAt: Infinity, tags: [] });
    assertEquals((await keys(kv)).filter((k) => k.includes('"chunk"')), [], "old chunks dropped");
    await store.setData("big2", { value: big, expiresAt: Infinity, tags: [] });
    await store.deleteByTag("none");
    const [chunk] = (await keys(kv)).filter((k) => k.includes('"chunk"'));
    await kv.atomic().delete(JSON.parse(chunk)).commit();
    assertEquals((await store.getData("big2"))?.value, undefined, "a missing chunk reads empty");
  } finally {
    kv.close();
  }
});

Deno.test("kv cache: the sweep evicts the oldest past the caps and removes expired entries", async () => {
  const kv = await openKv(":memory:");
  const store = denoKvCacheStore({ kv, maxDataEntries: 2, maxPageEntries: 1, sweepIntervalMs: 0 });
  try {
    for (const key of ["a", "b", "c"]) {
      await store.setData(key, { value: key, expiresAt: Infinity, tags: ["t"] });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assertEquals(await store.getData("a"), undefined, "evicted");
    assertEquals((await store.getData("c"))?.value, "c");
    assert(!(await keys(kv)).some((k) => k.includes('"tag","t","data","a"')), "with its index");
    const page = { body: "x", status: 200, expiresAt: Infinity, tags: [] };
    await store.setPage("p1", { ...page, path: "/1" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.setPage("p2", { ...page, path: "/2" });
    assertEquals(await store.getPage("p1"), undefined);
    await store.setData("x", { value: 1, expiresAt: Date.now() + 5, tags: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.setData("y", { value: 1, expiresAt: Infinity, tags: [] }); // sweeps x
    assertEquals((await kv.get(["denext", "cache", "data", "x"])).value, null);
    // Throttled: a store with the default interval does not sweep on every write.
    const lazy = denoKvCacheStore({ kv, prefix: ["lazy"], maxDataEntries: 1 });
    await lazy.setData("1", { value: 1, expiresAt: Infinity, tags: [] });
    await lazy.setData("2", { value: 2, expiresAt: Infinity, tags: [] });
    assertEquals((await lazy.getData("2"))?.value, 2);
  } finally {
    kv.close();
  }
});

Deno.test("kv stores: a store given `path` opens and closes its own database; `kv` stays the app's", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-kv-" });
  try {
    const path = `${dir}/kv.sqlite3`;
    const cache = denoKvCacheStore({ path });
    await cache.setData("k", { value: 1, expiresAt: Infinity, tags: [] });
    await cache.close();
    await cache.close();
    await assertRejects(() => Promise.resolve(cache.getData("k")), Error, "closed");
    const sessions = denoKvSessionStore({ path });
    await sessions.close();
    const limits = denoKvRateLimitStore({ path });
    assertEquals((await limits.increment("k", 60_000)).count, 1);
    await limits.close();
    const kv = await openKv(path);
    const shared = denoKvCacheStore({ kv });
    assertEquals((await shared.getData("k"))?.value, 1, "the data persisted");
    await shared.close();
    assertEquals((await kv.get(["x"])).value, null, "the app's database is still open");
    kv.close();
    assertThrows(
      () => denoKvSessionStore({ kv, path }),
      TypeError,
      "not both",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("kv stores: a Deno without Deno.openKv gets a clear error", () => {
  const deno = Deno as unknown as { openKv?: unknown };
  const had = Object.getOwnPropertyDescriptor(deno, "openKv");
  Object.defineProperty(deno, "openKv", { value: undefined, configurable: true, writable: true });
  try {
    for (
      const [name, make] of [
        ["denoKvCacheStore", () => denoKvCacheStore()],
        ["denoKvSessionStore", () => denoKvSessionStore()],
        ["denoKvRateLimitStore", () => denoKvRateLimitStore()],
      ] as const
    ) {
      const error = assertThrows(make, DenoKvUnsupportedError);
      assert(error.message.startsWith(`${name}:`) && error.message.includes("--unstable-kv"));
      assertEquals(error.code, "unsupported");
    }
  } finally {
    if (had) Object.defineProperty(deno, "openKv", had);
  }
});

Deno.test("kv stores: concurrent writers retry their commits; retryCommit gives up eventually", async () => {
  const kv = await openKv(":memory:");
  try {
    const a = denoKvRateLimitStore({ kv });
    const b = denoKvRateLimitStore({ kv });
    const counts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).increment("k", 60_000)),
    );
    assertEquals(counts.map((w) => w.count).sort((x, y) => x - y)[19], 20);
    const sessions = denoKvSessionStore({ kv });
    const exp = Math.floor(Date.now() / 1000) + 60;
    await sessions.create("s", { user: { id: "u1" }, provider: "p", expiresAt: exp });
    assertEquals(
      await sessions.update!("s", { user: { id: "u2" }, provider: "p", expiresAt: exp }),
      true,
    );
    await sessions.deleteByUser("u1");
    assertEquals((await sessions.get("s"))?.user.id, "u2", "the old user's index was moved");
    await sessions.deleteByUser("u2");
    assertEquals(await sessions.get("s"), undefined);
    let attempts = 0;
    await assertRejects(
      () => retryCommit(() => Promise.resolve((attempts++, { done: false as const })), "x"),
      Error,
      "x: gave up",
    );
    assertEquals(attempts, 32);
  } finally {
    kv.close();
  }
});
