# denext — Roadmap

> Status: internal engineering tracker. **This file lists only work that still needs doing.**
> What shipped is in [CHANGELOG.md](./CHANGELOG.md); what denext can't or won't do is in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the standing guardrails and the security
> policy are in [POLICIES.md](./POLICIES.md). A shipped item is deleted, not annotated.
>
> denext **3.1** is in progress on `development`: Deno Desktop at Electron parity through a
> pinned runtime built from public forks ([Brainwires/deno](https://github.com/Brainwires/deno),
> [Brainwires/laufey](https://github.com/Brainwires/laufey)).

## Deno Desktop

- **Navigation guard:** keep foreign origins out of the window; a navigation away from the app
  origin opens in the system browser instead.
- **Upstream the fork so stock Deno can be used.** Offer every runtime change to denoland/deno
  and littledivy/laufey and maintain the pull requests (status per change in
  [our Deno Desktop runtime](https://denext.dev/docs/desktop-runtime#what-it-adds-over-stock-deno-desktop)).
  When stock Deno carries them, drop the runtime download, the Deno 2.9.7 pin and the cross-host
  backend directory (2.9.7's CLI looks a prebuilt backend up under the host's executable name),
  and archive the forks.
- **A Windows arm64 runtime** (none is built today).
- **A `deno desktop --inspect-renderer` spike** for `denext desktop dev`: CDP into the window,
  which `src/profile/browser.ts` already knows how to drive.

## Mobile and React Native

- **Android on a real device.** Every Android half (`denext/mobile`, the `denext mobile add`
  generators, React Native mode's shell-backed APIs, `mobile dev`, the storage plugin,
  `NativeViewSlot`'s `scrollPassthrough`) is compiled and unit-tested only, and the OTA plugin's
  Android template is compiled by hand, not in CI. The emulator comparison has Capacitor missing
  vsync on 67–70% of fling frames against React Native's 25–28%; run on a device (a device farm
  is an option), then profile the WebView list (layers, `content-visibility`) if the gap holds.
  No Android parity claim before that.
- **iPhone validation still to run:** the bottom safe-area inset and the example's button-row
  layout, biometrics with Face ID enrolled, native social login, a sandbox purchase, Sentry,
  background tasks and location, native modules, context menus, `<SystemIcon>`, font scale, the
  maps / video / symbols wiring of the Expo and community packages, and a migrated React Native
  app larger than `examples/expo-app` (T3 Code's).
- **List numbers:** the scroll-bench's emulator and iPhone runs, published in `/docs/lists`.
- **Accessibility:** move focus to the new screen on navigation; read bold text and grayscale
  from the OS (both read `false` today).
- **The remaining Expo shims:** `expo-battery`, `expo-sms`, `expo-intent-launcher`,
  `expo-video-thumbnails`, `expo-localization`, `expo-mesh-gradient`.
- **`denext migrate --from expo` advice** for the most-used native-only SDKs
  (`@react-native-firebase/*`, `react-native-iap`, `@stripe/stripe-react-native`), pointing at
  the [native SDK recipes](https://denext.dev/docs/native-sdk-recipes).
- **Capabilities:** background audio with lock-screen controls, multi-select and video image
  picking, file transfer with progress, a notification service extension and badges, SQLite
  encryption, a PowerSync recipe.
- **The parity ledger's React Native gaps:** the 32 `*Base` / `*Component` type aliases, the
  missing members (`AppRegistry`'s headless tasks and others, in
  `scripts/parity/native/baselines/known-gaps.json`), `AppState`'s `memoryWarning`,
  `Linking.sendIntent()`, `ActionSheetIOS.dismissActionSheet()`, and the lists'
  `renderScrollComponent`, `automaticallyAdjustKeyboardInsets` and LegendList `snapToIndices`
  (`lists.known-gaps.json`).
- **Importer-sensitive aliases in config,** so uniwind works without the `denext patch` recipe.
- **`denext profile --android`** over remote CDP; a Skia (CanvasKit) recipe; Tamagui / Unistyles
  verification.

## Auth

- **Passkeys / WebAuthn** over the adapter's credential tables.
- **A `next-auth` compat shim,** so a drop-in Next app that imports `next-auth` runs.
- **A standalone `denext/auth` subpath** (the surface lives in `denext/server` today).
- **OAuth `response_mode=form_post`:** a POST callback plus a `SameSite=None` transaction cookie.
  Apple needs it to hand over a user's name and email; the web `apple()` provider is
  `openid`-only until then.
- **An optional magic-link confirm page:** the GET renders a form that POSTs the token, closing
  link-scanner burns and login CSRF.
- **`totpQrSvg()`:** a dependency-free QR renderer for the `otpauth://` URI `enrollTotp` returns.
- **Richer events:** API-token issue / revoke events, a typed `signInFailed.reason` union, and
  `ip` on the other events (only `signInFailed` carries it).

## Server, ops and API surface

Each is documented as a manual recipe today (the
[production checklist](https://denext.dev/docs/production-checklist),
[multi-instance](https://denext.dev/docs/multi-instance) and
[route handler recipes](https://denext.dev/docs/route-handler-recipes) pages).

- **Shipped shared stores:** first-party Redis and Deno KV `CacheStore`, `SessionStore` and
  `RateLimitStore`, plus an exported adapter contract suite (`cacheStoreContract` from
  `denext/testing`) so a community adapter can prove itself.
- **`cors()` and `csrf()` API middlewares** for `createApi().use(...)`: an allowlist-driven
  preflight, and an origin / double-submit check for cookie-authenticated route handlers.
- **Task retries:** `defineTask({ retry: { attempts, backoff } })`, recorded in run history, with
  the overlap guard aware of a retrying run.
- **`denext generate migration | seed | ci`,** scaffolded the way `generate docker` is.
- **`denext upgrade`:** bump the `denext` pin, its CLI task and every first-party plugin together.
- **`denext routes`:** the app's pages and API routes as a table / `--json`.
- **CDN cache headers by default:** an ISR hit emits `public, s-maxage=<revalidate>,
  stale-while-revalidate=…`, with a config key to turn it off.
- **`global-error.tsx` hydration on the next-compat and static-export paths** (it hydrates on
  the native build and dev; elsewhere `reset` is inert).
- **`next/font/local` metric-matched fallback faces:** parse the local font's metrics (today
  `adjustFontFallback` on a local font emits no fallback face).
- **Node-stream `Writable` backpressure** for `renderToPipeableStream` /
  `renderToStaticNodeStream` (they buffer): make the core renderer pull-gated and resolve the
  `await allReady`-then-read deadlock the eager drain avoids. SSR-hot-path risk for a narrow
  payoff; `renderToReadableStream` is the primary path.
- **Deploy adapter API and presets:** a typed build manifest and a pluggable adapter seam
  (static export, Deno Deploy, Node, Docker; a documented seam for Workers / Vercel), on the
  plugin `addBuildStep` seam.
- **Generated clients in other languages** from the OpenAPI / GraphQL documents (TypeScript is
  served by `denext openapi types`).
- **CLI distribution:** publish the Homebrew / Scoop / winget manifests each release generates
  to a tap, a bucket and winget-pkgs; a Windows Arm64 `denext` binary.

## `denext ui` and DevTools

- **Agent control of `denext ui`:** an MCP front end over the UI's operations (every panel
  already answers a JSON twin).
- **Export the UI's form components** (`FormField`, `Control`, `Field`, `OpButton`, `Widget`)
  and retire the form renderer's remaining string API.
- **Per-element `__source`** for a true JSX owner stack (the panel shows the render-parent chain).
- **Profiler export / compare** across commits, plus component filters.
- **A Live / channel and state inspector tab** (subscriptions, channel pushes, cache entries).
- **On-demand snapshot pull** over the reload stream, so the MCP tools get a fresh tree.

## Router plugins

- **TanStack Start depth:** Start-style SSR through `plugin-kit`, as `@denext/react-router` did.
  The named unknown is the route tree, which TanStack generates with its Vite plugin; a Start
  plugin must own that generation. (Library mode already runs in SPA mode with no plugin.) A
  missing primitive goes into `plugin-kit` as a tested semver addition, never private surface.

## Build toolchain: waiting on `deno bundle`

`npm:esbuild` stays at build time because `deno bundle` exposes no plugin surface. The
next-compat and SPA-compat builds and the unbundled dev loop's dependency pre-bundle must
rewrite imports inside `node_modules` (the "two Reacts" fix) and run about 20 transforms
(`?url` assets, CSS shims, MDX, `use cache`, Node-builtin stubs, `import.meta.env`, pnpm
`catalog:`, Prisma externals, `jsr:` loading). The native App Router path already builds with
`deno bundle`. Deno 2.9.7 has neither hook below.

- **When `deno bundle` gets `--define`** ([denoland/deno#35347](https://github.com/denoland/deno/issues/35347),
  closed as completed, awaiting a release): add a capability probe to `probeBundleSupport`
  (`src/build/bundle.ts`), pass the esbuild `classDefine()` map and `__DENEXT_FEATURES__`
  verbatim, and retire `featureSeedBlock`. This folds the `__DENEXT_CLASS_COMPONENTS__` guards
  and lets `feature()` dead-code-eliminate in plain `.ts` modules on the native path (today it
  folds only in component modules there, and is a runtime read on the compat path). Degrade
  cleanly on older Deno.
- **When it gets a resolver / loader plugin API** (no committed issue yet): port
  `appResolverPlugin` / `denextRuntimePlugin` first, then the transforms one hook at a time;
  the compat e2es (`tests/e2e/next-compat-*`, `spa-compat`, `unbundled-*`) are the gate.
- **Not taking yet:** esbuild compiled to wasm as `@denext/esbuild`. It removes the npm download
  but runs several times slower on every compat build and dev session.
- **Maintenance:** track each vendored codec's upstream CVEs, rebuild SHA-256-pinned and
  regenerate its `THIRD-PARTY-LICENSES.md` before re-publishing.

## Docs

- **Make the deployment guide's Dockerfile byte-comparable** with what `denext generate docker`
  emits (the dependency-cache layer, least-privilege run flags, `PORT` vs `--port`), with a test
  that diffs the guide's fenced block against the template.
