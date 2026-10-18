// Automatic fetch() caching (uncached by default). A bare fetch() is passed
// through uncached; a GET given next:{revalidate,tags} or cache:"force-cache" is
// cached in the data cache and its tags feed revalidateTag.

import { assert, assertEquals } from "@std/assert";
import {
  __setFetchBaseForTests,
  __useCache,
  cachedFetch,
  type CacheStore,
  type DataEntry,
  inMemoryCacheStore,
  installFetchCache,
  revalidateTag,
  setCacheStore,
} from "../src/server/cache.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { DEFAULT_SEGMENT_CONFIG } from "../src/server/segment-config.ts";

/**
 * Swap the fetch base for a counting stub: `respond(calls, init)` builds each response
 * (`calls` is the 1-based hit count). Returns the live counter + a restore function.
 */
function stubFetchBase(respond: (calls: number, init?: RequestInit) => Response) {
  const counter = { calls: 0 };
  const prev = __setFetchBaseForTests(
    ((_input: RequestInfo | URL, init?: RequestInit) => {
      counter.calls++;
      return Promise.resolve(respond(counter.calls, init));
    }) as typeof fetch,
  );
  return { counter, restore: () => __setFetchBaseForTests(prev) };
}

Deno.test("automatic fetch caching: default uncached, explicit opt-in cached", async () => {
  setCacheStore(inMemoryCacheStore());
  installFetchCache();
  const { counter, restore } = stubFetchBase((n) =>
    new Response(JSON.stringify({ n }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );

  try {
    const ctx = createRequestContext(new Request("http://x/"));
    await runWithContext(ctx, async () => {
      // Bare fetch: NOT cached — each call hits the network.
      await fetch("http://api/a");
      await fetch("http://api/a");
      assertEquals(counter.calls, 2, "bare fetch is uncached");

      // cache:"no-store": explicitly uncached.
      await fetch("http://api/a", { cache: "no-store" });
      assertEquals(counter.calls, 3, "no-store is uncached");

      // cache:"force-cache": second call served from cache (same body).
      const a = await (await fetch("http://api/b", { cache: "force-cache" })).json();
      const b = await (await fetch("http://api/b", { cache: "force-cache" })).json();
      assertEquals(counter.calls, 4, "force-cache fetches once");
      assertEquals(a.n, b.n, "cached body is reused");

      // POST is never cached even with force-cache.
      await fetch("http://api/b", { method: "POST", cache: "force-cache" });
      await fetch("http://api/b", { method: "POST", cache: "force-cache" });
      assertEquals(counter.calls, 6, "non-GET is uncached");

      // next:{revalidate,tags}: cached and tagged.
      await fetch("http://api/c", { next: { revalidate: 60, tags: ["c"] } } as RequestInit);
      await fetch("http://api/c", { next: { revalidate: 60, tags: ["c"] } } as RequestInit);
      assertEquals(counter.calls, 7, "tagged fetch cached once");
    });

    // revalidateTag purges the tagged fetch entry.
    await revalidateTag("c");
    await runWithContext(createRequestContext(new Request("http://x/")), async () => {
      await fetch("http://api/c", { next: { revalidate: 60, tags: ["c"] } } as RequestInit);
      assertEquals(counter.calls, 8, "re-fetched after revalidateTag");
    });

    // Outside a request context: never cached.
    const before = counter.calls;
    await fetch("http://api/b", { cache: "force-cache" });
    await fetch("http://api/b", { cache: "force-cache" });
    assertEquals(counter.calls, before + 2, "outside a request, fetch is uncached");
  } finally {
    restore();
  }
});

Deno.test("fetchCache segment default shifts the baseline (force-cache / force-no-store)", async () => {
  setCacheStore(inMemoryCacheStore());
  installFetchCache();
  const { counter, restore } = stubFetchBase((n) =>
    new Response(JSON.stringify({ n }), { status: 200 })
  );
  try {
    // force-cache: a BARE GET (no per-call opt-in) is now cached.
    const forceCacheCtx = createRequestContext(new Request("http://x/"));
    forceCacheCtx.segmentConfig = { ...DEFAULT_SEGMENT_CONFIG, fetchCache: "force-cache" };
    await runWithContext(forceCacheCtx, async () => {
      await fetch("http://api/fc");
      await fetch("http://api/fc");
      assertEquals(counter.calls, 1, "force-cache caches a bare GET");
    });

    // force-no-store: even an explicit opt-in is NOT cached.
    const noStoreCtx = createRequestContext(new Request("http://x/"));
    noStoreCtx.segmentConfig = { ...DEFAULT_SEGMENT_CONFIG, fetchCache: "force-no-store" };
    const before = counter.calls;
    await runWithContext(noStoreCtx, async () => {
      await fetch("http://api/ns", { cache: "force-cache" });
      await fetch("http://api/ns", { cache: "force-cache" });
      assertEquals(counter.calls, before + 2, "force-no-store overrides a per-call opt-in");
    });
  } finally {
    restore();
  }
});

Deno.test("M3: automatic cache keys on request headers (no cross-user body reuse)", async () => {
  setCacheStore(inMemoryCacheStore());
  installFetchCache();
  const { counter, restore } = stubFetchBase((n, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "none";
    return new Response(JSON.stringify({ n, auth }), { status: 200 });
  });
  try {
    await runWithContext(createRequestContext(new Request("http://x/")), async () => {
      // Same URL + same TTL, different Authorization → distinct entries. Before the
      // fix both collided onto one key and Bob would be served Alice's body.
      const alice = await (await fetch("http://api/u", {
        cache: "force-cache",
        headers: { authorization: "Bearer alice" },
      })).json();
      const bob = await (await fetch("http://api/u", {
        cache: "force-cache",
        headers: { authorization: "Bearer bob" },
      })).json();
      assertEquals(counter.calls, 2, "differing headers must not share a cache entry");
      assertEquals(alice.auth, "Bearer alice");
      assertEquals(bob.auth, "Bearer bob");

      // Re-request Alice's exact headers → served from cache (no new network hit).
      const aliceAgain = await (await fetch("http://api/u", {
        cache: "force-cache",
        headers: { authorization: "Bearer alice" },
      })).json();
      assertEquals(counter.calls, 2, "identical headers reuse the cached body");
      assertEquals(aliceAgain.n, alice.n);
    });
  } finally {
    restore();
  }
});

Deno.test("M3: cachedFetch keys on Headers-instance auth (no collision)", async () => {
  setCacheStore(inMemoryCacheStore());
  let calls = 0;
  // cachedFetch's inner loader calls the GLOBAL fetch directly, so stub that.
  const prevGlobal = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const auth = new Headers(init?.headers).get("authorization") ?? "none";
    return Promise.resolve(new Response(`body:${auth}`, { status: 200 }));
  }) as typeof fetch;
  try {
    // A `Headers` instance previously serialized to "{}" in the key → collision.
    const a = await cachedFetch("http://api/v", {
      headers: new Headers({ authorization: "Bearer alice" }),
    });
    const b = await cachedFetch("http://api/v", {
      headers: new Headers({ authorization: "Bearer bob" }),
    });
    assertEquals(a, "body:Bearer alice");
    assertEquals(b, "body:Bearer bob");
    assert(a !== b, "distinct Authorization headers must not collide");
    assertEquals(calls, 2);
    // Identical headers reuse the cached body (no new call).
    const aAgain = await cachedFetch("http://api/v", {
      headers: new Headers({ authorization: "Bearer alice" }),
    });
    assertEquals(aAgain, "body:Bearer alice");
    assertEquals(calls, 2, "identical headers hit the cache");
  } finally {
    globalThis.fetch = prevGlobal;
  }
});

