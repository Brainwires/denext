// `@denext/backend` row-level security against a REAL Postgres: Supabase-style policies on a
// `notes` table (`using (auth.uid() = owner)`), enforced per user, for anon, and bypassed by the
// service client; `with check` refusing a row for someone else; nothing left on the pool's
// connections after 200 interleaved queries of two users; a thrown error rolling back; nested
// transactions; and the request path (a denextAuth session → `auth.uid()`).
//
// The app connects as a NON-superuser role (a superuser can SET ROLE to anything, which would
// hide a missing grant), created for the run with CREATEROLE in a database of its own; both are
// dropped afterwards. The `anon` / `authenticated` roles are cluster-wide and are left in place
// (another database may use them).
//
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`), with a superuser URL:
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/backend-rls-integration.test.ts
//
// Ignored without DENEXT_TEST_POSTGRES_URL or Deno.SQL; the same behaviour is unit-tested against
// a fake client in tests/backend-rls.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { builtinSql, type SqlClient } from "../src/server/postgres.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { backend } from "../packages/backend/mod.ts";
import { db } from "../packages/backend/server.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const SQL = builtinSql();
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";
const load = ((path: string) => import(path)) as unknown as ModuleLoader;
const ORIGIN = "https://app.test";

const authConfig: AuthConfig = {
  secret: "rls-secret-at-least-32-characters-long!",
  canonicalOrigin: ORIGIN,
  providers: [credentials({ authorize: () => null })],
};

/** A signed-in user's session cookie (`name=value`). */
async function cookieFor(id: string, email: string): Promise<string> {
  const issuing = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(issuing, () => issueAuthSession(authConfig, { id, email }, "credentials"));
  return issuing.outgoingHeaders.getSetCookie().find((c) => c.startsWith("__Host-denext_auth="))!
    .split(";")[0];
}

/** Run `fn` inside a request carrying `cookie` (none: signed out). */
function inRequest<T>(cookie: string | undefined, fn: () => T): T {
  const headers: HeadersInit = cookie ? { cookie } : {};
  return runWithContext(createRequestContext(new Request(`${ORIGIN}/`, { headers })), fn);
}

const A = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000a";
const B = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000b";

/** A throwaway database and a non-superuser app role that owns it; `drop()` removes both. */
async function environment(
  grant = true,
): Promise<{ app: SqlClient; admin: SqlClient; drop(): Promise<void> }> {
  const admin = new SQL!(URL_);
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const role = `dnx_app_${suffix}`;
  const database = `dnx_rls_${suffix}`;
  const password = crypto.randomUUID();
  await admin.unsafe(`CREATE ROLE ${role} LOGIN CREATEROLE PASSWORD '${password}'`);
  await admin.unsafe(`CREATE DATABASE ${database} OWNER ${role}`);
  if (grant) {
    // On a server where anon / authenticated already exist (an earlier run, another app), a new
    // role may not grant them to itself: that is the administrator's step (rlsSetupSql).
    const [existing] = await admin`select count(*)::int as n from pg_roles
      where rolname in ('anon', 'authenticated')`;
    if ((existing as { n: number }).n === 2) {
      await admin.unsafe(`GRANT anon, authenticated TO ${role}`);
    }
  }
  const url = new URL(URL_!);
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  const app = new SQL!(url.toString());
  return {
    app,
    admin,
    async drop() {
      await app.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      // The role was granted anon / authenticated (and holds ADMIN on them, as their creator):
      // DROP OWNED removes those grants with everything else it owns.
      await admin.unsafe(`DROP OWNED BY ${role}`);
      await admin.unsafe(`DROP ROLE ${role}`);
      await admin.close();
    },
  };
}

async function install(sql: SqlClient, plugins: DenextConfig["plugins"] = []): Promise<void> {
  resetPlugins();
  installPostgres(undefined);
  await applyPlugins({
    projectRoot: "/tmp/x",
    appDir: "/tmp/x/app",
    config: { plugins: [...(plugins ?? []), backend({ postgres: { sql } })] } as DenextConfig,
    mode: "prod",
    load,
  });
}

/** The notes table with Supabase-style policies, created by the app role (its owner). */
async function notesTable(): Promise<void> {
  await db.service().unsafe(`
    create table notes (id serial primary key, owner uuid not null, body text not null);
    alter table notes enable row level security;
    create policy "read own notes" on notes for select using (auth.uid() = owner);
    create policy "write own notes" on notes for insert with check (auth.uid() = owner);
    create policy "delete own notes" on notes for delete using (auth.uid() = owner);
    grant select, insert, delete on notes to authenticated;
    grant select on notes to anon;
    grant usage on sequence notes_id_seq to authenticated;
  `).simple!();
}

type Note = { owner: string; body: string };

Deno.test({
  name: `RLS on a real Postgres: policies per user, anon, service, with check, nesting${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  async fn() {
    const env = await environment();
    try {
      await install(env.app);
      // The first scoped query applies backend_rls_0001 as the (non-superuser) app role.
      assertEquals(await db()`select auth.uid() as uid, auth.role() as role`, [{
        uid: null,
        role: "anon",
      }]);
      await notesTable();
      await db
        .service()`insert into notes (owner, body) values (${A}, 'a1'), (${A}, 'a2'), (${B}, 'b1')`;

      const asA = db({ as: { id: A, email: "a@x.test" } });
      const asB = db({ as: { id: B } });
      const bodies = (rows: Note[]) => rows.map((r) => r.body).sort();
      assertEquals(bodies(await asA<Note>`select owner, body from notes`), ["a1", "a2"]);
      assertEquals(bodies(await asB<Note>`select owner, body from notes`), ["b1"]);
      assertEquals(await db()`select * from notes`, [], "anon sees nothing");
      assertEquals(bodies(await db.service()<Note>`select owner, body from notes`), [
        "a1",
        "a2",
        "b1",
      ]);

      // The helpers read the claims.
      const [who] = await asA`select auth.uid() as uid, auth.role() as role, auth.email() as email,
        auth.jwt() ->> 'aud' as aud, current_user as "user"`;
      assertEquals(who, {
        uid: A,
        role: "authenticated",
        email: "a@x.test",
        aud: "authenticated",
        user: "authenticated",
      });

      // with check: A may not write a row owned by B; anon may not write at all.
      const denied = await assertRejects(() =>
        asA`insert into notes (owner, body) values (${B}, 'forged')`
      );
      assertEquals((denied as { code?: string }).code, "42501");
      await assertRejects(() => db()`insert into notes (owner, body) values (${A}, 'anon')`);
      await asA`insert into notes (owner, body) values (${A}, 'a3')`;

      // unsafe() with parameters is scoped the same way.
      assertEquals(
        (await asB.unsafe<Note>("select body from notes where body like $1", ["%"])).length,
        1,
      );

      // A thrown error rolls back (and leaves nothing set); a nested begin is a savepoint.
      await assertRejects(
        () =>
          asA.begin(async (tx) => {
            await tx`insert into notes (owner, body) values (${A}, 'rolled back')`;
            throw new Error("boom");
          }),
        Error,
        "boom",
      );
      const nested = await asA.begin(async (tx) => {
        await tx`insert into notes (owner, body) values (${A}, 'outer')`;
        await assertRejects(
          () =>
            tx.begin(async (inner) => {
              await inner`insert into notes (owner, body) values (${A}, 'inner')`;
              throw new Error("inner");
            }),
          Error,
          "inner",
        );
        const kept = await tx.begin(async (inner) => {
          const [row] = await inner<{ uid: string }>`select auth.uid() as uid`;
          await inner`insert into notes (owner, body) values (${A}, 'inner kept')`;
          return row.uid;
        });
        return kept;
      });
      assertEquals(nested, A);
      assertEquals(bodies(await asA<Note>`select owner, body from notes`), [
        "a1",
        "a2",
        "a3",
        "inner kept",
        "outer",
      ]);
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await env.drop();
    }
  },
});

