// `@denext/backend` realtime against a REAL Postgres: the migration installs the trigger function
// and the triggers, NOTIFY reaches the one listener at commit, and each subscriber (on the real
// Live channel hub, driven without a socket) gets the rows its own row-level-security policies
// return — two users, a visibility change on update, deletes, a 500-row transaction coalesced, the
// listener reconnecting after `pg_terminate_backend`, and notifications handled in the root
// context — and that the re-read and seed queries are index scans on an integer and a uuid key
// (EXPLAIN). The app connects as a non-superuser role that owns its database.
//
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`), with a superuser URL:
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/backend-realtime-integration.test.ts
//
// Ignored without DENEXT_TEST_POSTGRES_URL or Deno.SQL; the same behaviour is unit-tested against
// a fake client in tests/backend-realtime.test.ts.

import { assert, assertEquals } from "@std/assert";
import { builtinSql, type SqlClient } from "../src/server/postgres.ts";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { resetChannels } from "../src/runtime/channel.ts";
import { backend } from "../packages/backend/mod.ts";
import { db, onTableChange, type TableChangeEvent } from "../packages/backend/server.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import {
  COLUMN_TYPES_SQL,
  installRealtime,
  RealtimeEngine,
  realtimeEngine,
  rereadQuery,
  seedQuery,
} from "../packages/backend/src/realtime.ts";
import { resolveRealtime } from "../packages/backend/src/realtime-sql.ts";
import { postgresEnvironment } from "./helpers/postgres-env.ts";
import {
  authConfig,
  changesOf,
  cookieFor,
  type Harness,
  realtimeHarness,
  settle,
  until,
} from "./helpers/realtime-harness.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const SQL = builtinSql();
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";
const load = ((path: string) => import(path)) as unknown as ModuleLoader;

const A = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000a";
const B = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000b";

/** Notes readable by their owner, written by anyone signed in for themselves. */
const NOTES = `
  create table notes (id bigserial primary key, owner uuid not null, body text not null);
  alter table notes enable row level security;
  create policy "read own" on notes for select using (auth.uid() = owner);
  create policy "write own" on notes for insert with check (auth.uid() = owner);
  grant select, insert on notes to authenticated;
  grant select on notes to anon;
  grant usage on sequence notes_id_seq to authenticated;
