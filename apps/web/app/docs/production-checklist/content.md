---
title: Production checklist
slug: production-checklist
lead: The go-live list, one line per item, with the exact config key, flag or environment variable it takes and where it is explained. Most of it is already on by default — the list is mostly about the handful of things only you can decide.
---

## What denext does before you do anything

A freshly built app served by `denext start` already **drains on
`SIGTERM`/`SIGINT`** (stops accepting connections, finishes in-flight requests,
bounded by a 10 s deadline), **times out** any request still running after 30 s
with a `503` and aborts the render's cooperative `AbortSignal`, **sheds** load
with a fast `503 + Retry-After` once the optional in-process concurrency ceiling
is reached, **caps request bodies** at 1 MiB for route handlers and Server
Actions (an over-cap body is a `413` before your code runs), bounds a slow body
read separately, keeps a **request id** on every request (an inbound
`x-request-id` from a trusted proxy, else a fresh UUID) and echoes it on every error
response, sets **`httpOnly` + `SameSite=Lax` + `Secure`** on every cookie,
refuses a session secret shorter than 32 characters in production, ships the
**hardening headers** (`X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, HSTS over HTTPS) and a strict hash-based **CSP** on every
HTML page, redacts server errors, and gives you `safeFetch` — a `fetch` that
resolves the host, refuses private/loopback/link-local addresses, **pins the
resolved IP** for the connection (closing DNS rebinding) and re-validates every
redirect hop. Nothing on this list needs to be turned on. The
[deployment guide](/docs/deploy) explains each in depth; this page is the short
form you run down before flipping DNS.

## The checklist

Each line: what to set → where it is documented. Config keys go in
`denext.config.ts`; the env var listed after a key is read when the key is unset
(config > env > default).

**Secrets and identity**

- `SESSION_SECRET` — at least **32 random characters**; shorter warns in dev and
  **throws in production**. Pass an array to rotate (`[new, old]`: all verify,
  the first signs). →
  [Cookies are secure by default](/docs/deploy#7-cookies-are-secure-by-default)
- `DENEXT_ENV=production` (or `NODE_ENV`) — `denext start` sets it when neither
  is present, so every "refuse in production" guard is armed. Your
  `.env.production` (and `.env.production.local`) load for that mode; the shell
  always wins over a file. → [Environment variables](/docs/environment)
- `hostPrefix: true` on `getSession()` / the auth cookie — renames the cookie to
  `__Host-…`, which the browser then binds to the exact origin (`Secure`,
  `Path=/`, no `Domain`). Turn it on **before** launch: enabling it later logs
  everyone out once. → [Cookies](/docs/deploy#7-cookies-are-secure-by-default)

**Behind a proxy or load balancer**

- `canonicalOrigin: "https://example.com"` (env `DENEXT_CANONICAL_ORIGIN`) —
  pins the public origin for absolute URLs, the Server Action origin check and
  HSTS. Without it, a proxy that rewrites `Host` makes **every Server Action
  answer `403`**. →
  [Tell denext about your proxy](/docs/deploy#6-tell-denext-about-your-proxy-origin--forwarded-headers)
- `trustForwardedHeaders: true` (env `DENEXT_TRUST_PROXY=1`) — only when clients
  **cannot** reach denext directly; it makes `X-Forwarded-Proto` /
  `X-Forwarded-Host` trusted for the origin and HSTS. Ignored when
  `canonicalOrigin` is set. The rate limiters key on the socket peer unless told
  the same thing separately — `rateLimit({
  trustForwardedHeaders: true })` and
  `denextAuth({ trustForwardedHeaders: true })` — and then use the **last**
  `x-forwarded-for` hop, the one your proxy appended. →
  [same section](/docs/deploy#6-tell-denext-about-your-proxy-origin--forwarded-headers)
- A concurrency ceiling and TLS **at the edge** (nginx `limit_conn`, Caddy, your
  platform) — the in-process `maxConcurrency` complements it, it does not
  replace it. →
  [Put a concurrency ceiling in front of denext](/docs/deploy#1-put-a-concurrency-ceiling-in-front-of-denext-required)

**Permissions and files**

- `--allow-write=.denext` on the start command — the durable `node:sqlite` cache
  lives at `.denext/cache.db` and task history at `.denext/tasks.db`. Without
  the grant the cache **silently falls back to memory** (one warning line at
  boot; `/_denext/health` reports `"cacheStore": "memory"`). The scaffold's
  `deno task start` already grants it. →
  [Health & readiness](/docs/deploy#13-health--readiness)
- Back up `.denext/*.db` and any app database (`auth.db` from
  `sqliteAuthAdapter`, `.denext/sessions.db` from `sqliteSessionStore`, your own
  `app.db`) like any SQLite file: copy the `-wal`/`-shm` siblings too, or use
  `VACUUM INTO` from a task. The cache is disposable; the others are not. →
  [Databases](/docs/database)
- Deno Deploy has **no persistent disk**: the cache is per-isolate memory, task
  history is a fragment that resets, and a SQLite file does not survive. Inject
  a shared `CacheStore` / `SessionStore` / `AuthAdapter` there. →
  [Multi-instance](/docs/multi-instance)

**Limits**

- `requestTimeout` (env `DENEXT_REQUEST_TIMEOUT_MS`, default `30000`; `0`
  disables) — the per-request deadline → `503`. A long SSE or AI stream is _not_
  cut at the deadline (the response is already out); see
  [Route handler recipes](/docs/route-handler-recipes#server-sent-events). It
  bounds _awaiting_, not CPU (§2 of the [deployment guide](/docs/deploy)). →
  [Production server config](/docs/config#production-server)
- `maxConcurrency` (env `DENEXT_MAX_CONCURRENCY`, default unlimited) — in-flight
  requests per instance; at capacity a request is shed at once with `503` +
  `Retry-After: 1`, never queued. Size it to what one instance can render, not
  to your traffic. → [Production server config](/docs/config#production-server)
- `DENEXT_SHUTDOWN_DRAIN_MS` (default `10000`; `0` waits forever) — the drain
  deadline on shutdown. Above your longest request, below the orchestrator's
  kill grace (k8s `terminationGracePeriodSeconds`, default 30 s). →
  [Graceful shutdown](/docs/deploy#10-graceful-shutdown)
- `apiMaxBodyBytes` / `actionMaxBodyBytes` (default 1 MiB each) — the
  route-handler and Server Action body caps; a single route lifts its own with
  `export const maxBodyBytes = N | false`. Raise them only on the routes that
  take uploads. → [File uploads](/docs/uploads)
- Rate limiting — `rateLimit({ max, windowMs })` from `denext/server` on a
  `createApi()` chain (429 + `Retry-After` before validation runs), the auth
  flows' built-in limiters, and a coarse per-IP limit at the edge. The default
  stores are **per process**; pass a shared `store` behind replicas. →
  [Typed API](/docs/typed-api), [Auth › Rate limiting](/docs/auth#rate-limiting)

**Headers and policy**

- `csp` — the strict hash-based policy is **on by default** for App Router pages
  (`"strict"`); `"off"` hands it to your edge, an object adds hosts
  (`{ connectSrc: [...] }`). In SPA mode it is opt-in. Flight, API and static
  responses carry no framework CSP — set one at the edge if you want it there. →
  [CSP is applied to page responses](/docs/deploy#5-csp-is-applied-to-page-responses-not-flightapistatic)
- `hsts` — `max-age=31536000` host-only by default;
  `{ includeSubDomains: true }` only when every subdomain is HTTPS. →
  [Configuration › Security](/docs/config#security)
- `headers()` rules for CDN caching of ISR pages — denext emits **no
  `Cache-Control`** on an ISR hit today, so a CDN in front needs the rule. →
  [Data & caching › CDN headers](/docs/data#cdn-headers)

**Observability**

- `DENEXT_LOG=json` — one JSON object per request (`method`, `path`, `status`,
  `statusClass`, `durationMs`, `requestId`); `DENEXT_LOG=1` for the compact
  line. → [Request logging](/docs/deploy#9-request-logging)
- `instrumentation.ts` — export `onRequest(info)` for metrics and
  `onRequestError(err,
  request, ctx)` for your error sink (Sentry-shaped
  context); `register()` runs once at boot. →
  [Observability](/docs/deploy#14-observability)
- `/_denext/health` — GET/HEAD, always `200`; the body's `cache` (`ok` /
  `degraded`) and `cacheStore` (`sqlite` / `memory` / `custom`) are the two
  fields to alert on. Point the load balancer here, or build a readiness route
  on `cacheStoreHealthy()`. →
  [Health & readiness](/docs/deploy#13-health--readiness)
- Propagate your edge's trace id as `x-request-id`; with `trustForwardedHeaders`
  (or `DENEXT_TRUST_PROXY=1`) denext keeps it (sanitized) and echoes it on every
  error response. →
  [Correlation ids](/docs/deploy#8-correlation-ids)

**Supply chain and pre-flight**

- `denext audit --sbom --strict` in CI — a CycloneDX SBOM plus a non-zero exit
  if the runtime source imports npm. →
  [Doctor & audit](/docs/doctor-audit#denext-audit)
- Deno's minimum-dependency-age policy — `minimumDependencyAge` in `deno.json`
  (or `--min-dep-age`) keeps a just-published package version out of a build for
  a cooling-off period; `DENEXT_MIN_DEP_AGE` forwards it to every child denext
  spawns. Decide the window deliberately rather than passing `--min-dep-age=0`
  in CI to make a red build go away.
- `denext doctor` — environment checks plus a render of **every route** on the
  real SSR path (dynamic routes expanded through `generateStaticParams`),
  exiting non-zero on a malformed document or a server crash; run it in CI
  before the image is promoted. →
  [Doctor & audit](/docs/doctor-audit#denext-doctor)
- Commit `deno.lock`; build the image with `deno install` from it so the deploy
  runs the versions CI tested. → [Deployment › Docker](/docs/deploy#docker)

**Multiple instances**

- If you run more than one replica: a shared `cache.store`, a shared auth
  `sessionStore` / `adapter`, a shared `rateLimit.store`, a `ChannelTransport`
  for Live, and **one** designated instance (or `Deno.cron`) for scheduled
  tasks. Every item is a per-node component by default. →
  [Multi-instance](/docs/multi-instance)

## Copy-paste

The environment a single self-hosted instance behind a TLS-terminating proxy
needs:

```sh
SESSION_SECRET=…                                 # ≥ 32 random chars
DENEXT_ENV=production                            # denext start sets it if absent
DENEXT_CANONICAL_ORIGIN=https://example.com      # or canonicalOrigin in the config
DENEXT_LOG=json
DENEXT_SHUTDOWN_DRAIN_MS=10000
PORT=3000                                        # every PaaS injects one; --port overrides
```

```sh
deno run --allow-net --allow-read --allow-env --allow-write=.denext jsr:@denext/denext@^2/cli start .
```

And the config keys that belong in `denext.config.ts` rather than the
environment, because they describe the app and not the host:

```ts
// denext.config.ts
import type { DenextConfig } from "denext/server";

export default {
  canonicalOrigin: "https://example.com",
  maxConcurrency: 100,
  headers: () => [
    {
      source: "/blog/:slug",
      headers: [{
        key: "Cache-Control",
        value: "public, s-maxage=60, stale-while-revalidate=600",
      }],
    },
  ],
  tasks: { history: true },
} satisfies DenextConfig;
```

See also: [Deployment](/docs/deploy) (the long form),
[Deployment targets](/docs/deployment-targets) (where to run it),
[Multi-instance](/docs/multi-instance) (what stops being true with two of them),
[Security posture](/docs/security) (threat by threat).
