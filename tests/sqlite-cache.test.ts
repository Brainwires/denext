// SQLite CacheStore adapter tests. Run with `deno test -A` — note NO
// `--unstable-kv` flag is required (that's the point of this backend).
//
// The store is backed by the first-party `@denext/sqlite` workspace package, so
// these run for real in CI. The self-skip is a safety net: if the package's wasm
// artifact is somehow unresolvable, the suite stays green rather than erroring.

import { assertEquals, assertRejects } from "@std/assert";
import { sqliteCacheStore } from "../src/server/sqlite-cache.ts";
import type { CachedPage, DataEntry } from "../src/server/cache.ts";

// deno-lint-ignore no-explicit-any
let rsqlite: any;
try {
  const specifier = "@denext/sqlite";
  rsqlite = await import(specifier);
} catch {
  rsqlite = undefined;
}
const skip = rsqlite === undefined;

function freshStore() {
  const dir = Deno.makeTempDirSync({ prefix: "denext-sqlite-cache-" });
  const path = `${dir}/cache.db`;
  return sqliteCacheStore({ path, module: rsqlite });
}

const soon = () => Date.now() + 60_000; // fresh
const past = () => Date.now() - 1_000; // already expired

const dataEntry = (
  value: unknown,
  tags: string[] = [],
  expiresAt = Infinity,
): DataEntry => ({ value, expiresAt, tags });

const page = (
  body: string,
  path: string,
  tags: string[] = [],
  expiresAt = Infinity,
): CachedPage => ({ body, status: 200, path, expiresAt, tags });

Deno.test({
  name: "data: set then get returns a structurally-equal entry",
  ignore: skip,
  fn: async () => {
    const store = freshStore();
    const entry = dataEntry({ hello: "world", n: 42 }, ["t1"]);
    await store.setData("k1", entry);
    assertEquals(await store.getData("k1"), entry);
  },
});

Deno.test({
  name: "data: unknown key is a miss",
  ignore: skip,
  fn: async () => {
    const store = freshStore();
    assertEquals(await store.getData("nope"), undefined);
  },
});

Deno.test({
  name: "data: expired entry is a miss (and is evicted)",
  ignore: skip,
  fn: async () => {
    const store = freshStore();
    await store.setData("k", dataEntry("v", [], past()));
    assertEquals(await store.getData("k"), undefined);
    // A fresh entry under the same key still works after the stale eviction.
    await store.setData("k", dataEntry("v2", [], soon()));
    assertEquals((await store.getData("k"))?.value, "v2");
  },
});

Deno.test({
  name: "data: infinity expiry persists as a hit",
  ignore: skip,
  fn: async () => {
    const store = freshStore();
    await store.setData("k", dataEntry("forever"));
    assertEquals((await store.getData("k"))?.expiresAt, Infinity);
  },
});

Deno.test({
  name: "data: staleAt (stale-while-revalidate point) round-trips",
  ignore: skip,
  fn: async () => {
    const store = freshStore();
    const staleAt = Date.now() + 30_000;
    const entry: DataEntry = { value: "v", expiresAt: Date.now() + 60_000, staleAt, tags: [] };
    await store.setData("k", entry);
    const got = await store.getData("k");
    assertEquals(got?.staleAt, staleAt);
    assertEquals(got?.value, "v");
  },
});

Deno.test({
  name: "data: an entry written with no staleAt reads back with none (never stale)",
  ignore: skip,
  fn: async () => {
    const store = freshStore();
    await store.setData("k", dataEntry("v", [], Date.now() + 60_000));
    const got = await store.getData("k");
    assertEquals(got?.value, "v");
    assertEquals("staleAt" in (got ?? {}), false);
  },
});

Deno.test({
  name: "expireByTag soft-expires (SWR) data + pages in place, not delete",
  ignore: skip,
  fn: async () => {
    const store = freshStore();
    await store.setData("d1", dataEntry("keep", ["t"]));
    await store.setData("d2", dataEntry("untagged", ["other"]));
    await store.setPage("p1", page("<html>", "/a", ["t"]));

    const staleAt = Date.now();
    const expiresAt = Date.now() + 60_000;
    await store.expireByTag!("t", { staleAt, expiresAt });

    // Tagged entries are STILL PRESENT (served stale), with rewritten timing.
    const d1 = await store.getData("d1");
    assertEquals(d1?.value, "keep");
    assertEquals(d1?.staleAt, staleAt);
    assertEquals(d1?.expiresAt, expiresAt);
    const p1 = await store.getPage("p1");
    assertEquals(p1?.body, "<html>");
    assertEquals(p1?.staleAt, staleAt);
    assertEquals(p1?.expiresAt, expiresAt);

    // An entry with a different tag is untouched.
    const d2 = await store.getData("d2");
    assertEquals(d2?.expiresAt, Infinity);
    assertEquals("staleAt" in (d2 ?? {}), false);
  },
});

