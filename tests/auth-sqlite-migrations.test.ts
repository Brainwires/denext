// sqliteAuthAdapter's versioned migrations: renames and drops the additive reconcile can't
// make, recorded in `auth_schema_migrations`, applied once, under SQLite's write lock, and
// re-checked inside that lock so a run that lost the race to another process applies nothing.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { sqliteAuthAdapter } from "../src/server/auth/sqlite-adapter.ts";
import {
  dropColumn,
  dropTable,
  MIGRATIONS_TABLE,
  renameColumn,
  renameTable,
  runSchemaMigrations,
  type SqliteSchemaMigration,
} from "../src/server/auth/sqlite-migrations.ts";
import type { SqliteDb, SqlValue } from "../src/server/sqlite-cache.ts";
import { makeTempDirUntilExit } from "./helpers/temp.ts";

function tempDbPath(): string {
  return `${makeTempDirUntilExit("denext-auth-migrations-")}/auth.db`;
}

/** node:sqlite behind the SqliteDb interface (what the adapter drives). */
function open(path: string, busyMs = 5000): SqliteDb & { raw: DatabaseSync } {
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA busy_timeout = ${busyMs}`);
  return {
    raw,
    exec: (sql: string, params?: SqlValue[]) =>
      void (params?.length ? raw.prepare(sql).run(...params) : raw.exec(sql)),
    query: <T>(sql: string, params?: SqlValue[]) => raw.prepare(sql).all(...(params ?? [])) as T[],
    close: () => raw.close(),
  };
}

function columns(db: SqliteDb, table: string): string[] {
  return db.query<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name);
}

function legacyDb(path: string): SqliteDb & { raw: DatabaseSync } {
  const db = open(path);
  db.exec("CREATE TABLE auth_widgets (id TEXT PRIMARY KEY, colour TEXT, legacy TEXT)");
  db.exec("INSERT INTO auth_widgets (id, colour, legacy) VALUES ('w1', 'red', 'x')");
  db.exec("CREATE TABLE auth_old_things (id TEXT)");
  db.exec("CREATE TABLE auth_gone (id TEXT)");
  return db;
}

function counted(calls: number[]): SqliteSchemaMigration[] {
  return [
    {
      version: 1,
      name: "rename colour",
      up(db) {
        calls.push(1);
        renameColumn(db, "auth_widgets", "colour", "color");
      },
    },
    {
      version: 2,
      name: "drop legacy + tables",
      up(db) {
        calls.push(2);
        dropColumn(db, "auth_widgets", "legacy");
        renameTable(db, "auth_old_things", "auth_things");
        dropTable(db, "auth_gone");
      },
    },
  ];
}

Deno.test("migrations: a rename and a drop apply, keep the rows, and are recorded", () => {
  const db = legacyDb(tempDbPath());
  try {
    const calls: number[] = [];
    assertEquals(runSchemaMigrations(db, counted(calls), { now: () => 42 }), [1, 2]);
    assertEquals(columns(db, "auth_widgets"), ["id", "color"]);
    assertEquals(db.query("SELECT id, color FROM auth_widgets"), [{ id: "w1", color: "red" }]);
    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map((r) => r.name);
    assert(tables.includes("auth_things") && !tables.includes("auth_old_things"));
    assert(!tables.includes("auth_gone"));
    assertEquals(
      db.query(`SELECT version, name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`),
      [
        { version: 1, name: "rename colour", applied_at: 42 },
        { version: 2, name: "drop legacy + tables", applied_at: 42 },
      ],
    );
    assertEquals(calls, [1, 2]);
  } finally {
    db.close();
  }
});

Deno.test("migrations: idempotent — a second run (and a second handle) applies nothing", () => {
  const path = tempDbPath();
  const first = legacyDb(path);
  const calls: number[] = [];
  runSchemaMigrations(first, counted(calls));
  assertEquals(runSchemaMigrations(first, counted(calls)), []);
  first.close();
  const second = open(path);
  try {
    assertEquals(runSchemaMigrations(second, counted(calls)), []);
    assertEquals(calls, [1, 2]);
  } finally {
    second.close();
  }
});

Deno.test("migrations: the helpers are no-ops on a fresh database, which is still recorded", () => {
  const db = open(tempDbPath());
  try {
    assertEquals(runSchemaMigrations(db, counted([])), [1, 2]);
    assertEquals(db.query(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`), [{ n: 2 }]);
  } finally {
    db.close();
  }
});

