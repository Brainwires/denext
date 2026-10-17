// Cache Components building blocks (Part A1/A2): the cacheLife profile registry
// and the cache-scope APIs cacheLife()/cacheTag() that a `use cache` function uses
// to declare its lifetime and tags.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  cacheLife,
  type CacheLifeProfile,
  cacheTag,
  currentCacheScope,
  installCacheLifeProfiles,
  registerCacheLifeProfiles,
  resolveCacheLife,
  validateCacheLifeProfile,
  withCacheScope,
} from "../src/server/cache.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

Deno.test("resolveCacheLife returns the built-in profiles (Next.js 16's values)", () => {
  // Next 16 `config-shared.js`: `seconds` keeps a 30 s client stale time and `max` expires
  // after a year (it no longer lives forever).
  assertEquals(resolveCacheLife("default"), { stale: 300, revalidate: 900, expire: Infinity });
  assertEquals(resolveCacheLife("seconds"), { stale: 30, revalidate: 1, expire: 60 });
  assertEquals(resolveCacheLife("minutes"), { stale: 300, revalidate: 60, expire: 3600 });
  assertEquals(resolveCacheLife("hours"), { stale: 300, revalidate: 3600, expire: 86400 });
  assertEquals(resolveCacheLife("days"), { stale: 300, revalidate: 86400, expire: 604800 });
  assertEquals(resolveCacheLife("weeks"), { stale: 300, revalidate: 604800, expire: 2592000 });
  assertEquals(resolveCacheLife("max"), { stale: 300, revalidate: 2592000, expire: 31536000 });
});

Deno.test("resolveCacheLife: an unknown name throws Next.js's error; inline fills from default", () => {
  assertThrows(
    () => resolveCacheLife("nope"),
    Error,
    'Unknown `cacheLife()` profile "nope" is not configured',
  );
  // Next.js points out a known name padded with spaces.
  assertThrows(
    () => resolveCacheLife(" hours "),
    Error,
    'Did you mean "hours" without the spaces?',
  );
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
  try {
    registerCacheLifeProfiles(custom);
    assertEquals(resolveCacheLife("blog"), { stale: 60, revalidate: 120, expire: 3600 });
    assertEquals(resolveCacheLife("hours"), { stale: 1, revalidate: 2, expire: 3 });
  } finally {
    installCacheLifeProfiles(undefined);
  }
});

Deno.test("cacheLife + cacheTag record onto the enclosing cache scope", async () => {
  const { value, scope } = await withCacheScope(async () => {
    assert(currentCacheScope() !== undefined, "inside a scope");
    cacheLife("days");
    cacheTag("posts", "user-1");
    await Promise.resolve();
    cacheLife({ revalidate: 5 });
    return "body";
  });
  assertEquals(value, "body");
  // Next.js keeps, per field, the LOWEST value any cacheLife() call set — not the last call.
  assertEquals(scope.life, { stale: 300, revalidate: 5, expire: 604800 });
  assertEquals(scope.tags, ["posts", "user-1"]);
});

Deno.test("cacheLife: several calls keep the lowest of each field, whatever the order", async () => {
  const { scope } = await withCacheScope(() => {
    cacheLife({ stale: 10 });
    cacheLife("hours"); // stale 300 is higher than 10 → stale stays 10
    cacheLife({ expire: 7200 }); // lower than hours' 86400
    return null;
  });
  assertEquals(scope.life, { stale: 10, revalidate: 3600, expire: 7200 });
});

Deno.test("cacheLife validates an inline profile with Next.js's messages", async () => {
  await withCacheScope(() => {
    assertThrows(
      () => cacheLife({ revalidate: false as never }),
      Error,
      "Pass `Infinity` instead of `false`",
    );
    assertThrows(
      () => cacheLife({ stale: "60" as never }),
      Error,
      "The stale option must be a number of seconds.",
    );
    assertThrows(() => cacheLife({ expire: NaN }), Error, 'Invalid `cacheLife()` option "expire"');
    assertThrows(
      () => cacheLife({ revalidate: 100, expire: 10 }),
      Error,
      "the expire option must be greater than the revalidate option",
    );
    assertThrows(() => cacheLife(null as never), Error, "Either pass a profile name or object.");
    assertThrows(() => cacheLife("nope"), Error, 'Unknown `cacheLife()` profile "nope"');
    cacheLife({ expire: Infinity }); // Infinity is allowed
    return null;
  });
});

Deno.test("cacheLife throws outside a use cache function and inside unstable_cache's loader", async () => {
  assertThrows(
    () => cacheLife("hours"),
    Error,
    '`cacheLife()` can only be called inside a `"use cache"`',
  );
  await assertRejects(
    () =>
      withCacheScope(async () => {
        await Promise.resolve();
        cacheLife("hours");
      }, "unstable"),
    Error,
    "can only be called inside",
  );
  // A private scope accepts it.
  const { scope } = await withCacheScope(() => cacheLife({ stale: 60 }), "private");
  assertEquals(scope.life, { stale: 60 });
});

Deno.test("installCacheLifeProfiles: config profiles (a custom default too), validated, replaced", () => {
  try {
    installCacheLifeProfiles({
      default: { revalidate: 120 }, // missing fields come from the built-in default
      biweekly: { stale: 60, revalidate: 1209600, expire: Infinity },
    });
    assertEquals(resolveCacheLife("default"), { stale: 300, revalidate: 120, expire: Infinity });
    assertEquals(resolveCacheLife("biweekly"), {
      stale: 60,
      revalidate: 1209600,
      expire: Infinity,
    });
    // A custom profile's missing fields come from the (configured) default.
    installCacheLifeProfiles({ default: { stale: 7 }, partial: { revalidate: 30 } });
    assertEquals(resolveCacheLife("partial"), { stale: 7, revalidate: 30, expire: Infinity });
    assertThrows(() => resolveCacheLife("biweekly"), Error, "Unknown"); // replaced, not merged
    assertThrows(
      () => installCacheLifeProfiles({ bad: { revalidate: 10, expire: 5 } }),
      Error,
      "the expire option must be greater",
    );
    assertThrows(
      () => validateCacheLifeProfile({ stale: -Infinity }, { config: "x" }),
      Error,
      'Invalid "cacheLife.x.stale" provided',
    );
  } finally {
    installCacheLifeProfiles(undefined);
  }
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

Deno.test("cacheTag outside a scope still tags the page (denext keeps it callable there)", () => {
  assert(currentCacheScope() === undefined);
  cacheTag("outside"); // no throw
});
