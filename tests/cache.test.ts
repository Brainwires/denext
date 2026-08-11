import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  cache,
  inMemoryCacheStore,
  PageCache,
  pageCacheExpiry,
  pageCacheTiming,
  revalidatePath,
  revalidateTag,
  setCacheStore,
  unstable_cache,
} from "../src/server/cache.ts";
import { cookies, createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { DEFAULT_SEGMENT_CONFIG } from "../src/server/segment-config.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageProps } from "../src/server/types.ts";

// ---- cache() request memoization -------------------------------------------

Deno.test("cache() memoizes within a request and resets across requests", () => {
  let calls = 0;
  const double = cache((x: number) => {
    calls++;
    return x * 2;
  });

  runWithContext(createRequestContext(new Request("http://x/")), () => {
    assertEquals(double(2), 4);
    assertEquals(double(2), 4);
    assertEquals(calls, 1); // memoized
    assertEquals(double(3), 6);
    assertEquals(calls, 2);
  });

  runWithContext(createRequestContext(new Request("http://x/")), () => {
    assertEquals(double(2), 4);
  });
  assertEquals(calls, 3); // fresh request -> recomputed

  // Outside a request there is no memo.
  double(2);
  double(2);
  assertEquals(calls, 5);
});

// ---- unstable_cache + revalidateTag ----------------------------------------

Deno.test("unstable_cache caches until its tag is revalidated", async () => {
  let n = 0;
  const load = unstable_cache(() => Promise.resolve(++n), ["uc-key"], { tags: ["t-uc"] });
  assertEquals(await load(), 1);
  assertEquals(await load(), 1); // cached
  await revalidateTag("t-uc");
  assertEquals(await load(), 2); // purged -> recomputed
});

// ---- PageCache -------------------------------------------------------------

Deno.test("PageCache stores, expires, and invalidates by path and tag", async () => {
  setCacheStore(inMemoryCacheStore()); // isolate from other tests' shared store
  const pc = new PageCache();
  await pc.set("/a", { body: "A", status: 200, path: "/a", expiresAt: Infinity, tags: ["ta"] });
  assertEquals((await pc.get("/a"))?.body, "A");

  // An already-past expiry is treated as a miss (and evicted).
  await pc.set("/b", { body: "B", status: 200, path: "/b", expiresAt: 1, tags: [] });
  assertEquals(await pc.get("/b"), undefined);

  await pc.revalidatePath("/a");
  assertEquals(await pc.get("/a"), undefined);

  await pc.set("/c", { body: "C", status: 200, path: "/c", expiresAt: Infinity, tags: ["tc"] });
  await revalidateTag("tc");
  assertEquals(await pc.get("/c"), undefined);
});

Deno.test("pageCacheExpiry honors dynamic/revalidate", () => {
  assertEquals(pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, dynamic: "force-dynamic" }), null);
  assertEquals(pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, dynamic: "force-static" }), Infinity);
  assertEquals(pageCacheExpiry(DEFAULT_SEGMENT_CONFIG), null); // auto + revalidate:false
  const e = pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, revalidate: 60 });
  assert(typeof e === "number" && e > Date.now());
});

Deno.test("pageCacheTiming: revalidate is stale-while-revalidate (no hard expiry)", () => {
  assertEquals(pageCacheTiming({ ...DEFAULT_SEGMENT_CONFIG, dynamic: "force-dynamic" }), null);
  assertEquals(pageCacheTiming({ ...DEFAULT_SEGMENT_CONFIG, dynamic: "force-static" }), {
    expiresAt: Infinity,
    staleAt: Infinity,
  });
  const t = pageCacheTiming({ ...DEFAULT_SEGMENT_CONFIG, revalidate: 60 });
  assert(t !== null);
  assertEquals(t.expiresAt, Infinity, "served indefinitely (stale-while-revalidate)");
  assert(t.staleAt > Date.now() && t.staleAt <= Date.now() + 60_000, "goes stale after revalidate");
});

// ---- App-level ISR ---------------------------------------------------------

