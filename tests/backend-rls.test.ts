// `@denext/backend` row-level security, against the fake client: the SQL `db()` issues (one
// transaction per query, the role and claims set transaction-locally before the query), who it
// acts as (the request's session, anon outside a request, an explicit user or session, the
// service escape hatch), the claims shape, nested transactions as savepoints, rollback on a
// thrown error, and the migration. What only a real server shows (policies enforced, nothing
// left on pooled connections, the role switch) is in tests/backend-rls-integration.test.ts.

import { assert, assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";
import type { DenextPlugin } from "../src/plugin/mod.ts";
import { backend, rlsMigrations, type RlsOptions, rlsSetupSql } from "../packages/backend/mod.ts";
import { db } from "../packages/backend/server.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { RLS_SETUP, sessionClaims } from "../packages/backend/src/rls.ts";
import { type FakeSqlClient, fakeSqlClient } from "./helpers/fake-sql-client.ts";

const load = ((path: string) => import(path)) as unknown as ModuleLoader;
const ORIGIN = "https://app.test";
const authConfig: AuthConfig = {
  secret: "rls-secret-at-least-32-characters-long!",
  canonicalOrigin: ORIGIN,
  providers: [credentials({ authorize: () => null })],
};

/** Install `backend({ postgres: { sql, rls } })` (and any other plugins) on a fresh fake. */
async function setUp(
  rls: RlsOptions = { migrate: false },
  plugins: DenextPlugin[] = [],
): Promise<FakeSqlClient> {
  const sql = fakeSqlClient();
  resetPlugins();
  installPostgres(undefined);
  await applyPlugins({
    projectRoot: "/tmp/x",
    appDir: "/tmp/x/app",
    config: { plugins: [...plugins, backend({ postgres: { sql, rls } })] } as DenextConfig,
    mode: "prod",
    load,
  });
  return sql;
}

function tearDown(): void {
  resetPlugins();
  installPostgres(undefined);
}

/** What a query sees: the role and the claims, read back inside its own transaction. */
const WHO =
  "select current_setting('role') as role, current_setting('request.jwt.claims') as claims";

async function whoAmI(client = db()): Promise<{ role: string; claims: Record<string, unknown> }> {
  const [row] = await client.unsafe<{ role: string; claims: string }>(WHO);
  return { role: row.role, claims: JSON.parse(row.claims) };
}

/** The statements after `from`, with the setup's parameters dropped (they are bound). */
function since(sql: FakeSqlClient, from: number): string[] {
  return sql.statements.slice(from);
}

const SETUP = RLS_SETUP.replace(/\$(\d+)/g, "?$1");

Deno.test("db() outside a request runs as anon, in a transaction that sets the role first", async () => {
  const sql = await setUp();
  try {
    const before = sql.statements.length;
    assertEquals(await whoAmI(), { role: "anon", claims: { role: "anon" } });
    assertEquals(since(sql, before), ["BEGIN", SETUP, WHO, "COMMIT"]);
    assertEquals(sql.settings.size, 0, "the settings ended with the transaction");
    // The tagged template goes through the same scope, values bound.
    const rows = await db()`select ${7} as n, current_setting('role') as role`;
    assertEquals(rows, [{ n: 7, role: "anon" }]);
  } finally {
    tearDown();
  }
});

Deno.test("db({ as: user }) acts as that user; sub, role and email cannot be overridden", async () => {
  await setUp();
  try {
    const me = await whoAmI(db({
      as: {
        id: "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a0001",
        email: "a@x.test",
        roles: ["editor"],
        claims: { tenant: "t1", sub: "someone-else", role: "service_role", email: "b@x.test" },
      },
    }));
    assertEquals(me.role, "authenticated");
    assertEquals(me.claims, {
      aud: "authenticated",
      app_metadata: { roles: ["editor"] },
      is_anonymous: false,
      tenant: "t1",
      sub: "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a0001",
      role: "authenticated",
      email: "a@x.test",
    });
    await assertRejects(() => whoAmI(db({ as: { id: "" } })), TypeError, "non-empty string id");
    assertEquals((await whoAmI(db({ as: "anon" }))).role, "anon");
  } finally {
    tearDown();
  }
});

const SESSION: AuthSession = {
  user: {
    id: "u-1",
    email: "u1@x.test",
    name: "U One",
    emailVerified: true,
    roles: ["admin"],
  },
  provider: "github",
  expiresAt: 2_000_000_000,
  issuedAt: 1_900_000_000,
  authTime: 1_899_999_000,
  sessionId: "sess-1",
  amr: ["pwd", "totp"],
  v: 2,
};

Deno.test("a session's claims have the Supabase access-token shape", async () => {
  assertEquals(sessionClaims(SESSION), {
    aud: "authenticated",
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    session_id: "sess-1",
    aal: "aal2",
    amr: [
      { method: "pwd", timestamp: 1_899_999_000 },
      { method: "totp", timestamp: 1_899_999_000 },
    ],
    app_metadata: { provider: "github", providers: ["github"], roles: ["admin"] },
    user_metadata: { name: "U One", email_verified: true },
    is_anonymous: false,
    sub: "u-1",
    role: "authenticated",
    email: "u1@x.test",
  });
  const single = sessionClaims({
    ...SESSION,
    amr: ["pwd"],
    authTime: undefined,
    issuedAt: undefined,
  });
  assertEquals(single.aal, "aal1");
  assertEquals(single.amr, [{ method: "pwd" }]);
  // rls.claims adds the app's own; identity claims win.
  await setUp({ migrate: false, claims: (s) => ({ tenant: `t-${s.user.id}`, sub: "x" }) });
  try {
    const me = await whoAmI(db({ as: SESSION }));
    assertEquals(me.claims.tenant, "t-u-1");
    assertEquals(me.claims.sub, "u-1");
  } finally {
    tearDown();
  }
});

Deno.test("db.service() and db({ as: 'service' }) are the connecting role's client: no scope", async () => {
  const sql = await setUp();
  try {
    assertStrictEquals(db.service(), sql);
    assertStrictEquals(db({ as: "service" }), sql);
    const before = sql.statements.length;
    await db.service()`select 1 as one`;
    assertEquals(since(sql, before), ["select 1 as one"]);
  } finally {
    tearDown();
  }
});

Deno.test("db() inside a request acts as its signed-in user; signed out is anon", async () => {
  await setUp({ migrate: false }, [denextAuth(authConfig)]);
  try {
    const issuing = createRequestContext(new Request(`${ORIGIN}/`));
    await runWithContext(
      issuing,
      () => issueAuthSession(authConfig, { id: "user-a", email: "a@x.test" }, "credentials"),
    );
    const cookie = issuing.outgoingHeaders.getSetCookie().find((c) =>
      c.startsWith("__Host-denext_auth=")
    )!.split(";")[0];
    const signedIn = createRequestContext(new Request(`${ORIGIN}/`, { headers: { cookie } }));
    const me = await runWithContext(signedIn, () => whoAmI());
    assertEquals(me.role, "authenticated");
    assertEquals(me.claims.sub, "user-a");
    assertEquals(me.claims.email, "a@x.test");
    const anonymous = createRequestContext(new Request(`${ORIGIN}/`));
    assertEquals((await runWithContext(anonymous, () => whoAmI())).role, "anon");
  } finally {
    tearDown();
  }
});

Deno.test("db().begin scopes the whole transaction once; a nested begin is a savepoint", async () => {
  const sql = await setUp();
  try {
    const before = sql.statements.length;
    const result = await db({ as: { id: "u" } }).begin(async (tx) => {
      const [outer] = await tx<{ role: string }>`select current_setting('role') as role`;
      const inner = await tx.begin(async (nested) => {
        const [row] = await nested<
          { sub: string }
        >`select current_setting('request.jwt.claims') as sub`;
        return JSON.parse(row.sub).sub;
      });
      return [outer.role, inner];
    });
    assertEquals(result, ["authenticated", "u"]);
    const issued = since(sql, before);
    assertEquals(issued.filter((s) => s === SETUP).length, 1, "one setup per transaction");
    assertEquals(issued[0], "BEGIN");
    assertEquals(issued[1], SETUP);
    assert(issued.includes("SAVEPOINT s1") && issued.includes("RELEASE SAVEPOINT s1"));
    assertEquals(issued.at(-1), "COMMIT");
    assertEquals(sql.settings.size, 0);
  } finally {
    tearDown();
  }
});

Deno.test("a thrown error rolls the scoped transaction back and leaves no settings", async () => {
  const sql = await setUp();
  try {
    sql.raw.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    await assertRejects(
      () =>
        db({ as: { id: "u" } }).begin(async (tx) => {
          await tx`insert into notes (body) values (${"lost"})`;
          throw new Error("boom");
        }),
      Error,
      "boom",
    );
    assertEquals(sql.statements.at(-1), "ROLLBACK");
    assertEquals(sql.settings.size, 0);
    // A failing nested begin rolls back to its savepoint only.
    await db({ as: { id: "u" } }).begin(async (tx) => {
      await tx`insert into notes (body) values (${"kept"})`;
      await assertRejects(
        () =>
          tx.begin(() => {
            throw new Error("inner");
          }),
        Error,
        "inner",
      );
    });
    assert(sql.statements.includes("ROLLBACK TO SAVEPOINT s1"));
    assertEquals(sql.statements.at(-1), "COMMIT");
    // The transaction handle never closes or reserves the shared pool.
    await db().begin(async (tx) => {
      await assertRejects(() => tx.close(), Error, "not available in a transaction");
    });
    assertEquals(sql.closes, 0);
  } finally {
    tearDown();
  }
});

Deno.test("a failed setup fails the query and rolls back", async () => {
  const sql = await setUp();
  try {
    sql.failNext(
      /set_config\('role'/,
      Object.assign(new Error('role "anon" does not exist'), {
        code: "22023",
      }),
    );
    await assertRejects(() => db()`select 1 as one`, Error, "does not exist");
    assertEquals(sql.statements.at(-1), "ROLLBACK");
    assertEquals(sql.settings.size, 0);
  } finally {
    tearDown();
  }
});

Deno.test("a single scoped query hands begin() the setup and the query, synchronously and unstarted", async () => {
  const sql = await setUp();
  try {
    // What Deno.SQL needs to send BEGIN, both statements and COMMIT in one round trip: the
    // callback returns an array of not-yet-started queries, without awaiting anything.
    const shapes: Array<{ array: boolean; length: number; thenables: boolean; ranSync: number }> =
      [];
    const base = sql.begin.bind(sql);
    (sql as unknown as { begin: unknown }).begin = (fn: (tx: unknown) => unknown) =>
      base((tx) => {
        const before = sql.statements.length;
        const returned = fn(tx);
        const items = Array.isArray(returned) ? returned : [];
        shapes.push({
          array: Array.isArray(returned),
          length: items.length,
          thenables: items.every((item) => typeof item?.then === "function"),
          ranSync: sql.statements.length - before,
        });
        return returned as never;
      });
    const before = sql.statements.length;
    assertEquals(await db()`select ${1} as one`, [{ one: 1 }], "the query's rows, not the array");
    assertEquals(await db().unsafe("select 2 as two"), [{ two: 2 }]);
    await db().unsafe("select 3 as three").simple!();
    const expected = { array: true, length: 2, thenables: true, ranSync: 0 };
    assertEquals(shapes, [expected, expected, expected]);
    assertEquals(since(sql, before), [
      "BEGIN",
      SETUP,
      "select ?1 as one",
      "COMMIT",
      "BEGIN",
      SETUP,
      "select 2 as two",
      "COMMIT",
      "BEGIN",
      SETUP,
      "select 3 as three",
      "COMMIT",
    ]);
  } finally {
    tearDown();
  }
});

Deno.test("a failed setup aborts the single-query transaction: the query never succeeds", async () => {
  const sql = await setUp();
  try {
    sql.raw.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    sql.failNext(/set_config\('role'/, Object.assign(new Error("no role"), { code: "22023" }));
    await assertRejects(
      () => db()`insert into notes (body) values (${"unscoped"})`,
      Error,
      "no role",
    );
    assertEquals(sql.raw.prepare("select count(*) as n from notes").get(), { n: 0 });
    assertEquals(sql.statements.at(-1), "ROLLBACK");
  } finally {
    tearDown();
  }
});

Deno.test("a client whose begin() does not await a returned array is refused, nothing unscoped runs", async () => {
  const sql = await setUp();
  try {
    (sql as unknown as { begin: unknown }).begin = (fn: (tx: unknown) => unknown) =>
      Promise.resolve(fn(sql));
    const before = sql.statements.length;
    await assertRejects(() => db()`select 1 as one`, TypeError, "must await an array");
    assertEquals(since(sql, before), [], "neither the setup nor the query was started");
  } finally {
    tearDown();
  }
});

Deno.test("unsafe() and unsafe().simple() are scoped; a query runs once however often awaited", async () => {
  const sql = await setUp();
  try {
    const query = db().unsafe<{ role: string }>("select current_setting('role') as role");
    const [first, second] = await Promise.all([query, query]);
    assertEquals(first, [{ role: "anon" }]);
    assertStrictEquals(first, second);
    const before = sql.statements.length;
    await db().unsafe("create table t (id integer); insert into t values (1);").simple!();
    const issued = since(sql, before);
    assertEquals(issued[0], "BEGIN");
    assertEquals(issued[1], SETUP);
    assertEquals(issued.at(-1), "COMMIT");
    assertEquals(sql.raw.prepare("select count(*) as n from t").get(), { n: 1 });
    // begin(options, fn) passes the options through to BEGIN.
    const options: string[] = [];
    const base = sql.begin.bind(sql);
    (sql as unknown as { begin: unknown }).begin = (a: unknown, b?: unknown) => {
      if (typeof a === "string") options.push(a);
      return base((typeof a === "function" ? a : b) as never);
    };
    await (db().begin as unknown as (o: string, f: () => number) => Promise<number>)(
      "isolation level serializable",
      () => 1,
    );
    assertEquals(options, ["isolation level serializable"]);
  } finally {
    tearDown();
  }
});

Deno.test("the RLS migration runs on the first scoped query (memoized, retried after a failure)", async () => {
  const sql = await setUp({});
  try {
    // The fake is SQLite: the migration's DO blocks fail there, which is enough to see that the
    // first query waits for it, that it is not memoized as failed, and that no query ran.
    await assertRejects(() => db()`select 1 as one`);
    const tried = sql.statements.filter((s) => s.includes("backend_rls_0001")).length;
    assert(tried >= 1, "the migration was attempted");
    assert(!sql.statements.includes("select 1 as one"));
    await assertRejects(() => db()`select 1 as one`);
    assert(
      sql.statements.filter((s) => s.includes("backend_rls_0001")).length > tried,
      "a failed migration is retried",
    );
    // db.service() never waits for it.
    assertEquals(await db.service()`select 2 as two`, [{ two: 2 }]);
  } finally {
    tearDown();
  }
});

Deno.test("rlsMigrations / rlsSetupSql: Supabase's helpers, idempotent roles, a DBA script", () => {
  const [migration] = rlsMigrations();
  assertEquals(migration.name, "backend_rls_0001");
  for (const fn of ["auth.uid()", "auth.role()", "auth.email()", "auth.jwt()"]) {
    assert(migration.sql.includes(`to_regprocedure('${fn}') IS NULL`), fn);
  }
  assert(migration.sql.includes("CREATE ROLE anon NOLOGIN NOINHERIT"));
  assert(migration.sql.includes("CREATE ROLE authenticated NOLOGIN NOINHERIT"));
  assert(migration.sql.includes("current_setting('request.jwt.claims', true)"));
  // The runner refuses a migration with its own BEGIN/COMMIT; the DO blocks must not look like one.
  assert(!/^\s*(?:BEGIN|COMMIT|END|ROLLBACK)\s*;/im.test(migration.sql));
  const script = rlsSetupSql("app_user");
  assert(script.includes(`GRANT anon, authenticated TO "app_user";`));
  assert(!script.includes("format('GRANT"), "the DBA script grants to the named role");
  assertThrows(() => rlsSetupSql('x"; drop table users; --'), TypeError, "plain role name");
});

/** A signed-in request context for `id`. */
async function signedInContext(id: string, email: string) {
  const issuing = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(issuing, () => issueAuthSession(authConfig, { id, email }, "credentials"));
  const cookie =
    issuing.outgoingHeaders.getSetCookie().find((c) => c.startsWith("__Host-denext_auth="))!.split(
      ";",
    )[0];
  return createRequestContext(new Request(`${ORIGIN}/`, { headers: { cookie } }));
}

Deno.test("a db() client kept across requests acts as the request running each query, anon outside", async () => {
  await setUp({ migrate: false }, [denextAuth(authConfig)]);
  try {
    const a = await signedInContext("user-a", "a@x.test");
    const b = await signedInContext("user-b", "b@x.test");
    // Made inside request A (or at module scope), then used by request B and by a task.
    const kept = runWithContext(a, () => db());
    assertEquals((await runWithContext(a, () => whoAmI(kept))).claims.sub, "user-a");
    const inB = await runWithContext(b, () => whoAmI(kept));
    assertEquals([inB.role, inB.claims.sub], ["authenticated", "user-b"]);
    assertEquals(await whoAmI(kept), { role: "anon", claims: { role: "anon" } }, "fails closed");
    // The identity is the request's that MADE the query, even when it is awaited later.
    const made = runWithContext(b, () => kept.unsafe<{ role: string; claims: string }>(WHO));
    assertEquals(JSON.parse((await made)[0].claims).sub, "user-b");
    const moduleScope = db();
    assertEquals((await runWithContext(b, () => whoAmI(moduleScope))).claims.sub, "user-b");
    // An explicit identity stays fixed wherever it runs.
    const pinned = db({ as: { id: "pinned" } });
    assertEquals((await runWithContext(b, () => whoAmI(pinned))).claims.sub, "pinned");
  } finally {
    tearDown();
  }
});

Deno.test("legacy per-claim settings are blanked in every scoped transaction", async () => {
  const sql = await setUp();
  try {
    // A session-level value on a pooled connection (or a role / database default) …
    await db.service()`select set_config('request.jwt.claim.sub', 'attacker', false)`;
    await db.service()`select set_config('request.jwt.claim.email', 'x@evil.test', false)`;
    await db.service()`select set_config('request.jwt.claim.role', 'service_role', false)`;
    await db.service()`select set_config('request.jwt.claim', '{"sub":"attacker"}', false)`;
    // … is empty inside the scope, so auth.uid() / auth.email() / auth.role() / auth.jwt()
    // fall through to request.jwt.claims.
    const [row] = await db({ as: { id: "u-1" } }).unsafe<Record<string, string>>(
      `select current_setting('request.jwt.claim.sub') as sub,
        current_setting('request.jwt.claim.email') as email,
        current_setting('request.jwt.claim.role') as role,
        current_setting('request.jwt.claim') as claim`,
    );
    assertEquals(row, { sub: "", email: "", role: "", claim: "" });
    assertEquals(sql.settings.get("request.jwt.claim.sub"), "attacker", "transaction-local only");
    // Still one statement, pipelined with the query.
    assertEquals((RLS_SETUP.match(/set_config/g) ?? []).length, 6);
  } finally {
    tearDown();
  }
});

Deno.test("custom claims never add an email the user does not have", async () => {
  await setUp({ migrate: false, claims: () => ({ email: "admin@x.test", tenant: "t" }) });
  try {
    const noEmail = await whoAmI(db({
      as: { id: "u-2", claims: { email: "admin@x.test", sub: "x", role: "service_role" } },
    }));
    assertEquals([noEmail.claims.email, noEmail.claims.sub, noEmail.claims.role], [
      undefined,
      "u-2",
      "authenticated",
    ]);
    const session = await whoAmI(db({ as: { ...SESSION, user: { id: "u-3" } } }));
    assertEquals([session.claims.email, session.claims.tenant], [undefined, "t"]);
    assert(!("email" in sessionClaims({ ...SESSION, user: { id: "u-4" } }, { email: "a@b" })));
  } finally {
    tearDown();
  }
});