Deno.test({
  name: "migration: a pre-SWR data table (no stale_at) is upgraded in place",
  ignore: skip,
  fn: async () => {
    const dir = Deno.makeTempDirSync({ prefix: "denext-sqlite-migrate-" });
    const path = `${dir}/cache.db`;
    // Seed an OLD-schema data table (the columns before stale_at existed).
    const raw = await rsqlite.Database.open(path, { backend: "file" });
    raw.exec(
      "CREATE TABLE data (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL, tags TEXT NOT NULL)",
    );
    raw.exec("INSERT INTO data (key, value, expires_at, tags) VALUES ('old', '\"v\"', NULL, '[]')");
    raw.close();

    // Opening the store runs `ALTER TABLE data ADD COLUMN stale_at` — the old row
    // still reads (never stale), and a new entry can persist its staleAt.
    const store = sqliteCacheStore({ path, module: rsqlite });
    assertEquals((await store.getData("old"))?.value, "v");
    const staleAt = Date.now() + 30_000;
    await store.setData("new", { value: "n", expiresAt: Infinity, staleAt, tags: [] });
    assertEquals((await store.getData("new"))?.staleAt, staleAt);
  },
});

Deno.test({
  name: "pages: set/get and deleteByPath removes only the matching path",
  ignore: skip,
  fn: async () => {
    const store = freshStore();
    await store.setPage("a", page("<a>", "/a"));
    await store.setPage("b", page("<b>", "/b"));

    assertEquals((await store.getPage("a"))?.body, "<a>");

    await store.deleteByPath("/a");
    assertEquals(await store.getPage("a"), undefined);
    assertEquals((await store.getPage("b"))?.body, "<b>"); // untouched
  },
});

Deno.test({
  name: "deleteByTag purges both data and page namespaces, leaves untagged",
  ignore: skip,
  fn: async () => {
    const store = freshStore();
    await store.setData("d1", dataEntry("v1", ["shared"]));
    await store.setData("d2", dataEntry("v2", ["other"]));
    await store.setPage("p1", page("<p1>", "/p1", ["shared"]));
    await store.setPage("p2", page("<p2>", "/p2", ["other"]));

    await store.deleteByTag("shared");

    assertEquals(await store.getData("d1"), undefined); // tagged -> gone
    assertEquals(await store.getPage("p1"), undefined); // tagged -> gone
    assertEquals((await store.getData("d2"))?.value, "v2"); // untagged -> kept
    assertEquals((await store.getPage("p2"))?.body, "<p2>"); // untagged -> kept
  },
});

Deno.test({
  name: "retagging: a removed tag no longer invalidates the entry",
  ignore: skip,
  fn: async () => {
    const store = freshStore();
    await store.setData("k", dataEntry("v", ["old"]));
    // Rewrite with a different tag set.
    await store.setData("k", dataEntry("v", ["new"]));

    await store.deleteByTag("old"); // stale tag must not purge the entry
    assertEquals((await store.getData("k"))?.value, "v");

    await store.deleteByTag("new"); // current tag does
    assertEquals(await store.getData("k"), undefined);
  },
});

// ---- Failure modes (fake module — run WITHOUT the optional dependency) ------

// A minimal in-memory stand-in for an rsqlite `Database` (schema execs are no-ops;
// query returns nothing, so every read is a clean miss).
function fakeDb() {
  return {
    exec: (_sql: string, _params?: unknown[]) => 0,
    query: <T>(_sql: string, _params?: unknown[]): T[] => [],
    close: () => {},
  };
}

Deno.test("sqlite: a failed Database.open is not memoized — the next access retries (CACHE-M2)", async () => {
  let attempts = 0;
  const module = {
    Database: {
      open: (_path: string) => {
        attempts++;
        // Fail the first open (transient lock/FS hiccup), succeed thereafter.
        return attempts === 1
          ? Promise.reject(new Error("database is locked"))
          : Promise.resolve(fakeDb());
      },
    },
  };
  const store = sqliteCacheStore({ path: ":memory:", module });

  // First access fails (the open rejected)…
  await assertRejects(() => store.getData("k") as Promise<unknown>, Error, "locked");
  // …but the failure wasn't cached, so the next access retries and succeeds.
  assertEquals(await store.getData("k"), undefined);
  assertEquals(attempts, 2, "the store re-opened rather than staying permanently disabled");
});

