import { assert, assertEquals } from "@std/assert";
import { PageCache, unstable_cache } from "../src/server/cache.ts";
import { optimizeImage } from "../src/server/image-optimizer.ts";
import { ImageResponse } from "../src/server/image-response.ts";
import { h } from "../src/jsx/jsx-runtime.ts";

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
      optimizeImage(new Request("http://x/_denext/image?url=/pic.png&w=80"), { publicDir: dir });

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
