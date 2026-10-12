# Changelog

## Unreleased

- **Realtime from the database.** `backend({ postgres, realtime: realtime({ tables }) })`: per-table
  AFTER triggers (migrations `backend_realtime_0001` + one per table; `realtimeMigrations()` /
  `realtimeSetupSql()` and `migrate: false` for a DBA) NOTIFY keys only; one listener per instance
  coalesces bursts and re-reads each subscriber's rows under their row-level security.
  `useTableChanges` (client), `onTableChange` and `tableChanges` (server), `revalidate: true` for
  `table:<name>` tags. Needs a client with `listen` (`Deno.SQL`, or `fromPostgresJs`).
- **Row-level security, Supabase-compatible.** `db()` now runs every query inside a transaction
  that first sets `role` (`authenticated` for the request's signed-in user, else `anon`) and
  `request.jwt.claims` with `set_config(…, true)` — transaction-local, pipelined with the query —
  so Supabase-style policies (`using (auth.uid() = owner)`) apply as written. Migration
  `backend_rls_0001` (on first use; `rls: { migrate: false }` to skip) creates the `anon` /
  `authenticated` roles, grants them to the connecting role, and adds Supabase's `auth.uid()`,
  `auth.role()`, `auth.email()` and `auth.jwt()`; `rlsSetupSql(role)` prints the same setup for a
  DBA. The claims have a Supabase access token's shape (`sub`, `role`, `aud`, `email`, `aal`,
  `amr`, `app_metadata`, `user_metadata`, …) plus `rls.claims(session)`. `db({ as })` acts as
  `"anon"`, a user or a session; `db.service()` (or `db({ as: "service" })`) is the unscoped
  connection. A `begin` inside `db().begin` is a savepoint. **Breaking:** `db()` outside a request
  is now `anon`, not the server's own connection — use `db.service()` there.
- **Postgres.** `backend({ postgres: { url | sql } })` opens one client for the app (`DATABASE_URL`
  by default; `Deno.SQL`, built into denext's Deno runtime, closed when the server drains) or
  adopts yours (`sql`, never closed by the plugin — the npm `postgres` package through
  `fromPostgresJs` on stock Deno). `db()` from `@denext/backend/server` returns it; on stock Deno
  without `sql` the app still starts and `db()` throws `PostgresUnsupportedError`
  (`code: "unsupported"`). `backendAuthAdapter({ schema?, migrate? })` is denext's
  `postgresAuthAdapter` on that client, for `denextAuth({ adapter })`. Needs denext with the
  Postgres stores (the release after 3.4.12).

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