/** A store that records every data entry written, over the in-memory one. */
function recordingStore(): { store: CacheStore; written: DataEntry[] } {
  const base = inMemoryCacheStore();
  const written: DataEntry[] = [];
  const store: CacheStore = {
    getData: (k) => base.getData(k),
    setData: (k, e) => {
      written.push(e);
      return base.setData(k, e);
    },
    getPage: (k) => base.getPage(k),
    setPage: (k, p) => base.setPage(k, p),
    deleteByTag: (t) => base.deleteByTag(t),
    deleteByPath: (p) => base.deleteByPath(p),
    expireByTag: (t, timing) => base.expireByTag!(t, timing),
  };
  return { store, written };
}

/** Stub the global fetch (cachedFetch's loader) with a counter; returns the counter + restore. */
function stubGlobalFetch(body: (calls: number) => string) {
  const counter = { calls: 0 };
  const prev = globalThis.fetch;
  globalThis.fetch = (() => {
    counter.calls++;
    return Promise.resolve(new Response(body(counter.calls), { status: 200 }));
  }) as typeof fetch;
  return { counter, restore: () => void (globalThis.fetch = prev) };
}

Deno.test("cachedFetch: revalidate and tags are the stored entry's, and revalidateTag purges it", async () => {
  const { store, written } = recordingStore();
  setCacheStore(store);
  const { counter, restore } = stubGlobalFetch((n) => `body ${n}`);
  const posts = { revalidate: 60, tags: ["posts"] };
  try {
    const t0 = Date.now();
    assertEquals(await cachedFetch("http://api/posts", posts), "body 1");
    assertEquals(written.length, 1, "one entry stored");
    assertEquals(written[0].tags, ["posts"], "the tags option reaches the entry");
    assert(
      written[0].expiresAt >= t0 + 60_000 && written[0].expiresAt <= Date.now() + 60_000,
      `revalidate 60 is the entry's TTL (expiresAt ${written[0].expiresAt})`,
    );
    assertEquals(await cachedFetch("http://api/posts", posts), "body 1");
    assertEquals(counter.calls, 1, "a hit");
    await revalidateTag("posts");
    assertEquals(await cachedFetch("http://api/posts", posts), "body 2");
    assertEquals(counter.calls, 2, "purged by its tag, fetched again");
    // Another call site tagging the same URL differently gets its own entry (its own tags).
    assertEquals(await cachedFetch("http://api/posts", { tags: ["feed"] }), "body 3");
    assertEquals(written.at(-1)?.tags, ["feed"]);
    assertEquals(written.at(-1)?.expiresAt, Infinity, "no revalidate: no expiry");
    // `revalidate: 0` is fetch's no-store: fetched every time, nothing stored.
    const before = written.length;
    assertEquals(await cachedFetch("http://api/live", { revalidate: 0 }), "body 4");
    assertEquals(await cachedFetch("http://api/live", { revalidate: 0 }), "body 5");
    assertEquals(written.length, before, "nothing stored");
  } finally {
    restore();
    setCacheStore(inMemoryCacheStore());
  }
});

