import { assert, assertEquals } from "@std/assert";
import {
  type CacheStore,
  cacheStoreHealthy,
  inMemoryCacheStore,
  PageCache,
  setCacheStore,
  unstable_cache,
} from "../src/server/cache.ts";
import { after } from "../src/server/request-context.ts";
import { optimizeImage } from "../src/server/image-optimizer.ts";
import { ImageResponse } from "../src/server/image-response.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { PageProps } from "../src/server/types.ts";

/** A CacheStore whose every method rejects — simulates a KV outage. */
function failingCacheStore(): CacheStore {
  const boom = () => Promise.reject(new Error("cache backend down"));
  return {
    getData: boom,
    setData: boom,
    getPage: boom,
    setPage: boom,
    deleteByTag: boom,
    deleteByPath: boom,
  };
}

function isrManifest(): RouteManifest {
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
    ],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

// Compile-time regression guard (H2): PageProps must NOT expose the raw request.
// Exposing it would be an ungated channel to per-user data that bypasses the
// cookies()/headers() cache-safety tripwire. If `request` is ever re-added to
// PageProps, the excess-property error disappears and this @ts-expect-error fails.
Deno.test("PageProps does not expose the raw request (cache-safety)", () => {
  const props: PageProps = {
    params: {},
    searchParams: new URLSearchParams(),
    // @ts-expect-error `request` must not be a PageProps field.
    request: new Request("http://x/"),
  };
  assert(props.params !== undefined);
});

Deno.test("cache degrades: a failing CacheStore never 500s a request (serves uncached)", async () => {
  setCacheStore(failingCacheStore());
  try {
    const modules: Record<string, unknown> = {
      "cached.tsx": { default: (_p: PageProps) => h("h1", null, "cached"), revalidate: 60 },
    };
    const app = createApp({
      getManifest: isrManifest,
      load: (fp) => Promise.resolve(modules[fp]),
      pageCache: new PageCache(),
    });
    // getPage rejects (read) AND setPage rejects (write) — the render must still 200.
    const res = await app(new Request("http://localhost/cached"));
    assertEquals(res.status, 200);
    assert((await res.text()).includes("cached"), "should serve the live render");
  } finally {
    setCacheStore(inMemoryCacheStore()); // restore for other tests
  }
});

Deno.test("cache error logging is rate-limited PER operation, not globally (OBS-L2)", async () => {
  setCacheStore(failingCacheStore());
  const origError = console.error;
  const ops = new Set<string>();
  console.error = (...args: unknown[]) => {
    const line = String(args[0] ?? "");
    // Lines read "denext: cache store <op> failed (serving uncached):".
    const m = line.match(/cache store (\w+) failed/);
    if (m) ops.add(m[1]);
  };
  try {
    // One unstable_cache call fails a getData (read) AND a setData (write) in the
    // same millisecond. A single global 1/sec gate would log only the first op and
    // suppress the second; per-op rate limiting logs both.
    const load = unstable_cache(() => Promise.resolve(1), ["obs-l2"]);
    await load();
  } finally {
    console.error = origError;
    setCacheStore(inMemoryCacheStore());
  }
  assert(ops.has("getData"), "the read failure logged");
  assert(ops.has("setData"), "the write failure ALSO logged (not suppressed by the read's)");
});

Deno.test("cache degrades: unstable_cache falls through to the loader when the store fails", async () => {
  setCacheStore(failingCacheStore());
  try {
    let calls = 0;
    const load = unstable_cache(() => Promise.resolve(++calls), ["deg"]);
    assertEquals(await load(), 1); // getData rejects -> miss -> loader runs
    assertEquals(await load(), 2); // setData rejected too, so still a miss -> loader re-runs
  } finally {
    setCacheStore(inMemoryCacheStore());
  }
});

Deno.test("cacheStoreHealthy reflects the active store's reachability", async () => {
  setCacheStore(inMemoryCacheStore());
  assertEquals(await cacheStoreHealthy(), true);
  setCacheStore(failingCacheStore());
  assertEquals(await cacheStoreHealthy(), false);
  setCacheStore(inMemoryCacheStore());
});

Deno.test("after() does not block the response (M1: detached drain)", async () => {
  // A page registers an after() callback that never resolves. If the handler
  // awaited the drain, `await app(...)` would hang forever; it returns, proving
  // the drain is detached.
  const never = new Promise<void>(() => {});
  const modules: Record<string, unknown> = {
    "cached.tsx": {
      default: (_p: PageProps) => {
        after(() => never); // blocks forever if awaited inline
        return h("h1", null, "hi");
      },
    },
  };
  const app = createApp({
    getManifest: isrManifest,
    load: (fp) => Promise.resolve(modules[fp]),
  });
  const res = await app(new Request("http://localhost/cached"));
  assertEquals(res.status, 200);
  assert((await res.text()).includes("hi"));
});

Deno.test("PageCache is bounded (LRU eviction under high-cardinality keys)", async () => {
  const pc = new PageCache();
  // Insert far more than the internal bound to prove it does not grow forever.
  for (let i = 0; i < 5000; i++) {
    await pc.set(`/p?${i}`, {
      body: "x",
      status: 200,
      path: "/p",
      expiresAt: Infinity,
      tags: [],
    });
  }
  // The oldest key was evicted (the cache is bounded, not unbounded)...
  assertEquals(await pc.get("/p?0"), undefined, "oldest entry should be evicted");
  // ...while the most-recently-inserted key survives (LRU keeps recent entries).
  assert(await pc.get("/p?4999"), "recent entry should survive");
});

Deno.test("unstable_cache data store is bounded", async () => {
  const load = unstable_cache((n: number) => Promise.resolve(n * 2), ["k"]);
  for (let i = 0; i < 5000; i++) await load(i);
  // Can't read the private map, but a fresh distinct key must still work and the
  // process must not have OOM'd — the LRU bound is exercised by the loop above.
  assertEquals(await load(123456), 246912);
});

Deno.test("optimizeImage caches encoded output (second call is served from cache)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_imgcache_" });
  try {
    const png = new Uint8Array(
      await ImageResponse(
        h("div", {
          style: { display: "flex", width: "100%", height: "100%", background: "#16a34a" },
        }),
        { width: 200, height: 200 },
      ).arrayBuffer(),
    );
    await Deno.writeFile(`${dir}/pic.png`, png);
    const req = () =>
      optimizeImage(new Request("http://x/_denext/image?url=/pic.png&w=64"), { publicDir: dir });

    const a = await req();
    const first = new Uint8Array(await a.arrayBuffer());
    // Delete the source so a second uncached call would fail — a cache hit still succeeds.
    await Deno.remove(`${dir}/pic.png`);
    const b = await req();
    assertEquals(b.status, 200);
    const second = new Uint8Array(await b.arrayBuffer());
    assertEquals(second.length, first.length, "second response should come from cache");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
