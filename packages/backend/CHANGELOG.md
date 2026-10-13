# Changelog

## 0.3.0 - 2026-10-13

Requires `@denext/denext` ^4.0.0-rc.1 (the jobs rename and the rest of denext 4.0's breaking
changes).

- **The storage sign route keeps the client address.** It rebuilt its request around the
  buffered body with a plain `new Request(...)`, which drops the socket peer denext records on the
  original (and its abort signal), so a middleware on the endpoint that keys on the request, such
  as `rateLimit()`, saw no client address. It now rebuilds it with `bufferedRequest` from
  `@denext/denext/plugin-kit`, which carries both.
- denext 4.0 calls background and scheduled work jobs: the docs, and the error a storage call
  outside a request gets without `{ service: true }`, say "job" where they said "task".

## 0.2.1 - 2026-10-12

Requires `@denext/denext` 3.4.16 or later.

- **Realtime: `timestamptz` keys match across `TimeZone` settings.** `to_jsonb()` formats a
  `timestamptz` in the session's `TimeZone`, so a write from a session in one zone and a
  subscriber's re-read in another spelled the same key differently: the change was dropped, and a
  seeded key never matched its delete. Migration `backend_realtime_0002` replaces the trigger
  function so that a key column whose catalog type is `timestamptz` is sent in UTC, and the re-read
  and seed queries spell such a key the same way (`to_jsonb(k AT TIME ZONE 'UTC') #>> '{}'`). Other
  key types are unchanged. With `migrate: false`, re-run `realtimeSetupSql()`.
- **Realtime: the signed-out quota is per IPv6 `/64` (security).** It keyed the raw client
  address, so an IPv6 client could rotate through its `/64` for a fresh quota per connection. It
  now keys `clientIpForLimits({ bucket: true })` (an IPv4-mapped address counts as its IPv4
  address). On a denext without that option the raw address is keyed, as before.

## 0.2.0 - 2026-10-12

First release on JSR (0.1.0 was tagged but never published). Requires `@denext/denext` 3.4.15 or
later.

- **Realtime: signed-out quota per client address.** A signed-out subscriber's
  `maxSubscriptionsPerIdentity` and seed budget now apply per client address
  (`clientIpForLimits()` in the Live connection's context), not per Live connection, so more
  sockets no longer buy more of either. Without a known address — or when the address is an
  untrusted loopback/private socket peer, a reverse proxy every visitor shares (set
  `trustForwardedHeaders` behind one) — it stays per connection.
- **Realtime: timestamp keys.** Re-read and seed queries return the key as the trigger spells it
  (`to_jsonb(row) ->> 'key'`, computed from the key column alone as `to_jsonb(t."key") #>> '{}'`),
  so a key whose text form differs from its JSON form (a `timestamp`) is matched to its
  notifications; the typed, index-served comparison is unchanged.
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
