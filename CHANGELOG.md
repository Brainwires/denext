# Changelog

All notable changes to **denext** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.2] - 2026-08-09

### Added

- **`safeFetch` — an SSRF-safe `fetch` for untrusted URLs** (exported from
  `denext/server`). Use it instead of `fetch()` whenever the destination is
  influenced by an end user (link previews, "import from URL", avatar-by-URL,
  webhooks). It resolves the host, **refuses any request whose resolved address is
  loopback/private/link-local**, and connects to the pinned IP with the original
  Host/SNI (closing DNS rebinding). Supports method/headers/body, an optional host
  allowlist (`*.domain` wildcards), per-hop-revalidated redirects, byte/time limits,
  and an `AbortController` `signal`; failures throw a typed `SafeFetchError`. (Do not
  use it to reach your own internal services — that's what `fetch`/`cachedFetch`
  are for.)

### Security

- **Image optimizer: DNS-rebinding protection (closes the residual SSRF gap from
  0.8.1).** Remote sources are no longer fetched by hostname and left to `fetch()`'s
  own DNS resolution. denext now resolves the host itself, **rejects the fetch if any
  resolved A/AAAA record is loopback/private/link-local/CGNAT/multicast**, and
  connects to that pinned IP while preserving the original `Host` header and TLS SNI
  (so certificate validation still holds and there is no second, rebindable
  resolution). An allowlisted hostname whose DNS points at an internal address (e.g.
  cloud metadata) is now refused. Implemented as a small SSRF-safe HTTP/1.1 GET
  client (`src/server/safe-fetch.ts`) with time and size bounds; the resolver and
  socket are injectable, so the path is fully unit-tested without network access.

## [0.8.1] - 2026-08-09

Security hardening from two independent reviews of 0.8.0. No breaking changes.

### Security

- **XSS via lowercase `on*` handler attributes.** The SSR attribute serializer only
  stripped React-style camelCase handlers (`onClick`), so lowercase HTML-native
  names (`onmouseover`, `onerror`, …) spread from untrusted props (`<div
  {...untrusted}>`) were emitted as live event-handler attributes. The handler
  filter is now case-insensitive, and `isValidAttrName` rejects any `on*` name — a
  single chokepoint covering all three SSR renderers **and** the client reconciler's
  `setAttribute`.
- **Image-optimizer SSRF via redirects.** The optimizer validated only the initial
  URL, then followed redirects automatically — an allowlisted host could redirect to
  cloud metadata (`169.254.169.254`), loopback, or a private service. Redirects are
  now followed manually with the full policy re-checked on **every** hop: allowlist,
  http(s) only, a redirect cap, and rejection of loopback/private/link-local/CGNAT/
  multicast IP literals (v4 and v6, incl. IPv4-mapped). (DNS rebinding — an
  allowlisted host resolving to a private address — remains out of scope; keep the
  allowlist to trusted hosts.)

### Fixed

- **Image endpoint resource limits.** Remote fetches now have a timeout and a max
  download size (declared and streamed); decoded sources are rejected past a
  dimension/pixel cap before resizing (decompression-bomb guard).
- **Server Action request body limit.** Oversized bodies are rejected (413) before
  the handler runs — a declared-`Content-Length` fast path plus a hard cap on the
  buffered body (covers chunked requests). Configurable via `actionMaxBodyBytes`
  (default 10 MiB).
- **CSRF origin check is now scheme-aware.** An `http` Origin is rejected for a known-
  HTTPS app (determined via `canonicalOrigin`, a trusted `X-Forwarded-Proto`, or the
  request URL); full-origin `allowedOrigins` entries match scheme-strictly. Bare-host
  entries stay scheme-agnostic for compatibility, and proxied deployments where the
  scheme is unknown keep the prior host-only behavior (no regression).
- **Static serving blocks symlink escapes.** A symlink inside `public/` that resolves
  outside it (via `Deno.realPath`) is no longer served; symlinks that stay within
  `public/` still work.

## [0.8.0] - 2026-08-09

Developer-experience and scaling release: a project scaffolder, first-class
Tailwind, an optional `src/` layout, configurable remote-image optimization, the
deferred operational features from 0.7.1, a memoization foundation, and an
experimental React-Compiler-style auto-memo pass. No breaking changes.

### Added

- **`denext create` / `denext init` scaffolder.** `create <dir>` generates a clean
  starter into a new/empty directory; `init` scaffolds into the current (possibly
  non-empty) directory without ever overwriting existing files. Both prompt
  interactively (or take `--tailwind`, `--src-dir`, `--compiler`, `--yes`) and wire
  up `deno.json`, an `app/` with a hydrating example page, and `.gitignore`.
- **Tailwind CSS, driven by denext.** Set `tailwind: { input, output }` in
  `denext.config.ts` and denext downloads and manages the Tailwind v4 _standalone_
  binary (zero npm — a build-time tool like the lightningcss wasm) and compiles your
  stylesheet automatically on `dev`/`build`. Override the binary with `TAILWIND_BIN`
  or the version with `DENEXT_TAILWIND_VERSION`.
- **Optional `src/` directory layout** (Next.js parity). When `src/app` exists, the
  app, middleware, and instrumentation live under `src/`; `public/`, config, and
  `.denext` stay at the project root.
- **Configurable remote image optimization.** `images: { domains, remotePatterns }`
  in `denext.config.ts` allowlists remote sources for the `/_denext/image` endpoint
  (exact hosts, or protocol/host-wildcard/pathname patterns). Remote sources remain
  refused by default (local-only, SSRF-safe).
