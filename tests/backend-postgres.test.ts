// `@denext/backend` Postgres: `backend({ postgres })` installs the client `db()` returns (a
// client it opened from a URL is closed on drain; one the app passed is not), `db()` explains a
// missing configuration or a Deno without `Deno.SQL`, and `backendAuthAdapter()` meets the
// shared AuthAdapter contract over that client.

import { assert, assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { PostgresUnsupportedError } from "../src/server/postgres.ts";
import { backend, backendAuthAdapter, type PostgresOptions } from "../packages/backend/mod.ts";
import { db } from "../packages/backend/server.ts";
import { deferredClient, installPostgres } from "../packages/backend/src/postgres.ts";
import { fakeSqlClient } from "./helpers/fake-sql-client.ts";
import { adapterContract } from "./helpers/auth-adapter-contract.ts";

const load = ((path: string) => import(path)) as unknown as ModuleLoader;

async function setUp(postgres: PostgresOptions): Promise<void> {
  resetPlugins();
  installPostgres(undefined);
  await applyPlugins({
    projectRoot: "/tmp/x",
    appDir: "/tmp/x/app",
    config: { plugins: [backend({ postgres })] } as DenextConfig,
    mode: "prod",
    load,
  });
}

/** Run `fn` with `Deno.SQL` replaced (or removed, for `undefined`), and `DATABASE_URL` set. */
async function withRuntime(
  ctor: unknown,
  url: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const deno = Deno as unknown as { SQL?: unknown };
  const had = Object.getOwnPropertyDescriptor(deno, "SQL");
  const before = Deno.env.get("DATABASE_URL");
  Object.defineProperty(deno, "SQL", { value: ctor, configurable: true, writable: true });
  if (url === undefined) Deno.env.delete("DATABASE_URL");
  else Deno.env.set("DATABASE_URL", url);
  try {
    await fn();
  } finally {
    if (had) Object.defineProperty(deno, "SQL", had);
    else delete deno.SQL;
    if (before === undefined) Deno.env.delete("DATABASE_URL");
    else Deno.env.set("DATABASE_URL", before);
    resetPlugins();
    installPostgres(undefined);
  }
}

Deno.test("db() before backend({ postgres }) names the missing configuration", () => {
  installPostgres(undefined);
  assertThrows(() => db(), Error, "add backend({ postgres");
});

Deno.test("backend({ postgres: { sql } }): db.service() is that client, never closed by the plugin", async () => {
  const sql = fakeSqlClient();
  await setUp({ sql });
  try {
    assertEquals(db.service(), sql);
    assertEquals(await db.service()`select ${1} as one`, [{ one: 1 }]);
    await runPluginTeardown();
    assertEquals(sql.closes, 0);
  } finally {
    resetPlugins();
    installPostgres(undefined);
  }
});

Deno.test("backend({ postgres: {} }) opens DATABASE_URL on Deno.SQL and closes it on drain", async () => {
  const sql = fakeSqlClient();
  const urls: unknown[] = [];
  class FakeSql {
    constructor(url: unknown) {
      urls.push(url);
      return sql;
    }
  }
  await withRuntime(FakeSql, "postgres://u@h/app", async () => {
    await setUp({});
    assertEquals(db.service(), sql);
    assertEquals(urls, ["postgres://u@h/app"]);
    await runPluginTeardown();
    assertEquals(sql.closes, 1);
    await setUp({ url: "postgres://explicit/db" });
    assertEquals(urls[1], "postgres://explicit/db", "an explicit url wins over DATABASE_URL");
  });
});

Deno.test("backend({ postgres }) on a Deno without Deno.SQL: setup succeeds, db() explains", async () => {
  await withRuntime(undefined, "postgres://u@h/app", async () => {
    await setUp({});
    const error = assertThrows(() => db());
    assertInstanceOf(error, PostgresUnsupportedError);
    assert(error.message.includes("fromPostgresJs"));
  });
  await withRuntime(undefined, undefined, async () => {
    await setUp({});
    assertThrows(() => db(), Error, "DATABASE_URL");
  });
});

Deno.test("backendAuthAdapter() meets the AuthAdapter contract over the backend's client", async (t) => {
  try {
    await adapterContract(t, async () => {
      await setUp({ sql: fakeSqlClient() });
      return backendAuthAdapter();
    });
  } finally {
    resetPlugins();
    installPostgres(undefined);
  }
});

Deno.test("backendAuthAdapter() can be built before setup; closing it leaves the pool open", async () => {
  const adapter = backendAuthAdapter({ migrate: true });
  const sql = fakeSqlClient();
  await setUp({ sql });
  try {
    const user = await adapter.createUser({ email: "a@x.test" });
    assertEquals((await adapter.getUser(user.id))?.email, "a@x.test");
    await adapter.close?.();
    assertEquals(sql.closes, 0);
    // The deferred client forwards the tagged template too, and its close is a no-op.
    const deferred = deferredClient();
    assertEquals(await deferred`select ${2} as two`, [{ two: 2 }]);
    await deferred.close();
    assertEquals(sql.closes, 0);
  } finally {
    resetPlugins();
    installPostgres(undefined);
  }
});
