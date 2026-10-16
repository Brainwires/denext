# denext — Known limitations

What denext **can't** do (the OS, platform, browser or an upstream forbids it), what it
**won't** do (a scope boundary), and mandatory per-OS differences. Fixable work is in
[ROADMAP.md](./ROADMAP.md); deliberate differences from React and Next.js are in
[KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md). A fixed entry is deleted, not annotated.

## React / Next.js surface

- **`<Script strategy="worker">` runs on the main thread** (as `afterInteractive`). denext ships
  no Partytown-style DOM-proxying worker runtime; self-host Partytown if you need one.
- **A library's npm `"use client"` files are found by resolving its packages as the server bundle
  does** (`node_modules`, `nodeResolve` on, the default). With `nodeResolve: false` the server
  bundle resolves packages differently, so a package's own client components may render on the
  server only.
- **`next/og` renders satori's subset** (flexbox, inline `style`, `tw`): the same engine and
  limits as Next. Arbitrary CSS would need a layout engine or a headless browser.
- **Async `startTransition` is scoped by a time window by default.** Browsers have no
  `AsyncContext`, so an unrelated urgent update raised outside an event handler while an async
  transition is pending is treated as a transition. `asyncContext: true` scopes by identity (it
  instruments every client `await`; `yield*` delegation and top-level `await` are not).
- **`next-intl` formats the common ICU subset.** An unknown number/date skeleton token is
  ignored, and deeply nested `plural`/`select` is depth-capped (an error, not a wrong render).
- **`captureOwnerStack()` reports the render-parent chain** (the DevTools panel's), not React's
  JSX-owner chain: a component passed as `children` through a wrapper is listed under the wrapper.
  Each frame's location is where the component was declared, and during a server render it
  returns `null`.
- **Won't:** legacy context (`childContextTypes`, use `createContext`), Next's `taint` config
  (React's `experimental_taint*` are enforced), and Next canary's navigation-stage APIs
  (`unstable_navigation` / `unstable_prefetch` from `next/cache`; an import fails the build).

## denext features: scope

### denext's Deno toolchain

- **Built for five targets only:** macOS (arm64, x64), Linux (x64, arm64) and Windows (x64).
  Elsewhere, and offline on first use, commands run on stock Deno, without `Deno.SQL` or
  Vitest/Jest compatibility in `deno test`. That includes Windows on Arm: the `denext` binary
  is built for it, but its Deno verbs run on the `deno` on your `Path` (the x64 binary, which
  runs under emulation, gets the x64 toolchain).
- **A CLI installed from JSR caches its verbs after the install, not during it.** `deno install
  -g jsr:@denext/denext/cli` caches the entrypoint; each verb's modules are cached by the CLI's
  first online run (in the background) or by `denext toolchain install`. A verb used offline
  before either has happened fails to load. The compiled binary embeds every verb.
- **A plain `deno task` runs a task's `deno` steps on the Deno that started it** (stock Deno);
  `denext task` is what puts the toolchain inside a task.
- **Coverage from a Vitest run doesn't merge with a plain run's.** The Vitest layer changes the
  code a module emits, so `deno coverage` under-reports a module whose profiles from both kinds
  of run it merges; report a Vitest run's coverage on its own.

### Islands, resumability and Cache Components

- **Per-island hydration is a Flight-route feature.** The isomorphic path and SPA mode hydrate
  as one root; `client:only` skips SSR by definition. In SPA mode the directives defer the
  component's mount and split its code instead (no server HTML to keep inert): only for a
  component imported by name, not a member tag or a module-level `hydrate` default; a component
  also used without a directive stays in the main bundle; `client:interaction` needs a
  `client:placeholder` to interact with, and replays the triggering gesture on the element at the
  same position in the component's DOM (its first element when the placeholder's shape differs).
- **`use cache` can't read request data** (`cookies()`/`headers()`/`connection()`): read it
  outside and pass the value in.
- **A streamed hole can't emit inline `<style>`/`<script>`** (the head and its CSP hashes have
  flushed); its late `<title>`/`<meta>` stays inline.
- **`searchParams` read outside a hole with `cacheKeyParams` set** can reflect another request;
  a whole-body cache refuses to store such a render, a PPR shell relies on the hole.

### Typed API, Live and GraphQL

- **Live is single-instance without a `ChannelTransport`** (`redisChannelTransport()`,
  `broadcastChannelTransport()` on Deno Deploy, or your own makes publishes, tag invalidations
  and `usePresence` rooms cross-instance).
- **Live views keep their model in one process:** a reconnect that lands on another instance, or
  after `live.limits.viewResumeSeconds`, re-runs `init` (sticky sessions keep it on one node).
  With JavaScript disabled only the first render works.
- **Channels carry state, not a log:** no replay on reconnect, at-most-once, latest-wins, 16 ms
  coalescing, `seq` ordered per instance. Re-authorization is lazy (`authTtlSeconds`;
  `channel.revoke(key)` is immediate). The production handshake requires a browser `Origin`.
