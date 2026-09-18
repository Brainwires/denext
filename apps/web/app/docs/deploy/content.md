---
title: Deployment
slug: deploy
lead: denext ships secure, production-minded defaults (graceful drain, request cancellation/timeout, body/cache/prefetch caps, error redaction, correlation ids, opinionated hardening headers, config validation). A few operational responsibilities are yours to configure at the edge/platform — this guide lists them.
---

denext ships secure, production-minded defaults (graceful drain, request
cancellation/timeout, body/cache/prefetch caps, error redaction, correlation
ids, opinionated hardening headers, config validation). A few operational
responsibilities are **yours** to configure at the edge/platform — they are
deliberately not baked into the framework so denext stays a thin, fast core.
This document lists them. See [the security guide](/docs/security) for the
threat-by-threat security posture and [the differences guide](/docs/differences)
for the safe defaults that deliberately differ from Next's.

## 0. Deploy recipes

`denext build` writes a `.denext/` output; `denext start` serves it. Build in
the image/CI, then run `start`.

### Static export

If your app is fully static (no per-request data), export it to plain HTML and
host it anywhere — this very docs site is built that way:

```sh
denext export .   # writes out/ — pure HTML, 0 KB JS on static pages
```

### Docker

```dockerfile
FROM denoland/deno:2.9.6

# Build and run as the image's unprivileged `deno` user — /app must be its own, because
# the build writes .denext/ and the durable cache (.denext/cache.db) lives there too.
WORKDIR /app
RUN chown deno:deno /app
USER deno

# Dependency layer: cached until deno.json / deno.lock change.
COPY --chown=deno:deno deno.json deno.lock* ./
RUN deno install

COPY --chown=deno:deno . .
RUN deno task build

EXPOSE 3000
# The built-in probe; its body reports the cache store ("memory" = write grant missing).
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD deno eval "fetch('http://127.0.0.1:3000/_denext/health').then((r)=>Deno.exit(r.ok?0:1)).catch(()=>Deno.exit(1))"

# `deno task start` = --allow-net --allow-read --allow-env --allow-write=.denext (the
# least-privilege task `denext create` writes; the write grant keeps the cache durable).
CMD ["deno", "task", "start"]
```

`docker build -t my-app . && docker run -p 3000:3000 -e SESSION_SECRET=… my-app`.
Put a concurrency ceiling / TLS in front (§1) — a reverse proxy or your
platform. Behind that proxy, tell denext its public origin (§6):
`-e DENEXT_CANONICAL_ORIGIN=https://example.com` (or `DENEXT_TRUST_PROXY=1`) —
without it every Server Action posted through a proxy that rewrites `Host` is
refused as cross-origin (`403`).

**Don't hand-write it.** `denext generate docker` writes the `Dockerfile`,
`docker-compose.yml` and `.dockerignore` for you — SSR or static image
auto-detected from your config — and the [Project UI](/docs/ui)'s Docker panel
regenerates the same three files with options (image mode `server` | `static`,
port, `denoland/deno` tag, an optional Postgres service that publishes
`127.0.0.1:5432`) and shows a per-file diff before it writes. Both are the same
templates, and a file you edited by hand (one without the generated-file
sentinel header) is never overwritten. The generator is the source of truth: the
snippet above is a readable illustration and can lag it in details like the
dependency-cache layer, the exact run flags and whether the port comes from
`PORT` or `--port`.

### Deno Deploy

Push the repo and point the entrypoint at `jsr:@denext/denext@^2/cli` with args
`start .`, or add a build step running `deno task build`. Deno Deploy provides
TLS and autoscaling; still set a per-instance `maxConcurrency` (§1) and your
secrets (`SESSION_SECRET`, etc.) as environment variables.

denext's cache defaults to Deno's built-in `node:sqlite` (a local SQLite file),
but Deno Deploy has no persistent local filesystem, so the cache falls back to a
per-instance **in-memory** store there. For a cache that is durable and shared
across edge instances, inject your own `CacheStore` via `cache.store` in
`denext.config.ts`.

### Self-host (systemd)

