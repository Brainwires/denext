# denext features

This file has **two parts**:

- **Part 1 — What denext ships**, the master list of supported features by
  category. Experimental (flag-gated) features are marked **⚑**.
- **Part 2 — Where denext beats React/Next**, the ledger of genuine enhancements
  over the React + Next.js baseline, each with its mechanism (`file:line`) and an
  honest **[default] / [opt-in] / [capability]** label.

Part 1 answers "can I do X?"; Part 2 answers "why is this better, and where's the
code?" For behavioral divergences from Next.js see
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); for the threat-by-threat security
posture see [CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md).

---

# Part 1 — What denext ships (by category)

## Rendering & routing (App Router)

- File-convention **App Router**: `app/page.tsx`, `layout.tsx`, `template.tsx`,
  `loading.tsx`, `error.tsx`, `global-error.tsx`, `not-found.tsx`, `default.tsx`.
- Dynamic (`[slug]`), catch-all (`[...all]`), optional catch-all (`[[...opt]]`),
  **route groups** (`(group)`), **parallel routes / slots** (`@slot` + `default`),
  and **intercepting routes** (`(.)`/`(..)`/`(...)`, soft-nav-aware).
- **Server Components** (default), async Server Components (`await` data in a page),
  and **`"use client"`** islands.
- **Streaming SSR** with `<Suspense>` (out-of-order boundary resolution) and the
  **RSC/Flight** boundary (server components stay server-side; only islands hydrate).
- **Metadata**: static `metadata`, `generateMetadata`, `generateViewport`,
  `generateStaticParams`; file-based `opengraph-image`/`twitter-image`/`icon`/
  `apple-icon`, `sitemap`, `robots`.
