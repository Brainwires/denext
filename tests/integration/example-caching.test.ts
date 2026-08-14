// Smoke test for examples/caching: build + serve it, then prove the caching
// primitives work end to end — unstable_cache HIT stability, revalidateTag
// invalidation via the API route, and ISR (export const revalidate) HIT via the
// prod PageCache.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";

const APP = new URL("../../examples/caching", import.meta.url).pathname;

/** Extract the cached "fetched at" timestamp the /data page renders. */
function cachedAt(html: string): string {
  const m = html.match(/data-cached-at[^>]*>([^<]+)</);
  assert(m, "the /data page must render a data-cached-at value");
  return m![1];
}

Deno.test({
  name: "examples/caching: unstable_cache, revalidateTag, and ISR",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    await build(APP);

    const { promise, resolve } = Promise.withResolvers<
      { hostname: string; port: number }
    >();
    server = await startProdServer({
      projectDir: APP,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
      onListen: (info) => resolve(info),
    });
    const { hostname, port } = await promise;
    const origin = `http://${hostname}:${port}`;

    await t.step(
      "unstable_cache serves a stable value across requests (HIT)",
      async () => {
        const first = cachedAt(await (await fetch(`${origin}/data`)).text());
        const second = cachedAt(await (await fetch(`${origin}/data`)).text());
        assertEquals(
          second,
          first,
          "the cached timestamp must be identical on the second request",
        );
      },
    );

    await t.step(
      "revalidateTag purges the entry so the loader re-runs",
      async () => {
        const before = cachedAt(await (await fetch(`${origin}/data`)).text());
        const res = await fetch(`${origin}/api/revalidate`, {
          method: "POST",
          redirect: "manual",
        });
        assertEquals(res.status, 303);
        assertEquals(res.headers.get("location"), "/data");
        await res.body?.cancel();
        // The loader stamps Date.now(); ensure a fresh value is observably different.
        await new Promise((r) => setTimeout(r, 5));
        const after = cachedAt(await (await fetch(`${origin}/data`)).text());
        assert(
          after !== before,
          `timestamp must change after revalidateTag (before=${before})`,
        );
      },
    );

    await t.step("the revalidate API route rejects a GET (405)", async () => {
      const res = await fetch(`${origin}/api/revalidate`);
      assertEquals(res.status, 405);
      await res.body?.cancel();
    });

    await t.step(
      "ISR serves the page from PageCache on the second request (HIT)",
      async () => {
        const r1 = await fetch(`${origin}/isr`);
        await r1.text();
        // First request populates the cache (MISS); the next within the window is a HIT.
        const r2 = await fetch(`${origin}/isr`);
        await r2.text();
        assertEquals(
          r2.headers.get("x-denext-cache"),
          "HIT",
          "ISR must serve a cached render",
        );
      },
    );
  } finally {
    controller.abort();
    await server?.finished;
  }
});
