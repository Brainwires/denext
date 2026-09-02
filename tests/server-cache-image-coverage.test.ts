// Coverage for the data/page cache (src/server/cache.ts) and the self-hosted image
// optimizer (src/server/image-optimizer.ts), driven by direct function calls.
//
// Cache: the in-memory store lifecycle (expiry, tag/path purge, soft-expire),
// cacheLife profiles + cache scope, the `use cache` executor (__useCache) with its
// single-flight / SWR / read-your-writes paths, unstable_cache SWR, page-cache
// timing, PageCache stats, revalidate hooks, the live-invalidate seam, store
// health, and automatic fetch() caching via the injectable base-fetch seam.
//
// Image: quality coercion, format negotiation, local/remote allowlists, the config
// mapper, header-only dimension probing (incl. the WebP variants), and optimizeImage
// end-to-end (webp encode, output-cache hit, SVG refusal, 400/404 fast paths).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  __setFetchBaseForTests,
  __useCache,
  cache,
  cacheLife,
  cacheStoreHealthy,
  cacheTag,
  currentCacheScope,
  getCacheStats,
  inMemoryCacheStore,
  installFetchCache,
  PageCache,
  pageCacheExpiry,
  pageCacheTiming,
  refresh,
  registerCacheLifeProfiles,
  resetCacheStats,
  resolveCacheLife,
  revalidatePath,
  revalidateTag,
  safeKey,
  setCacheStore,
  setLiveInvalidateHook,
  unstable_cache,
  updateTag,
  withCacheScope,
} from "../src/server/cache.ts";
import { DEFAULT_SEGMENT_CONFIG } from "../src/server/segment-config.ts";
import {
  createRequestContext,
  currentContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { samplePng } from "./fixtures/sample-image.ts";
import {
  coerceQuality,
  DEFAULT_DEVICE_SIZES,
  imageOptionsFromConfig,
  isAllowedLocal,
  negotiateFormat,
  optimizeImage,
  probeImageDimensions,
} from "../src/server/image-optimizer.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

// ===========================================================================
// cache.ts
// ===========================================================================

Deno.test("inMemoryCacheStore: data get/set, hard-expiry miss, tag + path purge", async () => {
  const store = inMemoryCacheStore();
  await store.setData("k", { value: 1, expiresAt: Infinity, tags: ["t"] });
  assertEquals((await store.getData("k"))?.value, 1);

  // A past hard-expiry is treated as a miss (and evicted).
  await store.setData("expired", { value: 9, expiresAt: Date.now() - 1, tags: [] });
  assertEquals(await store.getData("expired"), undefined);

  // Tag purge removes matching data + page entries.
  await store.setPage("p1", {
    body: "<html></html>",
    status: 200,
    path: "/x",
    expiresAt: Infinity,
    tags: ["t"],
  });
  await store.deleteByTag("t");
  assertEquals(await store.getData("k"), undefined);
  assertEquals(await store.getPage("p1"), undefined);

  // Path purge removes only the page rendered for that path.
  await store.setPage("p2", {
    body: "b",
    status: 200,
    path: "/keep",
    expiresAt: Infinity,
    tags: [],
  });
  await store.setPage("p3", {
    body: "b",
    status: 200,
    path: "/drop",
    expiresAt: Infinity,
    tags: [],
  });
  await store.deleteByPath("/drop");
  assert(await store.getPage("p2"));
  assertEquals(await store.getPage("p3"), undefined);
});

Deno.test("inMemoryCacheStore: expireByTag soft-expires in place (stale, not deleted)", async () => {
  const store = inMemoryCacheStore();
  await store.setData("d", { value: "v", expiresAt: Infinity, tags: ["soft"] });
  const future = Date.now() + 100_000;
  store.expireByTag!("soft", { staleAt: 123, expiresAt: future });
  const e = await store.getData("d");
  assert(e, "the entry is still present (served stale), not deleted");
  assertEquals(e!.staleAt, 123);
  assertEquals(e!.expiresAt, future);
});

Deno.test("pageCacheExpiry / pageCacheTiming honor dynamic/static/revalidate", () => {
  assertEquals(pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, dynamic: "force-dynamic" }), null);
  assertEquals(pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, dynamic: "force-static" }), Infinity);
  assertEquals(pageCacheExpiry(DEFAULT_SEGMENT_CONFIG), null); // default: not cached
  const rev = pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, revalidate: 60 });
  assert(rev !== null && rev > Date.now());

  assertEquals(pageCacheTiming({ ...DEFAULT_SEGMENT_CONFIG, dynamic: "force-dynamic" }), null);
  assertEquals(pageCacheTiming({ ...DEFAULT_SEGMENT_CONFIG, dynamic: "force-static" }), {
    expiresAt: Infinity,
    staleAt: Infinity,
  });
  const t = pageCacheTiming({ ...DEFAULT_SEGMENT_CONFIG, revalidate: 30 });
  assert(t !== null && t.expiresAt === Infinity && t.staleAt > Date.now());
});

