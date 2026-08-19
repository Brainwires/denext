// Cache Components building blocks (Part A1/A2): the cacheLife profile registry
// and the cache-scope APIs cacheLife()/cacheTag() that a `use cache` function uses
// to declare its lifetime and tags.

import { assert, assertEquals } from "@std/assert";
import {
  cacheLife,
  type CacheLifeProfile,
  cacheTag,
  currentCacheScope,
  registerCacheLifeProfiles,
  resolveCacheLife,
  withCacheScope,
} from "../src/server/cache.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

Deno.test("resolveCacheLife returns the built-in profiles", () => {
  assertEquals(resolveCacheLife("seconds"), { stale: 0, revalidate: 1, expire: 60 });
  assertEquals(resolveCacheLife("hours"), { stale: 300, revalidate: 3600, expire: 86400 });
  assertEquals(resolveCacheLife("max"), { stale: 300, revalidate: 2592000, expire: Infinity });
});

Deno.test("resolveCacheLife: unknown name falls back to default; inline fills from default", () => {
  assertEquals(resolveCacheLife("nope"), { stale: 300, revalidate: 900, expire: Infinity });
  // An inline object supplies only `revalidate`; stale/expire inherit from default.
  assertEquals(resolveCacheLife({ revalidate: 42 }), {
    stale: 300,
    revalidate: 42,
    expire: Infinity,
  });
});

Deno.test("registerCacheLifeProfiles adds custom profiles and overrides a built-in", () => {
  const custom: Record<string, CacheLifeProfile> = {
    blog: { stale: 60, revalidate: 120, expire: 3600 },
    hours: { stale: 1, revalidate: 2, expire: 3 }, // override the built-in
  };
  registerCacheLifeProfiles(custom);
  assertEquals(resolveCacheLife("blog"), { stale: 60, revalidate: 120, expire: 3600 });
  assertEquals(resolveCacheLife("hours"), { stale: 1, revalidate: 2, expire: 3 });
});

Deno.test("cacheLife + cacheTag record onto the enclosing cache scope", async () => {
  const { value, scope } = await withCacheScope(async () => {
    assert(currentCacheScope() !== undefined, "inside a scope");
    cacheLife("hours");
    cacheTag("posts", "user-1");
    await Promise.resolve();
    cacheLife({ revalidate: 5 }); // last cacheLife wins
    return "body";
  });
  assertEquals(value, "body");
  assertEquals(scope.life, { stale: 300, revalidate: 5, expire: Infinity });
  assertEquals(scope.tags, ["posts", "user-1"]);
});

Deno.test("cacheTag also propagates tags to the enclosing page render", async () => {
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    await withCacheScope(() => {
      cacheTag("a", "b");
      return null;
    });
    // Even outside a scope, cacheTag propagates to the page's collected tags.
    cacheTag("c");
  });
  assertEquals([...(ctx.collectedTags ?? [])].sort(), ["a", "b", "c"]);
});

Deno.test("cacheLife outside a scope is a no-op (does not throw)", () => {
  assert(currentCacheScope() === undefined);
  cacheLife("days"); // no scope → silently ignored
});
