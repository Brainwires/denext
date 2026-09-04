# denext — Honest edges

denext's promise is the **React/Next.js surface**: public APIs exist and behave
correctly for correct usage. This file lists only the places that promise
doesn't fully hold — a genuine **surface gap** (an API missing, throwing, or
behaving observably wrong) — plus the **bounded scope** of denext's own
capabilities (islands, resumability, Live, SPA mode, Cache Components). It is
deliberately terse; a fixed entry is deleted, not annotated.

Internal differences that **don't** break the surface — denext's own reconciler,
its async SSR renderer, the two-mechanism soft-nav, request-scoped
`React.cache`, Pages-Router-as-a-plugin, the next-compat build defaults — are
**design choices, not limitations**, and live in
[ARCHITECTURE.md](./ARCHITECTURE.md). Operational defaults live in
[DEPLOYMENT.md](./DEPLOYMENT.md).

## React / Next.js surface gaps

Where the compat surface genuinely differs from React/Next (mostly on the
next-compat interop path — denext's own apps are unaffected):

- **The Node-stream `react-dom/server` APIs buffer (no `Writable`
  backpressure).** `renderToString` / `renderToStaticMarkup` render the
  **synchronously-renderable** subset (a `<Suspense>` whose children suspend
  renders its fallback, exactly as React's `renderToString` does); a genuinely
  async Server Component outside a boundary throws a guided error pointing at
  `renderToReadableStream`. The **Node-stream** APIs — `renderToPipeableStream`
  / `renderToStaticNodeStream` — work via a thin `node:stream` adapter over the
  Web renderer (for npm libraries that hard-code them). `onShellReady` fires at
  the shell flush (the shell is enqueued as the first chunk, which the adapter
  peeks before signalling — a shell that throws surfaces as `onShellError`), but
  the document is still **not `Writable`-backpressured**.

  **Why (and why this isn't just an adapter wart):** the missing backpressure is
  a property of denext's streaming _core_, not of this shim — and denext's own
  apps share it. `render-to-stream.ts` builds its `ReadableStream` with an
  `async start(controller)` that renders each Suspense boundary to completion and
  `enqueue`s it **without consulting `controller.desiredSize`** — it's push-, not
  pull-driven, so completed-boundary HTML lands in the stream's in-memory queue
  regardless of how fast the consumer reads. React's Fizz renderer instead
  interleaves rendering with flushing and applies real backpressure to the
  destination; on that axis React's engine is genuinely more advanced, and we
  don't claim otherwise. denext made the opposite trade deliberately: (1) its
  **primary** primitive is a Web `ReadableStream` — exactly what
  `Response`/`Deno.serve`/edge want — so the Node-`Writable` API is correctly the
  legacy-compat afterthought, not the main path; and (2) the push model is far
  simpler (no Fizz-style scheduler), with fewer streaming edge cases. The cost is
  a narrow tail: a _large_ streamed document to a _slow_ client at _high_
  concurrency holds more in memory than React would. For typical pages (KB–low-MB
  of HTML that render in tens of ms) the queue drains instantly and the
  difference is invisible. True end-to-end backpressure would mean making the
  core renderer pull-gated (and resolving the `await allReady`-then-read deadlock
  that the current eager drain avoids) — an SSR-hot-path change with real
  regression risk and a narrow payoff, so it's deferred rather than rushed.
  denext's own apps should use `renderToReadableStream` regardless.
- **Legacy provider context** (`childContextTypes` / `getChildContext`) is an
  **intentional non-goal** — React deprecated this pre-`createContext` API, so
  denext won't chase it. Modern class context (`static contextType`) reaches
  parity; migrate providers to `createContext`.
- **`next/og` renders satori's layout subset** — flexbox + inline `style` (plus
  Tailwind via the `tw` prop); arbitrary `className`/CSS isn't resolved. This is
  **Next.js parity, not a denext choice**: `next/og` in Next.js renders through
  the same satori engine with the identical subset, so the boundary is satori's,
  and going beyond it would mean a full CSS layout engine / headless browser.
  Async components are supported. Bundled Noto Sans covers Latin offline;
  non-Latin glyphs fetch fonts from Google at render time unless you pass your
  own `fonts` or set `offline: true` (which errors instead of fetching — see the
  Security note below).
- **Async `startTransition` scopes by a time _window_ by default; opt into
  identity scoping with `experimental.asyncContext`.** React scopes
  async-transition entanglement with an async-context primitive browsers haven't
  shipped (`AsyncLocalStorage` is server-only; TC39 `AsyncContext` is still a
  proposal). By default denext uses a time window: while any async transition's
  promise is pending, updates are treated as transition-priority — **except** an
  update enqueued in a DOM event handler (a click/ keydown/input), which stays
  urgent (React's discrete-event priority), so a user interaction is never
  demoted by the window. What remains coarse is an unrelated urgent update
  raised _outside_ any event handler (e.g. from an unrelated timer) while the
  window is open. Rather than wait on the platform, denext ships its own
  first-party `AsyncContext` plus a build transform that makes it survive
  `await`; enable `experimental: { asyncContext: true }` and priority is scoped
  by transition **identity** — a post-`await` update stays a transition, an
  unrelated urgent update in the window keeps its priority. The transform
  instruments every `await` in client code (a small per-`await` cost), so it is
  opt-in; it now also instruments async generators (`await` and `yield`, with
  the frame captured at the first `.next()`), except those using `yield*`
  delegation, which are left un-instrumented — as is top-level `await`. Dev
  warns on a transition pending >10s either way.
- **`React.cache` is request-scoped during SSR, but persists off-request.** React's
  `cache()` is strictly per-request. denext matches that during a server render (the
  memo lives on the request context and is discarded with it), but a `cache()`-wrapped
  function called **outside** a request — in the client bundle, or in non-request server
  code — falls back to a **persistent per-function memo** with LRU eviction after 1024
  distinct primitive-key combinations. Two consequences off-request: a result can persist
  across logical calls where React would recompute, and a hot function with >1024 distinct
  primitive args silently evicts and recomputes. Inside a request (the intended use) the
  behavior is exact; treat `cache()` as request-scoped and don't rely on it for cross-call
  memoization off-request.
- **`next-intl` ICU formatting is a common-subset re-implementation.** Native `next-intl`
  uses the full `intl-messageformat`; denext hand-parses the common subset (plurals,
  select, number/date/time with the usual skeletons). An **unknown number/date skeleton
  token is silently ignored** rather than formatted, and deeply nested `plural`/`select`
  is depth-capped (beyond the cap is an error, not a wrong render). Standard messages
  format identically; exotic skeletons may differ.
- **`next/head` does not dedupe by `key`.** Real Next's `<Head>` collapses tags sharing a
  `key` (and singleton tags like `<title>`) to the last one. denext hoists **all** children
  of every `<Head>`, so two `<Head>` blocks emitting the same-`key` tag produce duplicates.
  Emit each head tag once (App Router `metadata`/`generateMetadata` is the preferred path
  and is unaffected).
- **A few React internals are shims.** `Children.map`/`Children.toArray` flatten and drop
  nullish/boolean children but **don't re-key** the way React namespaces keys during
  `toArray` (edge cases around reordering keyed children produced by `Children.map` differ);
  and the introspection hooks `captureOwnerStack()` / `cacheSignal()` return `null` and
  `addTransitionType()` is a no-op (rendering is unaffected — only dev tooling that reads
  them gets nothing).

## denext-original features — bounded scope

These are **capabilities React/Next don't have** ([FEATURES.md](./FEATURES.md)).
They're shipped and on by default in their contexts; the notes below are their
**documented boundaries**, not a regression from React and not an "experimental"
caveat — being a denext original is not the same as being incomplete.

### Islands & resumability (`client:*`, `resumable`, `qrl`)

- **Flight route only.** Per-island carve-out lives on the Flight path; add a
  `"use client"` boundary (or `export const resumable = true`) to opt in. The
  isomorphic single-root path and SPA mode hydrate as one root.
- **`client:only` skips SSR** (no first paint / SEO for that subtree);
  **`client:media`** hydrates eagerly when `matchMedia` is unavailable.

### Cache Components (`use cache` + PPR)

A stable, **opt-in** feature: enable it with top-level `cacheComponents: true`
in `denext.config.ts` (the pre-2.0 `experimental.cacheComponents` still works
and dev-warns to move). Off, `use cache` is inert and the render path is
byte-for-byte unchanged. Caching is a choice, not a default — these are the
three documented bounds of the opt-in:

- **Reading request data inside `use cache` throws** — `cookies()`/`headers()`/
  `connection()` are request-specific; read them outside and pass the value in.
- **A streamed hole can't emit an inline `<style>`/`<script>`** — the head (with
  its CSP hashes) is already flushed; the drainer dev-warns if a hole's HTML
  contains one. A streamed route isn't ISR page-cached, and in-boundary
  `<title>`/`<meta>` that resolves after the head flush stays inline rather than
  hoisting.
- **`searchParams` read outside a Suspense boundary** with `cacheKeyParams` set
  can reflect one request's value — keep such reads inside a hole, or don't
  narrow the key. When the whole body is cached (a no-hole shell or a plain ISR
  render), the framework now **refuses to store** a render that read a
  non-allowlisted param — in every environment, so the value can't bleed to
  other requests — and **dev additionally warns** and names the dropped param. A
  with-holes PPR shell can escape the read into a per-request hole, so it relies
  on that boundary rather than the store refusal.

## DevTools (dev-only)

denext ships its **own** in-page glass-box panel (`denext/devtools`,
Ctrl+Shift+D) as the full-fidelity surface: a searchable, collapsible component
tree; an element picker with a hover-highlight overlay; live-editable
hooks/state (plus ref-set and reducer-dispatch); prop overrides; deep, lazy
nested-value inspection with copy / `console.log` / store-as-`$d` actions;
capability badges; "why did this render" diffs; a per-commit **Profiler** with a
flamegraph + commit step-through; source links / owner stacks; and a render-mode
tab (static/dynamic/streamed + page-cache HIT/STALE/MISS + a **real-time**
Suspense-boundary waterfall + island hydration).

The stock **React DevTools** extension also works — Components tree, props, live
prop/state editing, and element selection all route back through denext's
reconciler (with an honest dev/prod build type). Two residuals are inherent to
driving a non-React reconciler through the extension: its **hooks view** and its
**Profiler** rely on React-internal introspection a synthetic fiber tree can't
provide — use denext's own panel for those. The panel's "owner stack" is the
render-parent chain, an approximation of React's JSX-owner stack (they coincide
for the common case).

## Experimental / unstable APIs

Implemented for compatibility but tracking still-unstable upstream surfaces, so
they may change: `unstable_cache` (still `unstable_` in Next 16),
`unstable_batchedUpdates` (a no-op — see [ARCHITECTURE.md](./ARCHITECTURE.md)),
`useMemoCache`/`c` (React Compiler runtime — the compiler hit 1.0 stable; this
is an internal helper). **`ViewTransition` applies route-level transitions**: a
Flight soft-navigation commits inside `document.startViewTransition` where the
browser supports it, so the route swap cross-fades; the component's per-element
props (`name`/`enter`/`exit`) are not yet honored (that needs real
`view-transition-name` DOM markers), and the isomorphic/HTML nav paths (async
reconcile) don't animate yet. **`Activity` is still a passthrough shim** — it
renders its children and ignores `mode`; real offscreen scheduling (deferred
pre-render, hidden-subtree state preservation) is a **not-yet-built** reconciler
feature, not a non-goal. **React `taint*` is implemented**:
`experimental_taintObjectReference` / `experimental_taintUniqueValue` mark a value
that must never cross the server→client boundary, enforced in the Flight serializer
(it throws rather than serialize a tainted object or secret string). Defense-in-depth,
not a substitute for not passing secrets. **Genuinely not implemented by design:**
Next `taint`. (Next `dynamicIO` isn't a non-goal either — it is the precursor
of Cache Components, which denext ships as the stable `cacheComponents` opt-in.)

## Security posture — accepted trade-offs

These are deliberate **safe defaults**, each with a one-line opt-in —
documented, not surprises. Full checklist in [DEPLOYMENT.md](./DEPLOYMENT.md).

- **Strict CSP by default** blocks external `<script>`/stylesheet/`<img>` until
  opted in per route (`csp: "strict" | "off" | {…}`; a route's `csp` export
  overrides). Applies to buffered **and** streamed/PPR responses.
- **HSTS is host-only by default** (no `includeSubDomains`/`preload`) so it
  can't brick non-HTTPS sibling subdomains. Strengthen via `hsts`, or
  `hsts: false`.
- **Session cookie isn't `__Host-`-locked by default** (would log everyone out
  on upgrade). Opt in with `hostPrefix: true` on `getSession`.
