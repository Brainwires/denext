// Default cache-store resolution: chooseCacheStore (pure) + resolveDefaultCacheStore
// (latching wrapper). The durable path resolves to @denext/sqlite when it's available and
// falls back to the in-memory store otherwise — so pre-publish these assert the fallback
// path and the config/latch behavior; the SQLite path is validated in Phase 2 once the
// package publishes. Run with `deno test -A`.
import { assert, assertEquals } from "@std/assert";
import {
  type CacheStore,
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
