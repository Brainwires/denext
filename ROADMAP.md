# denext — Roadmap

> Status: internal engineering tracker. **This file lists only work that still needs doing.**
> What shipped is in [CHANGELOG.md](./CHANGELOG.md); what denext can't or won't do is in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the standing guardrails and the security
> policy are in [POLICIES.md](./POLICIES.md). A shipped item is deleted, not annotated.
>
> The current release is denext **4.3.1**; 4.x patch and minor releases are cut from
> `development`, and what each one added is in the changelog.

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
- **List numbers:** the scroll-bench's emulator and iPhone runs, published in `/docs/lists`.
- **Capabilities:** a notification service extension and badges.
- **On a device:** encrypted key-value stores (`denext mobile add storage --encrypted`: SQLCipher
  linked into the iOS and Android builds, a store moved out of the plain database, its key in the
  Keychain / Keystore) and `PRAGMA key` through `@capacitor-community/sqlite`, background file
  transfers (`denext mobile add file-transfer`: a download that
  finishes with the app suspended or terminated, a pause and a resume, Android's WorkManager runs),
  background audio with the lock-screen / notification controls
  (`denext mobile add background-audio`: playback with the app backgrounded and the phone locked,
  the controls reaching the page, the Android foreground service), and `pickMedia`'s
  multi-select and video picks, on an iPhone and an Android phone.
- **`denext profile --android`** over remote CDP; a Skia (CanvasKit) recipe; Tamagui / Unistyles
  verification.

## `denext ui` and DevTools

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
