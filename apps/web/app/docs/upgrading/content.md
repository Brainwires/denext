---
title: Upgrading
slug: upgrading
lead: The breaking changes and renamed config keys per denext version, as a checklist — what to change when you bump, each linked to its changelog entry.
---

This page is a **checklist view** of the changelog: only the breaking changes,
the renamed or removed config keys, the removed exports, and the default flips
that need you to do something. Features, fixes and everything else live in the
[changelog](/docs/changelog), which stays the source of truth — every item below
links back to the release that introduced it.

## Before every upgrade

- **Read the changelog section for the version you are bumping to** — this page
  lists only what needs action; the [changelog](/docs/changelog) has the rest.
- **Bump the version, then run `deno task check`** (fmt, lint, tests — type
  errors surface through `deno test`). A renamed export or a changed type shows
  up here first.
- **Run `denext doctor`.** It checks the Deno floor, the config shape (unknown
  and graduated keys warn with a did-you-mean) and renders every route, so a
  boundary or metadata change that broke a page fails loudly.
- **A migrated app: re-run `denext migrate` only if the section below says a
  generated file changed shape.** Migrate writes config by default and is
  non-destructive to your source; see [Migrating from Next.js](/docs/migrating).

## 2.x → 3.0

3.0 removes the aliases denext kept through 2.x for its own renamed APIs. The
spellings that are React's or Next.js's own stay, as compatible aliases.

- **`experimental.compiler`, `experimental.asyncContext`,
  `experimental.features` and `experimental.nodeResolve` are removed** — move
  each to its top-level key: `reactCompiler`, `asyncContext`, `features`,
  `nodeResolve`. Setting one is now a `denext.config` validation error naming
  the replacement, not a dev warning (silently ignoring
  `experimental.nodeResolve: false` would change how the app builds). Next.js's
  own `experimental.reactCompiler`, `experimental.cacheComponents` and
  `experimental.optimizePackageImports` are still honored, with a dev warning.
  ([Configuration](/docs/config))
- **`redirect` from `denext/server` throws**, like `redirect` from `denext` and
  Next.js. The deprecated Response-returning alias is gone: return
  `redirectResponse(location, status)` from `middleware.ts`. Middleware that
  still calls `redirect()` keeps working — a thrown `redirect()` /
  `permanentRedirect()` there becomes a 307 / 308 response — but code that used
  the returned `Response` itself must call `redirectResponse`.
- **`InspectNode.sourceId` is removed** from the DevTools inspector tree — read
  `source` (`{ file, export, line, column }`) instead.

