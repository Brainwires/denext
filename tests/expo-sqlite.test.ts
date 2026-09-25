// denext/mobile's SQLite (openSqlite) and the expo-sqlite shim over it.
//
// - The SQL helpers (statement splitting, named → positional parameters).
// - The native path, in a faked Capacitor shell whose `CapacitorSQLite` plugin is backed by a
//   real SQLite (node:sqlite) with the plugin's wire shapes: positional `values`, iOS's leading
//   `{ ios_columns }` row, blobs as byte arrays.
// - T3 Code's own expo-sqlite flow (mobile-database.ts) end to end over that plugin.
// - The web path against the real @sqlite.org/sqlite-wasm in a worker (in memory: Deno has no
//   OPFS). The OPFS pool is exercised in a browser by the integration run.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  deleteSqlite,
  openSqlite,
  positionalParams,
  resetSqliteForTesting,
  splitSqlStatements,
} from "../src/mobile/sqlite.ts";
import { resetSqliteWorkerForTesting } from "../src/mobile/sqlite-web.ts";
import { moduleUrl, wasmUrl } from "../src/mobile/sqlite-wasm.ts";
import * as SQLite from "../src/expo/sqlite.ts";
import {
  findSqliteWasm,
  registerSqliteWasmBridge,
  sqliteWasmBridgeSource,
} from "../src/build/sqlite-wasm.ts";
import { join } from "@std/path";
import * as esbuild from "esbuild";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

/** The web engine the web tests load (the official build; Deno resolves its node entry). */
const SQLITE_WASM = "npm:@sqlite.org/sqlite-wasm@3.53.4-build1";

// ---- SQL helpers ---------------------------------------------------------------------------

Deno.test("sqlite: statements split at ; outside quotes, comments and trigger bodies", () => {
  assertEquals(
    splitSqlStatements("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;"),
    ["PRAGMA journal_mode = WAL", "PRAGMA foreign_keys = ON"],
  );
  assertEquals(
    splitSqlStatements(`INSERT INTO t VALUES ('a;b', "c;d"); -- trailing; comment
      /* block ; */ SELECT 1;;`),
    [`INSERT INTO t VALUES ('a;b', "c;d")`, "SELECT 1"],
  );
  assertEquals(
    splitSqlStatements(
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET n = CASE WHEN 1 THEN 2 END; " +
        "DELETE FROM u; END; SELECT 2",
    ),
    [
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET n = CASE WHEN 1 THEN 2 END; " +
      "DELETE FROM u; END",
      "SELECT 2",
    ],
  );
  assertEquals(splitSqlStatements("BEGIN; COMMIT"), ["BEGIN", "COMMIT"]);
  assertEquals(splitSqlStatements("  ;  "), []);
});

Deno.test("sqlite: named parameters take SQLite's numbering (first appearance)", () => {
  assertEquals(
    positionalParams("SELECT * FROM t WHERE a = $a AND b = :b OR a = $a AND c = '$x'", {
      ":b": 2,
      $a: 1,
    }),
    [1, 2],
  );
  assertEquals(positionalParams("SELECT @missing", {}), [null]);
  assertEquals(positionalParams("SELECT ?, ?", [1, "x"]), [1, "x"]);
});

// ---- a fake native plugin over node:sqlite -----------------------------------------------------

interface FakePlugin {
  plugin: Record<string, (...args: Any[]) => Promise<unknown>>;
  calls: Array<[string, Any]>;
  files: Map<string, DatabaseSync>;
}

