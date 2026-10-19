// The Postgres half of `denext db` (from `@denext/backend`'s hooks) and the schema diff behind
// `denext db diff`, without a server: the DDL `diffSnapshots` prints for each kind of change, the
// catalog reads of `readSnapshot`, and each action's flow (diff, pull, dump, lint, inspect, test,
// types) on a scripted Postgres with a fake process / file layer. They run against a real
// Postgres in tests/backend-platform-integration.test.ts and tests/db-migrations-integration.test.ts.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  diffSnapshots,
  quoteIdent,
  readSnapshot,
  type SchemaSnapshot,
  type TableSnapshot,
} from "../packages/backend/src/schema-diff.ts";
import {
  backendMigrationsOf,
  createDbHooks,
  type DbCommandIo,
  installDbHooks,
} from "../packages/backend/src/db-command.ts";
import { type DbActionInput, schemasOf } from "../packages/backend/src/db-action.ts";
import { formatTable, INSPECT_REPORTS } from "../packages/backend/src/db-inspect.ts";
import { splitSql, tally } from "../packages/backend/src/db-test.ts";
import { seedContentType } from "../packages/backend/src/storage-seed.ts";
import { type ScriptedSql, scriptedSql } from "./helpers/scripted-sql.ts";

function empty(): SchemaSnapshot {
  return {
    tables: {},
    indexes: {},
    policies: {},
    functions: {},
    views: {},
    triggers: {},
    enums: {},
  };
}

function table(name: string, extra: Partial<TableSnapshot> = {}): TableSnapshot {
  return {
    schema: "public",
    name,
    rls: false,
    columns: [{
      name: "id",
      type: "integer",
      notNull: true,
      default: null,
      identity: "",
      generated: null,
    }],
    constraints: { [`${name}_pkey`]: "PRIMARY KEY (id)" },
    ...extra,
  };
}

Deno.test("quoteIdent", () => {
  assertEquals(quoteIdent("items"), "items");
  assertEquals(quoteIdent("Items"), '"Items"');
  assertEquals(quoteIdent('a"b'), '"a""b"');
});

Deno.test("diffSnapshots: nothing for equal snapshots", () => {
  const a = empty();
  a.tables["public.t"] = table("t");
  assertEquals(diffSnapshots(a, structuredClone(a)), []);
});