Deno.test("resolveCacheLife: builtin, unknown→default, inline with inherited fields", () => {
  const minutes = resolveCacheLife("minutes");
  assertEquals(minutes.revalidate, 60);
  // An unknown profile name falls back to the `default` profile.
  assertEquals(resolveCacheLife("nope").revalidate, resolveCacheLife("default").revalidate);
  // An inline profile inherits missing fields from `default`.
  const inline = resolveCacheLife({ revalidate: 5 });
  assertEquals(inline.revalidate, 5);
  assertEquals(inline.stale, resolveCacheLife("default").stale);
});

Deno.test("registerCacheLifeProfiles: a custom profile overrides a builtin name", () => {
  registerCacheLifeProfiles({ minutes: { revalidate: 7 }, myprofile: { revalidate: 11 } });
  assertEquals(resolveCacheLife("minutes").revalidate, 7);
  assertEquals(resolveCacheLife("myprofile").revalidate, 11);
});

Deno.test("withCacheScope: cacheLife/cacheTag mutate the scope; currentCacheScope reads it", async () => {
  // Outside a scope these are no-ops (and don't throw).
  assertEquals(currentCacheScope(), undefined);
  cacheLife("hours");
  const { value, scope } = await withCacheScope(() => {
    assert(currentCacheScope(), "a scope is active inside withCacheScope");
    cacheLife("minutes");
    cacheTag("a", "b");
    return 42;
  });
  assertEquals(value, 42);
  assertEquals(scope.life?.revalidate, resolveCacheLife("minutes").revalidate);
  assertEquals(scope.tags, ["a", "b"]);
});

Deno.test("cache(): memoizes per request, recomputes across requests", () => {
  let calls = 0;
  const inc = cache((n: number) => {
    calls++;
    return n + 1;
  });
  runWithContext(createRequestContext(new Request("http://x/")), () => {
    assertEquals(inc(1), 2);
    assertEquals(inc(1), 2);
  });
  assertEquals(calls, 1);
  runWithContext(createRequestContext(new Request("http://x/")), () => inc(1));
  assertEquals(calls, 2);
});

Deno.test("__useCache: computes once (single-flight), then serves from cache", async () => {
  setCacheStore(inMemoryCacheStore());
  let calls = 0;
  const wrapped = __useCache("uc-basic", async (n: number) => {
    calls++;
    await Promise.resolve();
    return n * 10;
  }, { profile: "minutes" });

  // Concurrent misses coalesce to a single body run.
  const [a, b] = await Promise.all([wrapped(3), wrapped(3)]);
  assertEquals(a, 30);
  assertEquals(b, 30);
  assertEquals(calls, 1, "single-flight: the body ran once for concurrent misses");

  // A later call is a straight cache hit.
  assertEquals(await wrapped(3), 30);
  assertEquals(calls, 1);
});

Deno.test("__useCache: a stale entry is served immediately and refreshed in the background (SWR)", async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  let calls = 0;
  const wrapped = __useCache("uc-swr", () => {
    calls++;
    return `fresh-${calls}`;
  }, { profile: "minutes" });

  // Seed a stale entry under the executor's own key.
  const key = safeKey(["uc-swr", []]);
  await store.setData(key, {
    value: "stale",
    expiresAt: Infinity,
    staleAt: Date.now() - 1000,
    tags: [],
  });

  assertEquals(await wrapped(), "stale", "the stale value is served right away");
  await tick(); // let the background refresh land
  assertEquals(calls, 1, "the body ran once, in the background");
  assertStringIncludes((await store.getData(key))!.value as string, "fresh");
});

Deno.test("__useCache: read-your-writes — an updateTag'd hit forces a recompute", async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  const key = safeKey(["uc-ryw", []]);
  let calls = 0;
  const wrapped = __useCache("uc-ryw", () => {
    calls++;
    return `v${calls}`;
  }, { tags: ["t"] });

  await runWithContext(createRequestContext(new Request("http://x/")), async () => {
    // Mark the tag updated this request, then place a matching entry so the hit path
    // sees a still-present entry whose tag was updated (→ forced miss).
    updateTag("t");
    await store.setData(key, {
      value: "old",
      expiresAt: Infinity,
      tags: ["t"],
    });
    const out = await wrapped();
    assertEquals(out, "v1", "the updated tag forced a recompute rather than serving 'old'");
  });
  assertEquals(calls, 1);
});

