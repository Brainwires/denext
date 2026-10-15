// Boot-time DDL against a REAL Postgres: a first run of the auth adapter, the cache store and
// the job-history store sends the client no NOTICE (`… already exists, skipping`) and prints one
// line per store; with `DENEXT_BOOT_DDL=off` a fresh database is refused (by each store on use,
// and by the server's start for `@denext/backend`) without one table being created, and passes
// once the migrations were applied out of band.
//
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`):
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/postgres-boot-integration.test.ts
//
// Ignored without DENEXT_TEST_POSTGRES_URL or Deno.SQL; the same rules are unit-tested against a
// fake client in tests/postgres-boot.test.ts.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { builtinSql, type SqlClient } from "../src/server/postgres.ts";
import { BOOT_DDL_ENV, BootSchemaError, verifyBootSchemas } from "../src/server/postgres-boot.ts";
import { postgresAuthAdapter } from "../src/server/auth/postgres-adapter.ts";
import { postgresCacheStore } from "../src/server/postgres-cache.ts";
import { postgresJobHistoryStore } from "../src/server/postgres-job-history.ts";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { backend } from "../packages/backend/mod.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { installRealtime } from "../packages/backend/src/realtime.ts";
import { installWebhooks } from "../packages/backend/src/webhooks.ts";
import { postgresEnvironment } from "./helpers/postgres-env.ts";
import { migratePostgres } from "../src/server/postgres-migrate.ts";
import { type BackendDbHooks, backendHooks } from "../src/cli/db/project.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const SQL = builtinSql() as
  | (new (url?: string, options?: { onnotice?: (notice: unknown) => void }) => SqlClient)
  | undefined;
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";
const load = ((path: string) => import(path)) as unknown as ModuleLoader;

/** Run `fn` with `DENEXT_BOOT_DDL` set to `value` (unset with `undefined`), restored after. */
async function withBootDdl<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = Deno.env.get(BOOT_DDL_ENV);
  if (value === undefined) Deno.env.delete(BOOT_DDL_ENV);
  else Deno.env.set(BOOT_DDL_ENV, value);
  try {
    return await fn();
  } finally {
    if (before === undefined) Deno.env.delete(BOOT_DDL_ENV);
    else Deno.env.set(BOOT_DDL_ENV, before);
  }
}

/** Capture `console.info` while `fn` runs. */
async function infoLines(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.info = info;
  }
  return lines;
}

/** The tables of `schema`. */
async function tablesIn(sql: SqlClient, schema: string): Promise<string[]> {
  const rows = await sql.unsafe<{ name: string }>(
    "select table_name::text as name from information_schema.tables where table_schema = $1 " +
      "order by 1",
    [schema],
  );
  return rows.map((r) => r.name);
}

Deno.test({
  name:
    `boot DDL on a real Postgres: a first run sends no notice and prints one line a store${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const notices: unknown[] = [];
    const sql = new SQL!(URL_!, { onnotice: (notice) => void notices.push(notice) });
    const schema = `dnx_boot_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      const lines = await withBootDdl(undefined, () =>
        infoLines(async () => {
          await postgresAuthAdapter({ sql, schema }).getUser("nobody");
          await postgresCacheStore({ sql, schema }).getData("k");
          const history = postgresJobHistoryStore({ sql, schema });
          await history.record({
            name: "j",
            trigger: "schedule",
            startedAt: Date.now(),
            durationMs: 1,
            ok: true,
          });
        }));
      assertEquals(notices, [], "the server's notices stayed on the server");
      assertEquals(lines.length, 3, lines.join("\n"));
      assertStringIncludes(lines[0], "[denext] postgresAuthAdapter: applied ");
      assertStringIncludes(lines[1], "[denext] postgresCacheStore: applied ");
      assertStringIncludes(lines[2], "[denext] postgresJobHistoryStore: applied ");
      assert((await tablesIn(sql, schema)).includes("auth_users"));
      // A second process on the same database: nothing to apply, nothing printed.
      const again = await withBootDdl(
        undefined,
        () =>
          infoLines(() => Promise.resolve(postgresAuthAdapter({ sql, schema }).getUser("nobody"))),
      );
      assertEquals(again, []);
    } finally {
      await sql.unsafe(`drop schema if exists "${schema}" cascade`);
      await sql.close();
    }
  },
});

Deno.test({
  name:
    `boot DDL on a real Postgres: DENEXT_BOOT_DDL=off refuses a missing schema, creates nothing${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = new SQL!(URL_!);
    const schema = `dnx_boot_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      await withBootDdl("off", async () => {
        const error = await assertRejects(
          () => Promise.resolve(postgresAuthAdapter({ sql, schema }).getUser("nobody")),
          BootSchemaError,
        );
        assertStringIncludes(error.message, "postgresAuthAdapter: DENEXT_BOOT_DDL=off");
        await verifyBootSchemas().catch(() => {});
      });
      assertEquals(await tablesIn(sql, schema), [], "not even the tracking table");
      // Applied out of band (a release step with boot DDL on): the store starts.
      await withBootDdl(
        undefined,
        () =>
          infoLines(() => Promise.resolve(postgresAuthAdapter({ sql, schema }).getUser("nobody"))),
      );
      await withBootDdl("off", async () => {
        assertEquals(await postgresAuthAdapter({ sql, schema }).getUser("nobody"), undefined);
        await verifyBootSchemas();
      });
    } finally {
      await sql.unsafe(`drop schema if exists "${schema}" cascade`);
      await sql.close();
    }
  },
});

/** Set `backend({ postgres, … })` up as `denext start` does. */
async function startBackend(app: SqlClient): Promise<void> {
  resetPlugins();
  installPostgres(undefined);
  installRealtime(undefined);
  installWebhooks(undefined);
  await applyPlugins({
    projectRoot: "/tmp/x",
    appDir: "/tmp/x/app",
    config: {
      plugins: [
        backend({
          postgres: { sql: app },
          realtime: { tables: { notes: {} } },
          queues: {},
          webhooks: { delivery: "manual" },
        }),
      ],
    } as DenextConfig,
    mode: "prod",
    load,
  });
}

async function stopBackend(): Promise<void> {
  await runPluginTeardown();
  resetPlugins();
  installPostgres(undefined);
  installRealtime(undefined);
  installWebhooks(undefined);
}

Deno.test({
  name: `boot DDL on a real Postgres: DENEXT_BOOT_DDL=off stops @denext/backend's start${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    try {
      await env.app.unsafe("create table notes (id bigint primary key, body text)");
      let hooks: BackendDbHooks | undefined;
      await withBootDdl("off", async () => {
        const error = await assertRejects(() => startBackend(env.app), BootSchemaError);
        assertStringIncludes(error.message, "@denext/backend: DENEXT_BOOT_DDL=off");
        assertStringIncludes(error.message, "backend_rls_0001");
        assertStringIncludes(error.message, "backend_webhooks_0001");
        assertStringIncludes(error.message, "backend_realtime_t_notes_");
        hooks = backendHooks();
        await stopBackend();
      });
      const schemas = await env.app.unsafe<{ n: number }>(
        "select count(*)::int as n from pg_namespace where nspname in " +
          "('pgmq', 'supabase_functions', 'realtime')",
      );
      assertEquals(schemas[0].n, 0, "no backend schema was created");
      // Applied out of band as `denext db push` does (the backend's sets, the app's migrations,
      // then what needs the app's tables): the start passes.
      assert(hooks);
      const sets = [
        { table: hooks.table, migrations: hooks.migrations() },
        ...hooks.migrationSets?.() ?? [],
        ...hooks.afterMigrationSets?.() ?? [],
      ];
      for (const set of sets) {
        for (const migration of set.migrations) {
          await migratePostgres(env.app, { table: set.table, migrations: [migration] });
        }
      }
      await withBootDdl("off", async () => {
        await startBackend(env.app);
        await stopBackend();
      });
    } finally {
      await stopBackend().catch(() => {});
      await env.drop();
    }
  },
});
