// A pooled client paired with a direct connection (`withDirectConnection`, the `directUrl`
// option of denext's Postgres stores and of `backend({ postgres })`): queries and transactions go
// to the pooled one, LISTEN, reserved connections and migrations (with their lock) to the direct
// one, and closing the pair closes only what was opened for it. Against a real PgBouncer in
// transaction mode: tests/postgres-direct-integration.test.ts.

import { assert, assertEquals } from "@std/assert";
import {
  builtinSql,
  resolveConnection,
  sessionClient,
  type SqlClient,
  withDirectConnection,
} from "../src/server/postgres.ts";
import { migratePostgres, withMigrationLock } from "../src/server/postgres-migrate.ts";
import { openPostgres } from "../packages/backend/src/postgres.ts";
import { fakeSqlClient } from "./helpers/fake-sql-client.ts";

/** A client that records which methods ran on it and refuses every query. */
function refusing(log: string[], name: string): SqlClient {
  const fail = () => {
    log.push(`${name}:query`);
    return Promise.reject(new Error(`${name} must not be queried`));
  };
  const client = (() => fail()) as unknown as SqlClient;
  client.unsafe = (() => {
    const p = fail();
    return { then: p.then.bind(p) };
  }) as unknown as SqlClient["unsafe"];
  client.begin = () => fail() as Promise<never>;
  client.listen = () => {
    log.push(`${name}:listen`);
    return Promise.resolve({ unlisten: () => Promise.resolve() });
  };
  client.reserve = () => {
    log.push(`${name}:reserve`);
    return Promise.resolve(Object.assign(client, { release: () => {} }));
  };
  client.close = () => {
    log.push(`${name}:close`);
    return Promise.resolve();
  };
  return client;
}

Deno.test("withDirectConnection: queries pooled; listen, reserve and migrations direct", async () => {
  const log: string[] = [];
  const pooled = fakeSqlClient();
  const direct = refusing(log, "direct");
  const pair = withDirectConnection(pooled, direct);
  assertEquals(await pair.unsafe("SELECT 1 AS one"), [{ one: 1 }]);
  assertEquals(await pair.begin(async (tx) => await tx.unsafe("SELECT 2 AS two")), [{ two: 2 }]);
  await pair.listen!("c", () => {});
  await pair.reserve!();
  assertEquals(log, ["direct:listen", "direct:reserve"]);
  assert(sessionClient(pair) === direct);
  assert(sessionClient(pooled) === pooled, "an unpaired client is its own session client");
  await pair.close();
  assertEquals(pooled.closes, 1);
  assertEquals(log.at(-1), "direct:close");
});

Deno.test("migrations and their lock run on the direct connection, never through the pooler", async () => {
  const log: string[] = [];
  const direct = fakeSqlClient();
  const pair = withDirectConnection(refusing(log, "pooled"), direct);
  const result = await migratePostgres(pair, {
    migrations: [{ name: "0001_t", sql: "CREATE TABLE t (id TEXT)" }],
  });
  assertEquals(result.applied, ["0001_t"]);
  await withMigrationLock(pair, {}, async (tx) => await tx.unsafe("SELECT 1"));
  assertEquals(log, [], "nothing reached the pooled client");
  assert(direct.statements.some((s) => s.includes("pg_advisory_xact_lock")));
});

Deno.test("closing a pair leaves the client you handed in open", async () => {
  const log: string[] = [];
  const pair = withDirectConnection(refusing(log, "yours"), refusing(log, "opened"), {
    pooled: false,
  });
  await pair.close();
  assertEquals(log, ["opened:close"]);
});

Deno.test({
  name: "directUrl: a store and backend({ postgres }) pair their client with it",
  ignore: !builtinSql(), // Deno.SQL opens the direct URL (lazily: nothing connects here)
  async fn() {
    const yours = fakeSqlClient();
    const { sql, owned } = resolveConnection(
      { sql: yours, directUrl: "postgres://u:p@127.0.0.1:1/db" },
      "test",
    );
    assert(owned, "the direct connection it opened is the store's to close");
    assert(sessionClient(sql) !== sql && sessionClient(sql) !== yours);
    assertEquals(await sql.unsafe("SELECT 3 AS three"), [{ three: 3 }]);
    await sql.close({ timeout: 0 });
    assertEquals(yours.closes, 0, "yours stays open");
    // The backend reads DATABASE_DIRECT_URL next to DATABASE_URL.
    const env = (name: string) =>
      ({
        DATABASE_URL: "postgres://u:p@127.0.0.1:1/pooled",
        DATABASE_DIRECT_URL: "postgres://u:p@127.0.0.1:1/direct",
      })[name];
    const { slot } = openPostgres({}, env);
    assert("sql" in slot && sessionClient(slot.sql) !== slot.sql);
    if ("sql" in slot) await slot.sql.close({ timeout: 0 });
  },
});
