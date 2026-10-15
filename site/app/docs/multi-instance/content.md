---
title: Multi-instance deployments
slug: multi-instance
lead: One denext process is self-contained by default — its cache, sessions, rate-limit counters, auth database, Live fan-out and cron scheduler all live in that process. Every one of those is a per-node component with a small interface behind it. This page lists them, says exactly what stops being true when a second replica starts, and names the interface you implement to make it true again.
---

## The short version

| Component                              | Default                                                               | Across two instances                                                               | Make it shared with                                                                  |
| -------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Data + ISR page cache                  | `node:sqlite` file, `.denext/cache.db` (memory if unwritable)         | `revalidateTag` on A does **not** purge B; each node renders and caches on its own | `cache.store` → `redisCacheStore()` / `denoKvCacheStore()` / `postgresCacheStore()`  |
| Auth sessions (`strategy: "database"`) | none until you choose (`inMemorySessionStore` / `sqliteSessionStore`) | a session created on A is unknown to B; a revoke on A does not reach B             | `sessionStore` → `redisSessionStore()` / `denoKvSessionStore()` / `postgres…`        |
| Rate-limit counters                    | `inMemoryRateLimitStore()` per process                                | every limit is multiplied by the replica count                                     | `store` → `redisRateLimitStore()` / `denoKvRateLimitStore()` / `postgres…`           |
| Users, accounts, credentials           | `sqliteAuthAdapter` = one SQLite file                                 | single node (or a shared volume)                                                   | `adapter` → `postgresAuthAdapter()` / `backendAuthAdapter()` or your `AuthAdapter`   |
| Live channels + tag pushes             | in-memory loopback transport                                          | a `publish` on A reaches A's sockets only                                          | `setChannelTransport(t)` → `redisChannelTransport()` / `broadcastChannelTransport()` |
| Scheduled jobs (userland)              | minute-tick scheduler in every process                                | **fires on every replica**                                                         | one designated instance, or `Deno.cron`                                              |
| Job run history                        | `.denext/jobs.db` per process                                         | each node sees its own fragment                                                    | `jobs: { history: { store: postgresJobHistoryStore() } }` or your `JobHistoryStore`  |
| Connection and concurrency caps        | per process (`maxConcurrency`, `live.limits`, `@denext/graphql`)      | each cap is multiplied by the replica count                                        | (per process by design; size each to one instance, and cap the total at the edge)    |

