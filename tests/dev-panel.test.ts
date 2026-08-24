import { assertStringIncludes } from "@std/assert";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { DevPanel } from "../src/server/dev-panel.ts";
import {
  inMemoryCacheStore,
  PageCache,
  resetCacheStats,
  revalidateTag,
  setCacheStore,
} from "../src/server/cache.ts";

Deno.test("DevPanel renders the page-cache snapshot + island timeline scaffold", async () => {
  setCacheStore(inMemoryCacheStore());
  resetCacheStats();
  const pc = new PageCache();
  await pc.get("k"); // miss
  await pc.set("k", { body: "<p>", status: 200, path: "/k", expiresAt: Infinity, tags: ["t"] });
  await pc.get("k"); // hit
  await revalidateTag("t"); // invalidation

  const html = await renderToString(DevPanel());

  assertStringIncludes(html, "denext · glass-box");
  // Cache counters (hits/misses/sets = 1, one invalidation).
  assertStringIncludes(html, "hits");
  assertStringIncludes(html, "misses");
  assertStringIncludes(html, "invalidations");
  // The tag invalidation surfaces with its kind + value.
  assertStringIncludes(html, "tag");
  assertStringIncludes(html, "t");
  // Island section + the live-fill script target.
  assertStringIncludes(html, "Islands");
  assertStringIncludes(html, 'id="dnx-dp-islands"');
  assertStringIncludes(html, "__denextIslands");
  // Self-contained: inline styles present.
  assertStringIncludes(html, ".dnx-devpanel");
});

Deno.test("DevPanel shows an empty state when the cache has no invalidations", async () => {
  setCacheStore(inMemoryCacheStore());
  resetCacheStats();
  const html = await renderToString(DevPanel());
  assertStringIncludes(html, "no invalidations");
});