Deno.test("unstable_cache: SWR after a soft revalidateTag serves stale then refreshes", async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  let calls = 0;
  const load = unstable_cache(
    () => {
      calls++;
      return `data-${calls}`;
    },
    ["swr-key"],
    { tags: ["grp"], revalidate: 1000 },
  );
  assertEquals(await load(), "data-1"); // miss → compute + store
  assertEquals(calls, 1);
  assertEquals(await load(), "data-1"); // hit
  assertEquals(calls, 1);

  // Soft-expire the tag → the entry goes stale (still served) with SWR timing.
  await revalidateTag("grp", "seconds");
  const stale = await load();
  assertEquals(stale, "data-1", "the stale value is served while it refreshes");
  await tick();
  assertEquals(calls, 2, "a background refresh recomputed the value");
});

Deno.test("revalidateTag / revalidatePath: hard purge, recorded in stats + live hook", async () => {
  setCacheStore(inMemoryCacheStore());
  resetCacheStats();
  const hookTags: string[][] = [];
  setLiveInvalidateHook((tags) => hookTags.push([...tags]));
  try {
    await revalidateTag("news");
    await revalidatePath("/blog");
    const stats = getCacheStats();
    assertEquals(stats.invalidations, 2);
    assertEquals(stats.recentInvalidations.map((i) => i.kind), ["tag", "path"]);
    assertEquals(stats.recentInvalidations.map((i) => i.value), ["news", "/blog"]);
    // Only tag invalidations wake the live hook.
    assertEquals(hookTags, [["news"]]);
  } finally {
    setLiveInvalidateHook(null);
    resetCacheStats();
  }
});

Deno.test("setLiveInvalidateHook: a throwing hook is swallowed (invalidation still succeeds)", async () => {
  setCacheStore(inMemoryCacheStore());
  setLiveInvalidateHook(() => {
    throw new Error("hook blew up");
  });
  try {
    await revalidateTag("boom"); // must not throw
  } finally {
    setLiveInvalidateHook(null);
  }
});

Deno.test("updateTag + refresh flag the current request context", async () => {
  setCacheStore(inMemoryCacheStore());
  await runWithContext(createRequestContext(new Request("http://x/")), async () => {
    await updateTag("acct");
    refresh();
    const ctx = currentContext()!;
    assert(ctx.updatedTags?.has("acct"), "updateTag records the tag for read-your-writes");
    assertEquals(ctx.refreshRequested, true, "refresh() flags the request");
  });
  // Outside a request refresh() is a harmless no-op.
  refresh();
});

Deno.test("PageCache: get/set update stats; revalidatePath/Tag purge", async () => {
  setCacheStore(inMemoryCacheStore());
  resetCacheStats();
  const pc = new PageCache();
  try {
    assertEquals(await pc.get("missing"), undefined); // miss
    await pc.set("home", {
      body: "<html>home</html>",
      status: 200,
      path: "/",
      expiresAt: Infinity,
      tags: ["home"],
    });
    const hit = await pc.get("home"); // hit
    assertEquals(hit?.body, "<html>home</html>");

    const stats = getCacheStats();
    assertEquals(stats.pageMisses, 1);
    assertEquals(stats.pageHits, 1);
    assertEquals(stats.pageSets, 1);

    await pc.revalidatePath("/");
    assertEquals(await pc.get("home"), undefined);
  } finally {
    resetCacheStats();
  }
});

Deno.test("cacheStoreHealthy: true for a working store, false for a throwing one", async () => {
  setCacheStore(inMemoryCacheStore());
  assertEquals(await cacheStoreHealthy(), true);

  setCacheStore({
    getData: () => {
      throw new Error("store down");
    },
    setData: () => {},
    getPage: () => undefined,
    setPage: () => {},
    deleteByTag: () => {},
    deleteByPath: () => {},
  });
  assertEquals(await cacheStoreHealthy(), false);
  setCacheStore(inMemoryCacheStore()); // restore a sane default for later tests
});

