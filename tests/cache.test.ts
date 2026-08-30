import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  cache,
  type DataEntry,
  inMemoryCacheStore,
  PageCache,
  pageCacheExpiry,
  pageCacheTiming,
  revalidatePath,
  revalidateTag,
  safeKey,
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

Deno.test("safeKey throws on non-serializable args instead of a colliding fallback (CACHE-L3)", () => {
  // Serializable args produce a stable, distinct key.
  assertEquals(safeKey([{ a: 1 }]), '[{"a":1}]');
  assert(safeKey([{ a: 1 }]) !== safeKey([{ b: 2 }]), "distinct args → distinct keys");

  // A BigInt (JSON.stringify throws) must NOT collapse to a lossy String() key.
  assertThrows(() => safeKey([1n]), TypeError);
  // A circular reference likewise throws rather than silently colliding.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assertThrows(() => safeKey([circular]), TypeError);
  // Top-level function/undefined serialize to nothing → also rejected.
  assertThrows(() => safeKey(() => {}), TypeError);
  assertThrows(() => safeKey(undefined), TypeError);
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

Deno.test("pageCacheExpiry: revalidate 0 and revalidate false are both non-cacheable", () => {
  // Only a POSITIVE numeric revalidate caches; 0 (always-stale) and false (never
  // cache) both fall through to null. Boundary values the happy-path test skips.
  assertEquals(pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, revalidate: 0 }), null);
  assertEquals(pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, revalidate: false }), null);
});

Deno.test("pageCacheTiming: revalidate 0 and false yield no caching (null)", () => {
  assertEquals(pageCacheTiming({ ...DEFAULT_SEGMENT_CONFIG, revalidate: 0 }), null);
  assertEquals(pageCacheTiming({ ...DEFAULT_SEGMENT_CONFIG, revalidate: false }), null);
});

Deno.test("inMemoryCacheStore: page byte budget evicts the LRU beyond ~64MB (CACHE-M1)", async () => {
  const store = inMemoryCacheStore();
  const body = "x".repeat(1024 * 1024); // ~1 MB per page
  const mk = (i: number) => ({
    body,
    status: 200,
    path: `/p${i}`,
    expiresAt: Infinity,
    staleAt: Infinity,
    tags: [] as string[],
  });
  // 70 × ~1 MB exceeds the 64 MB byte budget, so the oldest must be evicted even
  // though we are far under the 1000-entry count cap.
  for (let i = 0; i < 70; i++) await store.setPage(`/p${i}`, mk(i));
  assertEquals(await store.getPage("/p0"), undefined, "oldest page evicted by byte budget");
  assert(await store.getPage("/p69"), "newest page retained");
});

Deno.test("M4: data byte budget evicts the LRU beyond ~32MB (far under the count cap)", async () => {
  const store = inMemoryCacheStore();
  const big = "y".repeat(1024 * 1024); // ~1 MB per value
  const mk = (): DataEntry => ({ value: big, expiresAt: Infinity, tags: [] });
  // 40 × ~1 MB exceeds the 32 MB data byte budget, so the oldest must be evicted
  // even though we are far under the 1000-entry count cap.
  for (let i = 0; i < 40; i++) await store.setData(`d${i}`, mk());
  assertEquals(await store.getData("d0"), undefined, "oldest data entry evicted by byte budget");
  assert(await store.getData("d39"), "newest data entry retained");
});

