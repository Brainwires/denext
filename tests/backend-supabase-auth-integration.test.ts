// The stock `@supabase/supabase-js` client's `supabase.auth.*` against `/auth/v1` on a REAL
// Postgres (`backendAuthAdapter()` on `backend({ postgres })`): every flow of
// tests/_supabase-auth-flows.ts, plus the identity end to end — an access token minted by
// `/auth/v1` scopes `db()` and auto-REST to its user through row-level security, the secret key
// is the service role, and a signed-out session's token is refused.
//
// Opt-in: DENEXT_TEST_SUPABASE_JS=1 and DENEXT_TEST_POSTGRES_URL (a superuser URL), on denext's
// Deno runtime (Deno.SQL). The backend-integration CI job sets both.

import { assertEquals, assertExists } from "@std/assert";
import { builtinSql } from "../src/server/postgres.ts";
import { backendAuthAdapter } from "../packages/backend/mod.ts";
import { db } from "../packages/backend/server.ts";
import { installPostgres, rlsReady } from "../packages/backend/src/postgres.ts";
import { type PostgresEnvironment, postgresEnvironment } from "./helpers/postgres-env.ts";
import { ORIGIN, supabaseAuthApp } from "./_supabase-auth-app.ts";
import { runFlows } from "./_supabase-auth-flows.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const reason = Deno.env.get("DENEXT_TEST_SUPABASE_JS") !== "1"
  ? "set DENEXT_TEST_SUPABASE_JS=1"
  : !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !builtinSql()
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";

Deno.test({
  name: `supabase-js auth against /auth/v1 on Postgres${label}`,
  ignore: reason !== undefined,
  async fn(t) {
    let env: PostgresEnvironment | undefined;
    await runFlows(
      t,
      async () => {
        env = await postgresEnvironment();
        installPostgres({ sql: env.app });
        return backendAuthAdapter();
      },
      async () => {
        installPostgres(undefined);
        await env?.drop();
        env = undefined;
      },
    );
  },
});

const SCHEMA = `
  create table notes (id serial primary key, owner uuid not null default auth.uid(), body text);
  alter table notes enable row level security;
  create policy "own" on notes for all to authenticated
    using (owner = auth.uid()) with check (owner = auth.uid());
  grant select, insert, update, delete on notes to authenticated;
  grant usage on sequence notes_id_seq to authenticated;
`;

Deno.test({
  name: `an /auth/v1 access token scopes db() and auto-REST through RLS${label}`,
  ignore: reason !== undefined,
  async fn() {
    const env = await postgresEnvironment();
    const app = await supabaseAuthApp({
      adapter: backendAuthAdapter(),
      backend: { postgres: { sql: env.app }, rest: {} },
      mode: "build",
    });
    try {
      await rlsReady();
      await db.service().unsafe(SCHEMA).simple!();
      const admin = app.admin();
      const a = (await admin.auth.admin.createUser({
        email: "a@example.com",
        password: "a password!",
        email_confirm: true,
      })).data.user;
      await admin.auth.admin.createUser({
        email: "b@example.com",
        password: "b password!",
        email_confirm: true,
      });
      const alice = app.client();
      const bob = app.client();
      await alice.auth.signInWithPassword({ email: "a@example.com", password: "a password!" });
      await bob.auth.signInWithPassword({ email: "b@example.com", password: "b password!" });
      // Writes through auto-REST carry the token: the row's owner default is auth.uid().
      const inserted = await alice.from("notes").insert({ body: "alice's" }).select();
      assertEquals(inserted.error, null);
      assertEquals(inserted.data[0].owner, a.id);
      await bob.from("notes").insert({ body: "bob's" });
      const mine = await alice.from("notes").select("body");
      assertEquals(mine.data, [{ body: "alice's" }]);
      // The secret key is the service role: every row.
      const all = await admin.from("notes").select("body").order("id");
      assertEquals(all.data?.length, 2);
      // Anon (the publishable key alone) sees nothing.
      const anon = await app.client().from("notes").select("body");
      assertEquals(anon.data ?? [], []);
      // Signed out, the token is refused (401), not downgraded to anon.
      const { data: { session } } = await alice.auth.getSession();
      await alice.auth.signOut();
      const stale = await app.fetch(`${ORIGIN}/rest/v1/notes`, {
        headers: { apikey: app.publishableKey, authorization: `Bearer ${session.access_token}` },
      });
      assertEquals(stale.status, 401);
      assertExists(session.access_token);
    } finally {
      await app.close();
      installPostgres(undefined);
      await env.drop();
    }
  },
});
