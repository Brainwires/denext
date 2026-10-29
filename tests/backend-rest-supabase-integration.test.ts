// `@denext/backend` auto-REST against a REAL Postgres, driven by the stock
// `@supabase/supabase-js` client (`createClient(appUrl, key)`, its own `fetch` routed into the
// app's request pipeline) — the wire format is PostgREST 12's, so supabase-js works unchanged:
// embedded resources (many-to-one, one-to-many, one-to-one, many-to-many, `!inner`, `!hint`,
// spreads, the `count` shorthand, filters / order / limit on an embed), `or` / `and` trees,
// every operator, aliases, casts and JSON paths, upserts (`onConflict`, `ignoreDuplicates`,
// `defaultToNull: false`), `rpc()` (GET and POST, set-returning then filtered, scalars, void,
// a single json argument), counts (exact, planned, estimated), `single` / `maybeSingle`, CSV,
// `schema()`, `rollback()`, `maxAffected()`, `abortSignal()`, and the `Database` types the
// plugin generates type-checking `createClient<Database>()`. denext's own `restClient` runs
// the same requests.
//
// The app connects as a NON-superuser role in a database of its own (both dropped afterwards).
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`), with a superuser URL:
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/backend-rest-supabase-integration.test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { builtinSql } from "../src/server/postgres.ts";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createApp } from "./helpers/released-app.ts";
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
import {
  generateSupabaseKeys,
  installSupabaseKeys,
  resolveSupabaseKeys,
  signSupabaseJwt,
} from "../src/server/auth/gotrue/keys.ts";

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

/** Every relation enables RLS with an open policy, so `tables: "*"` serves it. */
function open(table: string): string {
  return `alter table ${table} enable row level security;
    create policy "open" on ${table} for all to anon, authenticated using (true) with check (true);
    grant select, insert, update, delete on ${table} to anon, authenticated;`;
}

const SCHEMA = `
  create type mood as enum ('happy', 'sad');
  create table authors (id serial primary key, name text not null, meta jsonb, born date,
    mood mood not null default 'happy');
  create table profiles (id int primary key references authors(id), bio text);
  create table books (id serial primary key, author_id int references authors(id),
    title text not null, year int, tags text[], price numeric, during int4range,
    search tsvector generated always as (to_tsvector('english', title)) stored);
  create table editors (id serial primary key, name text not null);
  create table book_editors (book_id int references books(id), editor_id int references editors(id),
    primary key (book_id, editor_id));
  create table employees (id serial primary key, name text not null,
    supervisor_id int references employees(id));
  create table messages (id serial primary key, sender_id int references authors(id),
    receiver_id int references authors(id), body text);
  create table items (id int primary key, name text unique, qty int default 7,
    label text not null default 'none');
  ${open("authors")} ${open("profiles")} ${open("books")} ${open("editors")}
  ${open("book_editors")} ${open("employees")} ${open("messages")} ${open("items")}
  grant usage on all sequences in schema public to anon, authenticated;

  create table notes (id serial primary key, owner uuid not null, body text not null);
  alter table notes enable row level security;
  create policy "own" on notes for all to authenticated
    using (owner = auth.uid()) with check (owner = auth.uid());
  grant select, insert, update, delete on notes to authenticated;
  grant usage on sequence notes_id_seq to authenticated;

  insert into authors (name, meta, born, mood) values
    ('Ursula', '{"tags": ["sf"], "address": {"city": "Portland"}}', '1929-10-21', 'happy'),
    ('Octavia', '{"tags": ["sf", "afro"], "address": {"city": "Pasadena"}}', '1947-06-22', 'sad'),
    ('Nobody', null, null, 'happy');
  insert into profiles values (1, 'Earthsea'), (2, 'Kindred');
  insert into books (author_id, title, year, tags, price, during) values
    (1, 'A Wizard of Earthsea', 1968, '{fantasy,classic}', 9.99, '[1968,1969)'),
    (1, 'The Left Hand of Darkness', 1969, '{sf,classic}', 12.50, '[1969,1970)'),
    (2, 'Kindred', 1979, '{sf}', 15.00, '[1979,1980)'),
    (2, 'Parable of the Sower', 1993, '{sf,dystopia}', 18.00, '[1993,1994)');
  insert into editors (name) values ('Ed'), ('Edna');
  insert into book_editors values (1, 1), (2, 1), (3, 2);
  insert into employees (name, supervisor_id) values ('Boss', null), ('Mid', 1), ('Low', 2);
  insert into messages (sender_id, receiver_id, body) values (1, 2, 'hi'), (2, 1, 'hello');

  create function add(a int, b int default 10) returns int language sql immutable
    as $$ select a + b $$;
  create function books_by(author int) returns setof books language sql stable
    as $$ select * from books where author_id = author $$;
  create function author_stats() returns table (author_id int, n bigint) language sql stable
    as $$ select author_id, count(*) from books group by author_id $$;
  create function echo(json) returns json language sql immutable as $$ select $1 $$;
  create function wrap(payload jsonb) returns jsonb language sql immutable
    as $$ select jsonb_build_object('got', payload) $$;
  create function touch(n int) returns void language sql volatile
    as $$ update items set qty = qty + n where id = 1 $$;
  create function whoami() returns text language sql stable as $$ select auth.uid()::text $$;
  create function secret_fn() returns int language sql as $$ select 42 $$;
  revoke execute on function secret_fn() from public;

  create schema api;
  grant usage on schema api to anon, authenticated;
  create table api.things (id int primary key, label text);
  ${open("api.things")}
  insert into api.things values (1, 'from api');
  create view book_view with (security_invoker = on) as
    select id, author_id, title, year from books;
  grant select on book_view to anon, authenticated;
  create view book_view2 with (security_invoker = on) as
    select id as book_id, author_id as writer, title from book_view;
  grant select on book_view2 to anon, authenticated;
  create function full_title(books) returns text language sql stable
    as $$ select $1.title || ' (' || $1.year || ')' $$;
  create function author_of(books) returns setof authors rows 1 language sql stable
    as $$ select * from authors where id = $1.author_id $$;
  create function books_of(authors) returns setof books language sql stable
    as $$ select * from books where author_id = $1.id $$;
  create table hidden (id int primary key, note text);
  insert into hidden values (1, 'secret');
  analyze;
