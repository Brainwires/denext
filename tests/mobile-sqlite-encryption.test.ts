// SQLCipher through denext/mobile's openSqlite (and so the expo-sqlite shim): `encryptionKey`, or
// `PRAGMA key = '…'` as the first statement, keys the database in the shell through
// @capacitor-community/sqlite; the web engine (the real @sqlite.org/sqlite-wasm here) refuses
// rather than run the pragma as the no-op it is there and leave the data unencrypted.
//
// The native plugin is faked over node:sqlite with what matters here: one stored passphrase for
// the app, a file that is encrypted (or not), an encrypted file that does not open without its
// passphrase, `encryption` mode encrypting a plain file in place, and the secret calls closing
// every connection.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { openSqlite, resetSqliteForTesting, SqliteEncryptionError } from "../src/mobile/sqlite.ts";
import { resetSqliteWorkerForTesting } from "../src/mobile/sqlite-web.ts";
import * as SQLite from "../src/expo/sqlite.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

const SQLITE_WASM = "npm:@sqlite.org/sqlite-wasm@3.53.4-build1";

interface FakeFile {
  db: DatabaseSync;
  /** The passphrase it is encrypted with (null: plain). */
  key: string | null;
}

/** @capacitor-community/sqlite with encryption, over node:sqlite. */
function cipherPlugin(options: { encryptionOff?: boolean; failRekey?: boolean } = {}) {
  const files = new Map<string, FakeFile>();
  const conns = new Map<string, { mode: string; open: boolean }>();
  const calls: Array<[string, Any]> = [];
  let secret: string | null = null;
  const off = () => {
    if (options.encryptionOff) throw new Error("No Encryption set in capacitor.config");
  };
  const record = (name: string, fn: (o: Any) => unknown) => async (o: Any) => {
    calls.push([name, o]);
    return await fn(o);
  };
  const db = (database: string) => {
    const c = conns.get(database);
    if (!c?.open) throw new Error(`Connection to ${database} not available`);
    return files.get(database)!.db;
  };
  const plugin = {
    checkConnectionsConsistency: record("checkConnectionsConsistency", () => {
      conns.clear();
      return { result: false };
    }),
    createConnection: record("createConnection", (o) => {
      if (o.encrypted) off();
      if (conns.has(o.database)) throw new Error(`Connection ${o.database} already exists`);
      conns.set(o.database, { mode: o.mode, open: false });
    }),
    open: record("open", (o) => {
      const c = conns.get(o.database)!;
      const file = files.get(o.database);
      const key = c.mode === "no-encryption" ? null : secret;
      if (!file) {
        files.set(o.database, { db: new DatabaseSync(":memory:"), key });
      } else if (c.mode === "encryption" && file.key === null) {
        file.key = key; // encrypted in place
      } else if (file.key !== key) {
        throw new Error("Open: file is not a database");
      }
      c.open = true;
    }),
    isDBOpen: record("isDBOpen", (o) => ({ result: conns.get(o.database)?.open === true })),
    close: record("close", (o) => {
      const c = conns.get(o.database);
      if (c) c.open = false;
    }),
    closeConnection: record("closeConnection", (o) => {
      if (!conns.delete(o.database)) throw new Error(`No available connection for ${o.database}`);
    }),
    run: record("run", (o) => {
      const res = db(o.database).prepare(o.statement).run(...o.values);
      return { changes: { changes: Number(res.changes), lastId: Number(res.lastInsertRowid) } };
    }),
    query: record("query", (o) => ({
      values: db(o.database).prepare(o.statement).all(...o.values),
    })),
    isTransactionActive: record("isTransactionActive", (o) => ({
      result: db(o.database).isTransaction,
    })),
    deleteDatabase: record("deleteDatabase", (o) => void files.delete(o.database)),
    isSecretStored: record("isSecretStored", () => {
      off();
      return { result: secret !== null };
    }),
    setEncryptionSecret: record("setEncryptionSecret", (o) => {
      off();
      conns.clear(); // the plugin closes every connection
      secret = o.passphrase;
    }),
    checkEncryptionSecret: record("checkEncryptionSecret", (o) => {
      off();
      conns.clear();
      return { result: o.passphrase === secret };
    }),
    // Re-encrypts every encrypted file under the new passphrase, then stores it (as the plugin
    // does: UtilsSecret.changeEncryptionSecret), closing every connection first.
    changeEncryptionSecret: record("changeEncryptionSecret", (o) => {
      off();
      if (o.oldpassphrase !== secret) {
        throw new Error("changeEncryptionSecret: wrong old passphrase");
      }
      conns.clear();
      if (options.failRekey) throw new Error("changeEncryptionSecret: disk full");
      for (const file of files.values()) if (file.key !== null) file.key = o.passphrase;
      secret = o.passphrase;
    }),
    isDatabaseEncrypted: record("isDatabaseEncrypted", (o) => {
      const file = files.get(o.database);
      if (!file) throw new Error("Database does not exist");
      return { result: file.key !== null };
    }),
  };
  return { plugin, calls, files, secret: () => secret };
}

