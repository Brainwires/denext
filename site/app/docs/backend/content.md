---
title: Backend
slug: backend
lead: "@denext/backend puts backend services inside your app as one opt-in plugin: no hosted service, nothing to run beside it. It ships storage — buckets declared in config or created at runtime, per-bucket rules in TypeScript or SQL row-level security, signed upload and download URLs, multipart and TUS resumable uploads, image transforms, and Supabase's Storage API so supabase-js works unchanged, on S3 (AWS, Cloudflare R2, MinIO) or the local filesystem — Postgres for your server code and for auth, scoped by row-level security, realtime changes from your tables, and an optional REST API over them, with zero npm."
---

```sh
denext plugin add @denext/backend
```

Or by hand: add `"@denext/backend": "jsr:@denext/backend@^0.3.0"` to `deno.json`'s `imports`,
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
| `authorize` | deny    | `({ session, identity, op, key, bucket, request }) => boolean`. Only `true` allows. With no `authorize`, every operation is denied except downloads from a public bucket.                |
| `versioned` | off     | Object versioning ([below](#object-versioning)): `true` keeps overwritten and deleted objects as noncurrent versions; `false` suspends it.                                               |

`op` is `"upload"`, `"download"`, `"delete"` or `"list"` (for a listing, `key` is the prefix); a
copy is `download` on the source and `upload` on the destination, a move adds `delete` on the
source. `session` is `auth()` from [`denextAuth`](/docs/auth) — `null` when signed out or when the
app has no auth. A supabase-js caller's access token counts: its session is the one `auth()` reads
from the bearer (a revoked token, or one still owing a second factor, is `null`), or, without
`denextAuth`, the token's verified claims. `identity` is who the request acts as: `{ role: "anon" | "authenticated", claims,
userId? }`, the claims shaped like a Supabase access token's. A request that presents the secret
key (the service role) skips `authorize`.

Besides `driver` and `buckets`, `storage` takes:

| Option                  | Default                 | What it does                                                                                                                                              |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authorize`             | deny                    | The rule for buckets created at runtime, and for declared buckets without an `authorize` of their own.                                                    |
| `rls`                   | `false`                 | Authorize with SQL policies on `storage.objects` / `storage.buckets`, as Supabase does ([below](#sql-row-level-security-for-storage)). Needs `postgres`.  |
| `api`                   | `true`                  | The Supabase-compatible Storage API under `/storage/v1`; `{ basePath }` moves it, `false` turns it off.                                                   |
| `metadataPath`          | `.denext-storage.db`    | Without `postgres`: the `node:sqlite` file holding bucket and object metadata (relative to the project root). With `postgres` it is the `storage` schema. |
| `maxTransformDimension` | `2500`                  | The largest width or height the API's `render/image` routes produce.                                                                                      |
| `secret`                | `DENEXT_STORAGE_SECRET` | The HMAC secret for signed URLs and tokens (below).                                                                                                       |

**When `authorize` runs.** On every storage call made inside a request: the plugin's own endpoints,
and the server API called from a route handler, Server Action or Server Component, with that
request's session. Outside any request (a [job](/docs/jobs), a script, module load) there is no
session to authorize, so a plain handle is refused (`forbidden`; a public bucket's downloads stay
open): code that acts as the server takes a service handle, there or inside a request (a webhook,
an admin action). `storage.bucket("invoices", { service: true })` skips `authorize`; the size cap,
allow-list and sniffing still apply.

**The signing secret.** The plugin signs its own URLs and upload tokens with HMAC-SHA256. Set
`DENEXT_STORAGE_SECRET` (at least 32 characters) or `storage.secret`; pass a list, current first,
to rotate one out. `denext dev` falls back to a random secret per run, so links stop working on
restart. In production a missing secret is an error the first time a URL is signed.

### Drivers

**`s3({ region, bucket, endpoint?, credentials?, pathStyle?, publicEndpoint?, fetch? })`** talks to AWS S3, Cloudflare R2,
MinIO and other S3-compatible stores over `fetch`, with AWS Signature Version 4 computed by
`crypto.subtle` (no SDK). Every denext bucket is a key prefix in the one S3 bucket:
`avatars/u1/me.png`. Credentials default to `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
`AWS_SESSION_TOKEN`; the endpoint defaults to AWS, or `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL`.
AWS is addressed virtual-host style, a custom `endpoint` path style; `pathStyle` overrides either.
When browsers reach the store under another name than the server does (the Docker stack's
`http://minio:9000` is only resolvable inside the containers), set `publicEndpoint` (or
`S3_PUBLIC_ENDPOINT`): every URL handed to a browser — presigned uploads, downloads and multipart
parts — is signed for that host (SigV4 signs `Host`), while the server's own calls keep
`endpoint`.

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

### From the command line

`denext storage` is the Supabase CLI's `storage` group. It runs as the service role through the
app's own driver and metadata. A storage path is `ss:///<bucket>/<key>`; anything else is a local
path.

```sh
denext storage ls                                   # the buckets
denext storage ls ss:///avatars/team -r             # every key below a prefix
denext storage cp ./logo.png ss:///avatars/          # upload (--content-type, --cache-control)
denext storage cp ./public ss:///site -r             # a whole tree
denext storage cp ss:///avatars/logo.png ./logo.png  # download
denext storage mv ss:///avatars/a.png ss:///archive/a.png
denext storage rm ss:///archive -r
```

`denext db seed` creates the buckets the config declares, then uploads each
`supabase/buckets/<bucket>/**` file into its bucket.

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
| `upload(key, body, { upsert?, cacheControl?, metadata? })`                  | `upsert: false` refuses an existing key (`duplicate`); `cacheControl` is served back; `metadata` is free-form JSON kept with the object.                     |
| `info(key)` / `exists(key)`                                                 | The stored facts (`size`, `contentType`, `cacheControl`, `etag`, `metadata`, `owner`, timestamps), or `null`; whether the object exists.                     |
| `copy(from, to, { destinationBucket?, upsert? })` / `move(from, to, …)`     | Copy or rename an object, within a bucket or into another (whose size cap and allow-list apply). A move never replaces an existing destination.              |
| `listFolder(prefix?, { limit?, offset?, search?, sortBy? })`                | One level of a folder, Supabase-style: subfolders first (`id: null`), then the objects, sorted by `name`, `created_at`, `updated_at` or `last_accessed_at`.  |
| `createSignedUrls(keys, options?)`                                          | Download URLs for many keys at once; `null` where a key is missing or not readable.                                                                          |
| `getPublicUrl(key, { transform? })`                                         | The stable URL of an object in a public bucket (no request is made).                                                                                         |

Buckets can also be managed at runtime, as the service (`{ service: true }`, or a request that
presents the secret key) — or, with `rls: true`, as anyone the `storage.buckets` policies allow:

```ts
await storage.createBucket("exports", { fileSizeLimit: "20MB", allowedMimeTypes: ["text/csv"] }, {
  service: true,
});
await storage.updateBucket("exports", { public: true }, { service: true }); // partial update
await storage.emptyBucket("exports", { service: true });
await storage.deleteBucket("exports", { service: true }); // refused while it holds objects
const buckets = await storage.listBuckets({ service: true }); // declared ones too: `declared: true`
```

A declared bucket is changed in `denext.config.ts`, not at runtime; its settings are written into
the bucket table at startup.

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

**An S3 upload that is never completed** has been checked by nobody: a client can `PUT` to its
presigned URL and skip the completion call. Such bytes can still only be served with the type the
URL pinned, and every presigned `GET` the plugin signs carries `response-content-type` (the stored
type) and `response-content-disposition`: `inline` only for raster images, audio, video, PDF and
plain text, `attachment` for everything else — the same rule the plugin's own object route
applies — so an HTML or SVG file downloads instead of rendering. Record the keys
`uploadFile` / completion returned (in your own table) and sign download URLs only for those, and
give the S3 bucket a lifecycle rule that removes what was never recorded, plus one that aborts
incomplete multipart uploads after a day (`AbortIncompleteMultipartUpload`).

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
| `/storage/v1/…`                                | The [Supabase Storage API](#supabase-storage-api) and [TUS](#resumable-uploads-tus).  |

Objects served from your app's origin carry `X-Content-Type-Options: nosniff` and a sandboxing
`Content-Security-Policy`, and anything but images, audio, video, PDF and plain text downloads as an
attachment — an uploaded HTML or SVG file never runs script as your app. A public object on S3 is a
redirect to a presigned URL that lives five minutes.

### Metadata: buckets and objects

Every upload, copy, move and delete also keeps a row per object — its size, type, `Cache-Control`,
ETag, owner and free-form `metadata` — and a row per bucket. With `postgres` they are Supabase's own
tables, `storage.objects` and `storage.buckets` (same columns, same unique index, row-level
security enabled, `anon` / `authenticated` granted access), plus `storage.foldername(name)`,
`storage.filename(name)` and `storage.extension(name)`, created by the `backend_storage_0001`
migration on first use (`backend_storage_0002` adds the versioning and lifecycle columns) (`storageMigrations()` returns it for a DBA). A database restored from
Supabase keeps its tables and gains any missing column. Without `postgres` the same rows live in a
`node:sqlite` file (`storage.metadataPath`), which serves one server process: several replicas
sharing storage need the Postgres store. Listings, `info()` and the bucket API read the rows; the
bytes stay in the driver.

### Supabase Storage API

The plugin serves Supabase's Storage API under `/storage/v1`, so the `storage` client of
`@supabase/supabase-js` v2 works unchanged against your app:

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient("https://my-app.example", publishableKey);
await supabase.storage.from("avatars").upload(`${userId}/avatar.png`, file, { upsert: true });
const { data } = await supabase.storage.from("invoices").createSignedUrl(path, 60);
const { data: files } = await supabase.storage.from("avatars").list(userId, {
  limit: 50,
  sortBy: { column: "created_at", order: "desc" },
});
```

Every call of the storage client is there: `createBucket`, `getBucket`, `listBuckets` (with
`search`, sorting and paging), `updateBucket`, `emptyBucket`, `deleteBucket`, and the lifecycle
calls; `upload` and `update` (raw bodies or `FormData`, `upsert`, `cacheControl`, `contentType`,
`metadata`), `download` (with a `transform`), `info`, `exists`, `list` (folders first, `search`,
`sortBy`, `limit`, `offset`, `noncurrentVersions`, `deleteMarkers`, `exactMatch`), `listV2` (cursor
pages, with or without `with_delimiter`), `remove` (many at once, a path or `{ path, versionId }`),
`move` and `copy` (also into another bucket, `sourceVersionId`), `createSignedUrl` and
`createSignedUrls` (with `download`, `transform` and `versionId`), `createSignedUploadUrl` +
`uploadToSignedUrl`, and `getPublicUrl` (with `download`, `transform` and `versionId`). Errors come
back as Storage's `{ statusCode, error, message }` (`409 Duplicate`, `413`, `415`, `403`, `404`).

A form upload (supabase-js sends a `Blob` or `File` as one) is streamed: the fields before the
file are read, the file's bytes go through the size cap, the allow-list and content sniffing to the
store as they arrive — never buffered whole. Bucket rows are as private as on Supabase: with
TypeScript rules, `listBuckets` answers anon and signed-in users with an empty list and `getBucket`
with `Bucket not found` (Supabase's `storage.buckets` has row-level security and no policy); the
service role sees every bucket, and under `rls: true` your policies on `storage.buckets` decide.

Who a request is comes from the backend's shared identity, with
[`backend({ supabase })`](#supabase-keys-and-access-tokens) providing the keys: a user's access token
(`Authorization: Bearer <jwt>`) is that user (`authenticated`); the secret key (`apikey` or bearer)
is the service role, which skips `authorize` and policies; a signed-in denext session is that user;
anything else (the publishable key, or nothing) is `anon`. A token or key that is presented and
refused is an error — `400 InvalidJWT` for a bad or expired token, `401 Unauthorized` for an
unknown key — never a silent `anon`. A write that carries the session cookie follows the
[`csrf()`](/docs/typed-api) rule. The size cap, allow-list and content sniffing apply on every path,
the service role and signed uploads included. Signed URLs and upload tokens are HMAC-signed with the
storage secret and checked in constant time; a signed upload URL lives two hours.

Under `rls: true` a write is judged against the object as it is when the write lands, not when it
was checked. An upload, copy, move or TUS upload by a request's user writes its row under that
user's role, in one transaction with the current row locked, so an upsert needs your `update`
policy on whatever object is there at that moment. The bytes wait in a staging area until that
write is allowed, so a refused write never touches the bytes at the key. A move takes the
destination's name before it copies anything. A signed upload token minted by a policy-checked
caller (`/object/upload/sign`, signed TUS, `createSignedUploadUrl`) is pinned to the object's
version when it was signed: if the object has changed since, the upload is a `409`. A
`createSignedUploadUrl` PUT (or presigned part) goes to a staging place too, on S3 as on the fs
driver: its completion checks the bytes and moves them to the key with the row, so a refused or
abandoned upload never touches the object. Abandoned uploads are swept once they can no longer
be completed. Emptying a bucket (`POST /bucket/<id>/empty`) deletes only the objects,
noncurrent versions and delete markers your policies let the caller delete.

`render/image` transforms take Supabase's options: `width` and `height` (any size up to
`maxTransformDimension`), `resize` (`cover`, the default, fills the box and crops the overflow;
`contain` fits inside it; `fill` stretches to it), `quality` (1–100) and `format: "origin"` (keep
the source's format; the default is WebP). They run through the same image pipeline, cache and
decompression-bomb checks as the transforms above.

Without supabase-js, `@denext/backend/client` calls the same API from the browser with the page's
cookies: `listFiles(bucket, prefix, { limit, offset, search, sortBy, noncurrentVersions })`,
`listFilesV2(bucket, { prefix, cursor, limit, withDelimiter })`, `getFileInfo` (`versionId`),
`removeFiles(bucket, keys)`, `moveFile` and `copyFile` (`{ destinationBucket }`),
`getSignedUrls(bucket, keys, { expiresIn })`, `getPublicUrl(bucket, key, { transform, download })`
and `uploadResumable(bucket, key, file, { chunkSize, upsert, onProgress, signal, signature })` — a TUS upload
that retries a dropped chunk from the offset the server reports and terminates a cancelled one.
A refused call throws `StorageApiClientError` (`code` is Storage's error name, `status` the HTTP
status).

### Resumable uploads (TUS)

`/storage/v1/upload/resumable` speaks TUS 1.0.0 — creation, creation-with-upload, `PATCH`, `HEAD`,
termination and expiration — so `tus-js-client` and Uppy upload large files in chunks and resume
after a dropped connection:

```ts
import * as tus from "tus-js-client";

const upload = new tus.Upload(file, {
  endpoint: "/storage/v1/upload/resumable",
  chunkSize: 6 * 1024 * 1024,
  headers: { "x-upsert": "true" }, // the page's cookie session authorizes it
  metadata: { bucketName: "videos", objectName: `${userId}/clip.mp4`, contentType: "video/mp4" },
});
upload.start();
```

A signed upload URL works for TUS too, as on Supabase: point the client at
`/storage/v1/upload/resumable/sign` and send the token from `createSignedUploadUrl` as the
`x-signature` header (no session needed); the token names the one object it may write.

An upload is authorized when it is created (`authorize`, or the policies) and bound to its creator;
its size against the bucket's cap and its type against the allow-list are checked then, and the
assembled object's size and first bytes again at the end. It expires 24 hours after creation
(`Upload-Expires`). On S3 the bytes become parts of a multipart upload as they arrive (a remainder
under S3's 5 MiB minimum waits as a tail object); on the filesystem each `PATCH` is a chunk,
joined through the usual checks at the end. Progress lives in the metadata store, so any replica
can take the next `PATCH`.

### Object versioning

A bucket keeps versions the way Supabase Storage does. Its `versioning_status` is `DISABLED` (never
on), `ENABLED` or `SUSPENDED`: `createBucket(id, { versioningStatus: "ENABLED" })`,
`updateBucket(id, { versioningStatus: "ENABLED" | "SUSPENDED" })` (there is no way back to
`DISABLED`), or `versioned: true | false` on a declared bucket.

- While `ENABLED`, overwriting an object keeps the previous one as a **noncurrent version**, and
  deleting it (by path) leaves a **delete marker** as the current version: the object reads as
  absent, its history stays. While `SUSPENDED`, new writes replace the current object unless it was
  written while versioning was on.
- Every version has a `version` id (`info()` returns it). Read one with
  `download(path, { versionId })`, `info(path, { versionId })`, `createSignedUrl(path, s, {
  versionId })` or `getPublicUrl(path, { versionId })`; restore one with `copy(path, path, {
  sourceVersionId })`; delete one for good with `remove([{ path, versionId }])` — deleting the
  current version brings the newest noncurrent one back.
- `list(prefix, { noncurrentVersions, deleteMarkers })` (`exclude`, the default, `include` or
  `only`) and `listV2` show versions, each entry with `version`, `archived_at`,
  `is_delete_marker` and `is_versioned`; `exactMatch` lists one object's versions.
- A **lifecycle policy** expires noncurrent versions: `updateBucketLifecycle(id, { rules: [{
  status: "Enabled", filter: {}, noncurrentVersionExpiration: { noncurrentDays: 30,
  newerNoncurrentVersions: 2 } }] })`, `getBucketLifecycle`, `deleteBucketLifecycle` (validated as
  Supabase does: 1–1000 rules, `filter: {}` only). Expiry runs in the background of the bucket's
  writes, at most once a minute per server.

The rows live in `storage.objects` (`archived_at` set on a noncurrent version, `is_delete_marker`
on a marker), so policies on `storage.objects` see every version. A noncurrent version's bytes are
copied to an internal namespace of the store (`.denext-versions/<bucket>/<version>`) before they
would be overwritten; on S3 that is one server-side `CopyObject` per overwrite. The server API
has the same: `bucket.download(key, { versionId })`, `info(key, { versionId })`,
`remove([{ key, versionId }])`, `listFolder(prefix, { versions, deleteMarkers })` and
`storage.getBucketLifecycle` / `updateBucketLifecycle`.

### SQL row-level security for storage

With `storage: { rls: true }` (and `postgres`), storage authorizes the way Supabase does: each
operation runs its statement on `storage.objects` or `storage.buckets` as the request's role, with
its claims in `request.jwt.claims`, so policies written for Supabase apply unchanged:

```sql
create policy "own folder: read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own folder: write" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
```

As on Supabase: an upload needs `insert`, an upsert `select`, `insert` and `update`, a download,
`info`, a listing or a signed URL `select`, a remove `select` and `delete`, a move `update`, and
creating a bucket `insert` on `storage.buckets`. A public bucket's downloads need no policy. A
bucket's `authorize`, when it has one, must allow the operation too. With no policy nothing is
allowed (row-level security denies by default); the service role bypasses the policies.

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

The client is `Deno.SQL`, the Postgres client built into [denext's Deno toolchain](/docs/toolchain), opened at startup
and closed when the server drains. On stock Deno there is none: the app still builds and starts,
and `db()` throws an error with `code: "unsupported"` that says so. Pass a client of your own as
`postgres: { sql }` instead — the npm `postgres` package through `fromPostgresJs` from
`denext/server` works on any Deno; a client you pass is never closed by the plugin.

`backendAuthAdapter({ schema?, migrate? })` is `postgresAuthAdapter` on that client (see
[Auth › Postgres](/docs/auth#postgres)): its `auth_*` tables are created by migrations on first
use. Your own tables come from `denext generate migration <name>` and `denext job migrate`
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

Outside a request (a [job](/docs/jobs), a script) nobody is signed in, so `db()` is `anon` there:
act for a user with `db({ as: { id: userId } })`, or as the server itself with `db.service()`.
`db()` reads who is asking for each query, from the request that makes it (once per request), not
when the client was made — so a module-level `const sql = db()` is fine: it serves each visitor
as themself, and is `anon` for a query made outside any request. `db({ as })` is fixed to that
identity wherever it runs.

**`db.service()` is dangerous on purpose.** It is the app's database user with every policy
bypassed (it owns the tables): use it for migrations, maintenance tasks and admin code that has
already checked who is asking, never for a query built from a request on a user's behalf.

### Supabase keys and access tokens

With `backend({ supabase: true })` the backend also recognizes Supabase's credentials, so a
`supabase-js` client can call it with an API key and a user's access token:

- **API keys**: a publishable key (`sb_publishable_…`, the `anon` role, safe in a browser), a
  secret key (`sb_secret_…`, the `service_role`, server-side only), and the legacy `anon` /
  `service_role` JWTs signed HS256 with a JWT secret. They come from `DENEXT_PUBLISHABLE_KEY`,
  `DENEXT_SECRET_KEY` and `DENEXT_JWT_SECRET` (or `backend({ supabase: { publishableKey,
  secretKey, jwtSecret } })`). The publishable and secret keys take several, comma-separated (any
  one is accepted, so you can rotate one out); the JWT secret is a single value. Startup refuses
  a placeholder key (`undefined`, `null`, …), a secret key under 32 characters or too
  predictable to grant `service_role`, and one key set as both; an empty variable counts as
  unset.
- **Access tokens**: JWTs with Supabase's claims, signed ES256 under `DENEXT_JWT_SIGNING_KEYS` (a
  private JWK, or a JSON array of them, current first — or `supabase: { signingKeys }`; the first
  signs, all of them verify, and the public halves are served at
  `/auth/v1/.well-known/jwks.json`), or HS256 under the JWT secret when no signing key is set.

The same option mounts GoTrue's `/auth/v1` over your `denextAuth()` users, so `supabase.auth.*`
works unchanged; its options go under `supabase: { auth: { … } }` — see
[Supabase clients](/docs/auth#supabase-clients-authv1).

`denext backend keys` prints a fresh set as environment variables (`--json` as JSON; `--legacy`
adds a JWT secret and the legacy JWT keys); under `denext dev` with none configured, a set is generated once into
`.denext/backend-keys.json`. Store them as secrets; never commit them. `denext backend token
--sub <user-id>` signs an access token with the app's key (`--role anon | service_role`,
`--exp <seconds>`, `--claims '{…}'`), like `supabase gen bearer-jwt`. It prints only the token,
for a test or a `curl`. `denext gen keys` and `denext gen bearer-jwt` are the same commands under
the Supabase CLI's names.

Every request is resolved by one function, `resolveIdentity()` from `@denext/backend/server`, which
`db()`, auto-REST and the other endpoints share. The first that applies wins:

| Credential                                                          | Role            | `request.jwt.claims`         |
| ------------------------------------------------------------------- | --------------- | ---------------------------- |
| `Authorization: Bearer <access token>`                              | `authenticated` | the token's claims, as-is    |
| the secret key (`apikey` header or bearer) or legacy `service_role` | `service_role`  | `{ "role": "service_role" }` |
| a denext session (the auth cookie, or a native `nat_…` token)       | `authenticated` | built from the session       |
| the publishable key, the legacy `anon` JWT, or nothing              | `anon`          | `{ "role": "anon" }`         |

A credential that is presented and refused — an expired or forged token, an unknown key — is an
`IdentityError` (401), never a quiet fall back to `anon`. `service_role` runs as the app's database
user (no row-level security) with `auth.role()` reading `service_role`. An access token names its
session (`session_id`), and that session is checked on every request, so signing out ends its
tokens at once rather than at their expiry.

```ts
import { db, resolveIdentity } from "@denext/backend/server";
const who = await resolveIdentity(); // { role, claims, userId?, source, session? }
const rows = await db({ as: who })`select * from notes`;
```

### How it works

Each `db()` query is one transaction: `BEGIN`, then
`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true), …` (that is
`SET LOCAL ROLE` with a parameter — the form PostgREST uses), your query, `COMMIT`. The same
statement blanks the legacy per-claim settings (`request.jwt.claim.sub`, `.role`, `.email` and
`request.jwt.claim`), which Supabase's `auth.*` functions read first, so a value left on the
connection or set as a role default can never override the identity. Both settings
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
and set `backend({ postgres: { rls: { migrate: false } } })`. Without the grant, the first scoped query fails with
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
- With `backend({ supabase })` the secret key (`DENEXT_SECRET_KEY`, `sb_secret_…`) and the legacy
  `service_role` JWT run as `service_role`, with no row-level security — as on Supabase. Keep them
  server-side, never in a browser bundle. Server code doesn't need either: `db.service()` is its
  unscoped connection (and without `supabase` it is the only one).
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
          notes: { events: ["insert", "update", "delete", "truncate"], key: "id" }, // the defaults
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

| Option     | What it does                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initial`  | The rows to start from. A new array replaces the hook's rows (and clears `stale`).                                                                                                                                                                     |
| `filter`   | One column and one operator of Supabase's `eq neq lt lte gt gte in`: `{ list_id: 42 }`, `{ priority: { gte: 3 } }`, `{ status: { in: ["open", "blocked"] } }`, or `"list_id=eq.42"`, `"status=in.(open,blocked)"`. Applied in SQL, after the policies. |
| `events`   | The kinds of change to apply and report (default all): `["insert", "update", "delete", "truncate"]`.                                                                                                                                                   |
| `key`      | The rows' key column, as configured for the table (default `"id"`).                                                                                                                                                                                    |
| `schema`   | The table's schema, for a table outside `public` (one the publication lists, or a configured table with a `schema`).                                                                                                                                   |
| `onChange` | Called with each batch: `{ op: "insert" \| "update", key, row }`, `{ op: "update", key, oldKey, row }` when the key changed, `{ op: "delete", key }`, `{ op: "truncate" }`; `update` and `delete` carry `old` for a table configured `old: "full"`.    |
| `onResync` | Called when changes may have been missed: re-read and pass the rows as `initial`.                                                                                                                                                                      |
| `enabled`  | `false` keeps the hook idle.                                                                                                                                                                                                                           |

From a subscriber's side, `insert` means a row entered their view — inserted, or updated so their
policies or filter now match it — and `delete` means one left it: deleted, or updated out of their
policies or filter. `truncate` empties the list (it reaches only subscribers who could see rows of
the table). Rows keep arrival order; sort them when you render. The same tables also serve
[`supabase.channel()`](#supabase-realtime-supabasechannel), with Supabase's own event semantics.

### How it works

1. **Triggers send keys, never rows.** The first subscription applies migrations
   `backend_realtime_0001` to `0003` (the trigger function `denext_realtime_notify()`, replaced
   twice, and `denext_realtime_truncate()`), `0004` (the `realtime` schema: `realtime.messages`,
   `realtime.topic()`, `realtime.send()`, `realtime.broadcast_changes()`), `0005` (the shared
   presence tables) and one migration per table (`backend_realtime_t_<table>_<hash>`): an
   `AFTER INSERT OR UPDATE OR DELETE … FOR EACH ROW` trigger that sends
   `pg_notify('denext_realtime', '{"table","op","key","old_key"?,"ts"}')`, and an
   `AFTER TRUNCATE … FOR EACH STATEMENT` one. A NOTIFY payload is capped at 8000 bytes, and a row
   would leak past the policies, so only the key travels; a key too long to send becomes a
   "re-read" signal instead of failing the write. A `timestamptz` key travels in UTC, so sessions
   with different `TimeZone` settings agree on it. The one exception is the **old row** of a table
   configured `old: "full"`: its trigger adds the row as it was before an update or delete, when it
   fits (about 7.5 KB of JSON — a larger one is left out and the change says so). On a table with
   row-level security on (or not known to be off), it is delivered only to subscribers who could
   see the row before the change, and only with the first change to that row in a burst (a later
   change's old row is an intermediate state nobody re-read for them). Everyone else gets the key,
   as Supabase sends under row-level security. A table with row-level security off sends it to
   every subscriber. Changing a table's `events`, `key` or `old` installs a
   new migration that replaces its triggers; a table removed from the options keeps them until you
   `drop trigger denext_realtime on <table>` (and `denext_realtime_truncate`).
2. **One listener per server instance.** A single connection `LISTEN`s (the driver re-listens after
   a lost connection, and every subscriber is told to re-read, since changes sent meanwhile are
   lost). Notifications are coalesced for 16 ms, as Live coalesces its own pushes: within a burst
   the latest change per key wins. One burst is delivered at a time: changes that arrive while its
   re-reads run go out together in the next.
3. **Re-read as each subscriber.** Subscribers with the same identity, table and filter form a
   group, and each group's changed rows are read back with one query
   (`select … where key = any(…)`, 1 000 keys per statement) through the RLS-scoped client — `role`
   and `request.jwt.claims` set for that identity, exactly as `db()` does. A burst costs one query
   per identity, not one per subscriber per row: a 500-row transaction watched by two users is one
   flush and two re-reads. Keys and the filter value are compared in the column's own type (read
   once from the catalog), so the primary key — and an index on a filter column — serves the
   re-read, and each query runs under a transaction-local `statement_timeout` (`queryTimeoutMs`); a
   re-read that fails or times out becomes a "re-read" signal for that group.
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

**Limits.** Each identity — a signed-in user across all their connections, or the signed-out
visitors at one client address (`clientIpForLimits({ bucket: true })`, an IPv6 address counting
as its `/64`: one Live connection when no address is
known, or when it is a loopback/private socket peer — a reverse proxy every visitor shares; set
`trustForwardedHeaders` behind one, or name its client-address header in `rateLimitHeader` (believed
from `rateLimitTrustedProxies`, or a loopback/private peer under `trustForwardedHeaders`), to key
on each visitor's address; `rateLimitLocalAddresses` counts such a peer as itself) — may hold
`maxSubscriptionsPerIdentity` subscriptions (default 64), which also bounds
the distinct filters (re-read groups) it adds to a burst; the instance holds `maxSubscribers`. An
unsubscribed key is forgotten at once. One whose connection closed is kept for 15 seconds so a
reconnect resumes it, but only while there is room: at either cap the oldest such subscription
gives way, and only live subscriptions refuse a new one (the browser sees `denied`). Subscribing
runs one key-only query; at most four run at a time, and each identity may start 32 in a burst,
then 8 a second. Server-side `tableChanges` subscriptions count toward `maxSubscribers` only.

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

### Supabase Realtime: `supabase.channel()`

The app also speaks Supabase Realtime's own protocol: `/realtime/v1/websocket` (Phoenix channels,
serializer `1.0.0` and `2.0.0`, binary broadcast frames included) and the REST broadcast
`/realtime/v1/api/broadcast`. So the stock `@supabase/supabase-js` client, pointed at the app,
works unchanged — `postgres_changes`, broadcast, presence and private channels:

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient("https://app.example.com", publishableKey);
supabase
  .channel("notes")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "notes", filter: "priority=gte.3" },
    (payload) => console.log(payload.eventType, payload.new, payload.old),
  )
  .subscribe();
```

**Which tables.** Supabase's way works: `alter publication supabase_realtime add table notes` opts a
table in (the publication is created, empty, if it does not exist — so a Supabase migration that
alters it runs unchanged). The publication is read when realtime starts and every 10 seconds after,
so a table added or dropped while the app runs follows; under the notify source each such table
gets its triggers then (and loses them when it leaves). It needs a one-column primary key (its
key), and its old row follows Supabase: the whole row with `REPLICA IDENTITY FULL` and no row-level
security, else the key. `realtime({ tables })` still works, alongside — a table named in both is
the configured one — and `publication: false` turns the publication off (or names another one).

**postgres_changes.** A binding's `schema` and `table` select among those tables (`*` or no table:
all of them in the schema; a configured table's schema is `public` unless set); `event` is `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` or `*`; `filter` takes one
column and one of `eq neq lt lte gt gte in` (`"status=in.(open,blocked)"`, up to 100 values), on a
single table. The payload has Supabase's shape — `schema`, `table`, `commit_timestamp`,
`eventType`, `new`, `old`, `errors`, typed through `columns` — and, as in Supabase under row-level
security:

- an `INSERT` or `UPDATE` reaches a subscriber only when their SELECT policies (and the filter)
  return the row, re-read as them, exactly as for `useTableChanges`; an update that moves a row out
  of their view sends nothing;
- a `DELETE` reaches only subscribers who could see the row (denext tracks the keys each one was
  sent — Supabase sends deletes to every subscriber of the table);
- `old` holds the key column, which is what Supabase sends for a table under RLS; with
  `old: "full"` on the table it holds the whole old row, when it fitted the notification (else the
  key, and `errors: ["Error 413: Payload Too Large"]`), for a subscriber who could see the row
  before the change. Under row-level security a row that only just entered their view, or a later
  change in the same burst, carries the key alone. A row too large to deliver (1 MiB) arrives as
  its key with the same error;
- `TRUNCATE` reaches subscribers who could see rows of the table;
- every change to a row within one burst (changes 16 ms apart are one) is sent, in commit order,
  with the row as it is after the burst — so `new` of an INSERT followed by an UPDATE in the same
  burst is the updated row. A row inserted and deleted within one burst is sent to nobody (except
  the DELETE, to a subscriber who could already see it): once it is gone there is nothing to check
  against the subscriber's policies.

A joined channel gets Supabase's `system` messages: `Subscribed to PostgreSQL` once its bindings
are live, `Replication connection established` when it asked for `config.broadcast.replication_ready`
(the change stream is up before any join is answered), and `status: "error"` when changes may have
been missed (the listener reconnected): re-read.

**Broadcast.** `channel.send({ type: "broadcast", event, payload })` reaches every subscriber of the
topic on every server instance sharing the database; `config.broadcast.self` decides whether the
sender hears itself, `ack` makes `send()` resolve once the server has published it, and an
`ArrayBuffer` payload travels as bytes (serializer `2.0.0`). `channel.httpSend(event, payload)` and
`POST /realtime/v1/api/broadcast` (`{ messages: [{ topic, event, payload, private? }] }`) publish
over HTTP. From the database, Supabase's functions:

```sql
select realtime.send('{"body":"hello"}'::jsonb, 'message', 'room:42', false);

create function notes_broadcast() returns trigger security definer language plpgsql as $$
begin
  perform realtime.broadcast_changes('notes:' || coalesce(new.list_id, old.list_id)::text,
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  return null;
end $$;
create trigger notes_broadcast after insert or update or delete on notes
  for each row execute function notes_broadcast();
```

and from server code `broadcast(topic, event, payload, { private? })` from
`@denext/backend/server`. A public broadcast is one `pg_notify` on `denext_realtime_bus` (one too
large for a notification, over about 7.5 KB, is stored in `realtime.messages` and sent by id). A
private channel's broadcasts — from clients, REST, the server or SQL — are stored in
`realtime.messages`, as Supabase stores them, and carry `meta: { id }`; a private channel that joins
with `config.broadcast.replay: { since, limit }` gets the stored ones since `since` (epoch
milliseconds; at most 25, Supabase's limit) first, each with `meta: { replayed: true, id }`.
Stored messages are deleted after 3 days.

**Presence.** `track()`, `untrack()` and the `sync`, `join` and `leave` events work across
instances: presences are rows in `realtime.denext_presences`, owned by the instance holding the
socket, and each change is announced on the bus. An instance that stops untracks its own; one that
dies stops heartbeating (every 10 s) and the next instance to sweep removes its presences — within
about 40 seconds — and announces the leaves.

**Private channels.** `config: { private: true }` is authorized by the row-level-security policies
on `realtime.messages`, evaluated as the joining user with `realtime.topic()` set to the channel's
topic — Supabase's model, so existing policies apply:

```sql
create policy "members read" on realtime.messages for select to authenticated
  using (exists (select 1 from room_members m
                 where m.user_id = auth.uid() and 'room:' || m.room_id = realtime.topic()));
create policy "members write" on realtime.messages for insert to authenticated
  with check (exists (select 1 from room_members m
                      where m.user_id = auth.uid() and 'room:' || m.room_id = realtime.topic()));
```

SELECT lets a user receive (`extension` is `broadcast` or `presence`, so a policy can split them),
INSERT lets them send broadcasts and track presence; without SELECT the join is refused. The check
runs once per join — a transaction that inserts probe messages, switches to the user's role and
claims, and is always rolled back.

**Who is connected.** With [`backend({ supabase })`](#supabase-keys-and-access-tokens) keys installed, the socket
must carry a valid `apikey` (refused with a 401 otherwise), and the channel's `access_token` decides
who it is, verified as `resolveIdentity()` verifies a bearer: a user's access token is that user
under their policies, until its `exp` — then the channel closes ("Token has expired"), as
Supabase's does, unless a refreshed token arrived first (supabase-js pushes it on refresh, and it is
verified again); the secret key is `service_role` (past every policy, private channels included);
the publishable or anon key means "no user". A token that is refused (a bad signature, expired, an
unknown key) refuses the join, or closes a joined channel. Without a user token, a socket opened
from the app's own origin is the visitor's denext session — re-read every minute; a session that
ends or changes closes the socket so the client reconnects as whoever it is now — and a socket from
another origin is `anon` (a cross-site page must not act as the visitor). The REST broadcast
resolves its caller the same way (`apikey` header, `Authorization: Bearer`).

**Limits** (`realtime({ socket: { … } })`): `maxConnections` (10 000 per instance),
`maxConnectionsPerAddress` (100 per client address, `clientIpForLimits()`),
`maxChannelsPerConnection` (100), `maxEventsPerSecond` (100 per socket: more are dropped, twice
that closes the socket), and `maxPayloadBytes` (256 KiB per broadcast or presence state). A socket
that stops reading (8 MiB of unsent output) or stops heartbeating (75 s) is closed. Each binding
counts toward `maxSubscriptionsPerIdentity`. `socket: false` turns the endpoint off.

### denext's own hooks: `useBroadcast` and `useRealtimePresence`

The same channels without supabase-js, from `@denext/backend/client`. They share one WebSocket per
page to the endpoint above (same-origin, so it is the visitor's session and needs no key), reconnect
and rejoin by themselves, and meet supabase-js clients, SQL's `realtime.send()` and the server's
`broadcast()` on the same topics — on every server instance.

```tsx
"use client";
import { useBroadcast, useRealtimePresence } from "@denext/backend/client";

export function Room({ id, me }: { id: string; me: { id: string; name: string } }) {
  const { last, send } = useBroadcast<{ text: string }>(`room:${id}`, { event: "message" });
  const { peers } = useRealtimePresence(`room:${id}`, { name: me.name }, { presenceKey: me.id });
  return (
    <>
      <p>{Object.keys(peers).length} here — last: {last?.payload.text}</p>
      <button type="button" onClick={() => send("message", { text: "hi" })}>Say hi</button>
    </>
  );
}
```

`useBroadcast(topic, { event?, onMessage?, private?, self?, replay?, enabled? })` returns
`{ last, status, error, send }` — `send(event, payload)` resolves `"ok"` once the server has
published it. `useRealtimePresence(topic, state?, { presenceKey?, private?, enabled? })` returns
`{ peers, status, error }`: it tracks `state` (a new value re-tracks, `undefined` untracks) and lists
everyone present by key. Hooks on one topic in a page share its channel (the first one's options
apply). `realtimeClient()` is the page's client, and `new RealtimeClient(url)` one for another
endpoint. These are separate from [Live](/docs/live)'s `useChannel` / `usePresence`, which keep
their own contracts (Live presence is per server instance).

### The logical-replication source

By default changes come from triggers and `pg_notify` — which works on any Postgres, but every
transaction that NOTIFYs takes the notification queue's lock at commit, so committing writers
serialize behind it. `realtime({ source: "logical" })` reads them from the write-ahead log instead:
each server instance creates a temporary `pgoutput` slot on a reserved connection and reads it with
`pg_logical_slot_get_binary_changes()` every `logical.pollMs` (50 ms by default; a full batch of
`logical.maxChanges` is followed at once), for the tables of `supabase_realtime` and of
`denext_realtime` (which holds the configured tables). No trigger runs on the write path (existing
ones are disabled; switching back enables them), and `commit_timestamp` is the real commit time.
The rows are still re-read as each subscriber. It needs `wal_level = logical` (a server restart),
the connecting role's `REPLICATION` attribute (`alter role app replication`) and a client with
`reserve()`; a temporary slot ends with its connection, so a dead instance holds no WAL back, and a
lost connection is reopened with a re-read signal. All instances must use the same source.

Committed single-row INSERT transactions per second, on one table, against Postgres 17 (8 vCPU
shared VM; `bench/realtime-source.ts`, 8 s per cell, no realtime as the 100 % baseline):

| source           | 1 writer    | 8 writers   | 32 writers    |
| ---------------- | ----------- | ----------- | ------------- |
| none             | 3 821       | 13 215      | 16 196        |
| notify (default) | 2 411 (63%) | 5 943 (45%) | 2 887 (18%)   |
| logical          | 1 831 (48%) | 9 945 (75%) | 16 232 (100%) |

With `synchronous_commit = off` the 32-writer cells were 34 614 / 13 541 (39 %) / 36 217 (105 %).
The notify source's cost grows with concurrent writers; the logical source's does not, and its
single-writer cell is within the noise of the shared host. Use notify for modest write rates and
logical when many connections write realtime tables at once.

### Options

| Option                        | Default               | What it does                                                                                                                                                                 |
| ----------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tables`                      | —                     | `{ name: { events?, key?, schema?, old? } }`: the tables, their events, key column, schema and old-row mode (`"key"` or `"full"`). Optional when the publication lists them. |
| `publication`                 | `"supabase_realtime"` | Also the tables of this publication (created if missing; re-read every 10 s); `false` turns it off.                                                                          |
| `source`                      | `"notify"`            | `"logical"`: changes from logical decoding instead of triggers and NOTIFY ([see above](#the-logical-replication-source)).                                                    |
| `logical`                     | —                     | `{ pollMs?: 50, maxChanges?: 10000 }`: the logical source's read interval and batch.                                                                                         |
| `revalidate`                  | `false`               | `revalidateTag("table:<name>")` per burst; `{ owner: "one" }`: on one instance per database.                                                                                 |
| `migrate`                     | `true`                | Install the triggers on first use. `false` when a DBA runs `realtimeSetupSql(options)` instead.                                                                              |
| `maxSubscribers`              | 10 000                | Subscriptions per server instance (a closed tab's is kept 15 s for a reconnect, while there is room).                                                                        |
| `maxSubscriptionsPerIdentity` | 64                    | Subscriptions per signed-in user, or per signed-out client address (and so its distinct filters).                                                                            |
| `maxTrackedKeys`              | 10 000                | Keys tracked per subscription, for deletes.                                                                                                                                  |
| `queryTimeoutMs`              | 5 000                 | `statement_timeout` of each re-read and subscribe-time query (transaction-local).                                                                                            |
| `socket`                      | `true`                | Serve `/realtime/v1/*` for supabase-js; `false` turns it off; an object sets its [limits](#supabase-realtime-supabasechannel).                                               |

Realtime needs a Postgres client with `listen`: `Deno.SQL` (denext's [Deno toolchain](/docs/toolchain)), or the npm
`postgres` package through `postgres: { sql: fromPostgresJs(postgres(url)) }` on stock Deno.
Without one, `onTableChange` and `tableChanges` throw `RealtimeUnsupportedError`
(`code: "unsupported"`), browser subscriptions are refused, and `denext dev` says so at startup.
NOTIFY payloads are capped at 8000 bytes (why rows are re-read rather than carried, and why a full
old row has a size limit under the notify source), and notifications serialize committing writers —
the [logical source](#the-logical-replication-source) removes both.

## Auto-REST

Opt in, and the tables, views and functions of your schemas are served as HTTP routes with
PostgREST 12's wire format, so the browser (or a native app) can read and write them directly —
every statement run through `db()`, so [row-level security](#row-level-security) scopes it to the
request's user, or to `anon`. The stock `@supabase/supabase-js` client works against the routes
unchanged (`from()`, `rpc()`, `schema()`), and so does denext's own client, which has the same API.

```ts
// denext.config.ts
import { backend } from "@denext/backend";

export default {
  plugins: [
    backend({
      postgres: {},
      rest: {}, // the RLS-enabled tables of "public" the anon / authenticated roles can reach
    }),
  ],
};
```

```ts
// app/notes/notes-api.ts — used from client components
import "../../.denext/rest.ts"; // the generated types
import { from, rpc } from "@denext/backend/client";

export async function latestNotes(listId: number) {
  const { data, error, count } = await from("notes")
    .select("id, body, author:profiles(name), tags!inner(label)", { count: "exact" })
    .eq("list_id", listId)
    .or("pinned.is.true,created_at.gt.2026-01-01")
    .order("id", { ascending: false })
    .limit(20);
  if (error) throw error; // a RestClientError: { code, status, message, details, hint }
  return { notes: data ?? [], total: count };
}

export const addNote = (listId: number, body: string) =>
  from("notes").insert({ list_id: listId, body }).select().single();
export const saveNote = (note: { id: number; body: string }) =>
  from("notes").upsert(note).select("id").single();
export const removeNote = (id: number) => from("notes").delete().eq("id", id);
export const searchNotes = (query: string) => rpc("search_notes", { query }).limit(10);
```

The builder is supabase-js's: every filter (`eq` / `neq` / `gt` / `gte` / `lt` / `lte`, `like` /
`ilike` and their `AllOf` / `AnyOf`, `regexMatch`, `is`, `isDistinct`, `in` / `notIn`, `contains`
/ `containedBy` / `overlaps`, the `range*` operators, `textSearch`, `match`, `not`, `or`,
`filter`), the transforms (`select`, `order` / `limit` / `range` with `referencedTable`, `single`,
`maybeSingle`, `csv`, `geojson`, `explain`, `rollback`, `maxAffected`, `abortSignal`,
`throwOnError`), and `insert` / `upsert` / `update` / `delete`, resolving to
`{ data, error, count, status, statusText }`. `restClient({ url, headers, fetch, schema })` makes
a client with a base URL (an app on another origin, a native app's `Authorization: Bearer …`
session); `from` and `rpc` use the page's own origin and cookies; `.schema("api")` targets another
exposed schema.

With `@supabase/supabase-js` instead, point it at the app — `createClient(appUrl,
publishableKey)` — and `supabase.from("notes")…` and `supabase.rpc("fn", args)` reach these
routes. Pass the generated `Database` type to `createClient<Database>()` for typed queries.

**Who a request is.** The routes use the backend's shared request identity: with
`backend({ supabase })` they read supabase-js's `apikey` and `Authorization: Bearer` headers — a
user's access token runs as `authenticated` with its claims, the publishable key as `anon`, and the
secret key as `service_role`, which bypasses row-level security and — as in PostgREST — sees every
relation and function of the exposed schemas, granted or not (still only by catalog name). Without a token, the denext session (the auth cookie,
or a native app's `nat_…` token) decides, then `anon`. A token or key that is presented and refused
is a `401` before any statement — `PGRST303` for an expired token, `PGRST301` otherwise — with
`WWW-Authenticate: Bearer error="invalid_token"`.

### Routes

`GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE` on `/rest/v1/<table>`; `GET`, `HEAD` and
`POST` on `/rest/v1/rpc/<function>`; and `GET /rest/v1`, the OpenAPI description:

| Request                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select=id,body`                                            | The columns to return (default `*`). `alias:col`, `col::text` (a cast to a built-in or one of your schemas' types), `meta->a->>b` (JSON paths, named after the last key).                                                                                                                                                                                                   |
| `select=*,author:users(name)`                               | Embed related rows through a foreign key: many-to-one (an object), one-to-many (an array), one-to-one, and many-to-many through a junction whose foreign-key columns are part of its primary key. Nested embeds go 8 levels deep.                                                                                                                                           |
| `users!inner(name)`, `users!author_id(name)`                | `!inner` keeps only the parent rows with a match; a hint (a constraint, a foreign-key column, or the junction) picks one of several relationships. Several without a hint are a `300` (`PGRST201`) listing them.                                                                                                                                                            |
| `...users(name)`, `comments(count)`                         | A spread merges a to-one relation's columns into the parent; `count` (when the target has no such column) is the number of related rows.                                                                                                                                                                                                                                    |
| `users.name=eq.x`, `users.order=name`, `users.limit=2`      | Filter, order and page an embedded resource; `users=not.is.null` (or `is.null`) filters the parent on whether it has one.                                                                                                                                                                                                                                                   |
| `col=eq.value`                                              | A filter: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like` / `ilike` (`*` or `%`), `match` / `imatch` (regular expressions), `is` (`null`, `true`, `false`, `unknown`), `isdistinct`, `in.(a,"b,c")`, `cs` / `cd` / `ov`, the range operators `sl` / `sr` / `nxl` / `nxr` / `adj`, and `fts` / `plfts` / `phfts` / `wfts` with an optional configuration (`fts(english).cat`). |
| `col=not.eq.value`, `col=like(any).{a*,b*}`                 | A filter negated; `(any)` / `(all)` of an array for the comparisons and patterns.                                                                                                                                                                                                                                                                                           |
| `or=(a.eq.1,and(b.gt.2,c.is.null))`                         | Logic trees, nested and negated (`not.or=`), on an embed too (`users.or=(…)`). Every filter is ANDed with them.                                                                                                                                                                                                                                                             |
| `order=col.desc.nullslast,meta->>k`                         | The order: `asc` / `desc`, `nullsfirst` / `nullslast`, JSON paths.                                                                                                                                                                                                                                                                                                          |
| `limit=20&offset=40`, or a `Range: 40-59` header            | Paging, capped at `maxRows`. The response carries `Content-Range: 40-59/*`.                                                                                                                                                                                                                                                                                                 |
| `Prefer: count=exact`, `planned`, `estimated`               | Count the matching rows too: `Content-Range: 40-59/1234`, and `206` when the page is not all of them. `exact` is signed-in only by default (`exactCount`).                                                                                                                                                                                                                  |
| `Accept: application/vnd.pgrst.object+json`                 | One object instead of an array; zero or several rows are a `406` (and a write is rolled back). `;nulls=stripped` drops null fields.                                                                                                                                                                                                                                         |
| `Accept: text/csv`, `application/geo+json`                  | CSV, or a GeoJSON FeatureCollection (needs PostGIS; a `406` without it).                                                                                                                                                                                                                                                                                                    |
| `POST` with an object or an array of objects                | Insert. `columns=a,b` names the keys used (a missing one is NULL, or its default with `Prefer: missing=default`); a `text/csv` or form body works too.                                                                                                                                                                                                                      |
| `Prefer: resolution=merge-duplicates` (`ignore-duplicates`) | An upsert on the primary key, or on `on_conflict=col`.                                                                                                                                                                                                                                                                                                                      |
| `PATCH` with an object, plus filters                        | Update the matching rows. A request without a filter is refused (`400`, `21000`), as is `limit` on a `PATCH` / `DELETE`.                                                                                                                                                                                                                                                    |
| `DELETE` plus filters                                       | Delete the matching rows. A request without a filter is refused.                                                                                                                                                                                                                                                                                                            |
| `Prefer: return=representation` on a write                  | Answer with the written rows (`select=` shapes them, embeds included); the default, `return=minimal`, answers `201` / `204` with no body; `return=headers-only` sets `Location`.                                                                                                                                                                                            |
| `Prefer: tx=rollback`, `handling=strict, max-affected=N`    | Run, answer, and roll back; refuse (and roll back) a write that touched more than `N` rows. Under `handling=strict` an unknown preference is a `400`.                                                                                                                                                                                                                       |
| `/rpc/fn` (`POST` a JSON object, or `GET` with `?arg=v`)    | Call a function the roles may EXECUTE, by its arguments' names (overloads too). A function of one unnamed `json` / `jsonb` argument (or any one json argument with `Prefer: params=single-object`) takes the whole body.                                                                                                                                                    |
| `/rpc/fn?select=…&col=gt.1&order=…`                         | A set-returning function's rows are filtered, ordered, paged, counted and embedded like a table's; a scalar comes back as its JSON value, `void` as `204`. `GET` runs read-only, so a function that writes needs `POST`.                                                                                                                                                    |
| `Accept-Profile: api` / `Content-Profile: api`              | Another schema of `rest.schemas` (supabase-js's `.schema("api")`); one that is not exposed is a `406`.                                                                                                                                                                                                                                                                      |
| `select=*,full_name`, `select=*,author_of(*)`               | Computed fields and relationships: a function in the table's schema whose one argument is the table's row — returning a value (a field, filterable and orderable), or rows of another relation (an embed: `SETOF t ROWS 1` or a single row is to-one). A computed relationship of the same name wins over a foreign key.                                                    |
| `book_view?select=*,authors(*)`                             | Views embed too: a view inherits its base tables' foreign keys and unique keys through its column lineage (plain column references, followed through views over views), so it embeds from, into and through views.                                                                                                                                                          |
| `order=author(name).desc`                                   | Order by a column of a to-one embed (`PGRST118` for a to-many one).                                                                                                                                                                                                                                                                                                         |
| `or=(year.gt.2000,authors.name.eq.Ann)`                     | A logic tree may test an embedded resource's column: the parent row matches when a related row does (`PGRST108` when the embed is not in `select`).                                                                                                                                                                                                                         |
| `select=author_id,total:price.sum(),count()`                | Aggregates — `sum`, `avg`, `min`, `max`, `count`, with casts before and after (`price::int.sum()::text`) — grouped by the other selected columns and embeds. Off by default (`aggregates: true`; `PGRST123` otherwise): one reads every matching row.                                                                                                                       |
| `PUT` with one complete row, plus `pk=eq.v` filters         | A single-row upsert: the filters must be exactly the primary key (`PGRST105`, `405`), the body every writable column (`PGRST102`), and the body's key the URL's (`PGRST115`). `200` with the row, or `204`.                                                                                                                                                                 |
| `GET /rest/v1`                                              | PostgREST's OpenAPI (Swagger 2.0) document for the schema `Accept-Profile` picks, listing only what the requester can use (the secret key sees everything). `/rest/v1/` redirects there. It is separate from `@denext/openapi`'s document, which describes route handlers.                                                                                                  |
| `Accept: application/vnd.pgrst.plan`                        | The execution plan (`+json` / `+text`, `options=analyze\|verbose\|…`), only with `explain: true`; analyzed statements are rolled back.                                                                                                                                                                                                                                      |

**What is safe.** A schema, table, column, function, argument or type name is never taken from
the request as text: each is looked up in the catalog the plugin read and only a name found there
is quoted into the SQL, so an unknown column, relationship or operator is a `400`, never a
statement. An embed follows the catalog's foreign keys, never a name from the request. Every
filter value and every JSON-path key is a `$n` parameter cast to its column's type, and a request
body is one JSON parameter expanded by `json_populate_recordset` against the table's own row type
(or `json_to_record` against a function's argument types) — Postgres parses every value. The rows
come back as one JSON text built by Postgres (`json_agg`), so a `bigint` keeps its digits. Each
request runs in a transaction that sets the role and claims, then a `statement_timeout` (5 seconds
by default); a read's transaction is READ ONLY. A request takes at most 64 filters, 256 select
items and 8 levels of embedding.

**The shared pool.** The routes use the app's one Postgres pool, so at most `maxConcurrent` REST
statements run at once — half the pool's `max` by default (`Deno.SQL` and postgres.js report it;
5 when the client does not). A request past that waits up to a second for a slot, then is answered
`503` (`PGRST003`) with `Retry-After: 1`, leaving connections for the rest of the app. A full count
(`Prefer: count=exact`) reads every matching row, so by default only a signed-in request may ask
for one; an anonymous one is refused with `400` (`PGRST100`) and a hint (`exactCount: "all"`
allows everyone, `"never"` no one). `count=planned` (the planner's estimate) is open to everyone,
and `count=estimated` counts exactly only while the estimate is at most `maxRows`.

The plugin does not rate-limit the routes itself. [`middleware.ts`](/docs/middleware) runs before
them, so `rateLimit` from `denext/server` can guard them there:

```ts
// middleware.ts
import { apiErrorResponse, isApiError, next, rateLimit } from "denext/server";

// Per client address (an IPv6 /64), method and path; off for an untrusted loopback/private peer.
const limitRest = rateLimit({ max: 300, windowMs: 60_000 });

export async function middleware(request: Request) {
  if (new URL(request.url).pathname.startsWith("/rest/v1/")) {
    try {
      await limitRest({ request, params: {}, ctx: {}, method: request.method as "GET" });
    } catch (error) {
      if (isApiError(error)) return apiErrorResponse(error); // 429 with Retry-After
      throw error;
    }
  }
  return next();
}
```

**CSRF.** A write carrying cookies follows the same rule as Server Actions and `csrf()`: a
cross-site one is refused (`403`, `csrf_failed`). A request whose identity is a Supabase access
token or the secret key needs no such check, nor does a native app's bearer token
(`Authorization: Bearer nat_…`, which `auth()` reads instead of the cookie);
the exemption uses `auth()`'s own parser (`nativeBearerToken` from `denext/server`), so it applies
exactly when the session comes from the token, never from the cookie.

**Errors** are PostgREST-shaped JSON — `{ code, message, details, hint }` — with Postgres's
SQLSTATE as the code where Postgres refused (`23505` → `409`, `42501` → `403`, `23502` / `22P02` →
`400`, `57014` statement timeout → `504`), and PostgREST's own codes otherwise: `PGRST100` (a
malformed query), `PGRST102` (a bad body), `PGRST103` (a range past the rows), `PGRST106` (a
schema that is not exposed), `PGRST107` (a media type not produced), `PGRST116` (not exactly one
row), `PGRST122` (an unknown preference under `handling=strict`), `PGRST124` (more rows than
`max-affected`), `PGRST200` / `PGRST201` (no relationship, or several, for an embed — `300` with
the candidates in `details`), `PGRST202` / `PGRST203` (no function, or several overloads),
`PGRST205` (no such table) or `42703` (no such column). A 5xx hides the database's message (it is
logged).

### Which tables and functions

The plugin reads the catalog when the server starts, and again when a request names a table or
function it does not know (at most every 2 s under `denext dev`, every 10 s otherwise), so a table
a migration creates while the server runs gets its route without a restart. A change to a table it
already knows (a new column, a changed grant) is picked up on PostgREST's own signal,
`NOTIFY pgrst, 'reload schema'`: every replica listens, and `denext migration up` (with the stack's
migrations service and `migratePostgres`) sends it after applying anything. Send it yourself after
a manual DDL change, or make Postgres send it on every one with PostgREST's event trigger
(`create event trigger … on ddl_command_end execute procedure …` calling
`notify pgrst, 'reload schema'`; creating it needs a superuser). The relations of the exposed schemas that the `anon`
or `authenticated` role holds a privilege on — `SELECT`, `INSERT` or `UPDATE` on any column, or
`DELETE` — the foreign keys between them, and the functions either role may `EXECUTE`. A table
with no grant to either role gets no route, so a table stays private until you `grant`; a function
stays private once you `revoke execute … from public` (Postgres grants EXECUTE to everyone by
default). A function runs as the caller unless it is `security definer`, as in Supabase.

With the default `tables: "*"`, a reachable relation is served only when row-level security
applies to the caller:

| Relation                                                 | Served by `"*"`                                     |
| -------------------------------------------------------- | --------------------------------------------------- |
| a table (or partitioned table) with RLS enabled          | yes — its policies decide the rows                  |
| a view created `with (security_invoker = true)` (PG 15+) | yes — the base tables' policies apply to the caller |
| a table with RLS off                                     | no                                                  |
| an ordinary view (it runs with its owner's rights)       | no                                                  |
| a materialized view, a foreign table                     | no — neither has row-level security                 |

Everything skipped is listed in one warning at startup, with the reason, so a grant that would
have exposed a whole table is visible instead of silent. To serve one anyway, name it:
`tables: ["notes", "public_stats"]` exposes exactly the listed relations, whatever their RLS —
naming a table is your decision that its grants are the policy.

### Generated types

At `denext dev` startup and `denext build`, the plugin writes `.denext/rest.ts` from the live
catalog in the shape `supabase gen types typescript` writes (every relation and function of the
exposed schemas, as the secret key sees them): `Database`, with each exposed
schema's `Tables` (`Row`, `Insert` — columns with a default, or nullable, optional; generated
columns left out — `Update` and `Relationships`), `Views`, `Functions` (`Args` and `Returns`,
overloads as a union), `Enums` and `CompositeTypes`, plus the `Tables<>`, `TablesInsert<>`,
`TablesUpdate<>`, `Enums<>` and `CompositeTypes<>` helpers and `Constants`. Pass `Database` to
`createClient<Database>()` from `@supabase/supabase-js`, or import the file once and denext's
`from("notes")` autocompletes table names, types filters by column, and narrows
`select("id,body")` to those columns. Without a database to read (no `DATABASE_URL` at build time)
the plugin says so, keeps an earlier generated file, or writes a stub under which rows are
`Record<string, unknown>`.

### Options

| Option             | Default                       | What it does                                                                                                                                                                                     |
| ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemas`          | `["public"]`                  | The schemas served, the default first; `Accept-Profile` / `Content-Profile` pick another. `schema: "api"` is a shorthand for one.                                                                |
| `tables`           | `"*"`                         | `"*"`: the reachable RLS tables and `security_invoker` views; or a list of names (`"notes"` or `"api.notes"`), served as named (a listed table the roles cannot reach gets no route).            |
| `basePath`         | `"/rest/v1"`                  | Where the routes live (app-relative; `basePath` is prepended).                                                                                                                                   |
| `maxRows`          | 1000                          | The most rows one read (or set-returning call) returns, whatever `limit` asks for.                                                                                                               |
| `maxBodyBytes`     | 1 MiB                         | The largest request body.                                                                                                                                                                        |
| `statementTimeout` | 5000                          | Each request's `statement_timeout`, in milliseconds.                                                                                                                                             |
| `maxConcurrent`    | half the pool's `max`, else 5 | The most REST statements at once; past it a request waits up to 1 s, then gets `503` + `Retry-After`.                                                                                            |
| `exactCount`       | `"authenticated"`             | Who may send `Prefer: count=exact`: `"authenticated"`, `"all"` or `"never"` (refused with `400`).                                                                                                |
| `explain`          | `false`                       | Serve execution plans (`Accept: application/vnd.pgrst.plan`). Plans show table sizes and indexes: development only.                                                                              |
| `aggregates`       | `false`                       | Allow aggregate functions in `select=` (PostgREST's `db-aggregates-enabled`). An aggregate reads every matching row whatever `limit` says; enable it when the statement timeout bounds the cost. |

Two features are off until you turn them on, because each can cost a lot or reveal a lot:
aggregates (`aggregates: true`) and execution plans (`explain: true`). Everything else on this page
is always on. A view inherits a relationship only through plain column references: a column
computed by an expression has no origin, so a key that needs it is not inherited. The routes are
described by `GET /rest/v1`, not by the `@denext/openapi` document.

## Edge Functions

`backend({ functions: {} })` serves `functions/<name>.ts` (or `functions/<name>/index.ts`) at
`/functions/v1/<name>`: the path and request shape supabase-js's `functions.invoke` uses, so a
Supabase function moves over unchanged. A module that calls `Deno.serve(handler)` (any of its call
shapes) or default-exports a handler (a function, or an object with `fetch`) is a function.

```ts
// functions/hello/index.ts — `denext generate function hello` writes this
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const { name } = await req.json();
  return Response.json({ message: `Hello ${name}!` }, { headers: corsHeaders });
});
```

```ts
// denext.config.ts
backend({
  functions: {
    functions: { "stripe-webhook": { verifyJwt: false } }, // anyone may call this one
  },
});
```

```ts
// the browser, or any client
const { data, error } = await supabase.functions.invoke("hello", { body: { name: "denext" } });
const res = await fetch("/functions/v1/hello", { method: "POST", body: JSON.stringify({ name }) });
```

- **The request.** The function sees the request as Supabase's runtime passes it: the method, the
  headers (`Authorization`, `apikey`, `x-region`, …) and the body, buffered (JSON, text,
  `FormData` and binary alike; at most `maxBodyBytes`). Its URL path starts with the function's
  name — `/functions/v1/hello/users/1?x=1` arrives as `/hello/users/1?x=1` — so a router such as
  Hono with `basePath("/hello")` works as on Supabase.
- **The response** streams back as the function writes it, so server-sent events work.
- **Callers.** Like Supabase's `verify_jwt`, every function requires a valid caller by default and
  answers `401` before it runs otherwise. A valid caller is anything the backend's shared identity
  accepts: a user's access token, the publishable (anon) or secret key with
  `backend({ supabase: … })` — as on Supabase, where the anon key passes `verify_jwt` — or a denext
  auth session (the page's cookie, or a native app's bearer token). A presented credential that is
  refused (a bad or expired token) is a `401` too. A cookie-carrying write from another site is
  refused (`403`), as for Server Actions. `verifyJwt: false`, for the directory or one function, lets anyone call it. A CORS
  preflight (`OPTIONS`) is never checked: the function answers it, as in Supabase's `corsHeaders`
  recipe.
- **Environment.** `Deno.env.get("SUPABASE_URL")` is the app's own URL: `url`, else the app's
  `canonicalOrigin` (or `DENEXT_CANONICAL_ORIGIN`) plus its `basePath`, else the address the server
  listens on as this machine reaches it (`http://127.0.0.1:<port>`). It is never a request's
  `Host`, which a client chooses: a worker keeps its environment for life, next to the service
  key. With none of them known, functions get no `SUPABASE_URL`, and a warning says so. And `SUPABASE_DB_URL` is `DATABASE_URL`; `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY` come from `DENEXT_PUBLISHABLE_KEY` and
  `DENEXT_SECRET_KEY`; `env` adds variables
  for every function or for one. The process environment is visible too.
- **`EdgeRuntime.waitUntil(promise)`** is accepted: the worker stays up, so the work finishes.
- **Errors** come back in Supabase's relay shape, `{ code, message }`: `404 NOT_FOUND`,
  `401 UNAUTHORIZED`, `503 BOOT_ERROR` (the module failed to load, or exports no handler),
  `500 WORKER_ERROR` (the handler threw), `504 WORKER_TIMEOUT` (past `timeoutMs`) and `413` for a
  body over the cap.

### Isolation

Each function runs in a Deno Worker of its own, started on its first request and kept warm: its
own globals and module graph, so a function cannot reach the app's in-memory state or another
function's. A worker that throws outside a request is replaced on the next one. Under
`denext dev` an edit anywhere in the functions directory restarts the workers, and a function
added while the server runs is found on its first request. By default a worker has the server's
permissions; `permissions` gives one its own (`{ net: true, env: true, read: false }`), which needs
Deno's worker options: add `"unstable": ["worker-options"]` to `deno.json` (the plugin refuses to
start without it rather than let Deno exit on the first request). Functions run from source — `denext
build` does not bundle them — so deploy the `functions/` directory with the app, as with `jobs/`.

The directory is `functions/`, or `supabase/functions/` when only that exists (a project moved from
the Supabase CLI). Entries starting with `_` (`_shared/`) or `.` are not functions, nor are test
files. `denext functions` is the Supabase CLI's `functions` group:

```sh
denext functions new hello      # functions/hello/index.ts, served at /functions/v1/hello
denext functions list           # each route, file, and whether it verifies the caller (--json)
denext functions serve          # only the functions host, on :54321 (--port); edits reload
denext functions delete hello --yes
```

There is nothing to `download` or `deploy`: the functions ship inside the app, wherever it runs.

| Option         | Default           | What it does                                                                                          |
| -------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `dir`          | `"functions"`     | The functions directory (relative to the project).                                                    |
| `basePath`     | `"/functions/v1"` | Where the functions are served (app-relative; `basePath` is prepended).                               |
| `verifyJwt`    | `true`            | Require a valid caller before a function runs.                                                        |
| `timeoutMs`    | 150 000           | The longest one request may run; past it the function's request is aborted and the caller gets `504`. |
| `maxBodyBytes` | 20 MiB            | The largest request body passed to a function.                                                        |
| `env`          | `{}`              | Variables every function reads from `Deno.env`, over the process's own.                               |
| `url`          | see above         | The URL functions read as `SUPABASE_URL` (default: `canonicalOrigin`, else the server's own address). |
| `functions`    | `{}`              | Per function, by name: `verifyJwt`, `timeoutMs`, `env`, `permissions`.                                |

A function's worker acknowledges each abort. One that does not within a second (busy in synchronous
code, such as a `while (true) {}`) is terminated and replaced: the requests it was still serving
get `504`, and the next call starts on a fresh worker.

## Vault

`backend({ postgres: {}, vault: {} })` keeps secrets encrypted in your database, in Supabase
Vault's table shape (`vault.secrets`: `id`, `name`, `description`, `secret`, `key_id`, `nonce`,
`created_at`, `updated_at`).

```ts
import { vault } from "@denext/backend/server";

const id = await vault.createSecret("sk_live_…", "stripe_key", "Stripe secret key");
const stripeKey = await vault.get("stripe_key"); // the plaintext, or null
await vault.updateSecret(id, { secret: "sk_live_new" });
const all = await vault.decryptedSecrets(); // the rows of Supabase's vault.decrypted_secrets
```

- **Encryption** is AES-256-GCM, done in the app with a key from `DENEXT_VAULT_KEY` (at least 32
  characters; `openssl rand -base64 32` makes one) or `vault: { key }`. The key never reaches
  Postgres, its logs or a backup. Each write takes a fresh 96-bit nonce, and the row's id is
  authenticated with the ciphertext, so a ciphertext copied onto another row does not decrypt.
- **Rotation.** `key: [newKey, oldKey]` decrypts with either (each row records which key, as
  `key_id`) and encrypts with the first; `vault.rotate()` re-encrypts every row under it.
- **Who can read it.** Only server code. The table has row-level security on and nothing granted
  to `anon` or `authenticated`, so neither REST nor a user's `db()` reaches it.

### Vault in SQL

`vault: { sql: true }` adds Supabase's SQL surface over the same rows: `vault.create_secret(secret,
name, description)`, `vault.update_secret(id, secret, name, description, key_id)` and the
`vault.decrypted_secrets` view, so SQL and migrations written for Supabase run unchanged. Both
sides use one format (AES-256-GCM, the row id authenticated), so the app reads what SQL wrote and
the other way round. It needs the `pgcrypto` extension (trusted: the plugin creates it).

The key still never lives in the database. The app sets it for one transaction at a time, only in
transactions it opens: `vault.withKey(fn)` and every migration `denext db push`, `reset` or `diff`
applies. Anywhere else the functions and the view raise `vault: no key in this transaction`.

```ts
import { vault } from "@denext/backend/server";

const rows = await vault.withKey((sql) =>
  sql`select name, decrypted_secret from vault.decrypted_secrets`
);
```

```sql
-- supabase/migrations/…_secrets.sql, applied with `denext db push`
select vault.create_secret('sk_live_…', 'stripe_key', 'Stripe secret key');
```

What the SQL mode trusts, compared with the app-only vault:

- **The key transits the database session.** For that transaction it sits in a transaction-local
  setting (`set_config('denext.vault_keys', $1, true)`), sent as a bound parameter, so it is not in
  `pg_stat_activity`'s query text or `pg_stat_statements`. Anything running in that same
  transaction — a trigger or function your SQL calls — could read it with `current_setting()`;
  run only your own SQL inside `withKey`.
- **Server logs can capture it.** With `log_statement = 'all'` (or `'mod'` plus a logged write),
  Postgres logs bind parameters; a superuser, the provider, or `auto_explain` with parameter
  logging could see the key. Keep statement logging off for the app's role, or use the app-only
  vault.
- **Encryption runs on the database server**, in PL/pgSQL over pgcrypto's AES block function
  (pgcrypto has no GCM; the code builds it from AES, as specified by NIST SP 800-38D). It is slower
  than WebCrypto — fine for secrets, not for bulk data — and not constant-time.
- **Grants are the same:** only the app's own database user can call the functions or read the
  view; `anon` and `authenticated` get nothing, through REST or `db()`.

Without `sql: true` none of this exists: the key stays in the app process, and secrets are read
with `vault.get()` / `vault.decryptedSecrets()`.

## Queues

`backend({ postgres: {}, queues: {} })` adds message queues with [pgmq](https://github.com/pgmq/pgmq)'s
API, written in plain SQL: no extension to install. SQL written for Supabase Queues runs
unchanged, and so do Supabase's `pgmq_public` functions for the REST API.

```ts
import { queue, queueConsumer, queues } from "@denext/backend/server";

await queues.create("emails");
const emails = queue<{ to: string }>("emails");
await emails.send({ to: "a@example.com" }, { delay: 10 }); // visible in 10 s
const batch = await emails.read({ vt: 60, qty: 10 }); // hidden from other readers for 60 s
await emails.archive(batch.map((m) => m.msgId));
```

```ts
// jobs/send-emails.ts — drains the queue every minute
import { queueConsumer } from "@denext/backend/server";

export default queueConsumer<{ to: string }>({
  queue: "emails",
  schedule: "* * * * *",
  maxAttempts: 5, // then archived unhandled
  handler: async ({ message }) => await sendEmail(message.to),
});
```

```sql
-- the same, in SQL
select pgmq.create('emails');
select * from pgmq.send('emails', '{"to":"a@example.com"}');
select * from pgmq.read('emails', 60, 10);
select pgmq.archive('emails', 1);
```

- **The functions** are pgmq 1.4's: `create`, `create_unlogged`, `drop_queue`, `list_queues`,
  `send`, `send_batch`, `read` (with a visibility timeout), `read_with_poll`, `pop`, `archive`,
  `delete`, `set_vt`, `purge_queue`, `metrics`, `metrics_all`. Each queue is two tables,
  `pgmq.q_<name>` and its archive `pgmq.a_<name>`. A database that has the pgmq extension already
  keeps it; the plugin then adds only `pgmq_public`.
- **Queue names** are 1–47 lowercase letters, digits or `_`, checked in SQL before any table name
  is built from them.
- **Who can use a queue.** Every function runs with the caller's rights (`security invoker`, as in
  pgmq). The server's `queue()` uses the app's own database user; `queue(name, { as })` acts as a
  user. Through REST (`supabase.schema("pgmq_public").rpc("send", { queue_name, message })`),
  `anon` and `authenticated` can call the `pgmq_public` functions, but reach a queue only once you
  grant them its table, and the table's row-level security policies then apply:

  ```sql
  grant select, insert, update, delete on pgmq.q_tasks to authenticated;
  alter table pgmq.q_tasks enable row level security;
  create policy "own tasks" on pgmq.q_tasks to authenticated
    using (message ->> 'owner' = auth.uid()::text)
    with check (message ->> 'owner' = auth.uid()::text);
  ```

- **`queueConsumer`** returns a [job](/docs/jobs): each run reads batches of `batchSize` (default
  10) under `vt` seconds (default 30), runs the handler on each message, and archives it
  (`onSuccess: "delete"` deletes it). A handler that throws leaves the message to reappear after
  `vt`; one read more than `maxAttempts` times (default 5) is archived unhandled and logged.

## Vector search (pgvector)

The helpers work with Postgres's [pgvector](https://github.com/pgvector/pgvector) extension, which
your database must have (most providers include it; the `pgvector/pgvector` image does locally).
Nothing needs it until you use it, and then a missing extension is a clear error that names the
fix.

```sh
denext generate vector-search documents   # migrations/<stamp>_documents_vector_search.sql
denext db push
```

The migration creates the `vector` extension, a `documents` table (`id`, `content`, `metadata`,
`embedding vector(1536)` — change the dimensions to your model's) with an HNSW index and
row-level security, and Supabase's `match_documents(query_embedding, match_threshold,
match_count)` (`match_<table>` for another table). `vectorSearchSql({ table, dimensions, fn,
distance })` from `@denext/backend` returns the same SQL with other settings.

```ts
import { db, matchDocuments, toVector } from "@denext/backend/server";

const matches = await matchDocuments({ embedding, matchThreshold: 0.78, matchCount: 10 });
// [{ id, content, metadata, similarity }], closest first, under the caller's row-level security
await db()`insert into documents (content, embedding) values (${text}, ${
  toVector(embedding)
}::vector)`;
```

`vectorSearchSql` takes `table`, `dimensions`, `fn` (the function's name) and `distance`
(`"cosine"`, `"inner_product"` or `"l2"`); the function is also callable through REST `/rpc`.
`toVector` / `fromVector` convert between number arrays and pgvector's text form, and
`requireVector()` checks for the extension.

## Database webhooks

`backend({ postgres: {}, webhooks })` brings Supabase's database webhooks without `pg_net`: a
trigger records each change, and the app delivers it.

```ts
// denext.config.ts
backend({
  postgres: {},
  webhooks: {
    hooks: { "order-created": { url: "https://hooks.example.com/orders" } },
    secret: Deno.env.get("DENEXT_WEBHOOK_SECRET"), // signs every delivery
  },
});
```

```sql
create trigger order_created after insert on orders for each row
  execute function supabase_functions.http_request('order-created');
```

- **The payload** is Supabase's: `{ "type": "INSERT", "table": "orders", "schema": "public",
  "record": {…}, "old_record": null }` (`old_record` for updates and deletes; both `null` for a
  statement-level trigger, such as `TRUNCATE`). The trigger's other arguments are Supabase's too:
  method, headers (JSON), query parameters (JSON) and a timeout in milliseconds.
- **Where it may go is the app's decision.** The trigger's first argument names a configured hook.
  A trigger written for Supabase with a URL instead works only when `allowUrls` lists a prefix of
  it; any other target is recorded as failed and never fetched. Redirects are not followed.
- **Delivery.** The event is stored in `supabase_functions.webhook_events` in the same transaction
  as the change, and `denext dev` / `denext start` deliver it at once (NOTIFY) or within
  `pollIntervalMs`. A non-2xx answer or a network error is retried with exponential backoff
  (`backoffMs`, doubled up to `maxBackoffMs`) until `maxAttempts`, then marked failed. Several app
  instances share the work without sending one event twice at once; delivery is at least once,
  so receivers dedupe on `webhook-id`. `delivery: "manual"` leaves it to `deliverWebhooks()` (from
  a job), and `webhookEvents({ status })` lists recent events.
- **Signing** follows [Standard Webhooks](https://www.standardwebhooks.com): `webhook-id`,
  `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256>`, with the hook's `secret`
  or `webhooks.secret` (`DENEXT_WEBHOOK_SECRET`). A receiver checks it with
  `verifyWebhook(request, secret)`, which returns the payload or `null`.

## `denext db`

`denext db` and `denext migration` are the Supabase CLI's `supabase db` and `supabase migration`.
The migration verbs are denext's own and also run without this plugin, on SQLite too (see
[Migrations](/docs/database#migrations--seeding)). With `backend({ postgres })` in the config,
they also apply the plugin's own migrations first, and `db reset` drops the plugin's schemas too.
The plugin also adds the Postgres tooling. Migrations are `migrations/*.sql` (what
`denext migration new` writes), or `supabase/migrations/*.sql` in a Supabase project, whose
`supabase_migrations.schema_migrations` history is kept and updated in the Supabase CLI's shape.

| Command                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `denext db migrate [--to v] [--include-all] [--dry-run]`         | `denext migration up`: apply the plugin's migrations (row-level security, and vault, queues or webhooks when enabled), then the pending ones, each in its own transaction.                                                                                                                                                                                                                                    |
| `denext db rollback [--steps n \| --to v] [--force-reset --yes]` | `denext migration down`: run the newest applied migrations' down scripts, newest first. `--force-reset` instead resets the database and re-applies everything up to the target, as `supabase migration down` does.                                                                                                                                                                                            |
| `denext db status [--json]`                                      | `denext migration list`: local and applied versions side by side. A file changed after it was applied is flagged, and so is one with no down script.                                                                                                                                                                                                                                                          |
| `denext db push [--dry-run] [--include-seed]`                    | Like `migrate`; `--include-seed` runs the seed afterwards. Use `--linked` or `--db-url` to push to another database.                                                                                                                                                                                                                                                                                          |
| `denext db reset --yes [--version v] [--no-seed]`                | Drop `public` and the plugin's schemas (and the Supabase history), re-apply everything up to `--version`, then seed. For development databases.                                                                                                                                                                                                                                                               |
| `denext db seed [--force]`                                       | Run `supabase/seed.sql` (or `seed.sql`), then create the config's buckets and upload `supabase/buckets/<bucket>/**` into them. A seed file that already ran unchanged is skipped (its hash is in `supabase_migrations.seed_files`, as with the Supabase CLI); `--force` runs it again.                                                                                                                        |
| `denext db link --url <postgres-url>`                            | Check the URL, then store it in `.env` as `DENEXT_LINKED_DATABASE_URL`. `--linked` targets it; the URL is never printed.                                                                                                                                                                                                                                                                                      |
| `denext db diff [--schema a,b] [--file name]`                    | Apply the migrations to a throwaway shadow database, then print DDL for whatever the live database has that the migrations don't (a change made in `denext ui`, say). `--file` writes it as `migrations/<stamp>_<name>.sql`.                                                                                                                                                                                  |
| `denext db pull [name] [--schema s]`                             | The same DDL as `diff`, written as a new migration and recorded as applied on that database (`supabase db pull`).                                                                                                                                                                                                                                                                                             |
| `denext db dump [--data-only] [--schema s] [--file path]`        | `pg_dump` the database (schema only by default). Needs `pg_dump` on PATH; the password goes in the environment, not on the command line.                                                                                                                                                                                                                                                                      |
| `denext db lint [--schema s] [--level l] [--fail-on l] [--json]` | Run plpgsql_check over the PL/pgSQL functions when it is installed. Then run the built-in checks: RLS off on a table the API roles reach, policies on a table with RLS off, RLS on but no policy, a function without a pinned `search_path`, a view without `security_invoker`, a table the API roles cannot reach.                                                                                           |
| `denext db inspect <report> [--json]`                            | The `supabase inspect db` reports: `bloat`, `blocking`, `cache-hit`, `calls`, `db-stats`, `index-sizes`, `index-usage`, `locks`, `long-running-queries`, `outliers`, `replication-slots`, `role-configs`, `role-connections`, `seq-scans`, `table-index-sizes`, `table-record-counts`, `table-sizes`, `total-index-size`, `total-table-sizes`, `unused-indexes`, `vacuum-stats`, or `report` for all of them. |
| `denext db test [files…] [--json]`                               | Run pgTAP tests (`supabase/tests/**/*.sql`), each file in a transaction that is always rolled back. Needs the `pgtap` extension on the server.                                                                                                                                                                                                                                                                |
| `denext db types [--schema s] [--file path]`                     | Print (or write to `--file`) the `supabase gen types typescript`-shaped `Database` type for the schemas.                                                                                                                                                                                                                                                                                                      |

Every verb acts on the project's database by default: the plugin's client, else `DATABASE_URL`.
`--db-url <url>` or `--linked` points it at another one. `diff`, `pull` (with a shadow database) and
`dump` need the database URL, and `diff` / `pull` need a role allowed to `CREATE DATABASE`. `diff`
compares tables, columns, constraints, indexes, row-level security and policies, functions, views,
triggers and enum types. It does not compare grants, comments, extensions or sequence settings.
`calls` and `outliers` need `pg_stat_statements`.

## Browse it in `denext ui`

[`denext ui`](/docs/ui#database) has a Database section for a project that uses Postgres: tables
and their rows (paged, editable, each write previewed as the exact SQL first), row-level security
policies — with an "as user" preview of what a user id sees under them — migrations, the storage
buckets (declared and created at runtime) and their objects — a delete there goes through the
same storage operations as the app's, so the object's metadata row goes too — and denext auth's
users. It runs on loopback with the rest of the UI,
and honours `--read-only`.

## Self-hosting with Docker

`denext generate docker` sees `backend()` in your config and writes the compose stack it needs:
the app, Postgres 17 (`DATABASE_URL` wired in), MinIO with a one-shot bucket bootstrap when the
storage driver is `s3()`, and a migrations service when you have `migrations/` and
`jobs/migrate.ts` — every service health-checked, the app started only after the database is
healthy and the one-shots have finished.

```sh
denext generate docker --stack   # web, db, minio + minio-init, migrate; .env.example
cp .env.example .env             # fill in POSTGRES_PASSWORD, DENEXT_STORAGE_SECRET, …
docker compose up -d --build
```

Or let `denext stack` do all three, the way `supabase start` does:

```sh
denext stack up            # writes the stack if it is missing (--stack, or your generate flags),
                           # fills a missing .env with generated secrets (0600), compose up --wait
denext stack status        # API, REST, database and S3 URLs, the publishable key (--json);
                           # --show-secrets adds the secret key and the passwords
denext stack logs db -f    # docker compose logs
denext stack down          # --volumes also drops the data
```

`.env.example` names every secret the backend reads, with how to generate each; the compose
file refuses to start while a required one is empty. The image runs on denext's Deno toolchain,
which has the `Deno.SQL` client `backend({ postgres })` uses. `--pgvector` swaps in the
`pgvector/pgvector:pg17` image (detected from a `create extension vector` migration), and `--dev`
adds an overlay running `denext dev` against the same services. Flags, the service table and the
storage-endpoint note: [Deployment › Self-hosted stack](/docs/deploy#self-hosted-stack-postgres-storage-migrations).

## More services

Storage, Postgres, row-level security, realtime from the database, auto-REST, Edge Functions,
Vault, queues, vector search and database webhooks are the services in `@denext/backend`. Auth ([`denextAuth`](/docs/auth)), push and live data
([Live](/docs/live)), typed [route handlers](/docs/typed-api) and scheduled [jobs](/docs/jobs) are
already part of denext itself.