3.0 also carries every change that first shipped in the 2.11.0-rc.1 prerelease
(there is no 2.11.0 final): compression on by default, React re-render
semantics for library components, per-build page-cache keys and least-privilege
desktop packaging among them. Coming from 2.10 or earlier, work through
[the list below](#also-in-30-from-2110-rc1) too.

## Also in 3.0 (from 2.11.0-rc.1)

- **Responses are now compressed by default** (gzip per `Accept-Encoding`, Next.js's
  `compress`; `compress: { encodings: ["br", "gzip"] }` adds brotli, at about two to three
  times gzip's CPU). `denext start` and `denext dev` — App Router and SPA mode — and every
  `createApp()` / `serve()` embedder encode dynamic HTML, JSON, JS, CSS, SVG and XML responses
  of 1 KiB or more, and add `Vary: Accept-Encoding` to them. Set `compress: false` in
  `denext.config.ts` (or pass `compress: false` to `createApp()`) if a proxy or CDN in front
  already compresses. A response that already carries a `Content-Encoding` is never
  re-encoded, and a route opts out with `export const compress = false`. A test that calls a
  `createApp()` handler directly with an `Accept-Encoding` request header now gets an encoded
  body: drop the header or decode it. ([Configuration](/docs/config#production-server))
- **A compressed response's strong `ETag` becomes weak** (`W/"…"`), since the bytes on the wire
  are not the handler's; `Content-Length` and `Accept-Ranges` are dropped from it. A client or
  test that compared the `ETag` byte for byte compares the weak form, or the route opts out
  with `export const compress = false`. ([Configuration](/docs/config#production-server))
- **The ISR page cache is keyed per build.** A cached page references its build's hashed client
  chunks, so `denext start` now reads and writes only the entries of the build it runs: every
  deploy starts with a cold page cache (including `force-static` pages) even when the store
  outlives the build — a custom store, an explicit `cache.path`, a volume-mounted `.denext`
  (`denext build` already empties the default `.denext/cache.db`). `denext build` writes the id into
  `.denext/manifest.json` — random per build, or `DENEXT_BUILD_ID` when set; set it (to the
  commit sha, say) when replicas built separately should share one store. A custom
  `CacheStore` is unaffected in its interface, but page keys it receives now start with the
  cache format and build id (`v2:<buildId>:/path?query`), so a store or warm-up script that
  reads or seeds page keys by bare path must use the new form. `new PageCache()` in your own
  `createApp()` keeps path-only keys (`v2:/path`); pass a build id to key by build. After
  startup `denext start` also deletes the previous builds' pages from its store — always for the
  in-memory store and the default `.denext/cache.db`, and for a custom store or an explicit
  `cache.path` only when the id is pinned with `DENEXT_BUILD_ID` and the store implements the
  new optional `CacheStore.sweepPages(keep)`. A custom store without it keeps working and is
  never swept. ([Multiple instances](/docs/multi-instance#page-keys-and-builds))
- **`denext dev` serves a `reactNative` app on the per-module loop** (Fast Refresh keeps state
  on a component edit) instead of rebuilding and reloading per change, and an explicit
  `unbundled: true` dev server option is accepted. A package import is now served from a
  dependency bundle built on the first page load; if your app relied on a full rebuild per
  edit, set `DENEXT_DEV_UNBUNDLED=0` (or pass `unbundled: false`) for the bundled loop.
  ([React Native](/docs/react-native#fast-refresh))
- **Components from npm re-render with their parent (compat builds, React Native mode).**
  `react` and `react/jsx-runtime` imported from inside `node_modules` now resolve to variants
  whose elements denext skips only when their props object is unchanged (or they are a
  `memo()`), as React does; your own components keep the implicit shallow-props memo. A library
  that re-rendered too rarely on 2.10 (a stale screen after a tab press in expo-router's
  headless tabs) now updates, and a list built on a library's own engine (react-native-web's
  `FlatList` under `lists: "library"`) does about 10 % more scripting while it scrolls. Wrap a
  hot library subtree in `memo()` if it now renders more than you want.
- **`feature()` flags now take their configured value in a denext-native SPA.** A `mode: "spa"`
  app bundled without npm React read every `feature("KEY")` as `false` in production whatever
  `features` said. It now folds to the configured value, so a flag left `true` in
  `denext.config.ts` turns its branch on. Check `features` before you deploy.
- **A leftover `.denext/css-shims` redirect in your `deno.json` is removed, and `denext doctor`
  reports one as an error.** A build, export or dev run that was killed outright on 2.10 could
  leave absolute `file:///…/x.css` import entries in the app's `deno.json`. The next run deletes
  only those members (comments and formatting are kept, one log line says so); commit the
  cleaned file. Until then `denext doctor` / `denext mobile doctor` fail on it, which a CI gate
  will notice. Apps with `nodeModulesDir: "none"` or `"auto"` and no `npm:` imports are no
  longer patched at all.
- **Native templates: the composed iOS bridge is generation 5 (OTA, app extensions) and
  `MainActivity` is generation 2.** The next `denext mobile add` upgrades an unedited earlier
  file in place (2.10 would have rewritten it and dropped the new registrations). With OTA
  installed, run `denext mobile add-ota` first, as after any upgrade. The upgrade changes the
  native layer, so `denext mobile fingerprint` changes too: ship a new binary before you publish
  a UI stamped with `--native-fingerprint auto` from this version.
- **React Native mode: `Platform.select` in the iOS / Android shell falls back to `ios` /
  `android`.** A spec without `web` now picks the shell's own key (then `default`) instead of
  `default` or `undefined`, as React Native does on the device. `web` still wins everywhere, and
  a browser or Deno Desktop picks as before. Check specs whose `ios` / `android` values were
  written for the native app, not the web shell.
- **React Native mode: `requireNativeModule("X")` no longer throws when the module is absent**
  (a browser, SSR, a test, a shell without that plugin). It returns a stand-in whose functions
  throw only when called. Code that detected a missing module with `try` / `catch` around the
  call must use `requireOptionalNativeModule`, which still returns `null`.
- **Desktop packaging scripts no longer pass `-A`** in new projects. `denext create --desktop` and
  `denext migrate --desktop` write `scripts/package-*.ts` that derive `--allow-*` from
  `desktop.capabilities`. Existing scripts keep `-A` until you run
  `denext desktop package --regenerate-scripts` (a changed file is backed up to `<name>.bak`).
  After regenerating, anything the app does outside its enabled capabilities with Deno APIs
  (its own `Deno.Command`, network beyond loopback, writes outside app support) needs the
  matching capability or a hand-added flag. ([Desktop apps](/docs/desktop))
- **Types (`denext/mobile`, `denext`):** `FileDirectory` is now `AppFileDirectory |
  PickedDirectory` (it adds `{ picked: handle }`), so code that treats it as a string must narrow
  first. The `SyntheticEvent` type gains `isPersistent()`, so an object literal typed as
  `SyntheticEvent` needs it (the runtime events now implement `persist()`, `isPersistent()`,
  `isDefaultPrevented()`, `isPropagationStopped()` and `nativeEvent`). `Key` accepts `bigint`.
- **Islands-only pages ship no Server Component payload.** A page whose client parts are all
  `client:*` islands (or resumable) inlines `null` as `#__denext_flight` and boots without a
  root: its islands, delegated handlers and navigation only. A page that hydrates a root (an
  undirected client component, or an action / `qrl` / channel prop) is unchanged. Code or a
  test that read the inlined Server Component tree on such a page now reads `null`.
  ([Islands](/docs/islands))
- **Deno Desktop: a `desktop.ts` entry written before 2.11 serves no desktop capability.** It
  has no `resolveDesktopCapabilities(config, { base: import.meta.url })` spread into
  `runDesktop`, so every capability answers `unavailable` and the page keeps its web path. Add
  the spread and enable capabilities with `denext desktop add` (the generated `desktop.ts` does
  both). After regenerating the package scripts, add the `--allow-*` your own desktop
  extensions need by hand: their permissions are not derived.
  ([Desktop apps](/docs/desktop#desktop-capabilities))
- **React Native mode replaces more of react-native-web by default.** Each is on for an
  existing `reactNative` app and has a way back:
  - `FlatList`, `SectionList`, `VirtualizedList`, FlashList and LegendList run on denext's
    `VirtualList`; `reactNative: { lists: "library" }` restores the libraries' own engines
    ([Lists](/docs/lists#react-native)).
  - Popular community packages (React Navigation's native-stack / bottom-tabs / drawer,
    react-native-safe-area-context, react-native-keychain, AsyncStorage, MMKV and others)
    resolve to denext implementations; `reactNative: { aliases: { "<package>": false } }`
    restores one ([Community packages](/docs/react-native#community-packages)).
  - react-native-web's mocked APIs (`Keyboard`, `BackHandler`, `StatusBar`, `Alert`,
    `Linking`, …) are shell-backed, and `Linking.openSettings()` opens the app's settings
    instead of rejecting.
  - Declarative Reanimated `transform` / `opacity` animations run as Web Animations on the
    compositor; `globalThis.__DENEXT_REANIMATED_WAAPI = false` keeps Reanimated's own loop
    ([Animations on the compositor](/docs/react-native#animations-on-the-compositor)).
  - The default viewport adds `viewport-fit=cover`, so safe-area insets are no longer 0 in the
    iOS shell: a layout that padded for the notch by hand now pads twice. A viewport the app
    sets in `spa.head` replaces the default.

## Upgrading to 2.10

2.10 shipped through three release candidates; this section covers every change that needs
action since 2.9, whichever rc introduced it.

- **Over-the-air UI updates (Capacitor): re-run `denext mobile add-ota` and ship a new
  binary.** The native OTA templates move to generation 4, which checks the native fingerprint
  (unedited earlier templates upgrade in place). A manifest stamped with
  `denext ota manifest --native-fingerprint` is signed as payload v3, and a binary with an
  older template and an embedded public key refuses it with code `signature` (it verifies the v2
  payload). Keep publishing manifests without `--native-fingerprint` (still signed as v2) until
  every installed binary runs the generation-4 template; manifests without it keep working for
  both. ([2.10.0-rc.3](/docs/changelog#2100---2026-09-25))
- **Client-rendered booleanish attributes now match react-dom.** A boolean on `aria-*`,
  `data-*`, `draggable`, `spellCheck`, `contentEditable` (and React 19's other booleanish-string
  props) is written as `"true"` / `"false"`. Before, the client dropped the attribute for
  `false` and wrote `""` for `true`, so the DOM after hydration or a client render changes:
  `aria-hidden={false}` now stays as `aria-hidden="false"`, and `data-open={false}` renders
  `data-open="false"`, which a presence selector such as `[data-open]` now matches. Match on the
  value (`[data-open="true"]`) or omit the prop instead of passing `false`, and regenerate DOM
  snapshots. SSR already rendered these values.
  ([2.10.0-rc.1](/docs/changelog#2100---2026-09-25))
- **An explicit `denext dev --host` allows the host it binds** through the dev origin gate
  (`0.0.0.0` / `::` allow this machine's own addresses), and the SPA dev server now applies
  `allowedDevOrigins` too. `.denext/dev.json` records the bind as given in `hostname` and the
  allowed hosts in a new `devOrigins`; a local tool that read `hostname` as a loopback address
  should read `origin`. ([2.10.0-rc.3](/docs/changelog#2100---2026-09-25))
- **`denext mobile dev` edits `ios/App/App/Info.plist` for the session** (App Transport
  Security's `NSAllowsLocalNetworking` and a local-network usage string), which a physical
  iPhone needs to reach the LAN dev server. A changed plist is a native change: rebuild and run
  the app from Xcode once (it prints so); both are restored on exit. ([2.10.0](/docs/changelog))
- **`reactNative` refuses an explicit `unbundled: true` dev server option.** The resolution
  lives in bundler plugins the per-module loop does not run; drop the option (React Native
  mode already defaulted to the bundled loop).
  ([2.10.0-rc.3](/docs/changelog#2100---2026-09-25))
- **`denext mobile add` pins exactly when the project does.** When every `@capacitor/*` package
  in `package.json` is an exact version, capability packages are added at the version the
  capability table was verified against, with the package manager's exact flag; a project with
  any caret range still gets caret ranges. It also picks the package manager from the nearest
  lockfile up to the repository root, so a pnpm workspace member no longer gets
  `npm install`.
  ([2.10.0](/docs/changelog), [2.10.0-rc.2](/docs/changelog#2100---2026-09-25))
- **`denext mobile add barcode` raises `minSdkVersion` to 26** in `android/variables.gradle`
  (the scanner's Android library requires it; Capacitor 8 defaults to 24).
  ([2.10.0-rc.2](/docs/changelog#2100---2026-09-25))
- **Run the JSR CLI with `--node-modules-dir=none` inside a Node workspace**
  (`deno run -A --node-modules-dir=none jsr:@denext/denext/cli …`). Without it Deno resolves
  denext's `npm:` imports from the workspace's `node_modules` and fails, and next to a
  `pnpm-workspace.yaml` Deno 2.9.7 rewrites the root `package.json`.
  ([2.10.0-rc.2](/docs/changelog#2100---2026-09-25))
- **From 2.10.0-rc.3: run `denext mobile dev --restore` once** if a `mobile dev` session ran
  under the rc. Its restore could leave the dev server URL in
  `ios/App/App/capacitor.config.json` and `android/app/src/main/assets/capacitor.config.json`
  (a native build would then load the dev server); `--restore` now scrubs both.
  ([2.10.0](/docs/changelog))

## Upgrading to 2.9

- **Over-the-air UI updates (Capacitor): re-run `denext mobile add-ota --force` and ship a new
  binary.** The native plugin gained signed payload v2 (a `sequence` for downgrade protection and
  an optional `minNative` gate), bounded streaming downloads, redirect refusal and a sturdier boot
  watchdog. `add-ota` now upgrades unedited older templates itself, and with `--public-key` it
  fails if a template was kept. `denext ota manifest --sign` stamps a `sequence` by default. Once
  an app has accepted a sequenced manifest, it refuses unsequenced ones, so sign every release
  with a denext ≥ 2.9 CLI.
- **`requestId()` no longer trusts a client's `x-request-id`** unless `trustForwardedHeaders` /
  `DENEXT_TRUST_PROXY=1` is on. If your logs or idempotency relied on clients choosing the id,
  send it through your proxy, or read the header yourself.
- **`denextAuth` follows the app's `trustForwardedHeaders`** when its own is unset. Set it
  explicitly on `denextAuth` if the auth limiter should see a different address than
  `clientIp()`.
- **`requestSignal()` is `undefined` inside `use cache`.** Code that passed it into cached
  fetches now runs them to completion.
- **`optimizePackageImports`** accepts `false` (off entirely) and `"!pkg"` (drop one default).
  Multi-line imports keep their line count, so source maps below them are correct again.
- **SSR:** `defaultValue` / `defaultChecked` render only on `<input>`, and `<a href="">` is kept,
  both as in React.

## Upgrading to 2.8

- **An unsigned over-the-air update served over plain `http` is refused beyond loopback.**
  The native `DenextOta` plugin now refuses a manifest fetched over `http` from any host but
  `localhost` / `127.0.0.1` / `::1` / `10.0.2.2` (code `insecure`) unless it is signed. To keep
  shipping OTA updates:
  1. `denext ota keygen ota-signing.pem` — writes the private key (keep it out of git) and
     `ota-signing.pem.pub`;
  2. `denext mobile add-ota --force --public-key ota-signing.pem.pub` — refreshes the native
     templates and embeds the public key;
  3. sign every manifest: `denext ota manifest <dir> --sign ota-signing.pem`, or set
     `DENEXT_OTA_SIGNING_KEY` (the PEM contents) in CI for `denext ota manifest` and a
     `spa.ota` export alike;
  4. **rebuild and ship the app binary** — the key lives in the binary, so devices keep
     refusing unsigned-over-`http` updates until they run the new build.

  Serving the updates over `https` instead also works (the templates still need the
  `--force` refresh and a rebuild). ([2.8.0](/docs/changelog#280---2026-09-24))
- **SSR attributes follow ReactDOMServer's tables** — expect snapshot and golden-HTML test
  changes, no runtime action. A true boolean prop renders `disabled=""` (was a bare
  `disabled`); `tabIndex` → `tabindex`, `autoFocus` / `multiple` / `muted` → lowercase,
  `crossOrigin` → `crossorigin`, `transformOrigin` → `transform-origin`; `value`, `focusable`
  and the other enumerated props render `"true"` / `"false"`; an empty `src` / `href` is
  dropped (except `<a href="">`, since the next release) and an invalid `cols` / `rows` /
  `size` / `span` / `rowSpan` / `start` is omitted; a kebab-case style key with a number gets
  `px` (`{ "line-height": 2 }` → `line-height:2px`, as in React — use `lineHeight` for a
  unitless value). `serializeStyle` output has no trailing `;`, and a component that renders
  `null` / `undefined` / a boolean no longer leaves an empty text node in the DOM (so
  `childNodes` counts and DOM snapshots shrink). Regenerate the affected snapshots.
  ([2.8.1](/docs/changelog#281---2026-09-24))
- **iOS momentum-safe scrolling is on by default, for Safari visitors too** — not just
  Capacitor. On iOS/iPadOS WebKit the client runtime defers programmatic scroll writes during
  a touch fling, so virtualized lists stop killing momentum. Nothing to do unless your app
  depends on a scroll write landing mid-fling; opt out with `momentumSafeScroll: false` in
  `denext.config.ts`. ([2.8.3](/docs/changelog#283---2026-09-24))

## Upgrading to 2.7

- **`optimizePackageImports` is on by default.** The compat (esbuild) and SPA bundles rewrite
  barrel imports of a built-in list (`lucide-react`, `date-fns`, `lodash-es`, `ramda`, `rxjs`,
  `@tabler/icons-react`, `@heroicons/react/*`, `react-icons/*`, `@mui/icons-material`,
  `recharts`, `react-use`, `@headlessui/react`, `effect`) to the modules that define each
  name. Listing a package asserts its modules are side-effect free, so a top-level side effect
  in a module you don't import no longer runs. If one of those packages relies on that,
  exclude it with a `"!pkg"` entry (`optimizePackageImports: ["!recharts"]`), or turn the
  optimization off with `optimizePackageImports: false` (both since the next release; before
  that the default list could not be disabled). Next's
  `experimental.optimizePackageImports` is honored with a dev warning — move it to the top
  level. ([2.7.1](/docs/changelog#271---2026-09-23))

## Upgrading to 2.6

- **`useSyncExternalStore` updates run at sync priority**, whatever transition is in
  flight (React's `forceStoreRerender`). A store change that lands while a `startTransition`
  render is in progress abandons that render and restarts the transition after the sync
  commit. Nothing to change; a test that asserted a store update was deferred behind a
  transition now sees it commit first. ([2.6.0](/docs/changelog#260---2026-09-21))

## Upgrading to 2.5

2.5 shipped through six release candidates; this section covers every change that needs
action since 2.4, whichever rc introduced it.

- **The binary's checksum assets are named `<archive>.sha256`** —
  `denext-x86_64-apple-darwin.tar.gz.sha256`, not `denext-<target>.sha256` — and a combined
  `SHA256SUMS` sits beside them. Nothing installed is affected (no release had shipped with the
  old name); a script written against the earlier workflow reads the new names, and the
  installer now refuses to install without a checksum (`DENEXT_INSECURE=1` overrides).
  ([2.5.0](/docs/changelog))
- **`experimental.reactCompiler` → `reactCompiler`, `experimental.asyncContext` →
  `asyncContext`, `experimental.features` → `features`.** Every `experimental.*` key is now a
  top-level field (beside the earlier `nodeResolve` and `cacheComponents`); the old spellings —
  `experimental.compiler` included — still work as deprecated aliases and dev-warn, with the
  top-level field winning when both are set. Move them when convenient; the block is removed in
  3.0. ([2.5.0](/docs/changelog))
- **The `denext` binary treats an unversioned `jsr:@denext/denext` import as a pin to the
  latest published version** and re-execs `jsr:@denext/denext/cli`, where it used to refuse
  the directory as unpinned. Pin a version (`jsr:@denext/denext@^2.5.0`) for a reproducible
  build. ([2.5.0](/docs/changelog))
- **Schedules reach `Deno.cron` under a new registration name and with the weekday field
  respelled.** The old `task@cron` name was refused by `Deno.cron` for every expression, so
  nothing on Deno Deploy had ever registered — there is nothing to migrate, but a Deploy
  dashboard will show crons for the first time. Weekdays are POSIX (`0` = Sunday) and are
  translated to names; if you had written a schedule in `Deno.cron`'s `1–7` numbering to work
  around the difference, rewrite it as POSIX. A cron token that is not plain digits (`-5`,
  `0x10`, `1e1`, `5,,`) is now refused at parse time, and `N/S` on a lone number means
  `N`-to-max. ([2.5.0](/docs/changelog))
- **`runTask` rejects instead of throwing synchronously** when a handler throws before its
  first `await`; a `try { runTask(…) } catch` that expected a synchronous throw needs an
  `await`. ([2.5.0](/docs/changelog))
- **`denext ui` is served and opened at `http://127.0.0.1:<port>`**, not `localhost`, and its
  session cookie is a secret minted at the handshake rather than the launch token. A script that
  reconstructed a `localhost` origin from `--json`'s `port`, or sent the token as the cookie,
  uses the printed `url` and the cookie the handshake set. Config writes redirect to
  `/config/<view>?key=<key>` rather than `/config#<section>`.
  ([2.5.0](/docs/changelog))
- **`signIn(provider, { credentials })` answers `{ ok: false, error, status }` for a refusal**
  (`"invalid_credentials"`, `"throttled"` with `retryAfter`, `"access_denied"`, `"unavailable"`,
  `"rejected"`) instead of rejecting with the server's generic message; only a network failure or
  a non-JSON answer still throws. A `try`/`catch` around it that showed `err.message` needs
  `if (!result.ok)`. ([2.5.0](/docs/changelog))
- **The TOTP and email-request functions answer `{ ok, … }` unions.**
  `enrollTotp(config, session)` (was `(config, user)`) answers
  `{ ok: true, secret, uri }` or `{ ok: false, error }` and refuses a complete
  session that didn't sign in recently. `confirmTotp(config, { user, code })` and
  `verifySecondFactor(config, { userId, code })` take an options object; the
  latter answers `{ ok: true, method }` instead of the method or `null`.
  `requestPasswordReset()` / `requestEmailVerification()` answer `{ ok: true }` or
  `{ ok: false, error: "throttled", retryAfter }` instead of `{ throttled }`. A
  truthiness check on an old nullable result now always passes — test `.ok`.
  ([2.5.0-rc.5](/docs/changelog#250---2026-09-18))
- **`MfaStatus.enrolled` now means a confirmed factor, and `confirmed` is gone.**
  Read `pendingConfirmation` for an enrollment that was started but not
  confirmed. ([2.5.0-rc.5](/docs/changelog#250---2026-09-18))
- **Minting an API token needs a recent sign-in.** `POST /auth/tokens` from an
  older session answers `403 { error: "reauth_required" }`; sign in again first.
  ([2.5.0-rc.5](/docs/changelog#250---2026-09-18))
- **`verifyEmail()` answers `{ ok: true, user }` / `{ ok: false, error }`**
  instead of the user or `null`: `if (await verifyEmail(…))` now always passes —
  test `result.ok`. ([2.5.0-rc.3](/docs/changelog#250---2026-09-18))
- **`useSession().status` can be `"mfa-required"`.** An exhaustive `switch` or a
  `Record<status, …>` needs the new member.
  ([2.5.0-rc.2](/docs/changelog#250---2026-09-18))
- **`denextAuth` rate-limits sign-in starts and session reads by default** — 100
  per client IP per 15 minutes and 300 per minute. A load test, or many users
  behind one address, can meet a `429`; `SessionProvider` keeps its session
  through one. Tune `rateLimit.signin` / `rateLimit.session`, or turn every
  limiter off with `rateLimit: false`. ([2.5.0](/docs/changelog))

- **A help flag before the verb prints help instead of running the verb.**
  `denext --help build` used to run a build; it now prints `build`'s help. A
  script that relied on it runs `denext build`. An unknown flag before the verb
  is now an error instead of being silently ignored. ([2.5.0-rc.2](/docs/changelog#250---2026-09-18))
- **`AuthProvider` has a third member, `EmailProvider` (`type: "email"`).** An
  exhaustive `switch` over `provider.type` needs an `"email"` case.
  `credentials()`'s `authorize` became optional and the internal
  `issueAuthSession` gained a trailing options argument — both source-compatible,
  nothing to change. ([2.5.0-rc.2](/docs/changelog#250---2026-09-18))
- **The config schema no longer emits `x-denext.widget: "map"`.** Only a tool
  reading `denext.config.schema.json` is affected: detect a map from its
  `additionalProperties`. ([2.5.0-rc.2](/docs/changelog#250---2026-09-18))
- **The `linkAccount` event carries identity only** — provider, provider-side id,
  type and owner. A handler that read provider tokens off it reads the stored
  account back through the adapter.
  ([2.5.0-rc.1](/docs/changelog#250---2026-09-18))
- **`Await<T>` is renamed `MaybePromise<T>`** (`denext/server`). Rename the
  import. ([2.5.0-rc.1](/docs/changelog#250---2026-09-18))
- **`InspectNode.source` (`denext/devtools`) is a `SourceLocation` object.** The
  old string stays as `sourceId` for one minor.
  ([2.5.0-rc.1](/docs/changelog#250---2026-09-18))
- **Raised the scrypt `cost`? Pass the same options to `verifyPassword`**, or an
  unknown account rejects measurably faster than a known one.
  ([2.5.0-rc.1](/docs/changelog#250---2026-09-18))
- **A custom `SessionStore` needs `update` for sliding expiry.** Without it a
  session is never slid forward, and the store warns once.
  ([2.5.0-rc.1](/docs/changelog#250---2026-09-18))
- **`denext --help` lists a project's own verbs only from the cache `denext commands`
  wrote** (`.denext/commands.json`, fingerprinted against `denext.config.*`, `deno.json` and
  `deno.lock`) — it never imports your config. Before the first `denext commands`, or once one
  of those files changes, help points at `denext commands` instead; shell completions still
  enumerate them live. ([2.5.0-rc.1](/docs/changelog#250---2026-09-18),
  [2.5.0-rc.6](/docs/changelog#250---2026-09-18))

## Upgrading to 2.4

- **`denext deploy` was removed.** Deploy with `deployctl` (Deno Deploy), your
  host's own CLI, or the Docker/systemd recipes in the
  [deployment guide](/docs/deploy) — `denext generate docker` still scaffolds a
  Dockerfile. ([2.4.0](/docs/changelog#240---2026-09-11))
- **`useId()` emits a new, CSS-selector-safe id format** (`_d0-2-1_0_`, was
  `:d0.2.1_0:`). Nothing to change unless you pinned the literal old format —
  update those snapshots. ([2.4.0](/docs/changelog#240---2026-09-11))

## Upgrading to 2.3

No breaking changes.

## Upgrading to 2.2

No breaking changes.

## Upgrading to 2.1

No breaking changes.

## Upgrading to 2.0

The 2.0 cycle aligned denext's App Router with Next.js 15's shapes. Most items
below are a break only if your code depended on the old, non-Next shape.

### Config keys

- **`nextCompat` → `compatibilityMode`.** Rename the key (the value is
  unchanged: `boolean | "auto"`); the old key is no longer accepted. The scaffold
  flag `--next-compat` is now `--compatibility`.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`experimental.streaming` → `streaming` and `experimental.live` → `live`.**
  The legacy keys are no longer read — move the value up. An app that set
  `experimental.streaming: false` (a CSS-in-JS app, say) now streams until you
  set top-level `streaming: false`.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`experimental.nodeResolve` → `nodeResolve` and `experimental.compiler` →
  `experimental.reactCompiler`** (itself top-level `reactCompiler` since 2.5). Both old
  keys still work as deprecated aliases (removed in 3.0) and dev-warn — move them when
  convenient. Likewise `experimental.cacheComponents` → top-level `cacheComponents`.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`trailingSlash` defaults to Next's behavior.** An unset `trailingSlash` now
  redirects `/about/` → `/about` (308); set `trailingSlash: true` to keep the
  slashes. ([2.0.0](/docs/changelog#200---2026-09-05))
- **Deno KV cache backend (`denoKvCacheStore`) was removed.** Use the default
  SQLite cache store (Deno KV is still fine as an app database).
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **The Deno floor is `≥ 2.9`.** Upgrade Deno before you upgrade denext.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`@denext/htmx` `≥ 2.0.11` and `@denext/pages-router` `≥ 0.9.1` are
  required.** Older releases import barrel exports 2.0 removed — bump them in
  the same commit. ([2.0.0](/docs/changelog#200---2026-09-05))

### Routing and request handling

- **Catch-all params are `string[]`.** `app/docs/[...path]` yields
  `params.path = ["a", "b", "c"]`, not `"a/b/c"` — add `.join("/")` where you
  need the path form. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`searchParams` is a record, not a `URLSearchParams`.** `?a=1&a=2&b=x` is
  `{ a: ["1", "2"], b: "x" }`; the `URLSearchParams` is `searchParams.raw`.
  Both `params` and `searchParams` are now also awaitable, so Next 15 code ports
  unchanged. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`_folder` directories are private.** A folder starting with `_` is never
  routable — if you relied on a `/_components` route, rename the folder.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Route ordering is position-aware.** Specificity is compared segment by
  segment from the left, so `/a/[b]` now wins `/a/b` over `/[a]/b`. Check any
  route pair you disambiguated by relying on the old positional sum.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Per-segment `error.tsx` / `loading.tsx` boundaries.** A throw in a nested
  `layout.tsx` is caught by the nearest ancestor segment's `error.tsx` instead
  of escaping to the 500 page — re-check where your boundaries sit.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Middleware runs BEFORE config `rewrites`, and matchers see the
  locale-stripped path.** An `/admin/:path*` matcher now fires even when a
  rewrite maps `/admin/x` elsewhere, and `/dashboard/:path*` fires for
  `/fr/dashboard` under `i18n` — re-read your matchers.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Parentheses in a middleware matcher are regex groups.** Escape `\(` for a
  literal parenthesis. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`global-error.tsx` owns the document.** It replaces the root layout and must
  render its own `<html>` and `<body>` — denext no longer wraps it.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Segment config inherits what a child does not set.** A layout's
  `dynamic = "force-static"` now reaches a page that exports no `dynamic` —
  export the field explicitly where you want the child to win.
  ([2.0.0](/docs/changelog#200---2026-09-05))

### Server APIs

- **`redirect` on `denext/server` is renamed `redirectResponse`.** Use
  `redirectResponse()` in `middleware.ts`; `redirect` stays as a deprecated
  alias (removed in 3.0) and now means the throwing `redirect()` everywhere
  else. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`cookies().get(name)` returns `{ name, value } | undefined`.** Read
  `.value`; `getAll()` returns an array.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`headers()` is read-only.** `set` / `append` / `delete` throw a `TypeError`
  — build a new `Headers` instead.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`unstable_noStore()` actually opts out of the page cache.** A `revalidate`
  route that calls it is rendered per request — audit where you called it as a
  no-op. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`defineAction` redacts handler errors in production.** A non-validation
  throw yields `{ ok: false, error: "Internal Server Error", digest }`; if your
  UI showed `state.error` to users, surface the `digest` instead.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`Metadata` is Next.js-shaped.** `openGraph.image` / `twitter.image` are now
  `images` (the singular key emitted no `og:image` at all) — rename them.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Session tokens are domain-separated.** Sessions issued by a 2.0.0 release
  candidate are invalidated once; users sign in again. Nothing to change.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **A short auth secret throws at boot in production**, and the credentials rate
  limiter ignores `x-forwarded-for` unless `trustForwardedHeaders: true` — set a
  long `AUTH_SECRET`, and opt in if you sit behind a trusted proxy.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`NextRequest.ip` no longer trusts the first `x-forwarded-for` hop.** It
  prefers the socket peer, then the LAST hop, then `x-real-ip`.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`userAgent().device.type` is `undefined` for a desktop** (was `"desktop"`),
  matching ua-parser-js. ([2.0.0](/docs/changelog#200---2026-09-05))

### Client APIs

- **`useSearchParams()` returns `ReadonlyURLSearchParams`.** `append` / `delete`
  / `set` / `sort` throw; it is memoized per query string, so
  `useEffect(…, [searchParams])` stops re-running every render.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`useRouter()` is Next's `AppRouterInstance`** (`push`, `replace`,
  `prefetch`, `back`, `forward`, `refresh`) and is one stable object.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`Link` composes your props instead of overwriting them**, leaves
  `target="_blank"` / `download` / `rel="external"` to the browser, and
  `prefetch` is `boolean | null` (`null` = in-viewport only).
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`dynamic()`'s `loading` component receives Next's props**
  (`{ error, isLoading, pastDelay, timedOut, retry }`), not the wrapped
  component's props. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`composeRefs()` returns a cleanup** and honors a callback ref's returned
  cleanup (React 19) instead of calling every ref again with `null`.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`Children.count` / `Children.forEach` include holes and `Children.only`
  throws for anything but one element** (React's semantics).
  ([2.0.0](/docs/changelog#200---2026-09-05))

### Removed exports

- **89 internal symbols left the public barrels** (`denext`, `denext/server`,
  `denext/client`, `denext/testing`) — framework plumbing an application never
  calls. `Dispatcher` is gone from `denext`; `denext/build/next-compat` and
  `denext/remix` are curated barrels without their test seams; the Google-font
  build helpers left `denext/next/font/google`. Import from the source module if
  you genuinely need one. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`denext migrate --drop-in` was removed**, and source rewriting is now opt-in
  via `--codemod` (it used to be implied). Pass `--codemod` to get the old
  default. ([2.0.0](/docs/changelog#200---2026-09-05))

> Deprecated, not yet removed: `images.domains` (→ `images.remotePatterns`),
> `useFormState` (→ `useActionState`), `unstable_noStore` (→ `connection()`) and
> `io()` all still work through 2.x and are removed in 3.0. Each carries an
> `@deprecated` tag, so your editor strikes it through.
