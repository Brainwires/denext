# denext — Roadmap

> Status: internal engineering tracker. **This file lists only work that still needs doing.**
> What shipped is in [CHANGELOG.md](./CHANGELOG.md); what denext can't or won't do is in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the standing guardrails and the security
> policy are in [POLICIES.md](./POLICIES.md). A shipped item is deleted, not annotated.
>
> The current release is denext **4.1.0**; 4.x patch and minor releases are cut from
> `development`, and what each one added is in the changelog.

## 4.1.0: Limitations that can be lifted

Entries in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) that aren't forced by an OS, a browser
or an upstream. Each one's limitation entry is deleted when it ships.

- **Deno Desktop (runtime work):** CEF on macOS keeps cookies under a real Keychain key in a
  signed app, not Chromium's mock keychain; a share sheet (macOS `NSSharingServicePicker`,
  Windows `DataTransferManager`); Spotlight indexing and Handoff on macOS; icons and the
  destructive style in native context menus; `deliveredNotifications()` reads the OS's list on
  macOS and Windows; the CEF window on Windows bypasses proxy auto-detection for its loopback
  relay.

## Deno toolchain

- **Deno's next minor:** rebase denext's patches onto it and cut a new `-denext.N`. That release
  replaces Deno's TypeScript fork with stock TypeScript 6, so this rebase is larger than usual.

## Deno Desktop

- **A Windows Hello passkey ceremony in the release checks:** the Windows test machine is a
  Windows Server VM with no TPM, so the live create + sign-in with Windows Hello was skipped for
  3.1.0. Add a vTPM Windows 11 VM (or a Windows 11 PC) and run the CONTRIBUTING manual check.
- **Clerk on Windows and Linux against a production instance:** the redirect carries a per-flow
  `?denext_nonce=…`, which a development instance accepts against the allowed `myapp://app/`.
  Confirm with one real sign-in that a production instance's native redirect allowlist matches it
  too (an exact match would fail the sign-in closed).
- **Back to stock Deno once it carries the runtime changes.** Upstreaming them to denoland/deno
  and littledivy/laufey is the maintainer's own work, not tracked here. When stock Deno carries
  them, drop the runtime download, the Deno 2.9.7 pin and the cross-host backend directory
  (2.9.7's CLI looks a prebuilt backend up under the host's executable name), and archive the
  forks.
- **A Windows arm64 runtime** (none is built today).
- **A `deno desktop --inspect-renderer` spike** for `denext desktop dev`: CDP into the window,
  which `src/profile/browser.ts` already knows how to drive.

## Mobile and React Native

- **Android on a real device.** Every Android half (`denext/mobile`, the `denext mobile add`
  generators, React Native mode's shell-backed APIs, `mobile dev`, the storage plugin,
  `NativeViewSlot`'s `scrollPassthrough`) is compiled and unit-tested only, and the OTA plugin's
  Android templates are compiled and run in CI against JDK stand-ins for Android and Capacitor
  (`tests/ota-reverify.test.ts`), not built with Gradle there. The emulator comparison has Capacitor missing
  vsync on 67–70% of fling frames against React Native's 25–28%; run on a device (a device farm
  is an option), then profile the WebView list (layers, `content-visibility`) if the gap holds.
  No Android parity claim before that.
- **iPhone validation still to run:** the bottom safe-area inset and the example's button-row
  layout, biometrics with Face ID enrolled, native social login, a sandbox purchase, Sentry,
  background tasks and location, native modules, context menus, `<SystemIcon>`, font scale, the
  maps / video / symbols wiring of the Expo and community packages, and a migrated React Native
  app larger than `examples/expo-app` (a large real-world one).
- **List numbers:** the scroll-bench's emulator and iPhone runs, published in `/docs/lists`.
- **Accessibility:** move focus to the new screen on navigation; read bold text and grayscale
  from the OS (both read `false` today).
- **`denext migrate --from expo` advice** for the most-used native-only SDKs
  (`@react-native-firebase/*`, `react-native-iap`, `@stripe/stripe-react-native`), pointing at
  the [native SDK recipes](https://denext.dev/docs/native-sdk-recipes).
- **Capabilities:** background audio with lock-screen controls, multi-select and video image
  picking, file transfer with progress, a notification service extension and badges, SQLite
  encryption, a PowerSync recipe.
- **React Native 0.88 in the parity ledger:** the baseline is React Native 0.86.3; move it to
  0.88 once that is final (`REACT_NATIVE_PIN` in `scripts/parity/native/spec.ts`, the lists'
  `PINS`, `REACT_NATIVE_VERSION` in `src/react-native/platform.ts`), then refresh the baselines.
  Against `0.88.0-rc.4` the core and lists diffs already report no gaps.
- **A build-time `platform` constant** (`import { platform } from "denext/platform"`, folded to
  the target's name like `feature()`, so `if (platform === "ios")` is dead-code-eliminated per
  export). Platform-specific files cover the per-target code today, and `runtimePlatform()` the
  runtime branch; the constant needs a fold pass on every build path.
- **Platform files through tsconfig `paths`:** an import through a tsconfig `paths` alias does
  not take a variant (only `deno.json` and import-map aliases do); `denext migrate` converts
  `paths` to the import map.
- **Importer-sensitive aliases in config,** so uniwind works without the `denext patch` recipe.
- **`denext profile --android`** over remote CDP; a Skia (CanvasKit) recipe; Tamagui / Unistyles
  verification.

## Auth

- **A `next-auth` compat shim,** so a drop-in Next app that imports `next-auth` runs.

## React, Remix and SPA surface

- **`<ViewTransition>` callbacks and the rest of its surface:** `onEnter` / `onExit` /
  `onUpdate` / `onShare`, an `<Activity>` going hidden animated as an exit, and an update
  skipped when the boundary is off-screen.
- **A soft navigation streams `defer()` data per boundary,** as a document load does; today a
  client navigation's Flight payload waits for every deferred value.
- **A root layout rendered by client code hoists its `<head>` tags:** its
  `<title>` / `<meta>` / `<link>` are created again in the page container on hydration (the
  server hoisted them into the document head, and dev warns of the mismatch). Until then, put
  them in `metadata` or a Server Component layout.
- **SPA `client:interaction` replays the triggering event** on the mounted component, as a
  Flight island does; today the first interaction only mounts it.

## Server, ops and API surface

Each is documented as a manual recipe today (the
[production checklist](https://denext.dev/docs/production-checklist),
[multi-instance](https://denext.dev/docs/multi-instance) and
[route handler recipes](https://denext.dev/docs/route-handler-recipes) pages).

- **Shipped shared stores:** first-party Redis and Deno KV `CacheStore`, `SessionStore` and
  `RateLimitStore`, plus an exported adapter contract suite (`cacheStoreContract` from
  `denext/testing`) so a community adapter can prove itself.
- **Deploy adapter API and presets:** a typed build manifest and a pluggable adapter seam
  (static export, Deno Deploy, Node, Docker; a documented seam for Workers / Vercel), on the
  plugin `addBuildStep` seam.
- **Generated clients in other languages** from the OpenAPI / GraphQL documents (TypeScript is
  served by `denext openapi types`).

## `denext ui` and DevTools

- **Boot diagnosis, the last gaps:** follow import-map-resolved bare specifiers in the walk (so
  their link edges are checked too), and flag a name two `export *` sources both provide (an
  ambiguous export, a SyntaxError in browsers).
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

esbuild's plugin API (vendored, running the toolchain's esbuild binary — no longer `npm:esbuild`)
stays at build time because `deno bundle` exposes no plugin surface. The
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
