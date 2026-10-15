// `directUrl` against a REAL PgBouncer in transaction mode in front of a real Postgres. Through
// the pooler alone, LISTEN subscribes on a server connection the pooler hands to the next
// transaction, so `@denext/backend` realtime never hears a NOTIFY. With `directUrl` the
// listener (and every migration and its lock) runs on a direct connection to the server, and
// the same change reaches the hook, while queries keep going through the pooler.
//
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`), with a superuser URL to the
// server and one to a transaction-mode PgBouncer in front of the same database:
//
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//   DENEXT_TEST_PGBOUNCER_URL=postgres://postgres:pw@127.0.0.1:6432/postgres \
//     deno test -A tests/postgres-direct-integration.test.ts

import { assert, assertEquals } from "@std/assert";
import { builtinSql } from "../src/server/postgres.ts";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { backend } from "../packages/backend/mod.ts";
import { db, onTableChange } from "../packages/backend/server.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { installRealtime, realtimeEngine } from "../packages/backend/src/realtime.ts";

const DIRECT = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const POOLED = Deno.env.get("DENEXT_TEST_PGBOUNCER_URL") || undefined;
const SQL = builtinSql();
const reason = !DIRECT || !POOLED
  ? "set DENEXT_TEST_POSTGRES_URL and DENEXT_TEST_PGBOUNCER_URL"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const load = ((path: string) => import(path)) as unknown as ModuleLoader;

/** Set the backend up as `denext start` does, realtime on `table`. */
async function start(table: string, directUrl?: string): Promise<void> {
  resetPlugins();
  installPostgres(undefined);
  installRealtime(undefined);
  await applyPlugins({
    projectRoot: "/tmp/x",
    appDir: "/tmp/x/app",
    config: {
      plugins: [backend({
        postgres: { url: POOLED!, ...(directUrl ? { directUrl } : {}) },
        realtime: { tables: { [table]: {} }, publication: false },
      })],
    } as DenextConfig,
    mode: "prod",
    load,
  });
}

async function stop(): Promise<void> {
  await runPluginTeardown();
  resetPlugins();
  installPostgres(undefined);
  installRealtime(undefined);
}

/** Whether a change to `table` reaches `onTableChange` within `ms`. */
async function heard(table: string, ms: number): Promise<boolean> {
  let got = false;
  const off = onTableChange(table, () => void (got = true));
  await db.service().unsafe(`insert into ${table} (body) values ('x')`);
  const deadline = Date.now() + ms;
  while (!got && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  off();
  return got;
}

Deno.test({
  name:
    `directUrl on a real PgBouncer (transaction mode): realtime LISTENs on the direct connection${
      reason ? ` (skipped: ${reason})` : ""
    }`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const table = `dnx_direct_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const admin = new SQL!(DIRECT!);
    const app = `dnx_direct_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    try {
      await admin.unsafe(`create table ${table} (id bigserial primary key, body text)`);
      // Through the pooler alone: the trigger is installed, the NOTIFY is sent, nobody hears it.
      await start(table);
      await realtimeEngine().start();
      assertEquals(await heard(table, 1_000), false, "LISTEN through the pooler hears nothing");
      await stop();
      // With the direct URL: the listener is a session of its own on the server.
      const direct = new URL(DIRECT!);
      direct.searchParams.set("application_name", app);
      await start(table, direct.toString());
      await realtimeEngine().start();
      const listeners = await admin.unsafe<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where application_name = $1 " +
          "and query ilike 'listen%'",
        [app],
      );
      assertEquals(listeners[0].n, 1, "the LISTEN is on the direct connection");
      assert(await heard(table, 10_000), "the change reached the hook");
      await stop();
    } finally {
      await stop().catch(() => {});
      await admin.unsafe(`drop table if exists ${table}`);
      await admin.close();
    }
  },
});
