// Cache-store throughput: node:sqlite (durable, Deno built-in, zero-npm) vs the
// in-memory default. A set+get round-trip is the representative hot path (ISR page
// cache + unstable_cache).
//
//   deno bench -A --config deno.json bench/packages/cache_bench.ts
//
// Single machine → read the RELATIVE column, not absolute ns. Durability (sqlite
// survives restarts, in-memory does not) is a capability difference the numbers
// don't show; sqlite's cost buys persistence with no unstable flag.

import { inMemoryCacheStore } from "../../src/server/cache.ts";
import { sqliteCacheStore } from "../../src/server/sqlite-cache.ts";
import type { CacheStore, DataEntry } from "../../src/server/cache.ts";

const N = 200;
const mkEntry = (v: string): DataEntry => ({
  value: v,
  expiresAt: Infinity,
  tags: [],
});

const memory = inMemoryCacheStore();
const dir = Deno.makeTempDirSync({ prefix: "bench_sqlite_" });
const sqlite = sqliteCacheStore({ path: `${dir}/cache.db` });

// Seed each store so getData hits an existing row.
for (const store of [memory, sqlite]) {
  for (let i = 0; i < N; i++) await store.setData(`k${i}`, mkEntry(`v${i}`));
}

let gi = 0;
let si = 0;

// READ (cache hit) — the hot path for an ISR/page cache: written rarely on
// revalidation, read on every request.
function readBench(name: string, store: CacheStore, baseline = false) {
  Deno.bench({
    name,
    group: "getData (cache hit)",
    baseline,
    fn: async () => {
      await store.getData(`k${gi++ % N}`);
    },
  });
}

// WRITE (durable set) — happens on cache fill / revalidation.
function writeBench(name: string, store: CacheStore, baseline = false) {
  Deno.bench({
    name,
    group: "setData (write)",
    baseline,
    fn: async () => {
      await store.setData(`k${si++ % N}`, mkEntry("payload"));
    },
  });
}

readBench("in-memory (default, ephemeral)", memory, true);
readBench("node:sqlite (durable file)", sqlite);

writeBench("in-memory (default, ephemeral)", memory, true);
writeBench("node:sqlite (durable file)", sqlite);