function manifest(): RouteManifest {
  const base = {
    kind: "page" as const,
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  return {
    pages: [
      { ...base, pattern: parsePattern("cached"), routePath: "/cached", filePath: "cached.tsx" },
      { ...base, pattern: parsePattern("plain"), routePath: "/plain", filePath: "plain.tsx" },
    ],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

Deno.test("app ISR: cacheable page is served from cache on the second request", async () => {
  setCacheStore(inMemoryCacheStore()); // fresh ISR store per test (one store/process in prod)
  let renders = 0;
  const modules: Record<string, unknown> = {
    "cached.tsx": {
      default: (_p: PageProps) => {
        renders++;
        return h("h1", null, "cached");
      },
      revalidate: 60,
    },
    "plain.tsx": {
      default: (_p: PageProps) => {
        renders++;
        return h("h1", null, "plain");
      },
    },
  };
  const pageCache = new PageCache();
  const app = createApp({
    getManifest: manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache,
  });

  // First request renders and stores (MISS); second is served from cache (HIT).
  const r1 = await app(new Request("http://localhost/cached"));
  assertEquals(r1.headers.get("x-denext-cache"), "MISS");
  await r1.text();
  const r2 = await app(new Request("http://localhost/cached"));
  assertEquals(r2.headers.get("x-denext-cache"), "HIT");
  await r2.text();
  assertEquals(renders, 1); // second served from cache

  // revalidatePath purges -> next request re-renders.
  await revalidatePath("/cached");
  const r3 = await app(new Request("http://localhost/cached"));
  assertEquals(r3.headers.get("x-denext-cache"), "MISS");
  await r3.text();
  assertEquals(renders, 2);
});

Deno.test("app ISR: a stale entry is served immediately and regenerated in the background", async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  let renders = 0;
  const modules: Record<string, unknown> = {
    "cached.tsx": {
      default: (_p: PageProps) => {
        renders++;
        return h("h1", null, `fresh ${renders}`);
      },
      revalidate: 60,
    },
    "plain.tsx": { default: (_p: PageProps) => h("h1", null, "plain") },
  };
  const app = createApp({
    getManifest: manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache: new PageCache(),
  });

  // Seed a STALE cached entry (staleAt in the past, no hard expiry).
  await store.setPage("/cached", {
    body: "<!DOCTYPE html><html><body>STALE</body></html>",
    status: 200,
    path: "/cached",
    expiresAt: Infinity,
    staleAt: Date.now() - 1000,
    tags: [],
  });

  // The stale render is served immediately (STALE), and a background regen starts.
  const r1 = await app(new Request("http://localhost/cached"));
  assertEquals(r1.headers.get("x-denext-cache"), "STALE");
  assertStringIncludes(await r1.text(), "STALE");

  // Wait for the background regeneration to render AND store a fresh entry (poll
  // the store, not just the render counter — the store write trails the render).
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const probe = await store.getPage("/cached");
    if (probe && probe.staleAt != null && probe.staleAt > Date.now()) break;
  }
  assertEquals(renders, 1, "background regeneration rendered the page once");

  // The next request is now a fresh HIT with the regenerated body.
  const r2 = await app(new Request("http://localhost/cached"));
  assertEquals(r2.headers.get("x-denext-cache"), "HIT");
  assertStringIncludes(await r2.text(), "fresh 1");
});

Deno.test("app ISR: an opted-in page that reads cookies() is NOT cached (per-user safety)", async () => {
  setCacheStore(inMemoryCacheStore());
  let renders = 0;
  const modules: Record<string, unknown> = {
    "cached.tsx": {
      // Opts into caching, but reads a per-user cookie -> must stay dynamic.
      default: (_p: PageProps) => {
        renders++;
        const who = cookies().get("session") ?? "anon";
        return h("h1", null, `hello ${who}`);
      },
      revalidate: 60,
    },
    "plain.tsx": { default: (_p: PageProps) => h("h1", null, "plain") },
  };
  const app = createApp({
    getManifest: manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache: new PageCache(),
  });
  const alice = await app(
    new Request("http://localhost/cached", { headers: { cookie: "session=alice" } }),
  );
  assertStringIncludes(await alice.text(), "hello alice");
  // Not cached despite revalidate: reading cookies() forced a dynamic render,
  // so the response takes the normal (uncached) path — no cache header.
  assertEquals(alice.headers.get("x-denext-cache"), null);
  const bob = await app(
    new Request("http://localhost/cached", { headers: { cookie: "session=bob" } }),
  );
  assertStringIncludes(await bob.text(), "hello bob"); // Bob never sees Alice's render
  assertEquals(renders, 2);
});

Deno.test("app ISR: default (non-opted-in) page is never cached", async () => {
  setCacheStore(inMemoryCacheStore());
  let renders = 0;
  const modules: Record<string, unknown> = {
    "cached.tsx": { default: (_p: PageProps) => h("h1", null, "cached"), revalidate: 60 },
    "plain.tsx": {
      default: (_p: PageProps) => {
        renders++;
        return h("h1", null, "plain");
      },
    },
  };
  const app = createApp({
    getManifest: manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache: new PageCache(),
  });
  const a = await app(new Request("http://localhost/plain"));
  await a.text();
  const b = await app(new Request("http://localhost/plain"));
  await b.text();
  assertEquals(a.headers.get("x-denext-cache"), null); // not cached
  assertEquals(renders, 2); // rendered each time
});
