// `@denext/backend` realtime against a REAL Postgres: the migration installs the trigger function
// and the triggers, NOTIFY reaches the one listener at commit, and each subscriber (on the real
// Live channel hub, driven without a socket) gets the rows its own row-level-security policies
// return — two users, a visibility change on update, deletes, a 500-row transaction coalesced, the
// listener reconnecting after `pg_terminate_backend`, and notifications handled in the root
// context, a timestamp key read back as the notification spells it, a timestamptz key matched
// across a writer and a reader in different TimeZones — and that the re-read and seed
// queries are index scans on an integer, a uuid and a timestamp key (EXPLAIN); subscriptions are
// capped per identity, and flushes stay single-flight while a slow policy holds a re-read. The app
// connects as a non-superuser role that owns its database.
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
import { type RealtimeOptions, resolveRealtime } from "../packages/backend/src/realtime-sql.ts";
import { LogicalSource } from "../packages/backend/src/realtime-logical.ts";
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

/** Rows keyed by a timestamp: `to_jsonb` spells it `2026-01-02T03:04:05.5`, `::text` with a space. */
const STAMPS = `
  create table stamps (at timestamp primary key, body text not null);
  grant select on stamps to authenticated;
`;

async function install(
  app: SqlClient,
  tables: Record<string, { key?: string }> = { notes: {} },
  ddl = NOTES,
  options: Omit<RealtimeOptions, "tables"> = {},
): Promise<Harness> {
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
        backend({ postgres: { sql: app }, realtime: { ...options, tables } }),
      ],
    } as DenextConfig,
    mode: "prod",
    load,
  });
  // The RLS roles and auth.* come with the first scoped query; the policies use them.
  await db({ as: "anon" })`select 1`;
  await db.service().unsafe(ddl).simple!();
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

      // TRUNCATE: the statement-level trigger's notification tells every subscriber who could
      // see rows to forget them (no row data), and the server hooks hear it.
      const truncates: TableChangeEvent[] = [];
      const off = onTableChange("notes", (event) => {
        if (event.op === "truncate") truncates.push(event);
      });
      await db.service()`truncate notes`;
      await until(
        () => changesOf(ca).at(-1)?.op === "truncate" && changesOf(cb).at(-1)?.op === "truncate",
        5_000,
        "the truncate",
      );
      assertEquals(changesOf(ca).at(-1), { op: "truncate" });
      assertEquals(truncates.length, 1);
      assertEquals(truncates[0].table, "notes");
      off();
      // After it, both views start empty: the next row is an insert again.
      await db.service()`insert into notes (owner, body) values (${A}, ${"after"})`;
      await until(() => changesOf(ca).at(-1)?.op === "insert", 5_000, "the insert after");
    } finally {
      await uninstall(hub);
      await env.drop();
    }
  },
});

