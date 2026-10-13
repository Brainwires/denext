---
title: Coming from Supabase
slug: coming-from-supabase
lead: A concept map and migration checklist for Supabase developers. With denext and the opt-in @denext/backend plugin your backend lives in your app — auth, Postgres scoped by row-level security, storage, realtime and a PostgREST-style REST API — and you bring the Postgres.
---

Supabase is a hosted platform your app talks to over HTTP. denext is the other way round: the
backend is part of your app. [`denextAuth`](/docs/auth) signs users in, route handlers and
Server Actions are your functions, and [`@denext/backend`](/docs/backend) adds storage, Postgres
with Supabase-compatible row-level security, and realtime changes from your tables. You run it
where you run the app, against a Postgres you provide (any provider, or your own server).

To be plain about it once: **denext is not a hosted service.** Parts of the supabase-js API
already work against the app with `createClient(appUrl, publishableKey)` — the database
(`from()`, `rpc()`), Storage (`supabase.storage`, policies on `storage.objects` included), Realtime
(`supabase.channel()`) and Edge Functions (`functions.invoke`) — and the rest are calls to rewrite,
below. What carries over unchanged is the database: your tables, your SQL functions and your
row-level security policies, which use the same roles and the same `auth.*` functions.

```sh
denext plugin add @denext/backend
```

```ts
// denext.config.ts
import { denextAuth, github } from "denext/server";
import { backend, backendAuthAdapter, fs, realtime } from "@denext/backend";

export default {
  plugins: [
    backend({
      postgres: {}, // reads DATABASE_URL
      storage: { driver: fs({ dir: ".storage" }), buckets: { avatars: { public: true } } },
      realtime: realtime({ tables: { notes: {} } }),
    }),
    denextAuth({ providers: [github()], adapter: backendAuthAdapter() }),
  ],
};
```

## Concept map

