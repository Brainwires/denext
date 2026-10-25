# denext — Known limitations

What denext **can't** do (the OS, platform, browser or an upstream forbids it), what it
**won't** do (a scope boundary), and mandatory per-OS differences. Fixable work is in
[ROADMAP.md](./ROADMAP.md); deliberate differences from React and Next.js are in
[KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md). A fixed entry is deleted, not annotated.

## React / Next.js surface

- **`<Script strategy="worker">` runs off the main thread only through the app's own
  Partytown**, as in Next: it needs `nextScriptWorkers` (Next's `experimental.nextScriptWorkers`)
  and `@qwik.dev/partytown` (or `@builder.io/partytown`) in `node_modules`, else it runs on the
  main thread as `afterInteractive`. It needs service workers (Partytown's atomics mode, its
  debug build and the iframes a worker script creates get no Partytown, so an injection cannot
  use them either), and a worker script inside a `"use cache"` body or a PPR shell runs on the
  main thread, since that output cannot carry the response's nonce. Partytown's trade-offs
  apply: a cross-origin script is fetched by the worker and needs CORS, and what a worker script
  loads is outside the page's `scriptSrc`. SPA mode always uses the main-thread fallback.
- **`next/og` renders satori's subset** (flexbox, inline `style`, `tw`): the same engine and
  limits as Next. Arbitrary CSS would need a layout engine or a headless browser.
- **Async `startTransition` is scoped by a time window by default.** Browsers have no
  `AsyncContext`, so an unrelated urgent update raised outside an event handler while an async
  transition is pending is treated as a transition. `asyncContext: true` scopes by identity (it
  instruments every client `await`, async generator `yield` / `yield*` and top-level `await`).
  An async generator resumed by `throw()` / `return()` at a plain `yield` runs its `catch` /
  `finally` in the caller's context, not its own, and a module whose top-level evaluation throws
  leaves its context current.
- **`captureOwnerStack()` returns `null` during a server render**, and an element made with
  `h()` / `createElement` gets its owner when a render returns it (the component whose render
  result first holds it), not when it is made: one built outside any render (a module-level
  constant) is owned by the first component that returns it, where React gives it none, and its
  frame carries no JSX call site.
- **A native App Router or SPA build leaves out three runtimes the app's own sources never name**
  (on denext's Deno toolchain, whose `deno bundle` takes `--define`): the clearing of `next/image`
  blur placeholders in server-only trees (kept when a source names `blurDataURL` or a
  `placeholder` other than a plain string), the function-valued `<form action>` /
  `formAction` seam (kept when a source names `action` or `formAction`) and the filling of a
  route-pattern href from its `params` (`{ pathname: "/blog/[slug]", params }`, kept when a
  string or template literal in a source holds a `/[name]`, `/[...name]` or `/[[...name]]`
  segment). npm packages are not scanned, so a package that renders either of the first two by
  itself, with props the app never names, or builds a route pattern itself, needs the app to name
  it once. A next-compat (npm React) build keeps all three.
- **Won't:** legacy context (`childContextTypes`, use `createContext`) and Next's `taint` config
  (React's `experimental_taint*` are enforced).

## denext features: scope

### denext's Deno toolchain

- **Built for six targets only:** macOS (arm64, x64), Linux (x64, arm64) and Windows (x64,
  arm64). Elsewhere, and offline on first use, a command that needs the toolchain stops with an
  error naming `denext toolchain install`; `DENEXT_DENO=stock` runs stock Deno instead, without
  `Deno.SQL` or Vitest/Jest compatibility in `deno test`.
- **Windows on Arm has run on a VM, not yet on Arm64 hardware** (last verified on toolchain
  2.9.7-denext.21). On
  a Windows 11 Arm64 virtual machine (QEMU/KVM on an Arm64 board, software rendering through WARP,
  no GPU) these pass: `denext toolchain install` (`deno --version` reports `2.9.7-denext.21`,
  `aarch64-pc-windows-msvc`); `desktop run` and `desktop dev` windows on WebView2 and CEF (the page
  renders and hydrates, closing the window quits the verb cleanly); the desktop kitchen sink's
  window test on both backends with unsigned builds, the full-app update install, trial and
  rollback included; the runtime's own e2e suite on both backends, the menu accelerator and
  context-menu keyboard checks included; a `desktop package --arch arm64` `.msi`, installed per
  user and per machine, upgraded, launched and uninstalled; and a server binary from
  `denext build --compile --target aarch64-pc-windows-msvc` (an Arm64 executable that serves
  pages). denext's unit and integration suites run there too; what fails on that VM fails the
  same way on Windows x64, where CI's `windows-tests` job runs those suites for every release. CI's `windows-11-arm` job (desktop
  suites, `install.ps1`, the Arm64 `.msi`) is required for a release. Not yet run on Arm64: a
  physical PC (GPU rendering), Authenticode-signed builds and the trusted-update checks. A
  `desktop run` / `dev` window loads the VC++ runtime
  from System32, so it needs the Arm64 VC++ 2015-2022 redistributable on the machine; a packaged
  bundle carries the runtime next to its `.exe`.
- **A CLI installed from JSR caches its verbs after the install, not during it.** `deno install
  -g jsr:@denext/denext/cli` caches the entrypoint (Deno's install has no post-install step); every
  verb's modules, and the framework modules a verb loads by URL, are cached by
  `denext toolchain install` or by the CLI's first online run (in the background). A verb used
  offline before either has happened fails to load. The compiled binary embeds every verb.
- **The TypeScript 7 language server (the editor default) does less than the TypeScript 6
  service.** The pinned runtime's `deno lsp` runs the dated 7.1 nightly the toolchain pins by
  default (earlier runtimes through the `"deno.unstable": ["tsgo-lsp"]` that `create`, `migrate`
  and `upgrade` write into `.vscode/settings.json`). Against the in-process
  TypeScript 6 service it:
  - resolves only what `deno sync-types` expresses as `paths` and `.deno/` files, with the same
    gaps as the native check (no sloppy imports, `@deno-types` / `X-TypeScript-Types`, per-member
    `jsxImportSource`), types `jsr:` packages from `npm.jsr.io` whatever `JSR_URL` says, and sees
    a dependency added by editing an import only after the next `deno cache`;
  - writes `.deno/` (ignored by its own `.gitignore`) into the project;
    `DENO_TSGO_LSP_SYNC_TYPES=0` stops that, at the cost of the import map's types;
  - picks Deno's lib types per project, not per file (a worker module gets the window's types),
    and has no Vitest / Jest types for `*.vitest.ts`;
  - answers nothing inside remote documents (`deno:/https/…`), and a definition in a dependency
    lands on its `.deno/` mirror rather than the `https:` / `jsr:` URL;
  - skips notebook cells, semantic tokens, references / implementations code lenses, import
    updates on a file rename, `deno/inferredType`, and quick fixes that rewrite an auto-import to
    an import-map alias / `jsr:` / `npm:` specifier (its own relative or `paths` key is used);
  - has the nightly's quick-fix set only (no "Did you mean …" spelling or add-`await` fixes yet;
    auto-import and organize imports work), and outside a generated tsconfig uses tsgo's
    non-strict defaults;
  - runs as one extra process (about 100–250 MB) beside `deno lsp`.

  Each has the same way out: `DENO_UNSTABLE_TSGO_LSP=0` in the language server's environment
  keeps TypeScript 6 whatever the setting says, and a `deno.unstable` list in
  `.vscode/settings.json` that names other features but not `"tsgo-lsp"` keeps it for that
  project.
- **Runtime 3.0.0-rc.5's type-check leaves `.deno/npm-compat` in the project root.** It holds
  an npm-shaped copy of the `@jsr/*` packages, their `_test.ts` files included, and a later
  `deno test` with default discovery would run those. A `denext create` project's `deno.json`
  excludes `.deno/` (top-level `exclude`), as denext's own does; an older project adds
  `"exclude": [".deno/"]` itself. A runtime issue, to be fixed in rc.6 or later by keeping the
  copy out of the project.
- **On Windows, a closed console window, logoff or system shutdown cuts the drain short.**
  `denext start` begins its graceful shutdown on those events too, but Windows ends a console
  process as soon as Deno's console handler returns, which it does at once, so in-flight requests,
  the `services/` stop and `onShutdown()` don't get to finish. Stop a server with Ctrl-C or
  Ctrl-Break, which is what service wrappers (WinSW, NSSM) send: those drain fully.
- **A plain `deno task` runs a task's `deno` steps on the Deno that started it** (stock Deno);
  `denext task` is what puts the toolchain inside a task.

### Islands, resumability and Cache Components

- **On an isomorphic route an island hydrates in the page's tree, after the page.** Context
  reaches it from the page, so the page's own tree hydrates first. Its code splits into a chunk of
  its own only when the component is imported for directive elements alone, in a module that no
  Flight route, `global-error` or `instrumentation-client` also reaches, and only in
  `denext build` / `export`; otherwise (and in `denext dev` and a next-compat drop-in) it stays in
  the page bundle. A module-level `hydrate` default is not read (only the usage-site directive). A
  class or `lazy()` component renders eagerly; when split, it holds the page's hydration until its
  chunk lands (inside a Suspense boundary, the boundary renders it on the client instead). Events
  held while a split island's chunk loads replay as synthetic copies (`isTrusted` false), and a
  held `submit` that nothing cancels submits its form without its submitter. A listener on
  `window` itself sees a held event twice. `client:only` skips SSR by definition.
- **In SPA mode the directives defer the mount, not hydration.** There is no server HTML to keep
  inert, so the directives defer the component's mount and split its code instead. A module-level
  `hydrate` default is read only from a module imported by a relative path (not through an
  import-map alias or a package), and only for an import's own component or a namespace import's
  direct member; a component also used without a directive stays in the main bundle; `client:interaction` needs a
  `client:placeholder` to interact with, and replays the triggering gesture on the element at the
  same position in the component's DOM (its first element when the placeholder's shape differs).
- **A streamed hole can't emit inline `<style>`/`<script>`** (the head and its CSP hashes have
  flushed); its late `<title>`/`<meta>` stays inline.

