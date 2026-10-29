// `denext migration` / `denext db` on a real Postgres:
//
// - a Supabase project — `supabase/migrations/` plus the history the Supabase CLI wrote in
//   `supabase_migrations.schema_migrations` — is listed, migrated up, rolled back with its down
//   scripts, reset to a version (`--force-reset`), re-applied, repaired and fetched back to files,
//   with the history staying in the Supabase CLI's shape throughout;
// - denext's own `_migrations` history with `migrations/`;
// - `@denext/backend`'s Postgres tooling: lint, inspect, types, pull and pgTAP tests.
//
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     denext test -A tests/db-migrations-integration.test.ts
//
// Ignored without DENEXT_TEST_POSTGRES_URL or Deno.SQL (denext's Deno toolchain).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { builtinSql } from "../src/server/postgres.ts";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { DB_ACTIONS } from "../src/cli/commands/db.ts";
import { MIGRATION_ACTIONS } from "../src/cli/commands/migration.ts";
import type { MigrationRun } from "../src/cli/db/migrations.ts";
import { backend } from "../packages/backend/mod.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { postgresEnvironment as environment } from "./helpers/postgres-env.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const SQL = builtinSql();
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";
const load = ((path: string) => import(path)) as unknown as ModuleLoader;

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  }
}

/** Run an action against `url`; resolves its output. */
function runner(root: string, url: string) {
  return async (
    table: Record<string, (run: MigrationRun) => Promise<void>>,
    positionals: string[],
    flags: Record<string, string | number | boolean> = {},
    json = false,
  ): Promise<string> => {
    const lines: string[] = [];
    await table[positionals[0]]({
      ctx: {
        positionals,
        flags: { "db-url": url, ...flags },
        global: { cwd: root, json, verbose: false, quiet: false },
        rest: [],
      },
      projectDir: root,
      io: { log: (l) => lines.push(l), error: (l) => lines.push(`error: ${l}`) },
      env: () => undefined,
    });
    return lines.join("\n");
  };
}

const INIT = `-- migrate:up
create table todos (id bigint generated always as identity primary key, title text not null);
alter table todos enable row level security;
create policy "read todos" on todos for select using (true);
-- migrate:down
drop table todos;
`;
const ADD_DONE = "alter table todos add column done boolean not null default false;\n";
const VIEW = `-- migrate:up
create view open_todos with (security_invoker = on) as select * from todos where not done;
create function todo_count() returns bigint language sql set search_path = '' as $$
  select count(*) from public.todos;
$$;
-- migrate:down
drop function todo_count();
drop view open_todos;
`;

