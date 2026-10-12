---
title: Backend
slug: backend
lead: "@denext/backend puts backend services inside your app as one opt-in plugin: no hosted service, nothing to run beside it. It ships storage — buckets with per-bucket rules, signed upload and download URLs, multipart uploads, image transforms on download and access checks tied to the request's session, on S3 (AWS, Cloudflare R2, MinIO) or the local filesystem — Postgres for your server code and for auth, scoped by row-level security, realtime changes from your tables, and an optional REST API over them, with zero npm."
---

```sh
denext plugin add @denext/backend
```

Or by hand: add `"@denext/backend": "jsr:@denext/backend@^0.1.0"` to `deno.json`'s `imports`,
then the plugin to `denext.config.ts`.

Moving a project from Supabase? [Coming from Supabase](/docs/coming-from-supabase) maps each
Supabase feature to its denext equivalent and walks through moving the schema, policies, users and
files.

## Storage

### Configure buckets

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
            public: true, // anyone may download; uploads still need authorize
            maxBytes: 2 * 1024 * 1024,
            mime: ["image/png", "image/jpeg", "image/webp"],
            authorize: ({ session, op, key }) =>
              op === "upload" && !!session && key.startsWith(`${session.user.id}/`),
          },
          invoices: {
            mime: ["application/pdf"],
            authorize: ({ session, op, key }) =>
              !!session && op !== "delete" && key.startsWith(`${session.user.id}/`),
          },
        },
      },
    }),
  ],
};
```

A bucket name is lowercase letters, digits, `-` and `_`. Each bucket takes:

| Field       | Default | What it does                                                                                                                                                                             |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public`    | `false` | Downloads need no signature and no `authorize` call; their URLs are stable and cacheable. Uploads, deletes and listings still go through `authorize`.                                    |
| `maxBytes`  | 50 MiB  | The largest object accepted. Checked when an upload is signed, on the declared length, and on the bytes as they stream.                                                                  |
| `mime`      | any     | Allowed content types, exact (`application/pdf`) or `type/*`. A declared raster image (PNG, JPEG, GIF, WebP, AVIF, HEIC, BMP, ICO, TIFF) must also start with that format's magic bytes. |
| `authorize` | deny    | `({ session, op, key, bucket, request }) => boolean`. Only `true` allows. With no `authorize`, every operation is denied except downloads from a public bucket.                          |

`op` is `"upload"`, `"download"`, `"delete"` or `"list"` (for a listing, `key` is the prefix).
`session` is `auth()` from [`denextAuth`](/docs/auth) — `null` when signed out or when the app has
no auth.

**When `authorize` runs.** On every storage call made inside a request: the plugin's own endpoints,
and the server API called from a route handler, Server Action or Server Component, with that
request's session. A call outside any request (a [task](/docs/tasks), a script) is trusted and skips
it. To act as the server inside a request (a webhook, an admin action), take a service handle:
`storage.bucket("invoices", { service: true })` skips `authorize`; the size cap, allow-list and
sniffing still apply.

**The signing secret.** The plugin signs its own URLs and upload tokens with HMAC-SHA256. Set
`DENEXT_STORAGE_SECRET` (at least 32 characters) or `storage.secret`; pass a list, current first,
to rotate one out. `denext dev` falls back to a random secret per run, so links stop working on
restart. In production a missing secret is an error the first time a URL is signed.

### Drivers

**`s3({ region, bucket, endpoint?, credentials?, pathStyle? })`** talks to AWS S3, Cloudflare R2,
MinIO and other S3-compatible stores over `fetch`, with AWS Signature Version 4 computed by
`crypto.subtle` (no SDK). Every denext bucket is a key prefix in the one S3 bucket:
`avatars/u1/me.png`. Credentials default to `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
`AWS_SESSION_TOKEN`; the endpoint defaults to AWS, or `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL`.
AWS is addressed virtual-host style, a custom `endpoint` path style; `pathStyle` overrides either.

| Store         | Options                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| AWS S3        | `s3({ region: "eu-west-1", bucket: "my-app" })`                                     |
| Cloudflare R2 | `s3({ region: "auto", bucket, endpoint: "https://<id>.r2.cloudflarestorage.com" })` |
| MinIO         | `s3({ region: "us-east-1", bucket, endpoint: "http://127.0.0.1:9000" })`            |

Browsers upload to and download from the store directly with presigned URLs, so the bucket's CORS
rules must allow your app's origin to `GET` and `PUT`, and must expose the `ETag` header (a
multipart upload reads it).

**`fs({ dir })`** stores objects as files under `dir` (relative to the project root), for
development and single-server self-hosting. Uploads and downloads go through the plugin's own
endpoint with signed, expiring URLs; downloads answer `Range` requests. Writes land in a temporary
file and are renamed into place, so a refused upload leaves nothing behind.

### Server API

```ts
// app/api/invoice/route.ts
import { storage } from "@denext/backend/server";