Signed-cookie sessions (`getSession()` and auth's default `strategy: "cookie"`)
are the one thing on the list that is already replica-safe: the whole payload is
in the cookie, verified with the shared `SESSION_SECRET`. For every store
interface, denext ships a Postgres implementation in `denext/server`
(`postgresCacheStore`, `postgresSessionStore`, `postgresRateLimitStore`,
`postgresAuthAdapter`, `postgresJobHistoryStore`; each takes `{ sql | url,
schema?, directUrl? }` and creates its tables on first use) — see
[Databases › Postgres](/docs/database#postgres). The cache, session and
rate-limit stores also ship on **Redis** (`redisCacheStore`, `redisSessionStore`,
`redisRateLimitStore`) and **Deno KV** (`denoKvCacheStore`, `denoKvSessionStore`,
`denoKvRateLimitStore`), both zero-npm (below), and Live crosses instances
through Redis pub/sub (`redisChannelTransport`, [below](#live-channeltransport)). Each interface is small, and `denext/testing` exports
the contract suites denext's own stores pass, so a store of your own can prove
itself ([Your own store](#your-own-store)).

## Redis and Deno KV

```ts
// denext.config.ts — every replica points at one Redis
import { redisCacheStore } from "denext/server";
export default { cache: { store: redisCacheStore({ url: Deno.env.get("REDIS_URL") }) } };
```

```ts
// the auth stores, on the same server (one shared connection)
import { denextAuth, redisClient, redisRateLimitStore, redisSessionStore } from "denext/server";
const redis = redisClient(Deno.env.get("REDIS_URL")); // redis://user:pass@host:6379/0, rediss:// for TLS
denextAuth({
  // …
  session: { strategy: "database" },
  sessionStore: redisSessionStore({ client: redis }),
  rateLimit: { store: redisRateLimitStore({ client: redis }) },
});
```

The Redis stores run on `redisClient`, denext's own RESP2 client over
`Deno.connect` / `Deno.connectTls`: `AUTH` with a password or an ACL user,
`SELECT` from the URL's path, one pipelined connection shared by every request
(reopened on the next command after it drops). They need Redis 7 or Valkey
(`PEXPIREAT … NX/GT`, `SET … PXAT`) and use no Lua. Each store takes `client`
(yours; the store never closes it) or `url` (it opens and closes its own; the
default is `REDIS_URL`, then `redis://127.0.0.1:6379`), and a key `prefix`
(`denext:cache:`, `denext:session:`, `denext:ratelimit:` by default; use a hash
tag such as `{myapp}:cache:` to keep a store's keys in one Redis Cluster slot).
The cache keeps each entry as a hash, a set per tag and per path, and two sorted
sets per namespace (write order for the `maxDataEntries` / `maxPageEntries` caps,
hard expiry for the throttled sweep); every invalidation re-reads an entry's own
tags or path before deleting it. A session is a key Redis expires at the
session's `expiresAt`, and `update` is `SET … XX`. A rate-limit window is a hash
Redis expires when the window closes, counted in one `MULTI` block.

```ts
// Deno Deploy: the project's KV database, shared by every isolate and region
import { denoKvCacheStore, denoKvRateLimitStore, denoKvSessionStore } from "denext/server";
export default { cache: { store: denoKvCacheStore() } }; // or { kv: await Deno.openKv(url) }
```

The Deno KV stores take `kv` (an open `Deno.Kv`, yours) or `path` (what to pass
to `Deno.openKv`; the store opens and closes it), and a key `prefix`. Outside
Deno Deploy, `Deno.openKv` needs `--unstable-kv` (or `"unstable": ["kv"]` in
`deno.json`); without it a store that must open one throws
`DenoKvUnsupportedError`. Every read-modify-write is an atomic commit checked
against the version it read. A cached value larger than a KV value (64 KiB) is
stored in 60 KB chunks written before its entry; the size caps and the expiry
sweep run on the `sweepIntervalMs` schedule. Sessions and windows carry KV's
`expireIn`, and reads check expiry too (KV deletes expired keys eventually).

## Your own store

`denext/testing` exports the suites every shipped store passes —
`cacheStoreContract`, `sessionStoreContract` and `rateLimitStoreContract`. Give
one a factory that returns a fresh, empty store per case (a new key prefix on a
shared server works) and it runs each case as a step, closing the store
afterwards:

```ts
import { cacheStoreContract, sessionStoreContract } from "denext/testing";
import { myCacheStore, mySessionStore } from "./stores.ts";

Deno.test("my stores honour denext's contracts", async (t) => {
  let n = 0;
  await t.step("cache", (t) => cacheStoreContract(t, () => myCacheStore({ prefix: `t${n++}:` })));
  await t.step("sessions", (t) => sessionStoreContract(t, () => mySessionStore()));
});
```

A failing case throws a `StoreContractError` naming what differed. Under another
runner, pass `{ step: (name, fn) => test(name, fn) }` instead of `t`.

## The cache: `CacheStore`

`unstable_cache` / `cachedFetch` entries, `"use cache"` results and rendered ISR
pages all go through one pluggable store. The default is durable per node (a
SQLite file) and that is what makes the multi-instance behaviour surprising: it
_looks_ shared because it survives a restart, but a `revalidateTag("products")`
handled by instance A purges A's file only. Until B's entry reaches its own
`revalidate`, B serves the old page. With the built-in store there is no path by
which A's invalidation reaches B — not even with a `ChannelTransport` installed
(that carries the Live _push_ cluster-wide, so B's connected viewers get
re-rendered, but the re-render reads B's still-stale cache).

The interface, from `denext/server`:

```ts
interface CacheStore {
  getData(key: string): DataEntry | undefined | Promise<DataEntry | undefined>;
  setData(key: string, entry: DataEntry): void | Promise<void>;
  getPage(
    key: string,
  ): CachedPage | undefined | Promise<CachedPage | undefined>;
  setPage(key: string, page: CachedPage): void | Promise<void>;
  deleteByTag(tag: string): void | Promise<void>;
  deleteByPath(path: string): void | Promise<void>;
  expireByTag?(tag: string, timing: CacheEntryTiming): void | Promise<void>; // SWR soft-expire; optional
  sweepPages?(keep: string): number | Promise<number>; // drop other builds' pages; optional
}
```

The contract: every method may be sync or async (denext awaits); `get*` must
return only **fresh** entries — treating `expiresAt` in the past as a miss is
the store's job (a `DataEntry` also carries `staleAt` and `tags`; a `CachedPage`
carries its own timing); a store without `expireByTag` gets a hard `deleteByTag`
instead of stale-while-revalidate.

```ts
// denext.config.ts
import { postgresCacheStore } from "denext/server";
export default { cache: { store: postgresCacheStore({ url: Deno.env.get("DATABASE_URL") }) } };
// or redisCacheStore({ url: Deno.env.get("REDIS_URL") }), denoKvCacheStore(), or your own
```

### Page keys and builds

Rendered pages are keyed per build: `denext build` records a `buildId` in
`.denext/manifest.json` and `denext start` reads and writes page keys of the form
`v2:<buildId>:<path>?<query>` (the `v2` is the page-cache format). A cached page names its
build's hashed client chunks, so a new deploy never serves the previous build's pages; data
entries (`unstable_cache`, `cachedFetch`, `"use cache"`) are not keyed by build. The id is
random per build unless `DENEXT_BUILD_ID` is set at build time — set it (to the commit sha,
say) when replicas are built separately and must share one store's pages.

Once after startup, off the request path, `denext start` deletes the pages of other builds
and older formats from its store, through the store's optional `sweepPages(keep)`: delete every
**page** whose key does not start with `keep` (this build's `v2:<buildId>:` prefix), never a
data entry, and return the count. It sweeps the in-memory store and the default
`.denext/cache.db` always (only this build uses them; `denext build` empties that file anyway,
so it holds old pages only when it outlived the build, as on a mounted volume), but a store
other servers may share — a
custom store, or an explicit `cache.path` — only when the build id was pinned with
`DENEXT_BUILD_ID`: separately built replicas with random ids would otherwise delete each other's
live pages on every restart. A store without `sweepPages` is never swept; its other builds'
pages are unreachable and age out through its own expiry and eviction. Every shipped store
implements it.
`DENEXT_DEBUG_CACHE=1` logs the sweep's count.

`DataEntry` is `{ value, expiresAt, staleAt?, tags }` and `CachedPage` is the full HTML
`body` plus `status`, `path`, `expiresAt`, `staleAt?`, `tags` and the page's
hash-based `csp`, so a store round-trips a few KB per page. Keep the page cache
behind a CDN and let the shared store be the origin's memory, not the edge's.
`/_denext/health` reports `"cacheStore": "custom"` once yours is installed, and
`cacheStoreHealthy()` probes it.

Two cheaper options when a shared store is more than the app needs: **a CDN** in
front of each node, which caches ISR pages from the `public, s-maxage` header
they carry with `cdnCacheHeaders: true` (see [CDN headers](/docs/data#cdn-headers)), accepting that invalidation is the CDN's
purge API rather than `revalidateTag`; or **`cache: { store: "memory" }`** on a
short `revalidate`, which makes the per-node staleness explicit and bounded
instead of durable.

## Sessions: `SessionStore`

Only `session: { strategy: "database" }` (revocable sessions) needs a store. The
interface:

```ts
interface SessionStore {
  create(id: string, session: AuthSession): void | Promise<void>;
  update?(id: string, session: AuthSession): boolean | Promise<boolean>; // write-only-if-present; needed for sliding expiry
  get(id: string): AuthSession | undefined | Promise<AuthSession | undefined>; // unexpired only
  delete(id: string): void | Promise<void>;
  deleteByUser(userId: string): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

`update` is the subtle one: it must **not** upsert, so a session revoked between
a read and its refresh stays revoked. In Redis that is `SET … XX`
(`redisSessionStore` does this); in SQL an `UPDATE … WHERE id = ?` whose row count
you return. `inMemorySessionStore` is
per process; `sqliteSessionStore` (`.denext/sessions.db`) is per node unless the
file sits on a shared volume. See [Auth › Sessions](/docs/auth#sessions).

## Rate limiting: `RateLimitStore`

Both `rateLimit()` (the API middleware) and auth's built-in limiters count in a
store:

```ts
interface RateLimitStore {
  get(
    key: string,
  ): RateLimitWindow | undefined | Promise<RateLimitWindow | undefined>;
  increment(
    key: string,
    windowMs: number,
  ): RateLimitWindow | Promise<RateLimitWindow>; // opens a window when none
  reset(key: string): void | Promise<void>;
  decrement?(key: string): void | Promise<void>; // give back a reserved unit; optional
}
```

A `RateLimitWindow` is `{ count, resetAt }`. With the in-memory default,
`max: 5` behind three replicas is fifteen attempts per window against whichever
node the balancer picks — fine for a coarse API limit, wrong for a login
lockout. `redisRateLimitStore()`, `denoKvRateLimitStore()` or
`postgresRateLimitStore()` shares the count. Pass it as `rateLimit({ store })` and `denextAuth({ rateLimit:
{ store } })`. See
[Auth › Rate limiting](/docs/auth#rate-limiting).

## Users and credentials: `AuthAdapter`

`sqliteAuthAdapter({ path })` is one `node:sqlite` file — user data,
deliberately not under `.denext/` — so it is **single node**: replicas need a
shared volume or an adapter over a networked database. The adapter is the
largest of the interfaces (users, accounts, verification tokens, credentials,
second-factor state, an optional `sessions` store over the same handle); its
full contract, with what each method must and must not do, is in
[Auth › Database adapter › The contract](/docs/auth#the-contract), and the
SQLite schema it maintains is in
[The SQLite schema](/docs/auth#the-sqlite-schema) if you want to mirror it in
Postgres.

## Live: `ChannelTransport`

`createChannel().publish()`, `channel.revoke()` and a tag invalidation's Live
push are delivered to the sockets of the instance that emitted them. A transport
carries them to every other hub:

```ts
interface ChannelTransport {
  publish(ev: ChannelEvent): void | Promise<void>; // to every subscriber, this instance included
  subscribe(fn: (ev: ChannelEvent) => void): () => void;
}
```

`redisChannelTransport()` (from `denext/server`) implements it over Redis
pub/sub — the shipped transport for a self-hosted fleet:

```ts
// instrumentation.ts (or any module the server loads at startup)
import { redisChannelTransport, setChannelTransport } from "denext/server";
setChannelTransport(redisChannelTransport({ url: Deno.env.get("REDIS_URL") }));
```

Every event is one `PUBLISH` on one Redis channel (`channel`, default
`denext:channels`; give each app its own when apps share a server). The transport
opens two connections of its own, one to publish and one held in `SUBSCRIBE`; the
subscriber reconnects with backoff after a drop, subscribes again and calls
`onResync`. `url` takes everything `redisClient` does, `rediss://` and
`tls: { caCerts }` included. A publish never rejects: if Redis is down the event
still reaches this instance's sockets and the failure is logged once.

**Presence** (`usePresence`) rides the same transport: each hub publishes its own
peers in a room when they change and every 10 seconds once another instance is
heard from, and merges the other instances' snapshots into the `presence-state`
its sockets see. A hub that stops publishes its rooms as empty; a crashed one's
peers drop out after 35 seconds without a heartbeat. Room authorization stays
with the instance that holds the socket.

`broadcastChannelTransport()` implements the interface over the Web
`BroadcastChannel` API, which on **Deno Deploy** spans the isolates of one
deployment — that is its purpose; on a self-host it reaches only the workers of
one process, so it does not make two containers talk. Install either, or your own
two-method NATS transport, with `setChannelTransport(t)`; the hub re-subscribes.
Delivery is at most once (an event published while a subscriber is reconnecting
is not replayed). An event carries an `instance` id and a per-instance `seq`,
so ordering holds per publisher, not globally. Without a transport, the
practical alternative is **sticky sessions** at the balancer so a viewer's
socket and the actions that publish to it land on the same node — which works
for a single user's own updates and not for anything shared between users. See
[Live › Delivery semantics & scaling](/docs/live#delivery-semantics--scaling).
Server-held [live views](/docs/live-views#more-than-one-instance) also need a shared
`DENEXT_LIVE_VIEW_SECRET`, and resume after a reconnect only on the same node.

## Scheduled jobs: one runner, not one per replica

The userland scheduler is a minute tick inside every process that has jobs.
There is **no leader election**: three replicas each run `0 3 * * *` at 03:00
UTC, and the overlap guard (a job never runs concurrently with _itself_) is per
process. Pick one of:

- **Designate one instance.** Start exactly one replica with the schedules
  configured and the others with `scheduledJobs` empty — for example gate the
  config on an env var:

  ```ts
  // denext.config.ts
  const runner = Deno.env.get("JOB_RUNNER") === "1";
  export default {
    scheduledJobs: runner ? { "0 3 * * *": "cleanup" } : {},
  };
  ```

  A job's own `schedule` in `defineJob` counts too; keep schedules in the
  config so the gate covers all of them.
- **A separate process** for jobs: a worker with no web traffic that runs the
  same build with the schedules, or system cron / a Kubernetes `CronJob` calling
  `denext job <name>` on demand.
- **`Deno.cron`** on Deno Deploy (or a self-host started with
  `--unstable-cron`): the platform runs each schedule once per deployment, which
  is the managed scheduler denext prefers whenever it is present.

Make handlers **idempotent** regardless — a retry, a manual `denext job` during
a scheduled run on another node, or a redeploy mid-run all produce a second
execution. Run history (`jobs: { history: true }`) is a per-node SQLite file,
so the Project UI's Cron page shows the runs of whichever node's project
directory it reads; `jobs: { history: { store: postgresJobHistoryStore({ url }) } }`
shares one history across replicas. See [Scheduled jobs](/docs/jobs).

## Postgres behind replicas

When every replica shares one Postgres:

- **Schema at boot.** Each store (and `@denext/backend`) applies its migrations
  under a transaction-scoped advisory lock, so replicas starting together take
  turns and the one that waited skips what the other applied. Where a release
  step applies the schema instead, set `DENEXT_BOOT_DDL=off` on the replicas:
  they then only check that every migration is recorded and refuse to start
  with `boot_schema_missing` otherwise. See
  [Schema at startup](/docs/database#schema-at-startup).
- **Connections.** Each instance holds up to `max` pooled connections plus one
  for `LISTEN` when something listens; keep `instances × (max + 1)` under the
  server's `max_connections`.
- **A transaction-mode pooler** (PgBouncer, Supavisor) breaks `LISTEN`, reserved
  connections and session-level locks. Give denext a direct connection with
  `directUrl` (every store takes it; `backend({ postgres })` reads
  `DATABASE_DIRECT_URL`): queries keep going through the pooler, while
  `LISTEN`, reserved connections and every migration and its lock use the
  direct one. See
  [Pool sizing, timeouts and PgBouncer](/docs/database#pool-sizing-timeouts-and-pgbouncer).

## Caps are per process

`maxConcurrency`, Live's `live.limits` (`maxConnections`,
`maxConnectionsPerIp`, subscriptions, rooms) and `@denext/graphql`'s
subscription connection caps (which default to Live's) are counted inside one
process. Three replicas each allowing 64 connections per address allow 192 in
total. Size each cap to what one instance can carry, and put the cluster-wide
ceiling at the edge (see
[Put a concurrency ceiling in front of denext](/docs/deploy#1-put-a-concurrency-ceiling-in-front-of-denext-required)).

## What does not need anything

- Signed-cookie sessions (`getSession`, auth `strategy: "cookie"`) — shared
  secret, no state.
- Server Actions, route handlers, rendering — stateless per request.
- `.env` files — each node reads its own; use the platform's secret store so
  they agree.
- The client bundle — its chunks are content-hashed and served immutable, so a
  rolling deploy that briefly runs two versions is safe as long as each version
  serves its own build (a page rendered by the old image links the old image's
  chunks; see
  [Deployment targets › Zero-downtime](/docs/deployment-targets#zero-downtime-and-rolling-restarts)).

See also: [Production checklist](/docs/production-checklist),
[Deployment](/docs/deploy),
[Databases › Postgres](/docs/database#postgres).