- **Operational hooks (deferred from 0.7.1).** `onRequest(info)` for per-request
  logging/metrics (plus a `DENEXT_LOG=1` default logger), a per-request
  `requestTimeout` (→ 503), and cache single-flight (stampede protection) for both
  the data cache and the ISR page cache — coordinating waiters only, never sharing a
  live per-user render.
- **Memoization foundation.** The client reconciler now bails out of re-rendering a
  component whose props are shallow-equal and whose visible context is unchanged
  (context changes still reach deep consumers correctly). New `memo(Component,
  areEqual?)` HOC and `useMemoCache` primitive, plus a `denext/compiler-runtime`
  entrypoint.
- **Experimental auto-memo compiler** (`experimental: { compiler: true }`, default
  off). A build-time pass that lifts JSX component elements into `useMemoCache`-guarded
  memo calls so unchanged subtrees keep a stable reference and skip re-render. It runs
  only on the client bundle (server output is unchanged), is conservative (bails to
  identity on anything it cannot analyze), and is proven equivalent + effective by
  tests. Enable with `denext create --compiler`.

### Changed

- The `denext/rules-of-hooks` lint rule now also flags a hook called after a
  conditional early return (it may be skipped on some renders).

## [0.7.1] - 2026-08-09

Production-readiness fixes from a three-lens (correctness / operations / security)
review of 0.7.0. Two of the defects were in 0.7.0's own new features.

### BREAKING

- **`request` removed from `PageProps`.** The raw `Request` is no longer passed to
  page components, `metadata`/`generateMetadata`, or `generateViewport`. Reading
  per-request data off it bypassed the cache-safety tripwire, so a personalized
  render could be cached under a shared key and served to other users. **Migration:**
  read per-request data through `cookies()` / `headers()` from `denext/server` (both
  mark the render dynamic, so it is correctly excluded from the cache). `params` and
  `searchParams` are unchanged (they are part of the cache key and safe to read).

### Security

- **Cross-user cache disclosure** via the `request` prop — closed by the breaking
  change above (affected the in-memory page cache too; the shared KV cache made it
  cross-replica).
- **Host-header `og:image` cache poisoning.** When `og:image` is auto-populated from
  a dynamic `opengraph-image` route and no `canonicalOrigin` is configured, the URL
  is derived from the request `Host`; the render is now marked dynamic so a poisoned
  value can't be cached and served to everyone. Set `canonicalOrigin` to re-enable
  caching for such pages.

### Fixed

