// Boot-time DDL (src/server/postgres-boot.ts) against the fake client: with it on, a first run
// applies a feature's migrations with the server's notices silenced and prints ONE line for it
// (none on a later run); with `DENEXT_BOOT_DDL=off`, nothing is created, a missing schema fails
// with a BootSchemaError naming the migrations, and a server refuses to start until the schema
// every store of the config needs is there. Against a real server (notices counted, a fresh
// database refused): tests/postgres-boot-integration.test.ts.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  BOOT_DDL_ENV,
  bootDdlEnabled,
  bootMigrate,
  BootSchemaError,
  registerBootCheck,
  verifyBootSchemas,
} from "../src/server/postgres-boot.ts";
import { QUIET_SQL } from "../src/server/postgres-migrate.ts";
import { postgresAuthAdapter } from "../src/server/auth/postgres-adapter.ts";
import { postgresCacheStore } from "../src/server/postgres-cache.ts";
import { postgresJobHistoryStore } from "../src/server/postgres-job-history.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { fakeSqlClient } from "./helpers/fake-sql-client.ts";

const MIGRATIONS = [
  { name: "app_0001", sql: "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY)" },
  { name: "app_0002", sql: "CREATE TABLE IF NOT EXISTS gadgets (id TEXT PRIMARY KEY)" },
];

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

/** The tables the fake's SQLite holds. */
function tables(sql: ReturnType<typeof fakeSqlClient>): string[] {
  return (sql.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>).map((r) => r.name);
}

Deno.test("bootDdlEnabled: on unless DENEXT_BOOT_DDL is off / 0 / false / no", async () => {
  await withBootDdl(undefined, () => Promise.resolve(assert(bootDdlEnabled())));
  for (const off of ["off", "0", "false", "no", " OFF "]) {
    await withBootDdl(off, () => Promise.resolve(assert(!bootDdlEnabled(), off)));
  }
  for (const on of ["on", "1", "true", ""]) {
    await withBootDdl(on, () => Promise.resolve(assert(bootDdlEnabled(), on)));
  }
});

Deno.test("bootMigrate: a first run is quiet and prints one line; a later run prints none", async () => {
  await withBootDdl(undefined, async () => {
    const sql = fakeSqlClient();
    const first = await infoLines(() =>
      bootMigrate(sql, { migrations: MIGRATIONS, table: "app_migrations", feature: "widgets" })
    );
    assertEquals(first, [
      "[denext] widgets: applied 2 migrations to app_migrations (app_0001, app_0002)",
    ]);
    // Each migration's transaction raised client_min_messages before anything else ran.
    const begins = sql.statements.flatMap((s, i) => s === "BEGIN" ? [i] : []);
    assertEquals(begins.length, 2);
    for (const at of begins) assertEquals(sql.statements[at + 1], QUIET_SQL);
    const again = await infoLines(() =>
      bootMigrate(sql, { migrations: MIGRATIONS, table: "app_migrations", feature: "widgets" })
    );
    assertEquals(again, [], "nothing applied: nothing printed");
  });
});

Deno.test("bootMigrate: a long run names the first and last migration", async () => {
  await withBootDdl(undefined, async () => {
    const migrations = ["a", "b", "c", "d"].map((n, i) => ({
      name: `m_000${i + 1}`,
      sql: `CREATE TABLE IF NOT EXISTS t_${n} (id TEXT)`,
    }));
    const lines = await infoLines(() =>
      bootMigrate(fakeSqlClient(), { migrations, table: "m_migrations", feature: "four" })
    );
    assertEquals(lines, ["[denext] four: applied 4 migrations to m_migrations (m_0001 … m_0004)"]);
  });
});

