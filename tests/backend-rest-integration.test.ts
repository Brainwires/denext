// `@denext/backend` auto-REST against a REAL Postgres, through the request pipeline with
// denextAuth sessions: Supabase-style policies on a `notes` table decide what each caller sees
// and writes through `/rest/v1/notes` — user A cannot read, update or delete user B's rows, nor
// insert one in B's name; anon sees only the public rows and may not write; a table the roles
// hold no privilege on gets no route. Also the statements themselves on a real server: typed
// filters, `in`, `like`, ordering, `count=exact`, a one-column PATCH, bulk inserts through
// `json_populate_recordset`, a unique violation (409), the statement timeout (504), and the row
// types generated from the live catalog. A second app: a `security_invoker` view read with each
// caller's rights, `count=exact` refused for anon, the CSRF rule for cookie writes (a cookieless
// cross-site write reaches the policies), and `maxConcurrent` answering 503 + `Retry-After`
// while a statement sleeps on the server.
//
// The app connects as a NON-superuser role in a database of its own (both dropped afterwards).
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`), with a superuser URL:
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/backend-rest-integration.test.ts
//
// Ignored without DENEXT_TEST_POSTGRES_URL or Deno.SQL; the handler is unit-tested against a
// fake client in tests/backend-rest.test.ts and the builder in tests/backend-rest-query.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { builtinSql } from "../src/server/postgres.ts";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createApp } from "../src/server/app.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { backend } from "../packages/backend/mod.ts";
import { db } from "../packages/backend/server.ts";
import { restClient } from "../packages/backend/client.ts";
import { installPostgres, rlsReady } from "../packages/backend/src/postgres.ts";
import { readRestCatalog } from "../packages/backend/src/rest-catalog.ts";
import { generateRestTypes } from "../packages/backend/src/rest-codegen.ts";
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
const ORIGIN = "https://app.test";
const A = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000a";
const B = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000b";

const authConfig: AuthConfig = {
  secret: "rest-secret-at-least-32-characters-long!",
  canonicalOrigin: ORIGIN,
  providers: [credentials({ authorize: () => null })],
};

/** A signed-in user's session cookie. */
async function cookieFor(id: string): Promise<string> {
  const issuing = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(issuing, () => issueAuthSession(authConfig, { id }, "credentials"));
  return issuing.outgoingHeaders.getSetCookie().find((c) => c.startsWith("__Host-denext_auth="))!
    .split(";")[0];
}

/**
 * The schema: notes with owner / public policies, a private table, a slow `security_invoker` view,
 * and relations without row-level security (a table with RLS off, an owner's-rights view, a
 * materialized view) that the default `tables: "*"` must not serve.
 */
const SCHEMA = `
  create table notes (
    id serial primary key,
    owner uuid not null,
    body text not null,
    slug text unique,
    is_public boolean not null default false,
    tags text[],
    meta jsonb,
    big bigint,
    words integer generated always as (array_length(regexp_split_to_array(body, ' '), 1)) stored
  );
  alter table notes enable row level security;
  create policy "read own or public" on notes for select to authenticated
    using (owner = auth.uid() or is_public);
  create policy "anon reads public" on notes for select to anon using (is_public);
  create policy "insert own" on notes for insert to authenticated with check (owner = auth.uid());
  create policy "update own" on notes for update to authenticated
    using (owner = auth.uid()) with check (owner = auth.uid());
  create policy "delete own" on notes for delete to authenticated using (owner = auth.uid());
  grant select, insert, update, delete on notes to authenticated;
  grant select on notes to anon;
  grant usage on sequence notes_id_seq to authenticated;
  create table secrets (id int primary key, value text);
  insert into secrets values (1, 'hidden');
  create view slow with (security_invoker = on) as select pg_sleep(2)::text as nap;
  grant select on slow to anon;
  create table open_table (id int primary key);
  grant select on open_table to anon;
  create view definer_view as select id, body from notes;
  grant select on definer_view to anon;
  create materialized view mat as select 1 as one;
  grant select on mat to anon;
