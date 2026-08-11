// SQLite CacheStore adapter tests. Run with `deno test -A` — note NO
// `--unstable-kv` flag is required (that's the point of this backend).
//
// The store is backed by `rsqlite-wasm`. When that package isn't resolvable
// (not yet installed/mapped), every test self-skips so the suite stays green in
// CI without the optional dependency; map `rsqlite-wasm` (e.g. to
// `npm:rsqlite-wasm`) and the full suite runs.

import { assertEquals, assertRejects } from "@std/assert";
import { sqliteCacheStore } from "../src/server/sqlite-cache.ts";
import type { CachedPage, DataEntry } from "../src/server/cache.ts";

// deno-lint-ignore no-explicit-any
let rsqlite: any;
try {
  const specifier = "rsqlite-wasm";
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

if (skip) {
  console.warn(
    "sqlite-cache.test.ts: 'rsqlite-wasm' not resolvable — tests skipped. " +
      "Map it (e.g. npm:rsqlite-wasm) to run the full suite.",
  );
}