### Typed API, Live and GraphQL

- **Live is single-instance without a `ChannelTransport`** (`redisChannelTransport()`,
  `broadcastChannelTransport()` on Deno Deploy, or your own makes publishes, tag invalidations
  and `usePresence` rooms cross-instance).
- **Live views resume across instances only through a shared view store and from a
  serializable model:** without `setLiveViewStore(redisLiveViewStore() | postgresLiveViewStore())`
  a reconnect that lands on another instance, or any reconnect after
  `live.limits.viewResumeSeconds`, re-runs `init`; a model the wire codec cannot encode (a
  function, a class instance) stays in its process. A view resumed elsewhere carries on from the
  model as last stored; the resuming instance announces it over the channel transport, and the
  instance that parked the view stops its copy at once. With JavaScript disabled only the first
  render works.
- **Channels carry state unless they keep a log:** without `history`, no replay on reconnect,
  at-most-once, latest-wins, 16 ms coalescing, `seq` ordered per instance. A log replays what
  it retains (`size` per key, `ttlSeconds`); the in-memory one is per instance. Re-authorization is lazy (`authTtlSeconds`;
  `channel.revoke(key)` is immediate). The production handshake requires a browser `Origin`.
- **A batched call carries no custom headers but `x-csrf-token` and the ones the app forwards**
  (`apiBatch.forwardHeaders`, listed on the client too; one that needs another goes as its own
  request).
- **`@denext/openapi` describes only what a validator can export** (else `{}` / `unknown`); a
  custom middleware's responses appear only as `default` until it is tagged with
  `documentsErrors`.
- **`@denext/graphql` reloads a schema object only when it can trace it:** one built in
  `denext.config.ts` itself, or imported through an alias rather than a relative import, needs a
  dev-server restart after an edit (a module-path `schema` always reloads).

### Gleam and Lustre (`denext/gleam`)

- **A Lustre server component (`defineLustreView`) resumes only on the instance that ran it:**
  Lustre's model is an arbitrary Gleam value, so it is never written to the shared view store. A
  reconnect to the same instance within `live.limits.viewResumeSeconds` reattaches the running
  runtime; a reconnect to another instance, or a later one, runs `init` again. The page's first
  paint is replaced by Lustre's own render when the view mounts (not adopted), and Lustre's
  contexts (`provide` / `subscribe`) and client-sent attribute or property changes are not
  carried over Live.