- **Graceful shutdown drains up to a deadline** (default 10s;
  `DENEXT_SHUTDOWN_DRAIN_MS`), then force-exits so a stuck client can't pin the
  process (plugin teardown is skipped on a forced exit).
- **Scaffolded `dev`/`build` tasks use `-A`** (they compile/spawn tooling); the
  generated `start` task runs least-privilege.
- **`@denext/og` fetches a missing non-Latin font from `fonts.googleapis.com`**
  at render time — supply a local `fonts` option, or set `offline: true` on the
  `ImageResponse` to refuse the fetch (it raises a clear error instead of
  egressing).
- **The public-env island ships only _referenced_ prefixed vars.** A key read
  via a computed expression can't be detected — force-include it via
  `publicEnv: [...]`. Never give a secret a public prefix.
- **Pages Router Preview Mode signs its cookie with `DENEXT_PREVIEW_SECRET`.**
  Set it to a long random value in production (comma-separated to rotate).
  Without it a random per-process key is used, so preview sessions don't survive
  a restart or span instances (a one-time warning fires). A forged/unsigned
  preview cookie is ignored — it never discloses drafts.
- **`<Script strategy="worker">` runs on the main thread.** denext accepts the
  prop for `next/script` parity but has no Partytown-style off-main-thread
  runtime (that needs a DOM-proxying Web Worker), so a `worker` script degrades
  to `afterInteractive` (deferred, main thread) — the script still runs
  correctly, just not off-thread. A one-time dev warning fires. Self-host
  Partytown if you need true off-main-thread execution.