Deno.test("diffSnapshots: tables, columns, constraints and row-level security", () => {
  const from = empty();
  from.tables["public.items"] = table("items", {
    columns: [
      { name: "id", type: "integer", notNull: true, default: null, identity: "", generated: null },
      {
        name: "name",
        type: "text",
        notNull: false,
        default: "'x'::text",
        identity: "",
        generated: null,
      },
      { name: "gone", type: "text", notNull: false, default: null, identity: "", generated: null },
    ],
    constraints: { items_pkey: "PRIMARY KEY (id)", items_name_check: "CHECK (name <> '')" },
  });
  from.tables["public.old"] = table("old");
  const to = empty();
  to.tables["public.items"] = table("items", {
    rls: true,
    columns: [
      { name: "id", type: "bigint", notNull: true, default: null, identity: "", generated: null },
      { name: "name", type: "text", notNull: true, default: null, identity: "", generated: null },
      {
        name: "price",
        type: "integer",
        notNull: false,
        default: "0",
        identity: "",
        generated: null,
      },
      {
        name: "serial",
        type: "bigint",
        notNull: true,
        default: null,
        identity: "a",
        generated: null,
      },
      {
        name: "twice",
        type: "integer",
        notNull: false,
        default: null,
        identity: "",
        generated: "(price * 2)",
      },
    ],
    constraints: { items_pkey: "PRIMARY KEY (id)", items_name_check: "CHECK (length(name) > 0)" },
  });
  to.tables["public.orders"] = table("orders", {
    rls: true,
    columns: [
      { name: "id", type: "integer", notNull: true, default: null, identity: "d", generated: null },
      {
        name: "item",
        type: "integer",
        notNull: false,
        default: null,
        identity: "",
        generated: null,
      },
    ],
    constraints: {
      orders_pkey: "PRIMARY KEY (id)",
      orders_item_fkey: "FOREIGN KEY (item) REFERENCES items(id)",
    },
  });
  const ddl = diffSnapshots(from, to).join("\n");
  for (
    const line of [
      "ALTER TABLE public.items ALTER COLUMN id TYPE bigint USING id::bigint;",
      "ALTER TABLE public.items ALTER COLUMN name DROP DEFAULT;",
      "ALTER TABLE public.items ALTER COLUMN name SET NOT NULL;",
      "ALTER TABLE public.items ADD COLUMN price integer DEFAULT 0;",
      "ALTER TABLE public.items ADD COLUMN serial bigint GENERATED ALWAYS AS IDENTITY NOT NULL;",
      "ALTER TABLE public.items ADD COLUMN twice integer GENERATED ALWAYS AS ((price * 2)) STORED;",
      "ALTER TABLE public.items DROP COLUMN gone;",
      "ALTER TABLE public.items DROP CONSTRAINT items_name_check;",
      "ALTER TABLE public.items ADD CONSTRAINT items_name_check CHECK (length(name) > 0);",
      "ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;",
      "CREATE TABLE public.orders (\n  id integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  item integer,\n  CONSTRAINT orders_pkey PRIMARY KEY (id)\n);",
      "ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE public.orders ADD CONSTRAINT orders_item_fkey FOREIGN KEY (item) REFERENCES items(id);",
      "DROP TABLE public.old;",
    ]
  ) assertStringIncludes(ddl, line);
  // Back again: a default comes back, NOT NULL drops, RLS turns off.
  const back = diffSnapshots(to, from).join("\n");
  assertStringIncludes(back, "ALTER TABLE public.items ALTER COLUMN name SET DEFAULT 'x'::text;");
  assertStringIncludes(back, "ALTER TABLE public.items ALTER COLUMN name DROP NOT NULL;");
  assertStringIncludes(back, "ALTER TABLE public.items DISABLE ROW LEVEL SECURITY;");
});

Deno.test("diffSnapshots: functions, indexes, policies, views, triggers, enums — in order", () => {
  const from = empty();
  from.tables["public.t"] = table("t");
  from.tables["public.gone"] = table("gone");
  from.functions["public.f(integer)"] = "CREATE OR REPLACE FUNCTION public.f(integer) ... old";
  from.functions["public.dropped(text, integer)"] = "CREATE OR REPLACE FUNCTION public.dropped ...";
  from.indexes["public.t_old_idx"] = "CREATE INDEX t_old_idx ON public.t USING btree (id)";
  from.policies["public.t.p"] = {
    schema: "public",
    table: "t",
    name: "p",
    permissive: true,
    roles: ["authenticated"],
    command: "SELECT",
    using: "true",
    check: null,
  };
  from.policies["public.gone.q"] = { ...from.policies["public.t.p"], table: "gone", name: "q" };
  from.views["public.v"] = "SELECT 1";
  from.triggers["public.t.trg"] =
    "CREATE TRIGGER trg AFTER INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f()";
  from.enums["public.mood"] = ["sad", "ok"];
  from.enums["public.unused"] = ["a"];
  const to = empty();
  to.tables["public.t"] = table("t");
  to.functions["public.f(integer)"] = "CREATE OR REPLACE FUNCTION public.f(integer) ... new";
  to.indexes["public.t_new_idx"] = "CREATE UNIQUE INDEX t_new_idx ON public.t USING btree (id)";
  to.policies["public.t.p"] = {
    ...from.policies["public.t.p"],
    permissive: false,
    roles: ["anon", "Admins"],
    command: "UPDATE",
    check: "(id > 0)",
  };
  to.views["public.v"] = "SELECT 2";
  to.triggers["public.t.trg"] =
    "CREATE TRIGGER trg BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f()";
  to.enums["public.mood"] = ["sad", "happy"];
  to.enums["public.color"] = ["red", "o'range"];
  const ddl = diffSnapshots(from, to);
  const at = (needle: string) => ddl.findIndex((s) => s.includes(needle));
  for (
    const line of [
      "CREATE TYPE public.color AS ENUM ('red', 'o''range');",
      "ALTER TYPE public.mood ADD VALUE IF NOT EXISTS 'happy';",
      "-- public.mood: the label 'ok' was removed",
      "DROP VIEW public.v;",
      "DROP TRIGGER trg ON public.t;",
      "DROP POLICY p ON public.t;",
      "DROP INDEX public.t_old_idx;",
      "DROP TABLE public.gone;",
      "DROP FUNCTION public.dropped(text, integer);",
      "CREATE OR REPLACE FUNCTION public.f(integer) ... new;",
      "CREATE UNIQUE INDEX t_new_idx ON public.t USING btree (id);",
      `CREATE POLICY p ON public.t AS RESTRICTIVE FOR UPDATE TO anon, "Admins" USING (true) WITH CHECK ((id > 0));`,
      "CREATE VIEW public.v AS\nSELECT 2",
      "CREATE TRIGGER trg BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f();",
      "DROP TYPE public.unused;",
    ]
  ) assert(at(line) >= 0, `${line}\n---\n${ddl.join("\n")}`);
  assert(!ddl.some((s) => s.includes("DROP POLICY q")), "a dropped table takes its policies");
  assert(at("DROP POLICY p") < at("DROP TABLE"), "dependents are dropped before tables");
  assert(at("DROP TABLE") < at("CREATE OR REPLACE FUNCTION"), "functions after tables");
  assert(at("CREATE VIEW") < at("CREATE TRIGGER"), "triggers last");
  assert(at("CREATE TRIGGER") < at("DROP TYPE public.unused"), "types dropped at the end");
});

