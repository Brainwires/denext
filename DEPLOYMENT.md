# Deploying denext in production

denext ships secure, production-minded defaults (graceful drain, request
cancellation/timeout, body/cache/prefetch caps, error redaction, correlation
ids, opinionated hardening headers, config validation). A few operational
responsibilities are **yours** to configure at the edge/platform — they are
deliberately not baked into the framework so denext stays a thin, fast core.
This document lists them. See [CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md)
for the threat-by-threat security posture and [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)
for behavioral divergences.

## 0. Deploy recipes

`denext build` writes a `.denext/` output; `denext start` serves it. Build in the
image/CI, then run `start`.

### Docker

```dockerfile
FROM denoland/deno:2.9.5
WORKDIR /app

# Cache dependencies first (better layer caching).
COPY deno.json deno.lock* ./
RUN deno install --entrypoint jsr:@denext/denext/cli 2>/dev/null || true

COPY . .
RUN deno task build

ENV PORT=3000
EXPOSE 3000
# Least-privilege: grant only what the server needs (widen if you use FS/FFI).
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", \
     "jsr:@denext/denext/cli", "start", "."]
```

`docker build -t my-app . && docker run -p 3000:3000 -e SESSION_SECRET=… my-app`.
Put a concurrency ceiling / TLS in front (§1) — a reverse proxy or your platform.

### Deno Deploy

Push the repo and point the entrypoint at `jsr:@denext/denext/cli` with args
`start .`, or add a build step running `deno task build`. Deno Deploy provides TLS
and autoscaling; still set a per-instance `maxConcurrency` (§1) and your secrets
(`SESSION_SECRET`, etc.) as environment variables.

### Self-host (systemd)

```ini
# /etc/systemd/system/my-app.service
[Service]
WorkingDirectory=/srv/my-app
Environment=PORT=3000
Environment=SESSION_SECRET=…
ExecStart=/usr/local/bin/deno run --allow-net --allow-read --allow-env jsr:@denext/denext/cli start .
Restart=always
[Install]
WantedBy=multi-user.target
```

Run `deno task build` in your deploy step, then `systemctl restart my-app`. Front it
with nginx/Caddy for TLS + the concurrency limit (§1).

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
replacement — for the edge ceiling, `serve()`/`createApp()` accept a
`maxConcurrency` option: the max number of client requests one instance handles
at once. A request that arrives at capacity is **shed immediately** with a `503`
and `Retry-After: 1`. It is fast-fail, never queued, so shedding stays O(1) and
can't itself amplify the overload. A slot is held from arrival until the response
is **produced** and released on every exit path (success, error, abort, timeout);
for a streaming body the slot frees when the `Response` is returned, not when the
body finishes. This is deliberate: it bounds handler/render concurrency up to
Response production, but does **not** count a stream's client-read duration.
Holding a slot until a stream drains would let a slow-reading client pin slots
(slowloris) and would let long-lived SSE exhaust the ceiling — so the client-read
duration of streaming bodies (SSE, chunked handler responses, large static files)
must be bounded at the **edge / load balancer** (slow-client read timeouts, max
concurrent connections), not by this in-process counter. Background ISR
regeneration is exempt. Default: no limit. Set it slightly above your steady-state
target so a single instance self-protects if the edge limit is misconfigured — the
edge ceiling above is still required.

```ts
serve({ getManifest, maxConcurrency: 100 });
```

**`slotBackstop` (with `requestTimeout: 0`).** If you disable the request timeout
(`requestTimeout: 0`) _and_ set `maxConcurrency`, a render that never settles would
otherwise hold its slot forever and could eventually wedge the whole ceiling to
503s. A backstop timer (default 120s, tune via `slotBackstop`) force-frees the slot
in that case — it frees only the counter, it does **not** abort the render (you
opted out of timing requests out). With the default `requestTimeout` in place, the
timeout already settles the request, so the backstop is inert.

## 2. `requestTimeout` bounds _awaiting_, not _CPU_