- `redirect()` / `notFound()` / `forbidden()` / `unauthorized()`.
- **SPA mode** (`mode: "spa"`) — an alternative to the App Router for a
  **client-only** app ("React but not Next"): no `app/` directory and no SSR/Flight.
  denext bundles a single `spa.entry` (`src/build/spa.ts`), wraps it in an HTML shell,
  and serves that shell for every navigation (history-API fallback); `build`/`export`
  emit a static `out/` that `deno desktop` packages unchanged. Bring your own router
  and data layer (denext only bundles + mounts). CSS pipeline, Tailwind, and dev live
  reload apply. **npm-React apps run on denext's single React**: when the project has
  npm React installed (or `nextCompat: true`), SPA mode bundles through the
  [next-compat](#nextjs-drop-in-next-compat) esbuild rewrite so an npm library's own
  `import "react"` also resolves to denext (the "two Reacts" fix); `spa.env` provides
  compile-time `import.meta.env` (the Vite `define` analogue). A denext-native SPA
  keeps the fast plain-`deno bundle` path. Mutually exclusive with the App Router per
  project. See `examples/spa`.

## React runtime (own React 19-compatible implementation)

- Hooks: `useState`, `useReducer`, `useRef`, `useContext`, `useMemo`, `useCallback`,
  `useEffect`, `useLayoutEffect`, `useInsertionEffect`, `useId`, `useTransition`,
  `useDeferredValue`, `useSyncExternalStore`, `useImperativeHandle`, `useDebugValue`,
  `useEffectEvent`, `use()`, `useOptimistic`, `useActionState`, `useFormStatus`.
- `Suspense`, `SuspenseList`, `ErrorBoundary`, `startTransition`, `memo`,
  `createContext`, `forwardRef`, `createPortal`, `lazy`, `Profiler`, `StrictMode`.
- **Auto-memo compiler** (React-Compiler-style automatic memoization) ⚑.
- Class components (`Component`/`PureComponent`) in the next-compat build.

## Data, caching & ISR

- `fetch()` caching (Next 15/16 semantics: uncached by default; opt in via
  `next: { revalidate, tags }` / `force-cache`), request-scoped fetch dedupe.
- `unstable_cache`, `revalidatePath`, `revalidateTag`, `updateTag`.
- **Cache Components** (`"use cache"`, `cacheLife`, `cacheTag`) ⚑ and **Partial
  Prerendering (PPR)** — a cached static shell + per-request dynamic holes ⚑.
- **ISR** (`revalidate` / `force-static`) with stale-while-revalidate.
- Pluggable **cache stores**: in-memory (LRU-bounded), **SQLite** (`@denext/sqlite`),
  **Deno KV** — shared across instances (`setCacheStore`, `cacheStoreHealthy`).

## Server features

- **Route handlers** (`app/api/*/route.ts`, `GET`/`POST`/… returning `Response`).
- **Server Actions** (`"use server"`, progressive-enhancement forms, CSRF-defended).
- **Authentication** — first-party **`denextAuth`** plugin: OAuth 2.0 / OIDC
  (Authorization Code + PKCE) with **Google** / **GitHub** / generic-**OIDC**
  presets plus an email-password **Credentials** provider. Added as
  `plugins: [denextAuth({ … })]`, it auto-mounts `/auth/*`
  (signin/callback/session/providers/signout) — no route files to write. Read the
  session with `auth()`, gate routes with `requireAuth()` middleware, and use
  `useSession`/`signIn`/`signOut` on the client. `id_token`s are JWKS/RS256-verified;
  provider calls go through the SSRF-safe `safeFetch`; the `redirect_uri` is pinned
  to a required `canonicalOrigin`. Zero npm.
- **`cookies()` / `headers()`** with **secure cookie defaults** (httpOnly, SameSite=Lax,
  Secure over HTTPS).
- **Signed-cookie sessions**: `getSession()` (HMAC-SHA256, secret rotation) — the
  low-level session primitive `denextAuth` is built on, usable directly.
- **Middleware** (`middleware.ts`), **`draftMode()`**, `after()`-style deferred work.
- **Instrumentation** (`instrumentation.ts`): `register()` + `onRequestError()` with
  Next-shaped context (`routerKind`, `routePath`, `routeType`, `renderSource`,
  `revalidateReason`).
- **`safeFetch`** (SSRF-guarded fetch for untrusted URLs).
- **Databases**: any DB that runs on Deno works — built-in **`node:sqlite`** and
  **Deno KV** are zero-npm; Postgres/MySQL/Drizzle via standard drivers. See
  [DATABASE.md](./DATABASE.md), [`examples/notes`](./examples/notes) (SQLite, single
  process), and [`examples/postgres-load`](./examples/postgres-load) (a networked
  Postgres pool driven under concurrent load).

## Real-time & resumability

Two capabilities the React/Next architecture can't produce without a major rework
(the enhancement rationale + mechanism is in **Part 2 §4**):

- **Live Server Components** — `<Live tags={[...]}>` (from `@denext/denext/live`):
  the server re-renders **just that boundary**, under the viewer's own session, and
  **pushes** it over a WebSocket when any of its cache tags is invalidated
  (`revalidateTag`/`updateTag`) from anywhere — a Server Action, a webhook, a cron.
  The client reconciles in place; all other component state is preserved. Requires a
  Flight (RSC) route; the socket opens only once a `<Live>` boundary mounts.
- **Real-time data family** (same `@denext/denext/live` socket): `useLive(action,
  args, { tags })` subscribes to a server function's result and re-runs it under the
  viewer's session on tag invalidation; `usePresence(room)` gives who's-online /
  cursors (`{ self, others, peers, setState }`); `useLiveOptimistic` pairs an
  optimistic overlay with the live value. A Convex/Liveblocks-class layer, zero npm.
- **Resumability** ⚑ — `export const resumable = true` makes a route interactive with
  **no up-front hydration**; plain `useState` + `onClick` components work unchanged.
  Fine-grained primitives: island-level `client:load|idle|visible|interaction`
  directives, `qrl()` code-split/serializable event handlers, and
  `useSignal`/`useStore` reactive serializable state (adopted on resume, not
  recomputed). The runtime is a separate `@denext/denext/lazy` chunk; requires a
  Flight (RSC) route.

## Client runtime

- Hydration, **soft (SPA) client navigation** with reconcile-in-place, `Link`,
  scroll/focus handling.
- **Fast Refresh** (dev) with state preservation for route-structural components.
- **`dynamic()`** with `ssr: false` code-split islands.
- React DevTools: **Components tree** (props/nesting) ⚑ (hooks/state inspection is a
  documented gap).

## Styling

- **CSS**, **CSS Modules** (scoped class hashing), global CSS, and **Tailwind** (v4,
  compiled automatically) — extracted per route and `<link>`ed for a styled first paint.

## Images, fonts & OG

- **`next/image`** with a built-in, **SSRF-hardened** image optimizer
  (resize + WebP/AVIF, decompression-bomb guards, allowlists).
- Codecs as first-party zero-npm JSR packages: **`@denext/photon`** (resize/WebP),
  **`@denext/avif`** (AVIF).
- **`next/font`** (local + Google; Google self-hosting opt-in).
- **`next/og`** dynamic OG images via **`@denext/og`** (satori + resvg + yoga).

## Internationalization

- Optional-prefix **locale routing**, **`next-intl`** compatibility (provider,
  navigation, middleware, routing), ICU message subset, `useTranslations`.

## Security

Hardened by default — secure cookie defaults, **hash-based CSP** on buffered
responses, opinionated hardening headers (nosniff, frame-options, HSTS over HTTPS),
error redaction, correlation ids (`x-request-id`), config validation, SSRF-pinned
image fetch, and a continuously-run **CVE-defense** probe suite. The full mechanism
ledger is **Part 2 §1**; the threat-by-threat posture is
[CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md).

## Pages Router (opt-in plugin: `@denext/pages-router`)

Full Next.js Pages Router parity as a plugin (`plugins: [pagesRouter()]`):

- `pages/` file routing (`index`, `[slug]`, `[...all]`, `[[...opt]]`), `_app`,
  `_document`, and custom `_error`/`404`/`500`.
- `getServerSideProps`, `getStaticProps` with **build-time SSG** + `revalidate` **ISR**,
  and `getStaticPaths`.
- `next/head`, CSS / CSS Modules / Tailwind, `pages/api/*` (`(req, res)`).
- `useRouter`, `Link`, **client hydration + code-split soft navigation**, dev Fast Refresh.

The parity gaps (`router.events`, shallow routing, `<Link>` prefetch, i18n locale
routing) are tracked in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

## Next.js drop-in (next-compat)

- **`denext migrate`** migrates a Next App Router app in one pass: converts
  `package.json` → `deno.json` (react/react-dom/`next/*` aliased), **then** rewrites
  the app's own `next/*` + `react` imports to **native denext** (default
  `<Link>`/`<Image>` → named, `next/navigation` → `denext`, `next/headers`/
  `next/cache` → `denext/server`, …) after a confirmation prompt (`--yes` to skip;
  `--drop-in` to stop at the config and rely on the alias). A **`pages/` app is
  migrated too**: migrate wires the `@denext/pages-router` plugin and the codemod
  rewrites `next/router`/`next/head`/`next/link` to the plugin's compat modules.
  `denext codemod` runs just the import rewrite (auto-detecting `pages/`).
- Build-time **react → denext rewrite** (incl. inside npm packages) so the whole app
  runs on **one** React; the RSC/Flight island boundary is preserved.