`;

async function install(app: SqlClient): Promise<Harness> {
  resetPlugins();
  resetChannels();
  installPostgres(undefined);
  installRealtime(undefined);
  await applyPlugins({
    projectRoot: "/tmp/x",
    appDir: "/tmp/x/app",
    config: {
      plugins: [
        denextAuth(authConfig),
        backend({ postgres: { sql: app }, realtime: { tables: { notes: {} } } }),
      ],
    } as DenextConfig,
    mode: "prod",
    load,
  });
  // The RLS roles and auth.* come with the first scoped query; the policies use them.
  await db({ as: "anon" })`select 1`;
  await db.service().unsafe(NOTES).simple!();
  return realtimeHarness();
}

async function uninstall(hub: Harness | undefined): Promise<void> {
  hub?.dispose();
  await runPluginTeardown();
  resetPlugins();
  resetChannels();
  installPostgres(undefined);
  installRealtime(undefined);
}

Deno.test({
  name:
    `realtime on a real Postgres: per-subscriber RLS, updates, deletes, a 500-row burst${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let hub: Harness | undefined;
    try {
      hub = await install(env.app);
      const ca = hub.conn(await cookieFor(A));
      const cb = hub.conn(await cookieFor(B));
      assert((await hub.subscribe(ca, "notes")).ok, "A subscribed");
      assert((await hub.subscribe(cb, "notes")).ok, "B subscribed");

      // A writes under RLS (the trigger runs as `authenticated`): only A hears of it.
      const [{ id }] = await db({ as: { id: A } })<{ id: string }>`
        insert into notes (owner, body) values (${A}, ${"a's note"}) returning id::text as id`;
      await until(() => ca.frames.length === 1, 5_000, "A's insert");
      await settle(150);
      assertEquals(changesOf(ca), [{
        op: "insert",
        key: id,
        row: { id: Number(id), owner: A, body: "a's note" },
      }]);
      assertEquals(changesOf(cb), [], "B's policy hides A's note");

      // Handed to B (service): a delete for A, an insert for B.
      await db.service()`update notes set owner = ${B} where id = ${Number(id)}`;
      await until(() => ca.frames.length === 2 && cb.frames.length === 1, 5_000, "the handover");
      assertEquals(ca.frames[1].changes, [{ op: "delete", key: id }]);
      assertEquals(cb.frames[0].changes?.[0].op, "insert");

      // Deleted: B is told; A (who no longer sees it) is not.
      await db.service()`delete from notes where id = ${Number(id)}`;
      await until(() => cb.frames.length === 2, 5_000, "B's delete");
      await settle(150);
      assertEquals(cb.frames[1].changes, [{ op: "delete", key: id }]);
      assertEquals(ca.frames.length, 2);

      // 500 rows in one transaction: NOTIFY delivers them at commit, as one burst.
      const engine = realtimeEngine();
      const before = { ...engine.stats };
      const framesBefore = [ca.frames.length, cb.frames.length];
      await db.service().begin(async (tx) => {
        await tx.unsafe(
          `insert into notes (owner, body)
           select case when i % 2 = 1 then $1::uuid else $2::uuid end, 'note ' || i
           from generate_series(1, 500) as i`,
          [A, B],
        );
      });
      await until(
        () => changesOf(ca).length === 2 + 250 && changesOf(cb).length === 2 + 250,
        10_000,
        "the burst",
      );
      const flushes = engine.stats.flushes - before.flushes;
      const rereads = engine.stats.rereads - before.rereads;
      const frames = ca.frames.length - framesBefore[0] + cb.frames.length - framesBefore[1];
      assertEquals(engine.stats.notifications - before.notifications, 500);
      assert(flushes <= 3, `coalesced into ${flushes} flushes`);
      assert(rereads <= 2 * flushes, `${rereads} re-reads for 2 identities`);
      console.log(
        `real Postgres: 500 notifications → ${flushes} flush(es), ${rereads} re-reads, ${frames} frames`,
      );
      assert(changesOf(ca).slice(2).every((c) => c.op === "insert" && c.row?.owner === A));
    } finally {
      await uninstall(hub);
      await env.drop();
    }
  },
});

