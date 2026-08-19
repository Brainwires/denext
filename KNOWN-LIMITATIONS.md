# denext — Known limitations & behavioral divergences

denext reimplements the React + Next.js surface on Deno with its own tiny
React-equivalent and zero runtime npm dependencies. Compatibility is owed at the
**surface** (imports resolve, public APIs exist and behave correctly so real npm
libraries run); the internals deliberately **diverge where denext can be faster
or leaner** (its own fiber reconciler, an async-only SSR renderer). This document
is the honest catalogue of where the observable behavior differs from React/Next,
and which surfaces are experimental.

Most divergences below are confined to the **next-compat interop path** (running
real npm React libraries via `buildNextCompatPages`); denext's own apps are
unaffected. See [DEPLOYMENT.md](./DEPLOYMENT.md) for operational
responsibilities.

## React behavioral divergences

- **Async `startTransition` entangles by a time _window_, not by transition
  identity — a browser runtime constraint, not an unfinished feature.**
  `startTransition(async () => { await x; setState() })` works: the transition
  stays active across the `await` (post-`await` updates land on the transition
  lane, interruptibly) and `useTransition`'s `isPending` is held until the
  returned promise settles and its flush lands. React scopes entanglement to the
  specific transition's updates using an async-context primitive; **the reconciler
  runs in the browser, where no such primitive exists** (`AsyncLocalStorage` is
  server-only, and TC39 `AsyncContext` is not yet shipped in browsers), so denext
  scopes to a **time window** instead: while _any_ async transition's promise is
  pending, updates are treated as transition-priority. An unrelated urgent update
  during that window is therefore also deferred to the transition flush. The
  window is brief (it closes when the promise settles), and `useActionState`
  tracks its own pending state independent of this path. If the promise _never_
  settles (a bug in the async callback), the window never closes — `isPending`
  stays true. In **development** (`__denextDev`) a watchdog `console.warn`s when
  an async transition has been pending for over ~10s to surface this; it never
  force-settles (that would mask the real never-resolving `await` in production).
- **`unstable_batchedUpdates(fn)` just calls `fn`.** denext already batches
  updates (as does React 18+ automatic batching, which made this a legacy API),
  so this is a no-op wrapper provided for import compatibility; a library relying
  on it to _force_ a flush boundary gets different timing.

## Next.js divergences

- **Pages Router is not in core** — App Router is the built-in router. A Next.js
  **Pages Router** (`pages/` routing, `getServerSideProps`/`getStaticProps`/
  `getStaticPaths`, `_app`/`_document`, `pages/api/*`, `useRouter`) is available as an
  **opt-in plugin**, [`@denext/pages-router`](./packages/pages-router): add
  `plugins: [pagesRouter()]` to `denext.config.ts`. As of v0.3 it has full Pages Router
  parity for real apps — SSR + client hydration + code-split soft (SPA) navigation, CSS
  / CSS Modules, `_error`/`404`/`500`, `next/head`, build-time SSG + `revalidate` ISR,
  and dev Fast Refresh. Remaining gaps are minor (`router.events`, shallow routing,
  `<Link>` prefetch, i18n locale routing, legacy `getInitialProps`). See
  [PLUGINS.md](./PLUGINS.md).
- **Client navigation between isomorphic routes re-fetches full HTML.** A soft
  navigation to a **Flight** route transfers only the JSON Flight payload (the
  client rebuilds the tree through the app-wide client registry and reconciles
  in place); an isomorphic (non-Flight) route still re-fetches the full HTML
  document and re-runs its route bundle. This also means an isomorphic route's
  already-loaded module is retained across the nav rather than swapped.
  **Recommended path:** give routes where soft-nav cost or module retention
  matters a client/server boundary (`"use client"`/`"use server"`) so they
  qualify as Flight routes.
- **Legacy provider context** (`getChildContext` / `childContextTypes`) is
  unsupported on SSR; only `contextType` reaches parity (across all SSR
  renderers).
- **Strict default CSP** blocks external `<script src>` / stylesheets /
  `<img src>` until opted in per route — third-party widget/script-injecting
  libraries can be blocked by default until you opt hosts in. CSP is three-state
  and configurable: set `denext.config` `csp` to `"strict"` (default), `"off"` (no
  CSP header — Next.js-style, or set it at the edge), or an opt-in object; a route's
  own `csp` export (including `"off"`/`"strict"`) overrides the global for that
  route. It is still applied to **buffered** page responses only, not
  streaming/Flight responses (set those at the edge — see
  [DEPLOYMENT.md](./DEPLOYMENT.md)).
