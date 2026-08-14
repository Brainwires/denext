// Automatic fetch() caching (uncached by default). A bare fetch() is passed
// through uncached; a GET given next:{revalidate,tags} or cache:"force-cache" is
// cached in the data cache and its tags feed revalidateTag.

import { assertEquals } from "@std/assert";
import {
  __setFetchBaseForTests,
  inMemoryCacheStore,
  installFetchCache,
  revalidateTag,
  setCacheStore,
} from "../src/server/cache.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

Deno.test("automatic fetch caching: default uncached, explicit opt-in cached", async () => {
  setCacheStore(inMemoryCacheStore());
  installFetchCache();
  let calls = 0;
  const restore = __setFetchBaseForTests(
    ((_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify({ n: calls }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch,
  );

  try {
    const ctx = createRequestContext(new Request("http://x/"));
    await runWithContext(ctx, async () => {
      // Bare fetch: NOT cached — each call hits the network.
      await fetch("http://api/a");
      await fetch("http://api/a");
      assertEquals(calls, 2, "bare fetch is uncached");

      // cache:"no-store": explicitly uncached.
      await fetch("http://api/a", { cache: "no-store" });
      assertEquals(calls, 3, "no-store is uncached");

      // cache:"force-cache": second call served from cache (same body).
      const a = await (await fetch("http://api/b", { cache: "force-cache" })).json();
      const b = await (await fetch("http://api/b", { cache: "force-cache" })).json();
      assertEquals(calls, 4, "force-cache fetches once");
      assertEquals(a.n, b.n, "cached body is reused");

      // POST is never cached even with force-cache.
      await fetch("http://api/b", { method: "POST", cache: "force-cache" });
      await fetch("http://api/b", { method: "POST", cache: "force-cache" });
      assertEquals(calls, 6, "non-GET is uncached");

      // next:{revalidate,tags}: cached and tagged.
      await fetch("http://api/c", { next: { revalidate: 60, tags: ["c"] } } as RequestInit);
      await fetch("http://api/c", { next: { revalidate: 60, tags: ["c"] } } as RequestInit);
      assertEquals(calls, 7, "tagged fetch cached once");
    });

    // revalidateTag purges the tagged fetch entry.
    await revalidateTag("c");
    await runWithContext(createRequestContext(new Request("http://x/")), async () => {
      await fetch("http://api/c", { next: { revalidate: 60, tags: ["c"] } } as RequestInit);
      assertEquals(calls, 8, "re-fetched after revalidateTag");
    });

    // Outside a request context: never cached.
    const before = calls;
    await fetch("http://api/b", { cache: "force-cache" });
    await fetch("http://api/b", { cache: "force-cache" });
    assertEquals(calls, before + 2, "outside a request, fetch is uncached");
  } finally {
    __setFetchBaseForTests(restore);
  }
});