Deno.test({
  name: `realtime on a real Postgres: the listener reconnects after pg_terminate_backend${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let hub: Harness | undefined;
    try {
      hub = await install(env.app);
      const seen: Array<TableChangeEvent & { inRequest: boolean }> = [];
      type Bridge = { __denextCurrentRequestContext?: () => unknown };
      onTableChange("notes", (event) => {
        const inRequest = (globalThis as Bridge).__denextCurrentRequestContext?.() !== undefined;
        seen.push({ ...event, inRequest });
      });
      const ca = hub.conn(await cookieFor(A));
      assert((await hub.subscribe(ca, "notes")).ok);
      const engine = realtimeEngine();
      assertEquals(engine.stats.listens, 1);

      // A write made inside a request: the notification is handled in the root context.
      await runWithContext(createRequestContext(new Request("https://app.test/")), async () => {
        await db.service()`insert into notes (owner, body) values (${A}, ${"in a request"})`;
      });
      await until(() => seen.length === 1, 5_000, "the hook");
      assertEquals([seen[0].op, seen[0].inRequest], ["insert", false]);

      const killed = await env.admin.unsafe<{ ok: boolean }>(
        `select pg_terminate_backend(pid) as ok from pg_stat_activity
         where datname = $1 and query ilike 'listen%'`,
        [env.database],
      );
      assertEquals(killed.length, 1, "one listening connection per instance");
      await until(() => engine.stats.listens === 2, 15_000, "the re-LISTEN");
      await until(() => ca.frames.some((f) => f.resync), 5_000, "the resync frame");
      assert(seen.some((e) => e.op === "resync"));

      await db.service()`insert into notes (owner, body) values (${A}, ${"after"})`;
      await until(
        () => changesOf(ca).some((c) => c.op === "insert" && c.row?.body === "after"),
        5_000,
      );
    } finally {
      await uninstall(hub);
      await env.drop();
    }
  },
});

/** Two server instances' engines on one database: two clients, two listeners. */
async function twoInstances(
  env: { app: SqlClient; url: string },
  revalidate: boolean | { owner: "every" | "one" },
): Promise<{ engines: RealtimeEngine[]; clients: SqlClient[] }> {
  await env.app.unsafe("create table if not exists notes (id bigserial primary key, body text)");
  const clients = [env.app, new SQL!(env.url)];
  const engines = clients.map((client) =>
    new RealtimeEngine({ tables: { notes: {} }, revalidate }, () => client, () => Promise.resolve())
  );
  for (const engine of engines) await engine.start();
  return { engines, clients };
}

/** Insert one row and wait for every running engine's flush and ownership check. */
async function burst(app: SqlClient, engines: RealtimeEngine[]): Promise<number[]> {
  const before = engines.map((e) => e.stats.flushes);
  await app.unsafe("insert into notes (body) values ('x')");
  await until(() => engines.every((e, i) => e.stats.flushes > before[i]), 5_000, "the flushes");
  await settle(250); // the owner check is one round trip after the flush
  return engines.map((e) => e.stats.revalidations);
}

const OWNER_HOLDERS = `select pid from pg_locks where locktype = 'advisory'
  and classid = 1684369016 and objid = 1 and objsubid = 2 and granted
  and database = (select oid from pg_database where datname = $1)`;

Deno.test({
  name:
    `realtime on a real Postgres: revalidate owner "one" — one instance revalidates, with failover${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let engines: RealtimeEngine[] = [];
    let clients: SqlClient[] = [];
    try {
      ({ engines, clients } = await twoInstances(env, { owner: "one" }));
      const total = (counts: number[]) => counts.reduce((a, b) => a + b, 0);
      let counts = await burst(env.app, engines);
      assertEquals(total(counts), 1, `one instance revalidated (${counts})`);
      const owner = counts.indexOf(1);
      counts = await burst(env.app, engines);
      assertEquals(total(counts), 2);
      assertEquals(counts[owner], 2, "the same owner, every burst");
      assertEquals((await env.admin.unsafe(OWNER_HOLDERS, [env.database])).length, 1);

      // The owner's connection dies (the instance hung, the network dropped): its lock goes
      // with it, and the next burst is revalidated exactly once, by whoever takes the lock.
      const [{ pid }] = await env.admin.unsafe<{ pid: number }>(OWNER_HOLDERS, [env.database]);
      await env.admin.unsafe("select pg_terminate_backend($1)", [pid]);
      const deadline = Date.now() + 5_000;
      while ((await env.admin.unsafe(OWNER_HOLDERS, [env.database])).length > 0) {
        if (Date.now() > deadline) throw new Error("the terminated owner kept its lock");
        await settle(50);
      }
      let previous = counts;
      counts = await burst(env.app, engines);
      const failover = counts.map((n, i) => n - previous[i]);
      assertEquals(total(failover), 1, `failover revalidated once (${failover})`);
      const owning = failover.indexOf(1);
      previous = counts;
      counts = await burst(env.app, engines);
      assertEquals(counts.map((n, i) => n - previous[i])[owning], 1, "and keeps the lock");

      // The owner stops (a deploy): it gives the lock up, and the survivor takes over.
      await engines[owning].stop();
      const survivor = engines[1 - owning];
      const before = survivor.stats.revalidations;
      await burst(env.app, [survivor]);
      assertEquals(survivor.stats.revalidations - before, 1, "the survivor revalidates");
    } finally {
      for (const engine of engines) await engine.stop();
      if (clients[1]) await clients[1].close();
      await env.drop();
    }
  },
});