| Supabase                                            | denext                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A hosted project (`https://<ref>.supabase.co`)      | Your app, plus a Postgres you run or rent. Nothing to sign up for.                                                                                                                                                                                                                                                                             |
| `supabase.from("t").select()` (PostgREST)           | The same call: `backend({ rest })` serves PostgREST 12's wire format at `/rest/v1`, so supabase-js works unchanged, and so does denext's `from()` from `@denext/backend/client` — embeds, `or`, upserts and all, run as the request's user; or `db()` in server code. [Auto-REST](/docs/backend#auto-rest), [Postgres](/docs/backend#postgres) |
| Row-level security, `auth.uid()`, `auth.jwt()`      | The same: `db()` sets `role` and `request.jwt.claims` per query, and Supabase's own `auth.*` functions read them. [Row-level security](/docs/backend#row-level-security)                                                                                                                                                                       |
| `anon` / `authenticated` roles                      | The same names, created by the plugin's first migration. Tables need an explicit `grant`.                                                                                                                                                                                                                                                      |
| `service_role` key                                  | `db.service()` on the server — the app's own database user, no RLS. There is no key to leak: the server is the only client.                                                                                                                                                                                                                    |
| `supabase.rpc("fn", args)`                          | The same call (or `rpc()` from `@denext/backend/client`) against `/rest/v1/rpc/fn`, for the functions `anon` / `authenticated` may EXECUTE; or `` db()`select * from fn(${a}, ${b})` `` on the server. `security definer` runs as before.                                                                                                      |
| Supabase Auth: email + password                     | `credentials()` with an adapter. [Password sign-in](/docs/auth#password-sign-in-without-an-authorize)                                                                                                                                                                                                                                          |
| Supabase Auth: magic link, email OTP                | `magicLink()`, `emailOtp()` — through your own mailer. [Passwordless](/docs/auth#passwordless-magic-links-and-one-time-codes)                                                                                                                                                                                                                  |
| Supabase Auth: OAuth providers                      | `github()`, `google()`, `apple()`, `discord()`, … and generic `oidc()`. [Providers](/docs/auth#providers)                                                                                                                                                                                                                                      |
| Supabase Auth: MFA (TOTP), passkeys                 | TOTP with backup codes, and WebAuthn passkeys. [Two-factor](/docs/auth#two-factor-authentication-totp)                                                                                                                                                                                                                                         |
| `auth.users`, `auth.identities`                     | denext auth's `auth_*` tables on the same database via `backendAuthAdapter()`. [Auth › Postgres](/docs/auth#postgres)                                                                                                                                                                                                                          |
| `supabase.auth.getUser()` on the server             | `await auth()` from `denext/server`.                                                                                                                                                                                                                                                                                                           |
| Storage buckets, signed URLs, image transformations | `backend({ storage })` on S3, R2, MinIO or the filesystem, serving Supabase's Storage API at `/storage/v1` (supabase-js unchanged, TUS resumable uploads too). [Storage](/docs/backend#supabase-storage-api)                                                                                                                                   |
| Storage policies on `storage.objects`               | The same policies, with `storage: { rls: true }` — or a bucket's `authorize({ session, op, key })` in TypeScript. [SQL row-level security](/docs/backend#sql-row-level-security-for-storage)                                                                                                                                                   |
| Realtime: Postgres changes                          | `supabase.channel().on("postgres_changes", …)` unchanged against the app's `/realtime/v1/websocket`; or `useTableChanges(table)` in the browser, `tableChanges` / `onTableChange` on the server — each change re-read under the viewer's policies. [Realtime](/docs/backend#supabase-realtime-supabasechannel)                                 |
| Realtime: broadcast, presence, private channels     | `supabase.channel()` unchanged — broadcast (`self`, `ack`, REST, `realtime.send()` / `realtime.broadcast_changes()` from SQL), presence across instances, private channels under your `realtime.messages` policies; `broadcast()` from server code. [Realtime](/docs/backend#supabase-realtime-supabasechannel)                                |
| Edge Functions                                      | `backend({ functions })`: `functions/<name>/index.ts` served at `/functions/v1/<name>`, each in a worker of its own, `verify_jwt` on by default. Or route handlers. [Edge Functions](/docs/backend#edge-functions)                                                                                                                             |
| `supabase.functions.invoke()`, generated types      | `functions.invoke` calls `/functions/v1/<name>` as on Supabase; for route handlers, `createApiClient()` / `useApi()`. [Typed API](/docs/typed-api)                                                                                                                                                                                             |
| Database webhooks                                   | `onTableChange(table, fn)` on the server. [On the server](/docs/backend#on-the-server)                                                                                                                                                                                                                                                         |
| `pg_cron`, scheduled functions                      | `defineJob` in `jobs/` with a cron `schedule`. [Scheduled jobs](/docs/jobs)                                                                                                                                                                                                                                                                    |
| `supabase migration new`, `supabase db push`        | `denext generate migration <name>`, `denext job migrate`. [Postgres migrations](/docs/database#plain-sql-files-on-postgres)                                                                                                                                                                                                                    |
| Studio (table editor, policies, storage, users)     | The Database section of `denext ui`: tables and rows, policies with an "as user" preview, migrations, storage, auth users. Local only. [`denext ui`](/docs/ui#database)                                                                                                                                                                        |
| Vault, project secrets                              | Environment variables (`Deno.env.get`), `.env` in development. [Environment](/docs/environment)                                                                                                                                                                                                                                                |

## Side by side

### Querying under row-level security

```ts
// Supabase — the browser or the server, through PostgREST
const { data: notes, error } = await supabase
  .from("notes")
  .select("id, body")
  .eq("list_id", listId)
  .order("id");
```

```ts
// denext — server code: a route handler, Server Action or Server Component
import { db } from "@denext/backend/server";

const notes = await db()`
  select id, body from notes where list_id = ${listId} order by id
`;
```

```ts
// denext — the browser, through backend({ rest })'s PostgREST-style routes
import { from } from "@denext/backend/client";

const { data: notes, error } = await from("notes")
  .select("id,body")
  .eq("list_id", listId)
  .order("id");
```

All three run as the signed-in user, and your policies decide which rows come back. With
[auto-REST](/docs/backend#auto-rest) on, the browser can build queries against the tables the
`anon` / `authenticated` roles were granted, as with Supabase — with one difference: by default
only tables with RLS enabled and views created `with (security_invoker = true)` get a route.
PostgREST serves a granted table with RLS off, or a plain view that reads as its owner, to every
caller; denext skips those and lists them in a startup warning, and you name one in
`rest.tables` to serve it as is. A full count (`count: "exact"`) is for signed-in users by default
(`rest.exactCount`). Without auto-REST, a query exists only where your server code wrote it, and
the browser gets what a route handler, Server Action or Server Component chose to return. Every
interpolated value is a bound parameter. `db()` reads who is asking at each query, so a
module-level client is fine; outside a request (a job, a script) it runs as `anon`; act for a
user with `db({ as: { id: userId } })`, or as the server with `db.service()`.

### Signing in

```ts
// Supabase
await supabase.auth.signInWithPassword({ email, password });
await supabase.auth.signInWithOtp({ email });
await supabase.auth.signInWithOAuth({ provider: "github" });
const { data: { user } } = await supabase.auth.getUser();
```

```ts
// denext — in the browser
import { signIn } from "denext";

await signIn("credentials", { credentials: { email, password } });
await signIn("email", { credentials: { email } }); // magicLink() — or "email-otp" for emailOtp()
await signIn("github");
```

```ts
// denext — on the server
import { auth } from "denext/server";

const session = await auth(); // null when signed out
const userId = session?.user.id;
```

The session is a cookie on your own origin, so there is no access token to store or refresh in the
browser, and `db()` reads it on the server. Providers and the adapter are configured once in
`denextAuth({ … })`; Supabase sends auth mail for you, denext calls your
`sendVerificationRequest`. See [Auth](/docs/auth).

### Storage: upload and signed URLs

```ts
// Supabase — and the same code against denext: the Storage API is served at /storage/v1
await supabase.storage.from("avatars").upload(`${userId}/avatar.png`, file);
const { data } = await supabase.storage.from("invoices").createSignedUrl(path, 60);
```

Keep it as is, or use denext's own helpers:

```tsx
// denext — in the browser (a "use client" component)
import { getFileUrl, uploadFile } from "@denext/backend/client";

const { key } = await uploadFile("avatars", file, { key: `${userId}/avatar.png` });
const src = await getFileUrl("avatars", key, { transform: { width: 128 } });
```

```ts
// denext — on the server
import { storage } from "@denext/backend/server";

const url = await storage.bucket("invoices").createSignedUrl(path, { expiresIn: 60 });
```

Your policies on `storage.objects` keep working with `storage: { rls: true }`: denext keeps
Supabase's `storage` schema (`storage.foldername()` included) and runs each operation as the
request's role. Or write a bucket's rules as a function in `denext.config.ts`. Outside a request
(a job, a script) there is no session to pass it, so code there uses
`storage.bucket("invoices", { service: true })` — the counterpart of Supabase's service-role key
(over HTTP, the secret key from `backend({ supabase })`). The Supabase pattern of one folder per user, in
TypeScript:

```ts
buckets: {
  avatars: {
    public: true,
    mime: ["image/*"],
    authorize: ({ session, op, key }) =>
      op === "upload" && !!session && key.startsWith(`${session.user.id}/`),
  },
},
```

### Realtime: Postgres changes

```ts
// Supabase
supabase
  .channel("notes")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "notes", filter: `list_id=eq.${listId}` },
    (payload) => apply(payload),
  )
  .subscribe();
```

```tsx
// denext — opt the table in with realtime({ tables: { notes: {} } }), then:
"use client";
import { useTableChanges } from "@denext/backend/client";

export function Notes({ initial, listId }: { initial: Note[]; listId: number }) {
  const { rows } = useTableChanges<Note>("notes", { initial, filter: `list_id=eq.${listId}` });
  return <ul>{rows.map((n) => <li key={n.id}>{n.body}</li>)}</ul>;
}
```

The Supabase code above also runs as it is: the app serves Supabase Realtime's protocol at
`/realtime/v1/websocket`, so `createClient(appUrl, key).channel(…)` gets the same payloads —
`postgres_changes` with every filter operator (`eq neq lt lte gt gte in`), broadcast, presence and
private channels authorized by your `realtime.messages` policies. The tables still have to be listed
in `realtime({ tables })` (that installs their triggers) instead of added to the
`supabase_realtime` publication.

The hook is the denext-native way: the filter takes Supabase's `column=op.value` form or
`{ list_id: listId }` / `{ priority: { gte: 3 } }`, `events` narrows the kinds of change, and it
keeps the row list for you; `onChange` gets each batch if you would rather apply them yourself.
Either way every changed row is re-read as the subscriber, under their policies — a subscriber
never receives a row their `select` policies hide, and a delete reaches only subscribers who could
see the row. See [Supabase Realtime](/docs/backend#supabase-realtime-supabasechannel).

### Edge Functions

Copy `supabase/functions/` as it is (or leave it there: the plugin reads `supabase/functions/` when
there is no `functions/`) and turn the functions on:

```ts
// denext.config.ts
backend({ functions: { functions: { "stripe-webhook": { verifyJwt: false } } } });
```

```ts
// supabase/functions/hello/index.ts — unchanged
Deno.serve(async (req) => {
  const { name } = await req.json();
  return Response.json({ message: `Hello ${name}` });
});
// still called with: supabase.functions.invoke("hello", { body: { name } })
```

Each function runs in a Deno Worker of its own with `Deno.serve`, `EdgeRuntime.waitUntil` and
`SUPABASE_URL` / `SUPABASE_DB_URL` as on Supabase; `verify_jwt` becomes `verifyJwt` in the config.
See [Edge Functions](/docs/backend#edge-functions). Code that wants `auth()`, `db()` and `storage`
directly, or typed input with `defineApi`, fits a route handler (`app/api/hello/route.ts`) better:
it runs in the app's process. See [Typed API](/docs/typed-api).

### Your existing policies

Policies written for Supabase keep working, because the pieces they rely on are the same:

```sql
-- unchanged from Supabase
create policy "read own notes" on notes for select using (auth.uid() = owner);
create policy "write own notes" on notes for insert with check (auth.uid() = owner);
```

- `auth.uid()`, `auth.role()`, `auth.email()` and `auth.jwt()` are Supabase's own definitions,
  reading `request.jwt.claims`, which denext fills with the same keys as a Supabase access token
  (`sub`, `role`, `email`, `aal`, `app_metadata`, `user_metadata`, …).
- The roles are `anon` and `authenticated`. Supabase grants every table in `public` to both by
  default; denext grants nothing, so add the grants your policies assume:

```sql
grant select, insert, update, delete on notes to authenticated;
grant usage on sequence notes_id_seq to authenticated;
-- or Supabase's default, for every new table:
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
```

- `auth.uid()` returns `uuid`, and denext's auth adapters issue UUID user ids — so a user moved
  with their Supabase id still owns their rows.

See [Row-level security](/docs/backend#row-level-security) for who a query runs as and how the
claims are set.

## Migration checklist

1. **Export the schema, policies and data.** With the Supabase CLI,
   `supabase db dump -f schema.sql` (your schemas, policies included) and
   `supabase db dump --data-only -f data.sql`; or `pg_dump` against the project's connection
   string with `--schema=public --no-owner` (add your other schemas). Leave Supabase's own
   schemas (`auth`, `storage`, `realtime`, `extensions`, …) out — users and files move separately,
   below.
2. **Point `DATABASE_URL` at the new Postgres** and add `backend({ postgres: {} })`. The app's
   database user needs `CREATEROLE` so the first scoped query can create `anon`, `authenticated`
   and the `auth.*` functions; where it may not, have an administrator run `rlsSetupSql("app_user")`
   (from `@denext/backend`) and set `rls: { migrate: false }`.
3. **Create the roles and `auth.*` functions before restoring**, since your policies reference
   them: run the `rlsSetupSql` output with `psql`, or start the app once and make one `db()` query.
   If the dump grants to `service_role` or other Supabase-only roles, either
   `create role service_role nologin` first or delete those `grant` lines; drop or rewrite any
   foreign key that references `auth.users` (point it at `auth_users(id)` once auth's tables
   exist, step 5).
4. **Restore** `schema.sql` then `data.sql` with `psql`. From here on, new schema changes are
   `denext generate migration <name>` + `denext job migrate`.
5. **Apply denext's own migrations.** They run on first use: auth's `auth_*` tables when
   `backendAuthAdapter()` first runs (recorded in `auth_migrations`), the RLS setup and realtime
   triggers and the `realtime` schema when the backend first needs them (recorded in
   `backend_migrations`). Pass `migrate: false` to either and apply them from a deploy step if the
   app's user should not run DDL. Policies you wrote on `realtime.messages` (private channels) are
   in the `realtime` schema you left out: re-create them once the realtime migration has made the
   table.
6. **Move the users** — see [Moving users](#moving-users).
7. **Copy the storage objects** — see [Moving files](#moving-files).
8. **Swap the environment.** `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
   go away. You set `DATABASE_URL`, the `secret` you pass `denextAuth` (say `AUTH_SECRET`),
   `DENEXT_STORAGE_SECRET` (at least 32 characters), `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY` for an S3 driver, each OAuth provider's client id and secret, and
   whatever your mailer needs.
9. **Re-register OAuth redirect URLs** with each provider: the callback is now your app's
   `/auth/callback/<provider>` (under denext auth's `basePath`, default `/auth`), not Supabase's.
10. **Rewrite the client calls** using the side-by-side snippets above. supabase-js calls in the
    browser become Server Components, Server Actions, route handlers or `useApi` calls.

### Moving users

What moves:

- **Users, with their ids.** `createUser` takes an `id`, so each Supabase user keeps their UUID
  and every `owner = auth.uid()` row stays theirs. Copy `email`, `email_confirmed_at` (as epoch
  seconds in `emailVerified`) and the name and avatar from `raw_user_meta_data`.
- **OAuth links.** Each `auth.identities` row with an OAuth provider becomes `linkAccount({
  userId, provider, providerAccountId: provider_id })`, so the next GitHub or Google sign-in finds
  the same user. Use the same provider id denext uses (`github`, `google`, …).
- **Passwords — through a hasher that also verifies bcrypt.** Supabase stores bcrypt hashes
  (`$2a$…`) in `encrypted_password`; denext's default hasher is scrypt and does not read them.
  Copy each hash with `setCredential` as it is, and configure a `Hasher` that verifies both:

```ts
// lib/hasher.ts
import bcrypt from "npm:bcryptjs";
import { type Hasher, scryptHasher } from "denext/server";

const scrypt = scryptHasher();
export const hasher: Hasher = {
  hash: scrypt.hash, // new and reset passwords are scrypt
  verify: async (plain, stored) => {
    if (!stored.startsWith("$2")) return scrypt.verify(plain, stored); // equal work when empty
    try {
      return await bcrypt.compare(plain, stored);
    } catch {
      return false; // a malformed hash is a refusal, never an error
    }
  },
};
// denextAuth({ hasher, adapter: backendAuthAdapter(), providers: [credentials()], … })
```

A user keeps their bcrypt hash until they reset their password, when it is replaced with scrypt.
To convert everyone sooner, use a `credentials({ authorize })` of your own that checks the bcrypt
hash and writes `await hashPassword(password)` with `setCredential` on success.

What does not move:

- **Sessions and refresh tokens.** Everyone signs in once more.
- **TOTP factors and passkeys.** Users enroll again; passkeys are also bound to the site's domain.
- **Phone / SMS sign-in, anonymous users and SAML SSO** — denext auth has no equivalent (see
  below); move those users to email or OAuth sign-in first.

A one-off script, run against both databases (`npm:postgres` makes it work on any Deno):

```ts
// scripts/import-supabase-users.ts — deno run -A scripts/import-supabase-users.ts
import postgres from "npm:postgres";
import { fromPostgresJs, postgresAuthAdapter } from "denext/server";

const from = postgres(Deno.env.get("SUPABASE_DB_URL")!);
const adapter = postgresAuthAdapter({
  sql: fromPostgresJs(postgres(Deno.env.get("DATABASE_URL")!)),
});
const seconds = (t: Date | null) => (t ? Math.floor(t.getTime() / 1000) : undefined);

for (const u of await from`select * from auth.users where deleted_at is null`) {
  const meta = u.raw_user_meta_data ?? {};
  await adapter.createUser({
    id: u.id,
    email: u.email ?? undefined,
    emailVerified: seconds(u.email_confirmed_at),
    name: meta.full_name ?? meta.name,
    image: meta.avatar_url,
  });
  if (u.encrypted_password) await adapter.setCredential!(u.id, u.encrypted_password);
}
for (
  const i of await from`select * from auth.identities where provider not in ('email', 'phone')`
) {
  await adapter.linkAccount({
    userId: i.user_id,
    provider: i.provider,
    providerAccountId: i.provider_id,
    type: "oauth",
  });
}
await from.end();
await adapter.close?.();
```

### Moving files

Supabase Storage speaks the S3 protocol (Project Settings › Storage › S3 connection), so copy with
`rclone` or `aws s3 sync`. On an `s3()` driver every denext bucket is a key prefix inside one S3
bucket, so a Supabase bucket `avatars` goes to `<your-bucket>/avatars/`:

```sh
# rclone, with remotes "supabase" (the Supabase S3 endpoint) and "r2" (your store)
rclone copy supabase:avatars r2:my-app/avatars
rclone copy supabase:invoices r2:my-app/invoices

# or the AWS CLI, in two steps
aws s3 sync s3://avatars ./export/avatars --endpoint-url https://<ref>.supabase.co/storage/v1/s3
aws s3 sync ./export/avatars s3://my-app/avatars
```

On the `fs()` driver a bucket is a directory under `dir`, so `.storage/avatars/<key>`. Object keys
keep their paths, so the stored keys in your tables stay valid. Listings, `info()` and the policies
read the object rows in `storage.objects`: a database restored from a Supabase dump brings
`storage.buckets` and `storage.objects` (and your policies on them) along, and denext uses those
tables as they are. Then either keep the policies (`storage: { rls: true }`) or declare each bucket
in `backend({ storage: { buckets } })` with an `authorize` that matches what they allowed, and set
the store's CORS rules to allow your origin to `GET` and `PUT` and to expose `ETag`.

## Self-hosting

Supabase self-hosts as a `docker compose` stack; so does a denext app.
`denext generate docker --stack` reads your config and writes the compose file for what it uses —
the app, Postgres 17 (or `--pgvector`'s `pgvector/pgvector:pg17`), MinIO with its bucket created
by a one-shot `mc` service, and a one-shot `denext job migrate` before the app starts — with
health checks and `depends_on` conditions throughout, named volumes, and a `.env.example` listing
every secret (the role of Supabase's `.env` with its JWT secret and keys).

```sh
denext generate docker --stack
cp .env.example .env    # generate each secret as the file says
docker compose up -d --build
```

There is no Kong gateway, Studio or analytics container: the app itself serves the APIs, and
[`denext ui`](/docs/ui#database) is the dashboard, on your machine.
[Deployment › Self-hosted stack](/docs/deploy#self-hosted-stack-postgres-storage-migrations) has
the flags and the services.

## What is missing

denext covers the app-backend half of Supabase; some of the platform is not there:

- **Auto-REST leaves out a few PostgREST features.** Embedding through views, ordering by an
  embedded column, top-level `or=` on embedded columns, `PUT` upserts, aggregate functions and
  computed fields / relationships are not served; a `PATCH` or `DELETE` needs a filter (as on
  Supabase, where `safeupdate` refuses one without), and `count: "exact"` is for signed-in users
  unless `rest.exactCount` allows it.
- **supabase-js: the database, storage, realtime and functions calls.** `from()`, `rpc()` and
  `schema()` work against `/rest/v1`, `supabase.storage` against `/storage/v1`,
  `supabase.channel()` against `/realtime/v1` and `functions.invoke` against `/functions/v1`,
  unchanged (point `createClient` at the app); the other calls have to be rewritten, as above.
- **No hosted dashboard.** `denext ui` runs on your machine, on loopback; there is no shared web
  console, no logs explorer and no usage metrics.
- **Not hosted at all.** Backups, point-in-time recovery, connection pooling and database upgrades
  are your Postgres provider's job.
- **Auth gaps.** No phone or SMS sign-in, no anonymous sign-in, no SAML SSO (generic `oidc()`
  covers OIDC identity providers), and no built-in mailer — you supply `sendVerificationRequest`.
- **Realtime is LISTEN/NOTIFY.** Notifications serialize on commit across the database, so very high
  write volumes are better served by logical replication (planned); a table's full old row
  (`old: "full"`) is carried only when it fits a notification (about 7.5 KB of JSON). Tables opt
  in through `realtime({ tables })`, not the `supabase_realtime` publication.
- **Types for the REST client.** `.denext/rest.ts` is `supabase gen types`-shaped (tables,
  views, functions, enums and relationships of the exposed schemas) and types `createClient<Database>()`
  and denext's `from()`; `db()`'s tagged SQL is untyped, so for server queries use an ORM such as
  [Drizzle](/docs/database#orms) or write the row types.
- **No Vault, no extensions catalogue.** Secrets are environment variables, and the Postgres
  extensions you have are the ones your provider installs.