- **Only GET/HEAD calls batch; `useApi({ suspense: true })` seeds hydration on Flight routes
  only** (elsewhere it fetches on mount).
- **`@denext/openapi` describes only what a validator can export** (else `{}` / `unknown`);
  middleware responses appear only as `default`; `scalar` / `swagger` load from a CDN.
- **`@denext/graphql`: with Yoga `batching` the cost budget is per operation.** A schema object
  imported into `denext.config.ts` needs a restart after an edit (a module-path `schema` reloads).

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
- **The passkey endpoints are same-origin only:** an extra `passkeys.origins` entry (another web
  origin, an Android `apk-key-hash`) needs that origin to serve the auth routes itself.
- **Passkeys verify `none` and `packed` attestation only** (with `attestation.mds`, another
  format registers only as unattested), and ES256 / RS256 / Ed25519 keys only. The Metadata
  Service checks fetch no certificate revocation lists.
- **Fixed profiles:** TOTP is SHA-1 / 6 digits / 30 s (what every authenticator supports); an
  email local part must be ASCII.
- **Native sessions:** under `mfa.required: "always"` a user with no factor yet can't enroll from
  a native `id_token` sign-in (`403 mfa_required`; the browser flow enrolls); Apple token
  revocation needs `native.apple.clientSecret`.
- **`cors` covers route handlers and the native auth endpoints only**, not pages, Server Actions,
  the batch endpoint or Live; middleware must let `OPTIONS` under `/auth` through.
- **SAML Single Logout is `/auth/v1`'s only:** a `saml()` provider on denext's own endpoints
  signs in, and its session ends with `signOut()`, not with an IdP's LogoutRequest.

### `next-auth` (Auth.js v5) compat

- **Providers:** GitHub, Google, Apple, Discord, Microsoft Entra ID, GitLab, X (Twitter),
  LinkedIn, Facebook, Slack, Twitch, Spotify, Okta, Auth0, Keycloak, Cognito, Zoom, Notion,
  Credentials, Resend, Nodemailer / Email, and custom OAuth / OIDC objects. Auth.js's other
  `next-auth/providers/*` modules are not shipped; write one as a custom provider object.
  WebAuthn (`next-auth/providers/passkey`) is not mapped — denext's own `passkeys` are.
- **Adapters:** an Auth.js adapter (`@auth/prisma-adapter`, `@auth/drizzle-adapter`, …) backs
  users, accounts, verification tokens and database sessions. Its schema has no column for
  denext's roles, bans, password hashes or `sessionsValidAfter`, so those features don't work
  through it, `revokeAllSessions()` can't end its database sessions (it warns), and database
  sessions don't slide. With an adapter, a Credentials `authorize()` must return a user of the
  adapter's users table (by `id`), as with Auth.js; a user it doesn't know is refused.
- **v4 APIs** (`next-auth/next`, `getServerSession`, `next-auth/middleware`'s `withAuth`) are
  not shipped.
- **Not parity-gated:** the `next-auth` surface is not part of the React / Next.js parity CI gate.

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
  `statement_timeout`. The routes are not in the `@denext/openapi` document (`GET /rest/v1` serves
  PostgREST's own Swagger 2.0 one), and their request budget (`rest.rateLimit`) counts per
  process unless it is given a shared `store`.
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
- **A `denext build --compile` binary runs on Deno's stock `denort` 2.9.7**, not denext's
  toolchain build, so it has no `Deno.SQL` (Postgres goes through `fromPostgresJs(postgres(url))`;
  `db migrate` on a plain Postgres `DATABASE_URL` needs `@denext/backend` with that client), and it
  prints Deno's one-line `request.signal` legacy-abort notice on the first request (`deno compile`
  does not carry `--unstable-no-legacy-abort`). A SPA has no server to compile. `dev`, `build` and
  `export` stay on the CLI. next-compat builds and the Pages Router are untested in a binary.
- **Inside a Node workspace, run the JSR CLI with `--node-modules-dir=none`.** Deno resolves
  `npm:` from `node_modules` there (and rewrites a `pnpm-workspace.yaml`) before denext runs.
- **The dev server's assets answer only opted-in hosts** (loopback, `--lan`, `--host`,
  `allowedDevOrigins`; no wildcards), the CVE-2025-48068 defence.
- **`denext doctor` / `probeApp` don't see a streamed Suspense hole whose error nothing inside it
  catches:** the hole keeps its fallback in a 200 page. Put an `error.tsx` inside the hole, or
  assert on the route's content yourself.
- **DevTools hook names are all-or-nothing per component** (a conditional hook, or one imported
  by a bare / `npm:` / `jsr:` / URL specifier, a namespace import or `export *`, aborts naming).
  The bundled App Router path names route files only. Network, Cache, Routes and the MCP snapshot
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

