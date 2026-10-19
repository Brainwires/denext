// `unstable_cache()` nested in a `"use cache"` function, and the reverse — Next.js 16.4's
// `unstable-cache.ts` + `use-cache-wrapper.ts` rules: the call's `tags` and `revalidate` reach the
// outer entry (hit or miss; the minimum revalidate wins, an explicit `cacheLife()` wins over
// both), a stale hit inside a cached function refreshes in the foreground so the outer entry never
// stores a stale value, a `"use cache"` inside a loader keeps its tags and lifetime to itself, a
// loader inside a loader bypasses its own cache, and `revalidate: 0` is refused at construction.
// The propagation runs on the in-memory store and the node:sqlite one, so the tags are seen to
// reach a durable store's entry (the other stores prove the same through `cacheStoreContract`).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  __useCache,
  cacheLife,
  type CacheStore,
  cacheTag,
  inMemoryCacheStore,
  revalidateTag,
  setCacheStore,
  unstable_cache,
  withCacheScope,
} from "../src/server/cache.ts";
import { sqliteCacheStore } from "../src/server/sqlite-cache.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { makeTempDirUntilExit } from "./helpers/temp.ts";

const request = () => createRequestContext(new Request("http://x/"));
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(request(), fn);

/** A `"use cache"` entry's store key (see `sharedCacheEntry`). */
const cachedKey = (id: string, args: unknown[] = []) => JSON.stringify([id, args]);
/** An `unstable_cache` entry's store key (see `unstable_cache`). */
const unstableKey = (keyParts: string[], args: unknown[] = []) => JSON.stringify([keyParts, args]);

const stores: Record<string, () => CacheStore> = {
  memory: () => inMemoryCacheStore(),
  sqlite: () => sqliteCacheStore({ path: `${makeTempDirUntilExit("denext_uc_nest_")}/cache.db` }),
};

for (const [name, make] of Object.entries(stores)) {
  Deno.test(`[${name}] unstable_cache inside "use cache": its tags and revalidate reach the outer entry, hit or miss`, async () => {
    const store = make();
    setCacheStore(store);
    try {
      let inner = 0;
      let outer = 0;
      const id = `nest#${name}-outer`;
      const load = unstable_cache(() => Promise.resolve(++inner), [`nest#${name}-inner`], {
        tags: ["posts"],
        revalidate: 60,
      });
      const page = __useCache(id, async (x: number) => {
        outer++;
        return `${x}:${await load()}`;
      });
      const t0 = Date.now();
      assertEquals(await inRequest(() => page(1)), "1:1");
      const e = await store.getData(cachedKey(id, [1]));
      assert(e, "the outer entry is stored");
      assertEquals(e.tags, ["posts"], "the loader's tags reach the outer entry");
      assert(
        e.staleAt! >= t0 + 60_000 && e.staleAt! <= Date.now() + 60_000,
        `revalidate 60 caps the default profile's 900 (staleAt ${e.staleAt})`,
      );
      assertEquals(e.expiresAt, Infinity, "the outer entry's expire is left to the profile");
      // Another outer entry: a miss for the outer function, a HIT for the loader — tagged too.
      assertEquals(await inRequest(() => page(2)), "2:1");
      assertEquals(inner, 1, "the loader's entry was a hit");
      assertEquals((await store.getData(cachedKey(id, [2])))?.tags, ["posts"]);
      assertEquals(await inRequest(() => page(1)), "1:1");
      assertEquals(outer, 2, "both outer entries are served from the store");
      // Revalidating the loader's tag drops the outer entries with it.
      await revalidateTag("posts");
      assertEquals(await inRequest(() => page(1)), "1:2", "both recomputed");
      assertEquals(outer, 3);
      assertEquals(inner, 2);
    } finally {
      (store as { close?: () => void }).close?.();
      setCacheStore(inMemoryCacheStore());
    }
  });
}

Deno.test("the minimum revalidate wins, `false` never shortens, and the outer cacheLife() wins over all", async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  const a = unstable_cache(() => Promise.resolve(1), ["nest#min-a"], { revalidate: 120 });
  const b = unstable_cache(() => Promise.resolve(1), ["nest#min-b"], {
    revalidate: 45,
    tags: ["b"],
  });
  const forever = unstable_cache(() => Promise.resolve(1), ["nest#min-forever"], {
    revalidate: false,
    tags: ["forever"],
  });
  // The scope records what the calls propagated: the lowest revalidate, every tag once.
  const { scope } = await withCacheScope(async () => {
    await a();
    await b();
    await b();
    await forever();
  });
  assertEquals(scope.nested, { revalidate: 45 });
  assertEquals(scope.tags, ["b", "forever"]);
  // Stored entries: `false` leaves the default 900 s; an explicit cacheLife() stands even
  // when it is longer than the loader's revalidate (Next.js: explicitRevalidate wins).
  const implicit = __useCache("nest#min-implicit", () => forever());
  const explicit = __useCache("nest#min-explicit", () => {
    cacheLife("hours"); // revalidate 3600 > b's 45
    return b();
  });
  const t0 = Date.now();
  await inRequest(async () => {
    await implicit();
    await explicit();
  });
  const i = await store.getData(cachedKey("nest#min-implicit"));
  assert(i && i.staleAt! >= t0 + 900_000, "revalidate: false leaves the default 900 s");
  assertEquals(i.tags, ["forever"]);
  const x = await store.getData(cachedKey("nest#min-explicit"));
  assert(x && x.staleAt! >= t0 + 3600_000, "cacheLife('hours') stands above the loader's 45 s");
  assertEquals(x.tags, ["b"]);
});

