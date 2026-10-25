# denext — Roadmap

> Status: internal engineering tracker. **This file lists only work that still needs doing.**
> What shipped is in [CHANGELOG.md](./CHANGELOG.md); what denext can't or won't do is in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the standing guardrails and the security
> policy are in [POLICIES.md](./POLICIES.md). A shipped item is deleted, not annotated.
>
> The current release is denext **4.8.0**; 4.x patch and minor releases are cut from
> `development`, and what each one added is in the changelog.

## Deno toolchain

- **Deno's next minor:** rebase denext's patches onto it and cut the next `3.0.0-rc.N`. That release
  replaces Deno's TypeScript fork with stock TypeScript 6, so this rebase is larger than usual.
- **Toolchain audit (4.8) low-severity follow-ups:**
  - The Windows `toolchain link` shim writes `"<deno>" %*`: a `%` in the toolchain's path is
    expanded by cmd. Double each `%` when writing it (and when reading it back).
  - `toolchain link` / `unlink` on macOS and Linux take a link as denext's when its target merely
    starts with the cache root's path (`…/denext-deno-other/…` counts). Compare up to a separator.
  - `build --compile --sign` with signtool passes the `.pfx` password as `/p <password>` on the
    command line, where an administrator's process listing can read it. Sign by thumbprint after
    importing the `.pfx` into the user's store instead.
  - With neither `HOME` nor `USERPROFILE` set, `DENO_DIR` falls back to the working directory, so a
    checked-out repository could ship a toolchain binary and a stamp that vouches for it. Refuse,
    or use a per-user directory under the system temp directory.
  - The installers check the archive against `SHA256SUMS` from the same release: integrity, not
    authenticity. Verify the release's build attestation (or a signature) too.
  - A relative `DENO_BIN` resolves against the child's working directory (`build --compile` runs
    in the project), unlike `DENEXT_DENO`, which is made absolute. Resolve it when read.
  - The compile directory's `.npmrc` copy gets mode 0600 only when it is created; rewrite an older
    copy's mode too.
  - The never-embedded walk of `build --compile` does not follow symlinks, while `deno compile
    --include` may embed what a symlinked directory holds: check what it embeds, and exclude
    `.env` files and databases behind a link too.

## Supply chain (lifecycle-script jail)

Low findings from the 4.8 supply-chain audit:

- **`denext add` leaves an exception behind when `deno add` fails.** The exceptions go into
  deno.json before `deno add` runs its scripts; put the file back when the add exits non-zero.
- **Other `@denext` exemptions from the dependency-age hold go unnoticed.** `doctor` and `upgrade`
  look for the literal `"jsr:@denext/*"` denext once wrote; flag `"jsr:@denext/denext"` and other
  `@denext` entries too (denext never writes them).
- **The user-level `~/.npmrc`.** The runtime reads `jail-scripts` / `paranoid` from it too;
  `readJailSetting` reads only the project's `.npmrc` and the environment.
- **From runtime `3.0.0-rc.6` a packages-only `jailScripts` object no longer asks for the jail**
  (DENEXT.md item 108). `readJailSetting` still counts it as on, so next to `jail-scripts=false`
  denext writes exceptions and `doctor` flags missing ones for a jail that is off.
- **Narrow existing exceptions on the move to rc.6.** A built-in entry already configured as
  `net: true` stays so; `doctor` (or `upgrade`) could offer the host list and the `~` cache.
- **npm (`package.json` `workspaces`) members** are not read for dependencies; only a deno.json
  `workspace` is.
- **An unknown package's network failure** is pointed at `net: true`; on rc.6 suggest listing
  the hosts from the log instead.
- **The runtime in use, not the pin.** The jail planning assumes the pinned runtime; under
  `DENEXT_DENO=stock` or another binary it should read that runtime's version.
- **`.npmrc` next to a generated build config.** `module-config.json` / `css-config.json` now
  carry `supplyChain`; check whether a build child still finds the project's `.npmrc` (`paranoid`
  set there) from a config in `.denext/`, without copying a file that may hold credentials.

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
  them, drop the runtime download, the Deno 2.9.8 pin and the cross-host backend directory
  (2.9.8's CLI looks a prebuilt backend up under the host's executable name), and archive the
  forks.

