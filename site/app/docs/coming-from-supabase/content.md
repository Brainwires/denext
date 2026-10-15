---
title: Coming from Supabase
slug: coming-from-supabase
lead: The stock @supabase/supabase-js client works against a denext app — auth, the database, storage, realtime and Edge Functions — served by your app from a Postgres you bring. A concept map, what is deliberately different, and a migration checklist.
---

Supabase is a hosted platform your app talks to over HTTP. With denext and the opt-in
[`@denext/backend`](/docs/backend) plugin, the same API is served by your app itself, against a
Postgres you provide (any provider, or your own server): point the client you already have at it.

```ts
import { createClient } from "@supabase/supabase-js";

// Your app's own origin and its publishable key (`denext backend keys` prints a set).
const supabase = createClient("https://app.example.com", PUBLISHABLE_KEY);
```

**What works with the stock client**, once the matching option is on:

| supabase-js                                                  | Served at                | Turned on by                                                                            |
| ------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------- |
| API keys and access tokens (`apikey`, `Bearer`)              | every route below        | `backend({ supabase: true })` — or `supabase: { publishableKey, secretKey, … }`         |
| `supabase.auth.*` (GoTrue)                                   | `/auth/v1`               | `supabase: { auth: { … } }` with `denextAuth()` [→](/docs/auth#supabase-clients-authv1) |
| `from()`, `rpc()`, `schema()` (PostgREST 12)                 | `/rest/v1`               | `rest: {}` (`rest.schemas` for more than `public`) [→](/docs/backend#auto-rest)         |
| `supabase.storage` (incl. TUS uploads)                       | `/storage/v1`            | `storage: { … }` (`storage.rls` for SQL policies) [→](/docs/backend#storage)            |
| `supabase.channel()` (Postgres changes, broadcast, presence) | `/realtime/v1/websocket` | `realtime: realtime({ … })` [→](/docs/backend#realtime-from-the-database)               |
| `supabase.functions.invoke()`                                | `/functions/v1/<name>`   | `functions: {}` [→](/docs/backend#edge-functions)                                       |
| `schema("pgmq_public").rpc(…)` (Queues)                      | `/rest/v1/rpc/…`         | `queues: {}` with `rest` [→](/docs/backend#queues)                                      |

The database side carries over as SQL: your tables, functions and row-level security policies
(the same `anon` / `authenticated` roles and `auth.uid()` / `auth.jwt()`), Supabase's
`storage.objects` and `realtime.messages` policies, pgmq's queue functions, pgvector's
`match_documents`, `supabase_functions.http_request` webhook triggers and — with
`vault: { sql: true }` — `vault.create_secret()` and `vault.decrypted_secrets`.

**What is deliberately different:**

- **Your app is the server.** There is no hosted project or usage metering. The console is
  [`denext ui`](/docs/ui#database) on your machine, or, for a deployed stack,
  [`denext dashboard`](/docs/ui#the-stack-dashboard): the same pages behind `DASHBOARD_PASSWORD`,
  logs included. Backups, pooling and upgrades are your Postgres provider's job.
- **One user store, two ways in.** `/auth/v1` serves the users `denextAuth()` keeps, so a cookie
  session from denext's own sign-in and a supabase-js token session are the same user; server
  code reads either with `auth()`. Mail goes out through `GOTRUE_SMTP_*` (or `smtpMailer()` /
  your own `sendVerificationRequest`); you supply the SMS sender (`sendSms`).
- **Least exposure by default.** Auto-REST serves only tables with RLS on (and `security_invoker`
  views) unless you name others; Edge Functions verify the caller unless `verifyJwt: false`;
  webhooks reach only targets configured in the app; the vault key never lives in the database
  (its SQL surface works only inside transactions the app opens).
- **Server code does not need the client.** Inside the app, `db()` (scoped by the same policies),
  `storage`, `queue()` and `vault` from `@denext/backend/server` are direct, typed calls — no HTTP
  round trip.

```sh
denext plugin add @denext/backend
```

```ts
// denext.config.ts
import { denextAuth, github } from "denext/server";
import { backend, backendAuthAdapter, fs, realtime } from "@denext/backend";

export default {
  plugins: [
    denextAuth({ providers: [github()], adapter: backendAuthAdapter() }),
    backend({
      postgres: {}, // reads DATABASE_URL
      supabase: { auth: { siteUrl: "https://app.example.com" } }, // keys from the environment
      rest: {},
      storage: { driver: fs({ dir: ".storage" }), buckets: { avatars: { public: true } } },
      realtime: realtime({ tables: { notes: {} } }),
      functions: {},
    }),
  ],
};
```

## Concept map

| Supabase                                                                                       | denext                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A hosted project (`https://<ref>.supabase.co`)                                                 | Your app, plus a Postgres you run or rent. Nothing to sign up for.                                                                                                                                                                                                                                                                                                                                                                                    |
| `supabase.from("t").select()` (PostgREST)                                                      | The same call: `backend({ rest })` serves PostgREST 12's wire format at `/rest/v1`, so supabase-js works unchanged, and so does denext's `from()` from `@denext/backend/client` — embeds, `or`, upserts and all, run as the request's user; or `db()` in server code. [Auto-REST](/docs/backend#auto-rest), [Postgres](/docs/backend#postgres)                                                                                                        |
| Row-level security, `auth.uid()`, `auth.jwt()`                                                 | The same: `db()` sets `role` and `request.jwt.claims` per query, and Supabase's own `auth.*` functions read them. [Row-level security](/docs/backend#row-level-security)                                                                                                                                                                                                                                                                              |
| `anon` / `authenticated` roles                                                                 | The same names, created by the plugin's first migration. Tables need an explicit `grant`.                                                                                                                                                                                                                                                                                                                                                             |
| `service_role` key                                                                             | `DENEXT_SECRET_KEY` (`sb_secret_…`, with `backend({ supabase })`) — runs as `service_role`, past RLS, as on Supabase; never ship it to a browser. Server code can use `db.service()` instead, with no key at all.                                                                                                                                                                                                                                     |
| `supabase.rpc("fn", args)`                                                                     | The same call (or `rpc()` from `@denext/backend/client`) against `/rest/v1/rpc/fn`, for the functions `anon` / `authenticated` may EXECUTE; or `` db()`select * from fn(${a}, ${b})` `` on the server. `security definer` runs as before.                                                                                                                                                                                                             |
| Supabase Auth: email + password                                                                | `credentials()` with an adapter. [Password sign-in](/docs/auth#password-sign-in-without-an-authorize)                                                                                                                                                                                                                                                                                                                                                 |
| Supabase Auth: magic link, email OTP                                                           | `magicLink()`, `emailOtp()` — through your own mailer. [Passwordless](/docs/auth#passwordless-magic-links-and-one-time-codes)                                                                                                                                                                                                                                                                                                                         |
| Supabase Auth: OAuth providers                                                                 | `github()`, `google()`, `apple()`, `discord()`, … and generic `oidc()`. [Providers](/docs/auth#providers)                                                                                                                                                                                                                                                                                                                                             |
| Supabase Auth: MFA (TOTP, phone, WebAuthn), passkeys                                           | TOTP, phone and WebAuthn factors with backup codes (recovery codes) in one store both sign-in paths share, and WebAuthn passkeys. [Two-factor](/docs/auth#two-factor-authentication-totp)                                                                                                                                                                                                                                                             |
| Supabase Auth: phone OTP                                                                       | `phoneOtp()` — through your own `sendSms` (or `hooks.sendSms`). [Phone sign-in](/docs/auth#phone-sign-in)                                                                                                                                                                                                                                                                                                                                             |
| Supabase Auth: anonymous sign-in                                                               | `anonymous: true` → `POST /auth/anonymous`; an email or phone proof converts the user in place. [Anonymous sign-in](/docs/auth#anonymous-sign-in)                                                                                                                                                                                                                                                                                                     |
| Supabase Auth: captcha (hCaptcha, Turnstile)                                                   | `captcha` on `denextAuth()` — the same check on denext's endpoints and `/auth/v1`. [Captcha](/docs/auth#captcha)                                                                                                                                                                                                                                                                                                                                      |
| Supabase Auth hooks (access token, send email / SMS)                                           | `hooks.customAccessToken`, `hooks.sendEmail`, `hooks.sendSms` — for cookie sessions and `/auth/v1` alike. [Hooks](/docs/auth#hooks)                                                                                                                                                                                                                                                                                                                   |
| Supabase Auth: SAML SSO                                                                        | `/auth/v1` with `backend({ supabase: { auth: { saml } } })` — `signInWithSSO`, Single Logout, the `admin/sso/providers` API. denext's own cookie sign-in has no SAML. [SAML](/docs/auth#saml-single-sign-on)                                                                                                                                                                                                                                          |
| Supabase Auth: Web3 (Ethereum, Solana)                                                         | `/auth/v1` with `supabase: { auth: { web3 } }` — `signInWithWeb3`. [Web3](/docs/auth#web3-sign-in)                                                                                                                                                                                                                                                                                                                                                    |
| Supabase Auth: OAuth 2.1 server                                                                | `/auth/v1` with `supabase: { auth: { oauthServer } }` — `supabase.auth.oauth.*`, `admin.oauth.*`. [OAuth 2.1 server](/docs/auth#oauth-21-server)                                                                                                                                                                                                                                                                                                      |
| `auth.users`, `auth.identities`                                                                | denext auth's `auth_*` tables on the same database via `backendAuthAdapter()`. [Auth › Postgres](/docs/auth#postgres)                                                                                                                                                                                                                                                                                                                                 |
| `supabase.auth.getUser()` on the server                                                        | `await auth()` from `denext/server`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Storage buckets, signed URLs, image transformations                                            | `backend({ storage })` on S3, R2, MinIO or the filesystem, serving Supabase's Storage API at `/storage/v1` (supabase-js unchanged: TUS resumable uploads, `listV2`, object versions and lifecycle rules too). [Storage](/docs/backend#supabase-storage-api)                                                                                                                                                                                           |
| Storage policies on `storage.objects`                                                          | The same policies, with `storage: { rls: true }` — or a bucket's `authorize({ session, op, key })` in TypeScript. [SQL row-level security](/docs/backend#sql-row-level-security-for-storage)                                                                                                                                                                                                                                                          |
| Realtime: Postgres changes                                                                     | `supabase.channel().on("postgres_changes", …)` unchanged against the app's `/realtime/v1/websocket`; or `useTableChanges(table)` in the browser, `tableChanges` / `onTableChange` on the server — each change re-read under the viewer's policies. [Realtime](/docs/backend#supabase-realtime-supabasechannel)                                                                                                                                        |
| Realtime: broadcast, presence, private channels                                                | `supabase.channel()` unchanged — broadcast (`self`, `ack`, REST, `realtime.send()` / `realtime.broadcast_changes()` from SQL), presence across instances, private channels under your `realtime.messages` policies, replay; `broadcast()` from server code, `useBroadcast` / `useRealtimePresence` hooks. [Realtime](/docs/backend#supabase-realtime-supabasechannel)                                                                                 |
| Edge Functions                                                                                 | `backend({ functions })`: `functions/<name>/index.ts` served at `/functions/v1/<name>`, each in a worker of its own, `verify_jwt` on by default. Or route handlers. [Edge Functions](/docs/backend#edge-functions)                                                                                                                                                                                                                                    |
| `supabase.functions.invoke()`, generated types                                                 | `functions.invoke` calls `/functions/v1/<name>` as on Supabase; for route handlers, `createApiClient()` / `useApi()`. [Typed API](/docs/typed-api)                                                                                                                                                                                                                                                                                                    |
| Database webhooks                                                                              | `supabase_functions.http_request` triggers, delivered by the app (signed, retried) to the hooks you configure; or `onTableChange(table, fn)` on the server. [Database webhooks](/docs/backend#database-webhooks)                                                                                                                                                                                                                                      |
| `pg_cron`, scheduled functions                                                                 | `defineJob` in `jobs/` with a cron `schedule`. [Scheduled jobs](/docs/jobs)                                                                                                                                                                                                                                                                                                                                                                           |
| Queues (pgmq), `pgmq_public`                                                                   | The same SQL API without the extension, `queue()` / `queueConsumer()` on the server. [Queues](/docs/backend#queues)                                                                                                                                                                                                                                                                                                                                   |
| pgvector, `match_documents`                                                                    | The same extension and recipe: `denext generate vector-search <table>`, `matchDocuments()`. [Vector search](/docs/backend#vector-search-pgvector)                                                                                                                                                                                                                                                                                                     |
| The Supabase CLI (`migration`, `db`, `inspect db`, `test db`, `gen types`)                     | `denext migration …` and `denext db …`: the same verbs, the same `supabase/migrations/` and the same history table. See [the CLI table](#supabase-cli--denext).                                                                                                                                                                                                                                                                                       |
| Studio (table editor, SQL editor, policies, storage, users, realtime, functions, logs, health) | The Database section of `denext ui`: tables and rows, a SQL editor, policies with an "as user" preview, migrations, storage, auth users, realtime (publication opt-in, live channels, presence keys), Edge Functions with recent invocations, logs and health. For the self-hosted stack the same pages are its `dashboard` service, behind `DASHBOARD_PASSWORD`. [`denext ui`](/docs/ui#database), [the stack dashboard](/docs/deploy#the-dashboard) |
| Vault, project secrets                                                                         | `vault` from `@denext/backend/server` (AES-256-GCM under `DENEXT_VAULT_KEY`, same table shape); with `vault: { sql: true }` also `vault.create_secret()` and `vault.decrypted_secrets` in SQL. [Vault](/docs/backend#vault)                                                                                                                                                                                                                           |

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
`denextAuth({ … })`; auth mail goes through your `sendVerificationRequest` — `smtpMailer({ host,
user, pass, from })` is one. See [Auth](/docs/auth).

Or keep your client code: with `backend({ supabase })` the stock supabase-js `supabase.auth.*` calls
above work unchanged against `/auth/v1` — password, OTP / magic link, phone, anonymous, OAuth with
your `denextAuth()` providers or stored `custom:` providers, Web3 (`signInWithWeb3`), MFA, SAML SSO
(with Single Logout, encrypted assertions and the `admin/sso/providers` API), the OAuth 2.1 server
(`supabase.auth.oauth.*`, `admin.oauth.*`) and the admin API — over the same users the cookie
sign-in uses. The client's own session machinery works too: `getClaims()` (verified against the
app's JWKS), `onAuthStateChange`, `refreshSession()` / `setSession()`, the PKCE flow
(`flowType: "pkce"`) and `admin.listUsers()` paging. See
[Supabase clients](/docs/auth#supabase-clients-authv1).

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
request's role. Or write a bucket's rules as a function in `denext.config.ts`. Outside a request (a
job, a script) there is no session to pass it, so code there uses
`storage.bucket("invoices", { service: true })` — the counterpart of Supabase's service-role key
(over HTTP, the secret key from `backend({ supabase })`). The Supabase pattern of one folder per
user, in TypeScript:

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
private channels authorized by your `realtime.messages` policies, broadcast replay — and tables
opt in the Supabase way, with `alter publication supabase_realtime add table notes` (or by
`realtime({ tables })`).

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
   `auth`, `realtime` and `extensions` schemas out — users move separately, below. Include
   `--schema=storage` when you will keep Supabase's storage policies (`storage: { rls: true }`):
   the object and bucket rows and the policies come along, and the files are copied separately
   ([Moving files](#moving-files)).
2. **Point `DATABASE_URL` at the new Postgres** and add `backend({ postgres: {} })`. The app's
   database user needs `CREATEROLE` so the first scoped query can create `anon`, `authenticated`
   and the `auth.*` functions; where it may not, have an administrator run `rlsSetupSql("app_user")`
   (from `@denext/backend`) and set `backend({ postgres: { rls: { migrate: false } } })`.
3. **Create the roles and `auth.*` functions before restoring**, since your policies reference
   them: run the `rlsSetupSql` output with `psql`, or start the app once and make one `db()` query.
   If the dump grants to `service_role` or other Supabase-only roles, either
   `create role service_role nologin` first or delete those `grant` lines; drop or rewrite any
   foreign key that references `auth.users` (point it at `auth_users(id)` once auth's tables
   exist, step 5).
4. **Restore** `schema.sql` then `data.sql` with `psql`. From here on, write each schema change
   with `denext generate migration <name>` and apply it with `denext migration up` (which also
   applies the backend's and denext's own schemas); `denext job migrate` runs the same files from
   the generated job.
5. **Apply denext's own migrations.** `denext db push` (or `denext migration up`) applies them out
   of band: the backend's (the RLS setup, the storage, realtime, vault, queues and webhooks schemas,
   recorded in `backend_migrations`) and denext's own stores' (auth's `auth_*` tables, recorded in
   `auth_migrations`), then yours, then realtime's per-table triggers. Otherwise they run on first
   use, under the migration lock. If the app's user should not run DDL, apply them from a deploy
   step and set [`DENEXT_BOOT_DDL=off`](/docs/database#schema-at-startup): the server then creates
   nothing and refuses to start until every migration it needs is recorded. Policies you wrote on
   `realtime.messages` (private channels) are in the `realtime` schema you left out: re-create them
   once the realtime migration has made the table.
6. **Move the users** — see [Moving users](#moving-users).
7. **Copy the storage objects** — see [Moving files](#moving-files).
8. **Swap the environment.** Supabase's `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
   replaced by the app's own keys: `DENEXT_PUBLISHABLE_KEY` (what a supabase-js client is created
   with), `DENEXT_SECRET_KEY` (the `service_role`, server-side only) and
   `DENEXT_JWT_SIGNING_KEYS` — `denext backend keys` prints a fresh set (`--legacy` adds
   `DENEXT_JWT_SECRET` and the legacy JWT keys). `SUPABASE_URL` becomes the app's own origin. You
   also set `DATABASE_URL`, the `secret` you pass `denextAuth` (say `AUTH_SECRET`),
   `DENEXT_STORAGE_SECRET` (at least 32 characters), `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY` for an S3 driver, each OAuth provider's client id and secret, and
   whatever your mailer needs.
9. **Re-register OAuth redirect URLs** with each provider: the callback is now your app's
   `/auth/callback/<provider>` (under denext auth's `basePath`, default `/auth`), not Supabase's.
10. **Point the clients at the app.** Keep supabase-js, created with the app's origin and
    `DENEXT_PUBLISHABLE_KEY` (`createClient(appUrl, publishableKey)`), or move calls to the
    denext-native APIs in the side-by-side snippets above (Server Components, Server Actions,
    route handlers, `useApi`) where you prefer.

### Moving users

What moves:

- **Users, with their ids.** `createUser` takes an `id`, so each Supabase user keeps their UUID
  and every `owner = auth.uid()` row stays theirs. Copy `email`, `email_confirmed_at` (as epoch
  seconds in `emailVerified`) and the name and avatar from `raw_user_meta_data`.
- **OAuth and Web3 links.** Each `auth.identities` row with an OAuth provider becomes
  `linkAccount({ userId, provider, providerAccountId: provider_id })`, so the next GitHub or
  Google sign-in finds the same user. Use the same provider id denext uses (`github`, `google`,
  …). A `web3` identity carries over the same way (`provider: "web3"`, its
  `web3:<chain>:<address>` id unchanged), so `signInWithWeb3` finds the same user.
- **Phone and anonymous users.** Copy `phone` and `phone_confirmed_at` (as epoch seconds in
  `phoneVerified`) for a phone user, and `is_anonymous` as `isAnonymous: true`: phone sign-in
  (`phoneOtp()`, or `/auth/v1`'s `signInWithOtp({ phone })`) and an anonymous user's later
  conversion work as before.
- **Phone MFA factors.** A verified `phone` row of `auth.mfa_factors` holds only the number, so it
  can be re-created with `createMfaFactor({ id, userId, type: "phone", status: "verified", phone,
  … })` in the [one factor store](/docs/auth#one-factor-store-for-both-sign-in-paths) both sign-in
  paths share.
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
- **TOTP factors.** Supabase documents no supported way to export TOTP secrets, so plan for these
  users to enroll again (through `/mfa/enroll` or `supabase.auth.mfa.enroll()` — one store, either
  path). Until they do, they sign in without a second factor, so a policy that requires `aal2`
  should give them a way to enroll first.
- **WebAuthn factors and passkeys.** A credential is bound to the relying-party domain it was
  made for, and Supabase's public keys are not portable to another relying party: users
  register again.
- **SAML SSO providers.** Under `backend({ supabase })` `/auth/v1` serves SAML SSO: register each
  identity provider again with `POST /auth/v1/admin/sso/providers` (`supabase.auth.admin.sso`).
  As in Supabase, an SSO sign-in never takes over an existing account by email, so carry the SSO
  identities over: in the import below, write each `sso:<old provider id>` identity as
  `sso:<new provider id>` and those users sign in to their own accounts.
- **OAuth 2.1 server clients.** Supabase's OAuth server schema stores a hash of each client secret
  (`client_secret_hash`), so the secrets cannot be carried over; register the clients again
  (`supabase.auth.admin.oauth.createClient()`, or `POST /auth/v1/admin/oauth/clients`) and hand them
  their new credentials; their users approve again.
- **Denext's own (cookie) sign-in has no SAML.** SAML users sign in through `/auth/v1`
  (`supabase.auth.signInWithSSO`); the session is the same user `auth()` reads.

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
the app, Postgres 17 (or `--pgvector`'s `pgvector/pgvector:pg17`), MinIO with its bucket created by
a one-shot `mc` service, a one-shot `denext migration up` (the backend's own roles and schemas, then
your migrations) before the app starts, and a `dashboard` service — with health checks and
`depends_on` conditions throughout, named volumes, and a `.env.example` listing every secret (the
role of Supabase's `.env` with its JWT secret and keys).

```sh
denext generate docker --stack
cp .env.example .env    # generate each secret as the file says
docker compose up -d --build
```

There is no Kong gateway or analytics container: the app itself serves the APIs. Studio's place is
taken by the stack's `dashboard` service ([`denext dashboard`](/docs/deploy#the-dashboard)),
published on `127.0.0.1:3100` behind `DASHBOARD_PASSWORD`; `--dashboard-logs` adds the relay its
Logs page reads. On your machine, [`denext ui`](/docs/ui#database) has the same pages.
[Deployment › Self-hosted stack](/docs/deploy#self-hosted-stack-postgres-storage-migrations) has the
flags and the services.

## Supabase CLI → denext

| Supabase CLI                                               | denext                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supabase migration new <name>`                            | `denext migration new <name>` (`--stdin` takes the SQL from a pipe)                                                                                                            |
| `supabase migration list`                                  | `denext migration list` / `denext db status` (`--json`)                                                                                                                        |
| `supabase migration up`                                    | `denext migration up` / `denext db migrate` (`--include-all`, `--to <version>`)                                                                                                |
| `supabase migration down [--last n]`                       | `denext migration down` / `denext db rollback` (`--steps n` / `--last n`, `--to`). The down scripts run; `--force-reset --yes` resets and re-applies instead, as Supabase does |
| `supabase migration repair --status applied\|reverted <v>` | `denext migration repair --status applied\|reverted <v…>`                                                                                                                      |
| `supabase migration squash`                                | `denext migration squash [--version v]` (`--linked` / `--db-url` also rewrite that database's history)                                                                         |
| `supabase migration fetch`                                 | `denext migration fetch`                                                                                                                                                       |
| `supabase db push [--include-seed] [--dry-run]`            | `denext db push [--include-seed] [--dry-run]` (denext's own schemas first, then yours)                                                                                         |
| `supabase db pull`                                         | `denext db pull [name]`                                                                                                                                                        |
| `supabase db reset`                                        | `denext db reset --yes`                                                                                                                                                        |
| `supabase db diff`                                         | `denext db diff [--file name]`                                                                                                                                                 |
| `supabase db dump`                                         | `denext db dump`                                                                                                                                                               |
| `supabase db lint`                                         | `denext db lint` (plpgsql_check when installed, plus built-in RLS, `search_path` and grant checks)                                                                             |
| `supabase seed buckets`, `seed.sql`                        | `denext db seed`                                                                                                                                                               |
| `supabase inspect db <report>`                             | `denext db inspect <report>` (`report` runs them all)                                                                                                                          |
| `supabase test db`                                         | `denext db test` (pgTAP, `supabase/tests/`)                                                                                                                                    |
| `supabase gen types typescript`                            | `denext gen types` (= `denext db types`; `--schema`, `--file`)                                                                                                                 |
| `supabase gen keys` / `gen signing-key`                    | `denext gen keys` (= `denext backend keys`)                                                                                                                                    |
| `supabase gen bearer-jwt`                                  | `denext gen bearer-jwt` (= `denext backend token --role … --sub …`)                                                                                                            |
| `supabase functions new` / `list` / `serve` / `delete`     | `denext functions new` / `list` / `serve` / `delete --yes`                                                                                                                     |
| `supabase functions download` / `deploy`                   | Nothing to do: the functions ship inside the app (`denext build`)                                                                                                              |
| `supabase storage ls` / `cp` / `mv` / `rm`                 | `denext storage ls` / `cp` / `mv` / `rm` (`ss:///bucket/key` paths, `-r`)                                                                                                      |
| `supabase link`                                            | `denext db link --url <postgres-url>`, then `--linked` on any verb                                                                                                             |
| `supabase secrets set / list / unset`                      | `.env` (or your host's environment), or the [vault](/docs/backend#vault)                                                                                                       |
| `supabase start` / `stop` / `status`                       | `denext stack up` / `down` / `status` (and `logs`, `health`, `passwd`, `roll`) over the stack `denext generate docker` writes                                                  |
| Backing up a self-hosted stack (database + storage)        | `denext stack backup [--full]` / `denext stack restore` ([Operating the stack](/docs/deploy#operating-the-stack))                                                              |

Every database verb works on the project's own database by default. `--db-url <url>` or `--linked`
points it at another one. A project that keeps its files in `supabase/migrations/` keeps the
Supabase CLI's history table (`supabase_migrations.schema_migrations`), so you can switch between
the two CLIs in either direction.

**No denext equivalent:** `login`, `projects`, `orgs`, `branches`, `domains`, `vanity-subdomains`,
`sso`, `network-bans` / `network-restrictions`, `ssl-enforcement`, `postgres-config`, `backups`,
`snippets` and `services`. These manage Supabase's hosted platform. denext has none: your Postgres
provider and your host do that work.

## What is missing

denext covers the app-backend half of Supabase; some of the platform is not there:

- **Auto-REST defaults differ in three places.** A `PATCH` or `DELETE` needs a filter (as on
  Supabase, where `safeupdate` refuses one without); `count: "exact"` is for signed-in users unless
  `rest.exactCount` allows it; and aggregates (`rest.aggregates`) and execution plans
  (`rest.explain`) are off until you turn them on, as PostgREST ships them.
- **No hosted dashboard.** `denext ui` runs on your machine, on loopback; a deployed stack's
  `dashboard` service is yours to run and to put behind a TLS proxy. Its Logs page searches the
  stack's container logs; there is no logs explorer across deployments and no usage metrics.
- **Not hosted at all.** Backups, point-in-time recovery, connection pooling and database upgrades
  are your Postgres provider's job.
- **No built-in SMS sender, and no hosted mail service.** `/auth/v1` mails through the `sendEmail`
  hook, your `sendVerificationRequest`, or your SMTP server (`GOTRUE_SMTP_*`, TLS required), and
  texts through your `sendSms`. Mail templates take GoTrue's simple placeholders, not every Go
  template action.
- **Realtime: a row is re-read per subscriber.** Each change is re-read under the subscriber's
  policies (never carried past them), so a row inserted and deleted within one 16 ms burst reaches
  no one, and `new` is the row as it is after the burst. The default notify source serializes
  committing writers (`source: "logical"` does not, and needs `wal_level = logical`); under it a
  full old row is carried only when it fits a notification (about 7.5 KB of JSON).
- **Types for the REST client.** `.denext/rest.ts` is `supabase gen types`-shaped (tables, views,
  functions, enums and relationships of the exposed schemas) and types `createClient<Database>()`
  and denext's `from()`; `db()`'s tagged SQL is untyped, so for server queries use an ORM such as
  [Drizzle](/docs/database#orms) or write the row types.
- **Vault's SQL needs the app.** `vault.create_secret()` and `vault.decrypted_secrets` work
  (`vault: { sql: true }`) only inside transactions the app opens with the key — `vault.withKey()`
  and `denext db push` — because the key is never stored in the database; a `pg_cron` job or a
  `psql` session cannot read secrets on its own. App-side reads (`vault.get()`) need no SQL mode.
- **No extensions catalogue.** The Postgres extensions you have (pgvector, say) are the ones your
  provider installs; queues and webhooks need none.