Deno.test("M4: byte total is reclaimed on tag purge (no leak across writes)", async () => {
  const store = inMemoryCacheStore();
  const big = "z".repeat(1024 * 1024);
  // Fill ~31 MB under one tag, purge it, then confirm a fresh fill still fits —
  // i.e. deleteByTag credited the freed bytes back (a stale byte total would
  // spuriously evict these new entries).
  for (let i = 0; i < 31; i++) {
    await store.setData(`t${i}`, { value: big, expiresAt: Infinity, tags: ["batch"] });
  }
  await store.deleteByTag("batch");
  for (let i = 0; i < 20; i++) {
    await store.setData(`u${i}`, { value: big, expiresAt: Infinity, tags: [] });
  }
  assert(await store.getData("u0"), "earliest post-purge entry retained (bytes were reclaimed)");
  assert(await store.getData("u19"), "latest post-purge entry retained");
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

Deno.test("app ISR: query-param order does not fork the cache key (CACHE-M3)", async () => {
  setCacheStore(inMemoryCacheStore());
  let renders = 0;
  const modules: Record<string, unknown> = {
    "cached.tsx": {
      default: (_p: PageProps) => {
        renders++;
        return h("h1", null, "cached");
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

  // First order MISSes and renders; the permuted order must HIT the same entry.
  const r1 = await app(new Request("http://localhost/cached?a=1&b=2"));
  assertEquals(r1.headers.get("x-denext-cache"), "MISS");
  await r1.text();
  const r2 = await app(new Request("http://localhost/cached?b=2&a=1"));
  assertEquals(r2.headers.get("x-denext-cache"), "HIT");
  await r2.text();
  assertEquals(renders, 1); // one entry, not two

  // A genuinely different query value is still a distinct entry (MISS).
  const r3 = await app(new Request("http://localhost/cached?a=9&b=2"));
  assertEquals(r3.headers.get("x-denext-cache"), "MISS");
  await r3.text();
  assertEquals(renders, 2);
});

Deno.test("M6: cacheKeyParams allowlist narrows the ISR key (junk params don't fork)", async () => {
  setCacheStore(inMemoryCacheStore());
  let renders = 0;
  const modules: Record<string, unknown> = {
    "cached.tsx": {
      default: (_p: PageProps) => {
        renders++;
        return h("h1", null, "cached");
      },
      revalidate: 60,
    },
  };
  const app = createApp({
    getManifest: manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache: new PageCache(),
    cacheKeyParams: ["page"], // only ?page participates in the key
  });

  // First request renders and caches under the "page=1" key.
  const r1 = await app(new Request("http://localhost/cached?page=1&utm_source=x"));
  assertEquals(r1.headers.get("x-denext-cache"), "MISS");
  await r1.text();
  // Same allowlisted param, DIFFERENT junk param → same key → HIT (no new render).
  const r2 = await app(new Request("http://localhost/cached?page=1&utm_source=y&fbclid=z"));
  assertEquals(r2.headers.get("x-denext-cache"), "HIT");
  await r2.text();
  assertEquals(renders, 1, "junk params must not fork the cache");

  // A different allowlisted value IS a distinct entry (MISS).
  const r3 = await app(new Request("http://localhost/cached?page=2"));
  assertEquals(r3.headers.get("x-denext-cache"), "MISS");
  await r3.text();
  assertEquals(renders, 2);
});

Deno.test("cacheKeyParams edge-3: a whole-body-cached render dev-warns on a dropped searchParams read", async () => {
  setCacheStore(inMemoryCacheStore());
  const prevDev = (globalThis as { __denextDev?: boolean }).__denextDev;
  (globalThis as { __denextDev?: boolean }).__denextDev = true;
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const modules: Record<string, unknown> = {
      "cached.tsx": {
        // Reads ?theme — which the narrowed key drops — straight into the output.
        default: (p: PageProps) =>
          h("h1", null, `theme:${(p.searchParams as URLSearchParams).get("theme")}`),
        revalidate: 60,
      },
    };
    const app = createApp({
      getManifest: manifest,
      load: (fp) => Promise.resolve(modules[fp]),
      pageCache: new PageCache(),
      cacheKeyParams: ["page"], // ?theme is NOT in the key
    });

    // Request A renders theme=dark, caches it under the page=1 key, and warns that a
    // non-allowlisted param was baked into the shared body.
    const rA = await app(new Request("http://localhost/cached?page=1&theme=dark"));
    assertEquals(rA.headers.get("x-denext-cache"), "MISS");
    assertStringIncludes(await rA.text(), "theme:dark");
    assert(
      warnings.some((w) => w.includes("cacheKeyParams") && w.includes("theme")),
      "expected a dev warning naming the dropped searchParams read",
    );

    // Request B: same keyed param, different theme → HIT serves A's body (theme=dark),
    // NOT theme=light — the cross-request bleed the warning flags.
    const rB = await app(new Request("http://localhost/cached?page=1&theme=light"));
    assertEquals(rB.headers.get("x-denext-cache"), "HIT");
    assertStringIncludes(await rB.text(), "theme:dark");
  } finally {
    console.warn = origWarn;
    (globalThis as { __denextDev?: boolean }).__denextDev = prevDev;
  }
});

Deno.test("cacheKeyParams edge-3: reading only allowlisted params does NOT warn", async () => {
  setCacheStore(inMemoryCacheStore());
  const prevDev = (globalThis as { __denextDev?: boolean }).__denextDev;
  (globalThis as { __denextDev?: boolean }).__denextDev = true;
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const modules: Record<string, unknown> = {
      "cached.tsx": {
        // Reads only ?page, which IS in the key — safe, no bleed.
        default: (p: PageProps) =>
          h("h1", null, `page:${(p.searchParams as URLSearchParams).get("page")}`),
        revalidate: 60,
      },
    };
    const app = createApp({
      getManifest: manifest,
      load: (fp) => Promise.resolve(modules[fp]),
      pageCache: new PageCache(),
      cacheKeyParams: ["page"],
    });

    const r = await app(new Request("http://localhost/cached?page=1&utm_source=x"));
    assertEquals(r.headers.get("x-denext-cache"), "MISS");
    await r.text();
    assert(
      !warnings.some((w) => w.includes("cacheKeyParams")),
      `no dev warning expected for an allowlisted-only read; got: ${warnings.join(" | ")}`,
    );
  } finally {
    console.warn = origWarn;
    (globalThis as { __denextDev?: boolean }).__denextDev = prevDev;
  }
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

Deno.test({
  name: "app ISR: a hung background regen frees its key and keeps serving stale (H2)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  let regenStarts = 0;
  // Isolated route/path: a non-cooperative hang (no signal threading) can't be
  // reclaimed and leaks this key's leader lock — same limitation as the foreground
  // timeout — so keep it off the shared "/cached" path used by other tests.
  const isoManifest = (): RouteManifest => ({
    pages: [{
      kind: "page",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
      pattern: parsePattern("h2"),
      routePath: "/h2",
      filePath: "h2.tsx",
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  });
  const modules: Record<string, unknown> = {
    // Every render here is a background regen (we seed the entry directly). It hangs
    // forever — standing in for a slow/hung upstream fetch with no timeout.
    "h2.tsx": {
      default: async (_p: PageProps) => {
        regenStarts++;
        await new Promise<void>(() => {}); // never settles
        return h("h1", null, "unreached");
      },
      revalidate: 60,
    },
  };
  // A short requestTimeout gives the regen a short hard deadline.
  const app = createApp({
    getManifest: isoManifest,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache: new PageCache(),
    requestTimeout: 60,
  });

  const seedStale = () =>
    store.setPage("/h2", {
      body: "<!DOCTYPE html><html><body>STALE</body></html>",
      status: 200,
      path: "/h2",
      expiresAt: Infinity,
      staleAt: Date.now() - 1000,
      tags: [],
    });

  await seedStale();
  // Request 1: served STALE immediately; spawns regen #1 (which hangs).
  const r1 = await app(new Request("http://localhost/h2"));
  assertEquals(r1.headers.get("x-denext-cache"), "STALE");
  assertStringIncludes(await r1.text(), "STALE");
  for (let i = 0; i < 50 && regenStarts < 1; i++) await new Promise((r) => setTimeout(r, 5));
  assertEquals(regenStarts, 1, "the first regen started");

  // Wait past the regen deadline (60ms) so its key is force-freed despite the hang.
  await new Promise((r) => setTimeout(r, 150));
  await seedStale(); // the hung regen never wrote; keep the entry stale

  // Request 2: still served STALE (not wedged), and a NEW regen is spawned —
  // proving the key was freed. If the key had leaked, regenStarts would stay 1.
  const r2 = await app(new Request("http://localhost/h2"));
  assertEquals(r2.headers.get("x-denext-cache"), "STALE", "still serves stale, not wedged");
  await r2.text();
  for (let i = 0; i < 50 && regenStarts < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assertEquals(regenStarts, 2, "the freed key allowed a second regen (no permanent freeze)");
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