```ini
# /etc/systemd/system/my-app.service
[Service]
WorkingDirectory=/srv/my-app
Environment=PORT=3000
Environment=SESSION_SECRET=…
Environment=DENEXT_CANONICAL_ORIGIN=https://example.com
ExecStart=/usr/local/bin/deno run --allow-net --allow-read --allow-env --allow-write=.denext jsr:@denext/denext@^2/cli start .
Restart=always
[Install]
WantedBy=multi-user.target
```

Run `deno task build` in your deploy step, then `systemctl restart my-app`.
Front it with nginx/Caddy for TLS + the concurrency limit (§1).

## 1. Put a concurrency ceiling in front of denext (required)

denext does **not** impose a built-in cap on concurrent in-flight requests or a
CPU ceiling. A single Deno process will accept as many connections as the
runtime allows; a flood (or a few very expensive renders) can exhaust memory or
peg the CPU. In production you **must** bound concurrency at the layer in front:

- a reverse proxy (`nginx` `limit_conn`/`limit_req`, Caddy, HAProxy),
- a platform autoscaler + per-instance connection limit, or
- an API gateway / load balancer with request-rate and concurrency limits.

Run multiple denext instances behind that layer to scale out; size each
instance's concurrency to its CPU/memory budget.

**Optional in-process backstop (`maxConcurrency`).** As a complement — _not_ a
replacement — for the edge ceiling, set `maxConcurrency` in `denext.config.ts`
(or the `DENEXT_MAX_CONCURRENCY` env var; the config wins when both are set):
the max number of client requests one instance handles at once. A request that
arrives at capacity is **shed immediately** with a `503` and `Retry-After: 1`.
It is fast-fail, never queued, so shedding stays O(1) and can't itself amplify
the overload. A slot is held from arrival until the response is **produced** and
released on every exit path (success, error, abort, timeout); for a streaming
body the slot frees when the `Response` is returned, not when the body finishes.
This is deliberate: it bounds handler/render concurrency up to Response
production, but does **not** count a stream's client-read duration. Holding a
slot until a stream drains would let a slow-reading client pin slots (slowloris)
and would let long-lived SSE exhaust the ceiling — so the client-read duration
of streaming bodies (SSE, chunked handler responses, large static files) must be
bounded at the **edge / load balancer** (slow-client read timeouts, max
concurrent connections), not by this in-process counter. Background ISR
regeneration is exempt. Default: no limit. Set it slightly above your
steady-state target so a single instance self-protects if the edge limit is
misconfigured — the edge ceiling above is still required.

```ts
// denext.config.ts
export default { maxConcurrency: 100 } satisfies DenextConfig;
// or, per deployment: DENEXT_MAX_CONCURRENCY=100 deno task start
```

**`slotBackstop` (with `requestTimeout: 0`).** If you disable the request
timeout (`requestTimeout: 0`) _and_ set `maxConcurrency`, a render that never
settles would otherwise hold its slot forever and could eventually wedge the
whole ceiling to 503s. A backstop timer (default 120s, tune via the
`slotBackstop` config key) force-frees the slot in that case — it frees only the
counter, it does **not** abort the render (you opted out of timing requests
out). With the default `requestTimeout` in place, the timeout already settles
the request, so the backstop is inert.

## 2. `requestTimeout` bounds _awaiting_, not _CPU_

`requestTimeout` (a `denext.config.ts` key in milliseconds, or
`DENEXT_REQUEST_TIMEOUT_MS`; default 30s, `0` disables) aborts a request whose
work is cooperative — i.e. it awaits I/O and threads the per-request
`AbortSignal` into its `fetch()`es. It **cannot** preempt a synchronous CPU loop
(a tight `while`, a pathological regex, an unbounded synchronous render):
JavaScript is single-threaded, so a synchronous hot loop blocks the event loop
until it returns. Keep render/handler code free of unbounded synchronous work,
and rely on the edge concurrency ceiling (§1) to contain the blast radius.

## 3. Outbound `fetch()` is not SSRF-pinned by default

denext's image optimizer pins DNS and refuses private/loopback/link-local
targets via `safeFetch`. **Your own** server-side `fetch()` calls (in server
components, route handlers, Server Actions) are ordinary `fetch` — they are
**not** DNS-pinned. If you fetch a **user-controlled URL** on the server, wrap
it in the exported `safeFetch` so a hostile host/redirect can't reach your
metadata endpoint or internal network:

```ts
import { safeFetch } from "denext/server";

// Refuses if any resolved A/AAAA is loopback/private/link-local/CGNAT/etc.
const res = await safeFetch(userProvidedUrl);
```

That covers link previews, "import from URL", avatar-by-URL, webhooks, and
anything else where the user names the host: `safeFetch` resolves + validates
the host, refuses internal addresses, pins the connection (closing DNS
rebinding), and bounds time and size.

```ts
import { safeFetch, SafeFetchError } from "denext/server";

try {
  const res = await safeFetch(userUrl, {
    allowedHosts: ["*.trusted-cdn.com"], // optional; omit = any public host
    maxBytes: 5_000_000,
    signal: AbortSignal.timeout(8000), // or an AbortController's signal
  });
} catch (e) {
  if (e instanceof SafeFetchError) { /* e.code: "blocked-address", … */ }
}
```

For fixed, trusted URLs plain `fetch` is fine. Keep using `fetch`/`cachedFetch`
for your **own** backends (internal services, `localhost`) — those are exactly
the addresses `safeFetch` deliberately blocks.

## 4. Redirect helpers

- `redirect()` (control-flow), config-driven `redirects()`, and the **middleware
  `redirectResponse()` helper** normalize their target through
  `safeRedirectLocation`, collapsing protocol-relative escapes (`//host`,
  `/\host`, …) to a same-origin path.
- `safeRedirectLocation` **passes an explicit absolute URL through verbatim**
  (that is intended — you asked to leave the origin), so
  `redirect("https://" + userInput)` is still an open redirect. Do not pass a
  user-controlled absolute URL to a redirect without validating it against your
  own allowlist first.
- **Don't build a redirect/rewrite destination _host_ from request input.** A
  config rule like `{ destination: "https://:host/..." }` substitutes a URL
  param into the host — an open redirect. A `rewrite` to an external host is
  **not** an SSRF in denext (rewrites re-route by pathname against your local
  manifest and never proxy), but it is still a misconfiguration. Keep params in
  the path.
- `NextResponse.redirect(url)` keeps Next.js's stricter contract: `url` must be
  absolute and a relative string throws.

## 5. CSP is applied to page responses, not Flight/API/static

denext computes a strict Content-Security-Policy for HTML page responses,
**buffered and streamed** alike — a streamed page and a Cache Components / PPR
shell with per-request holes carry the same hash-based policy, because the swap
runtime is a hashed constant and the head's inline styles are hashed before the
first byte flushes (see the streaming note below). **Flight/RSC** payload
responses are not HTML documents and carry no framework-generated CSP; neither
do API-route or static responses. If you want a policy on those, **set it at the
edge** (reverse proxy / CDN). (A streamed PPR response is `private, no-store`,
so an intermediary never shares it.)