## Migration: Remix runs on the `denext/remix` runtime

`denext migrate --from remix` (also auto-detected) transforms a Remix app to run on
denext with its **data model intact** — no manual loader inversion. It restructures
`app/routes/*` → `app/**/page.tsx`+`layout.tsx` (`$param` → `[param]`, `$` →
`[...splat]`, `_index` → the segment page, pathless `_x` → a `(x)` route group, dotted
nesting → folders), converts `app/root.tsx` → `app/layout.tsx` (`<Meta/>`/`<Links/>`/
`<Scripts/>` stripped, `<Outlet/>` → the layout `children`), deletes
`entry.{server,client}.*`, and **splits each route** into a client component
(`page.client.tsx`) + a server data module (`page.data.ts`) wired by a generated
`page.tsx` wrapper — because a `loader` (server) and the component (client) can't share
one `"use client"` module. `@remix-run/*` imports are remapped to the first-party
`denext/remix` runtime, which implements Remix's surface on denext primitives:
`useLoaderData`/`useActionData` (loader run server-side, data across the Flight
boundary), `<Form>`/`useSubmit` (denext Server Actions), `useNavigate`/`useLocation`/
`useSearchParams`/`useParams`/`useMatches`, `<Link>`/`<NavLink>`/`<Outlet>`, `defer`/
`<Await>`, `meta` → `generateMetadata`, and `ErrorBoundary` → `error.tsx`.

