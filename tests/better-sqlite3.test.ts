// better-sqlite3 compat over node:sqlite: CRUD parity, pluck/raw, pragma, and
// transactions (commit, rollback, nested savepoints).

import { assert, assertEquals, assertThrows } from "@std/assert";
import Database, { Statement } from "../src/compat/better-sqlite3.ts";

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

// The surface Prisma's better-sqlite3 driver adapter drives: prepare(sql).bind(args)
// then reader/columns()/raw().all()/run() — see the DATABASE.md "Prisma" recipe.
Deno.test("bind() pre-binds params; reader/columns() describe the result", () => {
  const db = seeded();
  db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").bind(["Ada", 36]).run();
  db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").bind(["Alan", 41]).run();

  // A SELECT is a reader and reports its columns; the adapter uses this to decide
  // whether to fetch rows and what column metadata to hand Prisma.
  const sel = db.prepare("SELECT id, name FROM users WHERE age > ?").bind([30]);
  assertEquals(sel.reader, true);
  assertEquals(sel.columns().map((c) => c.name), ["id", "name"]);
  assertEquals(sel.columns()[1].table, "users");
  // raw().all() over the pre-bound params, as the adapter reads result sets.
  assertEquals(sel.raw().all(), [[1, "Ada"], [2, "Alan"]]);

  // A write is not a reader and exposes no columns.
  const ins = db.prepare("INSERT INTO users(name, age) VALUES(?, ?)");
  assertEquals(ins.reader, false);
  assertEquals(ins.columns(), []);
});

Deno.test("bind() can only be invoked once", () => {
  const db = seeded();
  const stmt = db.prepare("SELECT ?").bind([1]);
  assertThrows(() => stmt.bind([2]), TypeError);
});

