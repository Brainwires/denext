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
  sanitizeResources: false,
  sanitizeOps: false,
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
  sanitizeResources: false,
  sanitizeOps: false,
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
  sanitizeResources: false,
  sanitizeOps: false,
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
      await run(DB_ACTIONS, ["push"]);
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