- **Cache is now fail-safe.** A `CacheStore` error (KV outage, a page body over Deno
  KV's 64 KiB value cap, a non-cloneable value) no longer 500s the request: reads
  degrade to a live render and writes are skipped, both logged (throttled). Applies
  to `unstable_cache`/`cachedFetch` and the ISR page cache.
- **Dev hydration-mismatch false positives.** The 0.7.0 diagnostic warned on nearly
  every page (`Count: {n}`): SSR coalesces adjacent text into one node while the
  client splits it. The reconciler now splits and adopts the coalesced node cleanly —
  no warning — while still reporting genuine divergences. A boundary that re-suspends
  during hydration no longer warns either (its fallback mounts fresh).
- **`after()` no longer blocks the response.** Deferred callbacks (and deferred cache
  invalidations) drain after the response is produced, not before it.
- **Un-awaited `revalidateTag`/`revalidatePath` under an async store.** Inside a
  request, the invalidation is registered on the request's deferred queue so it drains
  before the isolate can be reclaimed; awaiting is documented as required for a
  fully-consistent result with an async store.
- **`deno bundle` probe no longer caches a transient failure**, which had permanently
  bricked a long-lived dev server after one spawn hiccup.
- **Bundler resolves root-relative (`/`) import-map paths** to absolute in the merged
  config (previously only `./`/`../`).
- **KV index markers stay bounded**: overwriting an entry drops the markers it no
  longer carries, so re-tagging a non-TTL entry can't leak index keys.
- **Prod server validates the build at startup** — a missing client entry now fails
  fast instead of a page that SSRs but silently never hydrates.
- **Dev file-watcher and live-reload streams close on shutdown**; concurrent
  first-hits for the same route are coalesced so duplicate `deno bundle` subprocesses
  aren't spawned.

### Added

- **`/_denext/health` reports cache reachability** (`{ status, cache }`) — still 200
  for liveness (the site serves even during a cache outage), with `cache: "degraded"`
  surfacing a backend problem to operators. New `cacheStoreHealthy()` export.

### Deferred to 0.8

Three net-new operational features from the review are intentionally not in this patch:
opt-in structured request logging/metrics, a per-request timeout/deadline, and
cache-miss single-flight (stampede protection).

## [0.7.0] - 2026-08-08

A production-maturity release that closes the architectural gaps left open after
0.6.1: shared multi-replica caching, a real-browser test suite, hydration
diagnostics, and hardening of the experimental `deno bundle` dependency.

### Added

- **Pluggable shared cache (`CacheStore`) + Deno KV adapter.** The data cache and
  ISR page cache now sit behind a `CacheStore` interface (mirroring
  `setDraftTokenStore`). `setCacheStore(store)` swaps the backend for all
  subsequent operations; the default stays in-memory. A built-in
  `denoKvCacheStore()` backs both caches with Deno KV, so a render or cached data
  entry produced on one replica is served by another and `revalidateTag` /
  `revalidatePath` reach every instance. New exports from `denext/server`:
  `setCacheStore`, `inMemoryCacheStore`, `denoKvCacheStore`, and the `CacheStore` /
  `DataEntry` types.
- **Real-browser E2E suite.** `deno task test:e2e` builds and serves
  `examples/hello` and drives it with a headless Chromium (via `@astral/astral`, a
  test-only dependency — never in the runtime graph, excluded from publish). It
  verifies the SSR→hydration round-trip the in-memory DOM tests cannot: the
  pre-hydration flag flips, the counter is interactive, a `dynamic({ ssr: false })`
  island is code-split and mounted client-side, `<Link>` navigation is a true SPA
  swap, and no console errors occur. Excluded from `deno task test`/`check`.
- **Dev-only hydration-mismatch warnings.** The client reconciler now warns (dev
  server only) when server and client markup disagree — a mismatched tag, a
  swapped node, or divergent text — instead of silently patching it. Gated on the
  live hydration cursor, so intentional divergences (`dynamic({ ssr: false })`,
  resolved Suspense, error fallbacks) never trigger false positives. Zero cost and
  fully silent in production.
- **`deno bundle` version guard + build smoke test.** `build`/`dev` now verify the
  resolved `deno` is new enough for the (experimental) `bundle` subcommand and fail
  with an actionable message (`DENO_BIN` hint) on a missing/old binary, instead of
  a cryptic bundle error. A full-build smoke test asserts the on-disk artifact
  shape (client entry + code-split chunks) as a tripwire against `deno bundle`
  output drift.

### Fixed

- **Page-cache tag invalidation.** ISR page-cache entries now inherit the tags of
  the cached data (`unstable_cache`/`cachedFetch`) read during their render, so
  `revalidateTag(tag)` purges the page and not just the underlying data. Page-cache
  writes previously stored no tags, making tag-based page invalidation a no-op.
- **Bundling from a project with relative import-map paths.** The bundler now
  resolves a base config's relative `imports` (e.g. `denext` → `../../mod.ts`) to
  absolute when writing its merged config to a temp dir, fixing `Module not found`
  failures when a route imported CSS (the merged-config path).

### Changed

- The ISR page cache is now async end to end (`PageCache.get`/`set` return
  promises) so it can be backed by a remote store; `revalidateTag`/`revalidatePath`
  now return a `Promise` you may await (the in-memory default still applies
  synchronously, so existing non-awaited calls keep working).

## [0.6.1] - 2026-08-08

A hardening release: a security fix plus the concrete production-readiness
blockers found in a post-0.6.0 review. No API changes.

### Security

- **Open redirect (protocol-relative `Location`).** `trailingSlash` normalization
  and path-preserving config `redirects()` (a `:path*` capture reflected into the
  destination) built a `Location` from request-path data without neutralizing
  protocol-relative (`//host`) or backslash (`/\host`) prefixes, which browsers
  resolve cross-origin. New `safeRedirectLocation()` preserves explicit
  `http(s)://` external redirects but forces everything else to a single-slash
  same-origin path; applied to all redirect sites. Regression tests added.

### Fixed

- **Graceful shutdown.** The CLI now traps `SIGINT`/`SIGTERM` (`SIGBREAK` on
  Windows) and aborts an `AbortController` wired into `Deno.serve`, so in-flight
  requests drain on deploy / pod termination instead of being dropped. The CSS
  re-exec forwards the signal to its child process.
- **Unbounded caches (memory-exhaustion).** The ISR `PageCache` and the
  `unstable_cache` / `cachedFetch` data store are now bounded LRUs, so
  high-cardinality keys (e.g. many distinct query strings) can no longer grow
  them without limit.
- **Image endpoint re-encoding.** `/_denext/image` now serves from a byte-bounded
  (64 MB) LRU of encoded webp output keyed on `src`+width, instead of
  decoding/resizing/re-encoding on every request.
- **Silent config failure.** A malformed `denext.config.ts` now fails fast with a
  clear error instead of silently dropping `basePath`/redirects/**security
  headers**.
- **Compiled-binary CSS.** A `deno compile`d binary now warns loudly that it
  cannot apply the CSS import map (`import "./x.css"` would fail), instead of
  failing silently at runtime.

### Added

- **`/_denext/health`** — a liveness/readiness probe endpoint for load balancers
  and Kubernetes.

### Notes

- Known limitations unchanged from 0.6.0 (see below), plus: ISR/data caches and
  `revalidatePath`/`revalidateTag` remain process-local — multi-replica
  deployments should front denext with a CDN and treat per-instance cache windows
  accordingly (a shared-store seam is planned).

## [0.6.0] - 2026-08-08

The "real CSS pipeline + Next.js parity" release: a genuine CSS Modules / global
CSS build (full `lightningcss` semantics) on a bundler-less Deno server, true
code-split `next/dynamic`, `next.config`-style redirects/rewrites/headers, a
complete Metadata + `generateViewport` API, and a batch of utility helpers.

### Added

- **Real CSS pipeline (CSS Modules + global CSS + Tailwind).** `import s from
  "./x.module.css"` yields scoped, hashed class names with `composes` and
  `:global` resolved; `import "./globals.css"` is extracted and linked. Powered by
  **`lightningcss` (wasm)** — the engine Parcel/Turbopack use. Because Deno cannot
  `import()` a `.css` module (and offers no runtime loader hook), the CLI generates
  a merged deno config that redirects each `.css` to a JS shim (the class map for
  modules, an empty module for globals) and **re-execs the module loader with
  `--config`**; the same import map feeds `deno bundle` for the browser. Extracted,
  transformed CSS is emitted per route and linked in `<head>`. Tailwind works
  through the global-import path (run the Tailwind CLI → import the output). Zero
  overhead for CSS-free projects.
- **`next/dynamic` — true code-splitting.** `dynamic(() => import("./Heavy"), {
  ssr, loading })` loads a component on demand as its **own bundle chunk** (via
  `deno bundle --code-splitting`, which hoists shared modules — context symbols,
  registries — into a common chunk so module identity is preserved). `ssr: false`
  renders the fallback on the server and mounts on the client; loading rides the
  existing Suspense machinery.
- **`denext.config` redirects / rewrites / headers + basePath / trailingSlash /
  assetPrefix.** Declarative `redirects()` (307/308 with `:param` substitution),
  `rewrites()` (internal re-route), and `headers()` (per-path response headers),
  evaluated once at startup; `trailingSlash` normalization (308); `basePath`
  (routing, asset serving, **and** client `<Link>`/`navigate()`/`usePathname()`);
  `assetPrefix` for CDN asset URLs.
- **Complete Metadata API + `generateViewport`.** `Metadata` now covers `twitter`
  cards, structured `alternates` (canonical + `hreflang`), `metadataBase` (resolves
  relative og/twitter images), structured `icons` (icon/shortcut/apple), `robots`
  as an object, `authors`, `verification`, and multi-image `openGraph.image` with
  width/height/alt. New `viewport` / `generateViewport` exports drive the viewport,
  `theme-color`, and `color-scheme` tags.
- **File-based metadata icons.** `app/icon.*`, `app/apple-icon.*`, and
  `app/twitter-image.*` (static images or dynamic `.tsx` modules) are auto-served
  at `/icon`, `/apple-icon`, `/twitter-image` and auto-injected as
  `<link rel="icon">` / `apple-touch-icon` / `twitter:image` — zero-config.
- **`next/og` `ImageResponse`** — render JSX to a PNG (satori flexbox layout →
  SVG → resvg raster, via `@cf-wasm/og`, which bundles a font and inlines its
  wasm). Returns a `Response` that flows through the `opengraph-image` convention.
- **Self-hosted image optimization** — a built-in `/_denext/image` endpoint
  (decode → resize → webp, via `@cf-wasm/photon`) for local `public/` assets;
  remote sources require an explicit host allowlist (SSRF-safe). `<Image>` gains a
  `loader` prop (`denextImageLoader` targets the endpoint), a generated responsive
  `srcSet` from a widths list, and `placeholder="blur"` + `blurDataURL`.
- **`next/font/google`** — `googleFont({ family, weights, styles })` fetches the
  Google Fonts CSS2 stylesheet and returns the same `FontResult`/`FontFace` shape
  as `localFont`.
- **`after()`** — schedule work to run after the response (drained on every exit
  path; throws are logged, not propagated).
- **`userAgent(request)`** — a stdlib UA parser (browser / OS / device / engine /
  bot detection).

### Deferred

- Image optimization covers local `public/` assets by default; remote sources need
  an explicit host allowlist.

### Notes

- New build/server-time dependencies (never enter the client bundle):
  `lightningcss-wasm` (CSS), `@cf-wasm/og` (ImageResponse), `@cf-wasm/photon`
  (image optimization).
- Dev limitation: adding a **new** `.css` file needs a dev restart (editing
  existing ones hot-reloads), because the server CSS import map is fixed at boot.

## [0.5.0] - 2026-08-08

The React Server Components release: a real `"use client"`/`"use server"`
boundary built bundler-lessly on Deno, plus the App Router features that were
previously shipped scoped-down. Server Actions folded into `"use server"` are
built with the same defensive posture as 0.4.0 (Next.js's worst CVEs were here).

### Added

- **Flight / RSC boundary (`"use client"` / `"use server"`)** — a true Server
  Components boundary with no third-party bundler. The server still SSRs client
  modules for first paint but emits them as **references** in a **Flight** payload
  (`#__denext_flight` island); only client modules ship to the browser. Directives
  are parsed by a real tokenizer (not a regex), the app-wide client/server split
  is discovered by crawling Deno's own module graph (`deno info`), and client
  islands are tagged as references via ESM singletons. `"use server"` exports
  auto-register and are stripped from the browser bundle by redirecting each
  server module to a generated client stub through a `deno bundle` import map —
  proven by byte-grep tests that server-component and server-action code are
  **provably absent** from the client bundle. `useId` is re-based per island so
  hydration ids stay aligned; streaming Flight interleaves boundary rows.
  Undirected modules stay **isomorphic** (opt-in, fully backward compatible).
  `serverAction("id", fn)` still works. The default remains the whole-tree
  isomorphic hydration for routes with no boundary.
- **Parallel routes done right** — `@slot` folders become full routable subtrees
  (their own segments, dynamic params, `layout`/`loading`/`error`), matched
  against the current URL with a new **`default.tsx`** convention, and
  **layout-scoped** so a slot spans every route under its layout (the canonical
  `@modal/(.)photo/[id]` intercept-in-slot modal works on soft nav).
- **Layout-relative `useSelectedLayoutSegment(s)`** — each layout now sees only
  the path segments **below its own level** (route groups add no depth), via a
  segment-depth provider wrapped around each layout on both server and client.
- **Dynamic OG images** — an `opengraph-image.{tsx,ts,jsx,js}` convention served
  at `/opengraph-image`. The default export may return an **SVG VNode**
  (serialized to `image/svg+xml`, no rasterizer dependency), a **`Uint8Array`**
  (served `image/png` — bring-your-own rasterizer), or a **`Response`** (verbatim).
  `og:image` auto-populates to its absolute URL when a page sets none.
- **`useTranslations()`** — a real message-catalog hook. `I18nConfig.messages`
  maps locale → catalog; the active catalog is provided to SSR and embedded in the
  hydration payload, so `t("greeting", { name })` interpolates `{var}` placeholders
  server-side and on the client (re-read on soft navigation). Correct under the
  Flight boundary too.
- **`instrumentation.ts`** — a project-root module exporting `register()` (run
  once at server boot, for tracing/metrics/error-reporting setup) and/or
  `onRequestError(error, request, context)` (called for each server-side request
  error, e.g. to forward to Sentry). Wired into the dev and production servers;
  both hooks are optional, may be async, and are invoked defensively so a failing
  hook never takes the server down. Errors are reported exactly once.
- **`.env` file support with client/server isolation** — `loadEnv` reads `.env`
  then `.env.local` (later wins; real shell vars win unless `override`) into
  `Deno.env`, wired into `dev`/`build`/`export`/`start`. Only variables prefixed
  **`NEXT_PUBLIC_`** (Next.js-compatible) or **`DENEXT_PUBLIC_`** are exposed to
  the browser — embedded in a `#__denext_public_env` island and read by the
  isomorphic `publicEnv()`; server-only variables never reach the client through
  this channel. Also `parseEnv`, `isPublicEnvKey`, `filterPublicEnv`.
- **Hardening & loose ends** — a **pluggable draft-token store**
  (`setDraftTokenStore` / `DraftTokenStore`) for multi-instance deployments
  (default in-memory; server-minted-token security preserved); **`<html lang>`**
  now reflects the active locale; and an **absolute-URL helper**
  (`requestOrigin` / `absoluteUrl`).

### Security

- **Directive scan can't be hidden by a banner** — `readDirective` now grows its
  read window until the module's directive prologue is conclusively resolved,
  instead of reading a fixed 1 KB head. A license banner longer than the window
  could previously hide a `"use server"` directive, failing open and leaking the
  server module into the client bundle.
- **`X-Forwarded-*` untrusted by default** — `requestOrigin`/`absoluteUrl` (used
  to auto-populate `og:image`) now ignore `X-Forwarded-Proto`/`-Host` unless a
  deployment opts in via `trustForwardedHeaders` (trusted reverse proxy) or pins
  the origin with `canonicalOrigin`, closing a header-spoofing vector.

## [0.4.0] - 2026-08-07

Server-first features: mutations, caching, and SEO — with Server Actions built
defensively (Next.js's worst CVEs were here).

### Added

- **Route segment config** — page/layout modules may `export const dynamic`,
  `revalidate`, `dynamicParams`, `runtime`, etc. The effective config is merged
  down the layout chain (shortest `revalidate` wins) and drives static/dynamic
  rendering; the static export skips `dynamic: "force-dynamic"` routes.
- **Data cache & Incremental Static Regeneration** — `cache()` (per-request
  memoization), `unstable_cache` + `cachedFetch` (cross-request TTL + tags),
  and `revalidatePath`/`revalidateTag`. The production server serves a rendered
  **page cache** for routes that opt in via `revalidate`/`force-static`; the
  default (`dynamic: "auto"`, `revalidate: false`) is **never cached**, so pages
  reading `cookies()`/`headers()` stay per-request.
- **Server Actions** — `serverAction(id, handler)` registers a server function
  dispatched over `POST /_denext/action/<id>`, usable as a `<form action>` (with
  no-JS **progressive enhancement**) or via `useActionState`. **Security:** every
  action request is enforced **same-origin** (Origin, then Referer, deny when
  absent) as a CSRF defense; POST-only; only registered ids resolve; handler
  errors are logged server-side but returned to the client as a generic message;
  redirects are forced to 303 and the no-JS redirect target is restricted to a
  same-origin path. Plus `serverOnly()`/`clientOnly()` boundary guards.
- **Metadata files** — `app/sitemap.ts` → `/sitemap.xml`, `app/robots.ts` →
  `/robots.txt`, `app/manifest.ts` → `/manifest.webmanifest`, and `app/favicon.ico`.
- **Document metadata hoisting** — render `<title>`/`<meta>`/`<link>` anywhere in
  the tree (React 19); they are hoisted into `<head>` during SSR (in-tree
  `<title>` wins over the `metadata` export).
- **Asset & navigation ergonomics** — `<Image>` (lazy/async/`priority`/`srcSet`),
  `<Script>` strategies, `localFont` + `<FontFace>` (`@font-face`), `useParams()`,
  `<Link prefetch>` (hover + viewport prefetch with a client HTML cache), and
  `draftMode()` (httpOnly preview cookie).

## [0.3.0] - 2026-08-07

Four "owns-both-halves" wins — things possible because denext owns the
reconciler, the router, the middleware runner, **and** the linter together.

### Added

- **Composable, ordered middleware** — `middleware.ts` / `proxy.ts` may now export
  an **ordered array** of handlers (or `{ handler, config }` entries) instead of a
  single function. They run in order: a `Response` short-circuits the chain, a
  `rewrite()` threads its URL into every later entry, and `next({ headers })`
  accumulates headers across the chain. Per-entry `config.matcher` gates individual
  entries. New `composeMiddleware()`; single-function exports keep working
  unchanged. 7 tests.
- **i18n routing (optional default-locale prefix)** — `/about` serves the default
  locale, `/fr/about` serves `fr`; the locale is peeled at request time (the router
  core is untouched) and merged into route `params`, so pages, layouts, templates,
  and client hydration all see `params.locale`. New `useLocale()` client hook,
  `peelLocale`, `detectLocale`/`parseAcceptLanguage`, and a ready-made
  `localeMiddleware` (cookie + `Accept-Language` negotiation) that composes into the
  chain above. Config comes from a `serve({ i18n })` option or a
  `denext.config.{ts,js}` export; static export emits one variant per locale. 10 tests.
- **Convention registry + parallel & intercepting routes** —
  - The scanner's hardcoded file-convention regexes are now a **table-driven
    registry** with a `registerConvention()` seam and a post-scan
    `registerRouteSynthesizer()` hook (extension points for derived routes). A
    golden-manifest test locks scanner output so the refactor is provably
    behavior-preserving.
  - **Parallel routes** — `@slot` folders are collected and rendered into the
    nearest layout as **named props** (server and client), without creating
    standalone routes.
  - **Intercepting routes** — `(.)`, `(..)`, `(..)(..)`, and `(...)` folders are
    parsed (fixing a bug where `(..)` was mis-stripped as a route group) and match
    **only on soft navigation** (via the existing `x-denext-nav` header); a hard load
    falls through to the real route. 8 tests.
- **Error-boundary superpowers** — beyond what React can do:
  - `useErrorBoundary()` returns `{ reset, captureError }` — `captureError(e)` routes
    an error (including async/`setTimeout` failures) to the nearest boundary's
    fallback; `reset()` retries its children.
  - Errors thrown in **event handlers and form actions** are caught and routed to the
    nearest boundary (React silently drops these). A rejected async handler/action is
    routed too.

  6 tests.

### Fixed

- **Client error boundaries no longer swallow control signals.** `redirect()`,
  `notFound()`, `forbidden()`, and `unauthorized()` thrown during client render now
  bubble past `<ErrorBoundary>` (matching the server renderer) instead of rendering
  the error fallback. A `redirect()` from an event handler performs a client
  navigation rather than showing a fallback.

## [0.2.0] - 2026-08-07

### Added

- **React 19 hook parity** — `useId` (deterministic across server render and
  client hydration), `useSyncExternalStore`, `useLayoutEffect`,
  `useDeferredValue`, `useTransition`/`startTransition`, and `useImperativeHandle`
  (with React 19 **ref-as-prop** — components receive `ref` in props, no
  `forwardRef`). Context objects are now usable **directly as a provider element**
  (`<MyContext value={v}>`, React 19 style) in addition to `<MyContext.Provider>`.
  (`useTransition`/`useDeferredValue` are simplified, non-interruptible
  approximations in this synchronous renderer.) 11 tests.
- **Router completeness** — new App Router special files and helpers:
  - `template.tsx` (wraps like a layout, conceptually re-mounted), `global-error.tsx`
    (replaces the whole tree on an uncaught render error → 500).
  - `forbidden()` / `unauthorized()` control signals (like `notFound()`) that render
    `forbidden.tsx` / `unauthorized.tsx` (nearest up the tree) with a real `403` / `401`;
    they bubble past error boundaries.
  - `useSelectedLayoutSegment()` / `useSelectedLayoutSegments()` (reactive; simplified,
    not layout-relative). The manifest scanner and client entry were extended to cover
    the new files. 7 tests.
- **Server ergonomics** — `redirect()`/`permanentRedirect()` control signals
  (throw from a server component → `307`/`308`), and a per-request async context
  (Deno `AsyncLocalStorage`) powering `cookies()` and `headers()` from
  `denext/server` (read request cookies/headers; `cookies().set()`/`delete()`
  queue `Set-Cookie` on the response). Added the client `useOptimistic` hook. 6 tests.
- **Form actions** — the React 19 `useActionState` and `useFormStatus` hooks, plus
  `<form action={fn}>` interception (submit calls the action with the form's
  `FormData`). Actions run on the client (typically calling a route handler);
  denext does **not** implement Next.js's bundler-transformed `"use server"` RPC.
  4 tests.
- **Static generation & SEO** — `denext export` pre-renders the whole app to a
  static, host-anywhere directory (`out/`): every page plus dynamic routes
  enumerated by `generateStaticParams`, with client bundles and `public/` assets
  copied in (still hydratable). Added `generateMetadata` (async) support and an
  expanded `Metadata` type (`keywords`, `robots`, `canonical`, `openGraph`,
  `icon`) rendered into `<head>`. 4 tests.

## [0.1.2] - 2026-08-07

### Fixed

- **JSR module-doc detection** — `jsx-runtime.ts`'s top JSDoc lacked an `@module` tag, so deno doc
  attached it to the first export instead of treating it as a module doc, failing JSR's "module docs
  in all entrypoints" check (`./jsx-runtime` and `./jsx-dev-runtime` both map to this file). Added the
  tag; all entrypoints now expose a recognized module doc.

## [0.1.1] - 2026-08-07

### Security

- **Fixed an XSS via unsafe attribute names in SSR and hydration.** An attribute name containing
  tag/attribute-delimiter characters — reachable when a component spreads untrusted keys, e.g.
  `<div {...untrusted}>` — could break out of the tag and inject markup. `serializeAttributes`
  (server) and the client reconciler now drop names failing `isValidAttrName` (rejects whitespace,
  quotes, `< > / =`, and control characters; `data-*`/`aria-*`/`xml:lang` stay valid). Attribute
  _values_ were already escaped; this closes the name vector. Added 5 security regression tests.

### Added

- **Full API documentation** — JSDoc on every exported symbol across all public entrypoints and
  module docs on each entrypoint (`deno doc --lint` is clean), taking JSR documentation coverage to
  100%.
- **CI & release automation** — a GitHub Actions `CI` workflow (fmt / lint / type-check / tests /
  `deno doc --lint`) and a `Publish to JSR` workflow that runs on `v*` tags with `id-token: write`,
  so releases carry **build provenance**.

## [0.1.0] - 2026-08-07

### Added

- **`denext` executable + packaging**:
  - `deno task compile` produces a standalone `denext` binary via `deno compile`. Fixed the compiled
    case where bundling shelled out to the wrong executable — `denoExecutable()` now resolves the
    real `deno` (via `DENO_BIN`, `~/.deno/bin/deno`, or `PATH`) instead of `Deno.execPath()` (which
    is `denext` in a compiled binary). `start` runs fully standalone; `dev`/`build` still need a
    `deno` for client bundling.
  - Exposed `./cli` and `./lint-plugin` exports, so `deno install`/`deno run jsr:@denext/denext/cli`
    and the lint plugin work from the published package.
  - Added a `publish.exclude` (tests, examples, build output, binary) — `deno publish --dry-run`
    passes with no slow-type errors, so the package is JSR-ready.
  - README: "The `denext` command" (install/compile/task) and "Using denext as a package" sections.
- **Port handling** (`src/server/serve-utils.ts`): when no `--port` is given, `dev`/`start` now
  auto-select an open port (trying 3000, 3001, … up to 10), logging each fallback, instead of
  crashing with `AddrInUse`. When `--port` **is** given, that exact port is required — an in-use
  port fails immediately with a clean, single-line error (exit 1). 4 tests.
- **Tooling config & clean baseline**: explicit, customizable `deno fmt` settings
  (`useTabs`/`lineWidth`/`indentWidth`/`semiColons`/`singleQuote`/`proseWrap`/`exclude`) and lint
  config in `deno.json`, plus `fmt`/`lint`/`check` tasks. The whole repo is now `deno fmt` clean and
  `deno lint` clean (including the denext hook rules).
- **Deno-native lint plugin** (`src/lint/denext-plugin.ts`): React/denext hook rules enforced by
  `deno lint` (no ESLint/npm) — `denext/rules-of-hooks` (no conditional hooks),
  `denext/hooks-in-component` (hooks only in components/`useX` hooks, not callbacks), and
  `denext/no-hooks-in-async` (hooks in async server components have no client effect). Wired into
  both `deno.json` files; 8 tests via `Deno.lint.runPlugin`.
- **Root not-found rendering**: unmatched page requests render the app's root `not-found.tsx`
  (within the root layout) with a `404` status, instead of a generic message. The manifest now
  tracks `rootNotFound`.
- **README + LICENSE**: full documentation (quick start, routing conventions, API surface,
  middleware, linting, architecture, limitations) and an MIT license. The example app
  (`examples/hello`) gained its own `deno.json` so it runs as a realistic standalone project.
- **Client-side navigation** (`src/client/navigation.ts`): SPA soft navigation without full reloads.
  - `<Link href>` renders a normal SSR anchor and navigates on the client; global click delegation
    also intercepts plain internal `<a>` links.
  - `navigate()` fetches the target page's server HTML, swaps the hydration root, updates
    `<title>` + history (push/replace/`popstate`), and re-runs the route bundle to hydrate; falls
    back to a full load on cross-origin or failure.
  - Router hooks: `useRouter()` (`push`/`replace`/`back`/`forward`/`refresh`), reactive
    `usePathname()` and `useSearchParams()`.
  - Route bundles now boot via `startClient()` (hydrate + install navigation).
- **App Router special files** (`loading.tsx`, `error.tsx`, `not-found.tsx`) and the primitives
  behind them (`src/runtime/error-boundary.ts`):
  - `<ErrorBoundary fallback>` renders a fallback (given `error` + `reset`) when a descendant throws
    during render — server (string + streaming) and client, with a working `reset()`.
  - `notFound()` throws a sentinel that bubbles past error boundaries to render the not-found UI
    with a real `404` status.
  - The manifest scanner captures the nearest `loading`/`error`/`not-found` per page (inherited down
    the tree); the render pipeline wraps each page in its error boundary and a `<Suspense>` whose
    fallback is `loading.tsx`; the client entry mirrors the same wrapping for hydration.
- **Root middleware** (`src/server/middleware.ts`): a `middleware.ts` (or `proxy.ts` alias) at the
  project root runs before routing. Handlers return a `Response` (short-circuit), `redirect()`,
  `rewrite()` (internal re-route), or `next()` (continue, optionally injecting response headers).
  Supports a `config.matcher` (`:name`, `:name*`, `*` patterns). Loaded by dev (hot-reloaded) and
  prod servers; exported from `denext/server`.
- **Suspense + streaming SSR** (`src/runtime/suspense.ts`, `src/jsx/render-to-stream.ts`): a
  `<Suspense fallback>` boundary, a `use()` primitive that unwraps promises by suspending, and
  `createResource()`.
  - `renderToReadableStream()` flushes the shell with each boundary's fallback, then streams each
    boundary's real content as it resolves plus an inline swap script — supporting multiple
    concurrent and nested boundaries.
  - `renderToString()` transparently resolves Suspense (no streaming).
  - Client reconciler supports Suspense: shows the fallback while a descendant suspends and swaps in
    real content when the promise settles.
- **Project scaffolding**: `deno.json` with a self-contained JSX toolchain
  (`jsxImportSource: "denext"`), standard-library-only import map, and dev/start/ build/test tasks.
  No runtime npm dependencies.
- **JSX runtime** (`src/jsx/`): a self-contained mini virtual DOM. `jsx`/`jsxs`/ `jsxDEV`/`Fragment`
  for the automatic runtime, plus a classic `h()` helper. No React dependency.
- **Server-side rendering** (`src/jsx/render-to-string.ts`): `renderToString` supporting function
  components (sync and async), fragments, context providers, correct HTML escaping, void elements,
  boolean attributes, style-object serialization, and `dangerouslySetInnerHTML`.
- **Hooks** (`src/runtime/hooks.ts`): swappable-dispatcher `useState`, `useReducer`, `useEffect`,
  `useMemo`, `useCallback`, `useRef`, `useContext`, shared between server and (upcoming) client
  runtimes.
- **Context** (`src/runtime/context.ts`): `createContext` with provider/consumer resolution during
  rendering.
- **File-based router** (`src/router/`): Next.js App Router-style conventions — `page`, `layout`,
  `route` files; static, dynamic (`[slug]`), catch-all (`[...rest]`), and optional catch-all
  (`[[...rest]]`) segments; route groups (`(group)`); specificity-ordered matching; filesystem
  manifest scanner.
- **HTTP server** (`src/server/`): request handler dispatching to API routes, server-rendered pages,
  static assets, or a 404. Includes:
  - Page render pipeline composing the layout chain around a page and merging layout + page
    `metadata` (title/description/meta/head).
  - Full HTML document assembly with `<head>` metadata and a hydration bootstrap (serialized route
    data + client module script).
  - API dispatch by HTTP method (`GET`/`POST`/… exports) with automatic `HEAD` from `GET` and
    `405` + `Allow` for unsupported methods.
  - Static file serving from `public/` with path-traversal protection and content-type detection.
  - `serve()` helper over `Deno.serve`, and an injectable module loader.
- **Client runtime** (`src/client/`): a small virtual-DOM reconciler with real hooks and in-place
  DOM patching. Includes:
  - `createRoot` (fresh mount) and `hydrateRoot` (adopts server markup in place, binding events
    without recreating nodes; self-heals on mismatch).
  - Full hooks on the client (`useState`/`useReducer`/`useEffect` with dependency tracking +
    cleanup, `useMemo`/`useRef`/`useContext`).
  - Keyed children reconciliation that preserves element identity across reorders; microtask-batched
    updates with a `flushSync` escape hatch.
  - Context provider/consumer resolution through the live instance tree.
  - `bootstrap.ts` browser entry that rebuilds the server's tree from the embedded hydration payload
    and hydrates `#__denext`.
  - Injectable `document` (`setDocument`) so the reconciler stays DOM-agnostic and testable without
    a third-party DOM.
- **Toolchain & CLI** (`src/build/`, `cli.ts`): dev/build/start commands driven by Deno's own
  toolchain — **no third-party bundler**.
  - Browser bundling via `deno bundle`: one entry per route (page + layouts + client runtime as a
    single module graph, preserving context identity).
  - `denext dev`: SSR + on-demand per-route bundling + live reload over SSE, with a filesystem
    watcher and generation-based module/bundle cache busting.
  - `denext build`: pre-bundles + minifies each route to `.denext/client/` and writes a build
    manifest.
  - `denext start`: serves SSR pages plus the pre-built, immutably-cached client bundles.
- **Example app** (`examples/hello/`): App Router demo — root layout, an interactive home page
  (`useState`/`useEffect` hydration), a static about page, a dynamic async blog route
  (`/blog/[slug]`), an API route, and CSS. Verified end-to-end: SSR, hydration payload, API
  GET/POST, static serving, dynamic params, and the production build/start path.
- **Tests**: coverage for the JSX runtime, SSR renderer, route-segment matching, the manifest
  scanner, the request handler, static serving, the client reconciler (hydration, keyed reordering,
  effects, context), and the build layer (route ids, generated entries), Suspense/streaming, error
  boundaries and `notFound()`, middleware, client navigation, and the lint plugin — 75 passing.
  Ships a tiny in-memory DOM shim so reconciler tests need no third-party DOM.

[0.6.1]: https://jsr.io/@denext/denext@0.6.1
[0.6.0]: https://jsr.io/@denext/denext@0.6.0
[0.5.0]: https://jsr.io/@denext/denext@0.5.0
[0.4.0]: https://jsr.io/@denext/denext@0.4.0
[0.3.0]: https://jsr.io/@denext/denext@0.3.0
[0.2.0]: https://jsr.io/@denext/denext@0.2.0
[0.1.2]: https://jsr.io/@denext/denext@0.1.2
[0.1.1]: https://jsr.io/@denext/denext@0.1.1
[0.1.0]: https://jsr.io/@denext/denext@0.1.0
