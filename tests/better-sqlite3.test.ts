// better-sqlite3 compat over node:sqlite: CRUD parity, pluck/raw, pragma, and
// transactions (commit, rollback, nested savepoints).

import { assert, assertEquals, assertThrows } from "@std/assert";
import Database from "../src/compat/better-sqlite3.ts";

function seeded(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
  return db;
}

Deno.test("prepare/run/get/all with positional params", () => {
  const db = seeded();
  const insert = db.prepare("INSERT INTO users(name, age) VALUES(?, ?)");
  const r = insert.run("Ada", 36);
  assertEquals(r.changes, 1);
  assertEquals(r.lastInsertRowid, 1);
  insert.run("Alan", 41);

  assertEquals(db.prepare("SELECT name FROM users WHERE id = ?").get(1), { name: "Ada" });
  assertEquals(db.prepare("SELECT COUNT(*) c FROM users").get(), { c: 2 });
  assertEquals((db.prepare("SELECT name FROM users ORDER BY id").all() as unknown[]).length, 2);
  db.close();
  assertEquals(db.open, false);
});

Deno.test("pluck() and raw() modifiers", () => {
  const db = seeded();
  db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").run("Ada", 36);
  assertEquals(db.prepare("SELECT name FROM users WHERE id=1").pluck().get(), "Ada");
  assertEquals(db.prepare("SELECT name, age FROM users WHERE id=1").raw().get(), ["Ada", 36]);
});

Deno.test("iterate() yields rows", () => {
  const db = seeded();
  const ins = db.prepare("INSERT INTO users(name, age) VALUES(?, ?)");
  ins.run("A", 1);
  ins.run("B", 2);
  const names = [...db.prepare("SELECT name FROM users ORDER BY id").pluck().iterate()];
  assertEquals(names, ["A", "B"]);
});

Deno.test("pragma simple returns a scalar", () => {
  const db = seeded();
  db.pragma("journal_mode = WAL");
  const mode = db.pragma("journal_mode", { simple: true });
  assert(typeof mode === "string");
});

Deno.test("transaction commits on success", () => {
  const db = seeded();
  const insertMany = db.transaction((people: [string, number][]) => {
    const ins = db.prepare("INSERT INTO users(name, age) VALUES(?, ?)");
    for (const [name, age] of people) ins.run(name, age);
    return people.length;
  });
  const n = insertMany([["A", 1], ["B", 2], ["C", 3]]);
  assertEquals(n, 3);
  assertEquals(db.prepare("SELECT COUNT(*) c FROM users").pluck().get(), 3);
  assertEquals(db.inTransaction, false);
});

Deno.test("transaction rolls back on throw", () => {
  const db = seeded();
  db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").run("Seed", 1);
  const bad = db.transaction(() => {
    db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").run("Temp", 2);
    throw new Error("boom");
  });
  assertThrows(() => bad(), Error, "boom");
  // The Temp insert must have been rolled back; only the seed row remains.
  assertEquals(db.prepare("SELECT COUNT(*) c FROM users").pluck().get(), 1);
});

Deno.test("transaction depth stays consistent after rollback (M2)", () => {
  const db = seeded();
  const bad = db.transaction(() => {
    throw new Error("boom");
  });
  assertThrows(() => bad(), Error, "boom");
  assertEquals(db.inTransaction, false, "depth restored to 0 after rollback");
  // A subsequent transaction must still work (depth not corrupted/negative).
  db.transaction(() => {
    db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").run("ok", 1);
  })();
  assertEquals(db.prepare("SELECT COUNT(*) c FROM users").pluck().get(), 1);
});

Deno.test("fileMustExist throws for a missing file (M4)", () => {
  assertThrows(
    () => new Database("/nonexistent/denext-does-not-exist.db", { fileMustExist: true }),
    Error,
    "fileMustExist",
  );
});

Deno.test("nested transactions use savepoints", () => {
  const db = seeded();
  const ins = db.prepare("INSERT INTO users(name, age) VALUES(?, ?)");
  const inner = db.transaction((fail: boolean) => {
    ins.run("inner", 9);
    if (fail) throw new Error("inner boom");
  });
  const outer = db.transaction(() => {
    ins.run("outer", 8);
    try {
      inner(true); // inner savepoint rolls back, outer continues
    } catch {
      // swallowed — outer still commits
    }
  });
  outer();
  // outer row committed; inner row rolled back to savepoint
  assertEquals(db.prepare("SELECT name FROM users ORDER BY id").pluck().all(), ["outer"]);
});
