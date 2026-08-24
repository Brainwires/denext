import { assert, assertEquals } from "@std/assert";
import {
  getCacheStats,
  inMemoryCacheStore,
  PageCache,
  resetCacheStats,
  revalidateTag,
  setCacheStore,
} from "../src/server/cache.ts";

Deno.test("getCacheStats: tracks page hit/miss/set and invalidations with timing", async () => {
  setCacheStore(inMemoryCacheStore());
  resetCacheStats();
  const pc = new PageCache();

  assertEquals(await pc.get("k"), undefined); // miss
  await pc.set("k", { body: "<p>", status: 200, path: "/k", expiresAt: Infinity, tags: ["t"] });
  assert(await pc.get("k")); // hit
  await revalidateTag("t"); // invalidation

  const s = getCacheStats();
  assertEquals(s.pageMisses, 1);
  assertEquals(s.pageHits, 1);
  assertEquals(s.pageSets, 1);
  assertEquals(s.invalidations, 1);
  const last = s.recentInvalidations.at(-1);
  assertEquals(last?.kind, "tag");
  assertEquals(last?.value, "t");
  assert(typeof last?.at === "number");
});

Deno.test("resetCacheStats clears the counters", () => {
  resetCacheStats();
  const s = getCacheStats();
  assertEquals(s.pageHits + s.pageMisses + s.pageSets + s.invalidations, 0);
  assertEquals(s.recentInvalidations.length, 0);
});
