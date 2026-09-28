// denext/mobile's durable key-value store (src/mobile/kv-store.ts): the backing it picks where
// the page runs (the DenextStorage plugin in the shell, @capacitor-community/sqlite, IndexedDB,
// memory), the SQL driver against a real SQLite (node:sqlite), the IndexedDB driver against an
// in-memory fake, and the store API over each.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  idbKvDriver,
  type KvDriver,
  openKeyValueStore,
  resetKeyValueStoreForTesting,
  sqlKvDriver,
} from "../src/mobile/kv-store.ts";
import { type Any, fakePlugin, inShell, withGlobals } from "./helpers/mobile-fakes.ts";
import { fakeIndexedDB } from "./helpers/fake-indexeddb.ts";

/** A SqlRunner over an in-memory node:sqlite database. */
function sqliteRunner() {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (sql: string) => Promise.resolve(void db.exec(sql)),
    run: (sql: string, params: Any) => Promise.resolve(db.prepare(sql).run(...params)),
    rows: (sql: string, params: Any) => {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...params) as Record<string, unknown>[];
      const columns = stmt.columns().map((c) => c.name);
      return Promise.resolve({ columns, rows: rows.map((r) => columns.map((c) => r[c])) as Any });
    },
  };
}

/** The driver contract every backing keeps. */
async function checkDriver(driver: KvDriver): Promise<void> {
  await driver.setMany("a", [["x", "1"], ["y", "2"], ["z", "3"]]);
  await driver.setMany("b", [["x", "other"]]);
  assertEquals(await driver.getMany("a", ["y", "missing", "x"]), ["2", null, "1"]);
  assertEquals(await driver.keys("a"), ["x", "y", "z"]);
  await driver.setMany("a", [["x", "1b"]]);
  assertEquals(await driver.getMany("a", ["x"]), ["1b"]);
  await driver.removeMany("a", ["y", "never"]);
  assertEquals(await driver.keys("a"), ["x", "z"]);
  await driver.clear("a");
  assertEquals(await driver.keys("a"), []);
  assertEquals(await driver.getMany("b", ["x"]), ["other"], "clear leaves other stores");
}

Deno.test("kv-store: the SQL driver keeps the contract on a real SQLite, in chunks", async () => {
  const driver = await sqlKvDriver(sqliteRunner(), "desktop");
  assertEquals(driver.kind, "desktop");
  await checkDriver(driver);
  const many = Array.from({ length: 450 }, (_, i): [string, string] => [`k${i}`, `v${i}`]);
  await driver.setMany("big", many);
  const values = await driver.getMany("big", many.map(([k]) => k));
  assertEquals(values, many.map(([, v]) => v));
  await driver.removeMany("big", many.map(([k]) => k));
  assertEquals(await driver.keys("big"), []);
});

Deno.test("kv-store: the IndexedDB driver keeps the contract", async () => {
  const fake = fakeIndexedDB();
  const driver = await idbKvDriver(fake.indexedDB, fake.IDBKeyRange);
  assertEquals(driver.kind, "indexeddb");
  await checkDriver(driver);
});

Deno.test("kv-store: in the shell the DenextStorage plugin backs every store", async () => {
  resetKeyValueStoreForTesting();
  const data = new Map<string, string>();
  const storage = fakePlugin(["getMany", "setMany", "removeMany", "keys", "clear"]);
  storage.plugin.getMany = (o: Any) =>
    Promise.resolve({ values: o.keys.map((k: string) => data.get(`${o.store}/${k}`) ?? null) });
  storage.plugin.setMany = (o: Any) => {
    for (const [k, v] of o.entries) data.set(`${o.store}/${k}`, v);
    return Promise.resolve({});
  };
  storage.plugin.keys = (o: Any) =>
    Promise.resolve({
      keys: [...data.keys()].filter((k) => k.startsWith(`${o.store}/`)).map((k) =>
        k.slice(o.store.length + 1)
      ),
    });
  await inShell("ios", { DenextStorage: storage.plugin }, async () => {
    const prefs = openKeyValueStore("prefs");
    assertEquals(await prefs.backend(), "native");
    await prefs.setMany([["theme", "dark"], ["font", "serif"]]);
    assertEquals(await prefs.getMany(["font", "nope"]), ["serif", null]);
    assertEquals(await prefs.get("theme"), "dark");
    assertEquals(await prefs.entries(), [["theme", "dark"], ["font", "serif"]]);
    assertEquals(await openKeyValueStore("other").keys(), []);
  });
  resetKeyValueStoreForTesting();
});

Deno.test("kv-store: a shell without a durable plugin warns once and uses IndexedDB", async () => {
  resetKeyValueStoreForTesting();
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const fake = fakeIndexedDB();
    await inShell("android", {}, async () => {
      const store = openKeyValueStore();
      assertEquals(await store.backend(), "indexeddb");
      await store.set("a", "1");
      assertEquals(await store.get("a"), "1");
      await openKeyValueStore("x").keys();
    }, fake);
  } finally {
    console.warn = warn;
    resetKeyValueStoreForTesting();
  }
  assertEquals(warnings.length, 1);
  assert(String(warnings[0]).includes("denext mobile add storage"));
});

Deno.test("kv-store: without IndexedDB (SSR, tests) the store is in memory", async () => {
  resetKeyValueStoreForTesting();
  await withGlobals({ indexedDB: undefined }, async () => {
    const store = openKeyValueStore("m");
    assertEquals(await store.backend(), "memory");
    await store.setMany([["b", "2"], ["a", "1"]]);
    assertEquals(await store.keys(), ["a", "b"]);
    await store.remove("a");
    assertEquals(await store.entries(), [["b", "2"]]);
    await store.clear();
    assertEquals(await store.keys(), []);
  });
  resetKeyValueStoreForTesting();
});

Deno.test("kv-store: keys and values must be strings; the name must not be empty", async () => {
  assertThrows(() => openKeyValueStore(""), TypeError, "non-empty");
  resetKeyValueStoreForTesting();
  const store = openKeyValueStore("v");
  await assertRejects(() => store.set("k", 1 as unknown as string), TypeError, "must be a string");
  await assertRejects(() => store.get(2 as unknown as string), TypeError, "key must be a string");
  resetKeyValueStoreForTesting();
});
