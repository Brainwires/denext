// The page cache is keyed per build: a cached page bakes in its build's hashed client chunk
// URLs (and its server-rendered content), which a redeploy no longer serves — so a new build
// must never read the previous build's entries, even from a durable store that outlived it.
// `denext build` writes the id into manifest.json and `denext start` hands it to `PageCache`.

import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { inMemoryCacheStore, PageCache, pageStoreKey, setCacheStore } from "../src/server/cache.ts";
import { resolveBuildId } from "../src/build/build-pipeline/finalize.ts";
import { readBuildInfo } from "../src/build/prod-server/manifest.ts";
import type { ProjectPaths } from "../src/build/paths.ts";

const pageFile = "/app/page.tsx";
const manifest = (): RouteManifest => ({
  pages: [{
    kind: "page",
    pattern: parsePattern(""),
    routePath: "/",
    filePath: pageFile,
    layoutChain: [],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  }],
  api: [],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
  directives: new Map(),
});

/** A server for `build`: an ISR page (force-static) whose body names the build that rendered it. */
function serverFor(build: string) {
  const Page = () => h("p", null, `rendered by ${build}`);
  return createApp({
    getManifest: manifest,
    load: (fp) =>
      Promise.resolve(fp === pageFile ? { default: Page, dynamic: "force-static" } : undefined),
    pageCache: new PageCache(build),
  });
}

Deno.test("a redeploy (build B) never serves build A's cached pages from a shared store", async () => {
  const store = inMemoryCacheStore(); // outlives both "processes", like .denext/cache.db
  setCacheStore(store);
  const a = serverFor("A");
  const first = await a(new Request("http://x/"));
  assertEquals(first.headers.get("x-denext-cache"), "MISS");
  await first.text();
  const again = await a(new Request("http://x/"));
  assertEquals(again.headers.get("x-denext-cache"), "HIT");
  assert((await again.text()).includes("rendered by A"));
  assert(await store.getPage(pageStoreKey("/", "A")), "build A's entry is under its id");

  // Restart as build B over the same store: its own render, never A's (force-static never
  // expires, so without the build key A's page would be served forever).
  const b = serverFor("B");
  const res = await b(new Request("http://x/"));
  assertEquals(res.headers.get("x-denext-cache"), "MISS");
  const body = await res.text();
  assert(body.includes("rendered by B") && !body.includes("rendered by A"), body);
  assertEquals((await b(new Request("http://x/"))).headers.get("x-denext-cache"), "HIT");
});

Deno.test("pageStoreKey: format, then build, then key; no build id → format + key", () => {
  assertEquals(pageStoreKey("/a?x=1", "b1"), "v2:b1:/a?x=1");
  assertEquals(pageStoreKey("/a"), "v2:/a");
  assertEquals(pageStoreKey("/a", ""), "v2:/a");
});

Deno.test("resolveBuildId: DENEXT_BUILD_ID wins; otherwise a fresh random id per build", () => {
  assertEquals(resolveBuildId(" 3f2c9a1 "), "3f2c9a1");
  const one = resolveBuildId(undefined);
  assertMatch(one, /^[0-9a-f]{16}$/);
  assertNotEquals(resolveBuildId(""), one);
});

Deno.test("denext start reads the build id from manifest.json (absent for an older build)", async () => {
  const outDir = await Deno.makeTempDir({ prefix: "denext_buildid_" });
  try {
    const paths = { outDir, projectDir: outDir } as unknown as ProjectPaths;
    assertEquals((await readBuildInfo(paths)).buildId, undefined);
    await Deno.writeTextFile(join(outDir, "manifest.json"), JSON.stringify({ buildId: "abc123" }));
    assertEquals((await readBuildInfo(paths)).buildId, "abc123");
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});