Deno.test("migrations: they run holding SQLite's write lock (another writer is refused meanwhile)", () => {
  const path = tempDbPath();
  const db = legacyDb(path);
  let refused = "";
  try {
    runSchemaMigrations(db, [{
      version: 1,
      name: "probe the lock",
      up() {
        const other = open(path, 0);
        try {
          other.exec("BEGIN IMMEDIATE");
          other.exec("ROLLBACK");
        } catch (error) {
          refused = String(error);
        } finally {
          other.close();
        }
      },
    }]);
    assert(/locked|busy/i.test(refused), `another writer got in: ${refused || "no error"}`);
  } finally {
    db.close();
  }
});

Deno.test("migrations: the applied set is re-read inside the lock (a lost race applies nothing)", () => {
  const path = tempDbPath();
  const db = legacyDb(path);
  // A handle whose FIRST read of the applied versions is stale — what a process sees when
  // another one applies the migrations between its check and its lock.
  let staleReads = 1;
  const racing: SqliteDb = {
    ...db,
    query<T>(sql: string, params?: SqlValue[]): T[] {
      if (sql.startsWith(`SELECT version FROM ${MIGRATIONS_TABLE}`) && staleReads > 0) {
        staleReads--;
        const winner = open(path);
        try {
          runSchemaMigrations(winner, counted([]));
        } finally {
          winner.close();
        }
        return [];
      }
      return db.query<T>(sql, params);
    },
  };
  try {
    const calls: number[] = [];
    assertEquals(runSchemaMigrations(racing, counted(calls)), []);
    assertEquals(calls, []);
  } finally {
    db.close();
  }
});

Deno.test("migrations: a failure rolls the whole batch back, and the next open retries", () => {
  const db = legacyDb(tempDbPath());
  try {
    const failing: SqliteSchemaMigration[] = [
      counted([])[0],
      {
        version: 2,
        name: "boom",
        up() {
          throw new Error("boom");
        },
      },
    ];
    assertThrows(() => runSchemaMigrations(db, failing), Error, "boom");
    assertEquals(columns(db, "auth_widgets"), ["id", "colour", "legacy"]);
    assertEquals(db.query(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`), [{ n: 0 }]);
    assertEquals(runSchemaMigrations(db, counted([])), [1, 2]);
  } finally {
    db.close();
  }
});

Deno.test("migrations: out-of-order or duplicate versions are refused", () => {
  const db = open(":memory:");
  try {
    const up = () => {};
    assertThrows(
      () => runSchemaMigrations(db, [{ version: 2, name: "a", up }, { version: 1, name: "b", up }]),
      Error,
      "strictly increasing",
    );
    assertThrows(
      () => runSchemaMigrations(db, [{ version: 1, name: "a", up }, { version: 1, name: "b", up }]),
      Error,
      "strictly increasing",
    );
  } finally {
    db.close();
  }
});

Deno.test("migrations: renaming onto an existing column is refused, not merged", () => {
  const db = open(":memory:");
  try {
    db.exec("CREATE TABLE auth_t (a TEXT, b TEXT)");
    assertThrows(() => renameColumn(db, "auth_t", "a", "b"), Error, "both columns exist");
  } finally {
    db.close();
  }
});

Deno.test("sqliteAuthAdapter: opening a database creates the migrations table", async () => {
  const path = tempDbPath();
  const adapter = sqliteAuthAdapter({ path });
  try {
    await adapter.createUser({ email: "m@x.test" });
  } finally {
    adapter.close?.();
  }
  const raw = new DatabaseSync(path);
  try {
    const row = raw.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(MIGRATIONS_TABLE);
    assert(row, "auth_schema_migrations is missing");
  } finally {
    raw.close();
  }
});
