# denext — Roadmap

> Status: internal engineering tracker. **This file lists only work that still
> needs doing.** Completed work lives in [FEATURES.md](./FEATURES.md) and
> [CHANGELOG.md](./CHANGELOG.md); honest gaps in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the mission + its superiority
> pillars in [MISSION.md](./MISSION.md); the standing engineering guardrails and
> the security policy in [POLICIES.md](./POLICIES.md).
>
> `development` is building **2.11**: denext as a React Native / Expo
> replacement (React Native mode's shell-backed overlay, lists on `VirtualList`,
> `denext/navigation`, the Tier 1 and Tier 2 platform capabilities, store
> tooling, the app backend) and its desktop twin (the Deno Desktop capability
> bridge). What shipped is in the `[Unreleased]` section of
> [CHANGELOG.md](./CHANGELOG.md) and in
> [REACT-NATIVE-EXPO.md](./REACT-NATIVE-EXPO.md); what is left for 2.11 final is
> the "2.11" section below. Beyond it: the next-minor candidates (carried since
> 2.5), the last build-time-purity item, the TanStack Start depth of the router
> plugins, and the unscheduled candidates. Items target the next minor unless
> marked otherwise; this file is rewritten each cycle.

---

## Build-time deps → first-party JSR/WASM

Reducing the build-time npm surface (build-time only, so the zero-npm
**runtime** claim already holds regardless). **`lightningcss` and `swc` are
done** — replaced by first-party `@denext/lightningcss` + `@denext/swc` (JSR,
built via `wasmbuild` from the core crates; see CHANGELOG). What remains npm at
build time: **`esbuild`** (the item below) plus the opt-in `sass` /
`@mdx-js/mdx` / `ws`.

