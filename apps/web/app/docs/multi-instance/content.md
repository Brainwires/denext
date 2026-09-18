---
title: Multi-instance deployments
slug: multi-instance
lead: One denext process is self-contained by default — its cache, sessions, rate-limit counters, auth database, Live fan-out and cron scheduler all live in that process. Every one of those is a per-node component with a small interface behind it. This page lists them, says exactly what stops being true when a second replica starts, and names the interface you implement to make it true again.
---

## The short version

| Component                              | Default                                                               | Across two instances                                                               | Make it shared with                                                                 |
| -------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Data + ISR page cache                  | `node:sqlite` file, `.denext/cache.db` (memory if unwritable)         | `revalidateTag` on A does **not** purge B; each node renders and caches on its own | `cache.store` → your `CacheStore`                                                   |
| Auth sessions (`strategy: "database"`) | none until you choose (`inMemorySessionStore` / `sqliteSessionStore`) | a session created on A is unknown to B; a revoke on A does not reach B             | `sessionStore` → your `SessionStore`                                                |
| Rate-limit counters                    | `inMemoryRateLimitStore()` per process                                | every limit is multiplied by the replica count                                     | `store` → your `RateLimitStore`                                                     |
| Users, accounts, credentials           | `sqliteAuthAdapter` = one SQLite file                                 | single node (or a shared volume)                                                   | `adapter` → your `AuthAdapter`                                                      |
| Live channels + tag pushes             | in-memory loopback transport                                          | a `publish` on A reaches A's sockets only                                          | `setChannelTransport(t)` → `broadcastChannelTransport()` or your `ChannelTransport` |
| Scheduled tasks (userland)             | minute-tick scheduler in every process                                | **fires on every replica**                                                         | one designated instance, or `Deno.cron`                                             |
| Task run history                       | `.denext/tasks.db` per process                                        | each node sees its own fragment                                                    | (per node by design)                                                                |

