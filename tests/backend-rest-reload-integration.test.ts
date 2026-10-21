// `@denext/backend` auto-REST picks up a schema change without a restart, against a REAL
// Postgres: a table created after the catalog was read is served once a migration run notifies
// `pgrst` (`NOTIFY pgrst, 'reload schema'` — PostgREST's signal, which `migratePostgres` and
// `denext migration up` send), and a column added to an existing table is served after a plain
// `NOTIFY pgrst, 'reload schema'` from anywhere.
//
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`), with a superuser URL:
//
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/backend-rest-reload-integration.test.ts

import { assertEquals } from "@std/assert";
import { builtinSql, type SqlClient } from "../src/server/postgres.ts";
import { migratePostgres } from "../src/server/postgres-migrate.ts";
import {
  applyPlugins,
  getPluginRequestHandler,
  resetPlugins,
  runPluginTeardown,
} from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createApp } from "../src/server/app.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { backend } from "../packages/backend/mod.ts";
import { db } from "../packages/backend/server.ts";
import { installPostgres, rlsReady } from "../packages/backend/src/postgres.ts";
import { postgresEnvironment as environment } from "./helpers/postgres-env.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !builtinSql()
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const load = ((path: string) => import(path)) as unknown as ModuleLoader;

/** Poll `fn` until it returns `want` (the NOTIFY arrives asynchronously), up to 3 s. */
async function eventually<T>(fn: () => Promise<T>, want: T): Promise<T> {
  let last = await fn();
  for (let i = 0; i < 30 && last !== want; i++) {
    await new Promise((r) => setTimeout(r, 100));
    last = await fn();
  }
  return last;
}

/**
 * Watch the plugin's `pgrst` listener on `sql` (the client handed to `backend({ postgres })`):
 * `listening` settles once it is subscribed, and `drained()` sends a payload the plugin ignores
 * (not `reload schema`) and resolves once the listener has received it. Postgres delivers a
 * listener its notifications in commit order, so by then every reload signal sent before it —
 * the backend's own boot migration sends one, as does `migratePostgres` — has been handled. A
 * signal still in flight would otherwise drop the cache after the test's next DDL, and the
 * "cached catalog" read would see the new column.
 */
function watchReloads(sql: SqlClient): { listening: Promise<void>; drained(): Promise<void> } {
  const listen = sql.listen!.bind(sql);
  const listening = Promise.withResolvers<void>();
  const waiting = new Map<string, () => void>();
  let seq = 0;
  sql.listen = (channel, fn, onlisten) =>
    listen(channel, (payload) => {
      fn(payload);
      if (channel === "pgrst") waiting.get(payload)?.();
    }, () => {
      onlisten?.();
      listening.resolve();
    });
  return {
    listening: listening.promise,
    async drained() {
      const marker = `denext-test-barrier ${++seq}`;
      const seen = new Promise<void>((resolve) => waiting.set(marker, resolve));
      await sql`select pg_notify('pgrst', ${marker})`;
      await seen;
      waiting.delete(marker);
    },
  };
}

Deno.test({
  name: `auto-REST re-reads the catalog on NOTIFY pgrst 'reload schema'${
    reason ? ` (skipped: ${reason})` : ""
  }`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-rest-reload-" });
    try {
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      const reloads = watchReloads(env.app);
      const config = {
        plugins: [backend({ postgres: { sql: env.app }, rest: {} })],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "prod", load });
      await rlsReady();
      // Subscribed (else the migration's signal is lost), and the boot migration's signal handled.
      await reloads.listening;
      await reloads.drained();
      const manifest = await scanRoutes(`${root}/app`);
      const handler = createApp({
        getManifest: () => manifest,
        load,
        matchExternal: getPluginRequestHandler(),
      });
      const status = async (path: string) => {
        const res = await handler(new Request(`https://app.test${path}`));
        await res.body?.cancel();
        return res.status;
      };
      assertEquals(await status("/rest/v1/later"), 404, "not in the catalog read at boot");

      // A migration run (the stack's migrate service, `denext migration up`) creates it.
      const applied = await migratePostgres(db.service(), {
        migrations: [{
          name: "0001_later",
          sql: `create table later (id int primary key, body text);
                alter table later enable row level security;
                create policy anyone on later for select using (true);
                grant select on later to anon, authenticated;
                insert into later values (1, 'hi');`,
        }],
      });
      assertEquals(applied.applied, ["0001_later"]);
      await reloads.drained();
      assertEquals(await status("/rest/v1/later"), 200, "re-read after the migration's signal");

      // A column added later: unknown until a reload signal, served right after one.
      await db.service().unsafe("alter table later add column extra text");
      assertEquals(await status("/rest/v1/later?select=extra"), 400, "cached catalog");
      await db.service()`select pg_notify('pgrst', 'reload schema')`;
      assertEquals(await eventually(() => status("/rest/v1/later?select=extra"), 200), 200);
    } finally {
      await runPluginTeardown();
      resetPlugins();
      installPostgres(undefined);
      await env.drop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