Deno.test("automatic fetch() cache: opt-in GET is cached once; passthrough otherwise", async () => {
  installFetchCache();
  setCacheStore(inMemoryCacheStore());
  let baseCalls = 0;
  const prev = __setFetchBaseForTests(
    ((input: RequestInfo | URL) => {
      baseCalls++;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(new Response(`body-for-${url}-${baseCalls}`, { status: 200 }));
    }) as typeof fetch,
  );
  try {
    await runWithContext(createRequestContext(new Request("http://x/")), async () => {
      // An opt-in GET (next.revalidate) is cached: the base fetch runs once.
      const a = await fetch("http://api.test/a", { next: { revalidate: 60 } } as RequestInit);
      const b = await fetch("http://api.test/a", { next: { revalidate: 60 } } as RequestInit);
      assertEquals(await a.text(), await b.text());
      assertEquals(baseCalls, 1, "the cached GET hit the base fetch exactly once");

      // A bare GET (no opt-in) is passed through uncached.
      const before = baseCalls;
      await fetch("http://api.test/uncached");
      assertEquals(baseCalls, before + 1);

      // A non-GET is always passed through.
      const beforePost = baseCalls;
      await fetch("http://api.test/a", { method: "POST", body: "x" });
      assertEquals(baseCalls, beforePost + 1);
    });

    // Outside a request context, fetch is never cached (straight passthrough).
    const before = baseCalls;
    await fetch("http://api.test/a", { next: { revalidate: 60 } } as RequestInit);
    assertEquals(baseCalls, before + 1);
  } finally {
    __setFetchBaseForTests(prev);
  }
});

Deno.test("safeKey: stable for serializable args, throws on non-serializable", () => {
  assertEquals(safeKey([{ a: 1 }]), '[{"a":1}]');
  let threw = false;
  try {
    safeKey([{ big: 1n }]); // BigInt is not JSON-serializable
  } catch {
    threw = true;
  }
  assert(threw, "a non-serializable key argument throws");
});

// ===========================================================================
// image-optimizer.ts
// ===========================================================================

Deno.test("coerceQuality: nearest allowed value, exact match, and empty-list fallback", () => {
  assertEquals(coerceQuality(70, [75]), 75);
  assertEquals(coerceQuality(75, [50, 75, 100]), 75);
  assertEquals(coerceQuality(60, [50, 75, 100]), 50); // nearest
  assertEquals(coerceQuality(90, [50, 75, 100]), 100);
  assertEquals(coerceQuality(42, []), 75); // no allowlist → the built-in default
});

Deno.test("negotiateFormat: AVIF only when configured AND accepted; WebP otherwise", () => {
  assertEquals(
    negotiateFormat("image/avif,image/webp", ["image/avif", "image/webp"]),
    "image/avif",
  );
  // Configured but not accepted → webp.
  assertEquals(negotiateFormat("image/webp", ["image/avif", "image/webp"]), "image/webp");
  // Accepted but not configured → webp.
  assertEquals(negotiateFormat("image/avif", ["image/webp"]), "image/webp");
  // No Accept header at all → webp baseline.
  assertEquals(negotiateFormat(null, ["image/webp"]), "image/webp");
});

Deno.test("isAllowedLocal: no patterns allows all; pathname glob + exact search enforced", () => {
  assert(isAllowedLocal("/anything.png"), "no patterns → everything allowed");
  const patterns = [{ pathname: "/assets/**", search: "v=1" }];
  assert(isAllowedLocal("/assets/deep/a.png?v=1", patterns));
  assert(!isAllowedLocal("/other/a.png?v=1", patterns), "pathname glob enforced");
  assert(!isAllowedLocal("/assets/a.png?v=2", patterns), "exact search enforced");
  // A pathname-only pattern (no search constraint) matches any query.
  assert(isAllowedLocal("/img/a.png?x=9", [{ pathname: "/img/*" }]));
});

Deno.test("imageOptionsFromConfig: maps config fields (and tolerates undefined)", () => {
  const opts = imageOptionsFromConfig(
    {
      domains: ["cdn.example.com"],
      deviceSizes: [640],
      qualities: [50],
      formats: ["image/avif"],
      maximumRedirects: 1,
    },
    "/public",
  );
  assertEquals(opts.publicDir, "/public");
  assertEquals(opts.allowedHosts, ["cdn.example.com"]);
  assertEquals(opts.deviceSizes, [640]);
  assertEquals(opts.qualities, [50]);
  assertEquals(opts.formats, ["image/avif"]);
  assertEquals(opts.maximumRedirects, 1);

  const empty = imageOptionsFromConfig(undefined, "/pub");
  assertEquals(empty.publicDir, "/pub");
  assertEquals(empty.allowedHosts, undefined);
});