export async function POST(request: Request): Promise<Response> {
  const invoices = storage.bucket("invoices"); // authorize runs with this request's session
  const upload = await invoices.createSignedUploadUrl("u1/2026-10.pdf", {
    contentType: "application/pdf",
    expiresIn: 600,
  });
  return Response.json(upload); // { key, method, url, headers, token, expiresAt }
}
```

| Method                                                                      | What it does                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createSignedUploadUrl(key, { contentType, expiresIn?, maxBytes?, size? })` | A URL to `PUT` the bytes to (default 15 minutes). `size` pins the exact length; on S3 the URL also pins `content-type`. Send `token` to complete it (below). |
| `createSignedUrl(key, { expiresIn?, transform? })`                          | A download URL: signed and expiring (default 1 hour), or the stable URL of a public bucket.                                                                  |
| `upload(key, body, { contentType? })`                                       | Store bytes from the server (`Uint8Array`, `Blob`, string or stream). The type defaults to the sniffed one. Large streams go multipart on S3.                |
| `download(key)`                                                             | `{ body, size, contentType, etag, lastModified }`, or `null`.                                                                                                |
| `head(key)`                                                                 | The object's info, or `null`.                                                                                                                                |
| `list(prefix?, { limit?, cursor? })`                                        | A page of `{ objects, cursor? }` in key order (at most 1000); pass `cursor` back for the next.                                                               |
| `remove(keys)`                                                              | Delete one key or a list (a missing key is not an error).                                                                                                    |

Keys are `/`-separated paths with no empty, `.` or `..` segment, no control character or
backslash, at most 1024 bytes; a key that is not already in that form is refused, never rewritten.
Failures are a `StorageError` with a `code` (`forbidden`, `too_large`, `mime_not_allowed`,
`mime_mismatch`, `invalid_key`, `unknown_bucket`, …) and the HTTP `status` the plugin answers with.

### Upload from the browser

```tsx
"use client";
import { getFileUrl, uploadFile } from "@denext/backend/client";

export function AvatarPicker({ userId }: { userId: string }) {
  async function onChange(event: { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files![0];
    const { key } = await uploadFile("avatars", file, {
      key: `${userId}/avatar.png`,
      onProgress: ({ loaded, total }) => console.log(Math.round((loaded / total) * 100)),
    });
    const src = await getFileUrl("avatars", key, { transform: { width: 128 } });
  }
  return <input type="file" accept="image/*" onChange={onChange} />;
}
```

`uploadFile(bucket, file, { key?, contentType?, onProgress?, signal?, concurrency? })` asks the
server to sign the upload, sends the bytes with `XMLHttpRequest` (for progress), then asks the
server to verify what arrived. With no `key`, a random id plus the file's extension is used. Above
`storage.multipartThreshold` (default 64 MiB) on S3, the file goes up in parts of
`storage.partSize` (default 16 MiB), several at once; a failed or cancelled upload is aborted on
the store. `getFileUrl(bucket, key, { transform?, expiresIn? })` returns a display or download URL.

Both call `POST /_denext/storage/sign` with the page's cookies. That endpoint applies the same rule
as [`csrf()`](/docs/typed-api): a request that carries cookies must come from the app's own origin
(or `allowedOrigins`), so another site cannot make a signed-in visitor's browser sign uploads. Its
body is validated before anything runs.

**What the server checks at completion.** On the filesystem driver the bytes pass through the
plugin, which enforces the size cap and the declared length while streaming and sniffs the first
bytes before anything is stored. On S3 the bytes go to the store directly, so completion checks
what arrived: the size against the cap and the declared length, the stored content type, and the
first bytes against the declared type. An object that fails is deleted.

### Image transforms