Deno.test({
  name:
    `a Supabase project's migrations and history: list, up, down, force-reset, repair, fetch${label}`,
  ignore: reason !== undefined,
  async fn() {
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-supa-mig-" });
    try {
      await write(root, {
        "supabase/migrations/20240101000000_init.sql": INIT,
        "supabase/migrations/20240102000000_add_done.sql": ADD_DONE,
        "supabase/migrations/20240102000000_add_done.down.sql":
          "alter table todos drop column done;\n",
        "supabase/migrations/20240103000000_view.sql": VIEW,
        "supabase/seed.sql": "insert into todos (title) values ('seeded');\n",
      });
      // What `supabase db push` leaves behind for the first migration: its objects and its row.
      await env.app.unsafe(INIT.split("-- migrate:down")[0]).simple!();
      await env.app.unsafe(`
        create schema supabase_migrations;
        create table supabase_migrations.schema_migrations (version text not null primary key,
          statements text[], name text, created_by text, idempotency_key text unique);
        insert into supabase_migrations.schema_migrations (version, statements, name) values
          ('20240101000000', array['create table todos (id bigint generated always as identity primary key, title text not null)',
          'alter table todos enable row level security',
          'create policy "read todos" on todos for select using (true)'], 'init');
      `).simple!();
      const run = runner(root, env.url);
      const history = async () => [
        ...await env.app`select version, name, array_length(statements, 1) as n
          from supabase_migrations.schema_migrations order by version`,
      ];

      const listed = JSON.parse(await run(MIGRATION_ACTIONS, ["list"], {}, true));
      assertEquals(listed.history, "supabase_migrations.schema_migrations");
      assertEquals(
        listed.migrations.map((m: { version: string; remote: boolean }) => [m.version, m.remote]),
        [["20240101000000", true], ["20240102000000", false], ["20240103000000", false]],
      );
      const up = await run(MIGRATION_ACTIONS, ["up"]);
      assertStringIncludes(up, "applied 20240102000000_add_done.sql");
      assertStringIncludes(up, "applied 20240103000000_view.sql");
      assertEquals((await history()).map((r) => [r.version, r.name]), [
        ["20240101000000", "init"],
        ["20240102000000", "add_done"],
        ["20240103000000", "view"],
      ]);
      assertEquals((await env.app`select todo_count()::int as n`)[0].n, 0);
      // The Supabase CLI's extra columns are left alone (a reset recreates the table in its base shape).
      const cols = await env.app`select column_name from information_schema.columns
        where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'`;
      assert(cols.some((c) => c.column_name === "idempotency_key"));

      // Roll back two with their down scripts.
      const down = await run(DB_ACTIONS, ["rollback"], { steps: 2 });
      assertEquals(
        down,
        "  reverted 20240103000000_view.sql\n  reverted 20240102000000_add_done.sql",
      );
      assertEquals((await history()).map((r) => r.version), ["20240101000000"]);
      const columns = await env.app`select column_name from information_schema.columns
        where table_name = 'todos' order by ordinal_position`;
      assertEquals(columns.map((c) => c.column_name), ["id", "title"]);
      await run(DB_ACTIONS, ["migrate"], { to: "20240102000000" });
      assertEquals((await history()).map((r) => r.version), ["20240101000000", "20240102000000"]);
      await run(DB_ACTIONS, ["migrate"]);

      // Supabase's `migration down`: reset, re-apply up to the version before the last one, seed.
      await assertRejects(
        () => run(DB_ACTIONS, ["rollback"], { "force-reset": true }),
        Error,
        "--yes",
      );
      const reset = await run(DB_ACTIONS, ["rollback"], { "force-reset": true, yes: true });
      assertStringIncludes(reset, "seeded from supabase/seed.sql");
      assertEquals((await history()).map((r) => r.version), ["20240101000000", "20240102000000"]);
      assertEquals((await env.app`select title, done from todos`)[0], {
        title: "seeded",
        done: false,
      });
      const views = await env
        .app`select count(*)::int as n from pg_views where viewname = 'open_todos'`;
      assertEquals(views[0].n, 0);

      // Re-apply; then repair and fetch.
      await run(MIGRATION_ACTIONS, ["up"]);
      await run(MIGRATION_ACTIONS, ["repair", "20240103000000"], { status: "reverted" });
      assertEquals((await history()).length, 2);
      await run(MIGRATION_ACTIONS, ["repair", "20240103000000"], { status: "applied" });
      const recorded = (await history())[2];
      assertEquals([recorded.name, recorded.n], ["view", 1]);
      const fetchRoot = await Deno.makeTempDir({ prefix: "dnx-supa-fetch-" });
      try {
        const fetched = await runner(fetchRoot, env.url)(MIGRATION_ACTIONS, ["fetch"]);
        assertStringIncludes(fetched, "wrote supabase/migrations/20240101000000_init.sql");
        const init = await Deno.readTextFile(
          `${fetchRoot}/supabase/migrations/20240101000000_init.sql`,
        );
        assertEquals(init.split(";\n").length, 4, init); // three statements, joined as Supabase does
        const view = await Deno.readTextFile(
          `${fetchRoot}/supabase/migrations/20240103000000_view.sql`,
        );
        assertStringIncludes(view, "create view open_todos");
        assert(!view.includes("drop view"), "only the up script is recorded");
        assertStringIncludes(
          await runner(fetchRoot, env.url)(MIGRATION_ACTIONS, ["fetch"]),
          "exists, skipped",
        );
      } finally {
        await Deno.remove(fetchRoot, { recursive: true });
      }
    } finally {
      await Deno.remove(root, { recursive: true });
      await env.drop();
    }
  },
});