- **`deno check` is clean** for typical apps (`skipLibCheck` + a `JSX.ElementType`
  admitting `ReactNode`-returning components) — Radix/lucide/recharts/cva type-check.
- The full `next/*` surface is aliased (link, image, navigation, headers, cache,
  server, font, script, dynamic, form, og, …).

Details and caveats: [README-NEXT-MIGRATION.md](./README-NEXT-MIGRATION.md) (the
canonical migration doc).

## Ecosystem packages (first-party JSR)

`@denext/photon`, `@denext/sqlite`, `@denext/avif`, `@denext/og`, `@denext/pages-router`
— published independently, zero-npm.

## Testing

- **App-testing helper** (`denext/testing`): `createTestApp(dir)` builds an
  in-process request handler (no build, no socket) that renders Server Components,
  runs Server Actions and `middleware.ts`, and reads cookies; `createTestClient`
  wraps any handler with a **cookie jar**, redirect control, and form
  parse-and-submit — so you can drive the whole app the way a **JavaScript-disabled**
  browser would and assert progressive enhancement in CI.
- **Component-testing helper** (`denext/testing`): `render(vnode)` mounts a single
  component into an in-memory DOM with **real hooks, effects, and events** (no
  browser), returning Testing-Library-style queries (`getByRole`/`getByText`/
  `getByLabelText`/`getByTestId`, `query*`/`getAll*`) and `fireEvent`.
- **Rendered-app conformance probe** (`denext/testing` → `probeApp`, or
  **`denext probe`**): renders **every route** of an app in process (expanding
  dynamic routes via `generateStaticParams`) and asserts each is a well-formed HTML
  document — `<!DOCTYPE>`, one `<html>`/`<head>`/`<body>`, a non-empty `<title>`,
  no server crash — classifying each route static (0 KB JS) or interactive. A CI
  gate that turns "every route renders" from a claim into a checked assertion.

## Build, tooling & CLI

- Build via **`deno bundle`** (no npm toolchain) with **code splitting** (shared
  runtime chunk), the CSS pipeline, and per-route client entries.
- **Plugin contract** (`DenextPlugin`: route-synthesizer / request-handler /
  build-step / teardown seams) with public `@denext/denext/bundle` and
  `@denext/denext/build/css` primitives. See [PLUGINS.md](./PLUGINS.md) for the
  authoring guide; consumed by `@denext/pages-router` and
  [`examples/plugin-aliases`](./examples/plugin-aliases).
- **Lint plugin** (denext-specific rules), `deno fmt`/`deno lint` integration.
- CLI: `create`, `init`, `dev`, `build`, `start`, `export` (static), `probe`
  (route conformance), `migrate`, `version` — plus **desktop/mobile** targets
  (`deno desktop` / Capacitor scaffolding).

## Deployment

- Production server with **graceful drain**, per-request **timeout**, an optional
  in-process **`maxConcurrency`** ceiling, body/cache/prefetch caps.
- **Static export** (`denext export`) for fully-static hosting.
- Deploy recipes (Docker / Deno Deploy / self-host) in
  [DEPLOYMENT.md](./DEPLOYMENT.md).

## Zero-npm runtime

The framework's **runtime carries no npm dependencies** — CI-enforced across
`src/{jsx,runtime,client,server,compat,plugin}` (`tests/no-npm-compat-guard.test.ts`).
Build-time tooling (esbuild/swc/lightningcss) never reaches the shipped runtime.

---

# Part 2 — Where denext beats React/Next

Things denext does **better** than the React + Next.js baseline it replaces —
cleaner, smaller, or more secure. This is the ledger of every genuine enhancement
(not parity feature), with the mechanism (`file:line`) and an honest **default vs.
opt-in** label. Parity features (useState, Suspense, App Router layouts, `<Image>`,
Server Actions, …) live in Part 1, not here. Gaps and divergences are tracked in
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

Legend: **[default]** on out of the box · **[opt-in]** requires a flag/config/build
path · **[capability]** implemented and exported but not on the default hot path.

## 1. Security

denext's threat model is encoded as executable exploit probes
(`tests/nextjs-cve-parity.test.ts`, `tests/security.test.ts`, `tests/safe-fetch.test.ts`,
`tests/hardening.test.ts`, `tests/production-hardening.test.ts`). Several defenses below fix
Next.js CVE classes independently — some before Next patched them. The
threat-by-threat map is [CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md).

### 1.1 Server Actions — CSRF / same-origin **[default]**

- **Same-origin verification, deny-by-default.** Every Server Action POST is checked against
  `Origin` (fallback `Referer`); when neither is present the request is **rejected**. A
  state-changing RPC defaults to _deny_. — `src/server/action-handler.ts:126-161`
  (`verifyOrigin`), called first at `:63`. Class of CVE-2024-34351.
- **Scheme-aware downgrade rejection.** An `http://host` Origin is refused for a known-HTTPS
  site (via `canonicalOrigin`, trusted `X-Forwarded-Proto`, or request URL); a forged
  `X-Forwarded-Proto` can only _tighten_, never loosen. — `action-handler.ts:156-179`.
- **POST-only dispatch.** `isActionRequest` requires `POST`, so no `<img>`/GET-triggered
  action. — `action-handler.ts:53-55`.
- **Bounded dispatch by registered id.** Action ids resolve through a `Map`; unknown ids 404.
  The id is never a path or eval target. — `action-handler.ts:75-78`,
  `src/runtime/server-action.ts:26`.
- **No error/stack leakage.** Handler errors are logged server-side, returned generic. —
  `action-handler.ts:106-108`.
- **Forced 303 + same-origin back-redirect** for no-JS form posts. — `action-handler.ts:98-104,
  226-238`.
