---
title: Backend
slug: backend
lead: "@denext/backend puts backend services inside your app as one opt-in plugin: no hosted service, nothing to run beside it. It ships storage today: buckets with per-bucket rules, signed upload and download URLs, multipart uploads, image transforms on download and access checks tied to the request's session, on S3 (AWS, Cloudflare R2, MinIO) or the local filesystem, with zero npm."
---

```sh
denext plugin add @denext/backend
```

Or by hand: add `"@denext/backend": "jsr:@denext/backend@^0.1.0"` to `deno.json`'s `imports`,
then the plugin to `denext.config.ts`.

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

## More services

Storage is the first service in `@denext/backend`. Auth ([`denextAuth`](/docs/auth)), realtime
([Live](/docs/live)), functions ([route handlers](/docs/typed-api)) and scheduled
[tasks](/docs/tasks) are already part of denext itself.
