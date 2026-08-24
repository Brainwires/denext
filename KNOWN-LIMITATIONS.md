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
  `plugins: [pagesRouter()]` to `denext.config.ts`. Remaining gaps: `router.events`,
  shallow routing, `<Link>` prefetch, i18n locale routing, legacy `getInitialProps`.
  See [PLUGINS.md](./PLUGINS.md).
- **Isomorphic soft-nav re-runs the route bundle (no in-place Flight reconcile).**
  A soft navigation to a **Flight** route transfers only the JSON Flight payload
  and reconciles the retained root in place. An isomorphic (non-Flight) route
  instead re-runs its route bundle to rebuild the tree — but it no longer transfers
  the full HTML document to do so: the server answers the nav with a compact JSON
  payload (`{title, data, entry, styles}`) and the client updates the title, the
  `#__denext_data` island, and the per-route stylesheets, then re-injects the entry
  (which reconciles the DOM through the retained root). The remaining difference from
  a Flight route is that the isomorphic route's module is re-evaluated on each nav
  rather than the tree being rebuilt from a registry. **Recommended path:** give
  routes where module re-evaluation cost matters a client/server boundary
  (`"use client"`/`"use server"`) so they qualify as Flight routes.
- **Legacy provider context** (`getChildContext` / `childContextTypes`) is
  unsupported on SSR; only `contextType` reaches parity (across all SSR
  renderers).
- **Strict default CSP** blocks external `<script src>` / stylesheets /
  `<img src>` until opted in per route — third-party widget/script-injecting
  libraries can be blocked by default until you opt hosts in. CSP is three-state
  and configurable: set `denext.config` `csp` to `"strict"` (default), `"off"` (no
  CSP header — Next.js-style, or set it at the edge), or an opt-in object; a route's
  own `csp` export (including `"off"`/`"strict"`) overrides the global for that
  route. It applies to **both buffered and streamed/PPR** responses (see the
  Security section).
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
  offline.

## Next.js drop-in (next-compat pipeline)

An unmodified Next.js **App Router** project can build and run on denext:
`denext migrate` writes a `deno.json` from the app's `package.json`; then
`denext build && denext start` (and `denext dev`) render it. When the project
uses npm React libraries (next-themes, Radix, recharts, …), denext auto-detects
next-compat mode (or set `compatibilityMode` in `denext.config`) and rewrites every
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
- **`React.cache` is request-scoped during SSR**: a `cache()`d function's result is
  keyed to the current request, so one request's value is never served to another.
  Off-request/client it's a persistent per-function memo.
- **`next/font/google` self-hosts at build by default** (Next parity): `denext
  build` downloads each used font's CSS + files and serves them from
  `/_denext/fonts`, so the browser never requests fonts from Google. A font the
  build can't fetch (offline / air-gapped CI) falls back to a runtime `<link>` with
  a warning; `denext dev` also uses the runtime `<link>` (no build step). Note the
  build now **executes** each page/layout module to discover font declarations — a
  module that can't load at build (e.g. top-level request-context access) is skipped
  and its fonts fall back to the runtime link.
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

## SPA mode (`mode: "spa"`) — scope & tradeoffs

SPA mode runs a **client-only** app (no `app/` directory). It intentionally does
**not** do what the App Router does, and has a few sharp edges to know:

- **No SSR / SSG / Flight.** The server sends an HTML shell with an empty root
  element; the app renders entirely on the client. There are no server components,
  no streaming, and no 0-KB-by-default static pages in this mode — those are App
  Router features. Choose App Router when you want server rendering.
- **Dev is live-reload, not Fast Refresh.** A source edit triggers a full page
  reload; component state is **not** preserved across edits (the state-preserving
  Fast Refresh above applies to the App Router entry, not a foreign SPA entry). A
  per-module SWC refresh transform for SPA mode is not yet wired.
- **The entry mounts itself.** denext bundles `spa.entry` for its side effects and
  provides an empty `#root` (configurable via `spa.rootId`); creating the root and
  rendering is the entry's job (`createRoot(...).render(...)`, as in a Vite app).
  denext does not call into the app after mounting, so routing/state/data are
  entirely yours.
