---
title: Coming from Supabase
slug: coming-from-supabase
lead: A concept map and migration checklist for Supabase developers. With denext and the opt-in @denext/backend plugin your backend lives in your app — auth, Postgres scoped by row-level security, storage and realtime — and you bring the Postgres.
---

Supabase is a hosted platform your app talks to over HTTP. denext is the other way round: the
backend is part of your app. [`denextAuth`](/docs/auth) signs users in, route handlers and
Server Actions are your functions, and [`@denext/backend`](/docs/backend) adds storage, Postgres
with Supabase-compatible row-level security, and realtime changes from your tables. You run it
where you run the app, against a Postgres you provide (any provider, or your own server).

To be plain about it once: **denext is not a hosted service, and it is not supabase-js
compatible.** There is no `createClient(url, anonKey)` to point at it and no drop-in for the
supabase-js API. What carries over unchanged is the database: your tables, your SQL functions
and your row-level security policies, which use the same roles and the same `auth.*` functions.

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

| Supabase                                            | denext                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A hosted project (`https://<ref>.supabase.co`)      | Your app, plus a Postgres you run or rent. Nothing to sign up for.                                                                                                                                |
| `supabase.from("t").select()` (PostgREST)           | `db()` from `@denext/backend/server`: a tagged-template SQL query, run as the request's user. No generated REST API — see [What is missing](#what-is-missing). [Postgres](/docs/backend#postgres) |
| Row-level security, `auth.uid()`, `auth.jwt()`      | The same: `db()` sets `role` and `request.jwt.claims` per query, and Supabase's own `auth.*` functions read them. [Row-level security](/docs/backend#row-level-security)                          |
| `anon` / `authenticated` roles                      | The same names, created by the plugin's first migration. Tables need an explicit `grant`.                                                                                                         |
| `service_role` key                                  | `db.service()` on the server — the app's own database user, no RLS. There is no key to leak: the server is the only client.                                                                       |
| `supabase.rpc("fn", args)`                          | `` db()`select * from fn(${a}, ${b})` `` — your SQL functions, `security definer` included, run as before.                                                                                        |
| Supabase Auth: email + password                     | `credentials()` with an adapter. [Password sign-in](/docs/auth#password-sign-in-without-an-authorize)                                                                                             |
| Supabase Auth: magic link, email OTP                | `magicLink()`, `emailOtp()` — through your own mailer. [Passwordless](/docs/auth#passwordless-magic-links-and-one-time-codes)                                                                     |
| Supabase Auth: OAuth providers                      | `github()`, `google()`, `apple()`, `discord()`, … and generic `oidc()`. [Providers](/docs/auth#providers)                                                                                         |
| Supabase Auth: MFA (TOTP), passkeys                 | TOTP with backup codes, and WebAuthn passkeys. [Two-factor](/docs/auth#two-factor-authentication-totp)                                                                                            |
| `auth.users`, `auth.identities`                     | denext auth's `auth_*` tables on the same database via `backendAuthAdapter()`. [Auth › Postgres](/docs/auth#postgres)                                                                             |
| `supabase.auth.getUser()` on the server             | `await auth()` from `denext/server`.                                                                                                                                                              |
| Storage buckets, signed URLs, image transformations | `backend({ storage })` on S3, R2, MinIO or the filesystem: `public` buckets, signed URLs, `transform`. [Storage](/docs/backend#storage)                                                           |
| Storage policies on `storage.objects`               | A bucket's `authorize({ session, op, key })` function, in TypeScript — not SQL.                                                                                                                   |
| Realtime: Postgres changes                          | `useTableChanges(table)` in the browser, `tableChanges` / `onTableChange` on the server, each change re-read under the viewer's policies. [Realtime](/docs/backend#realtime-from-the-database)    |
| Realtime: broadcast, presence                       | `createChannel` / `useChannel` and `usePresence` from `denext/live`. [Live](/docs/live)                                                                                                           |
| Edge Functions                                      | Route handlers (`app/api/<name>/route.ts`) and validated `defineApi` handlers; Server Actions for form mutations. [Typed API](/docs/typed-api)                                                    |
| `supabase.functions.invoke()`, generated types      | `createApiClient()` / `useApi()`, typed from your route handlers. [Typed API](/docs/typed-api)                                                                                                    |
| Database webhooks                                   | `onTableChange(table, fn)` on the server. [On the server](/docs/backend#on-the-server)                                                                                                            |
| `pg_cron`, scheduled functions                      | `defineTask` in `tasks/` with a cron `schedule`. [Scheduled tasks](/docs/tasks)                                                                                                                   |
| `supabase migration new`, `supabase db push`        | `denext generate migration <name>`, `denext task migrate`. [Postgres migrations](/docs/database#plain-sql-files-on-postgres)                                                                      |
| Studio (table editor, policies, storage, users)     | The Database section of `denext ui`: tables and rows, policies with an "as user" preview, migrations, storage, auth users. Local only. [`denext ui`](/docs/ui#database)                           |
| Vault, project secrets                              | Environment variables (`Deno.env.get`), `.env` in development. [Environment](/docs/environment)                                                                                                   |

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

Both run as the signed-in user, and your policies decide which rows come back. The difference is
where the query lives: with Supabase the browser can build queries against any granted table;
with denext a query exists only where your server code wrote it, and the browser gets what a route
handler, Server Action or Server Component chose to return. Every interpolated value is a bound
parameter. Outside a request (a task, a script) `db()` runs as `anon`; act for a user with
`db({ as: { id: userId } })`, or as the server with `db.service()`.

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
// Supabase
await supabase.storage.from("avatars").upload(`${userId}/avatar.png`, file);
const { data } = await supabase.storage.from("invoices").createSignedUrl(path, 60);
```

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

A bucket's rules are a function in `denext.config.ts` rather than SQL policies on
`storage.objects`. The Supabase pattern of one folder per user becomes:

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

The filter takes Supabase's `column=eq.value` form or `{ list_id: listId }`. The hook keeps the
row list for you; `onChange` gets each batch if you would rather apply them yourself. Every
changed row is re-read as the subscriber, under their policies — a subscriber never receives a row
their `select` policies hide. See
[Realtime from the database](/docs/backend#realtime-from-the-database).

### Edge Functions → route handlers

```ts
// Supabase — supabase/functions/hello/index.ts
Deno.serve(async (req) => {
  const { name } = await req.json();
  return Response.json({ message: `Hello ${name}` });
});
// called with: supabase.functions.invoke("hello", { body: { name } })
```

```ts
// denext — app/api/hello/route.ts
export async function POST(req: Request): Promise<Response> {
  const { name } = await req.json();
  return Response.json({ message: `Hello ${name}` });
}
// called with: fetch("/api/hello", { method: "POST", body: … }), or createApiClient()
```

Both are Deno and web-standard `Request` / `Response`, so most function bodies move as they are.
A route handler runs in your app's process, with `auth()`, `db()` and `storage` available, and
`defineApi` adds validated, typed input and errors. See [Typed API](/docs/typed-api).

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
   `denext generate migration <name>` + `denext task migrate`.
5. **Apply denext's own migrations.** They run on first use: auth's `auth_*` tables when
   `backendAuthAdapter()` first runs (recorded in `auth_migrations`), the RLS setup and realtime
   triggers when the backend first needs them (recorded in `backend_migrations`). Pass
   `migrate: false` to either and apply them from a deploy step if the app's user should not
   run DDL.
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
keep their paths, so the stored keys in your tables stay valid. Then declare each bucket in
`backend({ storage: { buckets } })` with an `authorize` that matches what its Supabase policies
allowed, and set the store's CORS rules to allow your origin to `GET` and `PUT` and to expose
`ETag`.

## What is missing

denext covers the app-backend half of Supabase; some of the platform is not there:

- **No generated REST API.** There is no PostgREST equivalent that turns tables into HTTP
  endpoints, so the browser cannot query a table directly; queries live in server code. An
  auto-generated API over the RLS-scoped client is planned.
- **No supabase-js drop-in.** Calls have to be rewritten, as above.
- **No hosted dashboard.** `denext ui` runs on your machine, on loopback; there is no shared web
  console, no logs explorer and no usage metrics.
- **Not hosted at all.** Backups, point-in-time recovery, connection pooling and database upgrades
  are your Postgres provider's job.
- **Auth gaps.** No phone or SMS sign-in, no anonymous sign-in, no SAML SSO (generic `oidc()`
  covers OIDC identity providers), and no built-in mailer — you supply `sendVerificationRequest`.
- **Storage policies are TypeScript, not SQL.** A bucket's `authorize` function replaces policies
  on `storage.objects`, and there is no `storage` schema to join against. Uploads are presigned
  (multipart on S3), not TUS resumable uploads.
- **Realtime is LISTEN/NOTIFY.** `TRUNCATE` sends nothing, and very high write volumes serialize
  on commit; logical replication is planned.
- **No database type generator.** `createApiClient` types your API, not your tables; use an ORM
  such as [Drizzle](/docs/database#orms) or write the row types.
- **No Vault, no extensions catalogue.** Secrets are environment variables, and the Postgres
  extensions you have are the ones your provider installs.
