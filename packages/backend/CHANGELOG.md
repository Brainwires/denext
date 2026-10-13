# Changelog

## Unreleased

- **`/auth/v1`.** `backend({ supabase: { auth } })` serves the GoTrue-compatible auth API over
  the `denextAuth()` users (sign-up, password / OTP / magic link / phone / anonymous / OAuth /
  id_token / PKCE sign-in, user updates, MFA factors, identities, SAML SSO, the admin API), so the
  stock supabase-js `supabase.auth.*` works unchanged.

- **`supabase` option and `resolveIdentity()`.** `backend({ supabase: true | { publishableKey,
  secretKey, jwtSecret, signingKeys } })` installs Supabase-compatible API keys and JWT signing
  keys, serves the JWKS at `/auth/v1/.well-known/jwks.json`, and adds `denext backend keys`.
  `resolveIdentity(request?)` (from `@denext/backend/server`) resolves a request to
  `{ role, claims, userId?, source, session? }` — access token, secret key, denext session, then
  `anon` — and throws `IdentityError` (401) for a refused credential; `db()` scopes every query
  with it, the service role running as the connecting role with its claims.

- **Edge Functions.** `backend({ functions: {} })` serves `functions/<name>.ts` /
  `functions/<name>/index.ts` at `/functions/v1/<name>` (supabase-js `functions.invoke`
  compatible), each function in a Deno Worker of its own; `Deno.serve(handler)` and
  default-exported handlers both work. JWT verification is on by default (`verifyJwt: false` per
  function), CORS preflights reach the function, responses stream, and `denext functions list`
  lists them.
- **`@denext/backend`: auto-REST speaks PostgREST 12, so `@supabase/supabase-js` works
  unchanged.** `createClient(appUrl, key)` then `from()`, `rpc()` and `schema()` reach
  `backend({ rest })`'s routes, and denext's own client (`from`, `rpc`, `restClient`) now has the
  same API. New on the routes: embedded resources through the catalog's foreign keys (many-to-one,
  one-to-many, one-to-one, many-to-many through a junction, `!inner`, `!hint`, spreads, the
  `count` shorthand, and filters / order / limit / offset / `or` on an embed, plus `rel=is.null`);
  `or` / `and` trees, nested and negated; every operator (`match`, `imatch`, `isdistinct`, `cs`,
  `cd`, `ov`, the range operators, `fts` / `plfts` / `phfts` / `wfts` with a configuration,
  `(any)` / `(all)`); aliases, `::casts` and JSON paths in select, filters and order; upserts
  (`Prefer: resolution=merge-duplicates|ignore-duplicates`, `on_conflict=`), `columns=` and
  `missing=default`; `/rpc/<function>` over GET and POST (named arguments and overloads, a single
  json argument, `params=single-object`, set-returning results filtered, ordered, paged, counted
  and embedded, scalars, `void`) for the functions `anon` / `authenticated` may EXECUTE;
  `count=planned|estimated`; CSV in and out; GeoJSON (with PostGIS); `return=headers-only`;
  `tx=rollback`; `handling=strict` with `max-affected`; `nulls=stripped`; execution plans behind
  the opt-in `rest.explain`; and several schemas through `rest.schemas` with `Accept-Profile` /
  `Content-Profile`. Requests resolve through the shared request identity, so supabase-js's
  `apikey` / `Authorization: Bearer` work (publishable key → `anon`, a user's access token →
  `authenticated`, the secret key → `service_role`), and a refused one is PostgREST's `401`
  (`PGRST301`, or `PGRST303` when expired). A GET runs in a READ ONLY transaction. Every name is still looked up in the
  catalog and every value bound; a request takes at most 64 filters, 256 select items and 8
  levels of embedding.
- **`@denext/backend`: `.denext/rest.ts` is `supabase gen types`-shaped.** `Database` with each
  exposed schema's `Tables` (with `Relationships`), `Views`, `Functions`, `Enums` and
  `CompositeTypes`, the `Tables<>` / `TablesInsert<>` / `TablesUpdate<>` / `Enums<>` helpers and
  `Constants`, so `createClient<Database>()` type-checks; it still registers the default schema
  for denext's `from()`.
- **Breaking:** `readRestCatalog(sql, schemas, tables)` takes the list of schemas and returns
  the whole catalog (`tables`, `foreignKeys`, `functions`, `enums`, …); `generateRestTypes(catalog)`
  takes the catalog alone; the client's `range()` sends `offset` / `limit` (as supabase-js does)
  instead of a `Range` header, and `maybeSingle()` checks the row count on the client.
- **Supabase Realtime.** `backend({ realtime })` serves `/realtime/v1/websocket` (Phoenix channels,
  serializer `1.0.0` and `2.0.0`, binary broadcast frames) and `POST /realtime/v1/api/broadcast`, so
  `@supabase/supabase-js`'s `supabase.channel(…)` works against the app: `postgres_changes` (per
  binding event, schema, table, `eq neq lt lte gt gte in` filters, Supabase's payload, old records,
  `TRUNCATE`) re-read under each subscriber's row-level security; broadcast (`self`, `ack`, binary,
  REST, `realtime.send()` and `realtime.broadcast_changes()` from SQL); presence (`track`,
  `untrack`, `sync` / `join` / `leave`) shared by every instance through Postgres; private channels
  authorized by `realtime.messages` policies as the joining user. With `backend({ supabase })`
  keys the socket needs a valid `apikey`, and the channel's `access_token` is verified like a
  bearer (a user until its `exp` — then the channel closes — the secret key `service_role`, re-verified
  on every `access_token` push; a refused token refuses the join or closes the channel); without a
  user token a same-origin socket is its session's user (re-read every minute; a changed session
  closes the socket). Limits: `realtime({ socket: { maxConnections,
  maxConnectionsPerAddress, maxChannelsPerConnection, maxEventsPerSecond, maxPayloadBytes } })`;
  `socket: false` turns the endpoint off.
- **Realtime tables:** `old: "full"` carries the old row of an update or delete (when it fits a
  notification), `truncate` is an event (on by default, delivered only to subscribers who could
  see rows), and new migrations `backend_realtime_0003` to `0005` add the TRUNCATE trigger
  function, the `realtime` schema (`messages`, `topic()`, `send()`, `broadcast_changes()`) and the
  presence tables. With `migrate: false`, re-run `realtimeSetupSql()`.
- **`useTableChanges` / `tableChanges` filters** take every Supabase operator — `{ priority: { gte:
  3 } }`, `"status=in.(open,blocked)"` — and the hook an `events` list; changes carry `old` (with
  `old: "full"`) and `{ op: "truncate" }`.
- **`broadcast(topic, event, payload)`** from `@denext/backend/server` publishes to every
  `supabase.channel(topic)` subscriber on every instance.
- **Supabase Storage parity.** `/storage/v1` serves Supabase's Storage API (supabase-js
  `supabase.storage` unchanged: buckets at runtime, uploads with upsert / cache control / metadata,
  list, info, exists, move, copy, bulk remove, signed URLs and uploads, public URLs, `render/image`
  transforms with `resize`), TUS resumable uploads at `/storage/v1/upload/resumable`, object and
  bucket metadata in Supabase's `storage` schema on Postgres (or `node:sqlite` without it), and
  `storage: { rls: true }` to authorize with SQL policies on `storage.objects` / `storage.buckets`.
  The server API gains `info`, `exists`, `copy`, `move`, `listFolder`, `createSignedUrls`,
  `getPublicUrl` and bucket management; `authorize` receives the request's `identity`.

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