- **npm-React path uses esbuild + needs installed deps.** A SPA that uses npm React
  bundles through the next-compat esbuild rewrite (not plain `deno bundle`), which
  resolves npm packages via the deno-loader — so `node_modules` must be materialized
  (`deno cache`/`deno install`) and the app's `deno.json` must be a valid,
  workspace-consistent config (the loader rejects a config that is not a member of an
  enclosing Deno workspace).
- **Vite asset imports** are handled on the compat path: `?url` (→ emitted file + URL),
  `?worker` (→ bundled chunk + `new Worker(url)`), `?raw` (→ text), `?inline` (→ data
  URL), bare `.wasm`/`.woff2`/image imports, and `new URL(…, import.meta.url)` — all
  emitted under `/_denext/client/assets/` (served by the SPA server, copied by `export`).
- **Tailwind on the compat path**: set `denext.config.ts` `tailwind: { input, output }`
  and **import the compiled `output`** from your entry (not the raw `@import "tailwindcss"`
  input — the input is excluded from the CSS pipeline's walk). The app's `deno.json` must
  anchor resolution (`nodeModulesDir` or `npm:` imports) so the `.css`→shim redirect is
  visible to the compat deno-loader.
- **Framework codegen (e.g. TanStack Router's `routeTree.gen.ts`) runs out-of-band.**
  esbuild does not run Vite plugins, so generate route trees before building
  (`tsr generate` in a `prebuild` step, `tsr watch` alongside `denext dev`).
- **One mode per project.** `mode: "spa"` turns off route scanning entirely — you
  cannot mix `app/` routes with SPA mode in the same project. For a mostly-server
  app with a few client-heavy screens, use the App Router with `"use client"`
  islands (or resumability) instead.
- **History-API fallback only.** Every non-asset navigation is served the same
  shell; deep links work via the client router. There is no per-path server
  response, redirect, or middleware in SPA mode.

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
  flushed immediately with each hole showing its fallback; each hole's real content
  then streams in as a `<template>` revealed by a single hashed swap-runtime script
  (no per-hole inline script), and the hydration scripts + client entry are emitted
  **last** so the client hydrates the completed document. The streamed response
  carries the **same strict hash-based CSP** as a buffered one (see the Security
  section); it is `private, no-store`. The shell — including `use cache` islands —
  still renders once and is cached; only the dynamic holes run per request.
- **PPR engages for cacheable pages AND `"use client"` (Flight) routes.** For a
  cacheable page (opted in via `revalidate`/`force-static`) it lifts the
  all-or-nothing rule where **any** dynamic read disqualified the whole page: the
  shell caches and the dynamic parts become per-request holes. A postpone-aware dual
  HTML+Flight renderer (`src/jsx/render-to-ppr-flight.ts`) means this now works on
  routes with a `"use client"` boundary too — client islands in the cached shell and
  inside resumed holes both hydrate. A page with no caching opt-in still renders
  fully per request.
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

## Islands & resumability (`client:*` directives, `resumable`, `qrl`)

denext ships directive-based **islands + progressive hydration** and **resumability**
as one system (islands are stage 1 of resumability). These go beyond React/Next.js;
the gaps below are real and bounded.

- **Flight (RSC) route only.** The island carve-out and signal adoption live on the
  Flight render path (a route with a `"use client"` boundary, or `resumable`). The
  isomorphic single-root path and SPA mode hydrate as one root and don't use per-island
  deferral. Add a `"use client"` boundary (or `export const resumable = true`) to opt a
  route in.
- **`client:only` skips SSR; `client:media` needs `matchMedia`.** Of the six
  directives (`load | idle | visible | interaction | media | only`), `client:only`
  renders on the client only (empty wrapper server-side), so it has **no first
  paint** — expect a layout shift and no SEO content for that subtree; and
  `client:media="(min-width:800px)"` hydrates immediately when `matchMedia` is
  unavailable. Precedence is **usage-site `client:*` > module `export const hydrate`
  > eager**.
- **Nested `client:*` islands hydrate with their parent (no independent deferral yet).**
  A `client:*` island rendered _inside_ another island's subtree is **gated to eager**:
  it renders inline (no wrapper of its own) and hydrates as part of the parent island's
  `hydrateRoot`, so the enclosing island's server HTML and client render stay
  structurally identical. Its own directive is ignored (and stripped, so it never leaks
  into serialized props). Independent deferral of a nested island would require a
  scope-aligned second carve and is deferred. Put a `client:*` island at the top level of
  a route (not passed as children into another island) if it must defer on its own.
- **`qrl()` has no build transform yet.** `qrl(() => import("./handler.ts"))` works at
  runtime (the handler is code-split and dispatched without mounting its component), but
  there is no compiler pass that auto-wraps handlers — you write the `qrl()` call
  yourself. A plain `onClick` in `resumable` mode is resumed-and-replayed via the
  delegated dispatcher instead.
- **Concurrent renders can interleave signal collection.** `useSignal`/`useStore` state
  is gathered into a module-global collector keyed by `useId`; two page renders running
  concurrently in the same isolate can interleave. In practice each request renders to
  completion within its own async context, but a custom renderer that awaits across two
  page renders sharing the collector is unsupported.

## Security posture — known limitations & accepted tradeoffs

denext's 1.0 security audit fixed every High/Medium finding and the quick-win
Lows. The items below are the gaps we **deliberately defer or accept** for 1.0 —
each with its trigger and why. They are limitations, not silent surprises; most
have a straightforward operator-side hardening or a scoped follow-up. See
[DEPLOYMENT.md](./DEPLOYMENT.md) for the operational checklist.

- **A streamed hole can't extend the CSP or hoist late metadata.** Streaming ships
  the same strict hash-based CSP as a buffered response — `script-src` from a fixed
  swap-runtime hash plus the route's `scriptSrc`, `style-src` from the inline
  `<style>` hashes in the already-flushed head — so a **Suspense hole must not emit
  an inline `<style>`/`<script>`**: the head is already out, its hash can't be added,
  and the drainer logs a dev warning if a hole's HTML contains one. A streamed route
  is also not ISR page-cached (it renders per request), and an in-tree
  `<title>`/`<meta>` _inside_ a boundary that resolves after the head flushes stays
  inline rather than hoisting (shell-level metadata hoists normally).
- **HSTS defaults to host-only (`max-age=31536000`, no `includeSubDomains`/
  `preload`).** The safe default can't brick sibling subdomains that aren't
  HTTPS-ready. It is configurable via `denext.config` `hsts`: set
  `{ includeSubDomains: true, preload: true }` (or a custom `maxAge`) for a stronger
  policy once all subdomains are HTTPS, or `hsts: false` to omit the header (e.g.
  your edge sets it).
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
- **Scaffolded `dev`/`build` tasks use `deno run -A`.** The generated `start` task
  runs least-privilege (`--allow-net --allow-read --allow-env`), but `dev`/`build`
  keep broad permissions because they compile, write `.denext`, and spawn tooling
  (Tailwind/esbuild). Tighten those for a locked-down CI if needed. (Examples still
  document `-A` for brevity.)
- **`@denext/og` egresses rendered non-Latin text to `fonts.googleapis.com`.**
  Beyond the "Latin glyphs need no extra permission" note: rendering non-Latin text
  in an OG image fetches the matching Google font, which sends the **text content**
  of that string to Google. To keep OG rendering fully local/offline, supply a local
  font via the `fonts` option instead of relying on the Google-font fallback.
- **The public-env island ships only the referenced prefixed variables.** `denext
  build` scans the client bundles and embeds only the `NEXT_PUBLIC_*` /
  `DENEXT_PUBLIC_*` vars the client actually references (not every prefixed one). A
  key read via a computed expression (`publicEnv()["NEXT_PUBLIC_" + x]`) can't be
  detected — force-include it via the `publicEnv: [...]` config allowlist. In `dev`
  (no build scan) all prefixed vars are shipped. Caveat unchanged: never give a
  _secret_ a public prefix.
