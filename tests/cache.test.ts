import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  cache,
  PageCache,
  pageCacheExpiry,
  revalidatePath,
  revalidateTag,
  unstable_cache,
} from "../src/server/cache.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
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
  revalidateTag("t-uc");
  assertEquals(await load(), 2); // purged -> recomputed
});

// ---- PageCache -------------------------------------------------------------

Deno.test("PageCache stores, expires, and invalidates by path and tag", () => {
  const pc = new PageCache();
  pc.set("/a", { body: "A", status: 200, path: "/a", expiresAt: Infinity, tags: ["ta"] });
  assertEquals(pc.get("/a")?.body, "A");

  // An already-past expiry is treated as a miss (and evicted).
  pc.set("/b", { body: "B", status: 200, path: "/b", expiresAt: 1, tags: [] });
  assertEquals(pc.get("/b"), undefined);

  pc.revalidatePath("/a");
  assertEquals(pc.get("/a"), undefined);

  pc.set("/c", { body: "C", status: 200, path: "/c", expiresAt: Infinity, tags: ["tc"] });
  revalidateTag("tc");
  assertEquals(pc.get("/c"), undefined);
});

Deno.test("pageCacheExpiry honors dynamic/revalidate", () => {
  assertEquals(pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, dynamic: "force-dynamic" }), null);
  assertEquals(pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, dynamic: "force-static" }), Infinity);
  assertEquals(pageCacheExpiry(DEFAULT_SEGMENT_CONFIG), null); // auto + revalidate:false
  const e = pageCacheExpiry({ ...DEFAULT_SEGMENT_CONFIG, revalidate: 60 });
  assert(typeof e === "number" && e > Date.now());
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
  revalidatePath("/cached");
  const r3 = await app(new Request("http://localhost/cached"));
  assertEquals(r3.headers.get("x-denext-cache"), "MISS");
  await r3.text();
  assertEquals(renders, 2);
});

Deno.test("app ISR: default (non-opted-in) page is never cached", async () => {
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