Deno.test("bootMigrate with DENEXT_BOOT_DDL=off creates nothing and names what is missing", async () => {
  const sql = fakeSqlClient();
  await withBootDdl("off", async () => {
    const error = await assertRejects(
      () =>
        bootMigrate(sql, { migrations: MIGRATIONS, table: "app_migrations", feature: "widgets" }),
      BootSchemaError,
    );
    assertEquals(error.code, "boot_schema_missing");
    assertEquals(error.missing, ["app_migrations:app_0001", "app_migrations:app_0002"]);
    assertStringIncludes(error.message, "widgets: DENEXT_BOOT_DDL=off");
    assertStringIncludes(error.message, "app_0001, app_0002");
  });
  assertEquals(tables(sql), [], "no DDL ran");
  // Applied out of band (boot DDL on, as a release step would): the check passes.
  await withBootDdl(
    undefined,
    () =>
      infoLines(() =>
        bootMigrate(sql, { migrations: MIGRATIONS, table: "app_migrations", feature: "widgets" })
      ),
  );
  await withBootDdl(
    "off",
    () => bootMigrate(sql, { migrations: MIGRATIONS, table: "app_migrations", feature: "widgets" }),
  );
  // A later denext adds a migration: it is reported, not applied.
  const more = [...MIGRATIONS, { name: "app_0003", sql: "CREATE TABLE gizmos (id TEXT)" }];
  await withBootDdl("off", async () => {
    const error = await assertRejects(
      () => bootMigrate(sql, { migrations: more, table: "app_migrations", feature: "widgets" }),
      BootSchemaError,
    );
    assertEquals(error.missing, ["app_migrations:app_0003"]);
  });
  assert(!tables(sql).includes("gizmos"));
});

Deno.test("DENEXT_BOOT_DDL=off: the stores check their tables on use instead of creating them", async () => {
  await withBootDdl("off", async () => {
    const sql = fakeSqlClient();
    const adapter = postgresAuthAdapter({ sql });
    await assertRejects(() => Promise.resolve(adapter.getUser("u1")), BootSchemaError);
    const cache = postgresCacheStore({ sql });
    await assertRejects(() => Promise.resolve(cache.getData("k")), BootSchemaError);
    // The job history never fails a job: its check is the server's start.
    postgresJobHistoryStore({ sql });
    const error = await assertRejects(() => verifyBootSchemas(), BootSchemaError);
    assertStringIncludes(error.message, "postgresJobHistoryStore");
    assertEquals(tables(sql), [], "no DDL ran");
  });
});

const load = ((path: string) => import(path)) as unknown as ModuleLoader;

/** Set the config's plugins up the way `denext start` (or `denext build`) does. */
function setUp(mode: "prod" | "build", config: DenextConfig = {}): Promise<void> {
  resetPlugins();
  return applyPlugins({ projectRoot: "/tmp/x", appDir: "/tmp/x/app", config, mode, load });
}

Deno.test("DENEXT_BOOT_DDL=off: a server refuses to start until every store's schema is there", async () => {
  await withBootDdl("off", async () => {
    await verifyBootSchemas().catch(() => {}); // nothing left over from another test
    const sql = fakeSqlClient();
    postgresAuthAdapter({ sql });
    postgresCacheStore({ sql });
    // A build never connects.
    await setUp("build");
    // The start does — and names both features.
    const error = await assertRejects(() => setUp("prod"), BootSchemaError);
    assertStringIncludes(error.message, "2 features can't start with DENEXT_BOOT_DDL=off");
    assertStringIncludes(error.message, "postgresAuthAdapter");
    assertStringIncludes(error.message, "postgresCacheStore");
    assert(error.missing.some((m) => m.startsWith("auth_migrations:")));
    assert(error.missing.some((m) => m.startsWith("cache_migrations:")));
    assertEquals(tables(sql), []);
    // Applied out of band: the next start passes.
    await withBootDdl(undefined, () =>
      infoLines(async () => {
        await postgresAuthAdapter({ sql }).getUser("u1");
        await postgresCacheStore({ sql }).getData("k");
      }));
    postgresAuthAdapter({ sql });
    postgresCacheStore({ sql });
    await setUp("prod");
  });
  resetPlugins();
});

Deno.test("registerBootCheck: a no-op with boot DDL on; each check runs once", async () => {
  let runs = 0;
  await withBootDdl(undefined, async () => {
    registerBootCheck(() => Promise.resolve(void runs++));
    await verifyBootSchemas();
  });
  assertEquals(runs, 0);
  await withBootDdl("off", async () => {
    registerBootCheck(() => Promise.resolve(void runs++));
    await verifyBootSchemas();
    await verifyBootSchemas();
  });
  assertEquals(runs, 1);
});