```ts
await storage.bucket("avatars").createSignedUrl("u1/me.png", {
  transform: { width: 256, height: 256, quality: 75, format: "webp" },
});
// public bucket: /_denext/storage/o/avatars/u1/me.png?w=256&h=256&q=75&fmt=webp
```

A PNG, JPEG, GIF or WebP object is resized to fit inside the box (aspect ratio kept, never
enlarged) and re-encoded through denext's [image pipeline](/docs/images), with its output cache,
concurrency limit and decompression-bomb checks. `width` and `height` must each be one of
`images.deviceSizes ∪ images.imageSizes`, `quality` is rounded to the nearest of
`images.qualities`, and `format: "avif"` needs `images.formats` to list `image/avif` — so the number
of distinct encodes per object stays bounded. Sources over 25 MiB are not transformed. On a private
bucket the transform is part of the signature; on a public one anyone may ask for any allowed size.

### Endpoints

The plugin answers under `/_denext/storage/` (after `basePath`); an app route never collides with
it.

| Endpoint                                       | Purpose                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /_denext/storage/sign`                   | `{ op: "upload" \| "complete" \| "abort" \| "download", … }` from the client helpers. |
| `GET`/`HEAD /_denext/storage/o/<bucket>/<key>` | Download: a public object, or a signed URL. `Range`, `If-None-Match` and transforms.  |
| `PUT`/`POST /_denext/storage/o/<bucket>/<key>` | Upload through a signed URL (filesystem driver).                                      |

Objects served from your app's origin carry `X-Content-Type-Options: nosniff` and a sandboxing
`Content-Security-Policy`, and anything but images, audio, video, PDF and plain text downloads as an
attachment — an uploaded HTML or SVG file never runs script as your app. A public object on S3 is a
redirect to a presigned URL that lives five minutes.

### Try it

[`examples/backend-storage`](https://github.com/Brainwires/denext/tree/main/examples/backend-storage)
is a gallery in a public bucket and documents in a private one, on the filesystem or on S3 from the
environment.

## Postgres

`backend({ postgres })` opens one Postgres client for the whole app. Server code gets it from
`db()`; denext auth puts its tables on it with `backendAuthAdapter()`.

```ts
// denext.config.ts
import { denextAuth, github } from "denext/server";
import { backend, backendAuthAdapter } from "@denext/backend";

export default {
  plugins: [
    backend({ postgres: { url: Deno.env.get("DATABASE_URL") } }), // `{}` reads DATABASE_URL too
    denextAuth({ providers: [github()], adapter: backendAuthAdapter() }),
  ],
};
```

```ts
// app/api/posts/route.ts
import { db } from "@denext/backend/server";

export async function GET(): Promise<Response> {
  const posts = await db()`SELECT id, title FROM posts ORDER BY id DESC LIMIT ${20}`;
  return Response.json(posts);
}
```

`db()` is a tagged-template query function: every interpolated value is a bound parameter, never
text spliced into the query. It also has `unsafe(text, params)` and `begin(async (tx) => …)` for a
transaction. Every query it runs is scoped by [row-level security](#row-level-security) to the
request's user; `db.service()` is the unscoped connection.

The client is `Deno.SQL`, the Postgres client built into denext's Deno runtime, opened at startup
and closed when the server drains. On stock Deno there is none: the app still builds and starts,
and `db()` throws an error with `code: "unsupported"` that says so. Pass a client of your own as
`postgres: { sql }` instead — the npm `postgres` package through `fromPostgresJs` from
`denext/server` works on any Deno; a client you pass is never closed by the plugin.

`backendAuthAdapter({ schema?, migrate? })` is `postgresAuthAdapter` on that client (see
[Auth › Postgres](/docs/auth#postgres)): its `auth_*` tables are created by migrations on first
use. Your own tables come from `denext generate migration <name>` and `denext task migrate`
([Databases › Postgres migrations](/docs/database#plain-sql-files-on-postgres)).

## Row-level security

`db()` runs every query as the request's user, so the database itself decides which rows that user
can read and write. It works the way Supabase does — the same roles, the same `auth.*` functions,
the same claims — so the policies you write (or bring from Supabase) look like this:

```sql
-- migrations/20261011_notes.sql
create table notes (id bigserial primary key, owner uuid not null, body text not null);
alter table notes enable row level security;
create policy "read own notes" on notes for select using (auth.uid() = owner);
create policy "write own notes" on notes for insert with check (auth.uid() = owner);
grant select, insert on notes to authenticated;
grant usage on sequence notes_id_seq to authenticated;
```

```ts
// app/api/notes/route.ts
import { db } from "@denext/backend/server";

