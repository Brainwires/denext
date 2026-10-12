# @denext/backend

**Backend services inside your [denext](https://denext.dev) app**, as one opt-in plugin: no hosted
service, nothing to run beside it. It ships **storage** — buckets with per-bucket rules, signed
upload and download URLs, multipart uploads, image transforms on download and access checks tied to
the request's session — on S3 (AWS, Cloudflare R2, MinIO) or the local filesystem, with zero npm;
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

Or by hand: add `"@denext/backend": "jsr:@denext/backend@^0.1.0"` to `deno.json`'s `imports` and
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

The client is `Deno.SQL`, built into denext's Deno runtime. On stock Deno pass your own:
`backend({ postgres: { sql: fromPostgresJs(postgres(url)) } })` with the npm `postgres` package
(`fromPostgresJs` is in `denext/server`). Guide: [Backend › Postgres](https://denext.dev/docs/backend#postgres).

**Row-level security, Supabase-compatible.** `db()` runs each query as the request's user: a
transaction that sets the role (`authenticated`, or `anon` when signed out or outside a request)
and `request.jwt.claims` transaction-locally, so policies written with Supabase's `auth.uid()`,
`auth.role()`, `auth.email()` and `auth.jwt()` apply unchanged. The roles and functions are created
by a migration on first use (or by a DBA with `rlsSetupSql(role)` and `rls: { migrate: false }`).
`db({ as: user })` acts for a user outside a request; `db.service()` bypasses RLS entirely — the
app's own database user, for maintenance code only. Guide:
[Backend › Row-level security](https://denext.dev/docs/backend#row-level-security).

## What it enforces

- **`authorize`** decides every operation (`upload`, `download`, `delete`, `list`) made inside a
  request, with `auth()`'s session; without one, everything but a public bucket's downloads is
  denied. Calls outside a request (tasks, scripts) are trusted.
- **Size, type and content**: `maxBytes` and the `mime` allow-list are checked when an upload is
  signed and again on the bytes; a declared image must start with that format's magic bytes.
- **Keys** cannot leave their bucket: no `..`, empty segments, control characters or backslashes.
- **Signed URLs** are HMAC-SHA256 over every parameter (method, bucket, key, expiry, type, size,
  transform), verified in constant time; S3 URLs are SigV4-presigned and pin type and size.
- **Uploads go through `POST /_denext/storage/sign`**, which refuses cross-site requests that carry
  cookies (denext's `csrf()` rule) and validates its body.
- Objects served from the app's origin carry `nosniff` and a sandboxing CSP.

Full guide: [denext.dev/docs/backend](https://denext.dev/docs/backend).