- **`esbuild`** stays until Deno grows the bundler hooks it stands in for — see
  _Upstream watch_ below for what exactly we are waiting on. The Deno-native
  binder path for anything else is proven: **Rust codecs** →
  [`denoland/wasmbuild`](https://github.com/denoland/wasmbuild) (`wasm-bindgen`
  glue, the `@denext/photon` / `@denext/lightningcss` / `@denext/swc` recipe);
  **C codecs** → a WASI/Component-Model component +
  [`jco transpile`](https://bytecodealliance.github.io/jco/transpiling.html).
- **Standing discipline:** track each vendored codec's upstream CVEs, rebuild
  SHA-256-pinned (like the Tailwind binary), and regenerate its
  `THIRD-PARTY-LICENSES.md` before re-publishing — Pillar 2 in maintenance form.

## Ecosystem router plugins

The plugin contract is **settled**: a router-class plugin imports from exactly
two places — `@denext/denext` (app API) and `@denext/denext/plugin-kit`
(contract seams + pipeline primitives: matchers, `bundleRoutes`, CSS, hydration
/ Fast-Refresh, `PageCache`). `@denext/pages-router` and `@denext/react-router`
dogfood it (both **shipped**; react-router is framework mode via the
route-synthesizer seam) and `tests/plugin-kit.test.ts` guards it. Remaining
build work:

- **TanStack Router, Start depth** — library mode is served: a stock file-based
  TanStack Router app runs in SPA mode with no plugin
  (`examples/tanstack-router`, the shape `denext migrate` writes), so no
  `@denext/tanstack-router` package at that depth (a package wrapping zero seams
  would be API surface with no payoff). What remains is TanStack Start-style SSR
  through `plugin-kit`, the same shape `@denext/react-router` proved out; its
  named unknown is the route tree, which TanStack generates with its Vite plugin
  (`routeTree.gen.ts`) — out-of-band `tsr generate` covers library mode, a Start
  plugin must own the generation.
- A missing primitive goes into `plugin-kit` (the plugin-kit rule: a deliberate,
  tested semver addition — as `apiDefinitionOf`, `tapChannel`, `verifyOrigin`
  and `remixCodegen` were), never the private surface.

## Upstream watch — `deno bundle` hooks (the last npm build tool)

**Standing watch item, not keystone work.** One dependency and one small polish
item share a single cause: `deno bundle` — esbuild under the hood — exposes none
of esbuild's plugin surface. Until it does, denext keeps `npm:esbuild` at build
time and the native path cannot fold a few runtime guards to literals. Neither
touches the zero-npm **runtime** guardrail; both are build-time.

- **Why `esbuild` is still here.** The next-compat and SPA-compat builds (apps
  that bring npm React: Next drop-ins, Vite migrations) and the unbundled dev
  loop's `@dep` pre-bundle must rewrite imports **inside `node_modules`**, not
  just in the app's own files. An import map — which `deno bundle --import-map`
  honours — reaches only the app's bare specifiers; when an npm library does its
  own `import "react"`, Node resolution hands it the real React and the page
  runs two Reacts. esbuild resolver plugins (`appResolverPlugin`,
  `denextRuntimePlugin` in `src/build/next-compat.ts`) redirect
  `react`/`react-dom`/`next/*` for every module in the graph — the "two Reacts"
  fix FEATURES.md describes. The same plugin seam then grew the transforms the
  compat path needs and `deno bundle` has no hook for: Vite `?url`/asset
  imports, the CSS shim redirect, MDX compile, the `"use cache"` transform,
  Node-builtin browser stubs, `import.meta.env` defines, pnpm
  `catalog:`/`workspace:` resolution, Prisma externals, and the Deno loader for
  `jsr:` specifiers (~20 plugins). The native App Router path needs none of this
  and already builds with `deno bundle`, npm-free.
- **What `--define` would still buy on native builds (small).** The size problem
  this section once tracked — the class runtime and the devtools bridge always
  shipping on native builds because their `classComponents` define-fold needs
  `--define` — is **solved without it**: both are import-gated behind
  entry-emitted installs (2.1.0-rc.3, −5.7 KB on the shared chunk;
  `tests/integration/build-smoke.test.ts` asserts the markers are absent) and
  the class runtime is an on-demand chunk loaded only when the server stamped
  `#__denext_classes` (2.4.0). What remains define-dependent is bytes, not KB:
  the `__DENEXT_CLASS_COMPONENTS__` guards in the reconciler read a runtime
  global on native instead of folding to a literal, and the `denext/feature`
  fold reaches only component modules there (a `feature()` call in a plain `.ts`
  util is seeded correctly via `globalThis.__DENEXT_FEATURES__` but not
  dead-code-eliminated). The compat/SPA esbuild paths fold both. A polish item,
  not a size win.
- **What we are waiting for, in order of how much it unblocks.** (1) A
  **resolver/loader plugin API** for `deno bundle` (or a package-wide alias that
  applies inside npm packages) — that alone retires `npm:esbuild` for the alias
  half and lets the source transforms be ported one hook at a time; (2)
  **`--define`** — folds the residual native guards above. Status (re-verified
  2026-09-13): **Deno 2.9.6** has neither. `--define` is tracked in
  [denoland/deno#35347](https://github.com/denoland/deno/issues/35347), closed
  as completed 2026-06-19 and awaiting a release — a _when_. A plugin API has no
  committed issue; watch the `deno bundle` release notes.
- **The fallback we are not taking yet.** esbuild compiled to wasm and published
  as `@denext/esbuild` (the `@denext/swc` recipe) would remove the npm download
  today, but runs several times slower than the native binary on every compat
  build and every unbundled dev session — a hygiene win paid for in DX. Revisit
  only if the plugin API stalls for a long time or a wasm build closes the speed
  gap.
- **Action when `--define` lands.** Add a `denoBundleSupportsDefine()`
  capability probe (extend `probeBundleSupport` in `src/build/bundle.ts`) and
  pass `--define __FLAG__=…`, **reusing the esbuild `classDefine()` map and the
  `__DENEXT_FEATURES__` define verbatim** (`src/build/next-compat.ts`) so both
  bundlers share one flag-authoring pattern; the `featureSeedBlock` in
  `bundle.ts` then becomes redundant on Deno versions that fold. The probe must
  degrade cleanly on older Deno — never break a build.
- **Action when plugins land.** Port `appResolverPlugin`/`denextRuntimePlugin`
  first (the alias half is small and is the whole "two Reacts" fix), keep
  esbuild for the remaining transforms, then move those one hook at a time; the
  compat e2es (`tests/e2e/next-compat-*`, `spa-compat`, `unbundled-*`) are the
  gate.

## Next-minor candidates (carried since 2.5)

**Auth:**

- **Passkeys / WebAuthn** over the adapter's credential tables.
- A **`next-auth` compat shim** so a drop-in Next app that imports `next-auth`
  runs.
- A standalone **`denext/auth` subpath** (today the surface lives in
  `denext/server`).
- **OAuth `response_mode=form_post`** — a POST callback plus a `SameSite=None`
  transaction cookie for it (a `Lax` cookie never rides a cross-site POST, so
  the callback would always fail `invalid_state`). It is what Apple needs to
  hand over a user's name and email; Apple stays `openid`-only until then.
- **An optional magic-link confirm page**: the GET renders a form that POSTs the
  token, closing link-scanner burns and login CSRF.
- **`totpQrSvg()`** — a dependency-free QR renderer for the `otpauth://` URI
  `enrollTotp` / `totpAuthUri` return (2.5 ships the URI, not the picture).

- **Richer events**: API-token issue/revoke events, a `signInFailed.reason`
  union, and an `AuthEvents.ip` for audit trails.

**Server, ops and API surface** (each gap is documented today rather than filled
— the [production checklist](https://denext.dev/docs/production-checklist),
[multi-instance](https://denext.dev/docs/multi-instance) and
[route handler recipes](https://denext.dev/docs/route-handler-recipes) pages say
what to do by hand):

- **Shipped shared stores** — first-party Redis and Deno KV implementations of
  `CacheStore`, `SessionStore` and `RateLimitStore`, plus an **exported adapter
  contract suite** (the test cases `sqliteCacheStore` / `sqliteSessionStore` /
  `sqliteAuthAdapter` already pass, runnable against a third-party store:
  `import { cacheStoreContract } from
  "denext/testing"`) so a community
  Postgres/Redis adapter can prove itself.
- **`cors()` and `csrf()` API middlewares** for `createApi().use(...)` — an
  allowlist-driven preflight + response headers, and an origin/double-submit
  check for cookie-authenticated plain route handlers (the Server Action and
  batch endpoints already enforce same-origin; a hand-written `route.ts` does
  not).
- **Task retries** — `defineTask({ retry: { attempts, backoff } })`, with the
  attempt recorded in run history and the overlap guard aware of a retrying run.
- **`denext generate migration|seed|ci`** — the SQL-file migration runner task,
  a seed verb and a GitHub Actions workflow, scaffolded the way
  `generate docker` is (the database and testing guides carry them as copy-paste
  today).
- **`denext upgrade`** — bump the `denext` pin, its CLI task and every
  first-party plugin together, then print the Upgrading-guide section for the
  crossed versions.
- **`denext routes`** — the app's pages + API routes as a table / `--json` (the
  MCP server's `denext_list_routes` has the data; the verb is missing).
- **CDN cache headers by default** — an ISR page hit emits no `Cache-Control`;
  emit `public, s-maxage=<revalidate>, stale-while-revalidate=…` (and
  `private, no-store` stays on dynamic pages) so a CDN in front caches without a
  `headers()` rule, with a config key to turn it off.

**`denext ui`:**

- **Export the UI's form components** (`FormField`, `Control`, `Field`,
  `OpButton`, `Widget`) and retire the form renderer's remaining string API.

**DevTools:**

- **Per-element `__source`** (a true JSX owner stack instead of the
  render-parent chain).
- **Profiler export / compare** across commits, plus component filters.
- A **Live / channel + state inspector** tab (subscriptions, channel pushes,
  cache entries).
- **On-demand snapshot pull** over the reload stream, so the MCP tools can ask
  for a fresh tree instead of reading the last pushed one.

**Docs:** align the [deployment guide](https://denext.dev/docs/deploy)'s
hand-written Dockerfile with what `denext generate docker` emits — the
dependency-cache layer, the least-privilege run flags, and `PORT` vs `--port`
differ today. The guide now points at the generator as the source of truth; the
remaining work is making the two byte-comparable (a test that diffs the guide's
fenced block against the template would keep them that way).

## 3.0

- **Agent control of `denext ui`** — an MCP front end over the UI's operations.
  Every panel already answers a JSON twin built for exactly this (the two file
  writers answer `{ ok, applied, diff }`; the others answer their own panel's
  shape — see [the Project UI guide](https://denext.dev/docs/ui)), so the wire
  would not have to change. Committing to an agent-driveable write surface is a
  3.0 decision, not a 2.6 one.

## 2.11: React Native / Expo replacement

Measured against React Native's core exports, the Expo SDK 57 packages, the most-used
third-party libraries and T3 Code's React Native app; rendering stays WebView (native rendering
is out of scope, React Native APIs and apps are not: see
[POLICIES.md](./POLICIES.md#engineering-guardrails)). The full status, including which items
ran on an iPhone, is [REACT-NATIVE-EXPO.md](./REACT-NATIVE-EXPO.md).

**Done on `development`** (see CHANGELOG `[Unreleased]`): React Native mode's shell-backed
overlay and the core exports react-native-web lacks, `Platform.select` / `Platform.constants`,
RN-mode safe areas, Reanimated worklets without Babel, lists on `VirtualList` (FlatList,
SectionList, VirtualizedList, FlashList, LegendList), expo-router and React Navigation
navigators on `denext/navigation`, the community-package alias table, the Expo shim round
(import-safe tracking-transparency / maps / `@expo/ui`, `expo-application`, image and camera
statics, auth-session providers), `react-native-windows` / `react-native-macos` (and
`reactNative.desktopPackage`), the parity gate measuring the real bundle, a real-browser
expo-router 57 test of the navigators; `VirtualList` / `VirtualMasonry` / `useVirtualReorder`;
`denext/navigation` (`StackLayout`, `TabsLayout`, `Sheet`); the platform capabilities (keyboard,
back, system bars, safe areas v2, dialog, permissions, local notifications, biometrics, social
login, geolocation, background location, purchases, app review and update, orientation, media
library, privacy screen, tracking, background tasks, process-death restore, screen reader
state, application, toast, action sheet; `readSafeAreaInsets` / `watchSafeAreaInsets`); store
tooling (privacy manifest, `mobile doctor --store | --release`, offline screen, Sentry,
`mobile inspect`); the app backend (`cors`, native sessions, native Sign
in with Apple / Google, account deletion, `createApiClient({ base, auth })`, `sendPush`, OTA
channels, `appLinks`); your own native code (`nativeModule`, `denext mobile add
native-module`, TurboModules / NativeModules / Expo modules reaching it) and native views
(`NativeViewSlot`, `native-views` / `native-map`, `scrollPassthrough`) with `expo-maps`,
`react-native-maps`, `expo-video` and `react-native-video` routed to them and `expo-symbols` to
`<SystemIcon>`; durable storage (`openKeyValueStore`, AsyncStorage / MMKV); React Native mode
Fast Refresh; `denext mobile assets | build | submit`; the native look (platform theme,
`<SystemIcon>`, native context menus); font scale, route announcements and `useReducedMotion`;
Reanimated on the compositor and `LayoutAnimation`; the Expo shims over the capabilities
(store-review, screen-orientation, navigation-bar, screen-capture, media-library); the core
names that failed the build (`DrawerLayoutAndroid`, `Settings`, `ProgressBarAndroid`,
`TouchableNativeFeedback`, `Image.resolveAssetSource`), `onContentSizeChange`, `@2x` / `@3x`
variants and snap props; the Deno Desktop runtime (fs, sqlite, device, dialogs, shell,
keep-awake, secure-store, extensions), `denext desktop add` and least-privilege packaging
(`denext desktop package --regenerate-scripts` for older projects).

**Open for 2.11 final:**

- **Deno Desktop, the rest of the plan:** the app menu, the navigation guard, single instance,
  tray, global shortcuts, launch at login; runtime capabilities for context menus (needs an
  upstream dismiss event), the clipboard and notifications (scheduling, click routing); a
  Windows `secureStore` backend; real-window runs of the capabilities on each OS.
- **iPhone items not yet validated:** the bottom safe-area inset and the example's button-row
  layout (fixes in progress), biometrics with Face ID enrolled, native social login, a sandbox
  purchase, Sentry, background tasks and background location, and the round-3 items built but
  not run on the phone (native modules, context menus, `<SystemIcon>`, durable storage, font
  scale, the maps / video / symbols wiring of the Expo and community packages).
- **List numbers:** the scroll-bench's emulator and iPhone runs, published in `/docs/lists`.
- **Android on a real device.** The emulator comparison (2026-09-25, REACT-NATIVE-EXPO.md gap 5)
  has Capacitor starting in under half the time and using less memory, but missing vsync on
  67–70% of fling frames against 25–28% for React Native. Every Android capability half is built
  and unit-tested only. Hardware is the blocker (a device farm is an option); no Android parity
  claim before a device run, then profile the WebView list if the gap holds.

**Later (after 2.11):**

- Focus management on navigation (move focus to the new screen), and bold text / grayscale
  from the OS.
- The remaining backable Expo shims: `expo-battery`, `expo-sms`, `expo-intent-launcher`,
  `expo-video-thumbnails`, `expo-localization`, `expo-mesh-gradient`.
- `denext migrate --from expo` advice for the native-only SDKs apps use most
  (`@react-native-firebase/*`, `react-native-iap`, `@stripe/stripe-react-native`), pointing at
  the [native SDK recipes](https://denext.dev/docs/native-sdk-recipes).
- Background audio with lock-screen controls, multi-select / video image picking, file transfer
  with progress, a notification service extension and badges, SQLite encryption and a
  PowerSync recipe.
- `denext profile --android` over remote CDP. (`denext mobile build` / `assets` / `submit`
  shipped: https://denext.dev/docs/mobile-build.)
- A Skia (CanvasKit) recipe; Tamagui / Unistyles verification.
- The parity ledger's React Native gaps: the `*Base` / `*Component` aliases, the missing
  members (`UIManager.dispatchViewManagerCommand` / `getViewManagerConfig`,
  `AppRegistry.registerHeadlessTask` and others), and the lists' `renderScrollComponent`,
  `automaticallyAdjustKeyboardInsets` and LegendList `snapToIndices` props.

## Candidate features (from the framework-gap survey)

Vetted gaps vs Next/Nuxt/Astro/SvelteKit/TanStack (the three picks that shipped
— scheduled tasks, type-safe routing, `@denext/content-collections` — are in
CHANGELOG/FEATURES). The rest are kept here so they aren't lost; not yet
scheduled.

- **Dev server attach for desktop apps (the Metro model).** ~~A packaged desktop
  window should be able to attach to `denext dev` and get HMR, the way a React
  Native app attaches to Metro.~~ **Shipped** (see CHANGELOG). The phone half
  shipped first (`allowedDevOrigins`, `denext dev --lan`, an explicit `--host`
  allowing what it binds, and `denext mobile dev` for Capacitor live reload);
  the desktop half is now `denext desktop dev`:
  - **`denext desktop dev`** — a window whose runtime reverse-proxies EVERYTHING
    (HTTP + HMR) over loopback to the dev server (reusing
    `src/build/dev-proxy.ts`), so `location.origin` stays loopback and neither
    the CSP nor the origin gate has to be relaxed. Proxy mode is reachable only
    through the dev-only `DENEXT_DESKTOP_DEV_URL` env seam this verb sets; the
    token-gated `/_denext/desktop/*` endpoints are never proxied; the per-launch
    token is stripped before proxying; the target is loopback-only unless `--lan`;
    and an attached dev server is left running on exit.
  - **The dev-vs-release packaging permission split** is resolved by the proxy
    design: the window needs net to the loopback dev port only, which a migrated
    SPA's `deno task desktop` already bakes (`--allow-net=127.0.0.1,localhost`),
    so `denext desktop dev` widens no permission over it. (The scaffolded
    packaging scripts now derive their flags from `desktop.capabilities`
    instead of `-A`.)
  - Optional (still open): a spike on `deno desktop --inspect-renderer` (CDP into
    the window, which `src/profile/browser.ts` already knows how to drive).
- **Deploy adapter API + presets** (the larger, separate bet — Nitro / Next 16
  Adapters): a typed build manifest (routes, prerenders, assets, cache rules) +
  a pluggable adapter seam with first-party presets. Achievable targets for a
  Deno-native framework: **static export, Deno Deploy, Node (deno node-compat),
  Docker**, with a documented third-party seam for Workers/Vercel. Highest
  ecosystem value, largest effort, one real Deno-fit tension (Workers runs
  workerd, not Deno). Builds on the existing plugin `addBuildStep` seam.

## Later (unscheduled)

- **Windows desktop installers + signing** — an installer (`setup.exe`) and Authenticode
  signing for `deno desktop` bundles, so Smart App Control trusts them. denext apps ship no
  node-gyp / native deps, so signing the one executable (and the installer) is enough. The
  packaging scripts in `examples/native/scripts` need their scaffold regeneration kept
  byte-identical first.

- Generated clients for **non-denext consumers** in **other languages** from the
  OpenAPI/GraphQL documents. TypeScript consumers are served:
  `denext openapi types` emits an import-free `ApiSchema` that
  `createApiClient<ApiSchema>({ base })` from JSR types from any project, so no
  fetch wrapper is generated for TS.
- **Node-stream `Writable` backpressure** for `renderToPipeableStream` /
  `renderToStaticNodeStream` (they buffer today — the first entry in
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)): make the core renderer
  pull-gated and resolve the `await allReady`-then-read deadlock the current
  eager drain avoids. An SSR-hot-path change with real regression risk and a
  narrow payoff; `renderToReadableStream` is the primary path.