export async function GET(): Promise<Response> {
  // Only the signed-in user's notes: the policy filters, not this query.
  return Response.json(await db()`select id, body from notes order by id`);
}

export async function POST(request: Request): Promise<Response> {
  const { body } = await request.json();
  // `with check` refuses a row whose owner is not the caller (SQLSTATE 42501).
  const [note] =
    await db()`insert into notes (owner, body) values (auth.uid(), ${body}) returning id`;
  return Response.json(note, { status: 201 });
}
```

### Who a query runs as

| Call                                                                   | Postgres role                            | `auth.uid()`  |
| ---------------------------------------------------------------------- | ---------------------------------------- | ------------- |
| `db()` in a request, signed in                                         | `authenticated`                          | the user's id |
| `db()` in a request, signed out                                        | `anon`                                   | `null`        |
| `db()` outside a request                                               | `anon`                                   | `null`        |
| `db({ as: { id, email?, roles?, claims? } })` or `db({ as: session })` | `authenticated`                          | that id       |
| `db({ as: "anon" })`                                                   | `anon`                                   | `null`        |
| `db.service()` / `db({ as: "service" })`                               | the app's own database user — **no RLS** | `null`        |

Outside a request (a [task](/docs/tasks), a script) nobody is signed in, so `db()` is `anon` there:
act for a user with `db({ as: { id: userId } })`, or as the server itself with `db.service()`.
`db()` reads the session when it is called and keeps it, so call it where the request is handled
rather than storing the client in a module-level variable.

**`db.service()` is dangerous on purpose.** It is the app's database user with every policy
bypassed (it owns the tables): use it for migrations, maintenance tasks and admin code that has
already checked who is asking, never for a query built from a request on a user's behalf.

### How it works

Each `db()` query is one transaction: `BEGIN`, then
`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)` (that is
`SET LOCAL ROLE` with a parameter — the form PostgREST uses), your query, `COMMIT`. Both settings
are transaction-local, so nothing survives on a pooled connection, and it is safe behind pgbouncer
in transaction mode; denext never issues a session-level `SET`. The setup statement and your query
are pipelined — sent together, in that order, on the transaction's one connection. On denext's
runtime (`Deno.SQL`) `BEGIN` and `COMMIT` ride along too, so a scoped query is one round trip; a
driver that waits for each answer (postgres.js through `fromPostgresJs`) takes more. If the setup
fails the transaction is aborted and your query never runs as the connecting role.

`db().begin(async (tx) => …)` scopes a whole transaction once (on `Deno.SQL`, three round trips for
two awaited queries);
a `begin` inside it is a savepoint. A thrown error rolls back the transaction and its settings.

### The claims

`request.jwt.claims` has the shape of a Supabase access token, so `auth.jwt()` reads the same keys:

```json
{
  "sub": "0b7c3c1e-…",
  "role": "authenticated",
  "aud": "authenticated",
  "email": "ada@example.com",
  "exp": 1791234567,
  "iat": 1791230967,
  "session_id": "…",
  "aal": "aal1",
  "amr": [{ "method": "pwd", "timestamp": 1791230967 }],
  "app_metadata": { "provider": "credentials", "providers": ["credentials"], "roles": ["editor"] },
  "user_metadata": { "name": "Ada", "image": "https://…", "email_verified": true },
  "is_anonymous": false
}
```

`aal` is `aal2` once the session has a second factor (`amr` includes `totp`, `bcp` or `mfa`);
`app_metadata.roles` are the denext session's `roles`. Signed out, the claims are `{ "role": "anon" }`.
Add your own with `backend({ postgres: { rls: { claims: (session) => ({ tenant: … }) } } })` and read
them as `auth.jwt() ->> 'tenant'`; `sub`, `role` and `email` cannot be overridden.

### Setup: the roles and `auth.*`

The first scoped query applies the migration `backend_rls_0001` (recorded in `backend_migrations`):

- the roles `anon` and `authenticated` (`NOLOGIN NOINHERIT`), created when missing;
- `GRANT anon, authenticated TO` the app's database user, so it may switch to them;
- the `auth` schema with `auth.uid()`, `auth.role()`, `auth.email()` and `auth.jwt()` — Supabase's
  own definitions, from
  [supabase/auth `migrations/20220224000811_update_auth_functions.up.sql`](https://github.com/supabase/auth/blob/master/migrations/20220224000811_update_auth_functions.up.sql),
  each created only when it does not exist yet.

That needs a database user that may create roles (`CREATEROLE`). Where it may not, have a database
administrator run the same setup once — `rlsSetupSql("app_user")` from `@denext/backend` prints it —
and set `rls: { migrate: false }`. Without the grant, the first scoped query fails with
`… may not grant itself the role anon` and a hint naming the `GRANT`. A superuser connection works
too, but connect as an ordinary role in production: a superuser could switch to any role.

### Coming from Supabase: your policies work as-is

- `auth.uid()`, `auth.role()`, `auth.email()` and `auth.jwt()` are Supabase's functions, reading the
  same `request.jwt.claims`; policies, `security definer` helpers and `with check` clauses that use
  them need no change. A database restored from Supabase keeps its own `auth.*` functions.
- `auth.uid()` returns `uuid`, as in Supabase: denext's own auth adapters issue UUID user ids. With
  ids of another shape, compare `auth.jwt() ->> 'sub'` instead.
- The roles are the same names. Supabase grants every table in `public` to `anon` and
  `authenticated` by default; here a table is reachable only once you `grant` it, as above —
  `alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;`
  restores Supabase's default if you want it.
- There is no `service_role` key: the server is the only client, and `db.service()` is its
  unscoped connection.
- RLS guards against a query that forgets a `where`, not against SQL injection: injected SQL could
  `reset role`. Keep values bound (the tagged template does it) and never build `unsafe()` text
  from input.

## Realtime from the database

Opt tables in, and every insert, update and delete reaches the browsers watching them — each change
re-read as that viewer, under their [row-level security](#row-level-security), so a subscriber
receives a row only when their own SELECT policies return it.

```ts
// denext.config.ts
import { backend, realtime } from "@denext/backend";

