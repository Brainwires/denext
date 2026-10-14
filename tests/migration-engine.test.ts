// The migration engine behind `denext migration` / `denext db`: parsing files into up and down
// scripts, the three histories (denext `_migrations` on Postgres and SQLite, the Supabase CLI's
// `supabase_migrations.schema_migrations`), and the operations over them (up with `--to` and
// the out-of-order guard, down with `--steps` / `--to` and the no-down refusal, repair, list).
// SQLite runs for real (node:sqlite, in memory); Postgres on a scripted client here and for real
// in tests/db-migrations-integration.test.ts.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  compareVersions,
  isVersioned,
  parseMigration,
  projectMigrationsDir,
  readMigrationFiles,
  splitMigration,
  versionOf,
} from "../src/server/migration-files.ts";
import {
  NoDownScriptError,
  postgresHistory,
  sqliteHistory,
  supabaseHistory,
} from "../src/server/migration-history.ts";
import {
  listMigrations,
  migrateDown,
  migrateUp,
  OutOfOrderError,
  planDown,
  repairHistory,
  versionAfter,
} from "../src/server/migration-ops.ts";
import { migratePostgres } from "../src/server/postgres-migrate.ts";
import { migrateSqlite, sqliteMigrationStatus } from "../src/server/sqlite-migrate.ts";
import { scriptedSql } from "./helpers/scripted-sql.ts";

Deno.test("splitMigration: sections, text before the first marker, no markers", () => {
  assertEquals(splitMigration("create table a();"), { up: "create table a();" });
  const both = splitMigration(
    "-- header\n-- migrate:up\ncreate table a();\n-- migrate:down\ndrop table a;\n",
  );
  assertEquals(both.up, "-- header\n\ncreate table a();\n");
  assertEquals(both.down, "\ndrop table a;\n");
  // A down marker with nothing after it is no down script.
  assertEquals(splitMigration("create table a();\n-- migrate:down\n  \n").down, undefined);
  // Marker spellings: case and trailing text.
  const loose = splitMigration("--migrate:UP transaction:false\nx;\n  -- Migrate:down\ny;");
  assertEquals([loose.up.trim(), loose.down?.trim()], ["x;", "y;"]);
});

Deno.test("parseMigration / versionOf / isVersioned / compareVersions", () => {
  assertEquals(versionOf("20261007093000_add_users.sql"), {
    version: "20261007093000",
    label: "add_users",
  });
  assertEquals(versionOf("init.sql"), { version: "init", label: "init" });
  assert(isVersioned("1_x.sql"));
  assert(!isVersioned("x.sql"));
  const m = parseMigration("2_b.sql", "create table b();", "drop table b;");
  assertEquals(m, {
    name: "2_b.sql",
    version: "2",
    label: "b",
    up: "create table b();",
    down: "drop table b;",
  });
  assertEquals(parseMigration("3_c.sql", "x;", "  ").down, undefined);
  assertThrows(
    () => parseMigration("4_d.sql", "x;\n-- migrate:down\ny;", "z;"),
    Error,
    "keep one",
  );
  assertEquals(compareVersions("9", "10"), -1);
  assertEquals(compareVersions("10", "10"), 0);
  assertEquals(compareVersions("b", "a"), 1);
  assertEquals(compareVersions("a", "b"), -1);
});

async function tempProject(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "dnx-mig-" });
  for (const [path, text] of Object.entries(files)) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  }
  return root;
}