/** Run `fn` in a native shell whose CapacitorSQLite is `plugin`. */
async function inShell(plugin: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.getOwnPropertyDescriptor(g, "Capacitor");
  g.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
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

Deno.test({
  name: "sqlite encryption (web): PRAGMA key and encryptionKey are refused; nothing runs",
  async fn() {
    const saved = g.Capacitor;
    delete g.Capacitor;
    const web = { moduleUrl: SQLITE_WASM, wasmUrl: "" };
    try {
      const err = await assertRejects(
        () => openSqlite("vault.db", { encryptionKey: "pw" }),
        SqliteEncryptionError,
        "sqlite-wasm",
      );
      assertEquals((err as SqliteEncryptionError).code, "ENCRYPTION_UNAVAILABLE");

      const db = await openSqlite("web-key.db", { web });
      const refused = await assertRejects(
        () => db.exec("PRAGMA key = 'pw'; CREATE TABLE secrets (v TEXT)"),
        Error,
        "would stay unencrypted",
      );
      assertEquals((refused as SqliteEncryptionError).code, "ENCRYPTION_UNAVAILABLE");
      assertEquals(
        await db.query("SELECT name FROM sqlite_master WHERE name = 'secrets'"),
        [],
        "nothing after the pragma ran",
      );
      // The Expo shim's statements reach the same refusal.
      const expo = new SQLite.SQLiteDatabase("web-key.db", {}, db);
      await assertRejects(() => expo.execAsync("PRAGMA key = 'pw'"), SqliteEncryptionError);
      await assertRejects(() => expo.runAsync("PRAGMA key = 'pw'"), SqliteEncryptionError);
      await assertRejects(() => expo.getFirstAsync("pragma KEY='pw'"), SqliteEncryptionError);
      // A quoted pragma name is still the key pragma: refused, never run on the plain driver.
      for (const sql of [`PRAGMA "key" = 'pw'`, "PRAGMA [key] = 'pw'", "PRAGMA 'key' = 'pw'"]) {
        await assertRejects(() => db.exec(sql), SqliteEncryptionError, "", sql);
      }
      // A statement that only mentions a key is not a key pragma.
      await db.exec("CREATE TABLE kv (key TEXT); PRAGMA user_version = 3");
      assertEquals(await expo.getFirstAsync("PRAGMA user_version"), { user_version: 3 });
      // No SQLCipher, so no rekey either.
      const rekey = await assertRejects(() => db.rekey("pw"), SqliteEncryptionError);
      assertEquals((rekey as SqliteEncryptionError).code, "ENCRYPTION_UNAVAILABLE");
      await assertRejects(() => db.exec("PRAGMA rekey = 'pw'"), SqliteEncryptionError);
      await db.close();
    } finally {
      resetSqliteWorkerForTesting();
      if (saved) g.Capacitor = saved;
    }
  },
});

Deno.test("sqlite encryption (native): encryptionKey opens a new database encrypted", async () => {
  const fake = cipherPlugin();
  await inShell(fake.plugin, async () => {
    const db = await openSqlite("vault.db", { encryptionKey: "pw" });
    await db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('secret')");
    assertEquals(await db.query("SELECT v FROM t"), [{ v: "secret" }]);
  });
  assertEquals(fake.secret(), "pw");
  assertEquals(fake.files.get("vault")!.key, "pw");
  const created = fake.calls.filter(([n]) => n === "createConnection").map(([, o]) => o);
  assertEquals(created.map((o) => [o.encrypted, o.mode]), [[true, "secret"]]);
});

Deno.test("sqlite encryption (native): expo-sqlite's PRAGMA key encrypts a plain database in place", async () => {
  const fake = cipherPlugin();
  await inShell(fake.plugin, async () => {
    const db = await SQLite.openDatabaseAsync("app.db");
    await db.execAsync("PRAGMA key = 'it''s'; CREATE TABLE t (v TEXT)");
    await db.runAsync("INSERT INTO t VALUES (?)", "x");
    assertEquals(await db.getAllAsync("SELECT v FROM t"), [{ v: "x" }]);
    // A key pragma read as a query answers no rows.
    assertEquals(await db.getFirstAsync("PRAGMA key = 'it''s'"), null);
    assertEquals(await db.runAsync("PRAGMA key = 'it''s'"), { changes: 0, lastInsertRowId: 0 });
  });
  assertEquals(fake.secret(), "it's", "the quoted passphrase, doubled quotes undone");
  assertEquals(fake.files.get("app")!.key, "it's");
  const modes = fake.calls.filter(([n]) => n === "createConnection").map(([, o]) => o.mode);
  assertEquals(modes.slice(0, 2), ["no-encryption", "encryption"]);
});

Deno.test("sqlite encryption (native): an encrypted file waits for its key, then opens", async () => {
  const fake = cipherPlugin();
  await inShell(fake.plugin, async () => {
    const first = await openSqlite("locked.db", { encryptionKey: "pw" });
    await first.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a')");
    await first.close();
  });
  await inShell(fake.plugin, async () => {
    const db = await openSqlite("locked.db");
    const err = await assertRejects(() => db.query("SELECT v FROM t"), SqliteEncryptionError);
    assertEquals((err as SqliteEncryptionError).code, "KEY_REQUIRED");
    await db.exec("PRAGMA key = 'pw'");
    assertEquals(await db.query("SELECT v FROM t"), [{ v: "a" }]);
  });
});

Deno.test("sqlite encryption (native): another passphrase than the stored one is WRONG_KEY", async () => {
  const fake = cipherPlugin();
  await inShell(fake.plugin, async () => {
    await (await openSqlite("a.db", { encryptionKey: "one" })).close();
    const err = await assertRejects(
      () => openSqlite("b.db", { encryptionKey: "two" }),
      SqliteEncryptionError,
      "one passphrase for every database",
    );
    assertEquals((err as SqliteEncryptionError).code, "WRONG_KEY");
  });
  assertEquals(fake.files.has("b"), false, "nothing was created");
});

Deno.test("sqlite encryption (native): a database the secret call closed reconnects by itself", async () => {
  const fake = cipherPlugin();
  await inShell(fake.plugin, async () => {
    const plain = await openSqlite("plain.db");
    await plain.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('p')");
    const vault = await openSqlite("vault.db", { encryptionKey: "pw" }); // closes every connection
    assertEquals(await plain.query("SELECT v FROM t"), [{ v: "p" }]);
    assertEquals(fake.files.get("plain")!.key, null, "the other database stays plain");
    await vault.exec("CREATE TABLE s (v TEXT)");
    await openSqlite("other.db", { encryptionKey: "pw" }); // checks the secret: closes all again
    assertEquals(await vault.query("SELECT count(*) AS n FROM s"), [{ n: 0 }]);
  });
});

Deno.test("sqlite encryption (native): encryption off in capacitor.config is ENCRYPTION_UNAVAILABLE", async () => {
  const fake = cipherPlugin({ encryptionOff: true });
  await inShell(fake.plugin, async () => {
    const err = await assertRejects(
      () => openSqlite("v.db", { encryptionKey: "pw" }),
      SqliteEncryptionError,
      "iosIsEncryption",
    );
    assertEquals((err as SqliteEncryptionError).code, "ENCRYPTION_UNAVAILABLE");
    const db = await openSqlite("p.db");
    await assertRejects(
      () => db.exec("PRAGMA key = 'pw'"),
      SqliteEncryptionError,
      "capacitor.config",
    );
  });
});

Deno.test("sqlite encryption: hexkey and a key pragma that is not first are refused; nothing runs", async () => {
  const fake = cipherPlugin();
  await inShell(fake.plugin, async () => {
    const db = await openSqlite("r.db");
    for (
      const sql of [
        "PRAGMA hexkey = '00ff'",
        "PRAGMA main.textkey = 'x'",
        "PRAGMA key = x'00ff'",
        "CREATE TABLE early (v); PRAGMA key = 'pw'",
        "PRAGMA key = 'a'; PRAGMA key = 'b'",
        // A quoted pragma name is the same pragma to SQLite: never a way past the rule.
        "PRAGMA 'hexkey' = '00ff'",
        "PRAGMA `textrekey` = 'x'",
        "PRAGMA rekey = x'00ff'",
        "PRAGMA rekey = 'a'; PRAGMA key = 'b'",
        "CREATE TABLE early3 (v); PRAGMA rekey = 'x'",
        `CREATE TABLE early2 (v); PRAGMA "key" = 'pw'`,
      ]
    ) {
      const err = await assertRejects(() => db.exec(sql), SqliteEncryptionError, "", sql);
      assertEquals((err as SqliteEncryptionError).code, "UNSUPPORTED", sql);
    }
    // PRAGMA rekey in any spelling is the rekey: refused on a database that was never keyed.
    for (
      const sql of [
        "PRAGMA rekey = 'new'",
        `PRAGMA "rekey" = 'new'`,
        "PRAGMA [rekey] = 'new'",
        `PRAGMA "main"."rekey" = 'x'`,
        "PRAGMA [main] . [rekey] = 'x'",
        "PRAGMA/**/rekey = 'x'",
      ]
    ) {
      const err = await assertRejects(() => db.exec(sql), SqliteEncryptionError, "", sql);
      assertEquals((err as SqliteEncryptionError).code, "KEY_REQUIRED", sql);
    }
    assert(!fake.calls.some(([n]) => n === "changeEncryptionSecret"));
    assertEquals(await db.query("SELECT name FROM sqlite_master"), [], "nothing ran");
    assert(!fake.calls.some(([n]) => n === "setEncryptionSecret"));
    await assertRejects(() => openSqlite("x.db", { encryptionKey: "" }), TypeError);
  });
});

Deno.test("sqlite encryption (native): a plugin without the encryption methods refuses PRAGMA key", async () => {
  const fake = cipherPlugin();
  const { isSecretStored: _, ...older } = fake.plugin;
  await inShell(older, async () => {
    const db = await openSqlite("o.db");
    const err = await assertRejects(() => db.exec("PRAGMA key = 'pw'"), SqliteEncryptionError);
    assertEquals((err as SqliteEncryptionError).code, "ENCRYPTION_UNAVAILABLE");
  });
});

// ---- rekey --------------------------------------------------------------------------------

Deno.test("sqlite rekey (native): every encrypted database moves to the new passphrase", async () => {
  const fake = cipherPlugin();
  await inShell(fake.plugin, async () => {
    const plain = await openSqlite("plain.db");
    await plain.exec("CREATE TABLE p (v TEXT); INSERT INTO p VALUES ('p')");
    const other = await openSqlite("other.db", { encryptionKey: "one" });
    await other.exec("CREATE TABLE o (v TEXT); INSERT INTO o VALUES ('o')");
    const db = await openSqlite("vault.db", { encryptionKey: "one" });
    await db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('secret')");
    await db.rekey("two");
    // The handle reconnected under the new passphrase; the others reconnect by themselves.
    assertEquals(await db.query("SELECT v FROM t"), [{ v: "secret" }]);
    assertEquals(await other.query("SELECT v FROM o"), [{ v: "o" }]);
    assertEquals(await plain.query("SELECT v FROM p"), [{ v: "p" }]);
    await db.rekey("two"); // the same passphrase: nothing to do
  });
  assertEquals(fake.secret(), "two");
  assertEquals(fake.files.get("vault")!.key, "two");
  assertEquals(fake.files.get("other")!.key, "two", "the plugin keeps one passphrase");
  assertEquals(fake.files.get("plain")!.key, null, "a plain database stays plain");
  const changes = fake.calls.filter(([n]) => n === "changeEncryptionSecret").map(([, o]) => o);
  assertEquals(changes, [{ passphrase: "two", oldpassphrase: "one" }]);
  // The next launch opens with the new passphrase only.
  await inShell(fake.plugin, async () => {
    const err = await assertRejects(
      () => openSqlite("vault.db", { encryptionKey: "one" }),
      SqliteEncryptionError,
    );
    assertEquals((err as SqliteEncryptionError).code, "WRONG_KEY");
    const db = await openSqlite("vault.db", { encryptionKey: "two" });
    assertEquals(await db.query("SELECT v FROM t"), [{ v: "secret" }]);
  });
});

Deno.test("sqlite rekey (native): expo-sqlite's PRAGMA rekey after PRAGMA key", async () => {
  const fake = cipherPlugin();
  await inShell(fake.plugin, async () => {
    const db = await SQLite.openDatabaseAsync("app.db");
    await db.execAsync("PRAGMA key = 'old'; CREATE TABLE t (v TEXT)");
    await db.execAsync("PRAGMA rekey = 'n''ew'; INSERT INTO t VALUES ('x')");
    assertEquals(await db.getAllAsync("SELECT v FROM t"), [{ v: "x" }]);
  });
  assertEquals(fake.secret(), "n'ew");
  assertEquals(fake.files.get("app")!.key, "n'ew");
});

Deno.test("sqlite rekey (native): refusals change nothing", async () => {
  const fake = cipherPlugin();
  await inShell(fake.plugin, async () => {
    const db = await openSqlite("vault.db", { encryptionKey: "one" });
    await db.exec("CREATE TABLE t (v TEXT)");
    // Inside a transaction.
    await db.exec("BEGIN");
    const inTx = await assertRejects(() => db.rekey("two"), SqliteEncryptionError);
    assertEquals((inTx as SqliteEncryptionError).code, "UNSUPPORTED");
    await db.exec("ROLLBACK");
    // Not a passphrase.
    await assertRejects(() => db.rekey(""), TypeError);
    // A database not keyed on this page.
    const plain = await openSqlite("plain.db");
    const unkeyed = await assertRejects(() => plain.rekey("two"), SqliteEncryptionError);
    assertEquals((unkeyed as SqliteEncryptionError).code, "KEY_REQUIRED");
  });
  assertEquals(fake.secret(), "one");
  assert(!fake.calls.some(([n]) => n === "changeEncryptionSecret"));
  // A plugin too old to change its passphrase.
  const older = cipherPlugin();
  const { changeEncryptionSecret: _, ...withoutChange } = older.plugin;
  await inShell(withoutChange, async () => {
    const db = await openSqlite("vault.db", { encryptionKey: "one" });
    const err = await assertRejects(() => db.rekey("two"), SqliteEncryptionError);
    assertEquals((err as SqliteEncryptionError).code, "ENCRYPTION_UNAVAILABLE");
  });
  assertEquals(older.secret(), "one");
});

Deno.test("sqlite rekey (native): a failed rekey keeps the old passphrase working", async () => {
  const fake = cipherPlugin({ failRekey: true });
  await inShell(fake.plugin, async () => {
    const db = await openSqlite("vault.db", { encryptionKey: "one" });
    await db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
    await assertRejects(() => db.rekey("two"), Error, "disk full");
    // The plugin closed the connection; the handle reconnects under the old passphrase.
    assertEquals(await db.query("SELECT v FROM t"), [{ v: "kept" }]);
  });
  assertEquals(fake.secret(), "one");
  assertEquals(fake.files.get("vault")!.key, "one");
});