/** `@capacitor-community/sqlite`'s native plugin, with its wire shapes, over node:sqlite. */
function fakeSqlitePlugin(platform: "ios" | "android"): FakePlugin {
  const files = new Map<string, DatabaseSync>();
  const conns = new Map<string, { db: DatabaseSync | null }>();
  const calls: Array<[string, Any]> = [];
  // The plugin binds `values` by index (sqlite3_bind_*). node:sqlite binds named
  // parameters by name, so a statement with names gets them keyed in SQLite's index order.
  const bind = (statement: string, values: unknown[]) => {
    const vals = values.map((v) => (Array.isArray(v) ? Uint8Array.from(v as number[]) : v));
    const names = [...new Set(statement.match(/[:@$][A-Za-z_]\w*/g) ?? [])];
    if (names.length === 0) return vals as Any[];
    return [Object.fromEntries(names.map((n, i) => [n.slice(1), vals[i]]))] as Any[];
  };
  const out = (v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v);
  const conn = (database: string) => {
    const c = conns.get(database);
    if (!c) throw new Error(`No available connection for ${database}`);
    if (!c.db) throw new Error(`database ${database} not opened`);
    return c.db;
  };
  const record = (name: string, fn: (o: Any) => unknown) => async (o: Any) => {
    calls.push([name, o]);
    return await fn(o);
  };
  const plugin = {
    checkConnectionsConsistency: record("checkConnectionsConsistency", (o) => {
      if (o.dbNames.length === 0) conns.clear();
      return { result: false };
    }),
    createConnection: record("createConnection", (o) => {
      if (conns.has(o.database)) throw new Error(`Connection ${o.database} already exists`);
      conns.set(o.database, { db: null });
    }),
    open: record("open", (o) => {
      const c = conns.get(o.database)!;
      let db = files.get(o.database);
      if (!db) files.set(o.database, db = new DatabaseSync(":memory:"));
      c.db = db;
    }),
    isDBOpen: record("isDBOpen", (o) => ({ result: !!conns.get(o.database)?.db })),
    close: record("close", (o) => {
      conns.get(o.database)!.db = null;
    }),
    closeConnection: record("closeConnection", (o) => {
      conns.delete(o.database);
    }),
    run: record("run", (o) => {
      if (!Array.isArray(o.values)) throw new Error("Run: Must provide an Array of values");
      const res = conn(o.database).prepare(o.statement).run(...bind(o.statement, o.values));
      return { changes: { changes: Number(res.changes), lastId: Number(res.lastInsertRowid) } };
    }),
    query: record("query", (o) => {
      if (!Array.isArray(o.values)) throw new Error("Query: Must provide an Array of values");
      const stmt = conn(o.database).prepare(o.statement);
      const rows = (stmt.all(...bind(o.statement, o.values)) as Record<string, unknown>[]).map((
        row,
      ) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, out(v)])));
      if (platform === "ios" && rows.length > 0) {
        const columns = stmt.columns().map((c: Any) => c.name);
        return { values: [{ ios_columns: columns }, ...rows] };
      }
      return { values: rows };
    }),
    isTransactionActive: record("isTransactionActive", (o) => ({
      result: conn(o.database).isTransaction,
    })),
    deleteDatabase: record("deleteDatabase", (o) => {
      files.delete(o.database);
    }),
  };
  return { plugin, calls, files };
}

/** Run `fn` inside a native shell whose `CapacitorSQLite` is `plugin`. */
async function inShell(
  plugin: Record<string, unknown>,
  platform: string,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = Object.getOwnPropertyDescriptor(g, "Capacitor");
  g.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: { CapacitorSQLite: plugin },
  };
  resetSqliteForTesting();
  try {
    await fn();
  } finally {
    if (saved) Object.defineProperty(g, "Capacitor", saved);
    else delete g.Capacitor;
    resetSqliteForTesting();
  }
}

