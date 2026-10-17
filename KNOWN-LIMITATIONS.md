# denext — Known limitations

What denext **can't** do (the OS, platform, browser or an upstream forbids it), what it
**won't** do (a scope boundary), and mandatory per-OS differences. Fixable work is in
[ROADMAP.md](./ROADMAP.md); deliberate differences from React and Next.js are in
[KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md). A fixed entry is deleted, not annotated.

## React / Next.js surface

- **`<Script strategy="worker">` runs on the main thread** (as `afterInteractive`). denext ships
  no Partytown-style DOM-proxying worker runtime; self-host Partytown if you need one.
- **`next/og` renders satori's subset** (flexbox, inline `style`, `tw`): the same engine and
  limits as Next. Arbitrary CSS would need a layout engine or a headless browser.
- **Async `startTransition` is scoped by a time window by default.** Browsers have no
  `AsyncContext`, so an unrelated urgent update raised outside an event handler while an async
  transition is pending is treated as a transition. `asyncContext: true` scopes by identity (it
  instruments every client `await`; `yield*` delegation and top-level `await` are not).
- **`captureOwnerStack()` follows the JSX owner only for `jsxDEV` elements:** an element made with
  `h()` / `createElement` records no owner, so its stack is the render-parent chain, and during
  a server render it returns `null`.
- **React 19.3's Fragment refs are not implemented.** `<Fragment ref={…}>` gets no
  `FragmentInstance` (event listeners, focus, observers and rects over the fragment's children);
  attach the ref to an element instead. React 19.3's other additions — `ViewTransition` and
  `addTransitionType` without the `unstable_` prefix — are in, but the compat layer reports React
  19.2.9 (`React.version`) until Fragment refs land, so a library that checks for 19.3 keeps its
  19.2 path.
- **Won't:** legacy context (`childContextTypes`, use `createContext`) and Next's `taint` config
  (React's `experimental_taint*` are enforced).

## denext features: scope

### denext's Deno toolchain

- **Built for six targets only:** macOS (arm64, x64), Linux (x64, arm64) and Windows (x64,
  arm64). Elsewhere, and offline on first use, commands run on stock Deno, without `Deno.SQL` or
  Vitest/Jest compatibility in `deno test`.
- **Windows on Arm has run on a VM, not yet on Arm64 hardware** (toolchain 2.9.7-denext.21). On
  a Windows 11 Arm64 virtual machine (QEMU/KVM on an Arm64 board, software rendering through WARP,
  no GPU) these pass: `denext toolchain install` (`deno --version` reports `2.9.7-denext.21`,
  `aarch64-pc-windows-msvc`); `desktop run` and `desktop dev` windows on WebView2 and CEF (the page
  renders and hydrates, closing the window quits the verb cleanly); the desktop kitchen sink's
  window test on both backends with unsigned builds, the full-app update install, trial and
  rollback included; the runtime's own e2e suite on both backends, the menu accelerator and
  context-menu keyboard checks included; and a `desktop package --arch arm64` `.msi`, installed
  per user and per machine, upgraded, launched and uninstalled. Not yet run there: a physical
  Arm64 PC (GPU rendering), Authenticode-signed builds and the trusted-update checks,
  `denext build --compile --target aarch64-pc-windows-msvc`, and denext's own test suites (CI's
  `windows-11-arm` job is still optional). A `desktop run` / `dev` window loads the VC++ runtime
  from System32, so it needs the Arm64 VC++ 2015-2022 redistributable on the machine; a packaged
  bundle carries the runtime next to its `.exe`.
- **A CLI installed from JSR caches its verbs after the install, not during it.** `deno install
  -g jsr:@denext/denext/cli` caches the entrypoint; each verb's modules are cached by the CLI's
  first online run (in the background) or by `denext toolchain install`. A verb used offline
  before either has happened fails to load. The compiled binary embeds every verb.
- **A plain `deno task` runs a task's `deno` steps on the Deno that started it** (stock Deno);
  `denext task` is what puts the toolchain inside a task.

### Islands, resumability and Cache Components

- **On an isomorphic route an island hydrates in the page's tree, its code in the page bundle.**
  The page imports the component, so its code is not split off; a module-level `hydrate`
  default is not read (only the usage-site directive), a class or lazy component renders
  eagerly, and an `on*Capture` handler in a `client:interaction` island misses the event that
  woke it. `client:only` skips SSR by definition.
- **In SPA mode the directives defer the mount, not hydration.** There is no server HTML to keep
  inert, so the directives defer the component's mount and split its code instead: only for a
  component imported by name, not a member tag or a module-level `hydrate` default; a component
  also used without a directive stays in the main bundle; `client:interaction` needs a
  `client:placeholder` to interact with, and replays the triggering gesture on the element at the
  same position in the component's DOM (its first element when the placeholder's shape differs).