`defer`/`<Await>` streams incrementally on the default streaming Flight path: a
`defer()` promise prop no longer blocks the shell — it leaves a value-hole placeholder
so first paint flushes immediately (with the `<Await>` fallback), the deferred content
streams in as its Suspense boundary resolves, and the resolved value is substituted into
the tail Flight so hydration carries real data (never `{}`). Cross-route `fetcher.submit`
/`<Form action>` to another **page** route's `action` works too: a page route that has an
`action` gets a generated `route.ts` POST handler, so a plain POST to the page URL runs
the action (its URL params threaded from the matched pattern), and denext dispatch serves
the same segment's GET from `page.tsx`. A redirecting cross-route action is followed as a
soft navigation.

The nuances worth knowing (reported as review notes, never silently changed):

- **Deferred DATA is whole-at-end, like every denext route.** The `<Await>` _content_
  streams progressively (its Suspense boundary), and first paint is not blocked, but the
  Flight _payload_ (`#__denext_flight`) is emitted once all boundaries resolve — so a
  soft-navigation to a deferred route carries the resolved value rather than re-streaming
  the chunk. A deferred **rejection** now drives `<Await errorElement>` (via `useAsyncError`)
  on every path — the rejected value serializes to an error marker in the tail Flight.

- **`shouldRevalidate` is honored.** A route's `shouldRevalidate` genuinely skips its loader
  on a client revalidation: the client echoes the route's prior loader data + params with the
  request (in headers, or a POST body when the echo is too large for headers — so there's no
  size limit), and when `shouldRevalidate` returns `false` the server SKIPS the loader's work
  (the DB query) and renders the route from the echoed data. Always-revalidate stays the default
  (first paint, hard nav, no `shouldRevalidate`, or an explicit `true`) and is never stale.

