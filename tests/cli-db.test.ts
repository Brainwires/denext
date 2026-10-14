// `denext migration …` and `denext db …` on SQLite (node:sqlite, real files): each action's flow
// through the CLI layer (target selection, history, output, --json), the hand-off to
// `@denext/backend`'s hooks, and one end-to-end run of the verb through cli.ts. Postgres (and a
// Supabase project's history) runs in tests/db-migrations-integration.test.ts.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { DB_ACTIONS } from "../src/cli/commands/db.ts";
import { MIGRATION_ACTIONS } from "../src/cli/commands/migration.ts";
import { type MigrationRun, setDotenv } from "../src/cli/db/migrations.ts";
import { backendHooks } from "../src/cli/db/project.ts";
import { LINKED_URL_ENV, openTarget, sqlitePathOf } from "../src/cli/db/target.ts";
import { scriptedSql } from "./helpers/scripted-sql.ts";

async function project(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "dnx-cli-db-" });
  for (const [path, text] of Object.entries(files)) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  }
  return root;
}

/** Run one action; resolves what it printed (an error rejects). */
async function act(
  table: Record<string, (run: MigrationRun) => Promise<void>>,
  root: string,
  positionals: string[],
  flags: Record<string, string | number | boolean> = {},
  options: { json?: boolean; env?: Record<string, string>; stdin?: string } = {},
): Promise<string[]> {
  const lines: string[] = [];
  await table[positionals[0]]({
    ctx: {
      positionals,
      flags,
      global: { cwd: root, json: options.json === true, verbose: false, quiet: false },
      rest: [],
    },
    projectDir: root,
    io: { log: (l) => lines.push(l), error: (l) => lines.push(`error: ${l}`) },
    env: (name) => options.env?.[name],
    stdin: () => Promise.resolve(options.stdin ?? ""),
  });
  return lines;
}

const A = "-- migrate:up\nCREATE TABLE a (id INTEGER);\n-- migrate:down\nDROP TABLE a;\n";
const B = "CREATE TABLE b (id INTEGER);\n";

function tables(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
    ).all() as { name: string }[]).map((r) => r.name);
  } finally {
    db.close();
  }
}

