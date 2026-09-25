# denext + Capacitor as a React Native / Expo replacement

What React Native and Expo provide that `denext/mobile` + a Capacitor shell must match before
it is a credible replacement. The bar is concrete: T3 Code's React Native app (`apps/mobile`
in pingdotgg/t3code), whose dependencies were audited on 2026-09-24. The comparison target is
T3's Capacitor shell (`apps/capacitor`, branch `denext-2.x`), which wraps T3's existing web UI.

Most items were "an official Capacitor plugin exists; denext should wrap it in a typed hook",
and those are now wrapped. The real gaps below are closed on the denext side except Android
native feel (gap 5), which needs a real-device measurement. Not audited: which T3 screens use
which dependency, so the ranking was by expected day-one impact, not measured usage.

This is about matching what React Native / Expo **apps** get, not about rendering natively:
per [POLICIES.md](./POLICIES.md#engineering-guardrails), React Native / native rendering is
out of scope and Capacitor/WebView stays the mobile story. The actionable items are tracked in
[ROADMAP.md](./ROADMAP.md) under "Mobile (Capacitor) parity".

## Real gaps (denext work)

1. **Push notifications.** T3 uses `expo-notifications` plus its own relay (APNs/FCM through
   `/v1/mobile/devices`) and a custom `t3-agent-notifications` module. A coding-agent app
   depends on "your agent finished" pushes. Capacitor has a push plugin; denext needed:
   - a `denext/mobile` registration + permission API;
   - notification-tap → deep-link routing;
   - T3's relay wiring as thin glue in t3code.

   **Done on the denext side:** `denext mobile add push`, `requestPushPermission` /
   `registerForPush` / `onPushReceived` / `onPushTapped` (and the hooks), and the
   `expo-notifications` shim over them. T3's relay wiring is t3code's own glue.

2. **OTA runtime-version gate.** `expo-updates` refuses an update built for a newer native layer
   (`runtimeVersion`). In 2.8.3 denext's OTA did not check this: an OTA UI whose JS calls a
   native plugin the installed binary lacks would boot and then fail, and the 15 s watchdog only
   catches a UI that never boots. denext 2.9.0 shipped the fix: the manifest carries `minNative`
   (`denext ota manifest --min-native`), and the native plugin refuses with code `native_too_old`
   when the installed binary is older; a signed `sequence` makes native refuse a lower one with
   code `downgrade`. Both live inside the v2 signed payload. The fingerprint check of the native
   layer (Expo's `mobile-fingerprint-check` equivalent) followed: `denext mobile fingerprint`
   hashes it (`--diff` explains a change, `--write` embeds it in the binary), and
   `denext ota manifest --native-fingerprint` stamps it into the signed payload (v3), so the
   native plugin refuses a UI built for another native layer (code `native_mismatch`).

3. **Auth sessions + deep links.** T3 signs in with Clerk via `expo-auth-session` /
   `expo-web-browser`: OAuth in a system browser sheet that returns to the app through a URL
   scheme or universal link. `expo-linking` also carries pairing links. Needed in
   `denext/mobile`:
   - `openAuthSession()` (ASWebAuthenticationSession on iOS, Custom Tabs on Android);
   - an `onDeepLink` hook (app URL open events, cold and warm start).

   **Done:** `denext mobile add auth-session` / `deep-links`, `openAuthSession` /
   `completeAuthSession` and `onDeepLink` / `useDeepLink`, with the `expo-auth-session`,
   `expo-web-browser` and `expo-linking` shims over them.

4. **App extensions.** T3 ships a share extension, home-screen widgets (`expo-widgets`,
   `t3-subscription-widget`) and Live Activities. These are native targets in either stack;
   Expo wires them in with config plugins. denext now has generators for all three, in the
   style of `add-ota`: `denext mobile add share-extension` (an iOS Share Extension target plus
   Android SEND intent filters, behind `onShareReceived` / `useShareReceived`),
   `denext mobile add widget --name <Name>` (a WidgetKit extension target plus an Android
   `AppWidgetProvider`, behind `setWidgetData` / `reloadWidgets`) and
   `denext mobile add live-activity --name <Name>` (ActivityKit UI in the same extension, iOS
   16.1+ behind `#available`, behind `startLiveActivity` / `updateLiveActivity` /
   `endLiveActivity` / `liveActivityPushToken`). They create the Xcode targets (embedded in the
   app, built before it) and share an App Group (`--app-group`, default `group.<bundle id>`) with
   the app. Also done: configurable widgets (`--configurable <param:enum=a|b,…>`, an App
   Intents `WidgetConfigurationIntent` on iOS 17+ whose provider reads the snapshot
   `setWidgetData(kind, data, { params })` stored for the chosen values; static on iOS 14–16 and
   on Android), ActivityKit push-to-start tokens (`liveActivityPushToStartToken` /
   `onLiveActivityPushToStartToken`, iOS 17.2+, which T3's relay registration sends), per-activity
   token events (`onLiveActivityPushToken`), `listLiveActivities`, and the `expo-widgets` shim
   over all of it. A T3 Capacitor copy with every extension (a configurable widget included)
   builds for device (`xcodebuild`, every target) and for Android (`assembleDebug`). What
   remains is device-only verification: running them signed on a device (the App Group must be
   registered in the developer account), a configurable widget's edit sheet, and a real
   push-to-start push. T3's own widget and Live Activity layouts are app work: the generated
   SwiftUI views are templates to edit.

5. **Native feel on Android.** The honest weak spot. React Native brings `react-native-screens`,
   `gesture-handler`, `reanimated`, native menus (`@react-native-menu/menu`), blur/glass
   (`expo-blur`, `expo-glass-effect`) and SF Symbols (`expo-symbols`). A WebView approximates
   these with CSS, View Transitions and `useBackSwipe`. iOS WKWebView holds up well. The
   Android emulator numbers (a software-rendered emulator on a build host without a GPU) showed
   heavy jank and are not representative. A real Android device measurement is needed before claiming parity
   either way.

## Covered by official Capacitor plugins (wrapped)

| T3 uses (Expo / RN)                         | Capacitor equivalent                                          |
| ------------------------------------------- | ------------------------------------------------------------- |
| `expo-haptics`                              | `@capacitor/haptics`                                          |
| `expo-clipboard`, `expo-paste-input`        | `@capacitor/clipboard`                                        |
| `expo-sharing`                              | `@capacitor/share`                                            |
| `expo-file-system`                          | `@capacitor/filesystem`                                       |
| `expo-device`, `expo-constants`             | `@capacitor/device`, `@capacitor/app`                         |
| `expo-network`                              | `@capacitor/network`                                          |
| `expo-splash-screen`                        | `@capacitor/splash-screen`                                    |
| `expo-image-picker`, `expo-document-picker` | `@capacitor/camera`, file-picker plugin                       |
| `expo-camera` (pairing QR scan)             | barcode-scanner plugin                                        |
| `expo-keep-awake`                           | keep-awake plugin                                             |
| `expo-quick-actions`                        | app-shortcuts plugin (community)                              |
| `expo-secure-store`                         | secure-storage plugin                                         |
| `expo-audio`, `expo-video`                  | Web Audio / `<video>` in the WebView; native plugin if needed |
| `expo-image-manipulator`                    | Canvas / OffscreenCanvas in the WebView                       |

The pattern, now applied to every row:

- `denext mobile add <capability>` installs the plugin and registers it natively;
- a typed hook in `denext/mobile` wraps it.

That keeps "no `@capacitor/*` imports in app code" true, and each hook gets a web / Deno Desktop
fallback for free. **Done:** `haptic`, `readClipboard` / `writeClipboard`, `share`,
`readFile` / `writeFile` (and the rest of the file API), `deviceInfo`, `networkStatus`,
`hideSplash`, `pickImage` / `pickDocument`, `scanBarcode`, `useKeepAwake`,
`setQuickActions` / `onQuickAction` and `secureStore` (the general form of what T3's shell did
with its own Keychain code); audio, video and image manipulation use the WebView's own APIs
through the `denext/expo/*` shims.

## Already covered, or better, on the denext side

- **OTA updates** (`expo-updates`): done in denext 2.7–2.8, with an app-driven update prompt
  and signed manifests (ECDSA P-256, public key in the binary). The native-version gate and
  downgrade protection (gap 2) shipped in 2.9.0.
- **Momentum scrolling in virtualized lists** (what `FlashList` / `FlatList` get natively):
  denext 2.8.3 keeps iOS WebKit's momentum fling alive while a virtualized list (LegendList,
  react-virtuoso, TanStack Virtual) corrects its scroll offset — on by default, in Capacitor and
  iOS Safari alike (`momentumSafeScroll: false` opts out).
- **Local database** (`expo-sqlite`): `openSqlite` in `denext/mobile` and the
  `denext/expo/sqlite` shim over it: a file through `@capacitor-community/sqlite` in the shell
  (`denext mobile add sqlite`), and on the web the app's own `@sqlite.org/sqlite-wasm` in a
  worker, persisted to OPFS through the `opfs-sahpool` VFS (no cross-origin isolation needed).
- **Keyboard + safe areas**: `useKeyboardInset`, `SAFE_AREA_CSS`, `useBackSwipe`, `useAppResume`.
- **Terminal, composer editor, markdown, diff review, syntax highlighting.** T3 wrote native
  modules for these:
  - `t3-terminal`
  - `t3-composer-editor`
  - `t3-markdown-text`
  - `t3-review-diff`
  - `react-native-nitro-markdown`
  - `react-native-shiki-engine`

  The web UI already has them (xterm, contenteditable, Shiki). This is the strongest part of
  the pitch: roughly 150k lines of React Native reimplementation that is simply not needed.
- **On-device Apple AI** (`@react-native-ai/apple`): niche; a native plugin if T3 needs it.

## Developer-experience gaps

- **Live reload on device** (`expo-dev-client` + Metro): **done.** `denext mobile dev` points
  the Capacitor shell at `denext dev` for the session (`--lan` for a physical device, restored
  on exit), and `allowedDevOrigins` / `denext dev --lan` let the phone in. The desktop half of
  dev-server attach is tracked in ROADMAP.
- **Build + CI** (EAS Build / Submit, preview builds, `mobile-fingerprint-check`): covered by
  `examples/capacitor-ci`, a GitHub Actions recipe that runs the fingerprint check from gap 2 and
  either ships a signed OTA manifest or builds signed binaries (`xcodebuild archive` with an App
  Store Connect API key, a keystore-signed `bundleRelease`). Store submission and preview builds
  stay the app's own steps.

## Compatibility layer: running Expo / React Native apps

Everything above is about denext/Capacitor apps consuming Capacitor plugins the way Expo apps
consume `expo-*` packages. A different, larger question: could an existing Expo / React Native
app's source run on denext mostly unchanged, the way a Next.js app does? That's a compatibility
layer, in three parts.

1. **Components** (`<View>`, `<Text>`, `StyleSheet`, `FlatList`, `Pressable`, `Animated`,
   `Platform`, `Linking` …).
   - react-native-web already implements the React Native primitives on the DOM, on top of
     React/ReactDOM, which denext's compat stands in for.
   - T3's 5,121 vitest tests pass against denext's React compat, which shows the alias approach
     works.
   - denext work:
     - run react-native-web on denext compat and fix what breaks;
     - a bundler "react-native" resolve mode: `react-native` → `react-native-web`, `.web.tsx`
       before `.tsx`, the `__DEV__`/`global` defines, and Metro-style `require("./img.png")`
       with `@2x`/`@3x`. **Done (B2.1):** `reactNative: true` in `denext.config.ts` (SPA mode;
       [guide](https://denext.dev/docs/react-native)). It covers every item of the resolve-mode
       spec below except uniwind (a documented recipe) and the web entry, which stays the app's.
       `require("./img.png")` works through the file loader; `@2x`/`@3x` variants are not
       picked by pixel ratio (documented). T3's `apps/mobile` builds with it and no denext patch;
       all 41 swept deep-link routes render the same text as the patched build;
     - `denext migrate --from expo`. **Done:** writes `deno.json`, a `reactNative`
       `denext.config.ts` with the app's own entry and a `capacitor.config.ts`; reads the app
       config statically (never runs it); reports each `expo-*` package's shim status, the
       native-only packages and Metro-only modules, and the `denext mobile add` command.
       expo-router works: React Native mode generates its `require.context` route context
       from `app/`. On a fresh copy of T3's `apps/mobile` the migrated app builds once the
       flagged packages get the app's stubs, and all 41 routes render clean;
2. **`expo-*` API shims**, aliased the same way `react` → denext is. **Done:** `denext/expo/*`,
   one module per package (35, every `expo-*` dependency of T3's `apps/mobile`), listed with status and omissions in `src/expo/manifest.ts` (`EXPO_SHIMS`,
   the contract `scripts/parity` checks). React Native mode aliases each listed package (and
   `expo/fetch`) to its shim unless `reactNative: { expoShims: false }`; the shims are prebuilt
   into the shared denext runtime, so their hooks share the app's one instance.
   ([guide](https://denext.dev/docs/react-native#expo-apis); per-package table below.)
   - Each `expo-*` import maps to a `denext/expo/*` module with the same API: a thin layer over
     the `denext/mobile` capability functions, each backed by a Capacitor plugin or a web API.
     Example: `expo-haptics` → `@capacitor/haptics`.
   - The work is finite: T3 uses about 35 `expo-*` packages, and `scripts/parity` can check
     signature parity against each package's types.
   - The limit: some Expo/RN APIs are synchronous because they run over JSI (the sync
     `expo-sqlite` API, MMKV). The Capacitor bridge is async, so those shims are async-only
     unless a web API backs them (localStorage, OPFS sync handles in a worker).
3. **Third-party React Native packages**, in three buckets:
   - **pure JS on RN primitives:** these work once layer 1 works;
   - **packages with a web implementation** (reanimated, gesture-handler, react-native-svg,
     safe-area-context, screens, `@legendapp/list`): these work through `.web.*` resolution with
     reduced features, e.g. reanimated worklets run on the main thread;
   - **native-only** (TurboModules, Nitro, JSI: vision-camera frame processors,
     `react-native-nitro-*`, T3's `t3-terminal`): these can't run in a WebView. Each needs a
     Capacitor-backed shim or stays unsupported. It's the same boundary Expo web has.

**Caveat:** the risk is performance, not feasibility. UI-thread animations, native navigation
stacks and native lists become DOM equivalents. That's fine on iOS WKWebView; Android needs a
real-device measurement.

**First step, a measured spike:** alias `react-native` → `react-native-web` and `expo-*` →
stubs, build T3's `apps/mobile/src` with denext, and count the failures by bucket (resolver,
missing shim, native-only, denext compat bug). Results: [Spike results](#spike-results-2026-09-24)
below.

**Shim status** (Expo SDK 57, versions from T3's `apps/mobile/package.json`):

| Package                  | Status  | Backed by                                                                                                    | Not provided                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expo`                   | partial | react-native-web AppRegistry; web-build native-module semantics                                              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-asset`             | partial | bundled file URLs                                                                                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-audio`             | partial | HTMLAudioElement, MediaRecorder                                                                              | `useAudioSampleListener`, `useAudioPlaylist`, `useAudioPlaylistStatus`, `createAudioPlaylist`, `useAudioStream`, `preload`, `clearPreloadedSource`, `clearAllPreloadedSources`, `getPreloadedSources`, `requestNotificationPermissionsAsync`, `AudioModule`, `IOSOutputFormat`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `expo-auth-session`      | partial | openAuthSession (via expo-web-browser), WebCrypto PKCE                                                       | `AccessTokenRequest`, `RefreshTokenRequest`, `RevokeTokenRequest`, `TokenRequest`, `Request`, `ResponseError`, `TokenError`, `useLoadedAuthRequest`, `useAuthRequestResult`, `requestAsync`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `expo-blur`              | partial | CSS backdrop-filter                                                                                          | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-build-properties`  | stub    | config plugin: identity                                                                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-camera`            | partial | scanBarcode (barcode plugin / BarcodeDetector), permissions                                                  | `PictureRef`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `expo-clipboard`         | partial | readClipboard / writeClipboard                                                                               | `getImageAsync`, `setImageAsync`, `ClipboardPasteButton`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `expo-constants`         | partial | globalThis.**DENEXT_EXPO_CONFIG**                                                                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-crypto`            | partial | WebCrypto                                                                                                    | `aesEncryptAsync`, `aesDecryptAsync`, `AESEncryptionKey`, `AESSealedData`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `expo-dev-client`        | stub    | no-op                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-device`            | partial | user agent + deviceInfo                                                                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-document-picker`   | partial | pickDocument                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-file-system`       | partial | readFile / writeFile / deleteFile + a localStorage index                                                     | `FileHandle`, `UploadTask`, `DownloadTask`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `expo-font`              | partial | FontFace                                                                                                     | `renderToImageAsync`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `expo-glass-effect`      | partial | CSS backdrop-filter; availability false                                                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-haptics`           | full    | haptic                                                                                                       | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-image`             | partial | react-native-web Image / <img>                                                                               | `useImage`, `ImageRef`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `expo-image-manipulator` | partial | canvas                                                                                                       | `useImageManipulator`, `ImageManipulator`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `expo-image-picker`      | partial | pickImage                                                                                                    | `VideoExportPreset`, `UIImagePickerControllerQualityType`, `UIImagePickerPresentationStyle`, `UIImagePickerPreferredAssetRepresentationMode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `expo-keep-awake`        | full    | keep-awake hold (plugin / Wake Lock)                                                                         | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-linking`           | partial | onDeepLink, openExternal                                                                                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-network`           | partial | networkStatus                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-notifications`     | partial | push (permission, token, received, tapped)                                                                   | `getExpoPushTokenAsync`, `scheduleNotificationAsync`, `cancelScheduledNotificationAsync`, `cancelAllScheduledNotificationsAsync`, `getAllScheduledNotificationsAsync`, `getNextTriggerDateAsync`, `getNotificationCategoriesAsync`, `setNotificationCategoryAsync`, `deleteNotificationCategoryAsync`, `getNotificationChannelGroupsAsync`, `getNotificationChannelGroupAsync`, `setNotificationChannelGroupAsync`, `deleteNotificationChannelGroupAsync`, `subscribeToTopicAsync`, `unsubscribeFromTopicAsync`, `registerTaskAsync`, `unregisterTaskAsync`, `BackgroundNotificationTaskResult`, `setAutoServerRegistrationEnabledAsync`, `NotificationTimeoutError`, `AndroidAudioUsage`, `AndroidAudioContentType`, `IosAlertStyle`, `IosAllowsPreviews` |
| `expo-paste-input`       | partial | DOM paste event                                                                                              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-quick-actions`     | partial | setQuickActions / onQuickAction                                                                              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-secure-store`      | partial | secureStore                                                                                                  | `getItem`, `setItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `expo-sharing`           | partial | share, Web Share files                                                                                       | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-splash-screen`     | full    | hideSplash                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-sqlite`            | partial | openSqlite: @capacitor-community/sqlite; the app's @sqlite.org/sqlite-wasm on OPFS (opfs-sahpool) on the web | `openDatabaseSync`, `deleteDatabaseSync`, `deserializeDatabaseAsync`, `deserializeDatabaseSync`, `backupDatabaseAsync`, `backupDatabaseSync`, `addDatabaseChangeListener`, `importDatabaseFromAssetAsync`, `SQLiteSession`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `expo-symbols`           | stub    | fallback / empty box                                                                                         | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-updates`           | partial | prepareUiUpdate / applyUiUpdate (OTA)                                                                        | `setUpdateURLAndRequestHeadersOverride`, `setUpdateRequestHeadersOverride`, `showReloadScreen`, `hideReloadScreen`, `addUpdatesStateChangeListener`, `latestContext`, `emitTestStateChangeEvent`, `resetLatestContext`, `UpdateInfoType`, `UpdatesLogEntryCode`, `UpdatesLogEntryLevel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `expo-video`             | partial | HTMLVideoElement                                                                                             | `VideoAirPlayButton`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `expo-web-browser`       | partial | openExternal, openAuthSession, completeAuthSession                                                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expo-widgets`           | partial | setWidgetData / reloadWidgets, the Live Activity functions and their token events                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Integration (T3's `apps/mobile`, a copy of the spike, `reactNative: true`, every `expo`/`expo-*`
alias to the spike's web-shims/web-stubs removed): the app builds with `index.ts` (its
`registerRootComponent`) as the SPA entry, and all 41 swept routes render clean, with the same
text as the spike's hand-shimmed build. Pairing with a T3 server now succeeds and the home
screen loads the environment (`expo-secure-store` had blocked it). Since then the
`expo-sqlite` stub and the hand `Appearance.setColorScheme` polyfill are gone too: with no
`expo-*` alias left, 41/41 routes render clean, and after pairing and a reload the app's
SQLite database (schema v1, the server-config and shell-snapshot caches) is in OPFS through
`opfs-sahpool` on a page that is not cross-origin isolated (`SharedArrayBuffer` absent, so the
engine's `"opfs"` VFS is unavailable, as expo-sqlite's own web build found). What remains are
the app's stubs for non-Expo native modules (Nitro, T3's native terminal/markdown/review-diff,
`@expo/ui`) and for the two modules its Metro config generates.

**Scope:** rendering stays WebView/DOM. This is API compatibility, not native rendering, so
it's consistent with POLICIES.md.

### Spike results (2026-09-24)

**Setup:** T3's `apps/mobile` built as a denext 2.9.0 SPA, `react-native` → react-native-web
0.21.2. 106 specifiers across 92 native/expo packages aliased to throwing stubs, 13
hand-written web shims, bundler workarounds applied through `denext patch`.

**Outcome:**

- The whole app builds in about 6 s: 2.59 MB minified, 781 KB gzipped (mostly shiki grammars).
- All 33 deep-linked routes render in headless Chromium.
- Against a real T3 server it paired over HTTP and WebSocket, listed the project, and rendered
  the new-task composer with live data (branch, model picker).
- Parity: the same entry built with real react-dom 19.2.3 gives identical route text and
  element counts on 7 routes and identical third-party harness results. The one difference
  was a denext bug (client booleanish attributes), fixed alongside this table.

| Bucket            | Count            | Notes                                                                                                                                                                                                                                                                        |
| ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| resolver          | 9                | Fixed by the resolve mode; the first build had 14 errors                                                                                                                                                                                                                     |
| missing shim      | 18               | 11 threw from stubs; 1 blocked the app (`expo-secure-store`, the connection catalog); 4 degraded (`expo-sqlite`, `expo-file-system`, `expo-font`, `react-native-webview`); react-native-web lacks `Appearance.setColorScheme`; `react-native-image-viewing` has no web build |
| native-only       | 0 hit at runtime | Stubbed without being exercised: `expo-widgets`, `@react-native-ai/apple`, `react-native-nitro-*`, `react-native-shiki-engine`, T3's native terminal/review-diff/markdown modules                                                                                            |
| denext compat bug | 1                | Client booleanish attributes                                                                                                                                                                                                                                                 |

**Resolve-mode spec** (the workarounds that were needed; all but uniwind and the web entry are
now built in as `reactNative: true`):

- `react-native` wins over an installed real RN for every importer. A plain import-map key
  loses: the node_modules resolver finds real RN's Flow source.
- `.web.tsx`/`.web.ts`/`.web.jsx`/`.web.js` first, for relative/alias probes and for package
  subpaths. Without it, native spec files pull RN Flow source (6 parse errors) and screens'
  `TabsHost`/`TabsScreen` fail to resolve.
- A `.js` → jsx loader (one package).
- `__DEV__` and `global` → `globalThis` defines; both are required at runtime (reanimated,
  gesture-handler).
- An Expo-style root style: `html,body,#root{height:100%}` with `#root` as flex. Without it,
  overlays intercept taps.
- uniwind: importer-sensitive aliases, plus the Tailwind input and
  `uniwind generate-artifacts` for extra themes.
- A web entry using `AppRegistry.runApplication` instead of Expo's `registerRootComponent`.
  **Retired** by `denext/expo/expo`: `registerRootComponent` now mounts through react-native-web's
  `AppRegistry`, so the app's own `index.ts` is the entry.
- Not needed: a Flow transform (Flow only arrived through wrong resolution) or an image-require
  shim (the existing file loader works).
- Open: `denext dev` fails. The npm prebundle can't resolve react-native-web's own deps through
  the alias (`styleq`, `fbjs`, `@babel/runtime`, `@react-native/normalize-colors`), and a
  `global.css` with `@import "tailwindcss"` gets a 500.

**Third-party packages through web builds:**

| Worked                                                                                       | Didn't                                    |
| -------------------------------------------------------------------------------------------- | ----------------------------------------- |
| react-native-web: all 12 primitives, zero console errors                                     | react-native-webview (no web platform)    |
| gesture-handler 2.32                                                                         | react-native-image-viewing (no web build) |
| reanimated 4.5.5 (`withTiming` settled near its first frame, same as with real React)        |                                           |
| react-native-svg + tabler icons; safe-area-context; keyboard-controller; uniwind             |                                           |
| react-native-screens + react-navigation native-stack: headers, back, navigate, URL linking   |                                           |
| `@legendapp/list` (1000 items virtualized); `@react-native-menu/menu` (rendered, not opened) |                                           |

**What it means:** the component layer works today on denext compat. What decides B2's scope
is the resolve mode (above) plus about 18 shims, led by `expo-secure-store`, `expo-sqlite`,
`expo-file-system`, `expo-font` and `expo-linking`/`expo-notifications`. The last two map onto
`denext/mobile`'s deep-link and push functions (since shipped, with their shims).

## Suggested order

1. ~~Push notifications, the OTA runtime-version gate, auth sessions + deep links, and the
   `mobile add <capability>` wrapper pattern.~~ Done.
2. ~~App extensions (share, widgets, Live Activities) and dev-server attach.~~ Done: every
   generator, configurable widgets and push-to-start included, and `denext mobile dev`. Left:
   the device-only checks under gap 4, and the desktop half of dev-server attach (ROADMAP).
3. Android native feel: measure on a real device first, then decide what to build. **Open.**
4. ~~The compatibility layer: the measured spike, the `react-native` resolve mode, the
   `denext/expo/*` shims, and `migrate --from expo`.~~ Done. Left: the app's own stubs for
   non-Expo native modules (see Integration above).
