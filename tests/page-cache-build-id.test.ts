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
import {
  type CachedPage,
  type CacheStore,
  type DataEntry,
  inMemoryCacheStore,
  PageCache,
  pageStoreKey,
  setCacheStore,
  sweepOtherBuildPages,
} from "../src/server/cache.ts";
import { openSqliteFile, sqliteCacheStore, type SqliteDb } from "../src/server/sqlite-cache.ts";
import { mayOwnPageStore } from "../src/build/prod-server/app.ts";
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

// ---- The startup sweep of other builds' pages ------------------------------------------------

const page = (path: string, tags: string[] = []): CachedPage => ({
  body: `<p>${path}</p>`,
  status: 200,
  path,
  expiresAt: Infinity,
  tags,
});
const data = (value: unknown, tags: string[] = []): DataEntry => ({
  value,
  expiresAt: Infinity,
  tags,
});

/** Seed a store the way two builds, an older format and the data cache leave it. */
async function seedMixedStore(store: CacheStore): Promise<void> {
  await store.setPage(pageStoreKey("/a", "A"), page("/a", ["t"])); // this build
  await store.setPage(pageStoreKey("/b?q=1", "A"), page("/b"));
  await store.setPage(pageStoreKey("/a", "B"), page("/a", ["t"])); // the previous build
  await store.setPage("/a", page("/a", ["t"])); // format 1: bare path
  await store.setPage(pageStoreKey("/a"), page("/a")); // format 2, no build id
  await store.setData("fetch:/api", data({ n: 1 }, ["t"])); // data cache: never swept
  await store.setData("v1:/a", data("a data key that looks like a page key"));
}

async function assertSwept(store: CacheStore): Promise<void> {
  assertEquals(await store.sweepPages!(pageStoreKey("", "A")), 3);
  assert(await store.getPage(pageStoreKey("/a", "A")), "this build's pages are kept");
  assert(await store.getPage(pageStoreKey("/b?q=1", "A")));
  assertEquals(await store.getPage(pageStoreKey("/a", "B")), undefined, "other build swept");
  assertEquals(await store.getPage("/a"), undefined, "format-1 page swept");
  assertEquals(await store.getPage(pageStoreKey("/a")), undefined, "build-less page swept");
  assertEquals((await store.getData("fetch:/api"))?.value, { n: 1 }, "data entries kept");
  assert(await store.getData("v1:/a"));
  // The kept page's tag index survived: revalidateTag still reaches it.
  await store.deleteByTag("t");
  assertEquals(await store.getPage(pageStoreKey("/a", "A")), undefined);
  assertEquals(await store.sweepPages!(pageStoreKey("", "A")), 0, "a second sweep is a no-op");
}

Deno.test("sqlite store: sweepPages drops other builds + older formats, keeps ours and data", async () => {
  let db: SqliteDb | undefined;
  const store = sqliteCacheStore({ path: ":memory:", openDb: (p) => (db = openSqliteFile(p)) });
  await seedMixedStore(store);
  await assertSwept(store);
  // The swept pages' tag rows went with them (no orphans left in the uncapped tags table).
  const orphans = db!.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tags WHERE ns = 'page' AND key NOT IN (SELECT key FROM pages)",
  )[0].n;
  assertEquals(orphans, 0);
});

Deno.test("sqlite store: a kept prefix is compared literally (no LIKE wildcards)", async () => {
  const store = sqliteCacheStore({ path: ":memory:" });
  await store.setPage("v2:A_:/x", page("/x"));
  await store.setPage("v2:AB:/x", page("/x"));
  assertEquals(await store.sweepPages!("v2:A_:"), 1);
  assert(await store.getPage("v2:A_:/x"));
});

Deno.test("in-memory store: sweepPages drops other builds + older formats, keeps ours and data", async () => {
  const store = inMemoryCacheStore();
  await seedMixedStore(store);
  await assertSwept(store);
});

Deno.test("sweepOtherBuildPages: a custom store without sweepPages is left alone", async () => {
  const pages = new Map<string, CachedPage>();
  const custom: CacheStore = {
    getData: () => undefined,
    setData: () => {},
    getPage: (k) => pages.get(k),
    setPage: (k, p) => void pages.set(k, p),
    deleteByTag: () => {},
    deleteByPath: () => {},
  };
  setCacheStore(custom);
  pages.set("v2:OLD:/a", page("/a"));
  assertEquals(await sweepOtherBuildPages("NEW"), undefined);
  assert(pages.has("v2:OLD:/a"), "untouched");
  // One that implements it gets this build's prefix.
  let kept = "";
  setCacheStore({ ...custom, sweepPages: (k) => ((kept = k), 7) });
  assertEquals(await sweepOtherBuildPages("NEW"), 7);
  assertEquals(kept, "v2:NEW:");
  // A failing sweep is housekeeping: logged, never thrown.
  const realError = console.error;
  console.error = () => {};
  try {
    setCacheStore({
      ...custom,
      sweepPages: () => {
        throw new Error("down");
      },
    });
    assertEquals(await sweepOtherBuildPages("NEW"), undefined);
  } finally {
    console.error = realError;
    setCacheStore(inMemoryCacheStore());
  }
});

Deno.test("the startup sweep runs only where no other live build can share the store", () => {
  const random = { buildIdPinned: false };
  const pinned = { buildIdPinned: true };
  // A store only this build uses: always.
  assert(mayOwnPageStore(random, "memory", false));
  assert(mayOwnPageStore(random, "sqlite", false)); // the default .denext/cache.db
  // One other servers may share: only with a deliberate (DENEXT_BUILD_ID) id.
  assert(!mayOwnPageStore(random, "sqlite", true)); // an explicit cache.path
  assert(!mayOwnPageStore(random, "custom", false));
  assert(mayOwnPageStore(pinned, "custom", false));
  assert(mayOwnPageStore(pinned, "sqlite", true));
});

Deno.test("denext start reads whether the build id was pinned", async () => {
  const outDir = await Deno.makeTempDir({ prefix: "denext_buildid_" });
  try {
    const paths = { outDir, projectDir: outDir } as unknown as ProjectPaths;
    await Deno.writeTextFile(
      join(outDir, "manifest.json"),
      JSON.stringify({ buildId: "sha1", buildIdPinned: true }),
    );
    assertEquals((await readBuildInfo(paths)).buildIdPinned, true);
    await Deno.writeTextFile(join(outDir, "manifest.json"), JSON.stringify({ buildId: "r" }));
    assertEquals((await readBuildInfo(paths)).buildIdPinned, false);
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});