- **A streamed hole can't emit inline `<style>`/`<script>`** (the head and its CSP hashes have
  flushed); its late `<title>`/`<meta>` stays inline.
- **`searchParams` read outside a hole with `cacheKeyParams` set** can reflect another request;
  a whole-body cache refuses to store such a render, a PPR shell relies on the hole.

### Typed API, Live and GraphQL

- **Live is single-instance without a `ChannelTransport`** (`redisChannelTransport()`,
  `broadcastChannelTransport()` on Deno Deploy, or your own makes publishes, tag invalidations
  and `usePresence` rooms cross-instance).
- **Live views resume across instances only through a shared view store and from a
  serializable model:** without `setLiveViewStore(redisLiveViewStore() | postgresLiveViewStore())`
  a reconnect that lands on another instance, or any reconnect after
  `live.limits.viewResumeSeconds`, re-runs `init`; a model the wire codec cannot encode (a
  function, a class instance) stays in its process. A view resumed elsewhere carries on from the
  model as last stored, while the parked copy runs on where it was until its window ends. With
  JavaScript disabled only the first render works.
- **Channels carry state unless they keep a log:** without `history`, no replay on reconnect,
  at-most-once, latest-wins, 16 ms coalescing, `seq` ordered per instance. A log replays what
  it retains (`size` per key, `ttlSeconds`); the in-memory one is per instance. Re-authorization is lazy (`authTtlSeconds`;
  `channel.revoke(key)` is immediate). The production handshake requires a browser `Origin`.
- **A batched call carries no custom headers but `x-csrf-token`** (one that needs another goes as
  its own request), and **`useApi({ suspense: true })` is not seeded from a Cache Components
  (PPR) shell of a non-Flight route** (it fetches on mount there).
- **`@denext/openapi` describes only what a validator can export** (else `{}` / `unknown`); a
  custom middleware's responses appear only as `default` until it is tagged with
  `documentsErrors`; `scalar` loads from a CDN (`swagger` is vendored).
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
- **A stopped Lustre app's own effects keep running:** Lustre gives no way to cancel an app's
  timers or subscriptions from outside. A stopped server component drops what they dispatch;
  `lustreIsland` clears its root on unmount, but `lustre.shutdown()` does nothing for a client app
  in Lustre 5.7.1, so they still dispatch into the detached runtime.
- **denext fixes Lustre 5.7.1's server runtime only:** the post-build fix applies to that version's
  exact file; another Lustre version or a changed file is left as it is, with a warning.
- **The Lustre helpers need the App Router without `compatibilityMode`:** in a compat build
  `denext/gleam` is a server-only subpath.

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
- **An Android `apk-key-hash` passkey origin can't call the passkey endpoints:** a native app has
  no web origin for `passkeys.corsOrigins`, so it needs endpoints of its own.
- **Passkeys verify `none`, `packed`, `tpm`, `android-key`, `apple` and `fido-u2f`
  attestation** (`android-safetynet` and `compound` register only as unattested, under
  `attestation.mds.allowUnattested`), and ES256 / RS256 / Ed25519 credential keys only. The
  Metadata Service checks use CRLs, not OCSP.
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

- **Providers:** GitHub, Google, Apple, Discord, Microsoft Entra ID, GitLab, X (Twitter),
  LinkedIn, Facebook, Slack, Twitch, Spotify, Okta, Auth0, Keycloak, Cognito, Zoom, Notion,
  Credentials, Resend, Nodemailer / Email, and custom OAuth / OIDC objects. Auth.js's other
  `next-auth/providers/*` modules are not shipped; write one as a custom provider object.
  WebAuthn (`next-auth/providers/passkey`) is not mapped — denext's own `passkeys` are.