- **`fetch()` is uncached by default** — matches the Next.js 15 **and** 16
  default (both flipped `fetch` and GET Route Handlers to uncached-by-default);
  stricter only versus Next ≤ 14. Opt in per call with
  `next: { revalidate, tags }` / `cache: "force-cache"` (Next's "previous
  model"). Next 16's `use cache` directive + Cache Components / PPR are
  implemented behind the experimental `cacheComponents` flag — see the **Cache
  Components** section below.
- **ICU message formatting is a compact subset**, not full `intl-messageformat`.
  Interpolation, `number`/`date`/`time`, `plural`/`selectordinal`/`select` (with
  `offset:`/`#`), nested submessages, and **apostrophe escaping** (`''`, quoted
  `'{'`/`'}'`/`'#'`) are supported; `spellout`/`duration` and full number/date
  skeletons are not.
- **`next/og` renders satori's layout subset.** The OG renderer (`@denext/og`,
  denext's own first-party codec — no setup) supports **flexbox + inline `style`
  only** (no `className`/CSS), and components must be **synchronous**. The bundled
  **Noto Sans** covers Latin and renders fully offline; glyphs outside it (emoji,
  CJK, other scripts) fetch fonts from Google at render time (needs `--allow-net`)
  and fall back to a placeholder glyph offline — pass your own `fonts` to stay
  offline. All of denext's codecs are now first-party, zero-npm JSR packages: image
  **resize/WebP** (`@denext/photon`), **AVIF** output (`@denext/avif`), the OG
  renderer (`@denext/og`), and the durable **SQLite cache** (`@denext/sqlite`) —
  **no peer dependencies remain**.

## Next.js drop-in (next-compat pipeline)

An unmodified Next.js **App Router** project can build and run on denext:
`denext migrate` writes a `deno.json` from the app's `package.json`; then
`denext build && denext start` (and `denext dev`) render it. When the project
uses npm React libraries (next-themes, Radix, recharts, …), denext auto-detects
next-compat mode (or set `nextCompat` in `denext.config`) and rewrites every
`react`/`react-dom`/`next/*` import — **including those inside npm packages** — to
denext at bundle time, so the whole app runs on denext's **one** React (no dual
React). The full `next/*` surface is aliased (link, navigation, image, og,
headers, cache, server, font, …).

The **RSC/Flight boundary is preserved** in compat mode: a compat route that
reaches a `"use client"` island renders its Server Components **server-side only**
and hydrates **just the islands** through a react→denext-rewritten flight bundle.
So an `async` data-fetching Server Component (`await db.query()`) works in a
compat route — its code stays on the server and never enters any client bundle;
only the `"use client"` islands (react→denext rewritten, keyed by the same stable
client ids the server tags) ship to the browser. Identity holds because each
island is bundled as its own build entry (a shared runtime chunk), so the page
bundle and the SSR-tagged island resolve to one instance. A compat route with
interactivity but no explicit `"use client"` boundary falls back to full-tree
hydration.

Current boundaries of the drop-in path:

- **`deno check` on a compat app is clean for typical apps.** `denext migrate`
  sets `skipLibCheck: true` (as Next.js/CRA do) so `deno check` validates **your**
  `.tsx` — not the bundled `.d.ts` of npm libraries, which are re-checked against
  denext's React type shim and would otherwise report harmless mismatches deep in
  `node_modules`. denext's `JSX.ElementType` admits `ReactNode`-returning
  components, so real component libraries (Radix incl. `asChild`, lucide, recharts,
  cva) type-check as JSX. Any residual library-specific type edge is type-only and
  never affects runtime rendering.
- **The boundary crawl resolves `@/…` path aliases from the app's `deno.json`**,
  so run `denext build`/`dev` from the **project directory** (its config on the
  cwd) — otherwise island detection can miss `@/`-imported `"use client"` modules
  and treat an interactive route as static.
- **Synchronous `react-dom/server` APIs throw.** denext's renderer is async, so
  `renderToString`/`renderToStaticMarkup`/`renderToPipeableStream` throw (loudly,
  not a wrong render). Libraries that call them at runtime for SSR (some
  CSS-in-JS `@emotion/server`, `react-pdf`, `@react-email`) are unsupported;
  use `renderToReadableStream`.