`;

Deno.test({
  name: `auto-REST × supabase-js on a real Postgres${label}`,
  ignore: reason !== undefined,
  async fn(t) {
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-rest-sb-" });
    const g = await generateSupabaseKeys();
    const keyConfig = {
      publishableKey: g.publishableKey,
      secretKey: g.secretKey,
      signingKeys: g.signingKey,
    };
    try {
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      const config = {
        plugins: [
          denextAuth(authConfig),
          backend({
            supabase: keyConfig,
            postgres: { sql: env.app },
            rest: {
              schemas: ["public", "api"],
              exactCount: "all",
              explain: true,
              aggregates: true,
              maxRows: 100,
            },
          }),
        ],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      await rlsReady();
      await db.service().unsafe(SCHEMA).simple!();
      const manifest = await scanRoutes(`${root}/app`);
      const handler = createApp({
        getManifest: () => manifest,
        load,
        matchExternal: getPluginRequestHandler(),
      });
      const seen: Request[] = [];
      /** supabase-js's fetch, routed into the app (a same-site browser would send Origin). */
      const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
        const headers = new Headers(request.headers);
        headers.set("host", "app.test");
        if (request.method !== "GET" && request.method !== "HEAD") headers.set("origin", ORIGIN);
        const routed = new Request(request.url, {
          method: request.method,
          headers,
          body: request.body,
          signal: request.signal,
        });
        seen.push(routed.clone());
        return await handler(routed);
      }) as typeof fetch;
      // Untyped (the typed client is checked in the last step): embeds are read as written.
      // deno-lint-ignore no-explicit-any
      const supabase: any = createClient(ORIGIN, g.publishableKey, {
        global: { fetch: appFetch },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      // deno-lint-ignore no-explicit-any
      const signedIn = (cookie: string): any =>
        createClient(ORIGIN, g.publishableKey, {
          global: { fetch: appFetch, headers: { cookie } },
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });

      await t.step("plain reads, filters and order", async () => {
        const { data, error, status } = await supabase.from("authors").select("id, name")
          .order("id");
        assertEquals(error, null);
        assertEquals(status, 200);
        assertEquals(data, [
          { id: 1, name: "Ursula" },
          { id: 2, name: "Octavia" },
          { id: 3, name: "Nobody" },
        ]);
        const sf = await supabase.from("books").select("title").contains("tags", ["sf"])
          .gte("year", 1970).order("year", { ascending: false });
        assertEquals(sf.data, [{ title: "Parable of the Sower" }, { title: "Kindred" }]);
        const notIn = await supabase.from("books").select("id").not("id", "in", "(1,2)")
          .order("id");
        assertEquals(notIn.data, [{ id: 3 }, { id: 4 }]);
        const ov = await supabase.from("books").select("id").overlaps("tags", [
          "dystopia",
          "fantasy",
        ])
          .order("id");
        assertEquals(ov.data, [{ id: 1 }, { id: 4 }]);
        const cd = await supabase.from("books").select("id").containedBy("tags", ["sf", "classic"])
          .order("id");
        assertEquals(cd.data, [{ id: 2 }, { id: 3 }]);
        const ilikeAny = await supabase.from("books").select("id")
          .ilikeAnyOf("title", ["%earthsea%", "kin%"]).order("id");
        assertEquals(ilikeAny.data, [{ id: 1 }, { id: 3 }]);
        const likeAll = await supabase.from("books").select("id")
          .likeAllOf("title", ["%of%", "%Darkness"]);
        assertEquals(likeAll.data, [{ id: 2 }]);
        const regex = await supabase.from("authors").select("name").filter("name", "match", "^O");
        assertEquals(regex.data, [{ name: "Octavia" }]);
        const imatch = await supabase.from("authors").select("name").filter("name", "imatch", "^u");
        assertEquals(imatch.data, [{ name: "Ursula" }]);
        const isNull = await supabase.from("authors").select("name").is("meta", null);
        assertEquals(isNull.data, [{ name: "Nobody" }]);
        const distinct = await supabase.from("authors").select("id").isDistinct("mood", "sad")
          .order("id");
        assertEquals(distinct.data, [{ id: 1 }, { id: 3 }]);
        const eqAny = await supabase.from("books").select("id").filter(
          "year",
          "eq(any)",
          "{1968,1993}",
        )
          .order("id");
        assertEquals(eqAny.data, [{ id: 1 }, { id: 4 }]);
        const enumEq = await supabase.from("authors").select("name").eq("mood", "sad");
        assertEquals(enumEq.data, [{ name: "Octavia" }]);
        const match = await supabase.from("books").select("id").match({ author_id: 2, year: 1979 });
        assertEquals(match.data, [{ id: 3 }]);
      });

      await t.step("ranges and full-text search", async () => {
        const gt = await supabase.from("books").select("id").rangeGt("during", "[1970,1971)")
          .order("id");
        assertEquals(gt.data, [{ id: 3 }, { id: 4 }]);
        const lt = await supabase.from("books").select("id").rangeLt("during", "[1969,1970)");
        assertEquals(lt.data, [{ id: 1 }]);
        const adj = await supabase.from("books").select("id").rangeAdjacent(
          "during",
          "[1970,1971)",
        );
        assertEquals(adj.data, [{ id: 2 }]);
        const gte = await supabase.from("books").select("id").rangeGte("during", "[1979,1980)")
          .order("id");
        assertEquals(gte.data, [{ id: 3 }, { id: 4 }]);
        const lte = await supabase.from("books").select("id").rangeLte("during", "[1968,1969)");
        assertEquals(lte.data, [{ id: 1 }]);
        const fts = await supabase.from("books").select("id").textSearch(
          "search",
          "wizard & earthsea",
        );
        assertEquals(fts.data, [{ id: 1 }]);
        const web = await supabase.from("books").select("id")
          .textSearch("title", "left hand", { type: "websearch", config: "english" });
        assertEquals(web.data, [{ id: 2 }]);
        const plain = await supabase.from("books").select("id")
          .textSearch("search", "sower parable", { type: "plain", config: "english" });
        assertEquals(plain.data, [{ id: 4 }]);
        const phrase = await supabase.from("books").select("id")
          .textSearch("search", "left hand", { type: "phrase", config: "english" });
        assertEquals(phrase.data, [{ id: 2 }]);
      });

      await t.step("or / and trees, nested and negated", async () => {
        const either = await supabase.from("books").select("id")
          .or("year.lt.1969,and(author_id.eq.2,title.ilike.*sower*)").order("id");
        assertEquals(either.data, [{ id: 1 }, { id: 4 }]);
        const quoted = await supabase.from("authors").select("id")
          .or('name.eq."Ursula",name.in.("Octavia","x,y")').order("id");
        assertEquals(quoted.data, [{ id: 1 }, { id: 2 }]);
        const notOr = await supabase.from("books").select("id")
          .not("tags", "cs", "{sf}").order("id");
        assertEquals(notOr.data, [{ id: 1 }]);
        const res = await appFetch(
          `${ORIGIN}/rest/v1/books?select=id&not.or=(year.gt.1970,id.eq.1)`,
        );
        assertEquals(await res.json(), [{ id: 2 }]);
      });

      await t.step("aliases, casts and JSON paths", async () => {
        const { data, error } = await supabase.from("authors")
          .select("who:name, city:meta->address->>city, first:meta->tags->0, born::text, id::text")
          .eq("meta->address->>city", "Pasadena");
        assertEquals(error, null);
        assertEquals(data, [{
          who: "Octavia",
          city: "Pasadena",
          first: "sf",
          born: "1947-06-22",
          id: "2",
        }]);
        const ordered = await supabase.from("authors").select("name").not("meta", "is", null)
          .order("meta->address->>city", { ascending: false });
        assertEquals(ordered.data, [{ name: "Ursula" }, { name: "Octavia" }]);
        const jsonContains = await supabase.from("authors").select("name")
          .contains("meta", { tags: ["afro"] });
        assertEquals(jsonContains.data, [{ name: "Octavia" }]);
        const badCast = await supabase.from("authors").select("name::nosuchtype");
        assertEquals([badCast.status, badCast.error?.code], [400, "42704"]);
      });

      await t.step("embedded resources", async () => {
        const m2o = await supabase.from("books").select("title, author:authors(name)").eq("id", 3)
          .single();
        assertEquals(m2o.data, { title: "Kindred", author: { name: "Octavia" } });
        const o2m = await supabase.from("authors").select("name, books(title)")
          .order("id").order("title", { referencedTable: "books" }).limit(2);
        assertEquals(o2m.data, [
          {
            name: "Ursula",
            books: [{ title: "A Wizard of Earthsea" }, { title: "The Left Hand of Darkness" }],
          },
          { name: "Octavia", books: [{ title: "Kindred" }, { title: "Parable of the Sower" }] },
        ]);
        const o2o = await supabase.from("authors").select("name, profiles(bio)").eq("id", 1)
          .single();
        assertEquals(o2o.data, { name: "Ursula", profiles: { bio: "Earthsea" } });
        const m2m = await supabase.from("books").select("id, editors(name)").order("id");
        assertEquals(m2m.data, [
          { id: 1, editors: [{ name: "Ed" }] },
          { id: 2, editors: [{ name: "Ed" }] },
          { id: 3, editors: [{ name: "Edna" }] },
          { id: 4, editors: [] },
        ]);
        const inner = await supabase.from("authors").select("name, books!inner(title)")
          .eq("books.year", 1979);
        assertEquals(inner.data, [{ name: "Octavia", books: [{ title: "Kindred" }] }]);
        const filtered = await supabase.from("authors").select("name, books(title)")
          .gt("books.year", 1968).lt("id", 3).order("id");
        assertEquals(filtered.data, [
          { name: "Ursula", books: [{ title: "The Left Hand of Darkness" }] },
          { name: "Octavia", books: [{ title: "Kindred" }, { title: "Parable of the Sower" }] },
        ]);
        const limited = await supabase.from("authors").select("name, books(title)")
          .eq("id", 2).order("year", { referencedTable: "books", ascending: false })
          .limit(1, { referencedTable: "books" }).single();
        assertEquals(limited.data, { name: "Octavia", books: [{ title: "Parable of the Sower" }] });
        const embeddedOr = await supabase.from("authors").select("name, books(id)")
          .or("year.eq.1968,year.eq.1993", { referencedTable: "books" }).order("id").limit(2);
        assertEquals(embeddedOr.data, [
          { name: "Ursula", books: [{ id: 1 }] },
          { name: "Octavia", books: [{ id: 4 }] },
        ]);
        const notNull = await supabase.from("authors").select("name, books(id)")
          .not("books", "is", null).order("id");
        assertEquals(notNull.data?.map((r: { name: string }) => r.name), ["Ursula", "Octavia"]);
        const isNullEmbed = await supabase.from("authors").select("name, books(id)").is(
          "books",
          null,
        );
        assertEquals(isNullEmbed.data, [{ name: "Nobody", books: [] }]);
        const spread = await supabase.from("books").select("title, ...authors(author_name:name)")
          .eq("id", 1).single();
        assertEquals(spread.data, { title: "A Wizard of Earthsea", author_name: "Ursula" });
        const count = await supabase.from("authors").select("name, books(count)").order("id");
        assertEquals(count.data, [
          { name: "Ursula", books: [{ count: 2 }] },
          { name: "Octavia", books: [{ count: 2 }] },
          { name: "Nobody", books: [{ count: 0 }] },
        ]);
        const nested = await supabase.from("editors")
          .select("name, books(title, authors(name))").eq("id", 2).single();
        assertEquals(nested.data, {
          name: "Edna",
          books: [{ title: "Kindred", authors: { name: "Octavia" } }],
        });
        // Two foreign keys from messages to authors: ambiguous until hinted.
        const ambiguous = await supabase.from("messages").select("body, authors(name)");
        assertEquals([ambiguous.status, ambiguous.error?.code], [300, "PGRST201"]);
        const hinted = await supabase.from("messages")
          .select("body, from:authors!sender_id(name), to:authors!messages_receiver_id_fkey(name)")
          .order("id");
        assertEquals(hinted.data, [
          { body: "hi", from: { name: "Ursula" }, to: { name: "Octavia" } },
          { body: "hello", from: { name: "Octavia" }, to: { name: "Ursula" } },
        ]);
        const viaColumn = await supabase.from("employees").select("name, boss:supervisor_id(name)")
          .eq("id", 3).single();
        assertEquals(viaColumn.data, { name: "Low", boss: { name: "Mid" } });
        const reports = await supabase.from("employees")
          .select("name, reports:employees!supervisor_id(name)").eq("id", 1).single();
        assertEquals(reports.data, { name: "Boss", reports: [{ name: "Mid" }] });
        const none = await supabase.from("authors").select("name, editors(name)");
        assertEquals([none.status, none.error?.code], [400, "PGRST200"]);
      });

      await t.step("single, maybeSingle, counts, ranges, HEAD", async () => {
        const one = await supabase.from("authors").select("name").eq("id", 1).single();
        assertEquals(one.data, { name: "Ursula" });
        const many = await supabase.from("authors").select("name").single();
        assertEquals([many.status, many.error?.code], [406, "PGRST116"]);
        const maybeNone = await supabase.from("authors").select("name").eq("id", 99).maybeSingle();
        assertEquals([maybeNone.data, maybeNone.error], [null, null]);
        const maybeOne = await supabase.from("authors").select("name").eq("id", 2).maybeSingle();
        assertEquals(maybeOne.data, { name: "Octavia" });
        const exact = await supabase.from("books").select("id", { count: "exact" }).range(0, 1);
        assertEquals([exact.count, exact.data?.length, exact.status], [4, 2, 206]);
        const head = await supabase.from("books").select("*", { count: "exact", head: true });
        assertEquals([head.count, head.data], [4, null]);
        const planned = await supabase.from("books").select("id", { count: "planned" });
        assert(typeof planned.count === "number" && planned.count >= 0, String(planned.count));
        const estimated = await supabase.from("books").select("id", { count: "estimated" });
        assertEquals(estimated.count, 4, "under maxRows the estimate is exact");
      });

      await t.step("CSV out, CSV in", async () => {
        const csv = await supabase.from("authors").select("id, name, born").order("id").limit(2)
          .csv();
        assertEquals(csv.data, "id,name,born\n1,Ursula,1929-10-21\n2,Octavia,1947-06-22\n");
        const res = await appFetch(`${ORIGIN}/rest/v1/items`, {
          method: "POST",
          headers: { "content-type": "text/csv", prefer: "return=representation" },
          body: 'id,name,label\n50,"csv, quoted",NULL\n51,plain,x\n',
        });
        assertEquals(res.status, 400, "label is NOT NULL, so NULL is refused");
        await res.body?.cancel();
        const ok = await appFetch(`${ORIGIN}/rest/v1/items?select=id,name`, {
          method: "POST",
          headers: { "content-type": "text/csv", prefer: "return=representation" },
          body: 'id,name\n50,"csv, quoted"\n51,plain\n',
        });
        assertEquals(await ok.json(), [{ id: 50, name: "csv, quoted" }, { id: 51, name: "plain" }]);
        await supabase.from("items").delete().in("id", [50, 51]);
      });

      await t.step("insert, upsert, update, delete", async () => {
        const inserted = await supabase.from("items").insert([
          { id: 1, name: "one" },
          { id: 2, name: "two", qty: 3 },
        ]).select().order("id");
        assertEquals(inserted.error, null);
        assertEquals(
          inserted.data,
          [
            { id: 1, name: "one", qty: null, label: "none" },
            { id: 2, name: "two", qty: 3, label: "none" },
          ].map((r) => r.id === 1 ? { ...r, qty: null } : r),
        );
        await supabase.from("items").delete().in("id", [1, 2]);
        const defaults = await supabase.from("items").insert([
          { id: 1, name: "one" },
          { id: 2, name: "two", qty: 3 },
        ], { defaultToNull: false }).select("id, qty, label").order("id");
        assertEquals(defaults.data, [{ id: 1, qty: 7, label: "none" }, {
          id: 2,
          qty: 3,
          label: "none",
        }]);
        const merged = await supabase.from("items").upsert({ id: 1, name: "uno", qty: 1 })
          .select("id, name, qty").single();
        assertEquals(merged.data, { id: 1, name: "uno", qty: 1 });
        const ignored = await supabase.from("items")
          .upsert({ id: 2, name: "dos" }, { ignoreDuplicates: true }).select();
        assertEquals(ignored.data, []);
        const byName = await supabase.from("items")
          .upsert({ id: 3, name: "uno", qty: 9 }, { onConflict: "name" }).select("id, qty");
        assertEquals(byName.data, [{ id: 3, qty: 9 }]);
        const updated = await supabase.from("items").update({ qty: 5 }).eq("id", 2)
          .select("qty").single();
        assertEquals(updated.data, { qty: 5 });
        const counted = await supabase.from("items").update({ label: "x" }, { count: "exact" })
          .gte("id", 1);
        assertEquals([counted.status, counted.count], [204, 2]);
        const withEmbed = await supabase.from("books").insert({
          author_id: 2,
          title: "Dawn",
          year: 1987,
        })
          .select("title, authors(name)").single();
        assertEquals(withEmbed.data, { title: "Dawn", authors: { name: "Octavia" } });
        const removed = await supabase.from("books").delete().eq("title", "Dawn").select("title");
        assertEquals(removed.data, [{ title: "Dawn" }]);
        const unfiltered = await supabase.from("items").delete();
        assertEquals([unfiltered.status, unfiltered.error?.code], [400, "21000"]);
        const tooMany = await supabase.from("items").update({ qty: 0 }).gte("id", 1).maxAffected(1);
        assertEquals([tooMany.status, tooMany.error?.code], [400, "PGRST124"]);
        assertEquals((await supabase.from("items").select("qty").eq("id", 2).single()).data, {
          qty: 5,
        });
        const rolled = await supabase.from("items").update({ qty: 100 }).eq("id", 2).select("qty")
          .rollback();
        assertEquals(rolled.data, [{ qty: 100 }]);
        assertEquals((await supabase.from("items").select("qty").eq("id", 2).single()).data, {
          qty: 5,
        });
      });

      await t.step("rpc", async () => {
        const sum = await supabase.rpc("add", { a: 2, b: 3 });
        assertEquals([sum.data, sum.error], [5, null]);
        const defaulted = await supabase.rpc("add", { a: 2 }, { get: true });
        assertEquals(defaulted.data, 12);
        const set = await supabase.rpc("books_by", { author: 1 }).select("title").order("year");
        assertEquals(set.data, [{ title: "A Wizard of Earthsea" }, {
          title: "The Left Hand of Darkness",
        }]);
        const filtered = await supabase.rpc("books_by", { author: 2 }, { get: true })
          .gt("year", 1980).select("title, authors(name)");
        assertEquals(filtered.data, [{
          title: "Parable of the Sower",
          authors: { name: "Octavia" },
        }]);
        const counted = await supabase.rpc("books_by", { author: 1 }, {
          count: "exact",
          head: true,
        });
        assertEquals(counted.count, 2);
        const table = await supabase.rpc("author_stats").order("author_id");
        assertEquals(table.data, [{ author_id: 1, n: 2 }, { author_id: 2, n: 2 }]);
        const one = await supabase.rpc("books_by", { author: 2 }).eq("year", 1979).single();
        assertEquals((one.data as { title: string }).title, "Kindred");
        const echoed = await supabase.rpc("echo", { anything: [1, 2] });
        assertEquals(echoed.data, { anything: [1, 2] });
        const wrapped = await supabase.rpc("wrap", { payload: { x: 1 } });
        assertEquals(wrapped.data, { got: { x: 1 } });
        const single = await appFetch(`${ORIGIN}/rest/v1/rpc/wrap`, {
          method: "POST",
          headers: { "content-type": "application/json", prefer: "params=single-object" },
          body: JSON.stringify({ x: 2 }),
        });
        assertEquals(await single.json(), { got: { x: 2 } });
        const voided = await supabase.rpc("touch", { n: 1 });
        assertEquals([voided.status, voided.data, voided.error], [204, null, null]);
        const readOnly = await supabase.rpc("touch", { n: 1 }, { get: true });
        assertEquals([readOnly.status, readOnly.error?.code], [405, "25006"]);
        const missing = await supabase.rpc("nope");
        assertEquals([missing.status, missing.error?.code], [404, "PGRST202"]);
        const wrongArgs = await supabase.rpc("add", { z: 1 });
        assertEquals([wrongArgs.status, wrongArgs.error?.code], [404, "PGRST202"]);
        const revoked = await supabase.rpc("secret_fn");
        assertEquals([revoked.status, revoked.error?.code], [404, "PGRST202"]);
        const anonWho = await supabase.rpc("whoami");
        assertEquals(anonWho.data, null);
        const who = await signedIn(await cookieFor(A)).rpc("whoami");
        assertEquals(who.data, A);
      });

      await t.step("schemas, RLS per user, rollback, explain, abort", async () => {
        const api = await supabase.schema("api").from("things").select("label");
        assertEquals(api.data, [{ label: "from api" }]);
        const unknown = await supabase.schema("nope").from("things").select();
        assertEquals([unknown.status, unknown.error?.code], [406, "PGRST106"]);
        assertEquals(seen.at(-1)?.headers.get("accept-profile"), "nope");
        const anonNotes = await supabase.from("notes").insert({ owner: A, body: "anon" });
        assertEquals(anonNotes.error?.code, "42501");
        const a = signedIn(await cookieFor(A));
        const b = signedIn(await cookieFor(B));
        assertEquals((await a.from("notes").insert({ owner: A, body: "mine" })).status, 201);
        assertEquals((await a.from("notes").select("body")).data, [{ body: "mine" }]);
        assertEquals((await b.from("notes").select("body")).data, []);
        const forged = await b.from("notes").insert({ owner: A, body: "forged" });
        assertEquals(forged.error?.code, "42501");
        const plan = await supabase.from("books").select("id").eq("id", 1).explain();
        assertStringIncludes(String(plan.data), "books");
        const jsonPlan = await supabase.from("books").select("id").explain({ format: "json" });
        assert(Array.isArray(jsonPlan.data), JSON.stringify(jsonPlan.data));
        const controller = new AbortController();
        controller.abort();
        const aborted = await supabase.from("books").select().abortSignal(controller.signal);
        assert(aborted.error !== null);
      });

      await t.step(
        "views, computed fields and relationships, related order, embedded or",
        async () => {
          const viaView = await supabase.from("book_view").select("title, authors(name)").eq(
            "id",
            3,
          )
            .single();
          assertEquals(viaView.data, { title: "Kindred", authors: { name: "Octavia" } });
          const intoView = await supabase.from("authors").select("name, book_view(title)")
            .eq("id", 1).order("title", { referencedTable: "book_view" }).single();
          assertEquals(intoView.data, {
            name: "Ursula",
            book_view: [{ title: "A Wizard of Earthsea" }, { title: "The Left Hand of Darkness" }],
          });
          const viewOverView = await supabase.from("book_view2")
            .select("title, writer, authors!writer(name)").eq("book_id", 4).single();
          assertEquals(viewOverView.data, {
            title: "Parable of the Sower",
            writer: 2,
            authors: { name: "Octavia" },
          });
          const computed = await supabase.from("books").select("title, full_title")
            .like("full_title", "%(1979)").single();
          assertEquals(computed.data, { title: "Kindred", full_title: "Kindred (1979)" });
          const toOne = await supabase.from("books").select("title, author_of(name)").eq("id", 1)
            .single();
          assertEquals(toOne.data, {
            title: "A Wizard of Earthsea",
            author_of: { name: "Ursula" },
          });
          const toMany = await supabase.from("authors").select("name, books_of(title)").eq("id", 2)
            .order("title", { referencedTable: "books_of" }).single();
          assertEquals(toMany.data, {
            name: "Octavia",
            books_of: [{ title: "Kindred" }, { title: "Parable of the Sower" }],
          });
          const related = await supabase.from("books").select("title, authors(name)")
            .order("authors(name)").order("year");
          assertEquals(related.data?.map((r: { title: string }) => r.title), [
            "Kindred",
            "Parable of the Sower",
            "A Wizard of Earthsea",
            "The Left Hand of Darkness",
          ]);
          const toManyOrder = await supabase.from("authors").select("name, books(title)")
            .order("books(title)");
          assertEquals([toManyOrder.status, toManyOrder.error?.code], [400, "PGRST118"]);
          const either = await supabase.from("books").select("id, authors(name)")
            .or("year.eq.1968,authors.name.eq.Octavia").order("id");
          assertEquals(either.data?.map((r: { id: number }) => r.id), [1, 3, 4]);
          const notEmbedded = await supabase.from("books").select("id").or("authors.name.eq.x");
          assertEquals([notEmbedded.status, notEmbedded.error?.code], [400, "PGRST108"]);
        },
      );

      await t.step("aggregates, PUT, the OpenAPI document, the secret key's catalog", async () => {
        const sums = await supabase.from("books").select("author_id, total:price.sum(), count()")
          .order("author_id");
        assertEquals(sums.error, null);
        assertEquals(sums.data, [
          { author_id: 1, total: 22.49, count: 2 },
          { author_id: 2, total: 33.00, count: 2 },
        ]);
        const embedded = await supabase.from("authors").select("name, books(year.max())")
          .eq("id", 1).single();
        assertEquals(embedded.data, { name: "Ursula", books: [{ max: 1969 }] });
        const cast = await supabase.from("books").select("year::text.min()").single();
        assertEquals(cast.data, { min: "1968" });
        const put = (query: string, body: unknown) =>
          appFetch(`${ORIGIN}/rest/v1/items${query}`, {
            method: "PUT",
            headers: { "content-type": "application/json", prefer: "return=representation" },
            body: JSON.stringify(body),
          });
        const created = await put("?id=eq.70", { id: 70, name: "seventy", qty: 1, label: "a" });
        assertEquals([created.status, await created.json()], [
          200,
          [{ id: 70, name: "seventy", qty: 1, label: "a" }],
        ]);
        const replaced = await put("?id=eq.70", { id: 70, name: "seventy", qty: 2, label: "b" });
        assertEquals(await replaced.json(), [{ id: 70, name: "seventy", qty: 2, label: "b" }]);
        const mismatch = await put("?id=eq.71", { id: 70, name: "x", qty: 1, label: "a" });
        assertEquals([mismatch.status, (await mismatch.json()).code], [400, "PGRST115"]);
        const partial = await put("?id=eq.70", { id: 70, name: "x" });
        assertEquals([partial.status, (await partial.json()).code], [400, "PGRST102"]);
        const notKey = await put("?name=eq.x", { id: 70, name: "x", qty: 1, label: "a" });
        assertEquals([notKey.status, (await notKey.json()).code], [405, "PGRST105"]);
        const slash = await appFetch(`${ORIGIN}/rest/v1/`);
        assertEquals([slash.status, slash.headers.get("location")], [308, "/rest/v1"]);
        const doc = await appFetch(`${ORIGIN}/rest/v1`, {
          headers: { accept: "application/openapi+json" },
        });
        assertEquals(doc.headers.get("content-type"), "application/openapi+json; charset=utf-8");
        const openapi = await doc.json();
        assertEquals(openapi.swagger, "2.0");
        assert(openapi.paths["/books"]?.get, "the books routes are listed");
        assert(openapi.paths["/rpc/add"]?.post, "the functions are listed");
        assertStringIncludes(
          openapi.definitions.books.properties.author_id.description,
          "This is a Foreign Key to `authors.id`.",
        );
        assertEquals(openapi.paths["/hidden"], undefined, "anon is shown only what it can use");
        const apiDoc = await appFetch(`${ORIGIN}/rest/v1`, {
          headers: { "accept-profile": "api" },
        });
        assert((await apiDoc.json()).paths["/things"]);
        // deno-lint-ignore no-explicit-any
        const service: any = createClient(ORIGIN, g.secretKey, {
          global: { fetch: appFetch },
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        assertEquals((await service.from("hidden").select()).data, [{ id: 1, note: "secret" }]);
        const anonHidden = await supabase.from("hidden").select();
        assertEquals([anonHidden.status, anonHidden.error?.code], [404, "PGRST205"]);
        const serviceDoc = await appFetch(`${ORIGIN}/rest/v1`, {
          headers: { apikey: g.secretKey },
        });
        assert((await serviceDoc.json()).paths["/hidden"], "the secret key sees the whole schema");
      });

      await t.step(
        "API keys and access tokens: publishable, user JWT, secret, refused",
        async () => {
          const keys = await resolveSupabaseKeys(keyConfig);
          const jwt = await signSupabaseJwt(keys, {
            sub: B,
            role: "authenticated",
            aud: "authenticated",
            exp: Math.floor(Date.now() / 1000) + 600,
          });
          const options = (extra: object) => ({
            global: { fetch: appFetch },
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            ...extra,
          });
          // deno-lint-ignore no-explicit-any
          const asB: any = createClient(
            ORIGIN,
            g.publishableKey,
            options({ accessToken: () => Promise.resolve(jwt) }),
          );
          assertEquals((await asB.from("notes").insert({ owner: B, body: "b's" })).status, 201);
          assertEquals((await asB.from("notes").select("body")).data, [{ body: "b's" }]);
          assertEquals((await asB.rpc("whoami")).data, B);
          assertEquals(
            (await asB.from("items").select("id", { count: "exact", head: true })).status,
            200,
          );
          // deno-lint-ignore no-explicit-any
          const service: any = createClient(ORIGIN, g.secretKey, options({}));
          const all = await service.from("notes").select("body").order("body");
          assertEquals(
            all.data,
            [{ body: "b's" }, { body: "mine" }],
            "the secret key bypasses RLS",
          );
          assertEquals((await service.rpc("whoami")).data, null);
          // deno-lint-ignore no-explicit-any
          const wrong: any = createClient(ORIGIN, "sb_publishable_wrong", options({}));
          const refused = await wrong.from("authors").select("id");
          assertEquals([refused.status, refused.error?.code], [401, "PGRST301"]);
          const expired = await signSupabaseJwt(keys, {
            sub: B,
            role: "authenticated",
            aud: "authenticated",
            exp: Math.floor(Date.now() / 1000) - 60,
          });
          // deno-lint-ignore no-explicit-any
          const stale: any = createClient(
            ORIGIN,
            g.publishableKey,
            options({ accessToken: () => Promise.resolve(expired) }),
          );
          const late = await stale.from("authors").select("id");
          assertEquals([late.status, late.error?.code], [401, "PGRST303"]);
        },
      );

      await t.step("denext's restClient runs the same requests", async () => {
        const client = restClient({
          url: `${ORIGIN}/rest/v1`,
          fetch: appFetch,
          headers: { apikey: g.publishableKey },
        });
        const { data } = await client.from("authors").select("name, books(title)")
          .eq("id", 2).order("title", { referencedTable: "books" }).single();
        assertEquals(data, {
          name: "Octavia",
          books: [{ title: "Kindred" }, { title: "Parable of the Sower" }],
        });
        assertEquals((await client.rpc("add", { a: 1, b: 1 })).data, 2);
        assertEquals((await client.schema("api").from("things").select("id")).data, [{ id: 1 }]);
        const maybe = await client.from("authors").select("id").eq("id", 42).maybeSingle();
        assertEquals([maybe.data, maybe.error], [null, null]);
        const up = await client.from("items").upsert({ id: 9, name: "nine" }).select("id").single();
        assertEquals(up.data, { id: 9 });
      });

      await t.step("generated Database types type-check createClient<Database>()", async () => {
        const catalog = await readRestCatalog(db.service(), ["public", "api"], "*");
        const types = generateRestTypes(catalog);
        assertStringIncludes(types, `foreignKeyName: "books_author_id_fkey"`);
        assertStringIncludes(types, `mood: "happy" | "sad"`);
        const dir = await Deno.makeTempDir({ dir: root });
        await Deno.writeTextFile(`${dir}/rest.ts`, types.replace(/declare module[\s\S]*$/, ""));
        await Deno.writeTextFile(
          `${dir}/check.ts`,
          `import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import type { Database, Tables } from "./rest.ts";