Deno.test({
  name:
    `denext's _migrations history on Postgres: up, down, reset, and a migration's own BEGIN${label}`,
  ignore: reason !== undefined,
  async fn() {
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-pg-mig-" });
    try {
      await write(root, {
        "migrations/20260101000000_a.sql":
          "-- migrate:up\ncreate table a (id int);\n-- migrate:down\ndrop table a;\n",
        "migrations/20260102000000_b.sql": "create table b (id int);\n",
      });
      const run = runner(root, env.url);
      await run(MIGRATION_ACTIONS, ["up"]);
      const rows = await env.app`select name, checksum from _migrations order by name`;
      assertEquals(rows.map((r) => r.name), ["20260101000000_a.sql", "20260102000000_b.sql"]);
      await assertRejects(() => run(MIGRATION_ACTIONS, ["down"]), Error, "no down script");
      await write(root, { "migrations/20260102000000_b.down.sql": "drop table b;" });
      await run(MIGRATION_ACTIONS, ["down"], { to: "0" });
      assertEquals((await env.app`select count(*)::int as n from _migrations`)[0].n, 0);
      // A changed applied file is flagged.
      await run(MIGRATION_ACTIONS, ["up"]);
      await write(root, { "migrations/20260102000000_b.sql": "create table b (id bigint);\n" });
      assertStringIncludes(await run(MIGRATION_ACTIONS, ["list"]), "changed since applied");
      await write(root, {
        "migrations/20260103000000_c.sql": "begin;\ncreate table c ();\ncommit;\n",
      });
      await assertRejects(
        () => run(MIGRATION_ACTIONS, ["up"]),
        Error,
        "manages its own transaction",
      );
      await Deno.remove(`${root}/migrations/20260103000000_c.sql`);
      await run(DB_ACTIONS, ["reset"], { yes: true, "no-seed": true });
      assertEquals((await env.app`select count(*)::int as n from _migrations`)[0].n, 2);
    } finally {
      await Deno.remove(root, { recursive: true });
      await env.drop();
    }
  },
});