Deno.test({
  name:
    `realtime on a real Postgres: a timestamp key reads back as the notification spells it${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let hub: Harness | undefined;
    try {
      hub = await install(env.app, { stamps: { key: "at" } }, STAMPS);
      // Seeded before the subscription: its key is tracked as the seed query returns it.
      await db.service()`insert into stamps (at, body) values ('2026-01-02 03:04:05', 'seeded')`;
      await settle(150); // its notification (if heard at all) lands before anyone subscribes
      const ca = hub.conn(await cookieFor(A));
      assert((await hub.subscribe(ca, "stamps")).ok);

      // An insert: the re-read row is matched to the notification's key.
      await db.service()`insert into stamps (at, body) values ('2026-01-02 03:04:06.5', 'new')`;
      await until(() => ca.frames.length === 1, 5_000, "the insert");
      assertEquals(changesOf(ca), [{
        op: "insert",
        key: "2026-01-02T03:04:06.5",
        row: { at: "2026-01-02T03:04:06.5", body: "new" },
      }]);

      // A delete of the seeded row: sent, since the seeded key matches the notification's.
      await db.service()`delete from stamps where at = '2026-01-02 03:04:05'`;
      await until(() => ca.frames.length === 2, 5_000, "the delete");
      assertEquals(ca.frames[1].changes, [{ op: "delete", key: "2026-01-02T03:04:05" }]);
    } finally {
      await uninstall(hub);
      await env.drop();
    }
  },
});

/** Rows keyed by a `timestamptz`: `to_jsonb` spells it with the session TimeZone's offset. */
const INSTANTS = `
  create table instants (at timestamptz primary key, body text not null);
  grant select on instants to authenticated;
`;

Deno.test({
  name:
    `realtime on a real Postgres: a timestamptz key matches across writer and reader TimeZones${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let hub: Harness | undefined;
    try {
      // The app's own sessions (the re-reads and seeds) run in UTC…
      await env.admin.unsafe(`alter database ${env.database} set timezone = 'UTC'`);
      hub = await install(env.app, { instants: { key: "at" } }, INSTANTS);
      // …while the writer's session is in New York: its to_jsonb spells the instant at -05:00.
      const write = (statement: string) =>
        db.service().begin(async (tx) => {
          await tx.unsafe("set local timezone = 'America/New_York'");
          await tx.unsafe(statement);
        });
      await write(`insert into instants values ('2026-01-02 03:04:05+00', 'seeded')`);
      await settle(150); // its notification (if heard at all) lands before anyone subscribes
      const ca = hub.conn(await cookieFor(A));
      assert((await hub.subscribe(ca, "instants")).ok);

      await write(`insert into instants values ('2026-01-02 03:04:06.5+00', 'new')`);
      await until(() => ca.frames.length === 1, 5_000, "the insert");
      // The row itself is read in the reader's session: its timestamptz at +00:00.
      assertEquals(changesOf(ca), [{
        op: "insert",
        key: "2026-01-02T03:04:06.5",
        row: { at: "2026-01-02T03:04:06.5+00:00", body: "new" },
      }]);

      // The seeded row, deleted from New York: its key matches the one the seed tracked.
      await write(`delete from instants where at = '2026-01-02 03:04:05+00'`);
      await until(() => ca.frames.length === 2, 5_000, "the delete");
      assertEquals(ca.frames[1].changes, [{ op: "delete", key: "2026-01-02T03:04:05" }]);
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
        create table tkeys (at timestamp primary key, body text);
        insert into tkeys select timestamp '2026-01-01' + g * interval '1.5 seconds', 'row ' || g
          from generate_series(1, 50000) g;
        analyze ikeys; analyze ukeys; analyze tkeys;
      `).simple!();
      const tables =
        resolveRealtime({ tables: { ikeys: {}, ukeys: {}, tkeys: { key: "at" } } }).tables;
      const typesOf = async (qualified: string) =>
        new Map(
          (await env.app.unsafe<{ name: string; type: string }>(COLUMN_TYPES_SQL, [qualified]))
            .map((row) => [row.name, row.type]),
        );
      const ints = await typesOf('"ikeys"');
      assertEquals(ints.get("id"), "integer");
      const uuids = await typesOf('"ukeys"');
      assertEquals(uuids.get("id"), "uuid");
      const stamps = await typesOf('"tkeys"');
      assertEquals(stamps.get("at"), "timestamp without time zone");
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
        // Keys as the notification spells them (JSON's `T`), cast back to the key's type.
        "timestamp key": await plan(
          env.app,
          ...spread(
            rereadQuery(
              tables.get("tkeys")!,
              undefined,
              ["2026-01-01T00:00:01.5", "2026-01-01T00:00:03"],
              stamps,
            ),
          ),
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
      assert(usesIndex(plans["timestamp key"], "tkeys_pkey"), plans["timestamp key"]);
      assert(usesIndex(plans["seed with a filter"], "ikeys_list"), plans["seed with a filter"]);
      for (
        const what of [
          "integer key",
          "integer key + filter",
          "uuid key",
          "timestamp key",
          "seed with a filter",
        ]
      ) {
        assert(!/Seq Scan/.test(plans[what as keyof typeof plans]), `${what}: no Seq Scan`);
      }
      assert(/Seq Scan on ikeys/.test(plans["integer key as text (before)"]));
    } finally {
      await env.drop();
    }
  },
});

Deno.test({
  name:
    `realtime on a real Postgres: seeds and re-reads spell every key type as the trigger does${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    try {
      // One table per key type, with the values whose text forms differ most.
      const keys: Record<string, [string, string]> = {
        int: ["integer", "(-2147483648), (0), (42)"],
        big: ["bigint", "(9007199254740993), (-1)"],
        uid: [
          "uuid",
          "('0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000a'), ('00000000-0000-0000-0000-000000000000')",
        ],
        txt: ["text", `('plain'), ('it''s "quoted"'), ('ünï ☃'), ('back\\slash'), ('')`],
        num: ["numeric", "(1.50), (-0.000), (1e20), (3.14159265358979323846)"],
        ts: [
          "timestamp",
          "('2026-01-02 03:04:05.5'), ('2026-01-02 00:00:00'), ('1999-12-31 23:59:59.999999')",
        ],
        tz: ["timestamptz", "('2026-01-02 03:04:05.5+02')"],
      };
      for (const [table, [type, values]] of Object.entries(keys)) {
        await env.app.unsafe(
          `create table k_${table} (k ${type} primary key); insert into k_${table} values ${values};`,
        ).simple!();
      }
      const tables = resolveRealtime({
        tables: Object.fromEntries(Object.keys(keys).map((t) => [`k_${t}`, { key: "k" }])),
      }).tables;
      for (const [table, [type]] of Object.entries(keys)) {
        const name = `k_${table}`;
        // What the trigger puts in a notification: `to_jsonb(row) ->> key` (a timestamptz in UTC).
        const value = type === "timestamptz" ? `t.k at time zone 'UTC'` : "t.k";
        const trigger = (await env.app.unsafe<{ k: string }>(
          `select to_jsonb(${value}) #>> '{}' as k from ${name} t order by t.k`,
        )).map((row) => row.k);
        const types = new Map([["k", type === "timestamptz" ? "timestamp with time zone" : type]]);
        const seeded = (await env.app.unsafe<{ k: string }>(
          ...spread(seedQuery(tables.get(name)!, undefined, 100, types)),
        )).map((row) => row.k).sort();
        assertEquals(seeded, [...trigger].sort(), `${type}: the seed spells keys as the trigger`);
        const reread = (await env.app.unsafe<{ k: string }>(
          ...spread(rereadQuery(tables.get(name)!, undefined, trigger, types)),
        )).map((row) => row.k).sort();
        assertEquals(reread, [...trigger].sort(), `${type}: a re-read finds and spells every key`);
      }
    } finally {
      await env.drop();
    }
  },
});

/** Notes whose read policy sleeps, so every seed and re-read takes ~300 ms on the server. */
const SLOW_NOTES = `
  create table notes (id bigserial primary key, owner uuid not null, body text not null);
  alter table notes enable row level security;
  create policy "read own, slowly" on notes for select
    using (auth.uid() = owner and (select true from pg_sleep(0.3)));
  grant select on notes to authenticated;
  grant select on notes to anon;
`;

Deno.test({
  name:
    `realtime on a real Postgres: subscriptions are capped per identity; deliveries go on${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let hub: Harness | undefined;
    try {
      hub = await install(env.app, { notes: {} }, NOTES, { maxSubscriptionsPerIdentity: 2 });
      const cookieA = await cookieFor(A);
      // A, in two tabs: two subscriptions, and the third is refused.
      const [tab1, tab2] = [hub.conn(cookieA), hub.conn(cookieA)];
      assert((await hub.subscribe(tab1, "notes", { subId: "1" })).ok);
      assert((await hub.subscribe(tab2, "notes", { subId: "2", filter: { owner: A } })).ok);
      assertEquals((await hub.subscribe(tab2, "notes", { subId: "3" })).ok, false);
      assertEquals(tab2.errors, ["deny"]);
      // B's quota is B's own; a signed-out connection has one of its own too.
      const cb = hub.conn(await cookieFor(B));
      assert((await hub.subscribe(cb, "notes")).ok, "B is not counted against A");
      const anon = hub.conn();
      assert((await hub.subscribe(anon, "notes", { subId: "1" })).ok);
      assert((await hub.subscribe(anon, "notes", { subId: "2" })).ok);
      assertEquals((await hub.subscribe(anon, "notes", { subId: "3" })).ok, false);
      assertEquals(realtimeEngine().size, 5);

      // The admitted subscriptions still get A's rows (and only them), the refused one nothing.
      const [{ id }] = await db({ as: { id: A } })<{ id: string }>`
        insert into notes (owner, body) values (${A}, 'capped') returning id::text as id`;
      await until(() => changesOf(tab1).length === 1 && changesOf(tab2).length === 1, 5_000);
      await settle(150);
      for (const conn of [tab1, tab2]) {
        assertEquals(changesOf(conn).map((c) => [c.op, c.key]), [["insert", id]]);
      }
      assertEquals([changesOf(cb), changesOf(anon)], [[], []], "RLS hides A's row");
    } finally {
      await uninstall(hub);
      await env.drop();
    }
  },
});

Deno.test({
  name:
    `realtime on a real Postgres: flushes are single-flight — a burst during a slow re-read waits${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let hub: Harness | undefined;
    try {
      hub = await install(env.app, { notes: {} }, SLOW_NOTES);
      const ca = hub.conn(await cookieFor(A));
      assert((await hub.subscribe(ca, "notes")).ok);
      const engine = realtimeEngine();
      const before = { ...engine.stats };
      const insert = (body: string) =>
        db.service()`insert into notes (owner, body) values (${A}, ${body})`;
      await insert("first");
      // Its flush has started (the counter moves first), and its re-read sleeps on the server…
      await until(() => engine.stats.flushes === before.flushes + 1, 5_000, "the first flush");
      // …while two more bursts arrive, each past the coalescing window of the one before.
      await insert("second");
      await settle(40);
      await insert("third");
      await until(() => changesOf(ca).length === 3, 10_000, "all three");
      await settle(400);
      assertEquals(changesOf(ca).map((c) => c.op === "insert" ? c.row?.body : c.op), [
        "first",
        "second",
        "third",
      ]);
      assertEquals(engine.stats.notifications - before.notifications, 3);
      assertEquals(engine.stats.flushes - before.flushes, 2, "the later bursts went out together");
      assertEquals(engine.stats.rereads - before.rereads, 2, "one re-read per flush");
    } finally {
      await uninstall(hub);
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

// The same TRUNCATE read from the WAL (`source: "logical"`, a pgoutput Truncate message): needs a
// server with wal_level = logical (`DENEXT_TEST_POSTGRES_LOGICAL=1` says it has one).
const logicalReason = reason ??
  (Deno.env.get("DENEXT_TEST_POSTGRES_LOGICAL") === "1"
    ? undefined
    : "set DENEXT_TEST_POSTGRES_LOGICAL=1");

Deno.test({
  name: `realtime on a real Postgres: TRUNCATE from logical decoding reaches who could see rows${
    logicalReason ? ` (skipped: ${logicalReason})` : ""
  }`,
  ignore: logicalReason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let hub: Harness | undefined;
    try {
      await env.admin.unsafe(`alter role ${new URL(env.url).username} replication`);
      hub = await install(env.app, { notes: {} }, NOTES, {
        source: "logical",
        logical: { pollMs: 20 },
      });
      const ca = hub.conn(await cookieFor(A));
      const cb = hub.conn(await cookieFor(B));
      assert((await hub.subscribe(ca, "notes")).ok, "A subscribed");
      assert((await hub.subscribe(cb, "notes")).ok, "B subscribed");
      await db({ as: { id: A } })`insert into notes (owner, body) values (${A}, ${"from the WAL"})`;
      await until(() => ca.frames.length === 1, 10_000, "A's insert");
      await db.service()`truncate notes`;
      await until(() => ca.frames.length === 2, 10_000, "the truncate");
      assertEquals(ca.frames[1].changes, [{ op: "truncate" }]);
      await settle(150);
      assertEquals(changesOf(cb), [], "B saw no rows: nothing to clear");
      const triggers = await env.app.unsafe(
        "select tgname from pg_trigger where tgname like 'denext_realtime%' and tgenabled <> 'D'",
      );
      assertEquals(triggers.length, 0, "no trigger on the write path");
    } finally {
      await uninstall(hub);
      await env.drop();
    }
  },
});

Deno.test({
  name: `realtime on a real Postgres: a failed logical read drops its slot and the source reopens${
    logicalReason ? ` (skipped: ${logicalReason})` : ""
  }`,
  ignore: logicalReason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    const error = console.error;
    console.error = () => {};
    let source: LogicalSource | undefined;
    const held: Array<{ release(): void | Promise<void> }> = [];
    try {
      await env.admin.unsafe(`alter role ${new URL(env.url).username} replication`);
      await env.app.unsafe("create table notes (id bigserial primary key, body text not null)");
      await env.app.unsafe("create publication dnx_pub for table notes");
      const table = resolveRealtime({ tables: { notes: {} } }).tables.get("notes")!;
      const keys: string[] = [];
      let resyncs = 0;
      let throwOnce = true;
      // The reopen must land on another pooled connection (as it can on a busy pool): the
      // second reservation first takes the connection just returned and holds it.
      let reserves = 0;
      const sql = {
        reserve: async () => {
          if (++reserves === 2) held.push(await env.app.reserve!());
          return await env.app.reserve!();
        },
      } as unknown as SqlClient;
      source = new LogicalSource({
        client: () => sql,
        publications: () => ["dnx_pub"],
        tableOf: (_schema, name) => name === "notes" ? table : null,
        emit: (event) => {
          // A read that fails with its session alive (here: a throw while decoding it).
          if (throwOnce) {
            throwOnce = false;
            throw new Error("decode failed");
          }
          if (event.key) keys.push(event.key);
        },
        resync: () => void resyncs++,
        pollMs: 20,
        maxChanges: 100,
      });
      await source.start();
      await env.app`insert into notes (body) values ('lost to the failed read')`;
      // Before the fix the old slot stayed on the pooled connection, pinning WAL: re-creating
      // it elsewhere failed ("already exists") on every retry, and no change was read again.
      await until(() => resyncs === 1, 10_000, "the source reopened");
      await env.app`insert into notes (body) values ('after the reopen')`;
      await until(() => keys.length === 1, 10_000, "a change read on the new slot");
      const slots = await env.admin.unsafe<{ n: number }>(
        "select count(*)::int as n from pg_replication_slots where database = $1",
        [env.database],
      );
      assertEquals(slots[0].n, 1, "only the live slot is left");
    } finally {
      await source?.stop();
      for (const conn of held) await conn.release();
      console.error = error;
      await env.drop();
    }
  },
});

Deno.test({
  name: `realtime on a real Postgres: trigger DDL waits for the backend's migration lock${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let hub: Harness | undefined;
    let release = () => {};
    let held: Promise<unknown> = Promise.resolve();
    try {
      hub = await install(env.app, {}, `${NOTES}\ncreate publication dnx_lock_pub;`, {
        publication: "dnx_lock_pub",
      });
      // Start (the realtime migrations apply), keeping the publication's re-read to call by hand.
      const real = globalThis.setInterval;
      let tick: (() => void) | undefined;
      globalThis.setInterval = ((handler: () => void, ms?: number) => {
        if (ms === 10_000) tick = handler;
        return real(handler, ms);
      }) as typeof setInterval;
      try {
        await realtimeEngine().start();
      } finally {
        globalThis.setInterval = real;
      }
      // Another instance is mid-migration: it holds the lock every boot migration takes.
      let locked = () => {};
      const isLocked = new Promise<void>((resolve) => locked = resolve);
      held = env.app.begin(async (tx) => {
        await tx.unsafe("select pg_advisory_xact_lock(hashtext($1))", [
          'denext:migrate:"backend_migrations"',
        ]);
        locked();
        await new Promise<void>((resolve) => release = resolve);
      });
      await isLocked;
      await db.service()`alter publication dnx_lock_pub add table notes`;
      tick!();
      const triggers = () =>
        env.app.unsafe("select 1 from pg_trigger where tgname = 'denext_realtime'");
      await settle(400);
      assertEquals((await triggers()).length, 0, "the trigger waits for the lock");
      release();
      await held;
      const deadline = Date.now() + 10_000;
      while ((await triggers()).length === 0) {
        assert(Date.now() < deadline, "the trigger is created once the lock is free");
        await settle(20);
      }
    } finally {
      release();
      await held.catch(() => {});
      await uninstall(hub);
      await env.drop();
    }
  },
});

/** Notes on lists, readable by their owner. */
const LISTED = `
  create table listed (id bigint primary key, owner uuid not null, list int, body text not null);
  alter table listed enable row level security;
  create policy "read own" on listed for select using (auth.uid() = owner);
  grant select on listed to authenticated;
`;

Deno.test({
  name:
    `realtime on a real Postgres: one identity's filters share one re-read; a reconnect is replayed under RLS${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    let hub: Harness | undefined;
    try {
      hub = await install(env.app, { listed: {} }, LISTED);
      const service = db.service();
      await service`insert into listed (id, owner, list, body) values
        (10, ${A}, 1, 'a, seeded'), (20, ${B}, 1, 'b, seeded')`;
      await settle(150);
      const a = await cookieFor(A);
      const all = hub.conn(a);
      const one = hub.conn(a);
      const two = hub.conn(a);
      const nulls = hub.conn(a);
      const { key } = await hub.subscribe(all, "listed");
      assert((await hub.subscribe(one, "listed", { filter: { list: 1 } })).ok);
      assert((await hub.subscribe(two, "listed", { filter: "list=in.(2,3)" })).ok);
      assert((await hub.subscribe(nulls, "listed", { filter: { list: { gt: 0 } } })).ok);

      // One burst, four filters of one identity: one combined re-read, each gets its own rows (a
      // NULL list matches no comparison).
      const engine = realtimeEngine();
      const before = { ...engine.stats };
      await service`insert into listed (id, owner, list, body) values
        (1, ${A}, 1, 'one'), (2, ${A}, 2, 'two'), (3, ${A}, null, 'none'), (4, ${B}, 1, 'b')`;
      await until(() => changesOf(all).length === 3, 5_000, "the unfiltered subscription's rows");
      await until(() => changesOf(nulls).length === 2, 5_000, "list > 0");
      await settle(150);
      assertEquals(changesOf(all).map((c) => c.key), ["1", "2", "3"]);
      assertEquals(changesOf(one).map((c) => c.key), ["1"]);
      assertEquals(changesOf(two).map((c) => c.key), ["2"]);
      assertEquals(changesOf(nulls).map((c) => c.key), ["1", "2"]);
      const flushes = engine.stats.flushes - before.flushes;
      assertEquals(engine.stats.rereads - before.rereads, flushes, "one re-read per burst");

      // The unfiltered subscription's socket drops; changes happen; it reconnects.
      hub.drop(all);
      await service`update listed set body = 'edited' where id = 1`;
      await service`delete from listed where id = 10`; // A could see it: replayed as a delete
      await service`delete from listed where id = 20`; // B's: never A's to hear about
      await service`insert into listed (id, owner, list, body) values (5, ${A}, 3, 'away')`;
      await service`update listed set owner = ${B} where id = 2`; // left A's view
      // The live subscriptions have them (so the journal does too).
      await until(
        () => changesOf(one).length === 3 && changesOf(two).length === 3,
        5_000,
        "the changes, live",
      );
      const back = hub.conn(a);
      assert((await hub.subscribe(back, "listed", { key })).ok);
      await until(() => back.frames.length === 2, 5_000, "resumed + the replay");
      assertEquals(back.frames[0].resumed, true);
      assertEquals(back.frames[0].seq, all.frames.at(-1)!.seq + 1, "numbered on");
      const replayed = back.frames[1].changes!.map((c) => [c.op, c.key]);
      assertEquals(replayed.sort(), [
        ["delete", "10"],
        ["delete", "2"],
        ["insert", "5"],
        ["update", "1"],
      ]);
    } finally {
      await uninstall(hub);
      await env.drop();
    }
  },
});