- **Adapters:** an Auth.js adapter (`@auth/prisma-adapter`, `@auth/drizzle-adapter`, …) backs
  users, accounts, verification tokens and database sessions. Roles, bans and
  `sessionsValidAfter` need its two optional extension methods (`getUserExtension` /
  `updateUserExtension`, an extension table); without them those fields are dropped with a
  warning and `revokeAllSessions()` can't end its database sessions. Password hashes are not
  stored through it, and database sessions don't slide. With an adapter, a Credentials `authorize()` must return a user of the
  adapter's users table (by `id`), as with Auth.js; a user it doesn't know is refused.
- **NextAuth.js v4:** `next-auth/middleware` reads the JWT strategy's token only, as v4 does, so
  with `session: { strategy: "database" }` every gated request is sent to sign in. A Pages API
  route's `NextAuth(req, res, …)` takes the body the Pages Router already parsed (string fields
  only). v4's `next-auth/client` (v3's API) and the `next-auth/providers/*` modules this list
  doesn't name are not shipped.

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
  `statement_timeout`. The `@denext/openapi` document lists the default schema's routes only (a
  second schema is described by `GET /rest/v1` with its `Accept-Profile`), and their request
  budget (`rest.rateLimit`) counts per process unless it is given a shared `store`.
- **Realtime re-reads every change as each subscriber.** With the default LISTEN/NOTIFY source the
  trigger sends only the key, so every change costs a re-read per identity and filter; many
  concurrent writers serialize on commit (the logical-replication source
  avoids that, but needs `wal_level = logical` and a `REPLICATION` role); and a change sent while
  the listener reconnects is lost (every subscriber is told to re-read). A delete, or an update out of view, reaches only a subscription
  that tracked the key — at most `maxTrackedKeys` (default 10 000) per subscription. Subscriptions
  are capped per identity and per instance; behind a reverse proxy without
  `trustForwardedHeaders`, signed-out visitors are counted per Live connection, not per address.
- **Storage's SQL policies need `storage: { rls: true }`** (otherwise a bucket's `authorize` in
  TypeScript decides, with no `storage` schema to join against). An S3 upload
  whose client skips the completion call was checked by nobody: record the keys completion
  returned, and give the bucket lifecycle rules for unrecorded objects and incomplete multipart
  uploads. Image transforms take PNG, JPEG, GIF, WebP and AVIF sources up to 25 MiB (an AVIF
  only when it declares its size: a still image, not a bare image sequence), at the configured
  `images` sizes and qualities only.

### Tooling

- **The compiled `denext` binary re-execs the denext the project pins** for every module-loading
  verb (`dev`, `build`, `export`, `start`, …), on denext's Deno toolchain (downloaded on first
  need; no Deno install required). Offline on first use, with no toolchain cached, it needs a
  `deno` on PATH. Without `DENEXT_VERSION` the installers pick the newest non-prerelease.
- **`denext build --compile` compiles a server only:** a SPA has no server to compile, and `dev`,
  `build` and `export` stay on the CLI. next-compat builds and the Pages Router are untested in a
  binary.
- **Inside a Node workspace, run the JSR CLI with `--node-modules-dir=none`.** Deno resolves
  `npm:` from `node_modules` there (and rewrites a `pnpm-workspace.yaml`) before denext runs.
- **The dev server's assets answer only opted-in hosts** (loopback, `--lan`, `--host`,
  `allowedDevOrigins`; no wildcards), the CVE-2025-48068 defence.
- **DevTools can't expand a package's custom hook** (one imported by a bare / `npm:` / `jsr:` /
  URL specifier): its cells are labelled with the call, and cells two such hooks in a row could
  share stay unnamed. The bundled App Router path names route files only. Network, Cache, Routes and the MCP snapshot
  need the App Router dev server. React DevTools' hooks view and Profiler read React internals,
  so they don't work; use denext's panel.
- **The first-party Markdown renderer escapes raw HTML** (it is not passed through). Use an `.mdx`
  entry for raw HTML or components.
- **`denext ui`'s compose editor owns a closed set of fields** (services, image, restart, build,
  ports, volumes, environment, depends_on, networks); the rest is hand-edited, a multi-document
  file is read-only, and a merge-key (`<<`) field can be overridden, not deleted. A third-party
  plugin's form needs a published `denext.catalog.optionsSchema`; code-valued options are
  read-only.

### Remix and React Router