Deno.test({
  name: `@denext/backend's db tooling on Postgres: lint, inspect, types, pull, test${label}`,
  ignore: reason !== undefined,
  async fn() {
    const env = await environment();
    const role = decodeURIComponent(new URL(env.url).username);
    await env.admin.unsafe(`ALTER ROLE ${role} CREATEDB`);
    const root = await Deno.makeTempDir({ prefix: "dnx-db-tools-" });
    try {
      await write(root, {
        "migrations/20260101000000_init.sql":
          "create table notes (id int primary key, body text);\n",
        "supabase/tests/notes.sql": `begin;
select plan(2);
select has_table('public', 'notes', 'notes exists');
select ok((select count(*) from notes) = 0, 'notes start empty');
select * from finish();
rollback;
`,
      });
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      const config = { plugins: [backend({ postgres: { sql: env.app } })] } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      const run = runner(root, env.url);
      // --yes: the test database may be on another host, where push asks first.
      await run(DB_ACTIONS, ["push"], { yes: true });
      // lint: RLS is off on a table the API roles can reach (when they exist) or no grants.
      const lint = JSON.parse(await run(DB_ACTIONS, ["lint"], { "fail-on": "none" }, true));
      assert(Array.isArray(lint.issues));
      assert(
        lint.issues.some((i: { check: string; object: string }) =>
          i.object === "public.notes" && ["rls_disabled", "table_no_grants"].includes(i.check)
        ),
        JSON.stringify(lint),
      );
      await env.app.unsafe("create function loose() returns int language sql as 'select 1'");
      const strict = JSON.parse(await run(DB_ACTIONS, ["lint"], { "fail-on": "none" }, true));
      assert(strict.issues.some((i: { check: string }) => i.check === "function_search_path"));
      await env.app.unsafe("drop function loose()");
      // inspect
      const sizes = JSON.parse(await run(DB_ACTIONS, ["inspect", "table-sizes"], {}, true));
      assert(sizes.some((r: { name: string }) => r.name === "notes"), JSON.stringify(sizes));
      const all = await run(DB_ACTIONS, ["inspect", "report"]);
      assertStringIncludes(all, "cache-hit:");
      // types
      const types = await run(DB_ACTIONS, ["types"]);
      assertStringIncludes(types, "notes: {");
      assertStringIncludes(types, "body: string | null");
      // pull: a change made in the database becomes a migration, recorded as applied.
      await env.app.unsafe("alter table notes add column pinned boolean default false");
      const pulled = await run(DB_ACTIONS, ["pull", "pin_notes"]);
      assertStringIncludes(pulled, "recorded as applied");
      const status = JSON.parse(await run(MIGRATION_ACTIONS, ["list"], {}, true));
      assertEquals(status.migrations.length, 2);
      assert(status.migrations.every((m: { remote: boolean }) => m.remote));
      assertStringIncludes(await run(DB_ACTIONS, ["diff"]), "No changes");
      // pgTAP, when the server has it.
      const [available] = await env.admin`select count(*)::int as n from pg_available_extensions
        where name = 'pgtap'`;
      if ((available as { n: number }).n > 0) {
        assertStringIncludes(await run(DB_ACTIONS, ["test"]), "All tests successful");
      } else {
        await assertRejects(() => run(DB_ACTIONS, ["test"]), Error, "pgtap extension");
      }
    } finally {
      await runPluginTeardown();
      resetPlugins();
      installPostgres(undefined);
      await Deno.remove(root, { recursive: true });
      await env.drop();
    }
  },
});

Deno.test({
  name: `migration squash rewrites a Postgres history, both formats${label}`,
  ignore: reason !== undefined,
  async fn() {
    const env = await environment();
    const supa = await Deno.makeTempDir({ prefix: "dnx-squash-supa-" });
    const plain = await Deno.makeTempDir({ prefix: "dnx-squash-plain-" });
    try {
      for (const [root, dir] of [[supa, "supabase/migrations"], [plain, "migrations"]] as const) {
        await write(root, {
          [`${dir}/20260101000000_a.sql`]: `-- migrate:up\ncreate table ${
            dir.startsWith("s") ? "sa" : "pa"
          } (id int);\n-- migrate:down\ndrop table ${dir.startsWith("s") ? "sa" : "pa"};\n`,
          [`${dir}/20260102000000_b.sql`]: `-- migrate:up\ncreate table ${
            dir.startsWith("s") ? "sb" : "pb"
          } (id int);\n-- migrate:down\ndrop table ${dir.startsWith("s") ? "sb" : "pb"};\n`,
        });
        const run = runner(root, env.url);
        await run(MIGRATION_ACTIONS, ["up"]);
        const out = await run(MIGRATION_ACTIONS, ["squash"], { yes: true }); // --db-url: history rewritten
        assertStringIncludes(out, "history: 2 rows → 20260102000000_b.sql");
        const listed = JSON.parse(await run(MIGRATION_ACTIONS, ["list"], {}, true));
        assertEquals(
          listed.migrations.map((m: { version: string; local: boolean; remote: boolean }) => [
            m.version,
            m.local,
            m.remote,
          ]),
          [["20260102000000", true, true]],
        );
        assertEquals(await run(MIGRATION_ACTIONS, ["up"]), "The database is up to date.");
        // The squashed file still rolls back as one (both tables, newest first).
        await run(MIGRATION_ACTIONS, ["down"]);
        const left = await env.app`select count(*)::int as n from information_schema.tables
          where table_schema = 'public' and table_name in ('sa', 'sb', 'pa', 'pb')`;
        assertEquals(left[0].n, root === supa ? 0 : 2, "the squashed pair is gone");
        if (root === supa) await run(MIGRATION_ACTIONS, ["up"]);
      }
      const history = await env.app`select version, name, array_length(statements, 1) as n
        from supabase_migrations.schema_migrations`;
      assertEquals(history.map((r) => [r.version, r.name]), [["20260102000000", "b"]]);
    } finally {
      await Deno.remove(supa, { recursive: true });
      await Deno.remove(plain, { recursive: true });
      await env.drop();
    }
  },
});