- **Action `redirect()` returned to the client, never server-fetched** — no SSRF to forge. —
  `action-handler.ts:101-105`. CVE-2026-64649.

### 1.2 DoS payload bounding (Server Actions) **[default]**

- **Two-stage body cap** — declared `Content-Length` fast-path (413) plus a streaming
  `readCappedBody` that hard-caps even a chunked body with no length. Default **1 MiB** (matches
  Next's `serverActions.bodySizeLimit`). — `action-handler.ts:23, 68-72, 85-86, 189-214`. Class
  of CVE-2025-55184 / CVE-2025-67779.
- **Inert JSON decode** — the only decode of client input is `JSON.parse` with no reviver; a
  payload shaped like a `react.server.reference` is inert data, never resolved/invoked. —
  `server-action.ts:219-242`. CVE-2025-55182 / CVE-2025-66478 (RSC RCE, CVSS 10.0).
- **Prototype-pollution resistance** — a `__proto__` key does not pollute `Object.prototype`
  (native `JSON.parse` + denext never deep-merges the payload). — verified
  `tests/nextjs-cve-parity.test.ts:533-540`.
- **Deep-nesting DoS bounded** — a ~200k-deep payload throws in `JSON.parse`, is caught, returns
  fast. — `server-action.ts:222`.

### 1.3 SSRF-safe image optimizer & `safeFetch` **[default]**

- **DNS-rebinding pinning (headline defense).** denext resolves the host itself, refuses if
  _any_ resolved A/AAAA record is internal, then connects to that _pinned_ IP with the original
  Host header + TLS SNI — no second, rebindable resolution at connect time. Closes the residual
  SSRF gap that a hostname allowlist alone leaves open. — `src/server/safe-fetch.ts:308-375`
  (`makePinnedFetch`, refusal `:331-334`), transport `:85-105`.
- **Comprehensive internal-range guard** — loopback, `0.0.0.0`, RFC1918, `169.254/16`
  (cloud metadata), `100.64/10` CGNAT, multicast/reserved/broadcast, IPv6 `::1`/`fc00::/7`/
  `fe80::/10`, `::ffff:` IPv4-mapped, `localhost`/`*.localhost`. — `safe-fetch.ts:19-52`.
- **Per-hop redirect re-validation** — each redirect hop is re-checked for scheme, allowlist,
  and internal-address before connecting. — `safe-fetch.ts:464-499`,
  `src/server/image-optimizer.ts:126-164`.
- **`safeFetch` — SSRF-safe fetch for untrusted URLs** (link previews, import-by-URL, webhooks):
  scheme check, host allowlist (`*.domain`, subdomain-not-apex), pinned resolution,
  per-hop-revalidated redirects, byte cap (10 MiB), timeout (10s) + caller `AbortSignal`, correct
  method downgrade. No Next equivalent. — `safe-fetch.ts:434-501`.
- **Remote images refused by default** — remote sources require an `images.domains` /
  `remotePatterns` allowlist. — `image-optimizer.ts:75-88, 134`; `src/server/config.ts:85-89`.
- **Resource-exhaustion / decompression-bomb bounds** — 25 MiB download cap (declared +
  streamed), 3 redirects, 10s timeout; source pixels (40M) and dimensions (12k) checked _before_
  the resize. — `image-optimizer.ts:43-52, 166-198, 236-240`.
- **HTTP response-parser hardening (request-smuggling resistant)** — controlled framing headers,
  `Accept-Encoding: identity`, integer-only `Content-Length`, prefers chunked, rejects bare-LF /
  non-hex / oversized chunk sizes. — `safe-fetch.ts:147-209, 214-253`.
- **Image endpoint can never emit active SVG / arbitrary download** — every source re-decoded and
  re-encoded to a raster format (`image/webp`, or `image/avif` when enabled, negotiated from
  `Accept`) with no `Content-Disposition`. — `image-optimizer.ts:207-253`. CVE-2025-55173.

### 1.4 SSR / hydration escaping strictness **[default]**

- **Attribute-name validation, stricter than React** — a shared `isValidAttrName` rejects names
  with whitespace/quotes/`<>/=`/control chars **and any `on*` name case-insensitively**, blocking
  the lowercase-handler XSS sink (`<div {...untrusted}>` with `onerror`) at _both_ SSR and
  client-DOM-mutation sites. — `src/jsx/render-to-string.ts:74-89`, applied `:379, :394`.
- **Attribute-value + text escaping** — everything through `escapeHtml`. —
  `render-to-string.ts:57-69, 242-243, 410`.
- **`</script>` / JSON-island breakout escaping** — every embedded JSON `<script>` island
  (public-env, hydration data, Flight) replaces every `<` with a `<` unicode escape,
  defeating `</script>` breakout from params/searchParams. — `src/server/document.ts:77,
  81`, `src/jsx/render-to-html-flight.ts:390-391`.

### 1.5 Origin / scheme / forwarded-header handling **[default]**

- **Forwarded headers untrusted by default** — `X-Forwarded-Proto`/`-Host` ignored unless the
  deployment opts into `trustForwardedHeaders` (or sets `canonicalOrigin`). —
  `src/server/absolute-url.ts:4-56`.
- **Open-redirect neutralization** — `safeRedirectLocation` collapses protocol-relative `//host`
  and backslash `/\host` to a single-slash path for all config-driven redirects. —
  `config.ts:200-204`. _Caveat:_ the manual middleware `redirect()` helper emits `location`
  verbatim by design (caller responsibility) — `src/server/middleware.ts:131-145`.

### 1.6 Middleware / routing SSRF & bypass defenses **[default]**

- **No `x-middleware-subrequest` escape hatch** — denext runs its middleware unconditionally; no
  internal header skips it. — `middleware.ts:314-361`. CVE-2025-29927 (auth bypass).
- **`next()`/`rewrite()` never dereferences a `Location`** — outcomes only attach headers; only
  the client follows a redirect. Intent markers stripped before reaching the client. —
  `middleware.ts:165-200, 255-299`. CVE-2025-57822 (middleware SSRF).
- **Rewrites route by pathname against the local manifest — never proxy a host.** —
  `middleware.ts:350-358`. CVE-2026-64645.
- **Middleware runs on locale-prefixed paths** — a guard gates `/admin` and `/fr/admin` alike. —
  CVE-2026-64642. _Caveat:_ a matcher written `/admin` (not `/:locale?/admin`) still lets
  `/fr/admin` through — an authoring hazard, same as Next.

### 1.7 Static file serving **[default]**

- **Path-traversal + symlink-escape protection** — decode + reject malformed percent-encoding,
  lexical containment in `publicDir`, _plus_ a `Deno.realPath` re-check so a symlink inside
  `public/` pointing outside is refused. — `src/server/static.ts:14-56`. Class of CVE-2024-51479.

### 1.8 Cache-poisoning defenses **[default]**

- **Only status-200, non-dynamic renders are cached** — 404/redirect/empty never stored;
  reading `cookies()`/`headers()` marks the render uncacheable. —
  `src/server/request-context.ts:26-27, 96-98, 229`. CVE-2025-49826.
- **Soft-nav data variant partitioned from the HTML cache.** — CVE-2024-46982 / CVE-2025-32421.
- **`cachedFetch` keys on the request body** — two POSTs with different bodies never share an
  entry. — CVE-2026-64648 / CVE-2026-64647.

### 1.9 draftMode token signing **[default]**

- **Server-minted random draft token** — draft mode is on only with a 24-byte
  `crypto.getRandomValues` token this server issued and tracks in a pluggable store; a
  forged/guessed cookie is not in the store. `httpOnly`, `sameSite=Lax`. Stronger than a
  static/config-derived bypass value. — `request-context.ts:133-223`. _Caveat:_ default store is
  in-memory per-process (inject a shared store for multi-instance); tokens are tracked, not
  cryptographically signed.

### 1.10 Public env-var isolation **[default]**

- **Single-gate public-prefix filter** — the browser only receives `NEXT_PUBLIC_` /
  `DENEXT_PUBLIC_` vars; `filterPublicEnv` is the _only_ producer of embedded values, and the
  client reads only that island. — `src/runtime/public-env.ts:15-70`. _Caveat:_ passing a secret
  as a prop to a client component remains the developer's responsibility (same boundary as Next).

### 1.11 Least-privilege runtime **[platform capability]**

- denext runs on Deno's capability model; a compromised dependency can't read arbitrary files or
  spawn processes the way a Node/Next process can. — `mod.ts:34`. _Honest note:_ denext's own
  `deno.json` tasks and `compile` use `-A` for dev convenience; scoped permissions are a platform
  capability you apply in production, **not** an enforced denext default.

### 1.12 `fetch()` is uncached by default **[default]**

- **No accidental caching of authenticated / per-user responses.** denext's automatic `fetch()`
  caching passes a bare `fetch()` through **uncached** — caching is explicit, opt-in per call via
  `next: { revalidate, tags }` or `cache: "force-cache"`. This **matches Next.js 15+**, which
  flipped `fetch` (and GET Route Handlers) to uncached-by-default after the implicit fetch cache
  repeatedly surprised developers by caching data that should not be shared (it was stricter only
  versus Next ≤ 14). An uncached fetch does **not** silently force the route dynamic. Only GET is
  cacheable; `cache: "no-store"` is always uncached. — `src/server/cache.ts` (`installFetchCache`).
  _(This is the canonical statement of the uncached-fetch behavior; other docs link here.)_

### 1.13 Default Content-Security-Policy **[default]**

- **A strict CSP out of the box — Next.js ships none.** Every document response carries
  `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self';
  img-src 'self' data:`. External scripts/styles are blocked by default; a route opts hosts in via
  `export const csp = { scriptSrc: [...], styleSrc: [...] }`. — `src/server/csp.ts`, `src/server/app.ts`.
- **Hash-based, so it survives the ISR cache.** Each inline `<script>`/`<style>` denext emits is
  allowed by a content `'sha256-…'`, not a per-request nonce (which would be identical — and thus
  useless — across every viewer of a byte-identical cached page). The policy is computed once and
  stored with the cached page. (CSP on streaming/Flight is set at the edge — see
  [DEPLOYMENT.md](./DEPLOYMENT.md) §5.)

### 1.14 Default hardening response headers **[default]**

- **`nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, and HSTS-over-HTTPS** on every
  response (added only where the app hasn't set its own). Next.js ships none of these by default. —
  `src/server/app.ts` (`applyDefaultSecurityHeaders`).

### 1.15 Dangerous URL scheme filtering **[default]**

- **`javascript:`/`vbscript:` (and executable `data:`) URLs are dropped**, not merely warned, at a
  shared attribute chokepoint across all SSR renderers and the client reconciler — defeating
  whitespace/control-char obfuscation. React 16.9+ only warns. — `src/jsx/render-to-string.ts`
  (`sanitizeUrlAttr`).

### 1.16 Safe-by-default redirects & slow-body timeout **[default]**

- **Every framework redirect** (middleware, server-component, server-action) normalizes its
  `Location` through `safeRedirectLocation`, so a protocol-relative escape can't become an open
  redirect. — `src/server/middleware.ts`, `src/server/app.ts`, `src/server/action-handler.ts`.
- **Server-Action body reader has an idle timeout** (→ 408): a trickled/never-closed body can't pin
  a handler under the size cap. — `src/server/action-handler.ts` (`readCappedBody`).

## 2. Performance / Size

Bundle numbers are gzipped, measured on `examples/hello` (`README.md` "Tiny by default").

### 2.1 Client payload / bundle

- **Zero-JavaScript static routes** **[default]** — a page with no state/effect/ref/context
  hook, no DOM event handler, and no `ssr:false` island ships **no client bundle and no hydration
  script**. Next always ships a runtime + hydration for App Router pages. Classifier scans the
  route's whole transitive local import graph; any interactivity signal, unreadable module, or
  failed crawl → hydrate (conservative). — `src/build/hydration.ts:25, 60, 79, 87`, wired
  `src/build/build.ts:88, 92, 148`.
- **Tiny self-contained React-equivalent** **[default]** — denext's own JSX runtime, hooks,
  context, and reconciler; no npm React. **~16 KB first load** vs ~60 KB React+ReactDOM / ~126 KB
  Next.js 16; **~15 KB** shared runtime baseline. — `src/runtime/*`, `src/jsx/*`,
  `src/client/fiber/*` (numbers: `README.md` "Tiny by default").
- **Single shared runtime chunk cached across navigations** **[default]** — one code-split pass
  hoists the runtime into a common chunk downloaded once; a later navigation transfers only the
  route delta (**~0.6–0.9 KB**). Route entries dropped from ~19 KB to ~1 KB each. —
  `src/build/bundle.ts:490, 396, 402-410`, `src/build/build.ts:101`; regression
  `tests/integration/build-smoke.test.ts:77, 80`.
- **Single-React bundling for npm libraries** **[opt-in — next-compat build]** — every
  react-family import (incl. inside npm packages) rewritten to denext's single React, so no
  duplicate React and no "no dispatcher installed". — `src/build/next-compat.ts:29, 36, 89-104,
  140`.

### 2.2 Render / re-render cost

- **Fiber bailout + childLanes** **[default]** — a component with shallow-equal props and
  unchanged visible context is not re-rendered; a clean subtree with no work in the render lanes
  is skipped entirely. Every function component gets memo-style bailout, not just `memo()`-wrapped
  ones. — `src/client/fiber/reconciler.ts:481-494, 463, 699-705, 810-820`;
  `src/runtime/memo.ts:24, 50, 72`; `src/client/fiber/fiber.ts:53-57, 85`.
- **Time-sliced, interruptible transitions** **[default for transition APIs]** —
  `useTransition`/`useDeferredValue`/`startTransition` render on a concurrent path with a 5 ms
  frame budget, yield via `MessageChannel`, and are preempted by urgent updates (abandon +
  restart); tree built off-DOM, committed atomically. Default sync lane still runs to completion.
  — `reconciler.ts:865, 903, 973-998, 918-929, 1023, 838, 812`; `src/runtime/hooks.ts:290, 299`.
  (The migration guide's §10 is the canonical description of the concurrency model.)
- **Auto-memo compiler / `useMemoCache`** **[opt-in — experimental]** — a React-Compiler-style
  pass lifts JSX elements into `memoValue(...)` for stable identity → more bailouts. Client-only
  and provably SSR-safe (server `useMemoCache` returns a fresh sentinel array, so transformed code
  is byte-equivalent server-side). Correctness over coverage: unanalyzable modules emitted
  unchanged. — `src/build/compiler.ts:1-18, 182, 318`;
  `src/runtime/compiler-runtime.ts:19, 37, 47`.

### 2.3 Server render / caching

- **Streaming SSR (Suspense)** **[capability]** — `renderToReadableStream` flushes the shell +
  per-boundary fallbacks first, then streams resolved content. _Honest status:_ the default page
  path uses blocking `renderToString`; streaming is exported and tested but **not** the default
  response. — `src/jsx/render-to-stream.ts:233, 247-261`; default path
  `src/server/render-page.ts:165`.
- **Per-request `React.cache`-equivalent memoization** **[default when used]** — `cache(fn)`
  de-dupes calls within one request; uncached outside a request. Plus single-flight coalescing for
  `unstable_cache` cold-cache stampedes. — `src/server/cache.ts:29, 253-256`.
- **Deno KV shared ISR / data cache** **[opt-in — default is in-memory]** — a pluggable
  `CacheStore` with a Deno KV adapter sharing renders/data across replicas; tag/path index keys
  make invalidation a `list`, native TTLs handle expiry; store errors degrade to a live render. —
  `src/server/cache.ts:70, 99-139, 152, 365, 411`; `src/server/kv-cache.ts:32, 52-53, 56, 62-66`.

### 2.4 Dependency footprint

- **Zero runtime npm dependencies** **[default — CI-enforced]** — the served runtime rides only
  Deno built-ins, `@std/*`, `Intl.*`, and `node:sqlite`. A guard fails on any `npm:` specifier in
  compat modules. `deno.json`'s remaining `npm:` deps (lightningcss, swc, esbuild) are
  build/dev-time only and never enter a shipped bundle; the image/og/sqlite codecs are now
  first-party JSR packages (`@denext/photon`/`@denext/avif`/`@denext/og`/`@denext/sqlite`), not
  npm peers. — `tests/no-npm-compat-guard.test.ts:9`; `src/build/next-compat.ts:17-20`.

## 3. Features / DX

Genuine value-adds React/Next lack, or do less cleanly — not parity.

### 3.1 Single-React npm compat (headline value-add)

- **Real npm React libraries run unmodified** — Radix, recharts, react-hook-form, dnd-kit,
  sonner, lucide on denext's runtime. A Deno import-map alias can't reach `import "react"` _inside_
  `node_modules`; denext rewrites transitively through esbuild and funnels all runtime modules
  through one namespace so denext instantiates exactly once. — `src/build/next-compat.ts:35, 138,
  28, 90, 159-175`; page pipeline `src/build/next-compat-build.ts:1`.
- **Curated `node:` built-in stubs for browser bundles** — safe-to-empty built-ins (`fs`, `path`,
  `os`, …) stubbed for the browser target (webpack `resolve.fallback` parallel); genuinely
  polyfillable ones (`buffer`, `crypto`, `stream`, …) deliberately _not_ stubbed, so real needs
  fail loudly. — `next-compat.ts:191, 238, 269`.

### 3.2 Zero-cost class-component build gate

- **`classComponents` DCE gate** — the entire class runtime is behind a bare-identifier flag
  esbuild folds to a literal, so a function-only app pays **zero bytes**; a class used with the
  flag off gets a _guided_ error, not the opaque native one. — `src/runtime/class-flag.ts:1, 24`;
  `src/compat/react.ts:228, 239-245`; detector `src/compat/class-detect.ts:30, 42`; gated runtime
  `src/compat/class-component.ts:1`; define `src/build/next-compat.ts:74`.

### 3.3 denext-only hooks & isomorphic utilities

- **`useErrorBoundary`** — imperative `captureError`/`reset` on the nearest boundary (async
  errors, timers). React makes you install `react-error-boundary`; denext ships it in-core,
  SSR-inert. — `src/runtime/hooks.ts:411, 359, 382`.
- **`isServer` / `serverOnly` / `clientOnly`** — replaces the `server-only` + `client-only` npm
  packages Next docs tell you to install; first-class in-core with a runtime `isServer()`. —
  `src/runtime/environment.ts:10, 22, 37`.
- **`publicEnv` / `isPublicEnvKey`** — isomorphic public-env reader with one provable leak-gate;
  accepts both `NEXT_PUBLIC_` (drop-in) and `DENEXT_PUBLIC_`. Runtime-enumerable, unlike Next's
  compile-time string replacement. — `src/runtime/public-env.ts:15, 33, 64`.
- **`useMemoCache`** — the React-Compiler cache primitive exposed as a _public_ hook (React's is
  an unstable internal), with `compiler-runtime` as a public entrypoint. —
  `src/runtime/hooks.ts:247, 74`; `src/runtime/compiler-runtime.ts:19, 37`.
- **`useEffectEvent` shipped stable** — still experimental in React proper. — `mod.ts` hook block,
  `src/runtime/hooks.ts`.
- **Browser-platform hooks React/Next don't ship** — `useWakeLock` (Screen Wake Lock, refcounted
  singleton), `usePictureInPicture` (`<video>` PiP), and `withWebLock` (cross-tab single-flight
  over the Web Locks API). SSR-inert / no-op where unsupported. — exported from `denext`.

### 3.4 Auto-memo compiler (Deno-native)

- **Build-time auto-memoization** (`experimental: { compiler: true }`) comparable in spirit to the
  React Compiler, running in-process via `@swc/wasm-web` with no transpile hook of its own; feeds
  the client bundle through the existing import-map seam; provably SSR-safe. — `src/build/
  compiler.ts:1-18`; runtime `src/runtime/compiler-runtime.ts:37`.

### 3.5 Deno-native lint plugin (no ESLint / no npm)

- **`denext` lint plugin — 4 rules under `deno lint`**: `rules-of-hooks`, `hooks-in-component`,
  `no-hooks-in-async` (hooks in async server components that never hydrate), `directive-placement`
  (a `"use client"`/`"use server"` that isn't the leading statement, or a module declaring both).
  React's equivalents need the ESLint + `eslint-plugin-react-hooks` npm toolchain. —
  `src/lint/denext-plugin.ts:120, 176, 223`.

### 3.6 Scaffolder & CLI ergonomics

- **`denext create` / `init`** — single Deno command with a native in-repo multi-select TUI (no
  `create-next-app`/npx, no `inquirer`); can scaffold targets Next's starter can't — native
  desktop (`deno desktop`), Capacitor iOS/Android, the full React/Next compat alias set. —
  `cli.ts:223, 240, 250`; `src/build/scaffold.ts:57-69, 86-112`.
- **Auto-CSS re-exec seam** — makes `import "./x.css"` work on a runtime with no CSS loader hook
  by generating a merged config and re-execing `--config` (guarded against infinite re-exec). —
  `cli.ts:62`.
- **Port auto-selection** — picks an open port from 3000 when `--port` is omitted; exact port
  required when given. — `cli.ts:141-142`.

### 3.7 Deno-native platform integrations (no native npm addons)

- **Deno KV shared ISR cache** — a distributed, Deploy-ready shared cache from a built-in; Next's
  on-disk ISR cache is per-instance unless you bolt on a custom handler + external store. —
  `src/server/kv-cache.ts:31`.
- **`better-sqlite3` → `node:sqlite` shim** — drop-in `better-sqlite3` surface (enough for
  Drizzle's driver) with **zero native dependency**, reproducing real-lib quirks (`fileMustExist`
  throwing, correct nested-savepoint rollback). — `src/compat/better-sqlite3.ts:18, 165, 236`.

### 3.8 Compat conveniences that are genuinely nicer

- **`@radix-ui/react-slot` reimplementation** (`Slot`/`Slottable`) with Radix's exact `mergeProps`
  semantics — lets `asChild` resolve to denext without Radix's slot package. —
  `src/compat/slot.ts:41, 88, 107`.
- **`next-intl` compat on `Intl.*` only** — ICU MessageFormat (plurals with `offset:`/`#`,
  selectordinal, select, nested submessages) built on standard `Intl.*` with **zero npm deps**
  (no `intl-messageformat`); documents its gaps honestly. — `src/compat/next-intl/icu.ts:1`,
  `src/compat/next-intl/index.ts:1`.
- **Self-hosted Google fonts (build-time, pure core)** — `selfHostGoogleFont` downloads
  `@font-face` CSS + woff2 and rewrites `src: url()` to local paths (no runtime Google request);
  the rewrite core is a pure, testable function with content-hashed filenames. —
  `src/compat/next/font/google.ts:142`, `:~165`, `:91`; `src/runtime/font-google.ts:64`.

## 4. Real-time & resumability (capabilities React/Next lack)

Two flagship capabilities the React/Next architecture can't produce without a
major rework — denext can because it owns the cache, the Flight boundary, and the
reconciler. Both are opt-in and tree-shake out of apps that don't use them.

### 4.1 Live Server Components & real-time data **[opt-in]**

- **Server-pushed boundary re-render.** `<Live tags={[...]}>` wraps a server-rendered subtree;
  when any tag is invalidated (`revalidateTag`/`updateTag`) from anywhere — a Server Action, a
  webhook, a cron — the server re-renders **just that boundary, under the viewer's own session**
  (a synthetic Flight request through the app handler) and pushes the subtree over a
  `/_denext/live` WebSocket; the client reconciles in place, preserving all other component state.
  **Next has no first-party way to push** an RSC re-render to idle clients — it re-renders only
  when the client asks. Degrades safely: an unlocatable boundary falls back to a route refresh,
  and with no client runtime `<Live>` just renders its children (SSR-safe). — hub
  `src/server/live.ts`; `<Live>` island `src/runtime/live-boundary.ts`; client
  `src/client/live-client.ts`; protocol/registry `src/runtime/live-protocol.ts`,
  `src/runtime/live-registry.ts`; cache seam `setLiveInvalidateHook` — `src/server/cache.ts:303`;
  entrypoint `src/live.ts` (the dedicated `denext/live` subpath, kept off the shared chunk).
- **Real-time data family on the same socket** — `useLive` (subscribe to a server function's
  result, re-run under the viewer's session on tag invalidation), `usePresence`
  (who's-online / cursors), `useLiveOptimistic` (optimistic overlay reconciled to the live value).
  A Convex/Liveblocks/PartyKit-class layer with **zero npm and zero extra infra**; the socket is
  shared with `<Live>` and opens only when a live feature mounts. — `src/live.ts` exports.
- _Caveat:_ requires a Flight (RSC) route; the WebSocket transport is a new attack surface tracked
  in [CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md).

### 4.2 Resumability — zero up-front hydration **[opt-in]**

- **Automatic mode.** `export const resumable = true` (`src/build/segment-config.ts`) makes a
  route interactive with **no up-front hydration**, and **plain components work unchanged**
  (`useState` + `onClick`, no `qrl`, no `client:*`). The server carves each island into a foreign
  `<div data-dnx-island>` the page root never executes, and stamps handler hosts with
  `data-dnx-h`; a single delegated listener resumes-and-replays the triggering event to the
  just-resumed handler (or, for a `qrl`, dispatches without mounting at all). Effect-only islands
  hydrate on idle. Only the touched island resumes; `useSignal` state is adopted, not recomputed.
  — server emit `src/jsx/render-to-html-flight.ts` + `src/jsx/render-to-string.ts`
  (`serializeAttributes` stamps `data-dnx-h`); client `src/client/qrl-dispatch.ts`
  (`installQrlDispatch`), `src/client/lazy-boot.ts` (`bootResumability`),
  `src/client/dom-fiber-map.ts`.
- **Island-level lazy hydration** — `client:load|idle|visible|interaction` directives defer an
  island's hydration until its strategy fires; the deferred-hydration runtime is a separate
  `@denext/denext/lazy` chunk, imported only when a page has lazy islands. —
  `src/runtime/lazy-directive.ts` (`parseStrategy`), `src/client/lazy-hydrate.ts`, `src/lazy.ts`.
- **`qrl()` — lazily-loaded, code-split, resumable handlers** — wrap a handler's dynamic import;
  the code is fetched on first activation, the handler survives serialization (a Flight `{$:"e"}`
  reference), and a delegated listener dispatches it **without running its component**. —
  `src/runtime/qrl.ts` (`DNX_H_ATTR` :29).
- **`useSignal` / `useStore` — reactive, serializable state** — `useSignal(0)` returns a stable
  box (`.value` / `.peek()`), `useStore(obj)` a shallow reactive object; values are serialized
  into a `#__denext_state` island keyed by position and **adopted** on the client instead of
  recomputing the initializer. React-parity hooks are untouched, and the signal runtime
  tree-shakes out of apps that never use it. — `src/runtime/signals.ts` (`useSignal` :50 /
  `useStore` :71), `src/runtime/signal-state.ts`.
- _Caveat:_ requires a Flight (RSC) route (the isomorphic single-root path doesn't use it);
  effect-only islands default to interaction-deferral, so give them an explicit
  `client:load`/`client:idle` if they must run without interaction.

## Maintenance

When you add or change a denext-specific feature or enhancement, update the right
part here: Part 1 for a supported feature (terse category bullet, ⚑ for
experimental), Part 2 for a genuine advantage over React/Next (mechanism `file:line`

- a **[default]/[opt-in]/[capability]** label). Keep the honesty caveats — the goal
  is an accurate ledger, not marketing. Gaps and divergences belong in
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md), not here.