- **Desktop hardening leftovers from the 4.8 packaging audit (all Low):**
  - `desktop.app.bridgeOrigins` takes `"*"` and `"<scheme>://*"` with no warning, and the desktop
    page never mentions them: warn at config validation (each binding's own `bind(…, { origins })`
    still has to list the origin) and document the two forms.
  - The `shell` capability's printed note names only `open` / `explorer` / `xdg-open`, while it
    also bakes `osascript`, `powershell.exe`, `rundll32.exe`, `gio` and `dbus-send` (the docs
    table lists them all). Make the note match.
  - The runtime's build provenance (`gh attestation verify`) is opt-in (`--attest-runtime`); the
    SHA-256 pin shipped in the denext package is the default trust root. Attest by default when
    `gh` is signed in, and say so when it is not.
  - A cached runtime is checked by file size unless `--verify-runtime` is given; a same-size
    change by another local process goes unnoticed until then. Re-hash in the background after
    a launch, or on a schedule.
  - A sidecar's child under the Deno CLI (`spawnSelf` from an app run with `deno run`) gets the
    parent's unscoped `--allow-*` but not `desktop.denoFlags` or `--unstable-*` flags given on the
    command line.
  - A sidecar whose `run.exec` is one of the project's files bakes an unscoped `--allow-run` (its
    copy's path in the cache folder is only known at launch). Scope it once the runtime can take
    a launch-time path.
- **Monorepo leftovers (Low):** a workspace member listed outside the root (`../x`, which Deno
  refuses) is still read for its imports and named oddly in hints; skip it. The loader stand-in
  for a glob member carries the workspace's imports but none of the root's other fields
  (`nodeModulesDir`): cover a glob-member app whose npm packages live in the root's
  `node_modules` with a test.

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
  multi-select and video picks, on an iPhone and an Android phone; React Native Skia with
  Reanimated and inside the Capacitor shell's WebViews.
- **Managed fastlane on macOS arm64:** run `denext toolchain install --with fastlane` and one lane
  (`denext fastlane ios build`) on an Apple-silicon Mac. The Ruby there is
  pinned and its hash checked, but the install has not been run; drop the KNOWN-LIMITATIONS
  clause once it passes.

## Backend (`@denext/backend`)

Low findings of the 4.8 backend audit (realtime and storage):

- **TUS: a PATCH that outlives its lease.** A PATCH stalled past the 5-minute lease still saves
  its progress, unconditionally, over a newer PATCH's (`saveResumable` does not check the lease).
  The completion's size check fails such an upload closed, but its orphaned chunk objects stay in
  `.denext-tus`. Save only while holding the lease, and refuse a PATCH that lost it.
- **Ranged reads from a store that ignores `Range`.** `serve` answers `206` with the requested
  range even when the S3-compatible store answered `200` with the whole object; use the range the
  driver reports (and fall back to a `200`). The object's size is also read by a `HEAD` before
  the `GET`, so a concurrent overwrite can change it in between.
- **Realtime: a frame in the Live hub's flush window at a drop.** A frame published just before a
  subscriber's connection dropped is fanned out on the hub's next flush, so a reconnect
  re-authorized within those milliseconds under other claims can still receive it (same user).
  Let a regranted subscription discard frames already handed to the hub.
- **Realtime: a reconnect that finds a new subscription** (swept, or another instance) is
  detected by the client only after 10 seconds of silence. Let the client mark a re-subscribe,
  so the server answers one that recreated the subscription with an explicit `resync`.
- **Realtime: the combined re-read's select list** is spliced into the single-filter query by a
  string replace of `as r from`; build it structurally (only a configured key column name could
  break it).

## Security hardening (4.8 OTA / updater / native-template audit, low)

The audit's lows that were security gaps have landed (see the CHANGELOG: manifest expiry, loopback OTA only in
debug builds, `booted()` bound to a version, directory requests, OS-enforced `requireBiometric`,
print confinement, `baseUrl` credentials, the bridge's origin guard, PKCE on mobile `openAuthSession`). What is left, each with why it is not done there:

- **`requireBiometric` on Deno Desktop:** the desktop keychain items have no biometric access
  control, so the gate is in the page there; it needs a runtime capability (macOS
  `SecAccessControl`, Windows Hello) in the Brainwires/deno fork.
- **OTA serve check, the rest:** checking the platform stamp natively (a signed export of the same
  publisher for another target, not a trust breach), `admit` failing closed outside the versions
  root (the served base is chosen by native code, never by the page) and the check on
  `/_capacitor_file_/` paths (needs write access to the app container already) are hardening, not
  gaps. NFC/NFD variants do not reach it (Swift compares paths by canonical equivalence; Android's
  filesystems are normalization-sensitive).
- **Small ones:** Android transfer record names from a hash of the id (a collision overwrites a
  record, but the page chooses every id: no boundary is crossed); a `secureStore` accessibility
  option (ThisDeviceOnly for tokens) is new API and changing the default changes documented
  behaviour, so it needs a decision.

## Migrators and auth providers (audit 4.8, low findings)

- **`migrate` freezes the migrating machine's paths into inlined rules.** The next.config
  evaluator keeps `HOME`, `TMPDIR`, `DENO_DIR` and the Windows profile variables; a
  `redirects()` / `headers()` that interpolates one of them is written into `denext.config.ts`
  with that machine's value. Pass placeholders for them, or flag such a rule for review.
- **`denext patch` follows links inside `node_modules`.** A patch's targets are confined
  lexically to the package folder, and the package folder is resolved through pnpm's links (which
  may lead to a workspace package outside the app). Confine the resolved targets to the project
  or workspace root, by real path.

## Auth (`denextAuth`)

- **`revokeSession(sid)` for stateless cookie sessions.** A stateless session's own id and the
  adapter's revocation list (`revokeSids` / `isSidRevoked`) now back SAML Single Logout; let
  app code end one stateless session by id through them too ("sign out this device" without a
  `sessionStore`).

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
- **Not taking yet:** esbuild compiled to wasm as `@denext/esbuild`. It removes the npm download
  but runs several times slower on every compat build and dev session.
- **Maintenance:** track each vendored codec's upstream CVEs, rebuild SHA-256-pinned and
  regenerate its `THIRD-PARTY-LICENSES.md` before re-publishing.

## Client runtime and Server Actions (AU5 audit, low severity)

From the 4.8 client-runtime and Server Actions audit; the High and Medium findings shipped.

- **`notFound()` / `forbidden()` / `unauthorized()` in a Server Action called from the browser**
  reaches the client as a plain `Error("notFound")` (src/client/action-dispatch.ts), so the error
  boundary renders, not `not-found.tsx`; the client has no not-found boundary for an event-path
  signal yet. Add one, then re-raise the reply's `signal` as the branded error.
- **A held form-action submit** (one that beat the on-demand form-action chunk) builds its
  `FormData` and starts `useFormStatus`'s pending flag when the chunk arrives, not at the submit;
  `form.requestSubmit(button)` with no click does not run that button's function `formAction`; and
  `useFormStatus` under a form with no function `action` of its own (only a button's
  `formAction`) has no pending signal (src/client/form-action.ts, begin-work.ts `beginElement`).
- **The route-pattern href and blur-placeholder gates** (`__DENEXT_HREF_PARAMS__`,
  `__DENEXT_IMAGE_BLUR__`) still fail quietly when only a library uses the feature: a pattern href
  navigates to the literal `/blog/[slug]`, a placeholder stays painted. Report them as the
  form-action and hook-boundary gates do (errors 6 and 7).
- **The Fragment-ref runtime chunk**, once it fails to load, leaves a no-op for the page's life
  (src/client/fiber/fragment-ref-support.ts); retry it on the next Fragment ref.
- **Live handshakes waiting on `live.authorize`** are not counted against
  `live.limits.maxConnectionsPerIp` until they attach (re-checked after `authorize`, so no excess
  socket opens, but a slow hook can hold many pending handshakes). Count them while pending.