- **`useBlocker` guards in-app navigations and browser back/forward, not a hard unload.** A
  registered blocker vetoes `<Link>`/`useNavigate`/`<Form>` navigations **and** the browser
  back/forward buttons (the popstate is undone and re-applied on `proceed()`); one active blocker,
  matching react-router. A full page reload/close is still the browser's own `beforeunload` prompt
  — add one where you need to guard a hard unload.

- **Prisma is auto-migrated to the Rust-free Deno client.** An app (Next or Remix)
  that uses Prisma is wired end-to-end: the schema generator becomes the ESM/Deno
  `prisma-client` (with `queryCompiler` + `driverAdapters` — no native engine binary),
  every `@prisma/client` import repoints at the generated client, the driver adapter is
  injected at each `new PrismaClient()`, and `deno.json` gets the `links` shim + npm pins
  - a `prisma:setup` task. Run `deno task prisma:setup` once (it bundles denext's
    `node:sqlite` compat, installs, `prisma generate`s, and `db push`es), then build/run
    normally — queries go through the better-sqlite3 driver adapter to Deno's built-in
    SQLite. Two edges: (1) only **runtime** source under `app/`/`src/`/`lib/`/… is
    rewritten — Node-only tooling that legitimately uses the native client (a `prisma/
  seed.ts`, Cypress helpers) is deliberately left untouched, so run those under Node or
    port them; (2) a `new PrismaClient(<non-object-arg>)` is flagged for a one-line manual
    adapter add (the empty and object-literal forms are wired automatically). Non-SQLite
    datasources need their own Prisma driver adapter instead of better-sqlite3.

## Not yet available

A few capabilities aren't built yet (none affects the zero-npm runtime):

- **`next/font`: metric-matched fallback face.** `next/font` self-hosts Google
  fonts at build for **both** the prod server (`deno task start`) and the static
  export (`deno task export`) — no runtime Google request either way — and honors
  `subsets`/`preload`. One piece is not yet done: the **metric-matched fallback
  `@font-face`** (Next's `adjustFontFallback` — `size-adjust`/`ascent-override` on
  a local fallback to cut CLS) needs a bundled font-metrics database to compute
  exact overrides; a guessed table would mis-size the fallback, so it's deferred
  until real metrics are bundled.

## Post-2.0 (deferred, not gaps)

Work that is **deliberately deferred past 2.0**. None of it is a surface gap —
each is either a build-time purity item, an ecosystem package, or a documented
trade-off above — so none blocks the release. One line each, with the reason:

- **`esbuild` off npm.** Build-time only (it never enters a shipped bundle, so
  the zero-npm _runtime_ claim already holds); native-backed with a large API
  surface, isolated to `src/build/next-compat.ts` — the largest of the three
  build-time codecs and the one deferred furthest. See
  [ROADMAP.md](./ROADMAP.md) → "Build-time deps → first-party JSR/WASM".
- **Node-stream `Writable` backpressure.** `renderToPipeableStream` /
  `renderToStaticNodeStream` still buffer (see the first surface-gap entry
  above): true end-to-end backpressure means making the core renderer
  pull-gated and resolving the `await allReady`-then-read deadlock the current
  eager drain avoids — an SSR-hot-path change with real regression risk and a
  narrow payoff. Use `renderToReadableStream`.
- **WASM codec finalization** (`lightningcss` / `swc` off npm). Both are
  already WASM builds with a single import site each (`src/build/css.ts`,
  `src/build/swc-ast.ts`) — a surgical repoint, teed up but **publish-gated**
  (the same status as the shipped `@denext/*` codec packages).
- **Ecosystem router plugins** (`@denext/react-router`,
  `@denext/tanstack-router`). Client/library mode works today via SPA mode
  (shell + client entry); framework mode (loaders + streaming SSR) goes through
  the settled `plugin-kit` surface, with no core change needed. Soon, not now.
- **`next/font` metric-matched fallback face** — needs a bundled font-metrics
  database (see "Not yet available" above).
