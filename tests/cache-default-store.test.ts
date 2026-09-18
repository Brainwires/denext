// Default cache-store resolution: chooseCacheStore (pure) + resolveDefaultCacheStore
// (latching wrapper). The durable path resolves to @denext/sqlite when it's available and
// falls back to the in-memory store otherwise — so pre-publish these assert the fallback
// path and the config/latch behavior; the SQLite path is validated in Phase 2 once the
// package publishes. Run with `deno test -A`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CacheStore,
  cacheStoreKind,
  chooseCacheStore,
  type DataEntry,
  getCacheStore,
  inMemoryCacheStore,
  resolveDefaultCacheStore,
  setCacheStore,
} from "../src/server/cache.ts";

const entry = (value: unknown): DataEntry => ({
  value,
  expiresAt: Infinity,
  tags: [],
});

// A store roundtrips a data entry — i.e. it's a live, usable CacheStore.
async function assertFunctional(store: CacheStore, key: string): Promise<void> {
  await store.setData(key, entry(key));
  assertEquals((await store.getData(key))?.value, key);
}

Deno.test("chooseCacheStore: an explicit CacheStore object is used as-is", async () => {
  const custom = inMemoryCacheStore();
  assertEquals(await chooseCacheStore({ store: custom }), custom);
});

Deno.test("chooseCacheStore: 'memory' returns a fresh, functional in-memory store", async () => {
  const a = await chooseCacheStore({ store: "memory" });
  const b = await chooseCacheStore({ store: "memory" });
  assert(a !== b, "each resolution should be a distinct in-memory store");
  await assertFunctional(a, "mem-a");
  await assertFunctional(b, "mem-b");
});

Deno.test("chooseCacheStore: a durable-store path resolves to a functional node:sqlite store", async () => {
  // The durable node:sqlite store must be a live, usable store (or fall back to in-memory if
  // the FS isn't writable), never an error. We steer it at an explicit temp DB path rather
  // than the cwd-relative default: the old version `Deno.chdir`'d into a temp cwd, but chdir
  // mutates the PROCESS-GLOBAL cwd and, under `deno test --parallel`, corrupted the cwd of
  // concurrent tests that spawn subprocesses (a `deno bundle` then dies with "Failed getting
  // cwd"). An explicit `path` keeps this fully parallel-safe — no global state touched.
  const tmp = Deno.makeTempDirSync({ prefix: "denext-cache-default-" });
  try {
    const store = await chooseCacheStore({ path: `${tmp}/cache.db` });
    await assertFunctional(store, "default-key");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("chooseCacheStore: on Deno Deploy, no store config → in-memory (no file backend)", async () => {
  Deno.env.set("DENO_DEPLOYMENT_ID", "test-deploy-id");
  try {
    const store = await chooseCacheStore();
    await assertFunctional(store, "deploy-key");
  } finally {
    Deno.env.delete("DENO_DEPLOYMENT_ID");
  }
});

Deno.test("resolveDefaultCacheStore: an explicit store wins — resolution is a no-op once set", async () => {
  // Robust to cross-file module state: setCacheStore latches unconditionally, so after it
  // a default resolution must not replace the app's chosen store. (The install-when-unset
  // path is the trivial glue over chooseCacheStore, which is covered above.)
  const explicit = inMemoryCacheStore();
  setCacheStore(explicit);
  assertEquals(getCacheStore(), explicit);

  await resolveDefaultCacheStore({ store: inMemoryCacheStore() });
  assertEquals(
    getCacheStore(),
    explicit,
    "a default resolution must never override an explicitly-set store",
  );
});

Deno.test("chooseCacheStore: an unwritable sqlite path falls back to memory with ONE boot line naming the path and the grant", async () => {
  // The prod symptom this guards: `denext start` without `--allow-write=.denext` silently
  // ran on the per-process store while /_denext/health said the cache was fine. The path
  // here is inside a plain FILE, so node:sqlite cannot create its parent directory.
  const tmp = Deno.makeTempDirSync({ prefix: "denext-cache-unwritable-" });
  const blocker = `${tmp}/not-a-dir`;
  Deno.writeTextFileSync(blocker, "");
  const path = `${blocker}/cache.db`;
  const original = console.warn;
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(" "));
  try {
    const store = await chooseCacheStore({ path });
    await assertFunctional(store, "fallback-key"); // still a working (memory) store
  } finally {
    console.warn = original;
    Deno.removeSync(tmp, { recursive: true });
  }
  assertEquals(warned.length, 1, "exactly one line");
  assertStringIncludes(warned[0], `durable node:sqlite cache unavailable at ${path}`);
  assertStringIncludes(warned[0], "--allow-write=.denext");
  assertStringIncludes(warned[0], 'cache: { store: "memory" }');
});

Deno.test("cacheStoreKind: sqlite for the durable default, memory for the fallback/explicit memory, custom for the app's own", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "denext-cache-kind-" });
  const saved = getCacheStore();
  try {
    setCacheStore(await chooseCacheStore({ path: `${tmp}/cache.db` }));
    assertEquals(cacheStoreKind(), "sqlite");
    setCacheStore(await chooseCacheStore({ store: "memory" }));
    assertEquals(cacheStoreKind(), "memory");
    setCacheStore(inMemoryCacheStore());
    assertEquals(cacheStoreKind(), "memory");
    const custom: CacheStore = {
      getData: () => undefined,
      setData: () => {},
      getPage: () => undefined,
      setPage: () => {},
      deleteByTag: () => {},
      deleteByPath: () => {},
    };
    setCacheStore(custom);
    assertEquals(cacheStoreKind(), "custom");
  } finally {
    setCacheStore(saved);
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("/_denext/health reports the store kind, so a silent fallback to memory is visible from the probe", async () => {
  // The prod handler in front of createApp serves the probe itself; a bare ProjectPaths
  // (no config) is all it reads for it. The body keeps `cache` (reachability) and adds
  // `cacheStore` (what backs it).
  const { createProdHandler } = await import("../src/build/prod-server/handler.ts");
  const handler = createProdHandler(
    { config: null } as unknown as Parameters<typeof createProdHandler>[0],
    "/nonexistent-client-dir",
    "",
    false,
    () => Promise.resolve(new Response("app")),
  );
  const saved = getCacheStore();
  try {
    setCacheStore(inMemoryCacheStore());
    const res = await handler(new Request("http://localhost/_denext/health"));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { status: "ok", cache: "ok", cacheStore: "memory" });
  } finally {
    setCacheStore(saved);
  }
});