for (const platform of ["ios", "android"] as const) {
  Deno.test(`sqlite native (${platform}): exec, run, query, blobs, transactions`, async () => {
    const fake = fakeSqlitePlugin(platform);
    await inShell(fake.plugin, platform, async () => {
      const db = await openSqlite("notes.db");
      assertEquals(db.backend, "native");
      // The page's first open resets leftover native connections, then opens fresh.
      assertEquals(fake.calls.slice(0, 4).map(([n]) => n), [
        "checkConnectionsConsistency",
        "createConnection",
        "isDBOpen",
        "open",
      ]);
      assertEquals(fake.calls[1][1].database, "notes", "the plugin appends SQLite.db itself");
      await db.exec(`
        PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
        CREATE TABLE n (id INTEGER PRIMARY KEY, body TEXT, data BLOB, flag INTEGER);
        -- a comment; with a semicolon
        INSERT INTO n (body) VALUES ('semi;colon');
      `);
      const r = await db.run("INSERT INTO n (body, data, flag) VALUES (?, ?, ?)", [
        "two",
        new Uint8Array([1, 2, 3]),
        true,
      ]);
      assertEquals(r, { changes: 1, lastInsertRowId: 2 });
      const rows = await db.query<Any>("SELECT id, body, data, flag FROM n ORDER BY id");
      assertEquals(rows[0], { id: 1, body: "semi;colon", data: null, flag: null });
      assertEquals(rows[1].data, new Uint8Array([1, 2, 3]));
      assertEquals(rows[1].flag, 1);
      const named = await db.query<Any>("SELECT body FROM n WHERE id = $id", { $id: 2 });
      assertEquals(named, [{ body: "two" }]);
      const raw = await db.queryRows("SELECT body, id FROM n WHERE id = 1");
      assertEquals(raw, { columns: ["body", "id"], rows: [["semi;colon", 1]] });
      // Row statements go through `query`, everything else through `run` (never `execute`).
      const statements = fake.calls.filter(([n]) => n === "run" || n === "query")
        .map(([n, o]) => `${n}:${o.statement.split(" ")[0]}`);
      assert(statements.includes("query:PRAGMA"), statements.join());
      assert(statements.includes("run:CREATE"), statements.join());
      await db.exec("BEGIN");
      assert(await db.inTransaction());
      await db.run("DELETE FROM n");
      await db.exec("ROLLBACK");
      assertEquals(await db.inTransaction(), false);
      assertEquals((await db.query("SELECT * FROM n")).length, 2);
      await db.close();
      await assertRejects(() => db.query("SELECT 1"));

      // Reopening in the same page reuses the connection bookkeeping (no second reset).
      const again = await openSqlite("notes.db");
      assertEquals((await again.query("SELECT count(*) AS c FROM n"))[0], { c: 2 });
      assertEquals(fake.calls.filter(([n]) => n === "checkConnectionsConsistency").length, 1);
      await again.close();
      await deleteSqlite("notes.db");
      assertEquals(fake.files.has("notes"), false);
    });
  });
}

Deno.test("sqlite native: a connection the reset missed is reused, not an error", async () => {
  const fake = fakeSqlitePlugin("ios");
  await fake.plugin.createConnection({ database: "a" });
  fake.plugin.checkConnectionsConsistency = () => Promise.resolve({ result: true });
  await inShell(fake.plugin, "ios", async () => {
    const db = await openSqlite("a");
    assertEquals(await db.query("SELECT 7 AS x"), [{ x: 7 }]);
    await db.close();
  });
});

Deno.test("sqlite: names with slashes are refused", async () => {
  await assertRejects(() => openSqlite("../x.db"), TypeError);
  await assertRejects(() => openSqlite(""), TypeError);
  await assertRejects(() => deleteSqlite("a/b"), TypeError);
});

Deno.test("sqlite web: no engine found → an error naming the package", async () => {
  const saved = g.Capacitor;
  delete g.Capacitor;
  try {
    const err = await assertRejects(() => openSqlite("x.db"));
    assert(String((err as Error).message).includes("@sqlite.org/sqlite-wasm"));
  } finally {
    if (saved) g.Capacitor = saved;
  }
});

// ---- the expo-sqlite shim, T3 Code's flow over the native plugin ---------------------------

