# Deploying denext in production

denext ships secure, production-minded defaults (graceful drain, request
cancellation/timeout, body/cache/prefetch caps, error redaction, correlation
ids, opinionated hardening headers, config validation). A few operational
responsibilities are **yours** to configure at the edge/platform — they are
deliberately not baked into the framework so denext stays a thin, fast core.
This document lists them. See [CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md)
for the threat-by-threat security posture and [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)
for behavioral divergences.

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

denext computes a Content-Security-Policy for **buffered** HTML page responses
(it can hash inline scripts because it has the whole document). **Streaming**
responses (`renderToReadableStream`) and **Flight/RSC** responses do not carry a
framework-generated CSP — the full document isn't known when the first bytes
flush. If you rely on CSP for those responses, **set it at the edge** (reverse
proxy / CDN) with a nonce- or hash-based policy you control, or use buffered
rendering for the routes that need a framework CSP.

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

## 7. Cookies set no implicit secure attributes

The `cookies()` / `ResponseCookies` compat API emits exactly the attributes you
pass (matching Next.js — it does not silently add `httpOnly`/`secure`/`sameSite`).
For any sensitive cookie, set them explicitly:

```ts
cookies().set("session", token, {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
});
```

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
