// SQLite CacheStore adapter tests. Backed by Deno's built-in node:sqlite (real SQLite),
// so these always run — no optional dependency, no unstable flag. Run with `deno test -A`.

import { assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { sqliteCacheStore } from "../src/server/sqlite-cache.ts";
import type { CachedPage, DataEntry } from "../src/server/cache.ts";

function freshStore() {
  const dir = Deno.makeTempDirSync({ prefix: "denext-sqlite-cache-" });
  return sqliteCacheStore({ path: `${dir}/cache.db` });
}

// A store with tight caps and an eager sweep, for the eviction/sweep tests.
function cappedStore(maxDataEntries: number, maxPageEntries: number) {
  const dir = Deno.makeTempDirSync({ prefix: "denext-sqlite-cache-evict-" });
  return sqliteCacheStore({
    path: `${dir}/cache.db`,
    maxDataEntries,
    maxPageEntries,
    sweepIntervalMs: 0, // sweep on every write so hard-expiry reclaim is deterministic
  });
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

Deno.test("data: set then get returns a structurally-equal entry", () => {
  const store = freshStore();
  const entry = dataEntry({ hello: "world", n: 42 }, ["t1"]);
  store.setData("k1", entry);
  assertEquals(store.getData("k1"), entry);
});

Deno.test("data: unknown key is a miss", () => {
  const store = freshStore();
  assertEquals(store.getData("nope"), undefined);
});

Deno.test("data: expired entry is a miss (and is evicted)", () => {
  const store = freshStore();
  store.setData("k", dataEntry("v", [], past()));
  assertEquals(store.getData("k"), undefined);
  store.setData("k", dataEntry("v2", [], soon()));
  assertEquals((store.getData("k") as DataEntry).value, "v2");
});

Deno.test("data: infinity expiry persists as a hit", () => {
  const store = freshStore();
  store.setData("k", dataEntry("forever"));
  assertEquals((store.getData("k") as DataEntry).expiresAt, Infinity);
});

Deno.test("data: staleAt (stale-while-revalidate point) round-trips", () => {
  const store = freshStore();
  const staleAt = Date.now() + 30_000;
  const entry: DataEntry = { value: "v", expiresAt: Date.now() + 60_000, staleAt, tags: [] };
  store.setData("k", entry);
  const got = store.getData("k") as DataEntry;
  assertEquals(got.staleAt, staleAt);
  assertEquals(got.value, "v");
});

Deno.test("data: an entry written with no staleAt reads back with none (never stale)", () => {
  const store = freshStore();
  store.setData("k", dataEntry("v", [], Date.now() + 60_000));
  const got = store.getData("k") as DataEntry;
  assertEquals(got.value, "v");
  assertEquals("staleAt" in got, false);
});

Deno.test("expireByTag soft-expires (SWR) data + pages in place, not delete", () => {
  const store = freshStore();
  store.setData("d1", dataEntry("keep", ["t"]));
  store.setData("d2", dataEntry("untagged", ["other"]));
  store.setPage("p1", page("<html>", "/a", ["t"]));

  const staleAt = Date.now();
  const expiresAt = Date.now() + 60_000;
  store.expireByTag!("t", { staleAt, expiresAt });

  // Tagged entries are STILL PRESENT (served stale), with rewritten timing.
  const d1 = store.getData("d1") as DataEntry;
  assertEquals(d1.value, "keep");
  assertEquals(d1.staleAt, staleAt);
  assertEquals(d1.expiresAt, expiresAt);
  const p1 = store.getPage("p1") as CachedPage;
  assertEquals(p1.body, "<html>");
  assertEquals(p1.staleAt, staleAt);
  assertEquals(p1.expiresAt, expiresAt);

  // An entry with a different tag is untouched.
  const d2 = store.getData("d2") as DataEntry;
  assertEquals(d2.expiresAt, Infinity);
  assertEquals("staleAt" in d2, false);
});

Deno.test("migration: a pre-SWR data table (no stale_at) is upgraded in place", () => {
  const dir = Deno.makeTempDirSync({ prefix: "denext-sqlite-migrate-" });
  const path = `${dir}/cache.db`;
  // Seed an OLD-schema data table (the columns before stale_at existed).
  const raw = new DatabaseSync(path);
  raw.exec(
    "CREATE TABLE data (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL, tags TEXT NOT NULL)",
  );
  raw.prepare("INSERT INTO data (key, value, expires_at, tags) VALUES (?, ?, ?, ?)")
    .run("old", '"v"', null, "[]");
  raw.close();

  // Opening the store runs `ALTER TABLE data ADD COLUMN stale_at` — the old row still
  // reads (never stale), and a new entry can persist its staleAt.
  const store = sqliteCacheStore({ path });
  assertEquals((store.getData("old") as DataEntry).value, "v");
  const staleAt = Date.now() + 30_000;
  store.setData("new", { value: "n", expiresAt: Infinity, staleAt, tags: [] });
  assertEquals((store.getData("new") as DataEntry).staleAt, staleAt);
});

Deno.test("pages: set/get and deleteByPath removes only the matching path", () => {
  const store = freshStore();
  store.setPage("a", page("<a>", "/a"));
  store.setPage("b", page("<b>", "/b"));

  assertEquals((store.getPage("a") as CachedPage).body, "<a>");

  store.deleteByPath("/a");
  assertEquals(store.getPage("a"), undefined);
  assertEquals((store.getPage("b") as CachedPage).body, "<b>"); // untouched
});

Deno.test("pages: a PPR shell round-trips its hole/flight extras", () => {
  const store = freshStore();
  const shell: CachedPage = {
    body: "<shell>",
    status: 200,
    path: "/ppr",
    expiresAt: Infinity,
    tags: ["t"],
    holeIds: ["h0", "h1"],
    headExtras: "<meta>",
    inTreeTitle: "Title",
    flightSignalState: { "0.1": 42 },
    flightShell: { $: "$", r: "h0" } as unknown as CachedPage["flightShell"],
  };
  store.setPage("ppr", shell);
  const got = store.getPage("ppr") as CachedPage;
  assertEquals(got.holeIds, ["h0", "h1"]);
  assertEquals(got.headExtras, "<meta>");
  assertEquals(got.inTreeTitle, "Title");
  assertEquals(got.flightSignalState, { "0.1": 42 });
  assertEquals(got.flightShell, { $: "$", r: "h0" } as unknown);

  // A plain (non-PPR) page carries no extras.
  store.setPage("plain", page("<p>", "/plain"));
  assertEquals("holeIds" in (store.getPage("plain") as CachedPage), false);
});

Deno.test("deleteByTag purges both data and page namespaces, leaves untagged", () => {
  const store = freshStore();
  store.setData("d1", dataEntry("v1", ["shared"]));
  store.setData("d2", dataEntry("v2", ["other"]));
  store.setPage("p1", page("<p1>", "/p1", ["shared"]));
  store.setPage("p2", page("<p2>", "/p2", ["other"]));

  store.deleteByTag("shared");

  assertEquals(store.getData("d1"), undefined); // tagged -> gone
  assertEquals(store.getPage("p1"), undefined); // tagged -> gone
  assertEquals((store.getData("d2") as DataEntry).value, "v2"); // untagged -> kept
  assertEquals((store.getPage("p2") as CachedPage).body, "<p2>"); // untagged -> kept
});

Deno.test("retagging: a removed tag no longer invalidates the entry", () => {
  const store = freshStore();
  store.setData("k", dataEntry("v", ["old"]));
  store.setData("k", dataEntry("v", ["new"])); // rewrite with a different tag set

  store.deleteByTag("old"); // stale tag must not purge the entry
  assertEquals((store.getData("k") as DataEntry).value, "v");

  store.deleteByTag("new"); // current tag does
  assertEquals(store.getData("k"), undefined);
});

Deno.test("data: FIFO eviction drops the oldest-inserted rows past maxDataEntries", () => {
  const store = cappedStore(3, 3);
  for (let i = 0; i < 5; i++) store.setData(`k${i}`, dataEntry({ i }, [`t${i}`]));
  // Cap 3: the two oldest (k0, k1) are evicted; the three newest remain.
  assertEquals(store.getData("k0"), undefined);
  assertEquals(store.getData("k1"), undefined);
  assertEquals((store.getData("k2") as DataEntry).value, { i: 2 });
  assertEquals((store.getData("k4") as DataEntry).value, { i: 4 });

  // The cap holds on further writes: k5 in, k2 (now oldest) out.
  store.setData("k5", dataEntry({ i: 5 }, ["t5"]));
  assertEquals(store.getData("k2"), undefined);
  assertEquals((store.getData("k3") as DataEntry).value, { i: 3 });
  assertEquals((store.getData("k5") as DataEntry).value, { i: 5 });
});

Deno.test("pages: FIFO eviction drops the oldest-inserted rows past maxPageEntries", () => {
  const store = cappedStore(3, 2);
  for (let i = 0; i < 4; i++) store.setPage(`p${i}`, page(`body${i}`, `/p${i}`, [`pt${i}`]));
  // Cap 2: p0, p1 evicted; p2, p3 remain.
  assertEquals(store.getPage("p0"), undefined);
  assertEquals(store.getPage("p1"), undefined);
  assertEquals((store.getPage("p2") as CachedPage).body, "body2");
  assertEquals((store.getPage("p3") as CachedPage).body, "body3");
});

Deno.test("sweep: hard-expired rows are reclaimed on write", () => {
  const store = cappedStore(1000, 1000); // caps high so only the sweep acts
  store.setData("stale", dataEntry({ v: 1 }, ["s"], past())); // already expired
  store.setData("fresh", dataEntry({ v: 2 }, ["s"], soon())); // triggers the sweep
  assertEquals(store.getData("stale"), undefined);
  assertEquals((store.getData("fresh") as DataEntry).value, { v: 2 });
});

// ---- Failure modes (inject the open hook; no real file backend) --------------

Deno.test("sqlite: a failed open is not memoized — the next access retries (CACHE-M2)", () => {
  let attempts = 0;
  const store = sqliteCacheStore({
    path: ":memory:",
    openDb: () => {
      attempts++;
      if (attempts === 1) throw new Error("database is locked"); // transient
      return { exec: () => {}, query: () => [], close: () => {} };
    },
  });

  assertThrows(() => store.getData("k"), Error, "locked");
  assertEquals(store.getData("k"), undefined); // retried and succeeded
  assertEquals(attempts, 2, "the store re-opened rather than staying permanently disabled");
});

Deno.test("sqlite: a store that can't initialize surfaces the error (caller then serves uncached)", () => {
  const store = sqliteCacheStore({
    path: ":memory:",
    openDb: () => ({
      exec: () => {
        throw new Error("disk I/O error"); // schema creation fails
      },
      query: () => [],
      close: () => {},
    }),
  });
  // The store propagates the error; cache.ts's best-effort wrapper turns this into an
  // uncached read at the call site (covered in production-hardening.test.ts).
  assertThrows(() => store.getPage("k"), Error, "disk I/O");
});