Deno.test("expo-sqlite: T3 Code's mobile-database flow over the native plugin", async () => {
  const fake = fakeSqlitePlugin("ios");
  await inShell(fake.plugin, "ios", async () => {
    const database = await SQLite.openDatabaseAsync("t3code-client.db");
    await database.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const schema = await database.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
    assertEquals(schema, { user_version: 0 });
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`
        CREATE TABLE IF NOT EXISTS client_cache (
          environment_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (environment_id, kind, cache_key)
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS client_cache_environment_updated
          ON client_cache (environment_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS client_preferences (
          singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    });
    await database.execAsync("PRAGMA user_version = 1;");
    assertEquals(await database.getFirstAsync("PRAGMA user_version"), { user_version: 1 });
    const save = (env: string, key: string, payload: string) =>
      database.runAsync(
        `INSERT INTO client_cache
          (environment_id, kind, cache_key, schema_version, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (environment_id, kind, cache_key) DO UPDATE SET
           schema_version = excluded.schema_version,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        env,
        "shell",
        key,
        1,
        payload,
        Date.now(),
      );
    assertEquals((await save("env-1", "snapshot", "{}")).changes, 1);
    await save("env-1", "snapshot", '{"v":2}');
    await save("env-2", "snapshot", "{}");
    const loaded = await database.getFirstAsync<{ payload: string }>(
      "SELECT payload FROM client_cache WHERE environment_id = ? AND kind = ? AND cache_key = ?",
      "env-1",
      "shell",
      "snapshot",
    );
    assertEquals(loaded?.payload, '{"v":2}');
    const listed = await database.getAllAsync<{ payload: string }>(
      "SELECT payload FROM client_cache WHERE kind = ? ORDER BY updated_at",
      "shell",
    );
    assertEquals(listed.length, 2);
    const summary = await database.getAllAsync(`
      SELECT environment_id AS environmentId, kind, COUNT(*) AS recordCount,
        COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS payloadBytes
      FROM client_cache GROUP BY environment_id, kind ORDER BY environment_id, kind`);
    assertEquals(summary, [
      { environmentId: "env-1", kind: "shell", recordCount: 1, payloadBytes: 7 },
      { environmentId: "env-2", kind: "shell", recordCount: 1, payloadBytes: 2 },
    ]);
    await database.runAsync(
      `INSERT INTO client_preferences (singleton, payload, updated_at) VALUES (1, ?, ?)
       ON CONFLICT (singleton) DO UPDATE SET payload = excluded.payload`,
      '{"baseFontSize":17}',
      5,
    );
    assertEquals(
      await database.getFirstAsync(
        "SELECT payload, updated_at AS updatedAt FROM client_preferences WHERE singleton = 1",
      ),
      { payload: '{"baseFontSize":17}', updatedAt: 5 },
    );
    assertEquals((await database.runAsync("DELETE FROM client_cache")).changes, 2);
    await database.closeAsync();
  });
});

