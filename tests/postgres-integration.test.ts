// denext's Postgres stores against a REAL Postgres server: the shared AuthAdapter contract and
// every store suite (tests/helpers/postgres-suites.ts), each case in a schema of its own, plus
// what only a real server can show — two clients (two replicas) racing a consume-once token and
// two runners migrating at once on separate connections.
//
// Opt-in. On denext's Deno runtime (which has the built-in `Deno.SQL`):
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/postgres-integration.test.ts
//
// On stock Deno the same suites run through the npm `postgres` package (the documented
// stock-Deno path, `fromPostgresJs`) when DENEXT_TEST_POSTGRES_JS=1 is set too. Without
// DENEXT_TEST_POSTGRES_URL every test here is ignored, so CI stays green with no server; the
// suites also run on every Deno against a fake client in tests/postgres-stores.test.ts.

import { assertEquals } from "@std/assert";
import { builtinSql, fromPostgresJs, type SqlClient } from "../src/server/postgres.ts";
import { postgresAuthAdapter } from "../src/server/auth/postgres-adapter.ts";
import { migratePostgres, postgresMigrationStatus } from "../src/server/postgres-migrate.ts";
import { type Fresh, postgresSuites } from "./helpers/postgres-suites.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const POSTGRES_JS = Deno.env.get("DENEXT_TEST_POSTGRES_JS") === "1";
const SQL = builtinSql();

/** A client of the kind under test. */
type Driver = "Deno.SQL" | "npm:postgres";

async function connect(driver: Driver): Promise<SqlClient> {
  if (driver === "Deno.SQL") return new SQL!(URL_);
  // Not a literal: type checking must not resolve (or download) the package on CI.
  const spec = ["npm:postgres", "3.4.7"].join("@");
  const postgres = (await import(spec)).default as (
    url: string,
    options: Record<string, unknown>,
  ) => Parameters<typeof fromPostgresJs>[0];
  return fromPostgresJs(postgres(URL_!, { max: 4, onnotice: () => {} }));
}

/** Fresh schemas for each case on one client, dropped afterwards. */
function schemas(sql: SqlClient) {
  const made: string[] = [];
  return {
    fresh: (): Promise<Fresh> => {
      const schema = `dnx_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      made.push(schema);
      return Promise.resolve({ sql, schema });
    },
    async drop() {
      for (const schema of made) await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    },
  };
}

for (const driver of ["Deno.SQL", "npm:postgres"] as const) {
  const reason = !URL_
    ? "set DENEXT_TEST_POSTGRES_URL"
    : driver === "Deno.SQL" && !SQL
    ? "needs denext's Deno runtime (Deno.SQL)"
    : driver === "npm:postgres" && !POSTGRES_JS
    ? "set DENEXT_TEST_POSTGRES_JS=1"
    : undefined;
  const label = reason ? ` (skipped: ${reason})` : "";

  Deno.test({
    name: `Postgres stores on a real server via ${driver}: contract + suites${label}`,
    ignore: reason !== undefined,
    async fn(t) {
      const sql = await connect(driver);
      const { fresh, drop } = schemas(sql);
      try {
        await postgresSuites(t, fresh);
      } finally {
        await drop();
        await sql.close();
      }
    },
  });

  Deno.test({
    name:
      `Postgres via ${driver}: two replicas race one token, two runners migrate at once${label}`,
    ignore: reason !== undefined,
    async fn() {
      const a = await connect(driver);
      const b = await connect(driver);
      const { fresh, drop } = schemas(a);
      try {
        const { schema } = await fresh();
        const one = postgresAuthAdapter({ sql: a, schema });
        const two = postgresAuthAdapter({ sql: b, schema });
        // Two first uses at once on separate connections: the advisory lock lets one migrate.
        await Promise.all([one.getUser("x"), two.getUser("x")]);
        const status = await postgresMigrationStatus(a, { schema, table: "auth_migrations" });
        assertEquals(status.unknown, ["0001_auth_tables"]);
        for (let round = 0; round < 10; round++) {
          const ref = {
            identifier: "race@x.test",
            tokenHash: `h${round}`,
            purpose: "magic" as const,
          };
          await one.createVerificationToken!({
            ...ref,
            expires: Math.floor(Date.now() / 1000) + 60,
          });
          const won = await Promise.all([
            one.useVerificationToken!(ref),
            two.useVerificationToken!(ref),
          ]);
          assertEquals(won.filter(Boolean).length, 1, "consumed exactly once across replicas");
        }
        const migrations = Array.from({ length: 5 }, (_, i) => ({
          name: `m${i}`,
          sql: `CREATE TABLE "${schema}".t${i} (id INTEGER);`,
        }));
        const [ra, rb] = await Promise.all([
          migratePostgres(a, { migrations, schema }),
          migratePostgres(b, { migrations, schema }),
        ]);
        assertEquals([...ra.applied, ...rb.applied].sort(), migrations.map((m) => m.name));
      } finally {
        await drop();
        await a.close();
        await b.close();
      }
    },
  });
}