export default {
  plugins: [
    backend({
      postgres: {},
      realtime: realtime({
        tables: {
          notes: { events: ["insert", "update", "delete"], key: "id" }, // both are the defaults
        },
      }),
    }),
  ],
};
```

```tsx
// app/notes/page.tsx — the first rows come from the server, under the same policies
import { db } from "@denext/backend/server";
import { NoteList } from "./note-list.tsx";

export default async function Page() {
  const notes = await db()<Note>`select id, body from notes order by id`;
  return <NoteList initial={notes} />;
}
```

```tsx
// app/notes/note-list.tsx
"use client";
import { useTableChanges } from "@denext/backend/client";

export function NoteList({ initial }: { initial: Note[] }) {
  const { rows, stale } = useTableChanges<Note>("notes", { initial });
  return <ul>{rows.map((note) => <li key={note.id}>{note.body}</li>)}</ul>;
}
```

`useTableChanges(table, options)` returns `{ rows, changes, status, stale, error }`:

| Option     | What it does                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initial`  | The rows to start from. A new array replaces the hook's rows (and clears `stale`).                                                                    |
| `filter`   | One column compared for equality: `{ list_id: 42 }`, or Supabase's `"list_id=eq.42"`. Applied in SQL, after the policies.                             |
| `key`      | The rows' key column, as configured for the table (default `"id"`).                                                                                   |
| `onChange` | Called with each batch: `{ op: "insert" \| "update", key, row }`, `{ op: "update", key, oldKey, row }` when the key changed, `{ op: "delete", key }`. |
| `onResync` | Called when changes may have been missed: re-read and pass the rows as `initial`.                                                                     |
| `enabled`  | `false` keeps the hook idle.                                                                                                                          |

From a subscriber's side, `insert` means a row entered their view — inserted, or updated so their
policies or filter now match it — and `delete` means one left it: deleted, or updated out of their
policies or filter. Rows keep arrival order; sort them when you render.

### How it works