Deno.test("expo-sqlite: params forms, statements, the sql tag, each, transactions", async () => {
  const fake = fakeSqlitePlugin("android");
  await inShell(fake.plugin, "android", async () => {
    const db = await SQLite.openDatabaseAsync("misc.db");
    await db.execAsync("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.runAsync("INSERT INTO t (v) VALUES (?)", ["array"]);
    await db.runAsync("INSERT INTO t (v) VALUES ($v)", { $v: "record" });
    const r = await db.runAsync("INSERT INTO t (v) VALUES (?)", "spread");
    assertEquals(r.lastInsertRowId, 3);
    const stmt = await db.prepareAsync("SELECT v FROM t WHERE id >= ? ORDER BY id");
    const result = await stmt.executeAsync<{ v: string }>(2);
    assertEquals(await result.getFirstAsync(), { v: "record" });
    const seen: string[] = [];
    await result.resetAsync();
    for await (const row of result) seen.push(row.v);
    assertEquals(seen, ["record", "spread"]);
    assertEquals(await stmt.getColumnNamesAsync(), ["v"]);
    const raw = await stmt.executeForRawResultAsync<{ v: string }>(3);
    assertEquals(await raw.getAllAsync(), [["spread"]]);
    await stmt.finalizeAsync();
    await assertRejects(() => stmt.executeAsync(1));
    const insert = await db.prepareAsync("INSERT INTO t (v) VALUES (?)");
    assertEquals((await insert.executeAsync("four")).lastInsertRowId, 4);

    const id = 4;
    assertEquals(await db.sql<{ v: string }>`SELECT v FROM t WHERE id = ${id}`, [{ v: "four" }]);
    assertEquals(await db.sql`SELECT v FROM t WHERE id = ${id}`.values(), [["four"]]);
    assertEquals(await db.sql<{ v: string }>`SELECT v FROM t WHERE id = ${1}`.first(), {
      v: "array",
    });
    const tagged = await db.sql`UPDATE t SET v = ${"x"} WHERE id = ${1}`;
    assertEquals((tagged as SQLite.SQLiteRunResult).changes, 1);
    const each: number[] = [];
    for await (const row of db.getEachAsync<{ id: number }>("SELECT id FROM t ORDER BY id")) {
      each.push(row.id);
    }
    assertEquals(each, [1, 2, 3, 4]);

    await assertRejects(
      () =>
        db.withTransactionAsync(async () => {
          await db.runAsync("DELETE FROM t");
          throw new Error("boom");
        }),
      Error,
      "boom",
    );
    assertEquals((await db.getAllAsync("SELECT id FROM t")).length, 4, "rolled back");
    assertEquals(await db.isInTransactionAsync(), false);

    // An exclusive transaction holds other calls on the database until it ends.
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tx = db.withExclusiveTransactionAsync(async (txn) => {
      order.push("tx-start");
      await gate;
      await txn.runAsync("INSERT INTO t (v) VALUES ('tx')");
      order.push("tx-end");
    });
    const outside = db.getAllAsync("SELECT id FROM t").then((rows) => {
      order.push(`outside:${rows.length}`);
    });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([tx, outside]);
    assertEquals(order, ["tx-start", "tx-end", "outside:5"]);
    await db.closeAsync();
    await SQLite.deleteDatabaseAsync("misc.db");
  });
});

Deno.test("expo-sqlite: the manifest's omitted exports are absent; the sync API is too", () => {
  const mod = SQLite as Record<string, unknown>;
  for (const name of ["openDatabaseSync", "deleteDatabaseSync", "SQLiteSession"]) {
    assertEquals(name in mod, false, name);
  }
  assertEquals("runSync" in SQLite.SQLiteDatabase.prototype, false);
  assertThrows(() => SQLite.useSQLiteContext());
});

// ---- the web path: the real engine in a worker ---------------------------------------------

Deno.test({
  name: "sqlite web: the real @sqlite.org/sqlite-wasm in a worker (in memory without OPFS)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const saved = g.Capacitor;
    delete g.Capacitor;
    const web = { moduleUrl: SQLITE_WASM, wasmUrl: "" };
    try {
      const db = await openSqlite("web.db", { web });
      assertEquals(db.backend, "memory", "Deno has no OPFS: the pool falls back to memory");
      await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, b BLOB, big INTEGER)");
      assertEquals(
        await db.run("INSERT INTO t (v, b, big) VALUES (?, ?, ?)", [
          "a",
          new Uint8Array([9, 8]),
          9007199254740993,
        ]),
        { changes: 1, lastInsertRowId: 1 },
      );
      await db.run("INSERT INTO t (big) VALUES ($v)", { $v: true });
      const rows = await db.query<Any>("SELECT * FROM t ORDER BY id");
      assertEquals(rows[0].v, "a");
      assertEquals(rows[0].b, new Uint8Array([9, 8]));
      assertEquals(typeof rows[0].big, "number", "BigInt → number");
      assertEquals(rows[1].big, 1, "true binds as 1");
      assertEquals((await db.queryRows("SELECT v, id FROM t WHERE id = 1")).columns, ["v", "id"]);
      await db.exec("BEGIN");
      assert(await db.inTransaction());
      await db.exec("ROLLBACK");
      await assertRejects(() => db.query("SELECT * FROM nope"), Error, "no such table");

      // The Expo shim over the same web driver.
      const expo = new SQLite.SQLiteDatabase("web.db", {}, db);
      await expo.withExclusiveTransactionAsync(async (txn) => {
        await txn.execAsync(
          "CREATE TABLE u (x); INSERT INTO u VALUES (1); INSERT INTO u VALUES (2)",
        );
      });
      assertEquals(await expo.getAllAsync("SELECT x FROM u"), [{ x: 1 }, { x: 2 }]);
      assertEquals(await expo.getFirstAsync("PRAGMA user_version"), { user_version: 0 });
      await expo.closeAsync();
      await assertRejects(() => db.query("SELECT 1"), Error, "closed");
      await deleteSqlite("web.db", { web });
    } finally {
      resetSqliteWorkerForTesting();
      if (saved) g.Capacitor = saved;
    }
  },
});

