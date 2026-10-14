# examples/backend-storage

`@denext/backend` storage in one app: an image gallery in a **public** bucket (thumbnails resized on
download through denext's image pipeline) and a **private** documents bucket whose links are signed
and expire. Uploads go from the browser straight to the store with progress; the server signs them,
then checks size, type and the first bytes of what arrived.

```sh
denext task dev          # http://localhost:3000 — files land in ./.storage
```

## On S3, Cloudflare R2 or MinIO

Name a bucket and the same app stores objects there instead (each denext bucket is a key prefix in
it):

```sh
S3_BUCKET=my-bucket S3_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
DENEXT_STORAGE_SECRET=$(openssl rand -base64 32) denext task dev
```

Add `S3_ENDPOINT=http://127.0.0.1:9000` for MinIO, or `https://<account>.r2.cloudflarestorage.com`
with `S3_REGION=auto` for R2. The bucket's CORS must allow this app's origin to `PUT`, and expose
the `ETag` header (multipart uploads read it).

## What to look at

- `denext.config.ts` — the driver and the two buckets' rules (`public`, `maxBytes`, `mime`,
  `authorize`). This demo has no sign-in, so `authorize` only looks at the operation; a real app
  checks the session `denextAuth` provides.
- `app/page.tsx` — the server API: `storage.bucket("gallery").list()` and `createSignedUrl()` with a
  `transform`.
- `app/uploader.tsx` — the browser API: `uploadFile()` with progress, then `getFileUrl()`.
- `app/resumable.tsx` — `uploadResumable()`: TUS uploads in chunks that survive a dropped
  connection.
- `app/notes/` — a **versioned** bucket (`versioned: true`): every save keeps the old text, and
  `listFolder("", { versions: "include" })` shows the history.
- `scripts/supabase-js.ts` — the same storage from the stock `@supabase/supabase-js` client
  (`deno task supabase-js` while the app runs): buckets, uploads, listings, signed URLs, versions
  and `listV2`, against `/storage/v1` with the dev keys `backend({ supabase: true })` generates.