Deno.test({
  name: `realtime on a real Postgres: revalidate "every" — each instance revalidates${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let engines: RealtimeEngine[] = [];
    let clients: SqlClient[] = [];
    try {
      ({ engines, clients } = await twoInstances(env, true));
      assertEquals(await burst(env.app, engines), [1, 1]);
      assertEquals((await env.admin.unsafe(OWNER_HOLDERS, [env.database])).length, 0, "no lock");
    } finally {
      for (const engine of engines) await engine.stop();
      if (clients[1]) await clients[1].close();
      await env.drop();
    }
  },
});

/** The plan of `text` with `params`, as one string. */
async function plan(sql: SqlClient, text: string, params: unknown[]): Promise<string> {
  const rows = await sql.unsafe<Record<string, string>>(`explain ${text}`, params);
  return rows.map((row) => Object.values(row)[0]).join("\n");
}

Deno.test({
  name: `realtime on a real Postgres: re-reads and seeds use the key and filter indexes${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    try {
      await env.app.unsafe(`
        create table ikeys (id integer primary key, list_id integer not null, body text);
        create index ikeys_list on ikeys (list_id);
        insert into ikeys select g, g % 500, 'row ' || g from generate_series(1, 50000) g;
        create table ukeys (id uuid primary key, body text);
        insert into ukeys select gen_random_uuid(), 'row ' || g from generate_series(1, 50000) g;
        analyze ikeys; analyze ukeys;
      `).simple!();
      const tables = resolveRealtime({ tables: { ikeys: {}, ukeys: {} } }).tables;
      const typesOf = async (qualified: string) =>
        new Map(
          (await env.app.unsafe<{ name: string; type: string }>(COLUMN_TYPES_SQL, [qualified]))
            .map((row) => [row.name, row.type]),
        );
      const ints = await typesOf('"ikeys"');
      assertEquals(ints.get("id"), "integer");
      const uuids = await typesOf('"ukeys"');
      assertEquals(uuids.get("id"), "uuid");
      const someUuids = (await env.app.unsafe<{ id: string }>(
        "select id::text as id from ukeys limit 3",
      )).map((row) => row.id);

      const plans = {
        "integer key": await plan(
          env.app,
          ...spread(rereadQuery(tables.get("ikeys")!, undefined, ["7", "42", "4242"], ints)),
        ),
        "integer key + filter": await plan(
          env.app,
          ...spread(
            rereadQuery(
              tables.get("ikeys")!,
              { column: "list_id", value: "7" },
              ["7", "507"],
              ints,
            ),
          ),
        ),
        "uuid key": await plan(
          env.app,
          ...spread(rereadQuery(tables.get("ukeys")!, undefined, someUuids, uuids)),
        ),
        "seed with a filter": await plan(
          env.app,
          ...spread(
            seedQuery(tables.get("ikeys")!, { column: "list_id", value: "7" }, 10_000, ints),
          ),
        ),
        // The shape before: the key compared as text — no index can serve it.
        "integer key as text (before)": await plan(
          env.app,
          ...spread(rereadQuery(tables.get("ikeys")!, undefined, ["7", "42"], new Map())),
        ),
      };
      for (const [what, text] of Object.entries(plans)) console.log(`EXPLAIN ${what}:\n${text}\n`);
      assert(usesIndex(plans["integer key"], "ikeys_pkey"), plans["integer key"]);
      assert(usesIndex(plans["integer key + filter"], "ikeys_pkey"), plans["integer key + filter"]);
      assert(usesIndex(plans["uuid key"], "ukeys_pkey"), plans["uuid key"]);
      assert(usesIndex(plans["seed with a filter"], "ikeys_list"), plans["seed with a filter"]);
      for (
        const what of ["integer key", "integer key + filter", "uuid key", "seed with a filter"]
      ) {
        assert(!/Seq Scan/.test(plans[what as keyof typeof plans]), `${what}: no Seq Scan`);
      }
      assert(/Seq Scan on ikeys/.test(plans["integer key as text (before)"]));
    } finally {
      await env.drop();
    }
  },
});

/** Whether a plan reads `index` (an index scan, index-only scan or bitmap index scan). */
function usesIndex(text: string, index: string): boolean {
  return new RegExp(`(Index (Only )?Scan using|Bitmap Index Scan on) ${index}\\b`).test(text);
}

/** A query as `plan`'s arguments. */
function spread(query: { text: string; params: unknown[] }): [string, unknown[]] {
  return [query.text, query.params];
}