const S3_ENDPOINT = Deno.env.get("DENEXT_TEST_S3_ENDPOINT") || undefined;
const s3Reason = reason ?? (S3_ENDPOINT ? undefined : "set DENEXT_TEST_S3_ENDPOINT");

Deno.test({
  name: `db seed on Postgres + MinIO: seed_files hashes, buckets and their objects${
    s3Reason ? ` (skipped: ${s3Reason})` : ""
  }`,
  ignore: s3Reason !== undefined,
  async fn() {
    const { s3 } = await import("../packages/backend/mod.ts");
    const { storage } = await import("../packages/backend/server.ts");
    const { installRuntime } = await import("../packages/backend/src/runtime.ts");
    const { sha256Hex, signRequest } = await import("../packages/backend/src/sigv4.ts");
    const credentials = {
      accessKeyId: Deno.env.get("DENEXT_TEST_S3_ACCESS_KEY") ?? "",
      secretAccessKey: Deno.env.get("DENEXT_TEST_S3_SECRET_KEY") ?? "",
    };
    const store = `seed${Date.now().toString(36)}`;
    const sign = async (method: string) => {
      const req = await signRequest(
        { method, origin: new URL(S3_ENDPOINT!).origin, path: `/${store}` },
        { region: "us-east-1", service: "s3", credentials },
        await sha256Hex(""),
      );
      delete req.headers.host;
      return await fetch(req.url, { method, headers: req.headers });
    };
    const created = await sign("PUT");
    await created.body?.cancel();
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-seed-pg-" });
    try {
      await write(root, {
        "supabase/migrations/20260101000000_init.sql": "create table notes (body text);\n",
        "supabase/seed.sql": "insert into notes values ('seeded');\n",
        "supabase/buckets/avatars/team/a.txt": "hello",
      });
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      installRuntime(undefined);
      const config = {
        plugins: [backend({
          postgres: { sql: env.app },
          storage: {
            secret: "storage-secret-at-least-32-characters",
            driver: s3({ endpoint: S3_ENDPOINT!, region: "us-east-1", bucket: store, credentials }),
            buckets: { avatars: {} },
          },
        })],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      const run = runner(root, env.url);
      await run(DB_ACTIONS, ["migrate"]);
      const first = await run(DB_ACTIONS, ["seed"]);
      assertStringIncludes(first, "seeded from supabase/seed.sql");
      assertStringIncludes(first, "bucket avatars");
      assertStringIncludes(first, "uploaded avatars/team/a.txt");
      const recorded = await env.app`select path, hash from supabase_migrations.seed_files`;
      assertEquals(recorded.map((r) => r.path), ["supabase/seed.sql"]);
      assertEquals(String(recorded[0].hash).length, 64);
      const again = await run(DB_ACTIONS, ["seed"]);
      assertStringIncludes(again, "skipped supabase/seed.sql (unchanged");
      await run(DB_ACTIONS, ["seed"], { force: true });
      assertEquals((await env.app`select count(*)::int as n from notes`)[0].n, 2);
      const object = await storage.bucket("avatars", { service: true }).download("team/a.txt");
      assertEquals(await new Response(object!.body).text(), "hello");
      const rows = await env.app`select name from storage.objects where bucket_id = 'avatars'`;
      assertEquals(rows.map((r) => r.name), ["team/a.txt"]);
      await storage.bucket("avatars", { service: true }).remove(["team/a.txt"]);
    } finally {
      await runPluginTeardown();
      resetPlugins();
      installPostgres(undefined);
      installRuntime(undefined);
      const removed = await sign("DELETE");
      await removed.body?.cancel();
      await Deno.remove(root, { recursive: true });
      await env.drop();
    }
  },
});

Deno.test({
  name:
    `migration up on a fresh database: the backend's roles and schemas before the app's${label}`,
  ignore: reason !== undefined,
  async fn() {
    const { fs, realtime } = await import("../packages/backend/mod.ts");
    const { installRuntime } = await import("../packages/backend/src/runtime.ts");
    const { migratePostgres } = await import("../src/server/postgres-migrate.ts");
    const { realtimeMigrations } = await import("../packages/backend/src/realtime-sql.ts");
    const { STORAGE_MIGRATIONS_TABLE, storageMigrations } = await import(
      "../packages/backend/src/storage-meta-pg.ts"
    );
    // (On a server where `anon` / `authenticated` exist already, the app role is granted them as
    // an administrator would; on a new server the first migration creates them.)
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-backend-first-" });
    try {
      // What a Supabase app's first migration does: grant to the API roles, write storage and
      // realtime policies. None of it exists on a fresh database until the backend's migrations
      // ran — which the server's start does only after this migration (the stack's order).
      await write(root, {
        "migrations/20260101000000_init.sql": `create table notes (id int primary key, body text);
alter table notes enable row level security;
grant select on notes to anon, authenticated;
create policy "read notes" on notes for select to anon using (true);
create policy "own uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and owner_id = auth.uid()::text);
create policy "room members" on realtime.messages for select to authenticated using (true);
alter publication supabase_realtime add table notes;
`,
      });
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      installRuntime(undefined);
      const realtimeOptions = { tables: { notes: {} } };
      const config = {
        plugins: [backend({
          postgres: { sql: env.app },
          storage: {
            secret: "storage-secret-at-least-32-characters",
            driver: fs({ dir: ".storage" }),
            buckets: { avatars: {} },
          },
          realtime: realtime(realtimeOptions),
        })],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      const run = runner(root, env.url);
      const out = await run(MIGRATION_ACTIONS, ["up"]);
      assertStringIncludes(out, "backend_rls_0001  (@denext/backend)");
      assertStringIncludes(out, "backend_realtime_0004  (@denext/backend)");
      assertStringIncludes(out, "backend_storage_0001  (@denext/backend)");
      assertStringIncludes(out, "backend_realtime_pub_supabase_realtime  (@denext/backend)");
      assertStringIncludes(out, "applied 20260101000000_init.sql");
      assert(out.indexOf("backend_storage_0001") < out.indexOf("20260101000000_init.sql"), out);
      // The roles first: the realtime and storage schemas grant to them.
      assert(out.indexOf("backend_rls_0001") < out.indexOf("backend_realtime_0001"), out);
      // The per-table realtime trigger needs the app's table: it comes after the app's migration.
      assert(
        out.indexOf("20260101000000_init.sql") < out.indexOf("backend_realtime_t_notes_"),
        out,
      );
      // The server's start then finds everything applied (same names, same tracking tables).
      const storage = await migratePostgres(env.app, {
        migrations: storageMigrations(),
        table: STORAGE_MIGRATIONS_TABLE,
      });
      assertEquals(storage.applied, []);
      const live = await migratePostgres(env.app, {
        migrations: realtimeMigrations(realtimeOptions),
        table: "backend_migrations",
      });
      assertEquals(live.applied, [], "up applied the per-table trigger too");
      // Run again: nothing to do.
      assertStringIncludes(await run(MIGRATION_ACTIONS, ["up"]), "The database is up to date.");
    } finally {
      await runPluginTeardown();
      resetPlugins();
      installPostgres(undefined);
      installRuntime(undefined);
      await Deno.remove(root, { recursive: true });
      await env.drop();
    }
  },
});