Deno.test("probeImageDimensions: WebP VP8X / VP8 (lossy) / VP8L (lossless) headers", () => {
  const riff = (fourcc: string): Uint8Array => {
    const b = new Uint8Array(30);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
    for (let i = 0; i < 4; i++) b[12 + i] = fourcc.charCodeAt(i);
    return b;
  };

  // VP8X: 24-bit LE (width-1)@24 and (height-1)@27.
  const vp8x = riff("VP8X");
  vp8x[24] = 99; // width 100
  vp8x[27] = 49; // height 50
  assertEquals(probeImageDimensions(vp8x), { width: 100, height: 50 });

  // VP8 (lossy): signature 0x9d 0x01 0x2a at 23..25, dims LE u16 (14-bit) at 26/28.
  const vp8 = riff("VP8 ");
  vp8[23] = 0x9d;
  vp8[24] = 0x01;
  vp8[25] = 0x2a;
  new DataView(vp8.buffer).setUint16(26, 200, true);
  new DataView(vp8.buffer).setUint16(28, 150, true);
  assertEquals(probeImageDimensions(vp8), { width: 200, height: 150 });

  // VP8L (lossless): marker 0x2f at 20, then packed dims (here 1×1).
  const vp8l = riff("VP8L");
  vp8l[20] = 0x2f;
  assertEquals(probeImageDimensions(vp8l), { width: 1, height: 1 });

  // A recognized RIFF/WEBP with an unknown chunk fourcc → null.
  assertEquals(probeImageDimensions(riff("XXXX")), null);
});

Deno.test("DEFAULT_DEVICE_SIZES is the Next breakpoint ladder", () => {
  assert(DEFAULT_DEVICE_SIZES.includes(640));
  assert(DEFAULT_DEVICE_SIZES.includes(3840));
});

Deno.test("optimizeImage: encodes a local PNG to webp, then serves the second identical variant from cache", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_imgcov_" });
  try {
    await Deno.writeFile(`${dir}/hero.png`, samplePng());
    const url = "http://x/_denext/image?url=/hero.png&w=128&q=70";

    const first = await optimizeImage(new Request(url), { publicDir: dir });
    assertEquals(first.status, 200);
    assertEquals(first.headers.get("content-type"), "image/webp");
    assertStringIncludes(first.headers.get("cache-control") ?? "", "max-age=");
    assertEquals(first.headers.get("vary"), "Accept");
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    assert(firstBytes.byteLength > 0);

    // A second identical request is served from the server-side output cache.
    const second = await optimizeImage(new Request(url), { publicDir: dir });
    assertEquals(second.status, 200);
    const secondBytes = new Uint8Array(await second.arrayBuffer());
    assertEquals(secondBytes, firstBytes, "the cached variant is byte-identical");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("optimizeImage: refuses an SVG source (raster-only, script-smuggling guard)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_imgsvg_" });
  try {
    await Deno.writeTextFile(
      `${dir}/vector.svg`,
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    );
    const res = await optimizeImage(
      new Request("http://x/_denext/image?url=/vector.svg&w=128"),
      { publicDir: dir },
    );
    assertEquals(res.status, 400);
    assertStringIncludes(await res.text(), "unsupported image type");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("optimizeImage: a local source outside localPatterns is a 404", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_imglp_" });
  try {
    await Deno.writeFile(`${dir}/guarded.png`, samplePng());
    const res = await optimizeImage(
      new Request("http://x/_denext/image?url=/guarded.png&w=128"),
      { publicDir: dir, localPatterns: [{ pathname: "/allowed/**" }] },
    );
    assertEquals(res.status, 404, "the source path is not in the local allowlist");
    await res.body?.cancel();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("optimizeImage: a missing url or non-positive width is a 400 fast-fail", async () => {
  const missing = await optimizeImage(new Request("http://x/_denext/image"), {});
  assertEquals(missing.status, 400);
  await missing.body?.cancel();

  const zero = await optimizeImage(new Request("http://x/_denext/image?url=/a.png&w=0"), {});
  assertEquals(zero.status, 400);
  await zero.body?.cancel();
});

Deno.test("optimizeImage: an absent local source is a 404", async () => {
  const res = await optimizeImage(
    new Request("http://x/_denext/image?url=/nope.png&w=128"),
    { publicDir: "/does-not-exist-denext" },
  );
  assertEquals(res.status, 404);
  await res.body?.cancel();
});