The framework CSP keeps `script-src 'self'` and never hashes arbitrary inline
`<script>` output (so injected script can't self-authorize a hash) — denext
emits no executable inline script of its own on the buffered path; its data
islands are `type="application/json"` and its runtime is a same-origin
`<script src>`. It DOES hash each inline `<style>` block into `style-src`.
External scripts/styles are blocked until a route opts hosts in.

**Configuring it (three-state, global with per-file override):**

```ts
// denext.config.ts — app-wide default:
export default {
  csp: "strict", // default: the hash-based strict policy
  // csp: "off",                    // emit NO CSP header (set it at the edge / Next-style)
  // csp: { connectSrc: ["https://api.example.com"] }, // strict + these global opt-ins
};
```

```ts
// a route file overrides the global for that route:
export const csp = { scriptSrc: ["https://plausible.io"] }; // strict + this route's opt-ins
// export const csp = "off";   // disable CSP for just this route (e.g. an embed)
// export const csp = "strict"; // force strict here even when the global default is "off"
```

**Incremental streaming (`streaming`).** **On by default.** A route with a
pending `<Suspense>` boundary flushes its shell first and streams each boundary
as it resolves; streamed responses carry the **same strict hash-based CSP** as
buffered ones (the swap runtime is a hashed constant). A fully synchronous route
(no holes) is still delivered buffered, so it stays shared-cacheable, and
ISR/PPR-cacheable routes take their own path first — so streaming never bypasses
the page cache. A streamed route is rendered per request (`no-store`), not
ISR-cached. Opt the whole app out with `streaming: false` (a top-level config
field).

## 6. Tell denext about your proxy (origin + forwarded headers)

Behind a TLS-terminating reverse proxy, denext needs to know its real public
origin for correct absolute URLs, Server-Action **CSRF origin checks**, and
HSTS. Configure one of, in `denext.config.ts` or as an env var (the config wins
when both are set):

- **`canonicalOrigin: "https://example.com"`** (env `DENEXT_CANONICAL_ORIGIN`) —
  pins the public origin outright (wins over any header; the most robust
  option). A bare origin — scheme + host, no path; anything else fails config
  validation at boot. Or
- **`trustForwardedHeaders: true`** (env `DENEXT_TRUST_PROXY=1`) — trust
  `x-forwarded-proto` / `x-forwarded-host` from the proxy. Only enable this when
  clients **cannot** reach denext directly and spoof those headers.

```ts
// denext.config.ts
export default {
  canonicalOrigin: "https://example.com",
} satisfies DenextConfig;
```

With neither set, denext derives the origin from the `Host` header / request URL
and treats `x-forwarded-proto` as untrusted (so a spoofed
`x-forwarded-proto:
https` will **not** induce HSTS, and the action-CSRF check
uses the connection's own scheme). The symptom of a proxy that rewrites `Host`
with neither set is every Server Action answering `403` (its `Origin` no longer
matches the `Host` denext sees) — set one of the two and it clears.

The same rule governs the helpers: **`absoluteUrl`/`requestOrigin` derive the
origin from the `Host` header** unless you opt in with `trustForwardedHeaders`.
A client can spoof `Host`, so for a fixed public origin set `canonicalOrigin` —
it overrides the header and is the robust choice for canonical and `og:image`
URLs.

## 7. Cookies are secure by default

`cookies().set()` defaults to **`httpOnly` + `SameSite=Lax` + `Secure`** (Secure
is added over HTTPS — directly or behind a proxy that sets
`x-forwarded-proto: https`). This is stricter than Next.js (which adds nothing)
— a deliberate secure default. To set a cookie the browser's JS must read, opt
out explicitly:

```ts
cookies().set("theme", "dark", { httpOnly: false }); // client-readable
```

For sessions, set a strong `SESSION_SECRET` (≥32 chars; a shorter one warns in
dev and throws in production) and prefer the built-in signed-cookie helper
instead of hand-rolling:

```ts
import { getSession } from "denext/server";
const session = await getSession<{ userId: string }>({
  secret: Deno.env.get("SESSION_SECRET")!, // long + random (≥32 chars; shorter warns in dev, throws in prod)
  hostPrefix: true, // recommended: origin-lock the cookie (__Host- → Secure, Path=/, no Domain)
});
await session.set({ userId: user.id }); // signed (HMAC), httpOnly, Secure, SameSite=Lax
```

`hostPrefix: true` renames the cookie to `__Host-denext_session` and pins the
browser-enforced origin-lock invariants, so a sibling subdomain can't set or
read it. Enable it from the start on new apps (turning it on later logs existing
users out once, since the cookie is renamed).

## 8. Correlation ids

Every response carries a request id (surfaced in the request log and echoed as
`x-request-id` on error responses). denext reuses an inbound `x-request-id` from
your proxy when present (sanitized to safe token characters and length-bounded),
otherwise it mints a UUID. Propagate a trace id from your edge as `x-request-id`
to correlate proxy and app logs.

## 9. Request logging

Set `DENEXT_LOG=json` for structured (one-JSON-object-per-line) request logs
suited to log pipelines — each object carries a `statusClass` field (`2xx`,
`5xx`, …) ready to ingest; any other truthy value (e.g. `DENEXT_LOG=1`) emits a
compact human-readable one-line-per-request log. Logged fields (method, path,
status, duration, request id) are safe against log forging (the request id is
sanitized; JSON output escapes control characters). For a programmatic hook
instead of (or alongside) the env var, see the `onRequest` callback in §14.

## 10. Graceful shutdown

On `SIGTERM`/`SIGINT` the server stops accepting new connections and drains
in-flight requests, then runs plugin teardowns. Draining is bounded by a
deadline (default **10s**): set `DENEXT_SHUTDOWN_DRAIN_MS` to tune it, or `0` to
drain indefinitely. If the deadline elapses with requests still in flight the
process force-exits (and plugin teardown is skipped). Size it above your longest
expected request and below your orchestrator's kill grace (e.g. k8s
`terminationGracePeriodSeconds`, typically 30s).

## 11. The ISR page-cache key omits the Host (multi-tenant caveat)

The built-in ISR page cache keys entries on `pathname + sorted search params` —
**not** the request's `Host`. This is correct for the common case (one instance
serves one origin) and keeps the key stable behind a proxy that may rewrite
Host.