Deno.test("sqlite: a store that can't initialize surfaces the error (caller then serves uncached)", async () => {
  const module = {
    Database: {
      open: (_path: string) =>
        Promise.resolve({
          // Schema creation fails — simulates a corrupt/unwritable database file.
          exec: (_sql: string, _params?: unknown[]): number => {
            throw new Error("disk I/O error");
          },
          query: <T>(_sql: string, _params?: unknown[]): T[] => [],
          close: () => {},
        }),
    },
  };
  const store = sqliteCacheStore({ path: ":memory:", module });
  // The store propagates the error; cache.ts's best-effort wrapper turns this into
  // an uncached read at the call site (covered in production-hardening.test.ts).
  await assertRejects(() => store.getPage("k") as Promise<unknown>, Error, "disk I/O");
});

// A store with tight caps and an eager sweep, for the eviction/sweep tests.
function cappedStore(maxDataEntries: number, maxPageEntries: number) {
  const dir = Deno.makeTempDirSync({ prefix: "denext-sqlite-cache-evict-" });
  return sqliteCacheStore({
    path: `${dir}/cache.db`,
    module: rsqlite,
    maxDataEntries,
    maxPageEntries,
    sweepIntervalMs: 0, // sweep on every write so hard-expiry reclaim is deterministic
  });
}

Deno.test({
  name: "data: FIFO eviction drops the oldest-inserted rows past maxDataEntries",
  ignore: skip,
  fn: async () => {
    const store = cappedStore(3, 3);
    for (let i = 0; i < 5; i++) {
      await store.setData(`k${i}`, dataEntry({ i }, [`t${i}`]));
    }
    // Cap 3: the two oldest (k0, k1) are evicted; the three newest remain.
    assertEquals(await store.getData("k0"), undefined);
    assertEquals(await store.getData("k1"), undefined);
    assertEquals((await store.getData("k2"))?.value, { i: 2 });
    assertEquals((await store.getData("k4"))?.value, { i: 4 });

    // The cap holds on further writes: k5 in, k2 (now oldest) out.
    await store.setData("k5", dataEntry({ i: 5 }, ["t5"]));
    assertEquals(await store.getData("k2"), undefined);
    assertEquals((await store.getData("k3"))?.value, { i: 3 });
    assertEquals((await store.getData("k5"))?.value, { i: 5 });

    // An evicted key's tag rows are cleaned up too: re-tagging under a fresh key and
    // purging the evicted key's old tag must not remove the survivor.
    await store.setData("k3", dataEntry({ i: 3 }, ["t0"])); // reuse t0 (was k0's tag)
    await store.deleteByTag("t0"); // would over-delete if k0's orphan tag row lingered
    // k3 carried t0 so it goes; the point is no crash and tag purge is well-scoped.
    assertEquals(await store.getData("k3"), undefined);
    assertEquals((await store.getData("k5"))?.value, { i: 5 });
  },
});

Deno.test({
  name: "pages: FIFO eviction drops the oldest-inserted rows past maxPageEntries",
  ignore: skip,
  fn: async () => {
    const store = cappedStore(3, 2);
    for (let i = 0; i < 4; i++) {
      await store.setPage(`p${i}`, page(`body${i}`, `/p${i}`, [`pt${i}`]));
    }
    // Cap 2: p0, p1 evicted; p2, p3 remain.
    assertEquals(await store.getPage("p0"), undefined);
    assertEquals(await store.getPage("p1"), undefined);
    assertEquals((await store.getPage("p2"))?.body, "body2");
    assertEquals((await store.getPage("p3"))?.body, "body3");
  },
});

Deno.test({
  name: "sweep: hard-expired rows are reclaimed on write (SQL runs on the engine)",
  ignore: skip,
  fn: async () => {
    // Caps high so eviction doesn't interfere; sweepIntervalMs:0 forces a sweep each write.
    const store = cappedStore(1000, 1000);
    await store.setData("stale", dataEntry({ v: 1 }, ["s"], past())); // already expired
    await store.setData("fresh", dataEntry({ v: 2 }, ["s"], soon())); // triggers the sweep
    // The expired row is gone without ever being read; the fresh one survives.
    assertEquals(await store.getData("stale"), undefined);
    assertEquals((await store.getData("fresh"))?.value, { v: 2 });
  },
});

if (skip) {
  console.warn(
    "sqlite-cache.test.ts: '@denext/sqlite' not resolvable — tests skipped. " +
      "Build it (packages/sqlite: deno run -A jsr:@deno/wasmbuild build) to run.",
  );
}