Signed-cookie sessions (`getSession()` and auth's default `strategy: "cookie"`)
are the one thing on the list that is already replica-safe: the whole payload is
in the cookie, verified with the shared `SESSION_SECRET`. No Redis, Postgres or
KV implementation of any interface ships with denext today — that is a
[roadmap item](https://github.com/Brainwires/denext/blob/main/ROADMAP.md); each
interface is small enough that the rest of this page can show the shape.

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
}
```

The contract: every method may be sync or async (denext awaits); `get*` must
return only **fresh** entries — treating `expiresAt` in the past as a miss is
the store's job (a `DataEntry` also carries `staleAt` and `tags`; a `CachedPage`
carries its own timing); a store without `expireByTag` gets a hard `deleteByTag`
instead of stale-while-revalidate. A Redis sketch that keeps one JSON value per
key plus a set per tag and per path so invalidation is two round-trips:

```ts
// lib/redis-cache.ts — a sketch from the interface (untested; adapt the client calls)
import type { CachedPage, CacheEntryTiming, CacheStore, DataEntry } from "denext/server";
import { createClient } from "npm:redis";

const r = createClient({ url: Deno.env.get("REDIS_URL") });
await r.connect();

const ttl = (expiresAt: number) =>
  Number.isFinite(expiresAt) ? { PX: Math.max(1, expiresAt - Date.now()) } : {};
const fresh = <T extends { expiresAt: number }>(
  raw: string | null,
): T | undefined => {
  if (!raw) return undefined;
  const entry = JSON.parse(raw) as T;
  return entry.expiresAt > Date.now() ? entry : undefined;
};

async function index(
  kind: "data" | "page",
  key: string,
  tags: string[],
  path?: string,
) {
  for (const t of tags) await r.sAdd(`tag:${t}`, `${kind}:${key}`);
  if (path) await r.sAdd(`path:${path}`, `${kind}:${key}`);
}

async function purge(setKey: string) {
  const members = await r.sMembers(setKey);
  if (members.length) await r.del(members);
  await r.del(setKey);
}

export const redisCacheStore: CacheStore = {
  getData: async (key) => fresh<DataEntry>(await r.get(`data:${key}`)),
  async setData(key, entry) {
    await r.set(`data:${key}`, JSON.stringify(entry), ttl(entry.expiresAt));
    await index("data", key, entry.tags);
  },
  getPage: async (key) => fresh<CachedPage>(await r.get(`page:${key}`)),
  async setPage(key, page) {
    await r.set(`page:${key}`, JSON.stringify(page), ttl(page.expiresAt));
    await index("page", key, page.tags, page.path);
  },
  deleteByTag: (tag) => purge(`tag:${tag}`),
  deleteByPath: (path) => purge(`path:${path}`),
  async expireByTag(tag, timing: CacheEntryTiming) {
    for (const member of await r.sMembers(`tag:${tag}`)) {
      const raw = await r.get(member);
      if (!raw) continue;
      const entry = {
        ...JSON.parse(raw),
        staleAt: timing.staleAt,
        expiresAt: timing.expiresAt,
      };
      await r.set(member, JSON.stringify(entry), ttl(timing.expiresAt));
    }
  },
};
```

```ts
// denext.config.ts
import { redisCacheStore } from "./lib/redis-cache.ts";
export default { cache: { store: redisCacheStore } };
```

The sketch shows the _shape_ of a tag index, not a tested driver — `DataEntry`
is `{ value, expiresAt, staleAt?, tags }` and `CachedPage` is the full HTML
`body` plus `status`, `path`, `expiresAt`, `staleAt?`, `tags` and the page's
hash-based `csp`, so a store round-trips a few KB per page. Keep the page cache
behind a CDN and let the shared store be the origin's memory, not the edge's.
`/_denext/health` reports `"cacheStore": "custom"` once yours is installed, and
`cacheStoreHealthy()` probes it.

Two cheaper options when a shared store is more than the app needs: **a CDN** in
front of each node with a `Cache-Control` rule on the ISR paths (see
[CDN headers](/docs/data#cdn-headers)), accepting that invalidation is the CDN's
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
a read and its refresh stays revoked. In Redis that is `SET … XX`; in SQL an
`UPDATE … WHERE id = ?` whose row count you return. `inMemorySessionStore` is
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
lockout. A Redis `INCR` + `PEXPIRE NX` per key is the whole implementation. Pass
it as `rateLimit({ store })` and `denextAuth({ rateLimit:
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

`broadcastChannelTransport()` (from `denext/server`) implements it over the Web
`BroadcastChannel` API, which on **Deno Deploy** spans the isolates of one
deployment — that is its purpose; on a self-host it reaches only the workers of
one process, so it does not make two containers talk. Install it, or your own
two-method Redis pub/sub / NATS transport, with `setChannelTransport(t)`; the
hub re-subscribes. An event carries an `instance` id and a per-instance `seq`,
so ordering holds per publisher, not globally. Without a transport, the
practical alternative is **sticky sessions** at the balancer so a viewer's
socket and the actions that publish to it land on the same node — which works
for a single user's own updates and not for anything shared between users. See
[Live › Delivery semantics & scaling](/docs/live#delivery-semantics--scaling).

## Scheduled tasks: one runner, not one per replica

The userland scheduler is a minute tick inside every process that has tasks.
There is **no leader election**: three replicas each run `0 3 * * *` at 03:00
UTC, and the overlap guard (a task never runs concurrently with _itself_) is per
process. Pick one of:

- **Designate one instance.** Start exactly one replica with the schedules
  configured and the others with `scheduledTasks` empty — for example gate the
  config on an env var:

  ```ts
  // denext.config.ts
  const runner = Deno.env.get("TASK_RUNNER") === "1";
  export default {
    scheduledTasks: runner ? { "0 3 * * *": "cleanup" } : {},
  };
  ```

  A task's own `schedule` in `defineTask` counts too; keep schedules in the
  config so the gate covers all of them.
- **A separate process** for tasks: a worker with no web traffic that runs the
  same build with the schedules, or system cron / a Kubernetes `CronJob` calling
  `denext task <name>` on demand.
- **`Deno.cron`** on Deno Deploy (or a self-host started with
  `--unstable-cron`): the platform runs each schedule once per deployment, which
  is the managed scheduler denext prefers whenever it is present.

Make handlers **idempotent** regardless — a retry, a manual `denext task` during
a scheduled run on another node, or a redeploy mid-run all produce a second
execution. Run history (`tasks: { history: true }`) is a per-node SQLite file,
so the Project UI's Cron page shows the runs of whichever node's project
directory it reads. See [Scheduled tasks](/docs/tasks).

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
[Databases › Postgres / MySQL](/docs/database#postgres--mysql-multi-instance).