Deno.test("readSnapshot: the catalog rows become a snapshot", async () => {
  const answers: Array<[string, unknown[]]> = [
    ["c.relrowsecurity", [{ schema: "public", name: "t", rls: true }]],
    ["format_type", [
      {
        schema: "public",
        table: "t",
        name: "id",
        type: "integer",
        notNull: true,
        default: null,
        identity: "a",
        generated: null,
      },
      {
        schema: "public",
        table: "missing",
        name: "x",
        type: "text",
        notNull: false,
        default: null,
        identity: null,
        generated: null,
      },
    ]],
    ["pg_get_constraintdef", [
      { schema: "public", table: "t", name: "t_pkey", def: "PRIMARY KEY (id)" },
      { schema: "public", table: "missing", name: "m_pkey", def: "PRIMARY KEY (x)" },
    ]],
    ["pg_get_indexdef", [{ schema: "public", name: "i", def: "CREATE INDEX i ON public.t (id)" }]],
    ["pg_policies", [
      {
        schema: "public",
        table: "t",
        name: "p",
        permissive: "true",
        roles: ["b", "a"],
        command: "ALL",
        using: null,
        check: null,
      },
    ]],
    ["pg_get_functiondef", [{ key: "public.f()", def: " CREATE FUNCTION f() \n" }]],
    ["pg_get_viewdef", [{ schema: "public", name: "v", def: " SELECT 1;" }]],
    ["pg_get_triggerdef", [{ schema: "public", table: "t", name: "g", def: "CREATE TRIGGER g" }]],
    ["pg_enum", [{ schema: "public", name: "e", labels: ["a", "b"] }]],
  ];
  const sql = scriptedSql((text, params) => {
    assertEquals(params, [["public"]]);
    const found = answers.find(([needle]) => text.includes(needle));
    if (!found) throw new Error(text);
    return found[1];
  });
  const snap = await readSnapshot(sql, ["public"]);
  assertEquals(snap.tables["public.t"].columns.map((c) => c.name), ["id"]);
  assertEquals(snap.tables["public.t"].constraints, { t_pkey: "PRIMARY KEY (id)" });
  assertEquals(snap.policies["public.t.p"].roles, ["a", "b"]);
  assertEquals(snap.policies["public.t.p"].permissive, true);
  assertEquals(snap.functions["public.f()"], "CREATE FUNCTION f()");
  assertEquals(snap.views["public.v"], "SELECT 1;");
  assertEquals(snap.enums["public.e"], ["a", "b"]);
  assertEquals(Object.keys(snap.indexes), ["public.i"]);
  assertEquals(Object.keys(snap.triggers), ["public.t.g"]);
});