`;

Deno.test({
  name: `auto-REST on a real Postgres: RLS per user and anon, the statements, codegen${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-rest-pg-" });
    try {
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      const config = {
        plugins: [
          denextAuth(authConfig),
          backend({ postgres: { sql: env.app }, rest: { statementTimeout: 500, maxRows: 50 } }),
        ],
      } as DenextConfig;
      // `build` mode: no catalog read at setup, so the first request reads it (after the schema).
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      await rlsReady();
      await db.service().unsafe(SCHEMA).simple!();
      await db.service().unsafe(
        `insert into notes (owner, body, slug, is_public, tags, meta, big) values
         ($1, 'a private', 'a1', false, '{x,y}', '{"k":1}', 9007199254740993),
         ($1, 'a public note', 'a2', true, null, null, null),
         ($2, 'b private', 'b1', false, null, null, null)`,
        [A, B],
      );
      const manifest = await scanRoutes(`${root}/app`);
      const handler = createApp({
        getManifest: () => manifest,
        load,
        matchExternal: getPluginRequestHandler(),
      });
      const cookies: Record<string, string> = { [A]: await cookieFor(A), [B]: await cookieFor(B) };
      const call = (path: string, init: RequestInit & { as?: string } = {}) => {
        const { as, ...rest } = init;
        const headers = new Headers(rest.headers);
        headers.set("host", "app.test");
        if (as) headers.set("cookie", cookies[as]);
        if (rest.method && rest.method !== "GET") headers.set("origin", ORIGIN);
        if (rest.body !== undefined) headers.set("content-type", "application/json");
        return handler(new Request(new URL(path, ORIGIN), { ...rest, headers }));
      };
      const slugs = async (path: string, as?: string) => {
        const res = await call(path, { as });
        assertEquals(res.status, 200, await res.clone().text());
        return ((await res.json()) as { slug: string }[]).map((r) => r.slug).sort();
      };

      // Reads: each caller sees what the policies allow.
      assertEquals(await slugs("/rest/v1/notes?select=slug"), ["a2"], "anon: public only");
      assertEquals(await slugs("/rest/v1/notes?select=slug", A), ["a1", "a2"]);
      assertEquals(await slugs("/rest/v1/notes?select=slug", B), ["a2", "b1"]);
      assertEquals(
        await slugs("/rest/v1/notes?select=slug&slug=eq.b1", A),
        [],
        "A cannot read B's",
      );

      // Types come back as Postgres prints them: a bigint keeps every digit.
      const typed = await call("/rest/v1/notes?slug=eq.a1&select=id,tags,meta,big,words", {
        as: A,
      });
      const text = await typed.text();
      assertStringIncludes(text, '"big":9007199254740993');
      const [row] = JSON.parse(text);
      assertEquals([row.tags, row.meta, row.words], [["x", "y"], { k: 1 }, 2]);

      // Filters, ordering, paging and count, through the client.
      const client = (as?: string) =>
        restClient({
          url: `${ORIGIN}/rest/v1`,
          fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            return call(url.pathname + url.search, { ...init, as });
          }) as typeof fetch,
        });
      const listed = await client(A).from("notes").select("slug", { count: "exact" })
        .in("slug", ["a1", "a2", "b1"]).like("body", "a*").order("slug", { ascending: false })
        .limit(1);
      assertEquals([listed.data, listed.count, listed.status], [[{ slug: "a2" }], 2, 206]);
      const injected = await client(A).from("notes").select("slug")
        .eq("body", "x' or '1'='1");
      assertEquals(injected.data, []);
      const badType = await client(A).from("notes").select().eq("id", "not-a-number");
      assertEquals([badType.status, badType.error?.code], [400, "22P02"]);

      // Writes: A may not touch B's rows; nothing reports a row it could not see.
      const bId = (await db.service()`select id from notes where slug = 'b1'`)[0].id;
      const patched = await call(`/rest/v1/notes?id=eq.${bId}`, {
        as: A,
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({ body: "hijacked" }),
      });
      assertEquals([patched.status, await patched.json()], [200, []]);
      const removed = await call(`/rest/v1/notes?id=eq.${bId}`, { as: A, method: "DELETE" });
      assertEquals(removed.status, 204);
      await removed.body?.cancel();
      assertEquals(
        await db.service()`select body from notes where slug = 'b1'`,
        [{ body: "b private" }],
        "B's row is untouched",
      );
      const forged = await call("/rest/v1/notes", {
        as: A,
        method: "POST",
        body: JSON.stringify({ owner: B, body: "forged" }),
      });
      assertEquals([forged.status, (await forged.json()).code], [403, "42501"]);
      const anonWrite = await call("/rest/v1/notes", {
        method: "POST",
        body: JSON.stringify({ owner: A, body: "anon" }),
      });
      assertEquals([anonWrite.status, (await anonWrite.json()).code], [403, "42501"]);
      const anonDelete = await call("/rest/v1/notes?id=gt.0", { method: "DELETE" });
      assertEquals(anonDelete.status, 403);
      await anonDelete.body?.cancel();

      // A's own writes: a bulk insert, a one-column PATCH, a delete.
      const inserted = await call("/rest/v1/notes?select=slug,words", {
        as: A,
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify([
          { owner: A, body: "one two three", slug: "a3", tags: ["t"] },
          { owner: A, body: "four", slug: "a4", tags: null },
        ]),
      });
      assertEquals(inserted.status, 201);
      assertEquals(await inserted.json(), [{ slug: "a3", words: 3 }, { slug: "a4", words: 1 }]);
      const own = await call("/rest/v1/notes?slug=eq.a4&select=body", {
        as: A,
        method: "PATCH",
        headers: { prefer: "return=representation", accept: "application/vnd.pgrst.object+json" },
        body: JSON.stringify({ body: "four five" }),
      });
      assertEquals(await own.json(), { body: "four five" });
      const duplicate = await call("/rest/v1/notes", {
        as: A,
        method: "POST",
        body: JSON.stringify({ owner: A, body: "dup", slug: "a3" }),
      });
      assertEquals([duplicate.status, (await duplicate.json()).code], [409, "23505"]);
      const generated = await call("/rest/v1/notes", {
        as: A,
        method: "POST",
        body: JSON.stringify({ owner: A, body: "x", words: 9 }),
      });
      assertEquals([generated.status, (await generated.json()).code], [400, "428C9"]);
      const deleted = await client(A).from("notes").delete().in("slug", ["a3", "a4"]).select(
        "slug",
      );
      assertEquals(deleted.data?.map((r) => r.slug).sort(), ["a3", "a4"]);

      // No privilege, no route; the statement timeout answers 504.
      const secret = await call("/rest/v1/secrets", { as: A });
      assertEquals([secret.status, (await secret.json()).code], [404, "PGRST205"]);
      const slow = await call("/rest/v1/slow");
      assertEquals([slow.status, (await slow.json()).code], [504, "57014"]);

      // Granted relations without row-level security get no route under "*": the RLS-off
      // table, the owner's-rights view (it would read notes past their policies) and the
      // materialized view. Named explicitly, they are served as named.
      for (const name of ["open_table", "definer_view", "mat"]) {
        const res = await call(`/rest/v1/${name}`);
        assertEquals([res.status, (await res.json()).code], [404, "PGRST205"], name);
      }
      const skipped: string[] = [];
      const catalog = await readRestCatalog(db.service(), ["public"], "*", (list) => {
        skipped.push(...list.map((s) => `${s.name}:${s.kind}`));
      });
      assertEquals(skipped.sort(), [
        "definer_view:view",
        "mat:materialized view",
        "open_table:table",
      ]);
      const named = await readRestCatalog(db.service(), ["public"], ["open_table", "definer_view"]);
      assertEquals([...named.tables.get("public")!.keys()].sort(), ["definer_view", "open_table"]);

      // The row types, from the live catalog.
      assertEquals([...catalog.tables.get("public")!.keys()].sort(), ["notes", "slow"]);
      const types = generateRestTypes(catalog);
      assertStringIncludes(types, `tags: string[] | null;`);
      assertStringIncludes(types, `meta: Json | null;`);
      assertStringIncludes(types, `is_public?: boolean;`);
      const insert = types.slice(types.indexOf("Insert:"), types.indexOf("Update:"));
      assert(!insert.includes(`words`), "a generated column is never written");
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await env.drop();
      await Deno.remove(root, { recursive: true });
    }
  },
});