- **`React.lazy` maps to `next/dynamic`.** It loads the module but renders
  `next/dynamic`'s own `loading` option rather than suspending to the nearest
  `<Suspense fallback>`, so a `<Suspense>` fallback around a `React.lazy` child may
  not show during load. Prefer `next/dynamic` explicitly, or a denext dynamic import.
- **No `server-only`/`client-only` build enforcement.** A directive-less server
  module imported by a `"use client"` island is bundled to the browser (matching
  Next's default graph), but denext does not shim the `server-only` poison package,
  so the mistake fails at browser runtime rather than at build. Mark server-only
  modules with a top-level `"use server"` (they're stripped to client stubs), and
  keep secrets in Server Components.
- **`React.cache` is request-scoped during SSR** (fixed): a `cache()`d function's
  result is keyed to the current request, so one request's value is never served to
  another. Off-request/client it's a persistent per-function memo.
- **`next/font/google` fetches from Google at runtime by default** (a live
  `<link>`); opt into build-time self-hosting for privacy/offline.
- **Pages Router is not built into core** (see above) — App Router is built in; the
  Pages Router ships as the opt-in `@denext/pages-router` plugin.

## Fast Refresh (dev) preserves state for a scoped set of components

`denext dev` does state-preserving Fast Refresh: editing a `.tsx`/`.jsx` module
re-imports the route entry and reconciles in place (via a stable
component-family id) instead of a full reload, keeping `useState`/`useReducer`
state. Scope and fallbacks (it never risks corrupt state — it reloads when
unsure):

- **State is preserved for the route-structural components** the client entry
  registers — the page, its layouts and templates, and (for Flight routes) the
  `"use client"` islands. Components imported transitively and not enumerated by
  the entry remount on refresh (their local state resets); the surrounding
  registered components keep theirs.
- **Editing a component's hook shape** (adding/removing/reordering hooks) is
  detected as an unsafe reconcile and triggers a **full reload** rather than
  reusing mismatched hook cells. (A same-count reorder is not caught — a rare
  edge; hard-reload if state looks stale.)
- **`.css`, `public/` assets, config, middleware, and `.ts` server modules** do
  a **full reload** (not a refresh), since a client re-import can't reflect
  them. A **server component** edit likewise needs a reload to re-render on the
  server.
- Any hydration/render error during a refresh falls back to a full reload.

The refresh runtime is dev-only and DCE'd from production builds (its entries
carry none of it), so `denext build` output is byte-for-byte unaffected.

## React DevTools support (partial, not 100%)

denext registers with the React DevTools extension and reports each commit as a
React-fiber-shaped tree. What works and what doesn't:

- **Works:** the **Components tree** (correct component names, nesting, host
  elements) and **read-only props** in the inspector; element selection; a build
  type reported honestly (development vs production).
- **Does not work (post-1.0):** **hooks/state inspection** (React's DevTools
  reconstructs hooks by re-rendering the component with a special dispatcher
  through the renderer's internals, which denext's reconciler doesn't expose —
  version-sensitive backend work deferred past 1.0), **editing props/state /
  override hooks**, **context inspection**, the **Profiler tab**, and **source
  links / owner stacks** (needs a `react-jsxdev` compile path). Suspense/Portal/
  Class fibers are reported as function components.

`denext dev` provides a **standalone dev error overlay** (independent of the
extension): runtime errors, unhandled rejections, and server-pushed build/bundle
errors surface as a full-screen overlay, dismissed on the next successful edit.

If you need full hooks/Profiler inspection today, that remains a React-on-Node
capability; denext's tree/props view covers the common "what is rendering and
with what props" case.

## Experimental / unstable APIs (may change upstream)

denext implements these still-`unstable_`-prefixed (or intentionally internal)
surfaces for compatibility. They track APIs upstream still treats as unstable, so
they **may change or be removed** as those stabilize:

- `unstable_cache` (Next data cache) — still `unstable_` in Next 16; `use cache`
  (see below) is its successor, but `unstable_cache` remains valid.
- `unstable_batchedUpdates` (see the no-op note above) — legacy since React 18's
  automatic batching; retained for import compatibility.
- `useMemoCache` / `c` (React Compiler runtime) — an **internal** runtime helper
  the compiler emits, not a user-called API. The React Compiler reached **1.0
  (stable)** in Oct 2025, so the contract is stable; it is listed here only
  because it is internal, not because it is expected to break.

Now stable upstream and no longer treated as unstable by denext (kept here as a
migration note): **`useEffectEvent`** stabilized in **React 19.2** — denext exports
it as a stable hook. **`setRequestLocale`** (next-intl) stabilized in **v3.22**;
denext exports the stable name, with `unstable_setRequestLocale` retained as a
deprecated alias.

Not implemented (by design, for now): React `taint*` APIs, `Activity`,
`ViewTransition`; Next `dynamicIO` and `taint`. (Cache Components / PPR **are**
implemented behind `experimental.cacheComponents` — see below.)

## Cache Components (`use cache` + PPR) — experimental

Enabled with `experimental: { cacheComponents: true }` in `denext.config`. The
`use cache` directive (module-top or function-body) compiles into cross-request
server caching, and a cacheable page renders a request-independent **static
shell** (cached once) with dynamic subtrees (`cookies()`/`headers()` behind a
Suspense boundary) as **per-request holes**.
`cacheLife`/`cacheTag`/`revalidateTag`/ `updateTag`/`refresh` are all available.
When the flag is **off**, `use cache` is an inert string and the render path is
byte-for-byte unchanged.

First-landing scope — deliberate limitations:

- **Streamed holes.** The cached shell (its `<head>` rebuilt per request) is
  flushed immediately with each hole showing its fallback; each hole's real
  content then streams in as a `<template>` + a `__dnxSwap` script, and the
  hydration scripts + client entry are emitted **last** so the client hydrates the
  completed document. Because the body is streamed there is no per-response
  content-hash CSP — a streamed PPR response relies on an **edge/proxy CSP** (see
  DEPLOYMENT.md); it is already `private, no-store`. The shell — including
  `use cache` islands — still renders once and is cached; only the dynamic holes
  run per request.
- **PPR engages only for already-cacheable pages** (those opted in via
  `revalidate`/`force-static`). It lifts the all-or-nothing rule where **any**
  dynamic read disqualified the whole page from caching: now the shell caches
  and the dynamic parts become holes. A page with no caching opt-in still
  renders fully per request.
- **Flight / client-island routes fall through** to the normal render (PPR is
  not applied); they can still use `use cache` at the data layer.
- **Reading request data inside `use cache` is rejected.** Calling `cookies()`,
  `headers()`, or `connection()` inside a `use cache` function throws (as in
  Next.js) — the result is request-specific and must not be cached and served to
  other users. Read it outside the cached function and pass the value in.
- **`searchParams` read outside a Suspense boundary** is request data that is not
  postponed, so with `cacheKeyParams` set (narrowing the page cache key) a shell
  that reads a non-key param would reflect one request's value. Keep `searchParams`
  reads inside a boundary (a hole), or don't narrow the key for routes that read
  arbitrary params.
- **Persistent cache stores don't evict non-expiring entries.** The in-memory
  store is LRU-bounded, but the SQLite/KV backends only drop an entry when its key
  is re-read while stale. A `force-static`/`expire: Infinity` entry, or a
  query-keyed page with `cacheKeyParams` unset, can accumulate — set
  `cacheKeyParams` for query-heavy routes and prune the backing store out of band.
- **`revalidateTag(tag, profile)` (soft SWR) hard-purges on the Deno KV store.**
  The in-memory and SQLite stores implement soft-expire (they serve stale while
  refreshing); the Deno KV backend does not, so a tagged revalidate there deletes
  the entry and the next reader recomputes rather than serving stale.

## Class components are opt-in (next-compat build)

In the **next-compat build**, class components are gated behind
`classComponents: true` (so a function-only project pays nothing for the class
runtime). With the flag off, a class-based library bundles fine but throws a
guided error at first render. The default `denext build`/`dev` path always
compiles the class runtime in, so this only affects next-compat bundling.

## Security posture — known limitations & accepted tradeoffs

denext's 1.0 security audit fixed every High/Medium finding and the quick-win
Lows. The items below are the gaps we **deliberately defer or accept** for 1.0 —
each with its trigger and why. They are limitations, not silent surprises; most
have a straightforward operator-side hardening or a scoped follow-up. See
[DEPLOYMENT.md](./DEPLOYMENT.md) for the operational checklist.

- **Streamed pages (PPR / Cache Components) emit no per-response CSP and ship
  unhashed inline swap scripts.** Non-PPR responses get a hash-based CSP because
  the body is buffered and hashable; a _streamed_ PPR response is flushed
  incrementally, so its inline hole-swap scripts can't be hashed ahead of time and
  the strict CSP is omitted for that response. This is gated behind the
  experimental Cache Components flag. The fix (a single hashable runtime instead of
  per-hole inline scripts) is a real refactor — **deferred**. If you enable PPR and
  need CSP, front it with a proxy that injects a nonce-based policy.
- **Streaming vs CSP tradeoff (general).** The hash-based CSP can only hash a fully
  buffered body, so a streamed response can't carry it. denext buffers non-PPR
  routes by default so they get the CSP. Incremental (Suspense) streaming for
  non-PPR routes is available behind `experimental.streaming`, but it is applied
  **only to routes where no CSP would be emitted** (`csp: "off"` globally or on the
  route) — a route that keeps a CSP still buffers, with a one-time log warning that
  streaming was skipped for it. So enabling streaming never silently drops a CSP.
  (A streamed route also isn't ISR page-cached — it renders per request — and an
  in-tree `<title>`/`<meta>` inside a Suspense boundary that resolves _after_ the
  head flushes stays inline rather than hoisting; shell-level metadata hoists
  normally.)
- **HSTS omits `includeSubDomains` and `preload`.** The default `Strict-Transport-
  Security` header intentionally scopes to the exact host so enabling HTTPS on one
  app can't brick sibling subdomains that aren't HTTPS-ready. It is **not yet
  configurable** — if you want subdomain coverage/preload, set the header at your
  edge/proxy.
- **Session cookie is not `__Host-` origin-locked by default (one-line opt-in).**
  The default cookie name is `denext_session`; making `__Host-` the default would
  rename the cookie and invalidate every live session on upgrade, so it stays
  opt-in. Pass `hostPrefix: true` to `getSession` (or a `cookieName` that already
  begins with `__Host-`) to origin-lock it — denext's cookie layer then guarantees
  the browser-required `Secure` + `Path=/` + no-`Domain` invariants, so a sibling
  subdomain can neither read nor overwrite the cookie. It works on `http://localhost`
  too (localhost is a secure context). Enabling it logs users out once (the cookie
  is renamed). A too-short signing secret also warns.
- **Graceful shutdown drains for a bounded time, then forces exit.** On a shutdown
  signal the server stops accepting connections and drains in-flight requests, but
  only up to a deadline (default **10s**; set `DENEXT_SHUTDOWN_DRAIN_MS`, or `0` to
  wait indefinitely). If the deadline elapses with requests still in flight the
  process force-exits — so a stuck/slow client can't pin it open, at the cost of
  cutting genuinely long in-flight responses on shutdown, and **plugin teardown is
  skipped on a forced exit** (it runs only when the drain completes cleanly). Size
  the deadline above your longest expected request and below your orchestrator's
  kill grace period (e.g. k8s `terminationGracePeriodSeconds`).
- **Plugin teardown is skipped if startup throws after `applyPlugins`.** If server
  bootstrap fails _after_ plugins were applied, their `addTeardown` hooks may not
  run. The CLI force-exits anyway, so this only matters for **embedded callers**
  that start denext in-process and expect teardown on a failed boot.
- **Scaffolded projects and examples run production with `deno run -A`.** The
  generated scripts use all-permissions for zero-friction onboarding. For a
  hardened deploy, run with least privilege instead, e.g.
  `deno run --allow-net --allow-read=. --allow-env --allow-write=.denext,./out`.
- **The `react`/`next` specifier rewrite fails open on a matched-but-unmapped
  subpath.** In the next-compat build, an unmapped `react-*` subpath specifier
  passes through rather than erroring. This is **build-time only** (never a runtime
  code path); a stray unmapped subpath surfaces as a normal module-resolution
  error downstream, not a silent runtime swap.
- **`@denext/og` egresses rendered non-Latin text to `fonts.googleapis.com`.**
  Beyond the "Latin glyphs need no extra permission" note: rendering non-Latin text
  in an OG image fetches the matching Google font, which sends the **text content**
  of that string to Google. To keep OG rendering fully local/offline, supply a local
  font via the `fonts` option instead of relying on the Google-font fallback.
- **The public-env island ships every prefixed variable.** All `NEXT_PUBLIC_*` /
  `DENEXT_PUBLIC_*` environment variables are serialized to the browser, not only
  the ones a component references. This matches Next.js's build-time inlining model,
  but is worth stating for migrations: never give a _secret_ a public prefix.