/** A fake io: records files and pg_dump calls. */
function fakeIo(
  options: {
    dump?: (
      args: string[],
      env: Record<string, string>,
    ) => { code: number; stdout: string; stderr: string };
    shadow?: () => ScriptedSql;
  } = {},
) {
  const files = new Map<string, string>();
  const io: DbCommandIo = {
    run: (_cmd, args, env) => {
      if (!options.dump) return Promise.reject(new Deno.errors.NotFound("pg_dump"));
      const out = options.dump(args, env);
      return Promise.resolve({ ...out, stdout: new TextEncoder().encode(out.stdout) });
    },
    write: (path, data) => {
      files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
      return Promise.resolve();
    },
    connect: () => (options.shadow ?? (() => scriptedSql(() => [])))(),
  };
  return { io, files };
}

/** The fake project root: absolute on every OS (a drive on Windows). */
const PROJECT = resolve("/project");

const config = () => ({
  backendMigrations: () =>
    backendMigrationsOf([() => [{ name: "backend_x_0001", sql: "select 1" }]]),
  serviceSchemas: ["pgmq"],
});

/** Run one hook action; resolves the printed lines (an error rejects). */
function action(
  name: string,
  sql: ScriptedSql,
  options: {
    io?: DbCommandIo;
    url?: string;
    positionals?: string[];
    flags?: Record<string, string | boolean>;
    json?: boolean;
    root?: string;
    recorded?: string[];
  } = {},
) {
  const lines: string[] = [];
  const hooks = createDbHooks(config(), options.io ?? fakeIo().io);
  const root = options.root ?? PROJECT;
  const input: DbActionInput = {
    ctx: {
      positionals: [name, ...(options.positionals ?? [])],
      flags: options.flags ?? {},
      global: { cwd: root, json: options.json === true, verbose: false, quiet: false },
      rest: [],
    },
    projectDir: root,
    sql,
    ...(options.url ? { url: options.url } : {}),
    migrationsDir: `${root}/migrations`,
    applyAll: () => Promise.resolve([]),
    recordApplied: (file) => {
      options.recorded?.push(file);
      return Promise.resolve();
    },
    io: { log: (l) => lines.push(l), error: (l) => lines.push(`error: ${l}`) },
  };
  return hooks.actions[name](input).then(() => lines);
}

Deno.test("createDbHooks: the backend's migrations, schemas and actions; installDbHooks", () => {
  const hooks = createDbHooks(config());
  assertEquals(hooks.migrations().map((m) => m.name), ["backend_rls_0001", "backend_x_0001"]);
  assertEquals(hooks.table, "backend_migrations");
  assertEquals(hooks.serviceSchemas, ["pgmq"]);
  assertEquals(Object.keys(hooks.actions).sort(), [
    "diff",
    "dump",
    "inspect",
    "lint",
    "pull",
    "test",
    "types",
  ]);
  // Storage-only: no Postgres actions.
  assertEquals(Object.keys(createDbHooks(config(), undefined, false).actions), []);
  installDbHooks(hooks);
  assertEquals((globalThis as Record<symbol, unknown>)[Symbol.for("denext.backend.db")], hooks);
  installDbHooks(undefined);
  assertEquals((globalThis as Record<symbol, unknown>)[Symbol.for("denext.backend.db")], undefined);
});

Deno.test("schemasOf: public by default, a list, plain identifiers only", () => {
  const ctx = (schema?: string) => ({ flags: schema ? { schema } : {} }) as never;
  assertEquals(schemasOf(ctx()), ["public"]);
  assertEquals(schemasOf(ctx("public,app")), ["public", "app"]);
  try {
    schemasOf(ctx("bad schema"));
    throw new Error("expected a refusal");
  } catch (error) {
    assertStringIncludes((error as Error).message, "plain identifier");
  }
});