/** Notes behind a `security_invoker` view, and a slow view to hold a statement slot. */
const VIEWS = `
  create table notes (id serial primary key, owner uuid not null, body text not null);
  alter table notes enable row level security;
  create policy "read own" on notes for select to authenticated using (owner = auth.uid());
  create policy "insert own" on notes for insert to authenticated with check (owner = auth.uid());
  grant select, insert on notes to authenticated;
  grant select on notes to anon;
  grant usage on sequence notes_id_seq to authenticated;
  create view my_notes with (security_invoker = on) as select id, owner, body from notes;
  grant select on my_notes to authenticated, anon;
  create view nap with (security_invoker = on) as select pg_sleep(1.5)::text as nap;
  grant select on nap to anon;
`;

Deno.test({
  name:
    `auto-REST on a real Postgres: security_invoker views, maxConcurrent, exactCount, CSRF${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-rest-pg-" });
    try {
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      const config = {
        plugins: [
          denextAuth(authConfig),
          backend({ postgres: { sql: env.app }, rest: { maxConcurrent: 1 } }),
        ],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      await rlsReady();
      await db.service().unsafe(VIEWS).simple!();
      await db.service().unsafe(
        `insert into notes (owner, body) values ($1, 'a1'), ($1, 'a2'), ($2, 'b1')`,
        [A, B],
      );
      const manifest = await scanRoutes(`${root}/app`);
      const handler = createApp({
        getManifest: () => manifest,
        load,
        matchExternal: getPluginRequestHandler(),
      });
      const cookies: Record<string, string> = { [A]: await cookieFor(A), [B]: await cookieFor(B) };
      const call = (
        path: string,
        init: RequestInit & { as?: string; origin?: string } = {},
      ) => {
        const { as, origin, ...rest } = init;
        const headers = new Headers(rest.headers);
        headers.set("host", "app.test");
        if (as) headers.set("cookie", cookies[as]);
        if (rest.method && rest.method !== "GET") headers.set("origin", origin ?? ORIGIN);
        if (rest.body !== undefined) headers.set("content-type", "application/json");
        return handler(new Request(new URL(path, ORIGIN), { ...rest, headers }));
      };
      const bodies = async (res: Response) => {
        assertEquals(res.status, 200, await res.clone().text());
        return ((await res.json()) as { body: string }[]).map((r) => r.body).sort();
      };

      // A security_invoker view is served under "*" and reads with the CALLER's rights: the
      // policies on the table underneath decide, per user, and anon sees nothing.
      assertEquals(await bodies(await call("/rest/v1/my_notes?select=body", { as: A })), [
        "a1",
        "a2",
      ]);
      assertEquals(await bodies(await call("/rest/v1/my_notes?select=body", { as: B })), ["b1"]);
      assertEquals(await bodies(await call("/rest/v1/my_notes?select=body")), []);

      // count=exact is for signed-in users by default: anon is refused before any statement.
      const anonCount = await call("/rest/v1/my_notes", { headers: { prefer: "count=exact" } });
      assertEquals([anonCount.status, (await anonCount.json()).code], [400, "PGRST100"]);
      const counted = await call("/rest/v1/my_notes?select=body&limit=1", {
        as: A,
        headers: { prefer: "count=exact" },
      });
      assertEquals([counted.status, counted.headers.get("content-range")], [206, "0-0/2"]);
      await counted.body?.cancel();

      // CSRF: a cookie-carrying write from another site is refused before the database; the
      // same write same-site goes through; a cookieless cross-site one reaches Postgres (and
      // its policies, which refuse anon).
      const write = JSON.stringify({ owner: A, body: "a3" });
      const forged = await call("/rest/v1/notes", {
        as: A,
        method: "POST",
        body: write,
        origin: "https://evil.test",
      });
      assertEquals([forged.status, (await forged.json()).code], [403, "csrf_failed"]);
      const sameSite = await call("/rest/v1/notes", { as: A, method: "POST", body: write });
      assertEquals(sameSite.status, 201);
      await sameSite.body?.cancel();
      const cookieless = await call("/rest/v1/notes", {
        method: "POST",
        body: write,
        origin: "https://evil.test",
      });
      assertEquals([cookieless.status, (await cookieless.json()).code], [403, "42501"]);
      assertEquals(
        (await db.service()`select count(*)::int as n from notes where body = 'a3'`)[0].n,
        1,
        "only the same-site write landed",
      );

      // maxConcurrent: 1 — while one statement sleeps on the server, the next waits its second,
      // then is turned away with 503 PGRST003 and Retry-After; the slot frees afterwards.
      const slow = call("/rest/v1/nap");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const turnedAway = await call("/rest/v1/my_notes", { as: A });
      assertEquals(turnedAway.status, 503);
      assertEquals(turnedAway.headers.get("retry-after"), "1");
      assertEquals((await turnedAway.json()).code, "PGRST003");
      const napped = await slow;
      assertEquals(napped.status, 200);
      await napped.body?.cancel();
      assertEquals(
        (await bodies(await call("/rest/v1/my_notes?select=body", { as: A }))).length,
        3,
      );
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await env.drop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