It matters only if you run **one denext instance serving multiple tenants on
different hostnames from a shared `PageCache`**: a cacheable route at the same
path (e.g. `/dashboard`) would collide across tenants, and one tenant could be
served another's cached HTML. If that is your topology, do one of:

- run a separate instance (and cache) per tenant — the recommended shape; or
- put the tenant in the path (`/t/:tenant/…`) so it is part of the key; or
- supply a `PageCache` whose keys you namespace by tenant.

Single-origin deployments (the default) are unaffected. Note this partitioning
concern is distinct from the soft-nav variant partitioning (`x-denext-nav`,
which the cache already keeps separate from the HTML variant).

## 12. ISR cache-key query params (high-cardinality caveat + allowlist)

By default **every** query parameter participates in the ISR page-cache key
(only their _order_ is normalized, so `?a=1&b=2` and `?b=2&a=1` share one
entry). That is correct, but a cacheable route hit with high-cardinality junk
params — `?utm_*`, `?fbclid`, a random cache-buster — will mint a distinct entry
per distinct value, inflating the cache and churning its LRU (the default store
is the durable `node:sqlite` file under `.denext/`, so `denext start` needs
`--allow-write=.denext`; the in-memory fallback applies when that write is not
permitted). Both stores are byte- and count-bounded, so this degrades hit-rate
rather than exhausting memory, but it still wastes work.

Two mitigations, use either or both:

- **Strip junk params at the edge** before they reach denext (a reverse proxy
  can drop `utm_*`/`fbclid`), and/or
- **Set `cacheKeyParams`** in `denext.config.ts` (an opt-in allowlist of param
  names) so only the params that actually change cacheable output fork the key.
  Every other param is dropped from the key but **still reaches the render** via
  `searchParams` — so list every param whose value changes what a cacheable page
  emits. Omit it to keep the default (all params participate).

```ts
// denext.config.ts
export default { cacheKeyParams: ["page", "sort"] } satisfies DenextConfig;
// ?page=2&utm_source=x and ?page=2&utm_source=y now share one cached entry.
```

## 13. Health & readiness

The production server answers a built-in liveness probe at **`/_denext/health`**
(GET/HEAD only — other methods get a `405`), meant for load balancers and k8s
probes. It always returns `200` — the site serves even when the cache backend is
down, since reads degrade to live renders — and the JSON body reports cache
reachability so operators aren't blind to an outage:

```json
{ "status": "ok", "cache": "ok", "cacheStore": "sqlite" }
```

`"cache": "degraded"` means the active cache store failed its probe.
`cacheStore` is what backs it: `"sqlite"` (the durable default), `"memory"`
(per-process — nothing survives a restart; in production this almost always
means `denext start` was launched without `--allow-write=.denext`, and the boot
log says so in one line), or `"custom"` (your own `cache.store`). If you want
the same signal on a route of your own (a readiness check with app-level logic),
`cacheStoreHealthy()` probes the active cache backend **without throwing** —
expose it on a `/healthz` route:

```ts
// app/healthz/route.ts
import { cacheStoreHealthy } from "denext/server";
export async function GET() {
  return Response.json({
    ok: true,
    cache: (await cacheStoreHealthy()) ? "ok" : "degraded",
  });
}
```

## 14. Observability

**`onRequest(info)`.** Export `onRequest` from your root `instrumentation.ts`
(beside `register` / `onRequestError`) for per-request logging/metrics — `info`
carries `method`, `path`, `status`, `durationMs`, and a `requestId` (which is
also echoed as the `x-request-id` response header on an error, for correlation —
§8). It is called once after every response under `denext start` and
`denext dev`; a throw from it is swallowed. It replaces the `DENEXT_LOG` default
logger when present. `requestTimeout` (ms) responds `503` when exceeded (§2).

