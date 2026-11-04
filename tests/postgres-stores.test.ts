// denext's Postgres stores on a fake client (node:sqlite underneath, so this runs on any Deno):
// the shared AuthAdapter contract and the store suites (tests/helpers/postgres-suites.ts — the
// same ones tests/postgres-integration.test.ts runs against a real server), plus the client
// seam: Deno.SQL feature detection, the `unsupported` error, `fromPostgresJs`, ownership and
// close, migrate: false, a failed migration retried, and the migration runner's refusals.

import { assert, assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import { fakeSqlClient } from "./helpers/fake-sql-client.ts";
import { postgresSuites } from "./helpers/postgres-suites.ts";
import {
  fromPostgresJs,
  isPostgresUrl,
  postgresClient,
  PostgresUnsupportedError,
  type SqlClient,
  sqlState,
  toNumber,
} from "../src/server/postgres.ts";
import { migratePostgres, postgresMigrationStatus } from "../src/server/postgres-migrate.ts";
import { postgresAuthAdapter } from "../packages/auth/src/postgres-adapter.ts";
import { postgresCacheStore } from "../src/server/postgres-cache.ts";
import { postgresRateLimitStore } from "../packages/auth/src/postgres-rate-limit.ts";
import { postgresSessionStore } from "../packages/auth/src/postgres-session-store.ts";

Deno.test("Postgres stores on a fake client: contract + suites", async (t) => {
  await postgresSuites(t, () => Promise.resolve({ sql: fakeSqlClient() }));
});

/** Install a fake `Deno.SQL` for one test, restoring whatever was there. */
async function withDenoSql(
  ctor: unknown,
  fn: () => Promise<void> | void,
): Promise<void> {
  const deno = Deno as unknown as { SQL?: unknown };
  const had = Object.getOwnPropertyDescriptor(deno, "SQL");
  Object.defineProperty(deno, "SQL", { value: ctor, configurable: true, writable: true });
  try {
    await fn();
  } finally {
    if (had) Object.defineProperty(deno, "SQL", had);
    else delete deno.SQL;
  }
}

Deno.test("postgresClient: Deno.SQL when the runtime has it, a clear `unsupported` otherwise", async () => {
  await withDenoSql(undefined, () => {
    const error = assertThrows(() => postgresClient("postgres://x/db", "myFeature"));
    assertInstanceOf(error, PostgresUnsupportedError);
    assertEquals(error.code, "unsupported");
    assert(error.message.startsWith("myFeature:"), error.message);
    assert(error.message.includes("Deno.SQL") && error.message.includes("fromPostgresJs"));
    // Every store that is given a URL says so the same way, naming itself.
    for (
      const [name, make] of [
        ["postgresAuthAdapter", () => postgresAuthAdapter({ url: "postgres://x/db" })],
        ["postgresSessionStore", () => postgresSessionStore({ url: "postgres://x/db" })],
        ["postgresRateLimitStore", () => postgresRateLimitStore({ url: "postgres://x/db" })],
        ["postgresCacheStore", () => postgresCacheStore({ url: "postgres://x/db" })],
      ] as const
    ) {
      const e = assertThrows(make, PostgresUnsupportedError);
      assert(e.message.startsWith(`${name}:`), e.message);
    }
  });
  const seen: unknown[][] = [];
  class FakeSql {
    constructor(...args: unknown[]) {
      seen.push(args);
    }
  }
  await withDenoSql(FakeSql, () => {
    assertInstanceOf(postgresClient("postgres://h/db"), FakeSql);
    assertInstanceOf(postgresClient(), FakeSql);
    assertEquals(seen, [["postgres://h/db"], []], "no URL leaves Deno.SQL its env defaults");
  });
});

Deno.test("a store given `url` owns (and closes) its client; one given `sql` never closes it", async () => {
  const opened = fakeSqlClient();
  class OneClient {
    constructor() {
      return opened;
    }
  }
  await withDenoSql(OneClient, async () => {
    const adapter = postgresAuthAdapter({ url: "postgres://h/db" });
    await adapter.createUser({ email: "a@x.test" });
    await adapter.close?.();
    await adapter.close?.();
    assertEquals(opened.closes, 1, "closed once, however often close() is called");
    const cache = postgresCacheStore({ url: "postgres://h/db" });
    await cache.close();
    assertEquals(opened.closes, 2);
  });
  const mine = fakeSqlClient();
  const adapter = postgresAuthAdapter({ sql: mine });
  await adapter.getUser("x");
  await adapter.close?.();
  await postgresRateLimitStore({ sql: mine }).close();
  await postgresCacheStore({ sql: mine }).close();
  assertEquals(mine.closes, 0, "a client the app passed stays the app's");
});

Deno.test("store options: sql XOR url, and a schema must be a plain identifier", async () => {
  assertThrows(() => postgresAuthAdapter({}), TypeError, "pass `sql`");
  assertThrows(
    () => postgresAuthAdapter({ sql: fakeSqlClient(), url: "postgres://x" }),
    TypeError,
    "not both",
  );
  assertThrows(
    () => postgresCacheStore({ sql: fakeSqlClient(), schema: 'x"; drop' }),
    TypeError,
    "plain identifier",
  );
  await assertRejects(
    () => migratePostgres(fakeSqlClient(), { table: "a b" }),
    TypeError,
    "plain identifier",
  );
});

Deno.test("schema: tables are qualified with it, and the runner creates it", async () => {
  const sql = fakeSqlClient();
  // The fake has no schemas: watch the statements instead of running them.
  sql.failNext(/^CREATE TABLE IF NOT EXISTS "app"\."auth_migrations"/, new Error("stop here"));
  const adapter = postgresAuthAdapter({ sql, schema: "app" });
  await assertRejects(() => Promise.resolve(adapter.getUser("x")), Error, "stop here");
  assert(sql.statements.some((s) => s === 'CREATE SCHEMA IF NOT EXISTS "app"'));
});

Deno.test("migrate: false never touches the schema; a failed migration is retried", async () => {
  const sql = fakeSqlClient();
  const adapter = postgresAuthAdapter({ sql, migrate: false });
  await assertRejects(() => Promise.resolve(adapter.getUser("x")), Error, "no such table");
  assert(!sql.statements.some((s) => s.includes("CREATE TABLE")), "nothing created");
  const store = postgresSessionStore({ sql, migrate: false });
  await assertRejects(() => Promise.resolve(store.get("x")));

  const flaky = fakeSqlClient();
  flaky.failNext(/pg_advisory_xact_lock/, Object.assign(new Error("connection reset")));
  const retried = postgresAuthAdapter({ sql: flaky });
  await assertRejects(() => Promise.resolve(retried.getUser("x")), Error, "connection reset");
  assertEquals(await retried.getUser("x"), undefined, "the next call migrates and works");

  const cacheSql = fakeSqlClient();
  cacheSql.failNext(/pg_advisory_xact_lock/, new Error("boom"));
  const cache = postgresCacheStore({ sql: cacheSql });
  await assertRejects(async () => await cache.getData("k"), Error, "boom");
  assertEquals(await cache.getData("k"), undefined);
  const unmigrated = postgresCacheStore({ sql: fakeSqlClient(), migrate: false });
  await assertRejects(async () => await unmigrated.getData("k"), Error, "no such table");
});

Deno.test("migratePostgres: a directory of .sql files, in name order, file URLs included", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-pg-migrations-" });
  try {
    await Deno.writeTextFile(`${dir}/20260102_b.sql`, "CREATE TABLE b (id INTEGER);");
    await Deno.writeTextFile(`${dir}/20260101_a#1.sql`, "CREATE TABLE a (id INTEGER);");
    await Deno.writeTextFile(`${dir}/notes.txt`, "not a migration");
    const sql = fakeSqlClient();
    const result = await migratePostgres(sql, { dir });
    assertEquals(result.applied, ["20260101_a#1.sql", "20260102_b.sql"]);
    const status = await postgresMigrationStatus(sql, {
      dir: new URL(`file://${dir}/`),
      table: "_migrations",
    });
    assertEquals(status.pending, []);
    assertEquals(status.migrations.map((m) => m.name), ["20260101_a#1.sql", "20260102_b.sql"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migratePostgres refuses duplicate names and a file with its own transaction", async () => {
  const sql = fakeSqlClient();
  await assertRejects(
    () =>
      migratePostgres(sql, {
        migrations: [{ name: "x", sql: "SELECT 1" }, { name: "x", sql: "SELECT 2" }],
      }),
    Error,
    "two migrations are named",
  );
  for (const own of ["BEGIN;\nSELECT 1;\nCOMMIT;", "select 1;\n  commit;", "START TRANSACTION;"]) {
    await assertRejects(
      () => migratePostgres(sql, { migrations: [{ name: "own", sql: own }] }),
      Error,
      "manages its own transaction",
    );
  }
  // A function body that says BEGIN … END inside a statement is not a transaction statement.
  const body = "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;";
  await migratePostgres(sql, {
    migrations: [{ name: "tbl", sql: "CREATE TABLE x (id INTEGER);" }, { name: "trg", sql: body }],
  });
});

Deno.test("migration status rethrows anything but a missing table", async () => {
  const sql = fakeSqlClient();
  sql.failNext(
    /FROM "_migrations"/,
    Object.assign(new Error("permission denied"), { code: "42501" }),
  );
  await assertRejects(() => postgresMigrationStatus(sql), Error, "permission denied");
});

Deno.test("fromPostgresJs adapts the npm postgres client (end → close, tx wrapped)", async () => {
  const calls: unknown[][] = [];
  // A stand-in with postgres.js's shape: a tagged template, unsafe (with .simple), begin, end.
  const make = (tag: string): Parameters<typeof fromPostgresJs>[0] => {
    const pg = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push([tag, "tag", strings.join("?"), values]);
      return Promise.resolve([{ ok: 1 }]);
    }) as unknown as Parameters<typeof fromPostgresJs>[0];
    pg.unsafe = (text, params) => {
      calls.push([tag, "unsafe", text, params]);
      return Object.assign(Promise.resolve([{ n: "1" }]), {
        simple: () => {
          calls.push([tag, "simple", text]);
          return Promise.resolve([]);
        },
      });
    };
    pg.begin = async (fn) => await fn(make("tx"));
    if (tag === "pool") pg.end = (o) => Promise.resolve(void calls.push([tag, "end", o]));
    return pg;
  };
  const sql: SqlClient = fromPostgresJs(make("pool"));
  assertEquals(await sql`select ${1}`, [{ ok: 1 }]);
  assertEquals(await sql.unsafe("select $1", [2]), [{ n: "1" }]);
  const inside = await sql.begin(async (tx) => {
    await tx.unsafe("multi; statements").simple!();
    await tx.close(); // a transaction's client has no `end`: a no-op
    return "done";
  });
  assertEquals(inside, "done");
  await sql.close({ timeout: 1 });
  assertEquals(calls, [
    ["pool", "tag", "select ?", [1]],
    ["pool", "unsafe", "select $1", [2]],
    ["tx", "unsafe", "multi; statements", undefined],
    ["tx", "simple", "multi; statements"],
    ["pool", "end", { timeout: 1 }],
  ]);
});

Deno.test("helpers: isPostgresUrl, sqlState, toNumber", () => {
  assert(isPostgresUrl("postgres://u@h/db") && isPostgresUrl(" PostgreSQL://h/db"));
  assert(!isPostgresUrl("sqlite://x") && !isPostgresUrl(undefined) && !isPostgresUrl(""));
  assertEquals(sqlState({ code: "23505" }), "23505");
  assertEquals([sqlState(null), sqlState("x"), sqlState({ code: 1 })], [
    undefined,
    undefined,
    undefined,
  ]);
  assertEquals([toNumber(1), toNumber(2n), toNumber("3"), toNumber(" "), toNumber("x")], [
    1,
    2,
    3,
    undefined,
    undefined,
  ]);
  assertEquals(toNumber(null), undefined);
});

Deno.test("a row another writer corrupted reads as absent, not as a crash", async () => {
  const sql = fakeSqlClient();
  const adapter = postgresAuthAdapter({ sql });
  const user = await adapter.createUser({ email: "c@x.test", roles: ["a"] });
  sql.raw.prepare("UPDATE auth_users SET roles = 'not json' WHERE id = ?").run(user.id);
  assertEquals((await adapter.getUser(user.id))?.roles, undefined);
  await adapter.setMfa!({ userId: user.id, secret: "S", backupCodeHashes: ["h"] });
  sql.raw.prepare("UPDATE auth_mfa SET backup_code_hashes = '{}' WHERE user_id = ?").run(user.id);
  assertEquals((await adapter.getMfa!(user.id))?.backupCodeHashes, []);
});

Deno.test("consumeBackupCode gives up after repeatedly losing the swap", async () => {
  const sql = fakeSqlClient();
  const adapter = postgresAuthAdapter({ sql });
  await adapter.setMfa!({ userId: "u", secret: "S", backupCodeHashes: ["h1", "h2"] });
  // Every comparison rewrites the list under the caller, so each swap is lost.
  let n = 0;
  const result = await adapter.consumeBackupCode!("u", (hash) => {
    sql.raw.prepare("UPDATE auth_mfa SET backup_code_hashes = ? WHERE user_id = 'u'")
      .run(JSON.stringify(["h1", "h2", `x${n++}`]));
    return hash === "h1";
  });
  assertEquals(result, false);
});

Deno.test("a runner that loses the race to create the tracking table retries, then gives up", async () => {
  const sql = fakeSqlClient();
  const race = () => Object.assign(new Error("relation already exists"), { code: "42P07" });
  sql.failNext(/^CREATE TABLE IF NOT EXISTS "_migrations"/, race());
  const migrations = [{ name: "a", sql: "CREATE TABLE a (id INTEGER);" }];
  assertEquals((await migratePostgres(sql, { migrations })).applied, ["a"], "retried");

  const stuck = fakeSqlClient();
  for (let i = 0; i < 3; i++) {
    stuck.failNext(/^CREATE TABLE IF NOT EXISTS "_migrations"/, race());
  }
  await assertRejects(() => migratePostgres(stuck, { migrations }), Error, "already exists");
  const other = fakeSqlClient();
  other.failNext(/^CREATE TABLE IF NOT EXISTS "_migrations"/, new Error("disk full"));
  await assertRejects(() => migratePostgres(other, { migrations }), Error, "disk full");
});

Deno.test("rate-limit store: closed windows are swept at most once per interval", async () => {
  const sql = fakeSqlClient();
  const store = postgresRateLimitStore({ sql });
  await store.increment("a", 60_000);
  await store.increment("b", 60_000);
  const sweeps = sql.statements.filter((s) => s.startsWith("DELETE FROM auth_rate_limits"));
  assertEquals(sweeps.length, 1, "the default interval throttles the sweep");
});