1. **Triggers send keys, never rows.** The first subscription applies migration
   `backend_realtime_0001` (a trigger function, `denext_realtime_notify()`) and one migration per
   table (`backend_realtime_t_<table>_<hash>`): an `AFTER INSERT OR UPDATE OR DELETE … FOR EACH ROW`
   trigger that sends `pg_notify('denext_realtime', '{"table","op","key","old_key"?,"ts"}')`. A
   NOTIFY payload is capped at 8000 bytes, and a row would leak past the policies, so only the key
   travels; a key too long to send becomes a "re-read" signal instead of failing the write. Changing
   a table's `events` or `key` installs a new migration that replaces its trigger; a table removed
   from the options keeps its trigger until you `drop trigger denext_realtime on <table>`.
2. **One listener per server instance.** A single connection `LISTEN`s (the driver re-listens after
   a lost connection, and every subscriber is told to re-read, since changes sent meanwhile are
   lost). Notifications are coalesced for 16 ms, as Live coalesces its own pushes: within a burst
   the latest change per key wins.
3. **Re-read as each subscriber.** Subscribers with the same identity, table and filter form a
   group, and each group's changed rows are read back with one query
   (`select … where key in (…)`, 1 000 keys per statement) through the RLS-scoped client — `role`
   and `request.jwt.claims` set for that identity, exactly as `db()` does. A burst costs one query
   per identity, not one per subscriber per row: a 500-row transaction watched by two users is one
   flush and two re-reads.
4. **Deletes go only to those who could see the row.** A deleted row cannot be re-read against a
   policy, so each subscription tracks the keys it may know about: the rows it could see when it
   subscribed (one key-only query under its own policies, up to `maxTrackedKeys`) plus every row
   sent to it since. A delete, or an update that moves a row out of view, is sent only for a tracked
   key. Past `maxTrackedKeys` (default 10 000) further rows are delivered but not tracked, so their
   deletes are not sent: keep subscriptions narrow with a `filter`, or raise the limit.
5. **Frames.** Changes ride the Live socket on the backend's own channel, split to fit its payload
   cap (a row too large for one frame arrives with `truncated: true` and no `row`) and numbered per
   subscription; a gap, a burst over the queue limit, or a reconnect sets `stale` and calls
   `onResync`. Delivery is at-most-once, like every Live channel.

