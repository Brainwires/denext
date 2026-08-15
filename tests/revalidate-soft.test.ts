// Part A3: revalidateTag(tag, profile) soft-expires cached data (stale-while-
// revalidate) instead of hard-purging, and the single-arg form still hard-purges.

import { assert, assertEquals } from "@std/assert";
import {
  inMemoryCacheStore,
  revalidateTag,
  setCacheStore,
  unstable_cache,
} from "../src/server/cache.ts";
import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("A3: revalidateTag(tag, profile) serves stale then refreshes in the background", async () => {
  setCacheStore(inMemoryCacheStore());
  let n = 0;
  const load = unstable_cache(() => Promise.resolve(++n), ["swr"], { tags: ["t"] });

  // Prime the cache.
  assertEquals(await load(), 1);
  assertEquals(await load(), 1, "second read is a fresh hit");

  // Soft-expire: mark stale, keep serving. Drive it inside a request so the
  // background refresh is registered on (and drained by) the deferred queue.
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    await revalidateTag("t", "max");
    // The very next read serves the STALE value (still 1) and kicks a refresh.
    assertEquals(await load(), 1, "stale value served immediately");
  });
  await runDeferred(ctx); // drain the background refresh
  await tick();

  // After the background refresh landed, the next read is fresh.
  assertEquals(await load(), 2, "background refresh produced a fresh value");
  assertEquals(n, 2, "loader ran exactly twice (once primed, once refreshed)");
});

Deno.test("A3: single-arg revalidateTag still hard-purges (recompute on next read)", async () => {
  setCacheStore(inMemoryCacheStore());
  let n = 0;
  const load = unstable_cache(() => Promise.resolve(++n), ["hard"], { tags: ["h"] });
  assertEquals(await load(), 1);
  await revalidateTag("h"); // no profile → hard purge
  assertEquals(await load(), 2, "entry was purged, so it recomputed");
});

Deno.test("A3: the background refresh is deduped (one refresh under a stale stampede)", async () => {
  setCacheStore(inMemoryCacheStore());
  let n = 0;
  const load = unstable_cache(
    async () => {
      await tick();
      return ++n;
    },
    ["dedupe"],
    { tags: ["d"] },
  );
  assertEquals(await load(), 1);

  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    await revalidateTag("d", "hours");
    // Three concurrent stale reads must trigger only ONE background refresh.
    const [a, b, c] = await Promise.all([load(), load(), load()]);
    assertEquals([a, b, c], [1, 1, 1], "all serve the stale value");
  });
  await runDeferred(ctx);
  await tick();
  assert(n === 2, `exactly one refresh ran (n=${n})`);
});