Deno.test("migration list / up / down on SQLite, with --json, --to and --dry-run", async () => {
  const root = await project({
    "migrations/1_a.sql": A,
    "migrations/2_b.sql": B,
    "migrations/2_b.down.sql": "DROP TABLE b;",
  });
  const m = MIGRATION_ACTIONS;
  try {
    // Listing does not create the database.
    const before = await act(m, root, ["list"]);
    assertEquals(before[0], "sqlite:app.db (_migrations), migrations/");
    assertStringIncludes(before.join("\n"), "1              |                |");
    await assertRejects(() => Deno.stat(`${root}/app.db`), Deno.errors.NotFound);
    assertEquals(await act(m, root, ["up"], { "dry-run": true }), [
      "  would apply 1_a.sql",
      "  would apply 2_b.sql",
    ]);
    assertEquals(await act(m, root, ["up"], { to: "1" }), ["  applied 1_a.sql"]);
    assertEquals(tables(`${root}/app.db`), ["a"]);
    assertEquals(JSON.parse((await act(m, root, ["up"], {}, { json: true })).join("\n")), {
      applied: ["2_b.sql"],
      dryRun: false,
    });
    assertEquals(await act(m, root, ["up"]), ["The database is up to date."]);
    const listed = JSON.parse((await act(m, root, ["list"], {}, { json: true })).join("\n"));
    assertEquals(listed.history, "_migrations");
    assertEquals(listed.migrations.map((r: { remote: boolean }) => r.remote), [true, true]);
    assertEquals(await act(m, root, ["down"], { steps: 2, "dry-run": true }), [
      "  would revert 2_b.sql",
      "  would revert 1_a.sql",
    ]);
    assertEquals(await act(m, root, ["down"]), ["  reverted 2_b.sql"]);
    assertEquals(JSON.parse((await act(m, root, ["down"], {}, { json: true })).join("\n")), {
      reverted: ["1_a.sql"],
      dryRun: false,
    });
    assertEquals(await act(m, root, ["down"]), ["Nothing to roll back."]);
    assertEquals(tables(`${root}/app.db`), []);
    await assertRejects(() => act(m, root, ["down"], { steps: "x" }), TypeError, "--steps");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("db rollback --force-reset, db reset, db seed and repair on SQLite", async () => {
  const root = await project({
    "migrations/1_a.sql": A,
    "migrations/2_b.sql": B,
    "seed.sql": "INSERT INTO a VALUES (7);",
  });
  try {
    await act(DB_ACTIONS, root, ["migrate"]);
    await assertRejects(
      () => act(DB_ACTIONS, root, ["rollback"]),
      Error,
      "no down script for 2_b.sql",
    );
    await assertRejects(
      () => act(DB_ACTIONS, root, ["rollback"], { "force-reset": true }),
      Error,
      "--yes",
    );
    assertEquals(
      await act(DB_ACTIONS, root, ["rollback"], { "force-reset": true, "dry-run": true }),
      ["  would drop 2_b.sql"],
    );
    const reset = await act(DB_ACTIONS, root, ["rollback"], { "force-reset": true, yes: true });
    assertEquals(reset, [
      "  dropping 2_b.sql",
      "Reset sqlite:app.db.",
      "  applied 1_a.sql",
      "  seeded from seed.sql",
    ]);
    assertEquals(tables(`${root}/app.db`), ["a"]);
    // Reverting everything leaves nothing applied.
    await act(DB_ACTIONS, root, ["rollback"], { "force-reset": true, yes: true, "no-seed": true });
    assertEquals(tables(`${root}/app.db`), []);
    await assertRejects(() => act(DB_ACTIONS, root, ["reset"]), Error, "--yes");
    const full = await act(DB_ACTIONS, root, ["reset"], { yes: true, version: "1" });
    assertEquals(full.slice(1), ["  applied 1_a.sql", "  seeded from seed.sql"]);
    assertEquals(await act(DB_ACTIONS, root, ["seed"]), ["  seeded from seed.sql"]);
    assertEquals(JSON.parse((await act(DB_ACTIONS, root, ["seed"], {}, { json: true }))[0]), {
      seeded: ["seed.sql"],
    });
    // repair
    await assertRejects(() => act(MIGRATION_ACTIONS, root, ["repair", "2"]), TypeError, "--status");
    await assertRejects(
      () => act(MIGRATION_ACTIONS, root, ["repair"], { status: "applied" }),
      TypeError,
      "versions",
    );
    assertEquals(await act(MIGRATION_ACTIONS, root, ["repair", "2"], { status: "applied" }), [
      "  marked applied: 2_b.sql",
    ]);
    assertEquals(
      JSON.parse(
        (await act(MIGRATION_ACTIONS, root, ["repair", "2"], { status: "reverted" }, {
          json: true,
        })).join("\n"),
      ),
      { status: "reverted", migrations: ["2_b.sql"] },
    );
    // `db status` is `migration list`.
    assertStringIncludes((await act(DB_ACTIONS, root, ["status"])).join("\n"), "2              |");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
  const bare = await project({});
  try {
    assertStringIncludes((await act(DB_ACTIONS, bare, ["seed"]))[0], "Nothing to seed");
    assertStringIncludes((await act(MIGRATION_ACTIONS, bare, ["list"])).at(-1)!, "No migrations");
  } finally {
    await Deno.remove(bare, { recursive: true });
  }
});

Deno.test("migration new (--stdin), squash, fetch on SQLite", async () => {
  const root = await project({});
  try {
    const created = await act(MIGRATION_ACTIONS, root, ["new", "Add users"]);
    assert(/^Created migrations\/\d{14}_add_users\.sql$/.test(created[0]), created[0]);
    assertEquals(created[1], "Created jobs/migrate.ts");
    const [name] = [...Deno.readDirSync(`${root}/migrations`)].map((e) => e.name);
    const text = await Deno.readTextFile(`${root}/migrations/${name}`);
    assertStringIncludes(text, "-- migrate:down\nDROP TABLE IF EXISTS example;");
    await assertRejects(() => act(MIGRATION_ACTIONS, root, ["new"]), TypeError, "name");
    await new Promise((r) => setTimeout(r, 1100));
    await act(MIGRATION_ACTIONS, root, ["new", "piped"], { stdin: true }, {
      stdin: "CREATE TABLE piped (id INTEGER);",
    });
    const piped = [...Deno.readDirSync(`${root}/migrations`)].map((e) => e.name).sort()[1];
    assertStringIncludes(
      await Deno.readTextFile(`${root}/migrations/${piped}`),
      "CREATE TABLE piped (id INTEGER);\n\n-- migrate:down\n",
    );
    // fetch reads the Supabase history only.
    await assertRejects(() => act(MIGRATION_ACTIONS, root, ["fetch"]), Error, "not SQL");
    // squash: two files into the last one; applied history rewritten with --db-url.
    await act(MIGRATION_ACTIONS, root, ["up"]);
    const squashed = await act(MIGRATION_ACTIONS, root, ["squash"], { "db-url": "sqlite:app.db" });
    assertEquals(squashed[0], "  history: 2 rows → " + piped);
    assertStringIncludes(squashed[1], `Squashed 2 migrations into migrations/${piped}`);
    assertEquals([...Deno.readDirSync(`${root}/migrations`)].map((e) => e.name), [piped]);
    const merged = await Deno.readTextFile(`${root}/migrations/${piped}`);
    assertStringIncludes(merged, "-- migrate:up\n");
    assertStringIncludes(merged, `-- ${name}\n`);
    const list = JSON.parse(
      (await act(MIGRATION_ACTIONS, root, ["list"], {}, { json: true })).join("\n"),
    );
    assertEquals(list.migrations.length, 1);
    assertEquals(list.migrations[0].remote, true);
    assertEquals(await act(MIGRATION_ACTIONS, root, ["squash"]), [
      "Nothing to squash (fewer than two migrations).",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("db link: stores the URL in .env, never prints the password", async () => {
  const root = await project({ ".env": "OTHER=1\n", ".gitignore": "node_modules\n" });
  try {
    await assertRejects(() => act(DB_ACTIONS, root, ["link"]), TypeError, "--url");
    await assertRejects(
      () => act(DB_ACTIONS, root, ["link"], { url: "mysql://x" }),
      TypeError,
      "postgres://",
    );
    const url = "postgres://app:s3cret@db.example:5432/app";
    const lines = await act(DB_ACTIONS, root, ["link"], { url, "skip-check": true });
    assert(!lines.join("\n").includes("s3cret"), lines.join("\n"));
    assertStringIncludes(lines[0], "postgres://app:•••@db.example:5432/app");
    assertStringIncludes(lines[1], ".gitignore");
    const env = await Deno.readTextFile(`${root}/.env`);
    assertEquals(env, `OTHER=1\n${LINKED_URL_ENV}="${url}"\n`);
    assertEquals(
      setDotenv(env, LINKED_URL_ENV, "postgres://b"),
      `OTHER=1\n${LINKED_URL_ENV}="postgres://b"\n`,
    );
    assertEquals(setDotenv("A=1", "B", "x"), 'A=1\nB="x"\n');
    assertEquals(setDotenv("", "B", "x"), 'B="x"\n');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("targets: --db-url SQLite forms, --linked, the backend's client, Postgres-only verbs", () => {
  assertEquals(sqlitePathOf("sqlite:data/x.db"), "data/x.db");
  assertEquals(sqlitePathOf("file:///tmp/x.db"), "/tmp/x.db");
  assertEquals(sqlitePathOf("x.sqlite3"), "x.sqlite3");
  assertEquals(sqlitePathOf("mysql://x"), undefined);
  assertThrows(() => openTarget("/tmp", { dbUrl: "mysql://x" }), TypeError, "--db-url");
  assertThrows(() => openTarget("/tmp", { linked: true }, () => undefined), Error, "db link");
  assertThrows(
    () => openTarget("/tmp", { readOnly: true, postgresOnly: "denext db lint" }, () => undefined),
    Error,
    "denext db lint needs Postgres",
  );
  const slot = Symbol.for("denext.backend.postgres");
  const sql = scriptedSql(() => []);
  (globalThis as Record<symbol, unknown>)[slot] = { sql };
  try {
    const target = openTarget(
      "/tmp",
      {},
      (n) => n === "DATABASE_URL" ? "postgres://u:p@h/db" : undefined,
    );
    assertEquals(target.dialect, "postgres");
    assertEquals(target.sql, sql);
    assertEquals(target.url, "postgres://u:p@h/db");
    assertEquals(target.display, "postgres://u:•••@h/db");
  } finally {
    delete (globalThis as Record<symbol, unknown>)[slot];
  }
});

Deno.test("db <postgres action>: needs @denext/backend, then runs its hook", async () => {
  const root = await project({});
  const hooksSlot = Symbol.for("denext.backend.db");
  const pgSlot = Symbol.for("denext.backend.postgres");
  const global = globalThis as Record<symbol, unknown>;
  try {
    assertEquals(backendHooks(), undefined);
    await assertRejects(() => act(DB_ACTIONS, root, ["lint"]), Error, "@denext/backend");
    const seen: string[] = [];
    const sql = scriptedSql(() => []);
    global[pgSlot] = { sql };
    global[hooksSlot] = {
      migrations: () => [{ name: "backend_0001", sql: "create schema svc" }],
      table: "backend_migrations",
      serviceSchemas: ["svc"],
      actions: {
        lint: async (
          input: { applyAll(sql: unknown): Promise<string[]>; io: { log(l: string): void } },
        ) => {
          seen.push("lint");
          input.io.log(`applied ${(await input.applyAll(sql)).join(",")}`);
        },
      },
      seedBuckets: () => Promise.resolve(["bucket avatars"]),
    };
    assertEquals(await act(DB_ACTIONS, root, ["lint"]), ["applied backend_0001"]);
    assertEquals(seen, ["lint"]);
    // Push applies the backend's migrations first; seed seeds the buckets; reset drops its schemas.
    const pushed = await act(DB_ACTIONS, root, ["push"], { "include-seed": true });
    assertEquals(pushed, ["  applied backend_0001  (@denext/backend)", "  bucket avatars"]);
    await act(DB_ACTIONS, root, ["reset"], { yes: true });
    const drops = sql.calls.filter((c) => c.text.startsWith("DROP SCHEMA")).map((c) => c.text);
    assertEquals(drops, [
      'DROP SCHEMA IF EXISTS "public" CASCADE',
      'DROP SCHEMA IF EXISTS "svc" CASCADE',
    ]);
  } finally {
    delete global[hooksSlot];
    delete global[pgSlot];
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cli.ts: denext migration / db dispatch, unknown actions", async () => {
  const root = await project({ "deno.json": "{}", "migrations/1_a.sql": A });
  try {
    const run = async (...args: string[]) => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", new URL("../cli.ts", import.meta.url).pathname, ...args, "--cwd", root],
        stdout: "piped",
        stderr: "piped",
        env: { NO_COLOR: "1", DENEXT_DENO: "stock" },
      }).output();
      const text = (b: Uint8Array) => new TextDecoder().decode(b);
      return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) };
    };
    const up = await run("db", "migrate");
    assertEquals(up.code, 0, up.stderr);
    assertStringIncludes(up.stdout, "applied 1_a.sql");
    const bad = await run("migration", "sideways");
    assertEquals(bad.code, 1);
    assertStringIncludes(bad.stderr, 'unknown action "sideways"');
    const failed = await run("migration", "down", "--steps", "3");
    assertEquals(failed.code, 0, failed.stderr);
    const refused = await run("db", "reset");
    assertEquals(refused.code, 1);
    assertStringIncludes(refused.stderr, "denext db reset: reset drops every table");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
