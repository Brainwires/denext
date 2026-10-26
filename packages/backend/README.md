# @denext/backend

**Backend services inside your [denext](https://denext.dev) app**, as one opt-in plugin: no hosted
service, nothing to run beside it. It ships **storage** — buckets declared in config or created at
runtime, per-bucket rules in TypeScript or SQL row-level security, signed upload and download URLs,
multipart and TUS resumable uploads, image transforms, and Supabase's Storage API at
`/storage/v1` (so `supabase.storage` from `@supabase/supabase-js` works unchanged) — on S3 (AWS,
Cloudflare R2, MinIO) or the local filesystem, with zero npm;
and **Postgres** — one client for your server code (`db()`) and for denext auth
(`backendAuthAdapter()`).

```ts
// denext.config.ts
import { backend, fs, s3 } from "@denext/backend";

export default {
  plugins: [
    backend({
      storage: {
        driver: Deno.env.get("S3_BUCKET")
          ? s3({ region: "us-east-1", bucket: Deno.env.get("S3_BUCKET")! })
          : fs({ dir: ".storage" }),
        buckets: {
          avatars: {
            public: true,
            maxBytes: 2 * 1024 * 1024,
            mime: ["image/png", "image/jpeg", "image/webp"],
            authorize: ({ session, op, key }) =>
              op === "upload" && !!session && key.startsWith(`${session.user.id}/`),
          },
        },
      },
    }),
  ],
};
```

## Install

```sh
denext plugin add @denext/backend
```

Or by hand: add `"@denext/backend": "jsr:@denext/backend@^0.6.0"` to `deno.json`'s `imports` and
the plugin to `denext.config.ts` as above. Set `DENEXT_STORAGE_SECRET` (at least 32 characters):
it signs the plugin's URLs and upload tokens.

## Server

```ts
import { storage } from "@denext/backend/server";

const avatars = storage.bucket("avatars"); // authorize runs with the current request's session
const upload = await avatars.createSignedUploadUrl("u1/me.png", { contentType: "image/png" });
const thumb = await avatars.createSignedUrl("u1/me.png", { transform: { width: 128 } });
await avatars.upload("u1/generated.png", bytes);
const page = await avatars.list("u1/", { limit: 50 });
await avatars.remove(["u1/old.png"]);
```

## Browser

```ts
import { getFileUrl, uploadFile } from "@denext/backend/client";

const { key } = await uploadFile("avatars", file, {
  key: `${userId}/me.png`,
  onProgress: ({ loaded, total }) => console.log(loaded / total),
});
const src = await getFileUrl("avatars", key, { transform: { width: 256 } });
```

## Postgres

```ts
// denext.config.ts
import { denextAuth, github } from "denext/server";
import { backend, backendAuthAdapter } from "@denext/backend";

export default {
  plugins: [
    backend({ postgres: { url: Deno.env.get("DATABASE_URL") } }),
    denextAuth({ providers: [github()], adapter: backendAuthAdapter() }),
  ],
};
```

```ts
import { db } from "@denext/backend/server";

const posts = await db()`SELECT id, title FROM posts WHERE author = ${userId}`; // bound, not spliced
```

The client is `Deno.SQL`, built into denext's Deno runtime. Where it is missing (Deno Deploy) pass your own:
`backend({ postgres: { sql: fromPostgresJs(postgres(url)) } })` with the npm `postgres` package
(`fromPostgresJs` is in `denext/server`). Behind a transaction-mode pooler, set
`postgres.directUrl` (default `DATABASE_DIRECT_URL`): LISTEN, reserved connections and migrations
use the direct connection, queries the pooler. Guide:
[Backend › Postgres](https://denext.dev/docs/backend#postgres).

**Row-level security, Supabase-compatible.** `db()` runs each query as the request's user: a
transaction that sets the role (`authenticated`, or `anon` when signed out or outside a request)
and `request.jwt.claims` transaction-locally, so policies written with Supabase's `auth.uid()`,
`auth.role()`, `auth.email()` and `auth.jwt()` apply unchanged. The roles and functions are created
by a migration on first use (or by a DBA with `rlsSetupSql(role)` and
`postgres: { rls: { migrate: false } }`).
`db()` reads the identity at each query, so a module-level client is fine.
`db({ as: user })` acts for a user outside a request; `db.service()` bypasses RLS entirely — the
app's own database user, for maintenance code only. Guide:
[Backend › Row-level security](https://denext.dev/docs/backend#row-level-security).

**Realtime from the database.** `backend({ postgres: {}, realtime: realtime({ tables: { notes: {} } }) })`
adds triggers that NOTIFY the changed row's key; `useTableChanges("notes", { initial })` from
`@denext/backend/client` keeps a row list live, every row re-read as the viewer under their
row-level security, so a change reaches only the subscribers whose policies return it.
`onTableChange` and `tableChanges` from `@denext/backend/server` react on the server. The same
option serves Supabase Realtime at `/realtime/v1` — `supabase.channel()` with `postgres_changes`,
broadcast and presence, private channels authorized by `realtime.messages` policies — and
`source: "logical"` reads changes from logical replication instead of triggers. Guide:
[Backend › Realtime from the database](https://denext.dev/docs/backend#realtime-from-the-database).

**Auto-REST.** `backend({ postgres: {}, rest: {} })` serves the schema's tables (those the `anon` /
`authenticated` roles were granted and that enforce row-level security — RLS-enabled tables and
`security_invoker` views; others only when named in `rest.tables`) in PostgREST 12's wire format
under `/rest/v1`: embedded resources, `or` / `and` trees, every operator, aliases, casts and JSON
paths, upserts, `/rpc/<function>`, CSV, counts and PostgREST's OpenAPI document — every statement
run through `db()`, so row-level security applies, and `supabase.from()` / `rpc()` work
unchanged. Each client has a request budget (`rest.rateLimit`, default 1200 a minute; `false` turns
it off): past it, `429` `over_request_rate_limit` with `Retry-After`. `from("notes").select("id,body").eq("id", 1)`
from `@denext/backend/client` builds the requests, typed by the generated `.denext/rest.ts`. Guide:
[Backend › Auto-REST](https://denext.dev/docs/backend#auto-rest).

## Supabase compatibility and the other services

`backend({ supabase: true })` installs Supabase-style API keys (`DENEXT_PUBLISHABLE_KEY`,
`DENEXT_SECRET_KEY` — the `service_role`, server-side only — and ES256 `DENEXT_JWT_SIGNING_KEYS`;
`denext backend keys` mints them) and serves GoTrue's `/auth/v1` over the `denextAuth()` users, so
the stock `@supabase/supabase-js` client works against the app for auth, REST, storage, realtime
and functions. Each service is its own option:

- **Edge Functions** (`functions: {}`): `functions/<name>.ts` (or `functions/<name>/index.ts`) at
  `/functions/v1/<name>`, each in a Deno Worker of its own, for `supabase.functions.invoke`.
- **Vault** (`vault: {}`): AES-256-GCM secrets in `vault.secrets` under `DENEXT_VAULT_KEY`.
- **Queues** (`queues: {}`): pgmq's SQL API without the extension.
- **Vector search**: `vectorSearchSql()` / `matchDocuments()` over pgvector.
- **Database webhooks** (`webhooks`): signed, retried deliveries of table changes; settled events
  are deleted after `webhooks.retention` (delivered: 7 days, failed: 30).
- **An admin endpoint** (`/_denext/backend/admin/*`, `GET` with the secret key only) that
  `denext ui` and the stack's dashboard read: realtime channels and presence, Edge Function
  invocations, the `services/` supervision tree.

`denext db` (migrations, `diff`, `dump`, `pull`, `lint`, `inspect`, `test`, `types`), `denext
storage`, `denext functions` and `denext backend keys | token` cover the Supabase CLI's ground.
Guides: [Backend](https://denext.dev/docs/backend) ·
[Coming from Supabase](https://denext.dev/docs/coming-from-supabase).

## What it enforces

- **`authorize`** decides every operation (`upload`, `download`, `delete`, `list`) made inside a
  request, with `auth()`'s session; without one, everything but a public bucket's downloads is
  denied. Outside a request (jobs, scripts) there is no session, so only a service handle
  (`storage.bucket(name, { service: true })`) or a public bucket's download works.
- **Size, type and content**: `maxBytes` and the `mime` allow-list are checked when an upload is
  signed and again on the bytes; a declared image must start with that format's magic bytes.
- **Keys** cannot leave their bucket: no `..`, empty segments, control characters or backslashes.
- **Signed URLs** are HMAC-SHA256 over every parameter (method, bucket, key, expiry, type, size,
  transform), verified in constant time; S3 URLs are SigV4-presigned and pin type and size.
- **Uploads go through `POST /_denext/storage/sign`**, which refuses cross-site requests that carry
  cookies (denext's `csrf()` rule) and validates its body.
- Objects served from the app's origin carry `nosniff` and a sandboxing CSP.
- **The Storage API (`/storage/v1`) and TUS uploads** enforce the same rules: the secret key
  (`backend({ supabase })`'s) is the only way to the service role; with `storage: { rls: true }` every
  operation runs as the request's role so the policies on `storage.objects` / `storage.buckets`
  decide; the size cap, allow-list and sniffing apply to signed and resumable uploads too.

Full guide: [denext.dev/docs/backend](https://denext.dev/docs/backend).