Deno.test("sqlite bridge: the source fallback (no build, or the native deno bundle) has no engine", () => {
  assertEquals([moduleUrl, wasmUrl], [null, null]);
});

Deno.test("sqlite bridge: the generated module exports the engine URLs or nulls", () => {
  assertEquals(
    sqliteWasmBridgeSource(false),
    "export const moduleUrl = null;\nexport const wasmUrl = null;\n",
  );
  const src = sqliteWasmBridgeSource(true);
  assert(src.includes('"denext-sqlite-wasm-asset:dist/index.mjs"'));
  assert(src.includes("new URL(wasmFile, import.meta.url).href"));
});

Deno.test("sqlite bridge: an app build emits the installed engine's files and exports their URLs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_sqlite_bridge_" });
  const out = join(dir, "out");
  try {
    const pkg = join(dir, "node_modules/@sqlite.org/sqlite-wasm");
    await Deno.mkdir(join(pkg, "dist"), { recursive: true });
    await Deno.writeTextFile(join(pkg, "package.json"), '{"name":"@sqlite.org/sqlite-wasm"}');
    await Deno.writeTextFile(join(pkg, "dist/index.mjs"), "export default () => 'ENGINE';\n");
    await Deno.writeFile(join(pkg, "dist/sqlite3.wasm"), new Uint8Array([0, 97, 115, 109]));
    await Deno.writeTextFile(
      join(dir, "entry.js"),
      'export const load = () => import("denext-sqlite-wasm");\n',
    );
    const plugin: esbuild.Plugin = { name: "bridge", setup: registerSqliteWasmBridge };
    await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      splitting: true,
      format: "esm",
      outdir: out,
      absWorkingDir: dir,
      publicPath: "/_denext/client/",
      logLevel: "silent",
      plugins: [plugin],
    });
    const files = [...Deno.readDirSync(out)].map((e) => e.name);
    assert(files.some((f) => /^index-.*\.mjs$/.test(f)), files.join());
    assert(files.some((f) => /^sqlite3-.*\.wasm$/.test(f)), files.join());
    const chunk = files.filter((f) => f.endsWith(".js")).map((f) =>
      Deno.readTextFileSync(join(out, f))
    ).join("\n");
    assert(/"\/_denext\/client\/index-[^"]+\.mjs"/.test(chunk), "the module's public URL");
    assert(/"\/_denext\/client\/sqlite3-[^"]+\.wasm"/.test(chunk), "the wasm's public URL");
    assertEquals(await findSqliteWasm(join(dir, "sub")), await Deno.realPath(pkg));

    // Without the package: the bridge is the null module and the build still succeeds.
    await Deno.remove(join(dir, "node_modules"), { recursive: true });
    await Deno.remove(out, { recursive: true });
    const plugin2: esbuild.Plugin = { name: "bridge", setup: registerSqliteWasmBridge };
    await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      splitting: true,
      format: "esm",
      outdir: out,
      absWorkingDir: dir,
      logLevel: "silent",
      plugins: [plugin2],
    });
    const names = [...Deno.readDirSync(out)].map((e) => e.name);
    assertEquals(names.filter((f) => !f.endsWith(".js")), [], "no engine files emitted");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