- **`getLoadContext` values read from the Express request are `TODO` stubs** after migration, and
  `cspNonce` is `undefined` (denext's CSP is hash-based). The synthesized `ServerBuild` is flat.
- **`useBlocker` can't hold a hard unload;** add a `beforeunload` prompt for that.
- **A soft navigation sent as a POST gets its `defer()` values whole** (one whose
  `shouldRevalidate` echo is too large for headers); a GET navigation streams them as they settle.
- **`@denext/react-router` generates no route types.** `import type { Route } from
  "./+types/…"` is type-only, so it erases and the app runs, but denext writes no `+types`
  modules for a type check to resolve. (How `serverLoader()` behaves on a client navigation is a
  deliberate difference: [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md).)
- **Prisma auto-migration rewrites runtime source only** (seed and test tooling keep the native
  client); non-SQLite datasources need their own driver adapter.

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
- **`LayoutAnimation` animates positions, not sizes**, takes the next DOM change as the commit,
  and skips pages over 3,000 elements. Snap props are CSS scroll snap.
- **`adjustsFontSizeToFit` shrinks the outer `Text` only** (a nested `Text` with its own
  `fontSize` keeps it) and needs a box to overflow (`numberOfLines` or a fixed size).
  `ellipsizeMode="head"` / `"middle"` work on one plain-text line only, and `onTextLayout`'s font
  metrics are estimated from the font size. An `Image` with `crossOrigin` / `referrerPolicy` is
  drawn as an `<img>`, which doesn't draw `tintColor`.
- **`reactNative` requires `mode: "spa"`.** Fast Refresh reloads on a new dependency import, an
  added or removed route or a lockfile change. Resolution variants (`@2x`) are picked at load.
- **Can't (no WebView or browser API):** `expo-gl` on a worklet / UI runtime
  (`getWorkletContext` is undefined) and camera textures (`createCameraTextureAsync` rejects):
  `GLView` is the page's WebGL 2. Barometer and pedometer readings, the carrier facts of
  `expo-cellular`, Low Power Mode, and attachments on `expo-sms` / `expo-mail-composer` (an
  `sms:` / `mailto:` URL cannot carry them) are not available.
- **Can't (the pinned plugin has no call for it):** `expo-calendar` attendees, looking an event
  up by id, opening one in the calendar app, changing a single occurrence or setting its time
  zone; `expo-contacts` containers and change events, and on Android an update keeps only names,
  company, job title, note, emails and phones (addresses, URLs, the birthday and the photo are
  dropped); `expo-print`'s `printToFileAsync` (HTML to PDF) and `selectPrinterAsync`; Android's
  system brightness and brightness mode in `expo-brightness` (no `WRITE_SETTINGS`; brightness
  listeners never fire). These reject with `ERR_UNAVAILABLE`.
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
  larger click is dropped, so denext refuses to post one. The runtime cannot list delivered
  notifications, so `deliveredNotifications()` there lists only what denext posted during this run
  and has not removed (a notification the user dismissed is still listed, one from an earlier run
  is not), and `threadId` does not group them in the OS. [Details](https://denext.dev/docs/desktop#desktop-notifications).
- **Linux sessions differ:** with no tray host `createTray` rejects `unsupported`; with a locked
  keyring no one can unlock, CEF stores cookies obfuscated, not OS-protected
  (`cookieEncryption: "basic"`). `denext desktop doctor --linux` lists what is missing
  ([details](https://denext.dev/docs/desktop#desktop-linux-session)).
- **CEF cookies on macOS are only obfuscated, not protected by the OS.** CEF runs with
  Chromium's mock keychain, whose key is a constant, so the cookie store on disk is encrypted with
  a key every copy of Chromium knows (`cookieEncryption: "basic"`, always): any process that can
  read the app's data directory can read its cookies. The macOS WebView backend (WKWebView) keeps
  cookies in WebKit's own store; Windows CEF uses DPAPI (`"os"`).
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
- **A CEF window on Windows can wait for slow proxy auto-detection.** On a network where WPAD / PAC
  discovery is slow, Chromium waits for the proxy configuration before it applies its loopback
  bypass, so the page's Live WebSocket (through the runtime's loopback relay) can take 10 s or more
  to connect at startup. The webview backend and macOS / Linux are unaffected.
- **CEF on Linux has no spellcheck unless the app ships its dictionaries** (runtime
  2.9.7-denext.11): the runtime makes no network requests of its own, so it no longer downloads
  Hunspell dictionaries from Google. Put the `.bdic` files in `<data dir>/CEF/Dictionaries` to
  turn spellcheck on for those languages. Windows and macOS use the OS spellchecker, unchanged.
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
- **No share sheet, Handoff, Spotlight or Touch Bar.** `react-native-windows` / `-macos` native
  modules don't run (write a desktop extension); their extra components are DOM stand-ins.
- **`denext desktop dev` runs under the `deno` CLI only;** with `--lan` the per-launch token is
  not injected, so token-gated features are refused.