Deno.test("readMigrationFiles: .down.sql companions, order, a missing directory, URLs", async () => {
  const root = await tempProject({
    "migrations/2_b.sql": "create table b();",
    "migrations/2_b.down.sql": "drop table b;",
    "migrations/1_a.sql": "-- migrate:up\ncreate table a();\n-- migrate:down\ndrop table a;",
    "migrations/notes.txt": "ignored",
  });
  try {
    const files = await readMigrationFiles(`${root}/migrations`);
    assertEquals(files.map((f) => [f.name, f.down?.trim()]), [
      ["1_a.sql", "drop table a;"],
      ["2_b.sql", "drop table b;"],
    ]);
    const viaUrl = await readMigrationFiles(new URL(`file://${root}/migrations`));
    assertEquals(viaUrl.length, 2);
    assertEquals(await readMigrationFiles(`${root}/none`), []);
    assertEquals(await projectMigrationsDir(root), "migrations");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
  const supabase = await tempProject({ "supabase/migrations/1_a.sql": "x;" });
  try {
    assertEquals(await projectMigrationsDir(supabase), "supabase/migrations");
  } finally {
    await Deno.remove(supabase, { recursive: true });
  }
  const empty = await tempProject({});
  try {
    assertEquals(await projectMigrationsDir(empty), "migrations");
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});

const file = (version: string, up: string, down?: string) => ({
  name: `${version}_m${version}.sql`,
  version,
  label: `m${version}`,
  up,
  ...(down !== undefined ? { down } : {}),
});

const tables = (db: DatabaseSync) =>
  (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
  ).all() as { name: string }[]).map((r) => r.name);

Deno.test("SQLite history: up, --to, out-of-order guard, down, repair, list", async () => {
  const db = new DatabaseSync(":memory:");
  const history = sqliteHistory(db);
  const files = [
    file("1", "CREATE TABLE a (id INTEGER);", "DROP TABLE a;"),
    file("2", "CREATE TABLE b (id INTEGER);", "DROP TABLE b;"),
    file("3", "CREATE TABLE c (id INTEGER);"),
  ];
  const seen: string[] = [];
  assertEquals(await migrateUp(history, files, { to: "2" }, (n) => seen.push(n)), [
    "1_m1.sql",
    "2_m2.sql",
  ]);
  assertEquals(seen, ["1_m1.sql", "2_m2.sql"]);
  assertEquals(tables(db), ["a", "b"]);
  assertEquals(await migrateUp(history, files, { dryRun: true }), ["3_m3.sql"]);
  assertEquals(await migrateUp(history, files), ["3_m3.sql"]);
  // Already applied: apply() reports false and changes nothing.
  assertEquals(await history.apply(files[0]), false);
  // An older pending file is refused unless --include-all.
  const early = file("0", "CREATE TABLE z (id INTEGER);", "DROP TABLE z;");
  await assertRejects(() => migrateUp(history, [early, ...files]), OutOfOrderError, "0_m0.sql");
  assertEquals(await migrateUp(history, [early, ...files], { includeAll: true }), ["0_m0.sql"]);
  // Down: the newest has no down script — refused before anything runs.
  await assertRejects(
    () => migrateDown(history, [early, ...files]),
    NoDownScriptError,
    "3_m3.sql",
  );
  assertEquals(tables(db), ["a", "b", "c", "z"]);
  await assertRejects(() => history.revert(files[2]), NoDownScriptError);
  // Forget 3, then roll back two steps (2 and 1), newest first.
  await repairHistory(history, files, ["3"], "reverted");
  db.exec("DROP TABLE c");
  const steps = await planDown(history, [early, ...files], { steps: 2 });
  assertEquals(steps.map((s) => s.row.key), ["2_m2.sql", "1_m1.sql"]);
  assertEquals(await versionAfter(history, steps), "0");
  assertEquals(await migrateDown(history, [early, ...files], { steps: 2, dryRun: true }), [
    "2_m2.sql",
    "1_m1.sql",
  ]);
  assertEquals(await migrateDown(history, [early, ...files], { steps: 2 }), [
    "2_m2.sql",
    "1_m1.sql",
  ]);
  assertEquals(tables(db), ["z"]);
  // --to: everything after version 0 (nothing left after it) → nothing.
  assertEquals(await migrateDown(history, files, { to: "0" }), []);
  // A row with no local file cannot be rolled back.
  await assertRejects(() => migrateDown(history, files), NoDownScriptError, "no local file");
  await assertRejects(() => planDown(history, files, { steps: 0 }), TypeError, "--steps");
  // Repair: applied needs a local file; reverted needs a row.
  await assertRejects(() => repairHistory(history, files, ["9"], "applied"), Error, "version 9");
  await assertRejects(() => repairHistory(history, files, ["9"], "reverted"), Error, "not in");
  assertEquals(await repairHistory(history, files, ["1"], "applied"), ["1_m1.sql"]);
  const rows = await listMigrations(history, files);
  assertEquals(rows.map((r) => [r.version, r.local, r.remote, r.reversible]), [
    ["0", false, true, undefined],
    ["1", true, true, true],
    ["2", true, false, true],
    ["3", true, false, false],
  ]);
  assert(rows[1].appliedAt);
  assertThrows(() => sqliteHistory(db, "bad name"), TypeError, "plain table name");
  db.close();
});

Deno.test("SQLite history: a failing script rolls back; a script's own transaction runs as written", async () => {
  const db = new DatabaseSync(":memory:");
  const history = sqliteHistory(db);
  await assertRejects(
    () => history.apply(file("1", "CREATE TABLE a (id INTEGER); INSERT INTO nope VALUES (1);")),
    Error,
    "migration 1_m1.sql failed",
  );
  assertEquals(tables(db), []);
  assertEquals(await history.applied(), []);
  assert(await history.apply(file("2", "BEGIN;\nCREATE TABLE own (id INTEGER);\nCOMMIT;")));
  assertEquals(tables(db), ["own"]);
  db.close();
});

Deno.test("migrateSqlite / sqliteMigrationStatus: the runner jobs/migrate.ts calls", async () => {
  const root = await tempProject({
    "migrations/1_a.sql":
      "-- migrate:up\nCREATE TABLE a (id INTEGER);\n-- migrate:down\nDROP TABLE a;",
    "migrations/2_b.sql": "CREATE TABLE b (id INTEGER);",
  });
  const db = new DatabaseSync(":memory:");
  try {
    assertEquals(await migrateSqlite(db, { dir: `${root}/migrations`, dryRun: true }), {
      applied: [],
      pending: ["1_a.sql", "2_b.sql"],
      dryRun: true,
    });
    const result = await migrateSqlite(db, { dir: `${root}/migrations` });
    assertEquals(result.applied, ["1_a.sql", "2_b.sql"]);
    // The down section never ran.
    assertEquals(tables(db), ["a", "b"]);
    db.exec("INSERT INTO _migrations (name, applied_at) VALUES ('0_gone.sql', '2026-01-01')");
    const status = await sqliteMigrationStatus(db, { dir: `${root}/migrations` });
    assertEquals(status.pending, []);
    assertEquals(status.unknown, ["0_gone.sql"]);
    assertEquals(status.migrations.map((m) => m.applied), [true, true]);
  } finally {
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("migratePostgres runs only a file's up section", async () => {
  const root = await tempProject({
    "migrations/1_a.sql": "-- migrate:up\ncreate table a();\n-- migrate:down\ndrop table a;",
    "migrations/1_a.down.sql": "",
  });
  try {
    const sql = scriptedSql(() => []);
    await migratePostgres(sql, { dir: `${root}/migrations` });
    assert(sql.calls.some((c) => c.text.includes("create table a()")));
    assert(!sql.calls.some((c) => c.text.includes("drop table a")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("postgresHistory: the _migrations table, locked transactions, checksums", async () => {
  const rows = [{ name: "1_m1.sql", checksum: "x", applied_at: "2026-01-01T00:00:00Z" }];
  const sql = scriptedSql((text) => {
    if (text.startsWith("SELECT name, checksum")) return rows;
    if (text.startsWith("SELECT 1 AS hit")) return [];
    return [];
  });
  const history = postgresHistory(sql);
  assertEquals(history.keyOf(file("1", "")), "1_m1.sql");
  const applied = await history.applied();
  assertEquals(applied[0].version, "1");
  assertEquals(applied[0].checksum, "x");
  await history.apply(file("2", "create table b();"));
  assert(sql.calls.some((c) => c.text.startsWith("SELECT pg_advisory_xact_lock")));
  assert(sql.calls.some((c) => c.text.includes('INSERT INTO "_migrations"')));
  await history.revert(file("2", "x", "drop table b;"));
  assert(sql.calls.some((c) => c.text === "drop table b;"));
  assert(sql.calls.some((c) => c.text.startsWith('DELETE FROM "_migrations"')));
  await history.record(file("3", "y"));
  assert(sql.calls.some((c) => c.text.includes("ON CONFLICT (name)")));
  await history.forget(applied[0]);
  // A migration that manages its own transaction is refused.
  await assertRejects(
    () => history.apply(file("4", "BEGIN;\ncreate table c();\nCOMMIT;")),
    Error,
    "manages its own transaction",
  );
  // `listMigrations` flags a changed applied file through the checksum.
  const listed = await listMigrations(history, [file("1", "changed")], () => Promise.resolve("y"));
  assertEquals(listed[0].changed, true);
});

Deno.test("supabaseHistory: the Supabase CLI's table, keyed by version, statements kept", async () => {
  const sql = scriptedSql((text) => {
    if (text.startsWith("SELECT version, name, array_to_json")) {
      return [{ version: "1", name: "m1", statements: JSON.stringify(["create table a()"]) }];
    }
    return [];
  });
  const history = supabaseHistory(sql);
  assertEquals(history.format, "supabase");
  assertEquals(history.keyOf(file("7", "")), "7");
  assertEquals(await history.applied(), [{ key: "1", version: "1", name: "m1" }]);
  assertEquals(await history.statements!(), [
    { version: "1", name: "m1", statements: ["create table a()"] },
  ]);
  await history.apply(file("2", "create table b();\n"));
  const setup = sql.calls.map((c) => c.text);
  assert(setup.includes("CREATE SCHEMA IF NOT EXISTS supabase_migrations"));
  assert(setup.some((t) => t.includes("ADD COLUMN IF NOT EXISTS statements text[]")));
  const insert = sql.calls.find((c) => c.text.startsWith("INSERT INTO supabase_migrations"))!;
  assertEquals(insert.params, ["2", "m2", "create table b()"]);
  await history.revert(file("2", "x", "drop table b;"));
  assert(sql.calls.some((c) => c.text.startsWith("DELETE FROM supabase_migrations")));
  await history.record(file("3", "y;"));
  await history.forget({ key: "3", version: "3" });
  // A database without the table: an empty history.
  const missing = supabaseHistory(scriptedSql(() => {
    throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
  }));
  assertEquals(await missing.applied(), []);
  await assertRejects(
    () =>
      supabaseHistory(scriptedSql(() => {
        throw Object.assign(new Error("boom"), { code: "XX000" });
      })).applied(),
    Error,
    "boom",
  );
  assertStringIncludes(new NoDownScriptError(["a.sql"]).message, "--force-reset");
});
