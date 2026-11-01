# denext — Roadmap

> Status: internal engineering tracker. **This file lists only work that still needs doing.**
> What shipped is in [CHANGELOG.md](./CHANGELOG.md); what denext can't or won't do is in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the standing guardrails and the security
> policy are in [POLICIES.md](./POLICIES.md). A shipped item is deleted, not annotated.
>
> The current release is denext **4.11.8**; 4.x patch and minor releases are cut from
> `development`, and what each one added is in the changelog.
>
> Two parts: **Before 5.0** is the work the 5.0 gate waits on (an item stays here until its branch
> lands, then it is deleted); the **5.x** sections are everything else, grouped by area, each with
> the reason it is not a 5.0 item.

# Before 5.0

## Runtime fork (Brainwires/deno, `3.0.0-denext.N`)

- **The CJS `require()` read bypass under BYONM** (a fork regression): fix it in `3.0.0-denext.4` and
  publish an advisory with it.
- **Runtime update and install checks:** a Windows update covers only PE files; the verify-then-swap
  race; revocation that fails soft; the macOS code-signing requirement. The Windows PE coverage is
  the Medium one; ship them with `denext.4`.
- **Tag and pin `3.0.0-denext.3`.** It carries V8 15.2.124.45 (two exploited-in-the-wild CVEs) and the
  merged fork items for sloppy hints, desktop bind calls and idle-trim wake-ups. Publish the V8
  advisory with the pin.
- **V8 on Extended Stable 15.6, and the staleness-gate rework.** 15.2 gets no more fixes, so the next
  exploited V8 bug would be unfixable there; the patch-bump dispatch workflow and the Extended Stable
  plus patch-age rule come with it. If it can't fit the 5.0 date it becomes the first dated 5.x item,
  and the release notes say so.
- **A CEF 156 build with Chrome's fixes from 156.0.8078.73 on.** Runtime `3.0.0-denext.7` moved CEF
  to 156 (Chromium 156.0.8078.48); the next runtime takes the newer build. The bump cadence is a 5.x
  item.
- **Embed the expected `denort` SHA-256 in the CLI.** Today the download checks `SHA256SUMS` only.
- **`.deno/npm-compat` out of the project root** (in `denext.4`): the runtime's type-check keeps its
  copy of the `@jsr/*` packages outside the project; then delete the KNOWN-LIMITATIONS entry.
- **Document** the blocking-pool cap (other holders of the pool) and that compiled binaries honour
  `DENO_LEGACY_ABORT` / `DENO_UNSTABLE_IDLE_TRIM`.
- **A one-commit re-pin runbook** (the pin, the symbols, the revert) before 5.0.

## Capacitor

- **Capacitor 8.6.0** (the pin and the examples; it clears the package-age hold on 10-30).

## Breaking changes for 5.0

- denext's runtime is required; the `DENEXT_DENO=stock` text in
  KNOWN-LIMITATIONS goes with it.
- The `@denext/auth` package and its follow-ups.

## Needs a device, hardware or credentials (the 5.0 gate lets each become a dated

KNOWN-LIMITATIONS entry)

- **A Windows Hello passkey ceremony in the release checks:** the Windows test machine is a
  Windows Server VM with no TPM, so the live create + sign-in with Windows Hello was skipped for
  3.1.0. Add a vTPM Windows 11 VM (or a Windows 11 PC) and run the CONTRIBUTING manual check.
- **Clerk on Windows and Linux against a production instance:** the redirect carries a per-flow
  `?denext_nonce=…`, which a development instance accepts against the allowed `myapp://app/`.
  Confirm with one real sign-in that a production instance's native redirect allowlist matches it
  too (an exact match would fail the sign-in closed).
- **Android on a real device.** Every Android half (`denext/mobile`, the `denext mobile add`
  generators, React Native mode's shell-backed APIs, `mobile dev`, the storage plugin,
  `NativeViewSlot`'s `scrollPassthrough`) is compiled and unit-tested only, and the OTA plugin's
  Android templates are compiled and run in CI against JDK stand-ins for Android and Capacitor
  (`tests/ota-reverify.test.ts`), not built with Gradle there. The emulator comparison has Capacitor missing
  vsync on 67–70% of fling frames against React Native's 25–28%; run on a device (a device farm
  is an option). No Android parity claim before that.
- **iPhone validation still to run:** the bottom safe-area inset and the example's button-row
  layout, biometrics with Face ID enrolled, native social login, a sandbox purchase, Sentry,
  background tasks and location, native modules, context menus, `<SystemIcon>`, font scale, bold
  text and grayscale (iOS and Android), the stacks' focus move under VoiceOver / TalkBack, the
  maps / video / symbols wiring of the Expo and community packages, and a migrated React Native
  app larger than `examples/expo-app` (a large real-world one).