`requestTimeout` (default 30s) aborts a request whose work is cooperative —
i.e. it awaits I/O and threads the per-request `AbortSignal` into its
`fetch()`es. It **cannot** preempt a synchronous CPU loop (a tight `while`, a
pathological regex, an unbounded synchronous render): JavaScript is
single-threaded, so a synchronous hot loop blocks the event loop until it
returns. Keep render/handler code free of unbounded synchronous work, and rely
on the edge concurrency ceiling (§1) to contain the blast radius.

## 3. Outbound `fetch()` is not SSRF-pinned by default

denext's image optimizer pins DNS and refuses private/loopback/link-local
targets via `safeFetch`. **Your own** server-side `fetch()` calls (in server
components, route handlers, Server Actions) are ordinary `fetch` — they are
**not** DNS-pinned. If you fetch a **user-controlled URL** on the server, wrap
it in the exported `safeFetch` so a hostile host/redirect can't reach your
metadata endpoint or internal network:

```ts
import { safeFetch } from "@denext/denext/server";

// Refuses if any resolved A/AAAA is loopback/private/link-local/CGNAT/etc.
const res = await safeFetch(userProvidedUrl);
```

For fixed, trusted URLs plain `fetch` is fine.

## 4. Redirect helpers

- `redirect()` (control-flow) and the **middleware `redirect()` helper**
  normalize their target through `safeRedirectLocation`, collapsing
  protocol-relative escapes (`//host`, `/\host`, …) to a same-origin path.
- `safeRedirectLocation` **passes an explicit absolute URL through verbatim**
  (that is intended — you asked to leave the origin). Do not pass a
  user-controlled absolute URL to a redirect without validating it against your
  own allowlist first.
- `NextResponse.redirect(url)` keeps Next.js's stricter contract: `url` must be
  absolute and a relative string throws.

## 5. CSP is applied to buffered page responses, not streaming/Flight

denext computes a strict Content-Security-Policy for **buffered** HTML page
responses. **Streaming** responses (`renderToReadableStream`), **Flight/RSC**
responses, and **streamed Cache Components / PPR** responses (a cached shell with
per-request dynamic holes) do not carry a framework-generated CSP — the full
document isn't known when the first bytes flush. If you rely on CSP for those
responses, **set it at the edge** (reverse proxy / CDN) with a nonce- or hash-based
policy you control, or use buffered rendering for the routes that need a framework
CSP. (A streamed PPR response is already `private, no-store`, so an intermediary
never shares it.)