Deno.test({
  name: `RLS on a real Postgres: 200 interleaved queries of two users, nothing left behind${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  async fn() {
    const env = await environment();
    try {
      await install(env.app, [denextAuth(authConfig)]);
      await db()`select 1`;
      await notesTable();
      await db.service()`insert into notes (owner, body) values (${A}, 'a'), (${B}, 'b')`;
      const cookies = { [A]: await cookieFor(A, "a@x.test"), [B]: await cookieFor(B, "b@x.test") };
      // 200 requests of two users, all in flight at once on a pool of 10 connections.
      const runs = Array.from({ length: 200 }, (_, i) => {
        const user = i % 2 === 0 ? A : B;
        return inRequest(cookies[user], async () => {
          const client = db();
          // Every seventh fails and rolls back; every third is a multi-statement transaction.
          if (i % 7 === 0) {
            return await client.begin(async (tx) => {
              await tx`select pg_sleep(0.001)`;
              throw new Error(`fail ${i}`);
            }).then(() => ({ user, seen: ["unexpected"] }), () => ({ user, seen: [user] }));
          }
          if (i % 3 === 0) {
            return await client.begin(async (tx) => {
              await tx`select pg_sleep(0.001)`;
              const rows = await tx<Note>`select owner from notes`;
              return { user, seen: rows.map((r) => r.owner) };
            });
          }
          const rows = await client<Note>`select owner from notes`;
          return { user, seen: rows.map((r) => r.owner) };
        });
      });
      for (const { user, seen } of await Promise.all(runs)) {
        assertEquals(seen, [user], "each query saw only its own user's rows");
      }
      // Every pooled connection is back to the connecting role with no claims: probe them all
      // at once so the pool hands out each of them.
      const probes = await Promise.all(
        Array.from(
          { length: 40 },
          () =>
            db.service()<{ user: string; claims: string | null; role: string }>`
            select current_user as "user", current_setting('request.jwt.claims', true) as claims,
              current_setting('role') as role, pg_sleep(0.005)`,
        ),
      );
      for (const [probe] of probes) {
        assert(probe.user.startsWith("dnx_app_"), `connection left as ${probe.user}`);
        assert(!probe.claims, `connection kept claims ${probe.claims}`);
        assertEquals(probe.role, "none");
      }
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await env.drop();
    }
  },
});

Deno.test({
  name: `RLS on a real Postgres: db() in a request acts as the denextAuth user${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  async fn() {
    const env = await environment();
    try {
      await install(env.app, [denextAuth(authConfig)]);
      await db()`select 1`;
      await notesTable();
      await db.service()`insert into notes (owner, body) values (${A}, 'a'), (${B}, 'b')`;
      const cookie = await cookieFor(B, "b@x.test");
      const signedIn = await inRequest(cookie, () => db()<Note>`select body from notes`);
      assertEquals(signedIn.map((r) => r.body), ["b"]);
      const [claims] = await inRequest(
        cookie,
        () =>
          db()`select auth.email() as email, auth.jwt() -> 'app_metadata' ->> 'provider' as provider`,
      );
      assertEquals(claims, { email: "b@x.test", provider: "credentials" });
      const anonymous = await inRequest(undefined, () => db()`select body from notes`);
      assertEquals(anonymous, []);
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await env.drop();
    }
  },
});

Deno.test({
  name:
    `RLS on a real Postgres: a role that may not grant itself the roles is told the fix${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  async fn() {
    // Make sure the roles exist (created by someone else), then connect as a role without them.
    const first = await environment();
    try {
      await install(first.app);
      await db()`select 1`;
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await first.drop();
    }
    const env = await environment(false);
    try {
      await install(env.app);
      const error = await assertRejects(() => db()`select 1`, Error, "may not grant itself");
      const cause = (error as { cause?: { hint?: string } }).cause;
      assert(cause?.hint?.includes("GRANT anon, authenticated TO"), cause?.hint);
      // The service client still works: only scoped queries need the roles.
      assertEquals(await db.service()`select 1::int as one`, [{ one: 1 }]);
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await env.drop();
    }
  },
});