- **A stopped Lustre app's timers keep firing:** Lustre gives no way to cancel an app's timers or
  subscriptions from outside. A stopped server component, and (with denext's post-build fix to
  Lustre's client runtime) a stopped `lustreIsland`, ignore what they dispatch, but the timer
  itself runs until the page goes. A render frame Lustre scheduled just before the stop still runs
  once.
- **A Lustre runtime file of an unrecognised shape is not fixed:** the post-build fixes match the
  buggy code's pattern; a rewritten runtime is left as it is, with one warning.

### First-party auth (`denextAuth`)

- **Mail delivery is best-effort:** emailed tokens go to `sendVerificationRequest` (`smtpMailer()`
  or your own) after the response, so delivery can be cut short where the platform freezes the
  isolate.
- **`sqliteAuthAdapter` is single-node.**
- **Without an adapter, a stateless cookie session can't be ended early:** the user's
  `sessionsValidAfter` (set by `revokeAllSessions`, a password reset or change, a ban, a deletion
  and the pre-account-hijacking eviction) lives on the stored user, so with no adapter there is
  nothing to read. It is compared to the second: a session signed in during the very second it
  is set survives it. `revokeSession(id)` (one device) needs a `sessionStore`.
- **Sliding refresh needs a `Response` being produced** (`/session`, `requireAuth()`,
  `requireSession()`; a streamed component's headers have flushed). A store without `update`
  never slides.
- **`mfa.required: "always"` is trust-on-first-use;** rotating `secret` invalidates in-flight
  one-time codes, and a retired `secret` can be removed only after `denext auth reseal` reports
  zero remaining; rate limiters count per node without a shared
  `rateLimit.store`, and every per-IP budget (the captcha budget included) is skipped for a
  loopback/private peer with no trusted proxy hop unless `rateLimitLocalAddresses` is set.
- **Native passkey rows sign in usernameless only:** `/native/passkey/*` has no step-up of a
  pending native sign-in with a passkey (a code at `/native/mfa` finishes it), and no list or
  delete rows (the cookie `/passkeys` rows, or `listPasskeys` / `deletePasskey` on the server).
- **Passkeys accept ES256 / RS256 / Ed25519 credential keys only** (every WebAuthn L3
  attestation format is verified, `android-safetynet` and `compound` included). Revocation of the
  Metadata Service paths (OCSP, then CRL) fails closed by default, so an unreachable responder and
  CRL block registration; `attestation.revocation: "soft"` (the default with an offline `blob`)
  lets it through instead.
- **Fixed profiles:** TOTP is SHA-1 / 6 digits / 30 s (what every authenticator supports); an
  email local part must be ASCII.
- **Native sessions:** Apple token revocation needs `native.apple.clientSecret`.
- **`cors` lets a cross-origin caller into Server Actions, the API batch and Live only without
  cookies** (those keep the same-origin rule, or `allowedOrigins`), and a cross-origin Live socket
  needs `canonicalOrigin`; middleware must let `OPTIONS` under `/auth` through.
- **SAML Single Logout with stateless sessions ends every session of the user:** a cookie session
  has no id, so an IdP's LogoutRequest naming one SessionIndex ends all of that user's sessions
  signed in before it (a `sessionStore` ends exactly the named one).

### `next-auth` (Auth.js v5 and NextAuth.js v4) compat

- **Providers:** every `next-auth/providers/*` module of `@auth/core` 0.41.3 (`next-auth@5.0.0-beta.32`)
  except three: `azure-devops` (a JWT assertion exchange instead of an authorization code, and
  deprecated by Microsoft), `bankid-no` (userinfo as a signed JWT, which denext doesn't verify)
  and `wechat` (its `platformType` option switches the authorization URL and scope, which the
  generated data can't express). Write one as a custom provider object where its API allows.
- **Passkeys (`next-auth/providers/passkey`, `…/webauthn`):** registration is for a signed-in
  user with a verified address after a recent sign-in (Auth.js's sign-up by passkey is not
  offered); the relying party needs `AUTH_URL` or `relayingParty: { id, origin }`. Through an
  Auth.js adapter the ceremony challenge lives in the app's cache store, so instances sharing one
  (Postgres, Redis, Deno KV, or one host's SQLite file) need no sticky sessions; with the
  in-memory cache store (the default on Deno Deploy, or `cache: { store: "memory" }`) a ceremony
  must finish on the instance that began it. The counter update is a read-then-write (Auth.js's port has no
  compare-and-swap), and removing a passkey needs a denext-only `deleteAuthenticator` method. The
  built-in sign-in page's passkey button signs in only (no registration, as above).
- **Adapters:** an Auth.js adapter (`@auth/prisma-adapter`, `@auth/drizzle-adapter`, …) backs
  users, accounts, verification tokens and database sessions. Roles, bans and
  `sessionsValidAfter` need its two optional extension methods (`getUserExtension` /
  `updateUserExtension`, an extension table); without them those fields are dropped with a
  warning and `revokeAllSessions()` can't end its database sessions. Password hashes are not
  stored through it. Its database sessions slide only with a session cookie that carries the
  sign-in time (one an earlier denext issued ends at its row's expiry). Its session rows keep no sign-in time,
  sign-in methods or pending second factor, so `denextAuth` refuses MFA (an adapter with the
  factor store, or `mfa.required: "always"`) over them at startup; use the JWT strategy or a
  denext `sessionStore` with MFA. With an adapter, a Credentials `authorize()` must return a user of the
  adapter's users table (by `id`), as with Auth.js; a user it doesn't know is refused.
- **NextAuth.js v4:** `next-auth/middleware` reads the JWT strategy's token only, as v4 does, so
  with `session: { strategy: "database" }` every gated request is sent to sign in. A Pages API
  route's `NextAuth(req, res, …)` takes the body the Pages Router already parsed (string fields
  only). v4's `next-auth/client` (v3's API) is not shipped; v4's providers are the v5 ones
  above.

### Backend (`@denext/backend`)

- **Not hosted.** The stock supabase-js client works against the app (`/auth/v1`, `/rest/v1`,
  `/storage/v1`, `/realtime/v1`, `/functions/v1`, each once its option is on), but there is no
  Supabase project behind it: pooling and upgrades are the Postgres provider's job (`denext stack
  backup` / `restore` cover the self-hosted stack), and the Database section of `denext ui` and
  `denext dashboard` (its password-protected copy for the stack) is a single-project tool with
  one shared password, not a multi-user console, and keeps no metrics.
  Moving from a Supabase project, TOTP secrets, WebAuthn credentials and OAuth-server client
  secrets don't carry over (users enroll again, clients are re-registered).
- **The built-in Postgres client is `Deno.SQL`, part of denext's Deno runtime.** On stock Deno pass
  `postgres: { sql: fromPostgresJs(postgres(url)) }` (the npm `postgres` package); without a client
  `db()` and realtime throw `code: "unsupported"`.
- **Auto-REST speaks PostgREST 12's wire format but is not PostgREST:** a request takes at most 64
  filters, 256 select items and 8 levels of embedding, and runs under a 5-second
  `statement_timeout`. One URL serves every schema of `rest.schemas`, so in the `@denext/openapi`
  document a relation or function whose name two schemas share is described for the first of
  them only (`GET /rest/v1` with the other's `Accept-Profile` describes it). The request budget
  (`rest.rateLimit`) counts per process when neither it nor `denextAuth`'s `rateLimit` names a
  shared `store`.
- **Realtime re-reads every change as each subscriber.** With the default LISTEN/NOTIFY source the
  trigger sends only the key, so every burst costs one re-read per distinct role and claims (a
  user's sessions each carry their own `session_id`, so two devices are two re-reads); many
  concurrent writers serialize on commit (the logical-replication source avoids that, but needs
  `wal_level = logical` and a `REPLICATION` role); and a change sent while the database listener
  reconnects is lost (every subscriber is told to re-read). A browser's reconnect is replayed only
  from the instance that held its subscription, within `replay.retentionSeconds` and
  `replay.maxChangesPerTable`: without sticky sessions, or past either, the subscriber re-reads.
  Supabase's `postgres_changes` has no replay, as on Supabase. A delete, or an update out of view,
  reaches only a subscription that tracked the key — at most `maxTrackedKeys` (default 10 000) per
  subscription. Subscriptions are capped per identity and per instance; behind a reverse proxy
  without `trustForwardedHeaders`, signed-out visitors are counted per Live connection, not per
  address.
- **Storage's SQL policies need `storage: { rls: true }`** (otherwise a bucket's `authorize` in
  TypeScript decides, with no `storage` schema to join against). A signed upload without a
  `size` is not length-pinned at the store (S3 has no length range for a presigned `PUT`), so
  oversized bytes can reach the staging place until the completion refuses them or the sweep
  frees them; the sweep runs only when an upload is signed, completed or aborted, so give the S3
  bucket a lifecycle rule on `.denext-staging/` for an app whose uploads can stop for good. Image
  transforms take PNG, JPEG, GIF, WebP and AVIF sources up to 25 MiB (an AVIF
  only when it declares its size: a still image, not a bare image sequence), at the configured
  `images` sizes and qualities only.

### Tooling

- **The compiled `denext` binary re-execs the denext the project pins** for every module-loading
  verb (`dev`, `build`, `export`, `start`, …), on denext's Deno toolchain (downloaded on first
  need; no Deno install required). Offline on first use, with no toolchain cached, it stops with
  the fix (`denext toolchain install` once online); `DENEXT_DENO=stock` runs a `deno` on PATH
  instead. Without `DENEXT_VERSION` the installers pick the newest non-prerelease.
- **`denext build --compile` compiles a server only:** a SPA has no server to compile, and `dev`,
  `build` and `export` stay on the CLI.
- **A workspace glob member expands one level.** `"./apps/*"` names the folders directly under
  `apps/`; a deeper or mid-path glob (`packages/**`, `apps/*/web`) names nothing to denext, so an
  app it covers builds on its own config and its siblings' names don't resolve. List such members
  one by one. A package's own import map applies to its files as a scope, except in a server copy
  `denext dev` writes after an edit there, which resolves through the app's map.
- **Inside a Node workspace, run the JSR CLI with `--node-modules-dir=none`.** Deno resolves
  `npm:` from `node_modules` there (and rewrites a `pnpm-workspace.yaml`) before denext runs.
- **The dev server's assets answer only opted-in hosts** (loopback, `--lan`, `--host`,
  `allowedDevOrigins`; no wildcards), the CVE-2025-48068 defence.
- **DevTools can't expand a package's custom hook** (one imported by a bare / `npm:` / `jsr:` /
  URL specifier): its cells are labelled with the call, and cells two such hooks in a row could
  share stay unnamed. The bundled App Router path names route files only. Network, Cache, Routes and the MCP snapshot
  need the App Router dev server. React DevTools' hooks view and Profiler read React internals,
  so they don't work; use denext's panel.
- **`createTestApp` sets plugins up in `dev` mode**: their build steps run and what they emit is
  served, but a route the build itself prerenders renders on demand (a Pages Router
  `getStaticProps` page is rendered per request, and with a `deno.json` its client bundle is built
  on first use). `jobs/` is registered without its schedules, and `services/` is supervised
  process-wide, so two test apps with services can't run at once.
- **`viteEmitterPlugin` runs `generateBundle` asset emits only.** An asset by `fileName`, or by
  `name` under Rollup's default `assets/[name]-[hash][extname]`, is published; a chunk-type
  `emitFile` fails the build, and a plugin's own `assetFileNames` pattern, `setAssetSource` and
  every other Vite hook are not run.
- **The first-party Markdown renderer escapes raw HTML by default**; `markdown: { html:
  "sanitize" }` keeps what an allowlist sanitizer allows, never passing HTML through. Only the
  block containers (`details`, `div`, `blockquote`, `figure`, and `section` / `aside` when
  allowlisted) stay open across Markdown blocks, and only when an HTML block of their own opens
  them; an inline element (`<b>`, `<span>`, …) is closed at the end of the paragraph, heading,
  cell or item it was written in. Use an `.mdx` entry for components.
- **`denext ui`'s compose editor owns a closed set of fields** (services, image, restart, build,
  the plain-text settings `container_name`, `hostname`, `working_dir`, `user`, `platform`,
  `stop_signal` and `stop_grace_period`, ports, volumes, environment, depends_on, networks); the
  rest (`command`, `healthcheck`, `labels`, …) is hand-edited, and a multi-document file is
  read-only. A field a merge key (`<<`) supplies can be overridden, not deleted: Compose itself
  can't drop a merged value for one service (`!reset` leaves it in place). A third-party
  plugin's form needs a published `denext.catalog.optionsSchema`; code-valued options are
  read-only.

### Remix and React Router

- **Some `getLoadContext` values stay `TODO(denext migrate)` notes after migration.** Request reads,
  cookies, the client address, `req.session`, `req.user` and what an Express middleware set are
  mapped, but a value built from a top-level declaration of the server file or a middleware's local
  variable, a request field with no Fetch equivalent, and `req` / `res` passed on whole are left as
  located notes. A session the old server's store held does not carry over, `cspNonce` is
  `undefined` (denext's CSP is hash-based), and the synthesized `ServerBuild` is flat. A
  `getLoadContext` that returns a `RouterContextProvider` keeps the `context.set(key, value)` calls
  whose value carries over; one passing `req` / `res` on (an `expressContext`) is a note.
- **React Router route `middleware` on a page render runs ahead of the loaders, not around the
  render.** There is no single handler to wrap, so `next()` resolves at once to a stand-in
  response (headers set on it reach the page; another `Response` answers like a thrown one), code
  after `next()` runs before the loaders, and a parent route's loader may run before a child
  route's middleware. On a resource route and a plain POST to a page's action `next()` runs the
  real handler. `clientMiddleware` does not run.
- **`useBlocker` can't hold a hard unload;** add a `beforeunload` prompt for that.
- **Prisma auto-migration wires SQLite, Postgres (CockroachDB too), MySQL and SQL Server only:**
  a `mongodb` datasource keeps its `new PrismaClient()` unwired (Prisma 6 has no MongoDB driver
  adapter). SQL Server's `@prisma/adapter-mssql` (over npm `mssql`) is wired and unit-tested but
  not yet run against a live SQL Server. SQLite and Postgres
  run over `Deno.SQL` (`denext/prisma-adapter`, no npm driver) only on denext's Deno runtime
  3.0.0-rc.1 or later; on an earlier runtime migrate wires Prisma's npm adapters
  (`@prisma/adapter-better-sqlite3` with its `links` shim, `@prisma/adapter-pg`), and CockroachDB
  and MySQL always take theirs.
- **`denext/prisma-adapter` reads no `interval`, range, composite or geometric Postgres column**
  (Prisma's `UnsupportedNativeDataType`; cast it to `text` in a raw query). `money` is read at
  the fractional digits of `lc_monetary` as the first `money` result found it: a session that
  changes `lc_monetary` later (`SET lc_monetary`) keeps the client's first answer.

### Fresh and Preact

- **Fresh:** partial navigation swaps the `<Partial>` regions without Fresh's View Transitions
  wrapper (`f-view-transition`) and takes only the answer's `<title>` from its head; browser
  back / forward re-renders the whole page (a region's `append` / `prepend` history is not
  replayed). `main.ts`'s `app.islands()`, Fresh and Vite plugins and `fresh({…})` options are not
  run; `app.layout()` layouts wrap the pages inside the `_app` wrapper and outside the `_layout`
  files, and `app.onError()` answers the errors a handler or middleware raises (an error while a
  page component renders goes to the route's `_error` page). An `app.notFound()` middleware's
  Response body renders as the not-found page's text, at its status, so the static files in
  `public/` still answer first. `csp({ useNonce: true })` leaves out `'unsafe-inline'` (denext
  allows its own inline styles by hash and runs no inline script), and `import.meta.env.PROD` is
  true under `denext start`, where the source runs in place rather than from Vite's build output.
  `denext migrate --check` lists each one it finds
  ([Migrating from Fresh](https://denext.dev/docs/migrating-fresh)).
- **Preact:** `@preact/signals`' `useSignalRef` / `createModel` / `useModel` are not provided, and
  its `signal` / `computed` / `effect` (and hook forms) take no options argument.
  `denext/preact/compat` lacks `createFactory`, `findDOMNode`, `isFragment`, `isMemo` and
  `unmountComponentAtNode`, and its `render` / `hydrate` / `flushSync` take no callback;
  `denext/preact/jsx-runtime` lacks Deno's precompiled-JSX helpers (`jsxTemplate`, `jsxAttr`,
  `jsxEscape`), so `"jsx": "precompile"` needs `react-jsx`. (The parity gate lists each in
  `tests/fixtures/react-parity-known-gaps.json`.) Of Preact's `options` hooks denext calls
  `vnode`, `event` and `useDebugValue` (for elements the Preact entry points create); `diffed`,
  `unmount`, `debounceRendering`, `requestAnimationFrame` and the internal hooks are never called,
  so `preact/debug` / `preact/devtools` are empty modules. `useErrorBoundary` never catches during
  a server render, and a production build compiles its boundary support in only when the app's
  own sources name `useErrorBoundary` or import preact-iso (a Preact library that calls the hook
  needs the app to name it once). `denext/preact/render-to-string` keeps denext's attribute order and hyphenated SVG attributes, ignores the legacy `context` argument,
  and `renderToReadableStream` sends the whole document once resolved (no fallback-first
  streaming); `preact-render-to-string/jsx` and `/stream-node` are not mapped. A migrated Preact
  app runs as a SPA, so preset-vite's `prerender` does not carry over.
- **`denext/signals` re-renders the component that read a signal**, where Preact patches the text
  node in place; a signal bound to a DOM prop needs Preact's JSX runtime
  (`jsxImportSource: "preact"`).

### TanStack Start

- **`@denext/tanstack-start`:** a mocked import's runtime message (`denext dev`) lists no
  import trace. With `generateRouteTree: false` `denext export` prerenders only the `pages`
  listed and their links, refusing no route by kind, and the deploy manifest lists its server
  functions alone. The server render and the client bundle are compiled onto denext's React, so
  an app's own `react` import must resolve to denext (`compatibilityMode`).

## Mobile (Capacitor shell)

Rendering is a WebView by design, so the WebView's and the OS's limits apply.

- **iOS:** passkeys don't run on the `capacitor://` origin (use `openAuthSession`); service
  workers don't run there; `requestAnimationFrame` is capped at 60 Hz on 120 Hz displays
  ([WebKit 294338](https://bugs.webkit.org/show_bug.cgi?id=294338); lifting it is an App Review
  risk denext won't take); Live Activities and configurable widgets are iOS-only (configurable
  from iOS 17; push-to-start from 17.2); App Groups and push need a paid Apple Developer team; a
  LAN host (an OTA origin, `mobile dev --lan`, a file transfer) is unreachable until the user
  allows Local Network access (iOS asks once; Settings → Privacy & Security → Local Network), and
  until then requests fail with -1009 (the OTA check and file transfers add that hint).
- **Android:** the WebView is whatever the device has installed, so features and bugs vary;
  widgets are static (no configure activity); push needs `google-services.json`; `mobile dev`
  relies on `usesCleartextTraffic`, which an app's own `networkSecurityConfig` overrides.
- **Clerk in the shell (`denext/mobile/clerk`):** passkeys sign in through Clerk's hosted page in
  the auth session (a `capacitor://` / `https://localhost` page cannot use WebAuthn for Clerk's
  relying party) and are created on the web; on Android the OAuth callback is a custom-scheme
  intent, so another app registered for the scheme could receive it while a sign-in is pending
  (the same exposure as Windows and Linux desktop).
- **Delivered notifications on Android:** a push FCM draws has no group, so it is selected by its
  tag (`android.notification.tag`), not a `threadId`; the OS keeps no payload of a drawn
  notification, so `deliveredNotifications()` reports no `data` there.
- **JavaScript doesn't run in the page in the background**, and a silent push reaches it only
  while the app runs; `defineBackgroundTask` runs in Capacitor's Background Runner (no DOM).
- **WebView storage is evictable** (use `denext mobile add storage`); `secureStore` is a plain
  IndexedDB on the web; certificate pinning can't cover the WebView's own `fetch`/XHR.
- **Native context menus differ per OS:** iOS lifts a preview only for a bound element
  (`useContextMenu`); Android's `PopupMenu` flattens submenus into groups and draws no icons or
  title; the Deno Desktop menu draws no destructive style or icons.
- **Background audio (`denext mobile add background-audio`) and `pickMedia`** are compiled and
  unit-tested, not yet run on a device (background playback, the lock-screen and notification
  controls, multi-select and video picks). `setAudioSession`'s `interruption` applies on iOS only
  (Android's WebView takes audio focus itself); the iOS lock screen shows controls only for a
  non-mixing session; Android starts the media foreground service only with the app in the
  foreground (Android 12+) and keeps it until `clearNowPlaying()`. expo-audio's other audio-mode
  fields (silent mode, earpiece routing, background recording) are accepted without effect. A
  native `selectionLimit` holds on iOS and Android 13+ (elsewhere, and on the web, the result is
  cut to it); `ordered` needs `@capawesome/capacitor-file-picker` and iOS 15+.
- **File transfers (`denext mobile add file-transfer`)** are compiled and tested against a local
  server (the iOS manager through macOS's `URLSession`, the Android HTTP half through the JDK), not
  yet run on a device in the background. Android's WorkManager stops a job after about ten
  minutes: a download resumes from its `.part` file on the next run, an upload starts over; uploads
  cannot pause anywhere. iOS may defer a background transfer started while the app is already in
  the background. On the web a transfer lasts as long as the page. A Deno Desktop download
  pauses and resumes, but `fileTransfers()` lists only the ones this page started: after a
  restart, download the same URL to the same file again to continue its kept partial file.
- **Interactive keyboard dismissal** works at best on the outer scroller; screen readers follow
  the DOM accessibility tree; on Android `allowFontScaling={false}` can't undo WebView text zoom.
- **`NativeViewSlot` is a native layer, not DOM:** non-scroll layout changes reach it a frame
  late; on Android a slot inside a scrolling element trails it during a fling; non-box clips are
  not applied; an `"over"` view hides while covered; controls inside an iOS `"embed"` view
  don't complete a tap (use `"under"`); a slot a list unmounts destroys its view.
- **OTA updates can't change what the app is** (Apple DPLA 3.3.1(B)); the signing key is in the
  binary, so rotating it takes a store release; the fingerprint gate can't see native code pulled
  in from outside `ios/`, `android/` and the declared plugins; an iOS web-content crash during a
  trial is reloaded by Capacitor, not the plugin. A signed manifest expires (30 days by default):
  a release left unsigned past that is refused (`expired`) until it is re-signed, and the expiry
  is checked against the device clock. Unsigned updates from loopback work only in a debug build.
- **The native bridge answers only the app's own origin:** a page reached through
  `server.allowNavigation` or a hosted `server.url` (in a release build) cannot call plugins
  unless `plugins.DenextBridge.allowedOrigins` lists its exact origin (no wildcards) or
  `frameGuard: false` turns the check off. On Android the guard finds Capacitor's private
  `MessageHandler` by its type; if a future Capacitor changes that, the guard logs it and the
  bridge keeps Capacitor's own origin rules. Plugin responses then go back through
  `evaluateJavascript` (Capacitor's fallback path).
- **`openAuthSession` needs PKCE** (S256) on every platform unless `pkce: "not-applicable"` with a
  `reason`; Deno Desktop's loopback flow does not check for it yet.
- **`secureStore`'s `requireBiometric` is OS-enforced only in a current binary** (`denext mobile
  add biometrics` from a denext newer than 4.8.0, in a new binary): in an older binary, and in a Deno Desktop window (the desktop
  keychain has no biometric access control yet), the gate is denext's code in the page and page
  script can read the value. Android needs 9 or later (8 and earlier refuse it); the passcode as
  a fallback (`allowDeviceCredential`) needs Android 11. A gated value is dropped when the enrolled
  biometrics change, and it is never backed up.
- **`denext fastlane` (the managed fastlane)** runs on macOS and Linux only (arm64, x64); Windows
  is not supported. Its first install needs a C compiler, because several of fastlane's gems
  build C extensions. It runs denext's pinned gems, so plugins in `fastlane/Pluginfile` need the
  project's Gemfile and `bundle exec`. The Ruby comes from denext's own mirror (the `toolchain-assets`
  GitHub release), with Homebrew's `ghcr.io` registry as the fallback, both pinned by SHA-256. It has been run on
  macOS x64, Linux x64 (Ubuntu) and Linux arm64 (Fedora, SELinux enforcing); on macOS arm64 the
  Ruby is pinned and its hash checked, but the install has not been run there yet.
- **Won't:** native UIs for watches, cars and App Clips; hosted services (an Expo Go-style
  client, push relay, build/submit, OTA CDN); install attribution; MDM configuration wrappers;
  code obfuscation (keep secrets on the server).

## React Native mode

- **Rendering stays DOM** through react-native-web; native rendering is out of scope. A
  TurboModule / Fabric / `requireNativeComponent` view fails when used unless the app ships a
  Capacitor plugin of that name; Nitro objects throw; a Flow-source `main` fails the build.
- **No UI-thread animation or gesture runtime.** Reanimated worklets run on the main thread;
  only declarative `transform` / `opacity` animations move to the compositor.
- **No JSI, so nothing synchronous across the bridge:** native-module methods return Promises;
  Expo's `*Sync` APIs and `expo-secure-store`'s `getItem`/`setItem` are omitted
  (`denext/expo/manifest` lists each shim's omissions); `react-native-mmkv` reads an in-memory
  copy and refuses encryption (use `openKeyValueStore(name, { encrypted: true })`).
- **SQLite encryption is native only, and expo-sqlite's keys share one passphrase.** SQLCipher
  runs in the iOS / Android app; the web build (sqlite-wasm) and Deno Desktop refuse
  `PRAGMA key` and encrypted stores rather than keep the data in the clear.
  `@capacitor-community/sqlite` keeps one passphrase for all of an app's databases, so
  `PRAGMA key` with a second, different passphrase is refused, and `rekey` / `PRAGMA rekey`
  re-encrypts every encrypted database of the app one after another, so a crash part-way can
  leave them split between the two passphrases (an encrypted key-value store's rotation recovers
  by itself).
- **Native views:** maps and video are native only where registered, without overlays (on the
  web a placeholder and `<video>`); Liquid Glass, tab bars and large titles are CSS; `@expo/ui`
  views are stand-ins; `react-native-webview` is an `<iframe>`.
- **`LayoutAnimation` resizes by scaling** (FLIP: a resized view's content is drawn stretched
  while the animation plays, where React Native lays it out at each size), takes the next DOM
  change as the commit, and skips pages over 3,000 elements. Snap props are CSS scroll snap.
- **`adjustsFontSizeToFit` needs a box to overflow** (`numberOfLines` or a fixed size).
  `ellipsizeMode="head"` / `"middle"` work on one plain-text line only, and `onTextLayout`'s font
  metrics are estimated from the font size. An `Image` with `crossOrigin` / `referrerPolicy` is
  drawn as an `<img>`, which doesn't draw `tintColor`.
- Fast Refresh reloads on a new dependency import, an added or removed route or a lockfile
  change. Resolution variants (`@2x`) are picked at load.
- **On the App Router** (`reactNative` without `mode: "spa"`): expo-router is not available (it
  is a router, and `app/` is the App Router's; an import fails the build). react-native-web's
  server style sheet holds every style the process has created, not only the page's (a streamed
  Suspense boundary's new rules stream ahead of it). `fonts`, `rootStyle` and uniwind are the SPA
  shell's; `compatibilityMode: false` cannot be combined with it.
- **Can't (no WebView or browser API):** `expo-gl` on a worklet / UI runtime
  (`getWorkletContext` is undefined) and camera textures (`createCameraTextureAsync` rejects):
  `GLView` is the page's WebGL 2. Barometer and pedometer readings, the carrier facts of
  `expo-cellular`, Low Power Mode, and attachments on `expo-sms` / `expo-mail-composer` (an
  `sms:` / `mailto:` URL cannot carry them) are not available.
- **Not verified on a device yet:** the `DenextCalendar`, `DenextContacts`, `DenextPrint` and
  `DenextBrightness` plugins `denext mobile add calendar | contacts | print | brightness` write
  are compiled (Java against Capacitor 8) and type-checked (Swift against the iOS SDK) but not
  yet run on a phone (Android's split of a repeating event from one occurrence on included), and
  `expo-print`'s `printToFileAsync` lays HTML out without running its scripts.
- **A strict CSP still blocks a `<style>` element a library fills with text at run time**,
  and react-native-web's second sheet when it renders into a shadow root; those need
  `style-src 'unsafe-inline'`. react-native-web's own sheet and React Native mode's rules need
  nothing (the CSP is hash-based, so there is no nonce to give such an element).
- **Renderers built on `react-reconciler` see no denext context** (React Native Skia's
  `<Canvas>`, react-three-fiber, react-konva): a component inside their tree reads a context's default
  value (as in React, contexts don't cross renderers), and a provider placed inside the tree does
  not reach it either (in React it would); pass the values as props. A class component inside such
  a tree is not supported. React Native Skia with Reanimated, and in the Capacitor shell's
  WebViews, is not yet verified.
- **Unistyles' Babel plugin is ported in part:** the component swap and `useVariants` run, the
  per-style dependency pass does not (the theme is CSS variables; a style that depends on the
  breakpoint or another runtime value updates when its component renders again). Tamagui's
  optimizing compiler (`@tamagui/babel-plugin`) is not run; its runtime styles the components.
  `require.context` takes literal arguments only.
- **`denext profile --android` is Android only:** an iOS app's WKWebView is not profiled.
- **Won't:** expo-router `+api` / `+middleware` routes (write denext route handlers) and Expo's
  services (`getExpoPushTokenAsync` rejects; use `createPushSender`). The `expo-widgets` shim
  renders the generated SwiftUI, not the `"widget"` layout function. `expo-sqlite` on the web
  needs the app's own `@sqlite.org/sqlite-wasm` (no runtime npm).

## Deno Desktop

Under denext's pinned runtime; what the stock runtime lacks is in
[our Deno Desktop runtime](https://denext.dev/docs/desktop-runtime).

- **The window's engine is the OS's** (WKWebView, WebView2, WebKitGTK), so features and bugs
  follow the OS; `--backend cef` ships Chromium everywhere (about 150 MB larger).
- **Sign-in on Windows and Linux runs in the system browser**, which reports no cancel (no OS
  auth session); denext shows a Cancel overlay and `timeoutMs` is the backstop.
- **Clerk sign-in on Windows and Linux needs the app to handle its scheme.** When another app
  (an Electron build of the same app, say) handles `myapp:` links, the callback would go to it, so
  `denext/desktop/clerk` refuses with `scheme_owned_by_other_app`; Clerk's native redirect
  allowlist takes no loopback URL to fall back to. Call `claimDeepLinkScheme` from the user's click
  and sign in again. macOS is unaffected (its sheet catches the callback). A program that merely
  sends the app a forged callback is refused: each sign-in's redirect carries a per-session
  `denext_nonce` the callback must bring back, so the forgery protection does not depend on Clerk
  binding its `rotating_token_nonce` to the client.
- **Native passkeys:** on Linux (no OS API) only USB security keys, under runtime 3.0.0-rc.1+
  (libwebauthn; no platform authenticator, the browser otherwise); macOS needs the
  associated-domains entitlement
  and its provisioning profile (`desktop.macos`);
  the window's WebAuthn can't serve a web relying party (`denext/desktop/clerk` falls back).
- **Notifications:** on Linux a click that starts a quit app and a scheduled notification posted
  while the app is closed need a `.deb` / `.rpm` install, xdg-desktop-portal 1.19+ and a systemd
  user manager; macOS shows them only from a signed bundle. A click's tag, action and `data` are
  untrusted: the runtime drops clicks it never posted (each carries a MAC from a per-install key,
  `<app data dir>/laufey-notification-key`), but any process of the same user can read that key.
  A notification's tag is at most 256 bytes, its data 4 KiB and an action id 1 KiB (UTF-8): a
  larger click is dropped, so denext refuses to post one. Linux notification servers keep no list
  of an app's notifications, so `deliveredNotifications()` there lists only what denext posted
  during this run and has not removed (a notification the user dismissed is still listed, one from
  an earlier run is not); on every OS `threadId` does not group them in the OS. [Details](https://denext.dev/docs/desktop#desktop-notifications).
- **Linux sessions differ:** with no tray host `createTray` rejects `unsupported`; with a locked
  keyring no one can unlock, CEF stores cookies obfuscated, not OS-protected
  (`cookieEncryption: "basic"`). `denext desktop doctor --linux` lists what is missing
  ([details](https://denext.dev/docs/desktop#desktop-linux-session)).
- **A Linux CEF app run from a tarball or AppImage on Ubuntu 23.10+ has no Chromium sandbox**
  (AppArmor restricts user namespaces, and only the `.deb` / `.rpm` install the setuid
  `chrome-sandbox`): `appCapabilities().sandbox` reads `"off"`. Set
  `desktop.linux.requireSandbox: true` to refuse to start there instead (exit status 78);
  `denext desktop doctor --linux` says which sandbox a machine allows.
- **The Linux clipboard** is readable by an app in the background while the session is unlocked,
  as on macOS and Windows; a locked session refuses reads only where the locker sets logind's
  `LockedHint` ([details](https://denext.dev/docs/desktop#desktop-linux-session)).
- **WebKitGTK `fetch` bodies aren't byte streams** ([WebKit bug 322545](https://bugs.webkit.org/show_bug.cgi?id=322545)):
  on Linux's WebView backend `getReader({ mode: "byob" })` throws.
- **Wayland:** global shortcuts need the XDG portal (the user approves each); an app can't move
  its own window; CEF gets no paths from a file drop (use the webview backend).
- **Windows CEF apps start in their install folder** (CEF's bootstrap, which Chromium's sandbox
  needs; build paths from `Deno.execPath()`), and a bootstrap signed with a certificate Windows
  doesn't trust refuses to start ([details](https://denext.dev/docs/desktop#desktop-windows-cef)).
- **CEF on Linux spellchecks seven languages out of the box** (runtime 2.9.7-denext.21): the
  runtime makes no network requests of its own, so it never downloads Hunspell dictionaries; it
  ships en-US, en-GB, de-DE, fr-FR, es-ES, pt-BR and it-IT. For any other language the app ships
  the `.bdic` files in `dictionaries/` beside the host executable. Windows and macOS use the OS
  spellchecker, unchanged.
- **WebView2 streams only what the page fetches** ([WebView2Feedback#3519](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3519)):
  navigations and subresources arrive whole. Stream through `fetch` / `EventSource`, or use CEF.
- **Window and menu features differ per OS and backend** (title-bar styles and the Dock menu are
  macOS-only, Mica/Acrylic Windows 11, no CEF backdrops; Cmd+Q can't be held; a badge is a
  window-title prefix on Windows, and on Linux too unless a dock reads launcher badges). Ask
  `windowCapabilities()` and `appCapabilities()`.
- **macOS can hand your deep-link scheme to another app;** denext requires PKCE S256 and an exact
  `redirect_uri` + `state` match, and refuses a scheme another app owns. On macOS 13+
  `setLaunchAtLogin` may need approval in Login Items.
- **Installers need their OS's tools:** `.dmg` / `.pkg` on macOS (sign the `.pkg`), `.msi` needs
  WiX 5 on Windows, `.rpm` `rpmbuild`, AppImage `appimagetool`. No MSIX, Flatpak, Snap or Mac App
  Store build (each sandbox breaks per-app storage and deep-link registration).
- **Permissions:** a packaged app keeps `--allow-read` / `--allow-env` unscoped, and a picked path
  needs unscoped read/write (permissions bake at build time); FFI, Node-API addons and spawned OS
  tools are full trust; the bridge token is readable by any script in the page, so keep the
  strict CSP and enable only the capabilities you use.
- **`secureStore` per OS:** on macOS (under denext's pinned runtime; an older or the stock runtime
  writes through `/usr/bin/security`, which any program of the same user can read back) an app
  without a provisioning profile that grants a keychain access group keeps its items in the login
  keychain, where another program gets macOS's prompt (which the user can allow) rather than
  nothing. That keychain guards reads, not writes: another program of the user can replace an
  item's value or plant one for a key without a prompt. A team-signed app (Developer ID,
  development, App Store) reads such an item as not there (`null`), so a replaced value is lost to
  it; an ad-hoc signed build can't tell it from its own earlier build, so its read shows macOS's
  prompt; an unsigned build reads and writes it as its own, so it has no protection against
  another program's writes. An ad-hoc or unsigned build is also a new program to macOS after each
  rebuild, so its first read prompts. Values an older denext stored through `security` move over
  only when the app reads them during its first launch under the runtime's store (a marker in that store ends
  the move, so a key the app first reads later stays behind in the login keychain), and during
  that first launch an item another program of the user plants for a key the app has not read
  yet is still adopted on that key's first read; on Linux it needs a Secret Service
  provider (GNOME Keyring, or KWallet with its Secret Service enabled) whose keyring can be
  unlocked, reached through libsecret inside denext's pinned runtime (the stock runtime has no
  Linux secure store, and there is no `secret-tool` path) — else every call rejects
  `backend_unavailable` with the reason (never a plaintext fallback).
- **Linux file dialogs need denext's pinned runtime:** without it they answer `unavailable` (the
  page keeps `<input type="file">`). With it, a desktop whose portal has no FileChooser (wlroots
  with `xdg-desktop-portal-wlr` alone) gets GTK's chooser rather than the desktop's own; a CEF
  window on Wayland can't be named to the portal, so its portal dialog isn't modal to the window.
- **Some desktop paths can only be verified by hand** (Touch ID / Windows Hello passkeys, signed
  macOS notifications, the update signer match with real identities, Mica, real HiDPI displays):
  no CI runner has the hardware or identities, so they are checked before each final release
  ([checklist](https://denext.dev/docs/contributing#manual-desktop-checks-before-a-final-release)).
- **No Touch Bar.** `react-native-windows` / `-macos` native
  modules don't run (write a desktop extension); their extra components are DOM stand-ins.
- **`denext desktop dev` runs under the `deno` CLI only.**