The framework CSP keeps `script-src 'self'` and never hashes arbitrary inline
`<script>` output (so injected script can't self-authorize a hash) — denext emits
no executable inline script of its own on the buffered path; its data islands are
`type="application/json"` and its runtime is a same-origin `<script src>`. It DOES
hash each inline `<style>` block into `style-src`. External scripts/styles are
blocked until a route opts hosts in.

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

Neither API-route nor static-HTML responses carry a framework CSP either — the
same "set it at the edge" guidance applies.

**Incremental streaming (`experimental.streaming`).** Off by default, non-PPR
routes buffer so they can carry the hash-CSP. Enable `experimental: { streaming:
true }` to stream a route's shell + Suspense boundaries incrementally — but it
applies **only to routes where no CSP is emitted** (`csp: "off"` globally or on the
route), since a streamed body can't carry the hash-CSP. A route that keeps a CSP
still buffers (with a one-time log warning). A streamed route is rendered per
request (not ISR-cached).

## 6. Tell denext about your proxy (origin + forwarded headers)

Behind a TLS-terminating reverse proxy, denext needs to know its real public
origin for correct absolute URLs, Server-Action **CSRF origin checks**, and
HSTS. Configure one of:

- **`canonicalOrigin: "https://example.com"`** — pins the public origin
  outright (wins over any header; the most robust option), or
- **`trustForwardedHeaders: true`** — trust `x-forwarded-proto` / `x-forwarded-host`
  from the proxy. Only enable this when clients **cannot** reach denext directly
  and spoof those headers.

With neither set, denext derives the origin from the `Host` header / request URL
and treats `x-forwarded-proto` as untrusted (so a spoofed `x-forwarded-proto:
https` will **not** induce HSTS, and the action-CSRF check uses the connection's
own scheme).

## 7. Cookies are secure by default

`cookies().set()` defaults to **`httpOnly` + `SameSite=Lax` + `Secure`** (Secure is
added over HTTPS — directly or behind a proxy that sets `x-forwarded-proto: https`).
This is stricter than Next.js (which adds nothing) — a deliberate secure default. To
set a cookie the browser's JS must read, opt out explicitly:

```ts
cookies().set("theme", "dark", { httpOnly: false }); // client-readable
```

For sessions, prefer the built-in signed-cookie helper instead of hand-rolling:

```ts
import { getSession } from "denext/server";
const session = await getSession<{ userId: string }>({
  secret: Deno.env.get("SESSION_SECRET")!, // long + random (≥32 chars; a short one warns)
  hostPrefix: true, // recommended: origin-lock the cookie (__Host- → Secure, Path=/, no Domain)
});
await session.set({ userId: user.id }); // signed (HMAC), httpOnly, Secure, SameSite=Lax
```

`hostPrefix: true` renames the cookie to `__Host-denext_session` and pins the
browser-enforced origin-lock invariants, so a sibling subdomain can't set or read
it. Enable it from the start on new apps (turning it on later logs existing users
out once, since the cookie is renamed).

## 8. Correlation ids

Every response carries a request id (surfaced in the request log and echoed as
`x-request-id` on error responses). denext reuses an inbound `x-request-id` from
your proxy when present (sanitized to safe token characters and length-bounded),
otherwise it mints a UUID. Propagate a trace id from your edge as `x-request-id`
to correlate proxy and app logs.

## 9. Request logging

Set `DENEXT_LOG=json` for structured (one-JSON-object-per-line) request logs
suited to log pipelines; any other truthy value (e.g. `DENEXT_LOG=1`) emits a
compact human-readable line. Logged fields (method, path, status, duration, request id)
are safe against log forging (the request id is sanitized; JSON output escapes
control characters).

## 10. Graceful shutdown

On `SIGTERM`/`SIGINT` the server stops accepting new connections and drains
in-flight requests, then runs plugin teardowns. Draining is bounded by a deadline
(default **10s**): set `DENEXT_SHUTDOWN_DRAIN_MS` to tune it, or `0` to drain
indefinitely. If the deadline elapses with requests still in flight the process
force-exits (and plugin teardown is skipped). Size it above your longest expected
request and below your orchestrator's kill grace (e.g. k8s
`terminationGracePeriodSeconds`, typically 30s).

## 11. The ISR page-cache key omits the Host (multi-tenant caveat)

The built-in ISR page cache keys entries on `pathname + sorted search params` —
**not** the request's `Host`. This is correct for the common case (one instance
serves one origin) and keeps the key stable behind a proxy that may rewrite Host.

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

By default **every** query parameter participates in the ISR page-cache key (only
their _order_ is normalized, so `?a=1&b=2` and `?b=2&a=1` share one entry). That is
correct, but a cacheable route hit with high-cardinality junk params — `?utm_*`,
`?fbclid`, a random cache-buster — will mint a distinct entry per distinct value,
inflating the cache and (for the in-memory store) churning its LRU. The store is
byte- and count-bounded, so this degrades hit-rate rather than exhausting memory,
but it still wastes work.

Two mitigations, use either or both:

- **Strip junk params at the edge** before they reach denext (a reverse proxy can
  drop `utm_*`/`fbclid`), and/or
- **Set `cacheKeyParams`** (an opt-in allowlist of param names) so only the params
  that actually change cacheable output fork the key. Every other param is dropped
  from the key but **still reaches the render** via `searchParams` — so list every
  param whose value changes what a cacheable page emits. Omit it to keep the
  default (all params participate).

```ts
createApp({ /* … */ cacheKeyParams: ["page", "sort"] });
// ?page=2&utm_source=x and ?page=2&utm_source=y now share one cached entry.
```