**Who receives what.** The subscription key holds the table, the filter and a 128-bit random value
the browser picks; the first subscriber binds it to their identity (the user's id, or anon), and
anyone else presenting it is refused. The binding is re-checked every 60 seconds of traffic, so a
signed-out session stops receiving. A table needs `grant select … to authenticated` (and to `anon`
if signed-out visitors may watch it) for its rows to be readable at all.

### On the server

```ts
import { onTableChange, tableChanges } from "@denext/backend/server";

// Keys only, in the service context (no RLS): invalidate, enqueue, notify another system.
onTableChange("notes", ({ op, key }) => console.log(op, key));

// The rows an identity may see — the same re-read the browser gets — for an SSE stream, a GraphQL
// subscription, a worker acting for a user.
const stop = await tableChanges("notes", {
  as: { id: userId },
  filter: { list_id: 42 },
  onChange: ({ changes, resync }) => {/* … */},
});
```

`onTableChange` runs once per changed key per burst, on every instance (with `op: "resync"` when
changes may have been missed). `realtime({ revalidate: true })` also calls
`revalidateTag("table:<name>")` once per burst, so existing [Live](/docs/live) code —
`<Live tags={["table:notes"]}>`, `defineSubscription({ tags })`, `useApi({ tags })` — is pushed by
database writes from anywhere, including another service or `psql`.

Every instance runs its own listener, so with several instances that revalidation happens once per
instance — what an instance-local cache needs. When the cache is shared (a Postgres cache store),
`realtime({ revalidate: { owner: "one" } })` has one instance per database do it: the holder of a
session-level Postgres advisory lock, taken on a reserved connection and checked once per burst
(one round trip). The lock goes with its connection, so when the owner stops or dies the next
instance to see a burst takes over. It needs a client with `reserve()` (`Deno.SQL`, or postgres.js
through `fromPostgresJs`); without one every instance revalidates, with a warning.
`onTableChange` hooks still run on every instance.

### Options

| Option           | Default | What it does                                                                                    |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `tables`         | —       | `{ name: { events?, key?, schema? } }`: the tables, their events, key column and schema.        |
| `revalidate`     | `false` | `revalidateTag("table:<name>")` per burst; `{ owner: "one" }`: on one instance per database.    |
| `migrate`        | `true`  | Install the triggers on first use. `false` when a DBA runs `realtimeSetupSql(options)` instead. |
| `maxSubscribers` | 10 000  | Subscriptions per server instance (a closed tab's is kept 15 s for a reconnect).                |
| `maxTrackedKeys` | 10 000  | Keys tracked per subscription, for deletes.                                                     |

Realtime needs a Postgres client with `listen`: `Deno.SQL` (denext's Deno runtime), or the npm
`postgres` package through `postgres: { sql: fromPostgresJs(postgres(url)) }` on stock Deno.
Without one, `onTableChange` and `tableChanges` throw `RealtimeUnsupportedError`
(`code: "unsupported"`), browser subscriptions are refused, and `denext dev` says so at startup.
`TRUNCATE` sends nothing. For very high write volumes, logical replication is planned; LISTEN/NOTIFY
serializes on commit.

## Auto-REST

Opt in, and the tables of one schema are served as HTTP routes in the PostgREST style, so the
browser (or a native app) can read and write them directly — every statement run through `db()`,
so [row-level security](#row-level-security) scopes it to the request's user, or to `anon`.

```ts
// denext.config.ts
import { backend } from "@denext/backend";

export default {
  plugins: [
    backend({
      postgres: {},
      rest: {}, // every table of "public" the anon / authenticated roles hold a privilege on
    }),
  ],
};
```

```ts
// app/notes/notes-api.ts — used from client components
import "../../.denext/rest.ts"; // the generated row types
import { from } from "@denext/backend/client";

export async function latestNotes(listId: number) {
  const { data, error, count } = await from("notes")
    .select("id,body", { count: "exact" }) // data: { id: number; body: string }[] | null
    .eq("list_id", listId)
    .order("id", { ascending: false })
    .limit(20);
  if (error) throw error; // a RestClientError: { code, status, message, details, hint }
  return { notes: data ?? [], total: count };
}

export const addNote = (listId: number, body: string) =>
  from("notes").insert({ list_id: listId, body }).select().single();
export const editNote = (id: number, body: string) => from("notes").update({ body }).eq("id", id);
export const removeNote = (id: number) => from("notes").delete().eq("id", id);
```

The builder's shape loosely follows supabase-js's — `select`, `eq` / `neq` / `gt` / `gte` / `lt`
/ `lte` / `like` / `ilike` / `is` / `in` / `not`, `order`, `limit`, `offset`, `range`, `single`,
`insert` / `update` / `delete` with an optional `.select()` to get the written rows back — and
resolves to `{ data, error, count, status }` without throwing. It is not a drop-in for supabase-js.
`restClient({ url, headers, fetch })` makes a client with a base URL (an app on another origin, a
native app's `Authorization: Bearer …` session); `from` uses the page's own origin and cookies.

### Routes

`GET`, `HEAD`, `POST`, `PATCH` and `DELETE` on `/rest/v1/<table>`:

| Request                                          | What it does                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `select=id,body`                                 | The columns to return (default `*`). Columns of this table only: embedded resources, aliases, casts and JSON paths are refused (400).   |
| `col=eq.value`                                   | A filter: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like` / `ilike` (`*` or `%` matches any run), `is.null\|true\|false`, `in.(a,"b,c")`. |
| `col=not.eq.value`                               | The filter negated. Every filter is ANDed; `or=` and `and=` are not supported.                                                          |
| `order=col.desc.nullslast,other`                 | The order: `asc` / `desc`, `nullsfirst` / `nullslast`.                                                                                  |
| `limit=20&offset=40`, or a `Range: 40-59` header | Paging, capped at `maxRows`. The response carries `Content-Range: 40-59/*`.                                                             |
| `Prefer: count=exact`                            | Count every matching row too: `Content-Range: 40-59/1234`, and `206` when the page is not all of them.                                  |
| `Accept: application/vnd.pgrst.object+json`      | One object instead of an array; zero or several rows are a `406` (and a write is rolled back).                                          |
| `POST` with an object or an array of objects     | Insert (every object with the same keys). `201`; columns left out take their default.                                                   |
| `PATCH` with an object, plus filters             | Update the matching rows. A request without a filter is refused (`400`, `21000`).                                                       |
| `DELETE` plus filters                            | Delete the matching rows. A request without a filter is refused.                                                                        |
| `Prefer: return=representation` on a write       | Answer with the written rows (`select=` shapes them); the default, `return=minimal`, answers `201` / `204` with no body.                |

**What is safe.** A table, column or type name is never taken from the request as text: each is
looked up in the catalog the plugin read and only a name found there is quoted into the SQL, so an
unknown column or operator is a `400`, never a statement. Every filter value is a `$n` parameter
cast to its column's type, and a request body is one JSON parameter expanded by
`json_populate_record(set)` against the table's own row type — Postgres parses every value. The
rows come back as one JSON text built by Postgres (`json_agg`), so a `bigint` keeps its digits.
Each request runs in a transaction that sets the role and claims, then a `statement_timeout`.

**CSRF.** A write carrying cookies follows the same rule as Server Actions and `csrf()`: a
cross-site one is refused (`403`, `csrf_failed`). A native app's bearer token
(`Authorization: Bearer nat_…`, which `auth()` reads instead of the cookie) needs no such check.

**Errors** are PostgREST-shaped JSON — `{ code, message, details, hint }` — with Postgres's
SQLSTATE as the code where Postgres refused (`23505` → `409`, `42501` → `403`, `23502` / `22P02` →
`400`, `57014` statement timeout → `504`), and `PGRST100` (a malformed query), `PGRST102` (a bad
body), `PGRST103` (a range past the rows), `PGRST116` (not exactly one row), `PGRST205` (no such
table) or `42703` (no such column) otherwise. A 5xx hides the database's message (it is logged).

### Which tables

The plugin reads the catalog when the server starts (and again, under `denext dev`, when a request
names a table it does not know): every table, view, materialized view and foreign table of
`schema` that the `anon` or `authenticated` role holds a privilege on — `SELECT`, `INSERT` or
`UPDATE` on any column, or `DELETE`. A table with no grant to either role gets no route, so a
table stays private until you `grant`. Which rows a caller then reads or writes is up to its
policies; enable RLS on every exposed table.

### Generated types

At `denext dev` startup and `denext build`, the plugin writes `.denext/rest.ts` from the live
catalog: each exposed table's `Row`, `Insert` (columns with a default, or nullable, optional;
generated columns left out) and `Update` shapes, registered on `RegisteredRest` so `from("notes")`
autocompletes table names, types filters by column, and narrows `select("id,body")` to those
columns. Import it once. Without a database to read (no `DATABASE_URL` at build time) the plugin
says so, keeps an earlier generated file, or writes a stub under which rows are
`Record<string, unknown>`.

### Options

| Option             | Default      | What it does                                                                       |
| ------------------ | ------------ | ---------------------------------------------------------------------------------- |
| `schema`           | `"public"`   | The schema whose tables are served.                                                |
| `tables`           | `"*"`        | The tables to serve, by name; a listed table the roles cannot reach gets no route. |
| `basePath`         | `"/rest/v1"` | Where the routes live (app-relative; `basePath` is prepended).                     |
| `maxRows`          | 1000         | The most rows one read returns, whatever `limit` asks for.                         |
| `maxBodyBytes`     | 1 MiB        | The largest request body.                                                          |
| `statementTimeout` | 8000         | Each request's `statement_timeout`, in milliseconds.                               |

Not offered: embedded resources (joins through foreign keys — read the related table with a
second request, or write a route handler), `or` / `and` groups, upserts (`on_conflict`), RPC
(`/rpc/<function>` — call it with `db()` in a route handler) and CSV bodies. The routes are not
listed in the `@denext/openapi` document.

## Browse it in `denext ui`

[`denext ui`](/docs/ui#database) has a Database section for a project that uses Postgres: tables
and their rows (paged, editable, each write previewed as the exact SQL first), row-level security
policies — with an "as user" preview of what a user id sees under them — migrations, the storage
buckets and their objects, and denext auth's users. It runs on loopback with the rest of the UI,
and honours `--read-only`.

## More services

Storage, Postgres, row-level security, realtime from the database and auto-REST are the services in
`@denext/backend`. Auth ([`denextAuth`](/docs/auth)), push and live data ([Live](/docs/live)), functions ([route handlers](/docs/typed-api)) and scheduled
[tasks](/docs/tasks) are already part of denext itself.
