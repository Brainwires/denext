# Changelog

## Unreleased

- **Realtime limits (security).** Subscriptions are capped per identity
  (`maxSubscriptionsPerIdentity`, default 64: a signed-in user, or one signed-out Live connection);
  an unsubscribed key is forgotten at once and a disconnected one is kept for a reconnect only while
  there is room; subscribe-time seed queries run four at a time within a per-identity budget (32,
  then 8 a second). Re-reads and seeds compare the key and filter in the column's own type (read
  from the catalog), so the key and filter indexes serve them; each runs under a transaction-local
  `statement_timeout` (`queryTimeoutMs`, default 5 000); flushes are single-flight.
- **Security hardening.** Auto-REST with `tables: "*"` serves only RLS-enabled tables and
  `security_invoker` views (the rest are listed in a startup warning; name one in `rest.tables` to
  serve it); REST statements are capped by `maxConcurrent` (default half the pool, else 5; then
  `503` `PGRST003` with `Retry-After`), `statementTimeout` defaults to 5000 ms, and
  `exactCount` (default `"authenticated"`) refuses an anonymous `Prefer: count=exact`; the CSRF
  exemption uses `auth()`'s own bearer parser (`nativeBearerToken`). `db()` without `as` resolves
  the identity for each query from the request that makes it (a module-level client is fine; `anon`
  outside a request). The RLS setup statement blanks the legacy `request.jwt.claim.*` settings;
  `sub`, `role` and `email` are stripped from custom claims. Storage outside a request needs
  `{ service: true }` (a public bucket's downloads excepted). S3 presigned GETs carry
  `response-content-type` and `response-content-disposition` (`attachment` unless the type is
  safe inline).
- **Auto-REST.** `backend({ postgres, rest: {} })` serves the granted tables of a schema
  PostgREST-style under `/rest/v1/<table>`: `select=` (columns), `eq` / `neq` / `gt` / `gte` / `lt`
  / `lte` / `like` / `ilike` / `is` / `in` filters (and `not.`), `order=`, `limit` / `offset` /
  `Range`, `Prefer: count=exact`, single-object responses, inserts, and updates and deletes that
  require a filter. Every statement runs through `db()` under row-level security and a
  `statement_timeout`; identifiers come from the catalog only, values are typed parameters; errors
  are PostgREST-shaped; cross-site cookie writes are refused. `from()` / `restClient()` from
  `@denext/backend/client`, typed by the generated `.denext/rest.ts`. Options: `schema`, `tables`,
  `basePath`, `maxRows`, `maxBodyBytes`, `statementTimeout`.
- **Realtime from the database.** `backend({ postgres, realtime: realtime({ tables }) })`: per-table
  AFTER triggers (migrations `backend_realtime_0001` + one per table; `realtimeMigrations()` /
  `realtimeSetupSql()` and `migrate: false` for a DBA) NOTIFY keys only; one listener per instance
  coalesces bursts and re-reads each subscriber's rows under their row-level security.
  `useTableChanges` (client), `onTableChange` and `tableChanges` (server), `revalidate: true` for
  `table:<name>` tags (`revalidate: { owner: "one" }`: on one instance per database, elected with
  a Postgres advisory lock, for a shared cache). Needs a client with `listen` (`Deno.SQL`, or
  `fromPostgresJs`).
- **Row-level security, Supabase-compatible.** `db()` now runs every query inside a transaction
  that first sets `role` (`authenticated` for the request's signed-in user, else `anon`) and
  `request.jwt.claims` with `set_config(…, true)` — transaction-local, pipelined with the query
  (one round trip per query on `Deno.SQL`: `BEGIN`, setup, query and `COMMIT` go out together) —
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
