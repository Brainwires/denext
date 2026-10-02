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

- **A root layout's `<html>`/`<body>` rendered by CLIENT code is re-created on hydration.**
  denext owns the real document tags and nests a layout's `<html>`/`<head>`/`<body>` inside
  its page container, where the browser's parser drops them. A Server Component layout is
  handled: the server's Flight tree leaves the three tags out, so hydration adopts the
  server DOM, and their attributes (`lang`, `dir`, `className`…) are moved onto the real
  tags. When the layout is rendered in the browser instead — a `"use client"` root layout, or
  a route without a client boundary that re-renders its whole tree from its own bundle — the
  client tree still contains the tags, hydration mismatches at `<html>`, and the page DOM is
  re-created once (silently in production). Keep the root layout a Server Component, or
  render only the in-body chrome and let denext supply the document tags.

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
  identity scoping with `asyncContext`.** React scopes
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
  `await`; enable `asyncContext: true` in `denext.config.ts` and priority is scoped
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
- **SSR attribute serialization follows ReactDOMServer's tables (2.8.1), with a few
  differences.** Boolean props (`disabled=""`), the camelCase → HTML/SVG name map
  (`tabindex`, `crossorigin`, `stroke-width`, …), `"true"`/`"false"` for enumerated and
  `aria-*`/`data-*` attributes, the dropped empty `src`/`href` (kept on `<a href="">`),
  invalid `cols`/`rows`/`size`/`span`, `defaultValue`/`defaultChecked` (on `<input>` only),
  textarea/select values, inline styles and CSS custom properties match React. Still
  different:
  - `true` on an attribute React doesn't know renders `name=""` (React drops it, keeping
    only `data-*`/`aria-*`), matching what the client reconciler sets;
  - `autoCapitalize={true}` renders `autoCapitalize="true"` (React drops it);
  - `'` in text and attribute values is escaped as `&#39;` (React writes `&#x27;` — the same
    character to every parser, but a byte-for-byte snapshot differs);
  - an element with both `dangerouslySetInnerHTML` and children renders the HTML (React
    throws);
  - `key` is visible on `props` of an authored element (React strips it);
  - `defaultProps` on a **function** component is honored as a compat extension (React 19
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

### Boundary diagnostics (dropped function props, server-only leaks)

- **The dropped-function warning covers what the renderer can attribute.** A `"use client"`
  component's props warn on every Flight renderer; a host element's `onClick` in a Server
  Component warns on the streaming and PPR renderers, which know whether they are inside an
  island. Under streaming, an island's own Suspense content that resolves after the island
  finished is attributed to the server, so a handler it renders may warn spuriously (dev only).
- **The server-only leak check reads the bundle where one is produced** (`denext build`,
  `denext export`, the bundled dev path: the source map's shipped modules, so a helper that
  tree-shaking removed is not a leak). The unbundled per-module dev loop (the default
  `denext dev`) never bundles, so it checks the route's import graph instead — every local
  module counts, only `"use server"` modules are exempt — and only for a route the build would
  hydrate; a route the build ships without JavaScript is never checked there.
- **`denext/no-handlers-in-async` resolves module-local bindings only.** An imported handler
  or a prop-passed one is not flagged (it may be a server action), and a function inside a
  string or a non-`on*` prop is out of scope.

### Cache Components (`use cache` + PPR)

A stable, **opt-in** feature: enable it with top-level `cacheComponents: true`
in `denext.config.ts` (the pre-2.0 `experimental.cacheComponents` still works
and dev-warns to move — as does every other `experimental.*` key, all of which
graduated to top-level fields by 2.5). Off, `use cache` is inert and the render path is
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
- **An adapter without `deleteCredential` / `deleteMfa` overwrites instead of deleting.**
  Disabling TOTP then writes an empty, unconfirmed MFA record, and a pre-account-hijacking
  eviction replaces the password with the hash of a random secret; both read as absent
  everywhere. Both first-party adapters implement the deletes.
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
- **An email address's local part must be ASCII.** The emailed flows refuse an SMTPUTF8 local
  part; an internationalised domain is accepted and used in its punycode form.
- **Stateless cookie sessions survive a password reset — and a pre-account-hijacking
  eviction — until they expire.** Run a `sessionStore` (or `session.strategy: "database"`)
  so either one signs out every device. A pending second-factor session in a cookie can't be
  ended early either; it lasts 15 minutes.
- **`mfa.required: "always"` is trust-on-first-use**: a user with no factor enrolls one
  during the step-up, so whoever holds the first factor at that moment chooses the second.
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
- **Two presets carry provider constraints**: the web `apple()` provider is `openid`-only (name and email require
  `response_mode=form_post`, a cross-site POST callback that would arrive without the
  `SameSite=Lax` transaction cookie, so the router does not serve it — tracked in
  [ROADMAP.md](./ROADMAP.md)), and `microsoftEntra`
  requires a specific tenant — the `common` issuer is a template no discovery document can
  verify.
- **A session issued before 2.5.0-rc.3 has no `authTime`.** Enrolling a factor (the route or
  `enrollTotp()`) and minting an API token both need a recent sign-in, so such a session is
  asked to sign in again.
- **Native session mode (`native`) has edges of its own.** A user with a second factor can't
  use a native Apple / Google `id_token` sign-in (`403 mfa_required`; the browser flow runs
  the step-up). Two concurrent refreshes with one refresh token revoke the family (the loser
  reads as a replay) unless `native.refreshReuseInterval` sets a grace window —
  `nativeSession()` is single-flight, a hand-rolled client must be too.
  A custom-scheme redirect URI can be registered by another app; PKCE stops it redeeming an
  intercepted code, a claimed `https://` URI stops it receiving one. See
  [App backend](https://denext.dev/docs/app-backend#limitations).
- **Deleting an account can't end stateless cookie sessions on other devices**, and Apple
  token revocation needs the client-secret JWT (`native.apple.clientSecret`, minted from your
  `.p8` key by you); without it deletion proceeds and reports `appleRevoked: false`.
- **The `cors` config covers route handlers and the native auth endpoints only** — not pages,
  Server Actions, the `/_denext/api-batch` endpoint or Live. The native auth endpoints answer
  their preflights after `middleware.ts`, so a middleware guard must let `OPTIONS` under
  `/auth` through.

### Project UI (`denext ui`)

- **The compose editor owns a closed set of edits**:
  - adding and removing a service;
  - `image`, `restart` and `build` (a context path, or a mapping's `context`, `dockerfile`,
    `target` and `args`);
  - `ports` and `volumes`, a long-syntax entry key by key;
  - `environment`;
  - `depends_on`, with each dependency's `condition`;
  - `networks`;
  - commenting a service out or back in;
  - the top-level named volumes and networks.

  Every other service field (`command`, `healthcheck`, `labels`, `env_file`, `deploy` and the
  rest of the Compose specification) is edited by hand, as is a long-syntax key the form
  doesn't know (a volume's `bind:` options, say). A file holding several YAML documents is
  **opaque**: it is read-only, with the reason and the regeneration diff.
- **A field a service takes from a merge key (`<<`) can be overridden but not deleted.**
  Setting it writes an override into the service. Removing it would need Compose's `!reset`
  tag, which the editor does not write.
- **A third-party plugin's options form needs a published schema.** A JSR plugin gets one
  only if its package publishes `denext.catalog.optionsSchema` in its `deno.json` (or
  `jsr.json`). The UI reads it from `jsr.io` for the version `deno.lock` resolved — so not
  under `--offline` — and keeps only the keys the form reads. A first-party schema is
  generated from the package's types and expands four interfaces deep.
- **Code-valued plugin options are read-only.** A callback, a variable, a call, a `{}`
  schema part (a type the generator could not describe, like the values of openapi's
  `securitySchemes`) or a function-wrapped list (openapi's `tags`) renders as a read-only cell.
- **JSR search and adding a JSR package each need net permission for their host** —
  `api.jsr.io` to search, `jsr.io` to read a package's metadata. Without it that half of the
  panel degrades as under `--offline`; the UI only checks the permission, never prompts.

### Desktop & mobile (`denext desktop`, Capacitor)

- **The dev assets answer only hosts you opted in.** Every `/_denext/*` request (bundles, the
  module graph, the reload stream, the Live hub) is refused for a `Host` that is neither
  loopback nor in `allowedDevOrigins` — the CVE-2025-48068 defense. `denext dev --lan`, an
  explicit `--host`, `--allowed-dev-origin` and the `allowedDevOrigins` config key opt a host
  in; a device reaching the dev server by any other name (a second NIC's address, a DNS name
  you did not list) still gets a dead page. `--lan` binds only the LAN address, so
  `http://localhost` does not answer while it is on. Wildcard entries are not supported.
- **`denext desktop dev` runs the window under the `deno` CLI only.** A packaged app ignores
  `DENEXT_DESKTOP_DEV_URL`, the target must be a loopback `http:` URL unless `--lan` opts in, and
  with `--lan` the per-launch desktop token is not injected, so token-gated desktop features
  (`openAuthSession`'s loopback sheet, the updater boot beacon) are refused in that mode.
- **`denext mobile dev` edits `capacitor.config.*` (and, for iOS, `ios/App/App/Info.plist`)
  for the session.** Both are restored on every exit path Deno can observe; a `SIGKILL` or power
  loss leaves the edits and a backup in `.denext/`, restored by the next `mobile dev` or
  `mobile dev --restore`, so check before a release build after a crash. A config whose exported
  object is built by a function call it cannot see into (`export default makeConfig()`) is
  refused. The Info.plist keys are a native change, so the first session needs a rebuild from
  Xcode.
- **`denext mobile dev` on Android relies on `usesCleartextTraffic`.** An app that declares its
  own `android:networkSecurityConfig` overrides it on Android 7+ (API 24+), and the device may
  refuse the dev server's plain `http`; `mobile dev` warns, and the fix is a
  `<domain-config cleartextTrafficPermitted="true">` for the dev host (or an `https` dev
  server). The Android half of `mobile dev` has not been run on a device.
- **Android is compiled, not device-tested.** Every Android half of `denext/mobile`, the
  `denext mobile add` generators and React Native mode's shell-backed APIs is unit-tested and
  builds with Gradle, but none has run on an Android device (the iOS halves were run on an
  iPhone; see [REACT-NATIVE-EXPO.md](./REACT-NATIVE-EXPO.md) for exactly which). Android-only
  features (the back button and predictive back, process-death restore, `ToastAndroid`'s system
  toast, in-app updates) have not run anywhere. Android performance is measured on an emulator
  only: a whole-app comparison (T3 Code's Capacitor build against its React Native build, gap 5
  there) found Capacitor starting faster and using less memory, and React Native scrolling a
  long list more smoothly. There are no real-device Android numbers yet.
- **Android push needs `google-services.json`.** `@capacitor/push-notifications` registers with
  FCM through Firebase, so without `android/app/google-services.json` (from your Firebase
  project) registration fails; `denext mobile add push` only warns that it is missing. There is
  no web push fallback, and denext ships no push relay: your server sends through APNs / FCM.
- **App extensions need a paid Apple Developer team and some Xcode steps.** The App Group the
  share extension, widgets and Live Activities share (`--app-group`) must exist in the developer
  account, and a Personal Team cannot sign App Groups or push. When a capability writes a new
  `App.entitlements` and the App target does not yet point at one, selecting it in Xcode is a
  printed manual step.
- **Live Activities are iOS only.** `startLiveActivity` and the other Live Activity functions
  reject with code `unsupported` on Android and the web; push-to-start tokens need iOS 17.2+ and
  resolve `null` below it.
- **`secureStore` is not secret on the web.** It uses the Keychain / Keystore in the shell, the
  OS keychain in a Deno Desktop window with the `secure-store` capability (`denext desktop add
  secure-store`; macOS `security`, Linux libsecret, Windows WinRT PasswordVault — the Windows
  backend is verified by the Windows CI round-trip), and a plain IndexedDB database in a browser
  (or a desktop window without that capability, where it is also wiped on relaunch).
- **On macOS, other programs of the same user can read Deno Desktop `secureStore` items.** The
  items are written by `/usr/bin/security`, so their Keychain access list trusts that tool, and
  any process running as the user can read them with `security find-generic-password` without a
  prompt. The secret never appears in a process listing (it is sent to `security -i` on stdin).
- **Passkeys (WebAuthn) do not run in the iOS Capacitor WebView.** The page's origin is
  `capacitor://localhost`, which WebKit does not accept for WebAuthn, so
  `navigator.credentials` passkey ceremonies fail there. Run a passkey sign-in on the provider's
  own `https` page through `openAuthSession`.
- **On Windows and Linux, the Deno Desktop auth session cannot see the browser tab close.** The
  OS has no auth session of its own (macOS's `ASWebAuthenticationSession` reports `cancelled`),
  so `openAuthSession` opens the system browser, and closing its tab sends nothing back. denext
  shows the page a Cancel overlay meanwhile (`cancelOverlay`), and `timeoutMs` stays the backstop.
  The same holds for the loopback flow on every OS. On macOS the sheet cannot be closed from code,
  so a page cancel or a timeout leaves it open until the user closes it.
- **The Deno Desktop self-updater replaces the UI, not the app.** `denext/desktop/updater`
  verifies and overlays a signed UI export in the app-support directory; the executable and
  the runtime are updated only by shipping a new build. Every manifest must be signed.
- **Native context menus need `denext mobile add context-menu`, and iOS's lifted preview needs
  a bound element.** Without the plugin the menu is an accessible popover in the WebView. With
  it, the long-press menu with the lifted preview is `useContextMenu` / `attachContextMenu` (the
  system `UIContextMenuInteraction`, armed per press); `showContextMenu(items, { x, y })` from
  code has no element to lift, so iOS presents its `UIMenu` through the edit-menu presentation
  (iOS 16+; an action sheet on iOS 15). Android's `PopupMenu` lists submenus as labelled groups
  and draws no icons or menu title. A Deno Desktop window's native menu (the `context-menu`
  capability, denext's pinned runtime) nests submenus but draws no destructive style, glyph or SF
  Symbol icon, and shows a `title` as a disabled first item; under the stock runtime it is the
  in-page popover.
- **Over-the-air UI downgrade protection starts with the first sequenced release.** A signed
  manifest carries a `sequence` (v2), and a device refuses one older than the highest it has
  accepted (code `downgrade`), and the `minNative` gate refuses a UI that needs a newer app build
  (code `native_too_old`). A device that has never accepted a sequenced manifest (one updated only
  by denext ≤ 2.8 releases) still installs an older v1-signed UI. Without an embedded public key,
  TLS is the only protection (plain `http` is refused beyond loopback), and with one, plain `http`
  still exposes the request headers and files. The public key lives in the app binary, so
  rotating it (or recovering from a leaked private key) takes an app release. The Android
  template is compiled against Capacitor 8.5 by hand, not in CI; the iOS one is build-checked
  with `xcodebuild`.
- **The native fingerprint gate needs both sides, and binaries from before it refuse with the
  wrong code.** `denext mobile fingerprint --write` embeds the fingerprint and
  `denext ota manifest --native-fingerprint` stamps it; the `native_mismatch` check runs only
  when the binary and the manifest both carry one. A binary whose OTA plugin predates it
  (template generation 3, denext ≤ 2.10.0-rc.2) refuses a signed manifest with a fingerprint as
  `signature` (it verifies the v2 payload; v3 adds the fingerprint), and ignores the fingerprint
  of an unsigned one. The fingerprint hashes the committed native sources, so a version or build
  number committed there (`CURRENT_PROJECT_VERSION`, `versionCode`) counts as a native change: set
  them on the build command line. It reads installed plugin versions from `node_modules`, so
  fingerprint after installing packages. It cannot see native code that reaches the build from
  outside `ios/`, `android/` and the Capacitor plugins `package.json` declares (a CocoaPods or
  Gradle dependency pulled by a version range, an Xcode build setting passed by a script).
- **Downloaded OTA files are verified once, when they arrive.** The native plugin does not re-hash
  a version's files at each launch (that would cost every cold start), so a file changed in the
  app's data directory afterwards (a jailbroken or rooted device, or a debug build) is served as
  is.
- **An iOS web content process that dies during an OTA trial is reloaded by Capacitor, not by
  the plugin.** `CAPBridgeViewController.loadView()` is final, so the plugin cannot take over
  `webViewWebContentProcessDidTerminate` without replacing Capacitor's navigation delegate; if
  Capacitor's `reload()` leaves the trial UI blank, the boot watchdog rolls it back. On Android a
  renderer crash ends the app process (Capacitor does not handle `onRenderProcessGone`), and the
  next launch counts it as one of the trial's two attempts.
- **Configurable widgets are iOS 17+ only; Android widgets are static.** `denext mobile add widget
  --configurable` generates an App Intents configuration, which WidgetKit offers from iOS 17. On
  iOS 14–16 the same widget is a static one (kind `<Name>.static`) that shows the snapshot stored
  for the parameters' defaults; it lists no family on iOS 17, so one placed before an OS upgrade
  is not carried over to the configurable kind. Android has no configure activity: its widget
  shows the snapshot `setWidgetData` stores without `params`. Only enum parameters are supported,
  and a configured widget whose values have no snapshot of their own shows the unparameterised
  one.
- **The `expo-widgets` shim renders the generated SwiftUI, not the `"widget"` layout function.**
  Props become the widget's JSON snapshot or the Live Activity's state; `updateTimeline` stores
  only the entry that applies now; `LiveActivityFactory.start` returns before ActivityKit has an
  id (`getId()` is `""` until then); a start URL, stale dates and widget interaction events are
  not supported.
- **JavaScript does not run in the page in the background.** The OS suspends the WebView when
  the app leaves the foreground: timers stop, and WebSockets and Live subscriptions drop and
  reconnect on resume. `defineBackgroundTask` runs in Capacitor's Background Runner, a separate
  runtime with no DOM and no app state (about 30 s on iOS, scheduled by the OS). There is no
  background audio or lock-screen media control yet.
- **A silent (data) push reaches your JavaScript only while the app is running.** iOS throttles
  background pushes and does not wake the WebView for them; update a widget or Live Activity
  with a push-to-start or Live Activity push instead.
- **No native UI on watches, in cars or in App Clips.** watchOS / Wear OS UIs are native
  (SwiftUI / Compose), CarPlay and Android Auto take template UIs only, and an App Clip has a
  tight size budget; denext renders in a WebView.
- **Certificate pinning does not cover the WebView's own `fetch` / XHR.** Neither WKWebView nor
  Android WebView exposes a pinning hook for page requests; pinning plugins pin only requests
  sent through `CapacitorHttp`.
- **Service workers do not run on iOS's `capacitor://` origin.** Cache API data for offline use
  in SQLite or Preferences, unless the app is served from `https` with `WKAppBoundDomains`.
- **JavaScript-driven motion runs at 60 Hz on ProMotion iPhones.** WKWebView caps
  `requestAnimationFrame` at 60 Hz on 120 Hz displays
  ([WebKit bug 294338](https://bugs.webkit.org/show_bug.cgi?id=294338)); CSS and Web Animations
  and native scrolling run at the display's rate. Anything JavaScript moves frame by frame (a
  gesture-driven drag, Reanimated worklets, rows mounting during a fast fling) updates at half
  the rate React Native reaches there. Unlocking it needs a private WebKit setting, an App
  Review risk denext does not take. denext's smoothness checks ran on a 60 Hz iPhone 16e;
  nothing has been measured on a 120 Hz display.
- **Android WebView versions vary.** The WebView is a separately updated system app, so the
  engine is whatever the device has: current on Play-updated phones, older on devices without
  Play updates (some OEM, China-market and enterprise builds). Web features and bugs follow the
  device's version (for example, `env(safe-area-inset-*)` is wrong below WebView 140;
  `useSafeAreaInsets` reads the shell's insets instead). Only an emulator with WebView 124 has
  been measured.
- **Interactive keyboard dismissal is limited.** The swipe-down dismiss that tracks the keyboard
  (iMessage-style) is at best available to the WebView's outer scroller; inner scroll
  containers cannot drive it.
- **Screen readers follow the WebView's DOM accessibility tree.** `denext/navigation`'s stacks,
  tabs and React Native mode's navigators announce a screen change through an `aria-live`
  region, but focus is not moved to the new screen (a screen reader keeps its place in the
  page), plain App Router navigations outside them are not announced, and WKWebView may move
  VoiceOver focus to the top of the page on a full load. Whether VoiceOver / TalkBack is on, and
  the OS text size (Dynamic Type, Android's font scale), reach the page only through `denext
  mobile add accessibility`; the text size applies to a page only through `applyFontScale()`
  (or React Native mode's `Text`), and on Android `allowFontScaling={false}` cannot undo the
  WebView's own text zoom.
- **WebView storage is evictable; durable storage needs `denext mobile add storage`.** iOS and
  Android may clear a WebView's `localStorage` and IndexedDB under storage pressure.
  `openKeyValueStore` (and React Native mode's AsyncStorage / MMKV) write to the app's data folder
  only with the `DenextStorage` plugin (or an installed `@capacitor-community/sqlite`); without
  either they fall back to IndexedDB and warn. `denext mobile doctor` flags app code that keeps
  data in web storage itself. The store is not encrypted (secrets go in `secureStore`), and on
  Android a single value above about 2 MB cannot be read back (SQLite's cursor window), as with
  React Native's AsyncStorage. The iOS plugin has run on an iPhone (AsyncStorage data kept
  across launches in `examples/expo-app`); the Android one is compiled, not run on a device.
- **No install attribution or deferred deep links.** Firebase Dynamic Links shut down on
  2025-08-25; use an attribution SDK (Branch, AppsFlyer, Adjust).
- **An OTA update cannot change what the app is.** Apple allows over-the-air updates to
  interpreted code that keep the app's purpose (DPLA 3.3.1(B), guideline 2.5.2); new native
  capabilities, permissions or payment flows need a store build. The `minNative` and fingerprint
  gates enforce the native half, not the policy half.
- **No hosted services.** There is no Expo Go-style prebuilt client, no hosted push service, no
  hosted build or submit service and no hosted OTA CDN: denext provides the pieces
  (`createPushSender`, the CI recipe, `createOtaHandler`) for your own infrastructure.
- **An export is minified, not obfuscated, and client-side jailbreak or root detection is
  advisory.** Anything in `out/` can be read from the app package; keep secrets and
  authorization on the server.
- **Enterprise MDM (managed app configuration) is not wrapped.** Use a community plugin.
- **`NativeViewSlot` tracks some layout changes a frame late.** On iOS a scroll is followed
  natively in the same frame (the plugin observes the WebKit scroll view the slot scrolls with).
  On Android only the document's scroll is: a slot inside a scrolling element (a `VirtualList`)
  is moved from the page's per-frame measurement and trails it by a frame or two during a
  fling. Everywhere, a change that is not a scroll (a CSS transform or animation on an
  ancestor, a resize, content inserted above) reaches `"under"` / `"over"` views a frame late,
  or within 250 ms when no event announces it. A transformed ancestor is followed only as the
  rect it produces (a rotation or skew is drawn as its bounding box). A clip other than an
  `overflow` / `contain: paint` box (`clip-path`, a rounded `border-radius` corner, `mask`) is
  not applied. An `"over"` view hides whole while page content covers any part of it (occlusion
  is sampled at five points, so a cover smaller than the gaps between them is missed).
  `"under"` needs every ancestor transparent over the slot. `"embed"` (iOS) depends on WebKit
  backing the slot's `overflow: scroll` element with a native scroll view (as
  `@capacitor/google-maps` does); if it does not within 2 s the view falls back to `"over"`.
  UIKit controls inside an `"embed"` view (buttons, sliders) do not complete a tap there, since
  the touch belongs to WebKit's scroll view: gesture-driven views (a map's pan, pinch and markers)
  work, which is why the built-in `video` is drawn `"under"` by default. Give your own view type
  with controls `placement="under"` (or `"over"`). An `"over"` view near the edge of a scrolling
  list can flicker on iOS: the page's occlusion samples intermittently report it covered there
  (the cause is not yet known), and an `"over"` view hides while covered; `"under"` does not hide
  on occlusion (the page paints over it), so it is the placement to use.
  A slot a virtualized list unmounts destroys its view (a map loses its position; a video
  restarts). Android's `scrollPassthrough` (a drag past the touch slop along the axis is handed
  to the WebView from its start) is compile-verified, not yet run on an Android device, like the
  rest of the Android plugin (compiled, not run on a device or emulator).

- **Run the JSR CLI with `--node-modules-dir=none` inside a Node workspace.** In a folder under a
  `package.json`, Deno resolves `npm:` imports from `node_modules` (its manual mode), so
  `deno run -A jsr:@denext/denext/cli …` fails on denext's own `npm:esbuild` import before any
  denext code runs; next to a `pnpm-workspace.yaml`, Deno 2.9.7 then also migrates that file's
  `packages` / `catalog` into the root `package.json` as `workspaces` / `catalog`. denext cannot
  intercept either (both happen while Deno loads the module graph), so pass
  `--node-modules-dir=none` (or `--no-config`) there.

### Deno Desktop capabilities (`denext desktop add`, `denext/desktop/client`)

- **Browser storage survives a relaunch only with a stable app origin.** With
  `desktop.app.origin` and `desktop.app.identifier` set, denext's pinned Deno Desktop runtime
  serves the page at that origin and keys web storage by the identifier, so `localStorage`
  persists across launches (checked in packaged webview-backend apps on macOS, Linux and
  Windows; IndexedDB, OPFS and the Cache API share the same store but were not checked one by
  one). Without an origin, or under `DENEXT_DESKTOP_RUNTIME=stock`, the runtime binds a new
  loopback port each launch (denoland/deno#35444), so the page's origin changes and browser
  storage starts empty. `secureStore`, the file functions and `openSqlite` persist only with
  their desktop capability enabled (`secure-store`, `fs`, `sqlite`); without it they fall back to
  browser storage and warn once.
- **The pinned Deno Desktop runtime needs Deno 2.9.7 exactly, and packages Windows only on
  Windows.** `deno desktop` embeds the runtime, so another Deno version stops the build
  (`deno upgrade --version 2.9.7`). Deno 2.9.7's CLI looks a prebuilt backend up with the
  host's executable suffix, so a Windows bundle can't be built from macOS or Linux (nor a Linux
  one from Windows) on the pinned runtime; `DENEXT_DESKTOP_RUNTIME=stock` cross-builds with the
  stock runtime. There is no pinned Windows arm64 build.
- **The stock runtime keeps the web paths.** Under `DENEXT_DESKTOP_RUNTIME=stock`,
  `context-menu`, `notifications`, `clipboard`, `global-shortcuts` and `launch-at-login` answer
  `unavailable`: `showContextMenu` is the in-page popover, notifications are the WebView's
  Notification API (immediate only, no click routing), the clipboard is the WebView's
  `navigator.clipboard` (text only), and the shortcut and login calls reject. `dialogs` drives
  the OS dialog programs (osascript / PowerShell / zenity or kdialog) instead of the runtime's
  native panels, and application-menu accelerators fire only where the stock runtime binds them.
- **The desktop capabilities are unit-tested, not window-tested.** Each runtime capability is
  tested against the bridge contract, with its OS commands through an injected runner. A real
  `deno desktop` build with the derived flags launched and served its bundle on macOS; the
  capabilities themselves, and the Linux and Windows backends (libsecret, zenity / kdialog,
  PowerShell dialogs, `SetThreadExecutionState`), have no recorded run in a real window.
- **Read and env stay broad in a packaged app.** The package scripts derive `--allow-*` from
  `desktop.capabilities` instead of `-A`, but the baseline keeps `--allow-read` and
  `--allow-env` unscoped (the served bundle and the per-user app-support folder are only known
  at run time), and any capability that writes adds an unscoped `--allow-write`; the runtime
  capabilities confine file access. An extension's own permissions are not derived: grant them in
  `desktop.extraPermissions`, which the package scripts bake in.
- **The bridge token is readable by any script in the page.** The per-launch token lives in the
  top-level document (never in frames), so script injected into the page (an XSS) can use every
  capability the app enabled. Keep the strict CSP, enable only the capabilities you use, and
  treat `dialogs`, `shell`, `secure-store` and `keep-awake` as trusting the page with that power.
- **A path the user picks needs an unscoped file permission.** Deno Desktop bakes permissions at
  build time, and a path chosen in a dialog is known only at run time, so `dialogs` implies
  `--allow-read` and `--allow-write` without a list. The runtime narrows file access to the app's
  folders and the paths picked this session; other code in the Deno process is not narrowed.
- **FFI and spawned programs are full trust.** `secure-store` runs the OS credential tool
  (`security` / `secret-tool`), `shell` and `keep-awake` run OS tools (`open` / `xdg-open` /
  `explorer`, `caffeinate` / `systemd-inhibit`; `keep-awake` is FFI on Windows): each can do
  anything the user can. Node-API (`.node`) addons do not load in
  desktop builds on Linux and Windows (denoland/deno#36596); use FFI or a sidecar. FFI cannot
  touch windows or AppKit / Win32 UI, because the runtime is not on the main thread.
- **Desktop notifications per OS.** Linux has no notification scheduler: the app delivers a
  scheduled notification while it runs and shows one whose time passed while it was closed at the
  next launch, and a click on a notification after the app quit does not start it. A repeating
  notification is scheduled for its next 16 occurrences and topped up whenever the app runs, so an
  app not opened for longer stops showing it until it runs again. macOS asks for the permission
  once, and only an app bundle has notifications. Action buttons carry a title only (no text input, destructive or
  authentication option), there are no channels, and a notification stores at most 4 KiB of
  `data`.
- **Global shortcuts on Wayland need the XDG GlobalShortcuts portal.** The desktop asks the user
  to approve each shortcut and may bind another trigger (`userBinds` in `shortcutCapabilities()`);
  without the portal `registerShortcut` rejects `unsupported`. On macOS 13+ `setLaunchAtLogin`
  may answer `requires-approval` until the user allows the app in System Settings › Login Items.
- **Menu limits per backend.** The CEF backend draws no menu icons or tooltips in its application
  menu (Windows, Linux) or Linux context menus, and binds no `Super` accelerator on Windows; menu
  tooltips show on macOS and Linux only. The Dock menu (`setQuickActions`) is macOS only, and a
  Linux badge is a prefix of the window title.
- **Not on desktop:** the share sheet, Handoff, Spotlight, the Touch Bar, passkeys in the webview
  (its loopback IP origin is not a valid relying party; use `openAuthSession`), and deep links or open-file events reaching an
  already-running macOS app. The window API (`denext/desktop/window`), file drag and drop, the
  `hiddenInset` title bar, Mica / Acrylic and vibrancy need denext's pinned runtime; the stock
  runtime keeps only size, position, title and visibility.
- **Window API limits per OS.** Title bar styles and the traffic-light position are macOS only;
  Mica, Acrylic and tabbed are Windows 11 (Acrylic and tabbed 22H2), and the CEF backend has no
  backdrops; Wayland cannot move a window (`setWindowPosition`, and so the page-driven drag
  region, do nothing there). `app-region: drag` is native only on the CEF backend; on the system
  WebView backends `makeWindowDraggable` moves the window from the pointer through the bridge.
  `onCloseRequested` cannot hold a quit from the macOS app menu (Cmd+Q), and a page that never
  answers a close request loses its hold after 5 seconds. On Windows' WebView2 a drag reveals
  the dropped paths only on the drop.
- **Deno Desktop's own limits.** The UI is a web page in WKWebView, WebView2 or WebKitGTK, so it
  renders per OS (unless built with `--backend cef`, about 150 MB larger); there is no Mac App
  Store, Microsoft Store (MSIX), Flatpak or Snap build; the self-updater replaces the UI only.
  Deno Desktop itself is experimental in Deno 2.9, and a bug in it reaches denext apps until
  denext's pinned runtime fixes it. DevTools are off in a packaged app unless
  `desktop.inspectable: true`; under the stock runtime `desktop.inspectable` has no effect.
- **`react-native-windows` / `react-native-macos` are not native here.** A `reactNative` app runs
  as react-native-web in the window; their C++ / C# / Objective-C native modules do not run
  (write a desktop extension instead), and `Platform.OS` stays `"web"`
  (`Platform.constants.denextDesktop` and `.os` tell the window apart). Their extra components
  (`Flyout`, `Popup`, `Glyph`, `AppTheme`, `DynamicColorMacOS`) are DOM stand-ins, not native
  controls. Of the window-level `View` props, `mouseDownCanMoveWindow` (a drag region),
  `allowsVibrancy` (the window's vibrancy) and `draggedTypes` (file drops) work in a Deno Desktop
  window; `acceptsFirstMouse` is accepted and does nothing (the web view decides first-mouse
  clicks, and laufey has no per-view hook for it).

### React Native mode & Expo shims (`reactNative`, `denext/expo/*`)

- **Rendering stays DOM.** `reactNative` builds an app's source for the web through
  react-native-web. A TurboModule / Fabric codegen package, or a `requireNativeComponent` view,
  loads and fails only when its native module is used (unless the app ships a Capacitor plugin
  of that name, below); Nitro HybridObjects throw on use, and an Expo module's top-level
  `requireNativeModule` returns a stand-in that throws when called. A package whose `main` is
  Flow source fails earlier, at build time, unless an [Expo shim](https://denext.dev/docs/react-native#expo-apis)
  or [community alias](https://denext.dev/docs/react-native#community-packages) covers it.
  Each needs a web replacement of the app's own (`.web.ts` beside the importer, or a
  `deno.json` `imports` entry); `denext migrate --from expo` names the native-only packages it
  finds, and [Native SDK recipes](https://denext.dev/docs/native-sdk-recipes) covers Firebase,
  in-app purchases and Stripe.
- **No UI-thread animation or gesture runtime.** Reanimated's worklets are stamped at build time
  and run as plain JavaScript on the page's main thread, sharing it with React and layout; a
  busy thread drops frames React Native would keep. The build moves declarative `transform` /
  `opacity` animations (`withTiming`, `withSpring`, `withDelay`, `withSequence`, `withRepeat`,
  driven by a shared value or returned from the style) to Web Animations on the compositor, but
  gesture callbacks, `useFrameCallback`, derived values and reactions, `useAnimatedProps`,
  animations of any other style key, `withDecay` / `withClamp`, and a nested animation with its
  own callback stay on the main thread; so do libraries built on Reanimated (bottom-sheet, moti,
  Skia animations, victory-native) wherever they use those. The pass patches Reanimated 4's
  `lib/module` web build; another version's internals are left alone and keep the main-thread
  loop. Worklet classes and context objects are not stamped, and `runOnUISync` throws on the web.
- **Some native views have no WebView equivalent in React Native mode.** `expo-maps` and
  `react-native-maps` are the native map view only where the app registered it (`denext
  mobile add native-map`) and draw polylines, circles, callouts and other overlays nowhere; on
  the web they are a labelled placeholder (use MapLibre or Leaflet in a `.web.tsx` twin).
  `expo-video` / `react-native-video` fall back to an HTML `<video>` without the native view
  (no Picture in Picture, AirPlay or subtitles there). Not provided: Liquid Glass
  (`expo-glass-effect` reports it unavailable; `denext/navigation`'s platform theme approximates
  it in CSS, without refraction), native tab bars and large-title headers (`denext/navigation`
  draws them in the DOM), and `@expo/ui`'s SwiftUI / Compose
  views (stand-ins that render their children). `react-native-webview` is an `<iframe>`:
  script injection works only for inline HTML and same-origin pages.
- **The parity ledger's open React Native gaps.** React Native's 32 `*Base` / `*Component`
  type-alias exports are not exported, and 8 exports miss members (`AppRegistry`'s headless
  tasks and others; `scripts/parity/native/baselines/known-gaps.json`).
  `AppState`'s `memoryWarning` never fires (neither Capacitor nor denext's native code forwards
  the OS memory warning), `Linking.sendIntent()` rejects, and
  `ActionSheetIOS.dismissActionSheet()` closes nothing. `UIManager.getViewManagerConfig(name)`
  answers only for a native component the app built with `requireNativeComponent` /
  `codegenNativeComponent`, and `UIManager.dispatchViewManagerCommand` reaches a native view
  only through the element a ref holds (react-native-web's `findNodeHandle` throws, so there is
  no numeric tag). `codegenNativeCommands` commands take the same route, so the same limits apply.
- **`LayoutAnimation` animates positions, not sizes.** `configureNext` measures the page, waits
  for the next DOM change and plays FLIP animations: a view that moved glides from its old place
  (a transform), created views animate in and deleted views animate out (a snapshot clone in a
  fixed layer, so its inherited styles can differ). A view that changed size snaps to it, the
  `spring` type is a sampled curve (`ease-out` where CSS `linear()` is unsupported), and a page
  with more than 3,000 elements is not animated. The first DOM change after the call is taken as
  the commit, even an unrelated one.
- **Lists keep a few React Native props unimplemented.** The FlatList / SectionList / FlashList /
  LegendList adapters record their remaining gaps (such as LegendList's `snapToIndices` and
  `renderScrollComponent`) in `scripts/parity/native/baselines/lists.known-gaps.json`;
  `reactNative: { lists: "library" }` restores the libraries' own engines.
- **Snap props are CSS scroll snap.** `snapToInterval` / `snapToOffsets` / `snapToAlignment`
  end the platform's native momentum on a snap point, but `decelerationRate` only chooses
  between stopping at the next snap point (`"fast"`) or not: the momentum curve is the
  platform's. A virtualized list whose scroll space is scaled (past about 8M px) does not snap.
- **`react-native-mmkv` is synchronous over an asynchronous store.** Reads come from an in-memory
  copy seeded from `localStorage`; after the OS cleared the WebView's storage they miss those
  keys until `mmkvReady()` resolves, writes reach the durable store a moment after they return,
  and encryption (`encryptionKey`, `recrypt`) is refused.
- **Your own native modules are asynchronous only.** `TurboModuleRegistry`, `NativeModules`
  and Expo's `requireNativeModule` reach a Capacitor plugin (or a Deno Desktop extension) of the
  same name, but every method returns a Promise: there is no JSI, so synchronous TurboModule
  methods, `getConstants()`, Expo's sync `Function` / `Constants` and Nitro modules cannot be
  served. React Native mode warns at build time where app code uses a native method's result
  without awaiting it, and a dev build warns at run time. No codegen or autolinking runs: the
  native side is a Capacitor plugin you write or generate (`denext mobile add native-module`).
  See
  [Your own native code](https://denext.dev/docs/native-code).
- **The synchronous JSI Expo APIs are omitted.** The Capacitor bridge is asynchronous, so
  `expo-sqlite`'s `*Sync` API, `expo-secure-store`'s `getItem` / `setItem` and similar are not
  provided (use the `…Async` forms); `expo-file-system`'s sync calls act on an index the shim
  keeps and reach the files in the background. Each shim's omissions are listed in
  `denext/expo/manifest`.
- **`expo-sqlite` on the web needs `@sqlite.org/sqlite-wasm` installed by the app.** denext
  ships no npm runtime dependency; without the package, opening a database fails with an error
  naming it. Where OPFS is unavailable, or another tab of the origin holds the `opfs-sahpool`
  pool, the database is in memory for the session.
- **Resolution variants are picked once, when the module loads.** `require("./logo.png")` next to
  `logo@2x.png` / `logo@3x.png` bundles every variant and is the URL of the one the screen's
  pixel ratio wants then; a window moved to a screen of another density keeps it.
- **`reactNative` is valid only with `mode: "spa"`.** In `denext dev` an edit to a component
  module hot-swaps it with its state kept (Fast Refresh), but some edits still reload the page
  and lose state: the first import of a package, or of a name the app has not imported from it
  before (the dependency bundle is rebuilt), adding or removing an expo-router route, a change
  to `package.json` or a lockfile, and an edit to a module that is not a component (as in any
  SPA).
- **expo-router's `+api` and `+middleware` routes are not built.** Write them as denext route
  handlers.
- **Expo services are not provided.** `getExpoPushTokenAsync` rejects (send through your own
  APNs / FCM sender, `createPushSender`); `expo-updates` maps to denext's OTA.
- **uniwind needs importer-sensitive aliases denext's config cannot express yet**; the
  [recipe](https://denext.dev/docs/react-native#recipe-uniwind-and-tailwind) applies them with
  `denext patch`.

### Testing helpers (`denext doctor`, `probeApp`)

- **`denext doctor` / `probeApp` see a crash only as the framework's bare 500.** The
  "no-crash-marker" check matches the 500 fallback body (`Internal Server Error` and nothing
  else) and raw stack frames. A server error that a segment `error.tsx` caught and rendered
  at status 200 — the redacted message inside the boundary's own markup — is a rendered page
  to the probe. Assert on such routes yourself (a `contains` on the expected content).

### Compile-time feature flags (`feature()`)

- **DCE covers some paths, not all — but the value is always correct.** `feature("KEY")`
  (`denext/feature`) always returns the configured value: the server and every client bundle are
  seeded with the top-level `features` map. **Dead-code elimination** of the untaken branch happens
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
  `index` imports included) or — in the default dev loop — by an import-map alias,
  or re-exported by name through a barrel (one level), up to 3 levels of breadcrumb across modules. A hook
  imported by a bare, `npm:`/`jsr:`, URL specifier (or, in SPA mode, an import-map
  alias), through a namespace import, or through a barrel's `export *` still aborts naming for that
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

Nothing denext ships is experimental: every `experimental.*` config key graduated to a
top-level field by 2.5, and the `unstable_*` / `experimental_*` export names below are
**upstream's** names, kept for drop-in compatibility — the features behind them are stable
in denext. In new code use the un-prefixed twins on `denext/server`: `after`, `cacheLife`,
`cacheTag`, `noStore`, `connection` (the prefixed `unstable_after` / `unstable_cacheLife` /
`unstable_cacheTag` / `unstable_noStore` on `next/cache` are aliases of them). Still spelled
the upstream way because upstream is: `unstable_cache` (still `unstable_` in Next 16),
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

- **The compiled `denext` binary never builds an app in its own process.** Every module-loading
  verb (`dev`, `build`, `export`, `start`, `task`, `doctor`, `analyze`, `profile`, `desktop`)
  re-execs the denext the project pins, as a `deno run` child. This is deliberate — it is what
  makes `denext build` produce exactly what `deno task build` would rather than substituting the
  binary's own framework — but it is also load-bearing: a binary _cannot_ bundle in-process,
  because the generated client entry resolves `denext/client-runtime` and friends against
  `import.meta.url`, which inside a binary is a `deno-compile://` path the child bundler cannot
  see. **Consequence:** those verbs need a reachable `deno`, and a directory that pins no denext
  is refused with a message naming the fix, rather than built. `create`, `init`, `commands`,
  `completions` and `--version` run in the binary itself and need nothing; `ui` starts without
  Deno but its panels spawn `deno` for every project-touching operation. Signing is not a gap:
  the release workflow code-signs and notarises the macOS binary when the Apple Developer ID
  secrets are configured, and a `curl | sh` download never carries the quarantine attribute (a
  bare executable cannot be stapled either) — that is documented in
  [The `denext` command](./README.md#the-denext-command). What _is_ still missing: the installers'
  (`curl | sh`, `irm | iex`) default path needs a published non-prerelease release to resolve,
  because a release candidate is a GitHub prerelease and never "latest" — pass `DENEXT_VERSION`;
  and the Homebrew / Scoop / winget manifests each release generates are not yet published to a
  tap, a bucket or winget-pkgs (a maintainer step per release), and no Windows Arm64 binary is
  published (`install.ps1` installs the x64 one, which Windows on Arm runs under emulation).

- **`next/font/local`: no metric-matched fallback face.** Google fonts get Next's
  `adjustFontFallback` fallback face from a bundled metrics table (the same Capsize set Next
  ships, so the overrides are identical). A **local** font's metrics live in its file, which
  denext does not parse, so `localFont({ adjustFontFallback: "Arial" })` type-checks and
  keeps a stable class name but emits no fallback face — the stack falls straight through
  to your `fallback` list.
