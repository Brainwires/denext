# examples/backend-storage

`@denext/backend` storage in one app: an image gallery in a **public** bucket (thumbnails resized on
download through denext's image pipeline) and a **private** documents bucket whose links are signed
and expire. Uploads go from the browser straight to the store with progress; the server signs them,
then checks size, type and the first bytes of what arrived.

```sh
# from this directory
denext task dev          # http://localhost:3000 — files land in ./.storage
```

`denext dev` signs storage URLs with a random per-run secret and writes a set of Supabase API keys
to `.denext/backend-keys.json`. `denext task build && denext task start` needs
`DENEXT_STORAGE_SECRET` (32 characters or more) in the environment, and the Supabase keys
(`DENEXT_PUBLISHABLE_KEY`, `DENEXT_SECRET_KEY`, `DENEXT_JWT_SIGNING_KEYS`; `denext backend keys`
mints a set): without them `/storage/v1` refuses every key.

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
  (`deno task supabase-js` from this directory, in a second terminal while the app runs; set
  `APP_URL` when it isn't on `http://localhost:3000`): buckets, uploads, listings, signed URLs, versions
  and `listV2`, against `/storage/v1` with the dev keys `backend({ supabase: true })` generates.