const supabase = createClient<Database>("https://app.test", "key");
const { data } = await supabase.from("books").select("title, authors(name)").eq("id", 1).single();
const title: string | undefined = data?.title;
const author: string | undefined = data?.authors?.name;
const sum = await supabase.rpc("add", { a: 1 });
const n: number | null = sum.data;
const rows: Tables<"authors">[] = [];
const mood: "happy" | "sad" | undefined = rows[0]?.mood;
const things = await supabase.schema("api").from("things").select("label");
const label: string | null | undefined = things.data?.[0]?.label;
// @ts-expect-error: not a column
await supabase.from("books").select("nope").eq("nope", 1).single().then((r) => r.data?.nope);
export { author, label, mood, n, title };
`,
        );
        const check = await new Deno.Command(Deno.execPath(), {
          args: ["check", "--no-lock", `${dir}/check.ts`],
          stdout: "piped",
          stderr: "piped",
        }).output();
        const out = new TextDecoder().decode(check.stderr) + new TextDecoder().decode(check.stdout);
        assert(check.success, out);
      });
    } finally {
      resetPlugins();
      installPostgres(undefined);
      installSupabaseKeys(undefined);
      await env.drop();
      await Deno.remove(root, { recursive: true });
    }
  },
});

const GIS_URL = Deno.env.get("DENEXT_TEST_POSTGIS_URL") || undefined;
const gisReason = !GIS_URL
  ? "set DENEXT_TEST_POSTGIS_URL (a PostGIS server)"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;

Deno.test({
  name: `auto-REST × supabase-js: GeoJSON on PostGIS${gisReason ? ` (skipped: ${gisReason})` : ""}`,
  ignore: gisReason !== undefined,
  async fn() {
    const env = await environment(true, undefined, GIS_URL);
    const root = await Deno.makeTempDir({ prefix: "dnx-rest-gis-" });
    const adminUrl = new URL(GIS_URL!);
    adminUrl.pathname = `/${env.database}`;
    const admin = new (Deno as unknown as { SQL: new (url: string) => typeof env.admin }).SQL(
      adminUrl.toString(),
    );
    try {
      await admin.unsafe("create extension if not exists postgis");
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      const config = {
        plugins: [backend({ postgres: { sql: env.app }, rest: {} })],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      await rlsReady();
      await db.service().unsafe(`
        create table places (id int primary key, name text, geom geometry(Point, 4326));
        ${open("places")}
        insert into places values (1, 'here', ST_SetSRID(ST_MakePoint(1, 2), 4326));
      `).simple!();
      const manifest = await scanRoutes(`${root}/app`);
      const handler = createApp({
        getManifest: () => manifest,
        load,
        matchExternal: getPluginRequestHandler(),
      });
      const appFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set("host", "app.test");
        return handler(new Request(request.url, { method: request.method, headers }));
      }) as typeof fetch;
      // deno-lint-ignore no-explicit-any
      const supabase: any = createClient(ORIGIN, "anon", {
        global: { fetch: appFetch },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error, status } = await supabase.from("places").select("id, name, geom")
        .geojson();
      assertEquals([status, error], [200, null]);
      assertEquals(data, {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { id: 1, name: "here" },
        }],
      });
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await admin.close();
      await env.drop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