Deno.test('a `"use cache: private"` scope takes the loader\'s tags and revalidate too', async () => {
  setCacheStore(inMemoryCacheStore());
  const load = unstable_cache(() => Promise.resolve(1), ["nest#priv"], {
    tags: ["p"],
    revalidate: 10,
  });
  const { scope } = await withCacheScope(() => load(), "private");
  assertEquals(scope.tags, ["p"]);
  assertEquals(scope.nested, { revalidate: 10 });
});

Deno.test("a stale loader hit refreshes in the foreground inside a cached function, in the background outside", async () => {
  setCacheStore(inMemoryCacheStore());
  let n = 0;
  const load = unstable_cache(() => Promise.resolve(++n), ["nest#stale"], { tags: ["s"] });
  const outer = __useCache("nest#stale-outer", async (k: number) => `${k}:${await load()}`);
  assertEquals(await inRequest(() => load()), 1);
  await revalidateTag("s", "max"); // soft: stale now, served while it refreshes
  // Outside a cached function: the stale value now, the refresh in the background.
  const ctx = request();
  assertEquals(await runWithContext(ctx, () => load()), 1, "stale, served at once");
  await Promise.all(ctx.deferred.map((d) => d()));
  assertEquals(n, 2, "refreshed in the background");
  await revalidateTag("s", "max");
  // Inside one: the fresh value, so the outer entry never holds the stale one.
  assertEquals(await inRequest(() => outer(1)), "1:3", "refreshed in the foreground");
  assertEquals(await inRequest(() => outer(1)), "1:3", "the outer entry holds the fresh value");
  // A refresh that fails leaves the stale value standing in.
  let down = false;
  const flaky = unstable_cache(
    () => down ? Promise.reject(new Error("down")) : Promise.resolve("ok"),
    ["nest#flaky"],
    { tags: ["f"] },
  );
  assertEquals(await inRequest(() => flaky()), "ok");
  await revalidateTag("f", "max");
  down = true;
  const wrap = __useCache("nest#flaky-outer", () => flaky());
  assertEquals(await inRequest(() => wrap()), "ok", "the stale value when the refresh fails");
});

Deno.test('the reverse: a `"use cache"` inside a loader keeps its tags and lifetime to itself, and refreshes in the foreground when stale', async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  let inner = 0;
  let outer = 0;
  const cached = __useCache("nest#rev-inner", () => {
    cacheTag("rev");
    cacheLife("minutes"); // revalidate 60, expire 3600
    return Promise.resolve(++inner);
  });
  const load = unstable_cache(async () => {
    outer++;
    return `o${await cached()}`;
  }, ["nest#rev-outer"]);
  assertEquals(await inRequest(() => load()), "o1");
  const e = await store.getData(unstableKey(["nest#rev-outer"]));
  assert(e, "the loader's entry is stored");
  assertEquals(e.tags, [], "the inner entry's tag does not reach the loader's entry (Next.js)");
  assertEquals(e.expiresAt, Infinity, "nor does its lifetime");
  // The inner entry, soft-expired, refreshes in the foreground when another loader reads it.
  await revalidateTag("rev", "max");
  const other = unstable_cache(() => cached(), ["nest#rev-other"]);
  assertEquals(await inRequest(() => other()), 2, "fresh, not the stale 1");
  assertEquals(inner, 2);
  // Hard-revalidating the inner tag leaves the loader's entry standing.
  await revalidateTag("rev");
  assertEquals(await inRequest(() => load()), "o1", "the loader's entry stands");
  assertEquals(outer, 1);
});

Deno.test("a loader inside another loader bypasses its own cache (Next.js's rule)", async () => {
  setCacheStore(inMemoryCacheStore());
  let inner = 0;
  const load = unstable_cache(() => Promise.resolve(++inner), ["nest#uu-inner"]);
  const outerA = unstable_cache(() => load(), ["nest#uu-a"]);
  const outerB = unstable_cache(() => load(), ["nest#uu-b"]);
  assertEquals(await inRequest(() => load()), 1);
  assertEquals(await inRequest(() => outerA()), 2, "the loader re-ran inside the outer one");
  assertEquals(await inRequest(() => outerB()), 3);
  assertEquals(await inRequest(() => outerA()), 2, "the outer entry holds its result");
  assertEquals(await inRequest(() => load()), 3, "the nested run was stored for callers outside");
});

Deno.test("unstable_cache refuses revalidate: 0 and an invalid revalidate at construction (Next.js's messages)", () => {
  function loader() {
    return Promise.resolve(1);
  }
  assertThrows(
    () => unstable_cache(loader, ["k"], { revalidate: 0 }),
    Error,
    'Invariant revalidate: 0 can not be passed to unstable_cache(), must be "false" or "> 0" loader',
  );
  assertThrows(
    () => unstable_cache(loader, ["k"], { revalidate: -5 }),
    Error,
    'Invalid revalidate value "-5" on "unstable_cache loader", must be a non-negative number or false',
  );
  assertThrows(
    () => unstable_cache(loader, ["k"], { revalidate: "60" as never }),
    Error,
    'Invalid revalidate value "60"',
  );
  assertThrows(
    () => unstable_cache(loader, ["k"], { revalidate: NaN }),
    Error,
    "Invalid revalidate",
  );
  // `false`, `Infinity` and an omitted revalidate mean no expiry.
  unstable_cache(loader, ["k"], { revalidate: false });
  unstable_cache(loader, ["k"], { revalidate: Infinity });
  unstable_cache(loader, ["k"]);
});
