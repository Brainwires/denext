# Changelog

## 0.1.0

- **Storage.** `backend({ storage: { driver, buckets } })`: buckets with `public`, `maxBytes`, a
  `mime` allow-list (declared raster images are sniffed from their first bytes) and `authorize({
  session, op, key, bucket, request })`, run for every operation inside a request with the
  `denextAuth` session — denied when absent. Drivers: `s3()` for AWS S3, Cloudflare R2 and MinIO
  (SigV4 on `crypto.subtle`, path- and virtual-host-style, presigned PUT/GET, multipart upload,
  ListObjectsV2 paging) and `fs({ dir })` for development and self-hosting (HMAC-signed, expiring
  URLs served by the plugin, `Range` downloads, keys confined to their bucket). Server API
  `storage.bucket(n)` from `@denext/backend/server`: `createSignedUploadUrl`, `createSignedUrl`,
  `upload`, `download`, `head`, `list`, `remove`. Browser API from `@denext/backend/client`:
  `uploadFile` (progress, multipart above a threshold, cancellable) and `getFileUrl`. Image
  transforms on download (`width`, `height`, `quality`, `format`) through denext's image pipeline,
  bounded to the app's `images` sizes. `POST /_denext/storage/sign` applies the `csrf()` rule and
  validates its body.