- **The Expo SDK plugins on a device (iPhone and Android):** `DenextCalendar` (attendees, an
  event by id, one occurrence's changes and time zone, the event viewer and editor),
  `DenextContacts` (containers, change events, Android's full updates), `DenextPrint` (HTML to
  PDF, the printer picker, printing to a picked printer) and `DenextBrightness` (Android's system
  brightness and the `WRITE_SETTINGS` screen, iOS's change events) are compiled and type-checked
  only, Android's split of a repeating event from one occurrence on (`futureEvents` with
  `instanceStartDate`) included.
- **On a device:** encrypted key-value stores (`denext mobile add storage --encrypted`: SQLCipher
  linked into the iOS and Android builds, a store moved out of the plain database, its key in the
  Keychain / Keystore) and `PRAGMA key` through `@capacitor-community/sqlite`, background file
  transfers (`denext mobile add file-transfer`: a download that
  finishes with the app suspended or terminated, a pause and a resume, Android's WorkManager runs),
  background audio with the lock-screen / notification controls
  (`denext mobile add background-audio`: playback with the app backgrounded and the phone locked,
  the controls reaching the page, the Android foreground service), and `pickMedia`'s
  multi-select and video picks, on an iPhone and an Android phone; React Native Skia with
  Reanimated and inside the Capacitor shell's WebViews.
- **Signing the CLI and `denort`:** the workflow steps exist and warn without secrets; they wait on
  an Authenticode certificate.

# 5.x

Not blocking 5.0; each item says why.

## Supply chain (lifecycle-script jail)

- **GitHub-hosted declared downloads** (`bcrypt` 5, `argon2` before 0.28, `@discordjs/opus`,
  `libxmljs`): from denext.1 their declared host needs a grant, and a `knownPackages` entry can't
  cover GitHub's redirect to another host. Review them for `net` host lists in the built-in list.
  _Why 5.x: Low, and only legacy package versions hit it (`bcrypt` 5 already has advice)._
- **`Requires ffi access` in an install log.** `jailFailures` doesn't explain it yet: before denext.1
  (and where the OS can't confine) a jailed install check can't load the package's own native
  addon; say to leave the package unapproved. _Why 5.x: diagnostics only, and narrower once 5.0
  drops runtimes older than denext.1._

## Deno Desktop

- **Desktop hardening leftovers from the 4.8 packaging audit (all Low):**
  - A sidecar's child under the Deno CLI (`spawnSelf` from an app run with `deno run`) gets the
    parent's unscoped `--allow-*` but not `desktop.denoFlags` or `--unstable-*` flags given on the
    command line. _Why 5.x: Low, the CLI-dev path only._
  - A sidecar whose `run.exec` is one of the project's files bakes an unscoped `--allow-run` (its
    copy's path in the cache folder is only known at launch). Scope it once the runtime can take
    a launch-time path. _Why 5.x: needs a runtime launch-time path grant._
- **`requireBiometric` on Deno Desktop:** the desktop keychain items have no biometric access
  control, so the gate is in the page there; it needs a runtime capability (macOS
  `SecAccessControl`, Windows Hello) in the Brainwires/deno fork. _Why 5.x: a runtime capability
  plus a person at Touch ID / Hello; the gap is in KNOWN-LIMITATIONS._
- **Native bindings** (`denext desktop add native`). _Why 5.x: a new feature, no code yet._
- **Native passkey rows:** a step-up of a pending native sign-in, and list / delete. _Why 5.x: a
  fixable gap on a new surface._
- **Distro coverage** of the packaged runtime (a Wayland headless leg, a Fedora rpm smoke test, a
  `NEEDED` check). _Why 5.x: coverage work, no known failure._
- **The AppImage non-exchange swap fallback window** (a documented risk). _Why 5.x: Low._
- **WKWebView passkey refusal latency** (laufey). _Why 5.x: slow, not wrong._

## Mobile and React Native

- **Profiling the WebView list on a device** (layers, `content-visibility`) if the Android fling gap
  holds once it is measured. _Why 5.x: follows the device run above._
- **List numbers:** the scroll-bench's emulator and iPhone runs, published in `/docs/lists`.
  _Why 5.x: docs; the docs have SSR and desktop numbers only._
- **Capabilities:** a notification service extension and badges. _Why 5.x: a new capability._
- **A device check of the OTA isa-swap runtime.** _Why 5.x: needs a device._

## Backend (`@denext/backend`)

Low findings of the 4.8 backend audit (realtime and storage):

- **Realtime: a reconnect that finds a new subscription** (swept, or another instance) is
  detected by the client only after 10 seconds of silence. Let the client mark a re-subscribe,
  so the server answers one that recreated the subscription with an explicit `resync`.
  _Why 5.x: Low, latency only._
- **`@prisma/adapter-mssql` against a live SQL Server** (or a CI service container). _Why 5.x: a
  test gap on an adapter that is wired and unit-tested._

## Framework compatibility surfaces

- **`@denext/graphql` reloads only a schema it can trace.** _Why 5.x: dev-server restart works._
- **Fresh partial navigation:** `f-view-transition`, region history replay and the rest listed in
  KNOWN-LIMITATIONS. _Why 5.x: fixable gaps, none blocking._
- **Preact compat:** `createFactory`, `findDOMNode`, `isFragment`, `isMemo`,
  `unmountComponentAtNode`, callbacks, the precompile JSX helpers and render-to-string streaming
  (the parity gate lists them). _Why 5.x: small, independent gaps._
- **One-bundle (iso) routes keep the page on an action signal.** _Why 5.x: documented in
  KNOWN-LIMITATIONS._

## Build toolchain: waiting on `deno bundle`

esbuild's plugin API (vendored, running the toolchain's esbuild binary — no longer `npm:esbuild`)
stays at build time because `deno bundle` exposes no plugin surface. The
next-compat and SPA-compat builds and the unbundled dev loop's dependency pre-bundle must
rewrite imports inside `node_modules` (the "two Reacts" fix) and run about 20 transforms
(`?url` assets, CSS shims, MDX, `use cache`, Node-builtin stubs, `import.meta.env`, pnpm
`catalog:`, Prisma externals, `jsr:` loading). The native App Router path already builds with
`deno bundle`, and where `deno bundle --define` exists (denext's Deno toolchain from runtime
`3.0.0-rc.1`; probed, so an upstream release with the flag is picked up too) it defines the
class-component gate and the `features` map instead of seeding them; a stock Deno keeps the
seeded fallback. No Deno has the hook below yet.

- **When it gets a resolver / loader plugin API** (no committed issue yet): port
  `appResolverPlugin` / `denextRuntimePlugin` first, then the transforms one hook at a time;
  the compat e2es (`tests/e2e/next-compat-*`, `spa-compat`, `unbundled-*`) are the gate.
  _Why 5.x: the fork could own the hook now, but it is large and unscheduled._

## Server and CLI features

- **The 4.10 set** (the runtime items are merged in the fork, waiting on the `denext.3` pin):
  `HTMLRewriter`, `resolveCertificate`, the cookie jar and `patchedDependencies`. _Why 5.x: new
  features; they ship after the pin._
- **A compiled binary disarms baked limits for `job` / `db`** (depends on `compile.limits`). _Why
  5.x: follows `compile.limits`._
- **TypeScript 7.1 stable swap** and the `ts7-lsp-default` setting. _Why 5.x: date-driven (about
  11-24); 5.0 only if it ships after that._
- **Workflow bootstrap versions:** the workflows use Deno 2.9.6 only as a bootstrap; close as by
  design or document it. _Why 5.x: no user impact._
- **spa-dev-self-write's 700 ms settles** (a test). _Why 5.x: test flake._
- **expo-app's zod / decode-uri-component highs** (example only; fixed by Expo SDK 58). _Why 5.x:
  upstream._

## Runtime fork

- **A Windows console close, logoff or shutdown cuts the drain short** (the handler may block about
  5 s for CLOSE and longer for SHUTDOWN). _Why 5.x: fixable only in part._
- **V8 cadence:** the next major (16.0, about 12-15) and patch bumps, once the Extended Stable line
  exists. _Why 5.x: recurring._
- **CEF bump cadence** after the one 5.0 bump. _Why 5.x: no owner yet._
- **Crash reporting for the server and runtime rollback / revocation.** _Why 5.x: new tooling._
- **Bit-level reproducible runtime builds** (floating setup-deno / brew / apt, rust-cache on tags).
  _Why 5.x: Low._
- **The Windows CI Deno children hang, root cause** (an npm_installer flag lock and a cache_db
  mutex). _Why 5.x unless it recurs._
- **Node compatibility, continuing:** `node:test`, `async_hooks`, TLS, CLI flags, HTTP edge cases,
  the ESM loader, `worker_threads`, `fs`, `crypto`, `stream/iter`, `child_process`, the compile
  cache, `repl` / inspector, Node 26 experimental APIs (per-cluster counts in the fork's gap list).
  _Why 5.x: a continuous track with no 5.0 promise._
- **Upstream carries:** the npm side-effects cache, deterministic mode (seeded `randomInt` /
  `randomFillSync` first: a correctness bug under `--seed`, and cheap), the `deno compile` `--`
  warning, native image operations. _Why 5.x: separate runtime features._
- **`SafeSet` copy-constructor hang, Jest cross-realm rows, the Windows `cmd.exe` branch, and the 15
  Linux-only enabled node tests that need a macOS / Windows check.** _Why 5.x: Small, no user
  report._