- **Some `getLoadContext` values stay `TODO(denext migrate)` notes after migration.** Request reads,
  cookies, the client address, `req.session`, `req.user` and what an Express middleware set are
  mapped, but a value built from a top-level declaration of the server file or a middleware's local
  variable, a request field with no Fetch equivalent, and `req` / `res` passed on whole are left as
  located notes. A session the old server's store held does not carry over, `cspNonce` is
  `undefined` (denext's CSP is hash-based), and the synthesized `ServerBuild` is flat.
- **`useBlocker` can't hold a hard unload;** add a `beforeunload` prompt for that.
- **Prisma auto-migration wires SQLite, Postgres and MySQL only:** a `sqlserver`, `mongodb` or
  `cockroachdb` datasource keeps its `new PrismaClient()` unwired (SQL Server takes
  `@prisma/adapter-mssql` by hand; Prisma 6 has no MongoDB driver adapter). Postgres runs over npm
  `pg`, not denext's `Deno.SQL`, whose results carry no column types for a Prisma adapter.

### TanStack Start

- **`@denext/tanstack-start` does not prerender.** `denext export` writes no TanStack Start
  routes (`denext start` serves them). Its import protection applies Start's default client-side
  rules only: custom `importProtection` rules and the server build's `*.client.*` rule are not
  applied, and a violation fails `denext dev` too, where Start's dev server mocks the import and
  warns. The server render and the client bundle are compiled onto denext's React, so an app's
  own `react` import must resolve to denext (`compatibilityMode`).

## Mobile (Capacitor shell)

Rendering is a WebView by design, so the WebView's and the OS's limits apply.

- **iOS:** passkeys don't run on the `capacitor://` origin (use `openAuthSession`); service
  workers don't run there; `requestAnimationFrame` is capped at 60 Hz on 120 Hz displays
  ([WebKit 294338](https://bugs.webkit.org/show_bug.cgi?id=294338); lifting it is an App Review
  risk denext won't take); Live Activities and configurable widgets are iOS-only (configurable
  from iOS 17; push-to-start from 17.2); App Groups and push need a paid Apple Developer team.
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
- **Interactive keyboard dismissal** works at best on the outer scroller; screen readers follow
  the DOM accessibility tree; on Android `allowFontScaling={false}` can't undo WebView text zoom.
- **`NativeViewSlot` is a native layer, not DOM:** non-scroll layout changes reach it a frame
  late; on Android a slot inside a scrolling element trails it during a fling; non-box clips are
  not applied; an `"over"` view hides while covered; controls inside an iOS `"embed"` view
  don't complete a tap (use `"under"`); a slot a list unmounts destroys its view.
- **OTA updates can't change what the app is** (Apple DPLA 3.3.1(B)); the signing key is in the
  binary, so rotating it takes a store release; the fingerprint gate can't see native code pulled
  in from outside `ios/`, `android/` and the declared plugins; an iOS web-content crash during a
  trial is reloaded by Capacitor, not the plugin.
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
  copy and refuses encryption.
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
  server style sheet holds every style the process has created, and a module first loaded inside
  a streamed Suspense boundary adds its rules on the client only. `dev` uses the bundled loop
  (rebuild and reload, no per-module hot swap). `fonts`, `rootStyle` and uniwind are the SPA
  shell's; `compatibilityMode: false` cannot be combined with it.
- **Can't (no WebView or browser API):** `expo-gl` on a worklet / UI runtime
  (`getWorkletContext` is undefined) and camera textures (`createCameraTextureAsync` rejects):
  `GLView` is the page's WebGL 2. Barometer and pedometer readings, the carrier facts of
  `expo-cellular`, Low Power Mode, and attachments on `expo-sms` / `expo-mail-composer` (an
  `sms:` / `mailto:` URL cannot carry them) are not available.
- **Not verified on a device yet:** the `DenextCalendar`, `DenextContacts`, `DenextPrint` and
  `DenextBrightness` plugins `denext mobile add calendar | contacts | print | brightness` write
  are compiled (Java against Capacitor 8) and type-checked (Swift against the iOS SDK) but not
  yet run on a phone. On Android, splitting a repeating event from one occurrence on
  (`updateEventAsync` with `instanceStartDate` and `futureEvents`) is refused, and
  `expo-print`'s `printToFileAsync` lays HTML out without running its scripts.
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
- **Native passkeys:** none on Linux (no OS API); macOS needs the associated-domains entitlement
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
- **`denext desktop dev` runs under the `deno` CLI only;** with `--lan` the per-launch token is
  not injected, so token-gated features are refused.
