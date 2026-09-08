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
[ARCHITECTURE.md](./ARCHITECTURE.md). Places where denext **deliberately behaves
differently** from React/Next — observable, documented, and not going to change —
are in [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md). Operational defaults live
in [DEPLOYMENT.md](./DEPLOYMENT.md).

## React / Next.js surface gaps

Where the compat surface genuinely differs from React/Next (mostly on the
next-compat interop path — denext's own apps are unaffected):

- **`<Script strategy="worker">` runs on the main thread.** denext accepts the
  prop for `next/script` parity but has no Partytown-style off-main-thread
  runtime (that needs a DOM-proxying Web Worker), so a `worker` script degrades
  to `afterInteractive` (deferred, main thread) — the script still runs
  correctly, just not off-thread. A one-time dev warning fires. Self-host
  Partytown if you need true off-main-thread execution.

- **`global-error.tsx` hydration is not wired on the next-compat / static-export paths.**
  global-error replaces the root layout and renders its own document, which now hydrates on the
  native `denext build` and `denext dev` paths, so `reset` and any author interactivity work
  like Next. `reset` recovers **softly** — it re-fetches the current route and swaps the
  document in place (no browser reload); because denext's global-error fires on a SERVER render
  failure, that recovery re-runs the render rather than re-rendering an in-place client tree
  (there is none), falling back to a hard reload only if the re-fetch fails. The **next-compat**
  interop and **static-export** paths emit no entry, so there global-error stays
  server-rendered only (its `reset` inert).

- **The class-component runtime is installed only when a build scan sees a class in your
  app source.** To keep it out of function-only bundles, `denext build` scans your app
  source for `Component`/`PureComponent` and installs the ~3 KB class runtime only when it
  appears (a class component must name it). An app whose class components live **only in a
  dependency** the scan doesn't read — an npm package, or a sibling workspace package — with
  the word never appearing in the app's own source, gets a function-only bundle, so rendering
  that class throws `classComponentsDisabledError` in the **production build** (it works in
  `denext dev`, which installs the runtime unconditionally). Set `classComponents: true` in
  `denext.config.ts` to force it in. Compat (next-compat) apps already drive this off the
  same config flag.

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
- **`next/head` dedupes by `key` plus the `charSet`/`viewport` singletons — not Next's
  full set.** Same-`key` `<meta>`/`<link>` collapse last-wins (also through
  `Children.map` clones), and `<meta charSet>` / `<meta name="viewport">` collapse to one
  each; `<title>` is last-wins. `<base>`/`<script>`/`<style>`/`<noscript>` inside `<Head>`
  reach the document head through the server-inserted-HTML sink (server render only; a
  client-side navigation does not update them). Unlike Next, keyless `<meta>` sharing a
  `name`/`httpEquiv`/`itemProp` and duplicate `<base>` are **not** collapsed — denext's
  collector also receives React-19-style in-tree `<meta>` that React itself never dedupes,
  so the set is kept conservative on purpose.
- **SSR attribute serialization follows ReactDOMServer for the common cases, not all.**
  `defaultValue`/`defaultChecked`, textarea/select values, the camelCase → HTML/SVG name
  map, `"true"`/`"false"` for enumerated and `aria-*`/`data-*` attributes, and CSS custom
  properties match React. Still different: an element with both `dangerouslySetInnerHTML`
  and children renders the HTML (React throws); `key` is visible on `props` of an
  authored element (React strips it); `useId` emits `:d0_0:`-style ids (React 19.1's
  `«r0»` format is CSS-selector-safe without `CSS.escape`, these are not); and
  `defaultProps` on a **function** component is honored as a compat extension (React 19
  removed it) because popular npm libraries still rely on it.
- **A few React internals are shims.** The introspection hooks `captureOwnerStack()` /
  `cacheSignal()` return `null` (rendering is unaffected — only dev tooling that reads them
  gets nothing). `addTransitionType()` is fully wired — it drives `startViewTransition({ types })`
  and `<ViewTransition>`'s per-type `enter`/`exit`/`update`/`share` class maps.

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
four documented bounds of the opt-in:

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
- **The `use cache` transform is correctness-over-coverage** — it rewrites a
  top-level function declaration or `const` arrow, but leaves forms it can't
  rewrite while preserving their binding/export semantics **untouched** (an
  object/class method, a name-referenced `export default function`). A directive
  on one of those is inert, not an error; hoist the body into a cached top-level
  function if you need it cached.

### Typed API & live data (`defineApi`, `useApi`, `defineSubscription`, `createChannel`)

- **Live push is single-instance without a configured transport.** By default the hub
  runs in-process, so `<Live>`, `useLive`, `useSubscription` re-pushes and `useApi({ tags })`
  invalidations from a `revalidateTag` reach only that instance's connections. Configure a
  `ChannelTransport` — `broadcastChannelTransport()` for Deno Deploy isolates / workers, or
  your own two-method Redis/NATS transport via `setChannelTransport` — and **both**
  `createChannel` publishes **and** tag invalidations propagate cross-instance (a
  `revalidateTag` on one instance re-pushes watchers on every instance). The default
  in-memory transport loops back to the single instance, so nothing changes for a
  single-instance deploy.
- **Channels carry no history.** A subscriber gets pushes from the moment it subscribes;
  nothing replays on reconnect (compute a cold-start value during SSR and pass it as
  `initial`). Delivery is at-most-once and latest-wins under back-pressure; `seq` (surfaced by
  `useChannel`) orders frames from one instance only. A publisher burst within 16 ms delivers
  only the last value per key — the hub coalesces publishes, independent of back-pressure — so a
  channel carries state, not a log; keep a list in a Server Action for chat-style history.
- **Channel re-authorization is lazy.** A subscriber is re-authorized on traffic once
  `authTtlSeconds` (default 300) has passed, not per push; `channel.revoke(key)` is the
  immediate path.
- **Only GET/HEAD calls batch.** A mutation, a call with custom headers or a body, or
  `batch: false` always goes as its own request.
- **`useApi({ suspense: true })` seeds hydration on Flight routes only.** Signal
  collection runs in the Flight renderers; on an isomorphic route the hook fetches on
  mount instead.
- **The production Live handshake requires a browser `Origin` header.** A non-browser
  client (Deno's stable `WebSocket`, `curl`) cannot subscribe to the production hub;
  that is the same-origin check working as intended.
- **`@denext/openapi` describes what a validator can export.** A schema with no JSON
  Schema (no Standard JSON Schema, not TypeBox, no `toJsonSchema()`, no converter) is
  emitted as `{}` with an `opaque-schema` lint warning. Middleware-produced responses
  (`requireSession` 401, `rateLimit` 429) appear only as the operation's `default`
  response — a definition cannot name them. The `scalar` / `swagger` renderers load a
  pinned bundle from a CDN (not strict-CSP clean; self-host via `cdn`); the `builtin`
  renderer is. The document and docs page are served in every mode by default (a spec of your
  own API is usually public); `expose: "dev"` restricts them to `denext dev`, `authorize` gates
  per request.
- **`@denext/graphql` subscriptions are GraphQL over SSE**, not a WebSocket — every
  GraphQL client supports it, and it is what lets them ride denext channels without a
  second socket server. `fromChannel` bypasses the channel's socket-side `authorize`
  (gate in the resolver). Query depth is capped (default 12, `maxDepth: false` to disable) and,
  with introspection off, field suggestions are stripped — but there is no query
  cost/complexity budget yet (a follow-up for stable 2.1.0). The schema resolves once per
  process: in `denext dev`, an edit to a schema module needs a server restart (Deno's module
  graph caches it).

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
is an internal helper). **`ViewTransition` honors per-element transitions across
navigations**: on every soft-nav path (Flight, isomorphic, and full-HTML — the
iso/HTML paths now await their re-injected entry so the DOM swap happens inside the
transition), the wrapper stamps real `view-transition-name` on its host child on both
sides of the swap, so a shared `name` morphs between routes; `enter`/`exit`/`update`/
`share` become `view-transition-class` (per-type maps resolve against
`addTransitionType`, which also drives `startViewTransition({ types })`), and the
route-level cross-fade still applies where the browser supports it. Residual vs React:
only **navigation** commits are wrapped in a transition — a same-page state change that
adds/removes/reorders a `<ViewTransition>` (React's list-reorder case) is not animated —
each `name` must be unique among the elements live at once (two sharing a name make the
browser skip the transition, as in React / the View Transitions API), and the animation
itself needs a browser that supports the View Transitions API (it is a no-op elsewhere). **`Activity` does real offscreen scheduling** —
`mode="hidden"` keeps the subtree mounted-but-hidden (`display:none !important`), preserves its
state, and tears down its effects, so `mode="visible"` restores the same instances; a
subtree that mounts hidden is pre-rendered at transition priority. One residual gap vs
React: a subtree that MOUNTS hidden runs its effects once during that pre-render (and
keeps them connected while hidden) — React defers a hidden subtree's effects entirely;
denext only tears effects down on a visible→hidden transition, not a hidden mount.
A second residual: a hidden `<Activity>` subtree is **not server-rendered** — it emits no
SSR HTML and is client-mounted-hidden on hydration (so its state/effects behave as above),
rather than being pre-rendered into the streamed document the way React can.
**React `taint*` is implemented**:
`experimental_taintObjectReference` / `experimental_taintUniqueValue` mark a value
that must never cross the server→client boundary, enforced in the Flight serializer
(it throws rather than serialize a tainted object or secret string). Defense-in-depth,
not a substitute for not passing secrets. **Genuinely not implemented by design:**
Next `taint`. (Next `dynamicIO` isn't a non-goal either — it is the precursor
of Cache Components, which denext ships as the stable `cacheComponents` opt-in.)

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

- **`getLoadContext` values read from the Express request/response are stubs.** `denext migrate`
  ports a custom server's `getLoadContext` to `load-context.ts`: `serverBuild` becomes denext's
  synthesized Remix `ServerBuild` (`remixServerBuild()`) and `cspNonce` is `undefined` (denext's CSP
  is hash-based — there is no per-request nonce); any other key (`req.ip`, a per-request handle the
  server created) is a `TODO` stub carrying the original expression — fill it in from the request
  `defineLoadContext` hands you. The synthesized build is flat: every route's `path` is its full
  pattern under `root`, which is what `parentId` composition yields, but code that walks the real
  nesting sees one level.

- **`useBlocker` guards in-app navigations and browser back/forward, not a hard unload.** A
  registered blocker vetoes `<Link>`/`useNavigate`/`<Form>` navigations **and** the browser
  back/forward buttons (the popstate is undone and re-applied on `proceed()`); one active blocker,
  matching react-router. A full page reload/close is still the browser's own `beforeunload` prompt
  — add one where you need to guard a hard unload.

- **React Router v7 (`@denext/react-router`): server rendering only.** `clientLoader` /
  `clientAction` / `HydrateFallback` are not run — loaders/actions run on the server;
  `react-router.config.ts` `ssr: false` (RR's SPA mode) and `prerender` are not applied (use
  denext's `mode: "spa"`, and denext prerenders static routes itself); route `+types` typegen is
  type-only, so the app runs without it.

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

- **`@denext/content-collections`: no built-in Markdown/MDX renderer yet.** Collections are a
  typed, validated, queryable **data** layer: an entry's `body` is the raw MD/MDX source, which
  you render with your own MDX setup (`@denext/denext/build/next-compat` `compileMdxSource`) or a
  Markdown renderer. A first-party render helper is planned. Two v1 notes: the built store is read
  from `<cwd>/.denext/content-data.json`, so run the app from its project root (as `deno task
  dev`/`start` do); and unquoted YAML frontmatter dates parse as `Date` (quote them, or use a date
  schema).