Deno.test("db diff: a shadow database, the DDL printed or written, cleaned up", async () => {
  // The live database has a table the shadow does not.
  const live = scriptedSql((text) =>
    text.includes("c.relrowsecurity") ? [{ schema: "public", name: "extra", rls: false }] : []
  );
  const fake = fakeIo();
  const url = "postgres://u:p@db.test:5432/app";
  const lines = await action("diff", live, { io: fake.io, url });
  const created = live.calls.find((c) => c.text.startsWith("CREATE DATABASE"))!.text;
  assert(/^CREATE DATABASE denext_shadow_[0-9a-f]{12}$/.test(created), created);
  assert(live.calls.some((c) => c.text.startsWith("DROP DATABASE IF EXISTS denext_shadow_")));
  assertStringIncludes(lines.join("\n"), "CREATE TABLE public.extra");
  const written = await action("diff", live, {
    io: fake.io,
    url,
    flags: { file: "add_extra", schema: "public,app" },
  });
  const [[path, text]] = [...fake.files];
  assert(/[\\/]migrations[\\/]\d{14}_add_extra\.sql$/.test(path), path);
  assertStringIncludes(text, "-- denext db diff (public, app)");
  assertStringIncludes(written[0], "Wrote migrations/");
  await assertRejects(
    () => action("diff", live, { io: fake.io, url, flags: { file: "../escape" } }),
    TypeError,
    "letters, digits",
  );
  await assertRejects(() => action("diff", live), Error, "DATABASE_URL");
  // Identical: "No changes".
  assertEquals(await action("diff", scriptedSql(() => []), { url }), [
    "No changes: the database matches the migrations.",
  ]);
});

Deno.test("db pull: the database's schema as a migration, recorded as applied", async () => {
  const live = scriptedSql((text) =>
    text.includes("c.relrowsecurity") ? [{ schema: "public", name: "remote", rls: false }] : []
  );
  const fake = fakeIo();
  const recorded: string[] = [];
  // No URL: against an empty schema (no shadow database).
  const lines = await action("pull", live, { io: fake.io, recorded, positionals: ["initial"] });
  assert(/^\d{14}_initial\.sql$/.test(recorded[0]), recorded[0]);
  assertStringIncludes([...fake.files.values()][0], "CREATE TABLE public.remote");
  assertStringIncludes(lines[0], "recorded as applied");
  assert(!live.calls.some((c) => c.text.startsWith("CREATE DATABASE")));
  // With a URL: a shadow; nothing new → nothing written.
  const none = await action("pull", scriptedSql(() => []), { url: "postgres://db.test/app" });
  assertEquals(none, ["No schema changes found: the migrations match the database."]);
});

Deno.test("db dump: pg_dump with the password in the environment", async () => {
  const seen: { args: string[]; env: Record<string, string> }[] = [];
  const fake = fakeIo({
    dump: (args, env) => {
      seen.push({ args, env });
      return args.includes("--data-only")
        ? { code: 1, stdout: "", stderr: "permission denied\n" }
        : { code: 0, stdout: "CREATE TABLE t ();", stderr: "" };
    },
  });
  const sql = scriptedSql(() => []);
  const url = "postgres://app:s%40cret@db.test:5432/app";
  assertEquals(await action("dump", sql, { io: fake.io, url }), ["CREATE TABLE t ();"]);
  assertEquals(seen[0].env, { PGPASSWORD: "s@cret" });
  assert(!seen[0].args.join(" ").includes("cret"), "no password on the command line");
  assert(seen[0].args.includes("--schema-only"));
  await action("dump", sql, { io: fake.io, url, flags: { file: "out.sql", schema: "app" } });
  assertEquals(fake.files.get(join(PROJECT, "out.sql")), "CREATE TABLE t ();");
  assert(seen[1].args.includes("app"));
  await assertRejects(
    () => action("dump", sql, { io: fake.io, url, flags: { "data-only": true } }),
    Error,
    "pg_dump failed: permission denied",
  );
  await assertRejects(
    () => action("dump", sql, { url: "postgres://db.test/app" }),
    Error,
    "pg_dump is not on PATH",
  );
  await assertRejects(() => action("dump", sql), Error, "needs the database URL");
});

