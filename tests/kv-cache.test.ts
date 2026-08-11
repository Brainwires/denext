// Deno KV cache-store adapter. Run with `deno test -A --unstable-kv` (the repo's
// `test`/`check` tasks pass the flag). Each test uses an isolated in-memory KV.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { PageCache, setCacheStore } from "../src/server/cache.ts";
import { denoKvCacheStore } from "../src/server/kv-cache.ts";
import { revalidatePath, revalidateTag } from "../src/server/cache.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageProps } from "../src/server/types.ts";

async function withKv(fn: (kv: Deno.Kv) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("kv store: data round-trip, TTL expiry, and tag purge", async () => {
  await withKv(async (kv) => {
    const store = denoKvCacheStore(kv);
    await store.setData("k1", { value: 42, expiresAt: Infinity, tags: ["t1"] });
    assertEquals((await store.getData("k1"))?.value, 42);

    // An already-past expiry reads as a miss even before KV reaps it.
    await store.setData("k2", { value: "x", expiresAt: 1, tags: [] });
    assertEquals(await store.getData("k2"), undefined);

    // deleteByTag purges the tagged data entry.
    await store.deleteByTag("t1");
    assertEquals(await store.getData("k1"), undefined);
  });
});

Deno.test("kv store: page round-trip and invalidation by path and tag", async () => {
  await withKv(async (kv) => {
    const store = denoKvCacheStore(kv);
    await store.setPage("/a", {
      body: "A",
      status: 200,
      path: "/a",
      expiresAt: Infinity,
      tags: ["pt"],
    });
    assertEquals((await store.getPage("/a"))?.body, "A");

    await store.deleteByPath("/a");
    assertEquals(await store.getPage("/a"), undefined);

    await store.setPage("/b", {
      body: "B",
      status: 200,
      path: "/b",
      expiresAt: Infinity,
      tags: ["pt"],
    });
    await store.deleteByTag("pt");
    assertEquals(await store.getPage("/b"), undefined);
  });
});

Deno.test("kv store: overwriting an entry cleans up stale tag markers (L2)", async () => {
  await withKv(async (kv) => {
    const store = denoKvCacheStore(kv);
    await store.setData("k", { value: 1, expiresAt: Infinity, tags: ["old"] });
    await store.setData("k", { value: 2, expiresAt: Infinity, tags: ["new"] }); // re-tag
    // The stale "old" marker was removed, so purging "old" must NOT drop the entry.
    await store.deleteByTag("old");
    assertEquals((await store.getData("k"))?.value, 2, "entry survives an obsolete-tag purge");
    // The current "new" tag still invalidates it.
    await store.deleteByTag("new");
    assertEquals(await store.getData("k"), undefined);
  });
});

Deno.test("kv store: a page over KV's 64 KiB value limit is skipped, not thrown (CACHE-L2)", async () => {
  await withKv(async (kv) => {
    const store = denoKvCacheStore(kv);
    const origWarn = console.warn;
    console.warn = () => {}; // silence the expected throttled warning
    try {
      // ~70 KiB body exceeds the per-value limit; the write must be skipped cleanly.
      await store.setPage("/big", {
        body: "x".repeat(70 * 1024),
        status: 200,
        path: "/big",
        expiresAt: Infinity,
        tags: [],
      });
      assertEquals(await store.getPage("/big"), undefined, "oversize page is not cached");
    } finally {
      console.warn = origWarn;
    }
    // A normal-size page still round-trips.
    await store.setPage("/ok", {
      body: "small",
      status: 200,
      path: "/ok",
      expiresAt: Infinity,
      tags: [],
    });
    assertEquals((await store.getPage("/ok"))?.body, "small");
  });
});

Deno.test("kv store: two adapter instances over one KV share entries (replica simulation)", async () => {
  await withKv(async (kv) => {
    // Two independent adapters wrapping the same KV stand in for two replicas.
    const replicaA = denoKvCacheStore(kv);
    const replicaB = denoKvCacheStore(kv);
    await replicaA.setPage("/shared", {
      body: "from-A",
      status: 200,
      path: "/shared",
      expiresAt: Infinity,
      tags: [],
    });
    assertEquals((await replicaB.getPage("/shared"))?.body, "from-A");
  });
});

// ---- App-level ISR over KV -------------------------------------------------

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
    ],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

Deno.test("app ISR over KV: a render cached by one app is served by another (shared KV)", async () => {
  await withKv(async (kv) => {
    setCacheStore(denoKvCacheStore(kv));
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
    // Two separate app instances (as two replicas would be), one shared KV store.
    const appA = createApp({
      getManifest: manifest,
      load: (fp) => Promise.resolve(modules[fp]),
      pageCache: new PageCache(),
    });
    const appB = createApp({
      getManifest: manifest,
      load: (fp) => Promise.resolve(modules[fp]),
      pageCache: new PageCache(),
    });

    const r1 = await appA(new Request("http://localhost/cached"));
    assertEquals(r1.headers.get("x-denext-cache"), "MISS");
    await r1.text();
    // appB never rendered this route, yet serves it from the shared KV.
    const r2 = await appB(new Request("http://localhost/cached"));
    assertEquals(r2.headers.get("x-denext-cache"), "HIT");
    await r2.text();
    assertEquals(renders, 1);

    // Invalidation reaches the shared store, so the next request re-renders.
    await revalidatePath("/cached");
    const r3 = await appB(new Request("http://localhost/cached"));
    assertEquals(r3.headers.get("x-denext-cache"), "MISS");
    await r3.text();
    assertEquals(renders, 2);
  });
  // Restore the default store for subsequent test files.
  setCacheStore((await import("../src/server/cache.ts")).inMemoryCacheStore());
});

Deno.test("app ISR over KV: revalidateTag purges a page that read tagged data", async () => {
  await withKv(async (kv) => {
    setCacheStore(denoKvCacheStore(kv));
    let renders = 0;
    const { unstable_cache } = await import("../src/server/cache.ts");
    const loadData = unstable_cache(() => Promise.resolve("data"), ["kv-tag-test"], {
      tags: ["products"],
    });
    const modules: Record<string, unknown> = {
      "cached.tsx": {
        default: async (_p: PageProps) => {
          renders++;
          await loadData();
          return h("h1", null, "cached");
        },
        revalidate: 60,
      },
    };
    const app = createApp({
      getManifest: manifest,
      load: (fp) => Promise.resolve(modules[fp]),
      pageCache: new PageCache(),
    });

    await (await app(new Request("http://localhost/cached"))).text(); // MISS -> stored, tag "products"
    const hit = await app(new Request("http://localhost/cached"));
    assertEquals(hit.headers.get("x-denext-cache"), "HIT");
    await hit.text();
    assertEquals(renders, 1);

    // Revalidating the data tag must also purge the page that read it.
    await revalidateTag("products");
    const after = await app(new Request("http://localhost/cached"));
    assertEquals(after.headers.get("x-denext-cache"), "MISS");
    await after.text();
    assert(renders === 2, `expected re-render after tag purge, renders=${renders}`);
  });
  setCacheStore((await import("../src/server/cache.ts")).inMemoryCacheStore());
});