Deno.test("defaultSafeIntegers/safeIntegers read integers as BigInt", () => {
  const db = seeded();
  db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").run("Ada", 36);
  // Per-statement opt-in.
  assertEquals(db.prepare("SELECT age FROM users WHERE id=1").pluck().safeIntegers().get(), 36n);
  // Database-wide default applies to statements prepared afterwards.
  db.defaultSafeIntegers(true);
  assertEquals(db.prepare("SELECT age FROM users WHERE id=1").pluck().get(), 36n);
  db.defaultSafeIntegers(false);
  assertEquals(db.prepare("SELECT age FROM users WHERE id=1").pluck().get(), 36);
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

Deno.test("named-object parameters bind by @name / $name / :name", () => {
  const db = seeded();
  db.prepare("INSERT INTO users(name, age) VALUES(@n, $a) ").run({ n: "Ada", a: 36 });
  assertEquals(db.prepare("SELECT name FROM users WHERE id = :id").pluck().get({ id: 1 }), "Ada");
  assertEquals(db.prepare("SELECT age FROM users WHERE name = @n").pluck().get({ n: "Ada" }), 36);
});

Deno.test("get()/all() reuse pre-bound params when called with no args", () => {
  const db = seeded();
  const ins = db.prepare("INSERT INTO users(name, age) VALUES(?, ?)");
  ins.run("Ada", 36);
  ins.run("Alan", 41);
  const one = db.prepare("SELECT name FROM users WHERE id = ?").bind([1]);
  assertEquals(one.get(), { name: "Ada" }, "get() with no args uses the bound param");
  const adults = db.prepare("SELECT name FROM users WHERE age >= ? ORDER BY id").pluck().bind([40]);
  assertEquals(adults.all(), ["Alan"], "all() with no args uses the bound param");
});

Deno.test("bind() accepts varargs as well as a single array", () => {
  const db = seeded();
  assertEquals(db.prepare("SELECT ? a, ? b").bind(1, 2).get(), { a: 1, b: 2 }, "varargs");
  assertEquals(db.prepare("SELECT ? a, ? b").bind([3, 4]).get(), { a: 3, b: 4 }, "single array");
});

Deno.test("db.function registers a scalar UDF callable from SQL", () => {
  const db = seeded();
  db.function("timestwo", (n: unknown) => (n as number) * 2);
  assertEquals(db.prepare("SELECT timestwo(21) v").pluck().get(), 42);
});

Deno.test("pragma without simple returns full result rows", () => {
  const db = seeded();
  const info = db.pragma("table_info(users)") as Array<Record<string, unknown>>;
  assert(Array.isArray(info), "non-simple pragma returns an array of rows");
  assertEquals(info.map((c) => c.name), ["id", "name", "age"]);
});

Deno.test("a read-only database rejects writes and reports readonly=true", () => {
  const file = Deno.makeTempFileSync({ suffix: ".db" });
  try {
    const w = new Database(file);
    w.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    w.prepare("INSERT INTO t(v) VALUES(?)").run("seed");
    w.close();

    const ro = new Database(file, { readonly: true });
    assertEquals(ro.readonly, true);
    assertEquals(
      ro.prepare("SELECT v FROM t WHERE id=1").pluck().get(),
      "seed",
      "reads still work",
    );
    assertThrows(() => ro.prepare("INSERT INTO t(v) VALUES(?)").run("nope"), Error);
    ro.close();
  } finally {
    Deno.removeSync(file);
  }
});

Deno.test("expand() groups a row's columns under its source table", () => {
  const db = seeded();
  db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").run("Ada", 36);
  const stmt = db.prepare("SELECT name, age FROM users WHERE id=1");
  assertEquals(stmt.expand(), stmt, "expand() returns this for chaining");
  assertEquals(stmt.get(), { users: { name: "Ada", age: 36 } });
});

Deno.test("verbose logger is invoked with each executed SQL string", () => {
  const logs: string[] = [];
  const db = new Database(":memory:", { verbose: (m) => logs.push(String(m)) });
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)");
  db.prepare("SELECT * FROM t");
  assert(logs.some((s) => s.includes("CREATE TABLE t")), "exec() is logged");
  assert(logs.some((s) => s.includes("SELECT * FROM t")), "prepare() is logged");
});

Deno.test("safeIntegers round-trips an integer beyond Number.MAX_SAFE_INTEGER losslessly", () => {
  const db = seeded();
  const big = 9007199254740993n; // 2^53 + 1 — not representable as a JS number
  db.prepare("INSERT INTO users(id, name, age) VALUES(?, ?, ?)").run(big, "big", 1);
  assertEquals(
    db.prepare("SELECT id FROM users WHERE name='big'").pluck().safeIntegers().get(),
    big,
    "the value survives as a BigInt with no precision loss",
  );
});

Deno.test("inTransaction is true inside the transaction and false after", () => {
  const db = seeded();
  let insideDepth = false;
  db.transaction(() => {
    insideDepth = db.inTransaction;
    db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").run("x", 1);
  })();
  assertEquals(insideDepth, true, "inTransaction reports true mid-transaction");
  assertEquals(db.inTransaction, false, "and false once the transaction commits");
});

Deno.test("transaction mode variants (deferred/immediate/exclusive) each commit", () => {
  const db = seeded();
  const ins = (name: string) =>
    db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").run(name, 1);
  db.transaction(() => ins("d")).deferred();
  db.transaction(() => ins("i")).immediate();
  db.transaction(() => ins("e")).exclusive();
  assertEquals(db.prepare("SELECT name FROM users ORDER BY id").pluck().all(), ["d", "i", "e"]);
  assertEquals(db.inTransaction, false);
});

Deno.test("iterate() falls back to all() when the underlying stmt lacks iterate", () => {
  // A minimal StatementSync-like object without an iterate() method exercises the
  // compat's all()-based fallback path.
  const fake = {
    all: () => [{ n: 1 }, { n: 2 }],
    get: () => undefined,
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    columns: () => [],
    // deno-lint-ignore no-explicit-any
  } as any;
  const stmt = new Statement(fake, "SELECT n FROM t");
  assertEquals([...stmt.pluck().iterate()], [1, 2], "yields rows via the all() fallback");
});

Deno.test("using a statement after close() throws (no silent use-after-free)", () => {
  const db = seeded();
  db.close();
  assertEquals(db.open, false);
  assertThrows(() => db.prepare("SELECT 1"), Error);
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

// ---- aggregate / backup / serialize / expand / loadExtension ---------------

Deno.test("aggregate() registers a custom aggregate function", () => {
  const db = seeded();
  const ins = db.prepare("INSERT INTO users(name, age) VALUES(?, ?)");
  ins.run("Ada", 36);
  ins.run("Alan", 41);
  db.aggregate("sumage", {
    start: 0,
    step: (acc: unknown, age: unknown) => (acc as number) + (age as number),
  });
  assertEquals(db.prepare("SELECT sumage(age) t FROM users").pluck().get(), 77);
  db.close();
});

Deno.test("backup() writes a restorable copy via VACUUM INTO", async () => {
  const db = seeded();
  db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").run("Ada", 36);
  const out = Deno.makeTempFileSync({ suffix: ".db" });
  Deno.removeSync(out);
  const info = await db.backup(out);
  assert(info.totalPages > 0, "reports a page count");
  assertEquals(info.remainingPages, 0);
  db.close();
  // Reopen the backup and confirm the row is present.
  const restored = new Database(out);
  assertEquals(restored.prepare("SELECT name FROM users").pluck().get(), "Ada");
  restored.close();
  Deno.removeSync(out);
});

Deno.test("serialize() returns a byte buffer that reopens as a DB", () => {
  const db = seeded();
  db.prepare("INSERT INTO users(name, age) VALUES(?, ?)").run("Ada", 36);
  const bytes = db.serialize();
  assert(bytes instanceof Uint8Array && bytes.length > 0, "serialized bytes");
  // The SQLite file header magic string.
  assertEquals(new TextDecoder().decode(bytes.subarray(0, 15)), "SQLite format 3");
  db.close();
});

Deno.test("expand() groups JOIN columns by source table", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE a(id INTEGER PRIMARY KEY, v TEXT)");
  db.exec("CREATE TABLE b(id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO a(v) VALUES('av')").run();
  db.prepare("INSERT INTO b(v) VALUES('bv')").run();
  const row = db.prepare(
    "SELECT a.id, a.v, b.id, b.v FROM a JOIN b ON a.id = b.id",
  ).expand().get() as Record<string, Record<string, unknown>>;
  assertEquals(row.a, { id: 1, v: "av" });
  assertEquals(row.b, { id: 1, v: "bv" });
  db.close();
});

Deno.test("loadExtension() throws clearly unless allowExtension was set", () => {
  const db = new Database(":memory:");
  assertThrows(() => db.loadExtension("/nonexistent.so"), Error);
  db.close();
});