Deno.test("db lint: built-in checks, plpgsql_check when installed, levels and --fail-on", async () => {
  const sql = scriptedSql((text) => {
    if (text.includes("extname = 'plpgsql_check'")) return [{ found: true }];
    if (text.includes("plpgsql_check_function_tb")) {
      return [{ object: "public.f()", level: "error", message: "column x does not exist" }];
    }
    if (text.includes("NOT c.relrowsecurity") && text.includes("has_table_privilege")) {
      return [{ object: "public.open" }];
    }
    if (text.includes("search_path=%")) return [{ object: "public.g()" }];
    return [];
  });
  await assertRejects(() => action("lint", sql), Error, "level error");
  const lines = await action("lint", sql, { flags: { "fail-on": "none" } });
  const out = lines.join("\n");
  assertStringIncludes(out, "plpgsql_check");
  assertStringIncludes(out, "rls_disabled");
  assertStringIncludes(out, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(out, "function_search_path");
  const errorsOnly = await action("lint", sql, { flags: { "fail-on": "none", level: "error" } });
  assert(!errorsOnly.join("\n").includes("function_search_path"));
  const json = JSON.parse(
    (await action("lint", sql, { json: true, flags: { "fail-on": "none" } })).join("\n"),
  );
  assertEquals(json.plpgsqlCheck, true);
  assertEquals(json.issues.length, 3);
  // The schemas are bound as JSON, never interpolated.
  const bound = sql.calls.find((c) => c.text.includes("search_path=%"))!;
  assertEquals(bound.params, ['["public"]']);
  await assertRejects(
    () => action("lint", sql, { flags: { level: "loud" } }),
    TypeError,
    "unknown level",
  );
  // Nothing installed, nothing found.
  const clean = await action("lint", scriptedSql(() => []));
  assertEquals(clean, [
    "(plpgsql_check is not installed: function bodies were not checked)",
    "No issues found in public.",
  ]);
});

Deno.test("db inspect: a report as a table or JSON, extension checks, every report", async () => {
  const sql = scriptedSql((text) => {
    if (text.includes("pg_extension")) return [{ found: false }];
    if (text.includes("row_to_json")) return [{ row: JSON.stringify({ name: "t", count: 3 }) }];
    return [];
  });
  assertEquals(await action("inspect", sql, { positionals: ["seq-scans"] }), [
    "  name | count",
    "  -----|------",
    "  t    | 3",
  ]);
  assertEquals(
    JSON.parse((await action("inspect", sql, { positionals: ["seq-scans"], json: true }))[0]),
    [{ name: "t", count: 3 }],
  );
  await assertRejects(
    () => action("inspect", sql, { positionals: ["calls"] }),
    Error,
    "pg_stat_statements",
  );
  await assertRejects(() => action("inspect", sql, { positionals: ["nope"] }), Error, "unknown");
  await assertRejects(() => action("inspect", sql), Error, "name a report");
  const all = (await action("inspect", sql, { positionals: ["report"] })).join("\n");
  for (const name of Object.keys(INSPECT_REPORTS)) assertStringIncludes(all, `${name}:`);
  assertStringIncludes(all, "(skipped: calls needs");
  const allJson = JSON.parse(
    (await action("inspect", sql, { positionals: ["report"], json: true })).join("\n"),
  );
  assertEquals(Object.keys(allJson).length, Object.keys(INSPECT_REPORTS).length);
  assertEquals(formatTable([]), ["  (no rows)"]);
  assertStringIncludes(
    formatTable([{ a: null, b: { x: 1 }, c: new Date(0) }])[2],
    '| {"x":1} | 1970-01-01T00:00:00.000Z',
  );
});

Deno.test("splitSql: quotes, dollar bodies, comments and E-strings", () => {
  assertEquals(
    splitSql(`select 1; -- a; comment
select 'a;b', "c;d"; /* x; /* nested; */ y; */ select $$ a; b $$;
create function f() returns int language plpgsql as $body$ begin return 1; end $body$;
select E'it\\'s; fine', $1; ; -- trailing`),
    [
      "select 1",
      `select 'a;b', "c;d"`,
      "/* x; /* nested; */ y; */ select $$ a; b $$",
      "create function f() returns int language plpgsql as $body$ begin return 1; end $body$",
      "select E'it\\'s; fine', $1",
    ],
  );
  assertEquals(splitSql("-- only a comment\n"), []);
  assertEquals(splitSql("select 'it''s'"), ["select 'it''s'"]);
});

Deno.test("tally: plans, passes, failures and TODO", () => {
  assertEquals(tally("f", ["1..2", "ok 1 - a", "ok 2 - b"]).ok, true);
  assertEquals(tally("f", ["1..3", "ok 1 - a", "ok 2 - b"]).ok, false);
  const failed = tally("f", ["1..2", "ok 1", "not ok 2 - x", "# Failed test 2"]);
  assertEquals([failed.passed, failed.failed, failed.ok], [1, 1, false]);
  assertEquals(tally("f", ["not ok 1 # TODO later", "1..1"]).ok, true);
  assertEquals(tally("f", []).ok, false, "no tests ran");
});

Deno.test("db test: pgTAP files in a rolled-back transaction, TAP collected", async () => {
  const root = await Deno.makeTempDir({ prefix: "dnx-db-test-" });
  try {
    await Deno.mkdir(`${root}/supabase/tests/nested`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/supabase/tests/a.sql`,
      "begin;\nselect plan(2);\nselect ok(true, 'one');\nselect ok(true, 'two');\n" +
        "select * from finish();\nrollback;\n",
    );
    await Deno.writeTextFile(
      `${root}/supabase/tests/nested/b.sql`,
      "select plan(1);\nselect boom;",
    );
    const sql = scriptedSql((text) => {
      if (text.includes("pg_available_extensions")) return [{ found: true }];
      if (text.startsWith("select plan(")) return [{ plan: `1..${text.match(/\d+/)![0]}` }];
      if (text.startsWith("select ok(")) {
        return [{
          ok: `ok ${text.includes("one") ? 1 : 2} - ${text.includes("one") ? "one" : "two"}`,
        }];
      }
      if (text === "select boom") throw new Error('column "boom" does not exist');
      return [];
    });
    await assertRejects(
      () => action("test", sql, { root }),
      Error,
      "1 of 2 test files failed",
    );
    // BEGIN / ROLLBACK are the runner's; the extension is created inside its transaction.
    assert(!sql.calls.some((c) => /^(begin|rollback)$/i.test(c.text)));
    assert(sql.calls.some((c) => c.text === "CREATE EXTENSION IF NOT EXISTS pgtap"));
    const one = await action("test", sql, { root, positionals: ["supabase/tests/a.sql"] });
    assertEquals(one.at(-2), "supabase/tests/a.sql .. ok");
    assertEquals(one.at(-1), "All tests successful (1 files).");
    const json = JSON.parse(
      (await action("test", sql, { root, positionals: ["supabase/tests/a.sql"], json: true }))
        .join("\n"),
    );
    assertEquals(json, [{
      file: "supabase/tests/a.sql",
      planned: 2,
      passed: 2,
      failed: 0,
      ok: true,
    }]);
    await assertRejects(
      () => action("test", scriptedSql(() => [{ found: false }]), { root }),
      Error,
      "pgtap extension is not available",
    );
    await Deno.remove(`${root}/supabase`, { recursive: true });
    await assertRejects(() => action("test", sql, { root }), Error, "no tests");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("db types: the catalog as standalone Supabase-shaped types", async () => {
  const sql = scriptedSql(() => []);
  const fake = fakeIo();
  const printed = (await action("types", sql)).join("\n");
  assertStringIncludes(printed, "export type Database = {");
  assertStringIncludes(printed, "AUTO-GENERATED by `denext gen types`");
  assert(!printed.includes('declare module "@denext/backend/client"'), "standalone");
  const wrote = await action("types", sql, { io: fake.io, flags: { file: "db.types.ts" } });
  assertEquals(wrote, ["Wrote db.types.ts"]);
  assertStringIncludes(fake.files.get(join(PROJECT, "db.types.ts"))!, "export type Json");
});

Deno.test("seedContentType: by extension", () => {
  assertEquals(seedContentType("a/b.PNG"), "image/png");
  assertEquals(seedContentType("x.json"), "application/json");
  assertEquals(seedContentType("x.bin"), undefined);
});
