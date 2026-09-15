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
[the architecture guide](https://denext.dev/docs/architecture). Places where denext **deliberately behaves
differently** from React/Next — observable, documented, and not going to change —
are in [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md). Operational defaults live
in [the deployment guide](https://denext.dev/docs/deploy).

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
  authored element (React strips it); and `defaultProps` on a **function** component is
  honored as a compat extension (React 19 removed it) because popular npm libraries still
  rely on it.
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
  emitted as `{}` with an `opaque-schema` lint warning — and as `unknown` in the TypeScript
  `denext openapi types` emits (a recursive `$defs` reference is `unknown` at the cycle). Middleware-produced responses
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
  with introspection off, field suggestions are stripped. A query **cost budget** (`maxCost`,
  opt-in — the guard against the _multiplicative_ fan-out a depth limit misses, e.g.
  `users(first: 1000) { posts(first: 1000) }`) is available too, off by default; it runs at
  execute time so a page size passed as a variable is counted at its real value, and both the
  cost and depth walks memoize per fragment (a "fragment bomb" is analyzed in linear time). With
  Yoga `batching` on, the budget is enforced per operation, so an N-operation batch can cost up
  to N×. The schema resolves once per process: in `denext dev`, an edit to a schema module needs
  a server restart (Deno's module graph caches it).

### First-party auth (`denextAuth`)

- **No mailer.** denext never sends mail: every emailed token — email verification,
  password reset, a magic link, a one-time code — goes through your
  `sendVerificationRequest`. Inside a request the message is handed over after the response
  (`after()`, so the mailer's latency reveals nothing), which makes delivery best-effort on a
  serverless platform that freezes the isolate once the response is sent; outside a request
  it is awaited.
- **No passkeys / WebAuthn, and no `next-auth` compat shim.** A Next app that imports
  `next-auth` does not run under the drop-in; port it to `denextAuth` (both are tracked in
  [ROADMAP.md](./ROADMAP.md)).
- **`sqliteAuthAdapter` is single-node.** It is one SQLite file on Deno's built-in
  `node:sqlite` — replicas need a shared volume or your own `AuthAdapter`. Its schema evolves
  additively (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN`); there is no migration
  framework, so a column can be added but never renamed or dropped for you. TOTP secrets are
  stored in plaintext at rest by construction — TOTP verification needs the shared secret, so
  protect the database file; backup codes are stored only as `hasher` hashes.
- **The adapter contract has no delete for a password or a second factor.** Disabling TOTP
  writes an empty, unconfirmed MFA record, and a pre-account-hijacking eviction replaces the
  password with the hash of a random secret; both read as absent everywhere (optional
  `deleteCredential?` / `deleteMfa?` are on the roadmap).
- **`inMemoryAuthAdapter` keeps several live tokens per address and purpose;
  `sqliteAuthAdapter` keeps one.** In memory, a second link or code for the same address and
  purpose does not retire the first until that one is used or expires; in SQLite the newer
  one replaces it. So in SQLite, asking again cancels a link or code already in someone's
  inbox (within the send budget); in memory, every code in flight stays guessable until it
  expires.
- **TOTP is SHA-1 only, and denext renders no QR code.** `verifyTotp` and `totpAuthUri` use
  SHA-1, 6 digits and 30 seconds — the profile every authenticator app supports.
  `enrollTotp` returns the `otpauth://` URI: render it with a library of your choice, or
  show the secret for manual entry (`totpQrSvg` is planned for 2.6).
- **A GET spends a magic link**, so a mail gateway that pre-fetches links to scan them can
  burn one before the user clicks — prefer `emailOtp()` where link scanners are common.
- **A magic link redeemed by GET can sign a victim into an attacker's account** if the
  victim clicks a link the attacker requested for their own address (login CSRF — the same
  as Auth.js). Prefer `emailOtp()` where that matters.
- **Rotating `secret` invalidates the one-time codes in flight** — they are keyed under the
  current (first) secret, and live for minutes.
- **Email addresses must be ASCII.** An SMTPUTF8 local part or a non-punycode IDN domain is
  refused by the emailed flows.
- **Stateless cookie sessions survive a password reset — and a pre-account-hijacking
  eviction — until they expire.** Run a `sessionStore` (or `session.strategy: "database"`)
  so either one signs out every device. A pending second-factor session in a cookie can't be
  ended early either; it lasts 15 minutes.
- **`mfa.required: "always"` is trust-on-first-use**: a user with no factor enrolls one
  during the step-up, so whoever holds the first factor at that moment chooses the second.
- **No public helper spends the MFA attempt budget from a Server Action.** The `/mfa*`
  endpoints spend it; a Server Action that calls `verifySecondFactor` or `confirmTotp` must
  throttle itself (`examples/auth` carries its own limiter).
- **Sliding refresh only happens where a `Response` is being produced.** `session.updateAge`
  re-issues the cookie on `GET {basePath}/session`, in `requireAuth()` and in
  `requireSession()`. A bare `auth()` inside a streamed Server Component cannot set a cookie
  after the headers are flushed and deliberately does not try — call `updateAuthSession()`
  from a Server Action or route handler instead.
- **Sliding a store-backed session needs `SessionStore.update`, and never stops sliding.**
  The refresh is a write-only-if-present `update(id, session)`, so a revoke that raced the
  request cannot be undone by an upsert; a custom store that does not implement `update`
  simply never slides its sessions forward (they expire on their original schedule) and warns
  once. And there is **no absolute session ceiling** — an account in continuous use is
  extended indefinitely, so end a session with revocation or a shorter `maxAge`.
- **All five rate limiters count per node** unless you pass a shared `rateLimit.store`; the
  in-memory default is per process.
- **Account linking refuses unverified-email matches by default** (a deliberate divergence —
  see [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md)), and **an adapter does not switch
  sessions to database mode**: it is a persistence port, and `session: { strategy: "database" }`
  is what makes sessions stateful.
- **A bad emailed token lands on a different page per flow.** A wrong, spent or expired
  verification or reset token redirects to `pages.error` (else `pages.verifyRequest`, else
  `pages.afterSignIn`) with `?error=invalid_token`; a bad magic link or code goes to
  `pages.error` (else `pages.signIn`) with `?error=Verification`. Set `pages.error` to land
  both in one place.
- **Two presets carry provider constraints**: Apple is `openid`-only (name and email require
  `response_mode=form_post`, a cross-site POST callback that would arrive without the
  `SameSite=Lax` transaction cookie, so the router does not serve it — tracked in
  [ROADMAP.md](./ROADMAP.md)), and `microsoftEntra`
  requires a specific tenant — the `common` issuer is a template no discovery document can
  verify.
- **`requireBearer` takes the auth config as its first argument.** There is no ambient
  "current auth config" to read, so every call site passes the same object it passed to
  `denextAuth()`; an `activeAuthConfig()` helper that would make it optional is on the roadmap.
- **A session issued before 2.5.0-rc.3 has no `authTime`.** Enrolling a factor (the route or
  `enrollTotp()`) and minting an API token both need a recent sign-in, so such a session is
  asked to sign in again.

### Project UI (`denext ui`)

- **The compose editor owns a closed set of edits**: `image`, `restart`, `ports`,
  `environment`, `depends_on`, `volumes`, and commenting a service out or back in. A new
  service, `build`, `networks` and everything else is edited by hand; a long-syntax port or
  volume (a mapping) can be removed but not rewritten, and a flow-style field
  (`ports: ["80:80"]`) is refused. A file with anchors, aliases, merge keys, flow-style
  services, several documents (`---`) or mixed CRLF/LF line endings is **opaque** —
  read-only, with the regeneration diff.
- **Third-party plugins get no options form.** Option schemas come from the first-party
  catalog, generated from denext's own workspace, so a plugin found on JSR is added and wired
  but its options are set in `denext.config.ts`. A first-party schema expands four
  interfaces deep.
- **Code-valued plugin options are read-only.** A callback, a variable, a call, a `{}`
  schema part (a type the generator could not describe) or a function-wrapped list
  (openapi's `tags`, `securitySchemes`) renders as a read-only cell. A toggle over an option
  the config does not set is written only when it is switched on.
- **JSR search needs net permission for both `api.jsr.io` and `jsr.io`.** Without it the
  panel degrades exactly as under `--offline`; the UI checks the permission and never
  prompts.
- **`/config/next` is read-only.** denext never loads `next.config.*` at runtime, so writing to
  it would change nothing; the panel reads it in a bounded subprocess and offers to translate
  what denext honors into `denext.config.ts`.
- **`denext --help` does not list a project's own verbs, by design.** Rendering them would
  mean importing `denext.config.ts` and running every plugin `setup()`; `denext commands`
  (which the help footer points at) does that in a process that always exits, and shell
  completions still include them. The UI's Commands panel reads the same subprocess — and
  **running** a project verb from the panel pays plugin discovery again in its own child, so
  a slow `setup()` is felt on every run.

### Desktop & mobile (`denext desktop`, Capacitor)

- **`denext dev --host 0.0.0.0` serves HTML but no assets to a non-loopback client.** Every
  `/_denext/*` request (bundles, the module graph, the reload stream, the Live hub) is refused
  for a host that is neither loopback nor in `allowedDevOrigins` — the CVE-2025-48068 defense —
  and `allowedDevOrigins` has no config key, CLI flag or env var yet, only a programmatic
  `DevServerOptions` field. So a phone or a packaged desktop window pointed at a LAN dev server
  renders a dead page: **LAN / mobile dev attach is not supported yet** (tracked in
  [ROADMAP.md](./ROADMAP.md)). `denext desktop run` serves a static export over loopback, which
  is unaffected.

### Testing helpers (`denext doctor`, `probeApp`)

- **`denext doctor` / `probeApp` see a crash only as the framework's bare 500.** The
  "no-crash-marker" check matches the 500 fallback body (`Internal Server Error` and nothing
  else) and raw stack frames. A server error that a segment `error.tsx` caught and rendered
  at status 200 — the redacted message inside the boundary's own markup — is a rendered page
  to the probe. Assert on such routes yourself (a `contains` on the expected content).

### Compile-time feature flags (`feature()`)

- **DCE covers some paths, not all — but the value is always correct.** `feature("KEY")`
  (`denext/feature`) always returns the configured value: the server and every client bundle are
  seeded with `experimental.features`. **Dead-code elimination** of the untaken branch happens
  only where the build folds the call: the native App Router's **component (`.tsx`/`.jsx`)**
  modules, the whole SPA bundle, and dev. On the **compat (drop-in) App Router** path, and for
  **non-component (`.ts`) modules on the native path**, `feature()` reads the seeded value at
  runtime and the branch is **not** eliminated (correct, but no byte savings). Only a
  string-literal argument is foldable; `feature(name)` is always a runtime read. Flag names and
  their on/off states are embedded in the client bundle (like `NEXT_PUBLIC_*` env vars) — don't
  encode secrets in flag keys.

### First-party Markdown renderer (`@denext/content-collections/markdown`)

- **Deliberately a subset of CommonMark + GFM, not an engine.** It covers headings (with ids),
  paragraphs, flat ordered/unordered lists with lazy continuation, fenced code, blockquotes and
  `> [!NOTE]` callouts (multi-paragraph), GFM pipe tables, inline and reference-style links,
  emphasis and inline code — and deliberately omits **nested lists, footnotes, images, 4-space
  indented code, double-backtick code spans and raw-HTML passthrough** (raw HTML is escaped,
  never passed through). Inline code is single-backtick only, so a span that must itself
  contain a backtick has no spelling. A document that needs those is an `.mdx` entry, compiled
  at build.

## DevTools (dev-only)

denext ships its **own** in-page glass-box panel (`denext/devtools`,
Ctrl+Shift+D) as the full-fidelity surface — the six tabs and everything in them
are listed in [FEATURES.md](./FEATURES.md). Its documented boundaries:

- **Hook names are all-or-nothing per component.** The runtime walks the
  build-time metadata and the fiber's hook cells in lockstep; any mismatch — a
  conditional hook, or a custom hook the build could not follow — aborts naming
  for that component, which then shows kind labels and "names unavailable" rather
  than a plausible-looking wrong name. A custom hook expands when it is declared
  in the same module or bound by a static relative import (extensionless and
  `index` imports included), up to 3 levels of breadcrumb across modules. A hook
  imported by a bare, `npm:`/`jsr:`, URL or import-map-alias specifier, through a
  namespace import, or re-exported through a barrel still aborts naming for that
  component.
- **The "owner stack" is the render-parent chain**, an approximation of React's
  JSX-owner stack (they coincide for the common case); per-element `__source` is
  on the roadmap.
- **The bundled App Router path names route files only.** With
  `DENEXT_DEV_UNBUNDLED=0` (and for a route with an `.mdx`/`.md` page or layout,
  which always takes that path) the generated route entry carries line, column and
  hook names for the route-structural components — page, layouts, templates,
  `loading`, `error`, slot pages; an anonymous `export default` is keyed
  `#default` — but not for the components those files render, nor for a custom
  hook they import from another file. The bundled Flight entry carries none.
  `DENEXT_DEV_META=0` still turns it off, and production entries carry none. The
  default (unbundled) dev loop covers every module.
- **A `useDebugValue` label rides the row of the hook cell before the call.** It
  takes no cell of its own, so a component with no hook cells shows none, and a
  call placed between two hooks reads under the earlier one. It is dev-only,
  `format` runs only when the inspector reads it, and the MCP snapshot redacts it
  like every hook value (strings travel as `string(n)`).
- **Network, Cache and Routes — and the MCP snapshot — need the App Router dev
  server.** SPA dev serves none of those endpoints, so those tabs render a named
  "App Router only" state (the panel itself does mount in SPA dev, and its editor
  link falls back to `vscode://`).
- **The MCP snapshot is push-based, and armed lazily.** `denext_component_tree` /
  `denext_why_render` / `denext_hook_state` read the last snapshot the dev page
  posted, so they need `deno task dev` running **and** the app open in a browser,
  and an answer can be seconds stale — every answer states its age. A page that
  nobody has inspected posts nothing at all: the first tool call arms the dev
  server and the page starts pushing on its next settled commit, so that first
  call may answer "posted nothing yet" (call it again, or start the server with
  `DENEXT_DEV_INSPECT=1`). Snapshots expire after 10 minutes, a page can read only
  its own, and string values arrive redacted as `string(n)` — the characters never
  leave the browser, so a hook holding a token shows a length and nothing else.

The stock **React DevTools** extension also works — Components tree, props, live
prop/state editing, and element selection all route back through denext's
reconciler (with an honest dev/prod build type). Two residuals are inherent to
driving a non-React reconciler through the extension: its **hooks view** and its
**Profiler** rely on React-internal introspection a synthetic fiber tree can't
provide — use denext's own panel for those.

## Experimental / unstable APIs

Implemented for compatibility but tracking still-unstable upstream surfaces, so
they may change: `unstable_cache` (still `unstable_` in Next 16),
`unstable_batchedUpdates` (a no-op — see [the architecture guide](https://denext.dev/docs/architecture)),
`useMemoCache`/`c` (React Compiler runtime — the compiler hit 1.0 stable; this
is an internal helper). **Not provided:** Next 16.4 canary's navigation-stage APIs
(`unstable_navigation` / `unstable_prefetch` from `next/cache`, the "prefetch stage"
experiment) — an app importing them fails the compat build with "No matching export", which
is why the `next-app-router-playground` migration bed is pinned before the commit that
adopted them.

Residual gaps in the React 19.2 additions (the features themselves are in
[FEATURES.md](./FEATURES.md)):

- **`ViewTransition`:** only **navigation** commits are wrapped in a transition — a same-page
  state change that adds/removes/reorders a `<ViewTransition>` (React's list-reorder case) is
  not animated; each `name` must be unique among the elements live at once (two sharing a
  name make the browser skip the transition, as in React / the View Transitions API); and the
  animation needs a browser that supports the View Transitions API (a no-op elsewhere).
- **`Activity`:** a subtree that MOUNTS hidden runs its effects once during its pre-render
  (and keeps them connected while hidden) — React defers a hidden subtree's effects entirely;
  denext only tears effects down on a visible→hidden transition. A hidden subtree is also
  **not server-rendered** — it emits no SSR HTML and is client-mounted-hidden on hydration,
  rather than pre-rendered into the streamed document the way React can.
- **`taint*`:** `experimental_taintObjectReference` / `experimental_taintUniqueValue` are
  enforced in the Flight serializer (defense-in-depth, not a substitute for not passing
  secrets); Next's `taint` config is **not implemented by design**. (Next `dynamicIO` isn't a
  non-goal either — it is the precursor of Cache Components, which denext ships as the stable
  `cacheComponents` opt-in.)
- **Legacy provider context** (`childContextTypes` / `getChildContext`) is an intentional
  non-implementation — React deprecated this pre-`createContext` API, so denext won't chase
  it. Modern class context (`static contextType`) reaches parity; migrate providers to
  `createContext`.

## Migration: Remix runs on the `denext/remix` runtime

`denext migrate --from remix` ports a Remix app onto the first-party `denext/remix` runtime
with its data model intact — what it does and writes is documented in
[the Remix migration guide](https://denext.dev/docs/migrating-remix). These are the edges of that
runtime and transform (reported as review notes, never silently changed):

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

- **Prisma auto-migration has two edges.** Only **runtime** source under `app/`/`src/`/
  `lib/`/… is rewritten to the Deno client — Node-only tooling that legitimately uses the
  native client (a `prisma/seed.ts`, Cypress helpers) is deliberately left untouched, so run
  those under Node or port them; and a `new PrismaClient(<non-object-arg>)` is flagged for a
  one-line manual adapter add (the empty and object-literal forms are wired automatically).
  Non-SQLite datasources need their own Prisma driver adapter instead of better-sqlite3. The
  recipe itself is in [the database guide](https://denext.dev/docs/database).

## Not yet available

A few capabilities aren't built yet (none affects the zero-npm runtime):

- **`next/font/local`: no metric-matched fallback face.** Google fonts get Next's
  `adjustFontFallback` fallback face from a bundled metrics table (the same Capsize set Next
  ships, so the overrides are identical). A **local** font's metrics live in its file, which
  denext does not parse, so `localFont({ adjustFontFallback: "Arial" })` type-checks and
  keeps a stable class name but emits no fallback face — the stack falls straight through
  to your `fallback` list.