**Env-var logging.** If you don't need a callback, `DENEXT_LOG=1` gives a
compact one-line-per-request logger and `DENEXT_LOG=json` a structured object
per request (with a `statusClass` field) — see §9 for the fields and their
log-forging guarantees.

**Client-side instrumentation.** A root `instrumentation-client.{ts,tsx,js}`
(Next's convention) is bundled into every browser entry and runs before the
app's client code starts — the place for a monitoring/analytics init.

**OpenTelemetry recipe.** Wire `onRequest` to a histogram and `onRequestError`
to your tracer/error sink, both from `instrumentation.ts`:

```ts
// instrumentation.ts
import type { RequestLogInfo } from "denext/server";
export function onRequestError(err, request, ctx) {
  tracer.recordException(err, {
    "http.route": ctx.routePath,
    "http.url": request.path,
  });
}
export function onRequest(i: RequestLogInfo) {
  httpDuration.record(i.durationMs, {
    "http.method": i.method,
    "http.status_code": i.status,
    "http.status_class": `${Math.floor(i.status / 100)}xx`,
  });
}
```

**Custom server.** Everything above is also a `createApp()` / `serve()` option
(`onRequest`, `requestTimeout`, `maxConcurrency`, `slotBackstop`,
`canonicalOrigin`, `trustForwardedHeaders`, `actionMaxBodyBytes`,
`cacheKeyParams`) for an app that embeds denext instead of running
`denext start`. A custom server reads neither `denext.config.ts`'s server keys
nor the `DENEXT_*` env vars for them — pass the values yourself.

## 15. Ops runbook

- **Health:** point the load balancer at `/_denext/health`, or expose
  `cacheStoreHealthy()` on your own `/healthz` route for readiness checks (§13).
- **Correlate an error:** a `500` returns an `x-request-id` header; grep the
  logs (`DENEXT_LOG=json`) for that `requestId` to find the full server-side
  error and digest (§8, §9).
- **Runaway request:** bounded by `requestTimeout` (default 30s → `503`); the
  render is signal-aware, so a client disconnect or timeout actually cancels the
  work (§2).
- **Graceful shutdown:** on `SIGINT`/`SIGTERM` the server stops accepting
  connections and drains in-flight requests before exiting — abort the `serve()`
  signal to trigger it (§10 for the drain deadline).
- **Cache backend down:** reads/writes are best-effort — requests serve uncached
  and errors are logged (rate-limited per operation), never surfaced as `500`s.

## 16. App-layer responsibilities

A few things the framework deliberately cannot decide for you:

- **`dangerouslySetInnerHTML` and `metadata.head` emit raw HTML** — never pass
  unsanitized user/CMS content to them.
- **Middleware matchers see the locale-stripped path.** Under `i18n`, a
  `matcher: "/admin/:path*"` fires for `/fr/admin/x` as well as `/admin/x` (the
  matcher is tested against the path with the locale prefix removed, as in
  Next.js), so a locale prefix can never route around a path-restricted
  middleware. `ctx.locale` / `req.nextUrl.locale` carry the peeled locale.
- **Bound request sizes and rate-limit at your edge/proxy** — denext caps action
  bodies and image sources, but a proxy-level limit and rate limiting are still
  the right place for broad DoS protection (§1).

**Run production with least privilege.** The `dev`/`build` tasks use `-A`
because they bundle; `denext start` serves prebuilt output and never needs
`--allow-run`. The `start` task `denext create` writes is the least-privilege
set, and it is what the Docker image runs:

```sh
deno run --allow-net --allow-read --allow-env --allow-write=.denext jsr:@denext/denext/cli start .
```

`--allow-write=.denext` is not optional if you want the cache to survive a
restart: the durable `node:sqlite` store (the default) lives at
`.denext/cache.db`, and without the grant denext falls back to the per-process
memory store — it logs one line at boot naming the path and the grant, and
`/_denext/health` reports `"cacheStore": "memory"` (§13). Point the grant at the
directory of `cache.path` instead if you moved the file. `dev`/`build`/`export`
re-exec a child bundler; that child inherits the parent's actual grants instead
of a blanket `-A`, so narrowing the parent narrows the child too.