Deno.test('cachedFetch inside a "use cache" function: its tags and revalidate reach the outer entry and the page', async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  const { restore } = stubGlobalFetch((n) => `body ${n}`);
  try {
    const outer = __useCache(
      "fc#outer",
      () => cachedFetch("http://api/posts", { revalidate: 30, tags: ["posts"] }),
    );
    const ctx = createRequestContext(new Request("http://x/"));
    const t0 = Date.now();
    assertEquals(await runWithContext(ctx, () => outer()), "body 1");
    assert(ctx.collectedTags?.has("posts"), "the page carries the tag");
    const entry = await store.getData(JSON.stringify(["fc#outer", []]));
    assert(entry, "the outer entry is stored");
    assertEquals(entry.tags, ["posts"], "the fetch's tags reach the outer entry");
    assert(
      entry.staleAt! >= t0 + 30_000 && entry.staleAt! <= Date.now() + 30_000,
      "the fetch's revalidate caps the outer entry's",
    );
    await revalidateTag("posts");
    const again = createRequestContext(new Request("http://x/"));
    assertEquals(
      await runWithContext(again, () => outer()),
      "body 2",
      "revalidating the fetch's tag drops the outer entry too",
    );
  } finally {
    restore();
    setCacheStore(inMemoryCacheStore());
  }
});
