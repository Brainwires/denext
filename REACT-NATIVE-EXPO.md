# denext + Capacitor as a React Native / Expo replacement

What React Native and Expo provide that `denext/mobile` + a Capacitor shell must match before
it is a credible replacement. The bar is concrete: T3 Code's React Native app (`apps/mobile`
in pingdotgg/t3code), whose dependencies were audited on 2026-09-24. The comparison target is
T3's Capacitor shell (`apps/capacitor`, branch `denext-2.x`), which wraps T3's existing web UI.

**Where it stands (denext 2.10.0).** Every gap below is shipped on the denext side except
Android native feel (gap 5), which is open. Not audited: which T3 screens use which
dependency, so the ranking was by expected day-one impact, not measured usage.

This is about matching what React Native / Expo **apps** get, not about rendering natively:
per [POLICIES.md](./POLICIES.md#engineering-guardrails), React Native / native rendering is
out of scope and Capacitor/WebView stays the mobile story. Open items are tracked in
[ROADMAP.md](./ROADMAP.md) under "Mobile (Capacitor) parity".

**How each item was verified.** Two levels, and nothing is claimed beyond them:

- **iPhone:** run on a physical iPhone 16e (iOS 26.x) on 2026-09-25, in
  [`examples/mobile`](./examples/mobile) (one screen per `denext/mobile` capability) unless
  another app is named.
- **Built:** unit-tested and compiled (iOS `xcodebuild` and Android Gradle), not run on a
  device.

**Android has run on an emulator only (the T3 comparison in gap 5), not on a device.** Every
Android capability claim in this file is "built".

## Real gaps (denext work)

1. **Push notifications.** T3 uses `expo-notifications` plus its own relay (APNs/FCM through
   `/v1/mobile/devices`) and a custom `t3-agent-notifications` module. A coding-agent app
   depends on "your agent finished" pushes.

   **Shipped (2.10.0-rc.1):** `denext mobile add push`, `requestPushPermission` /
   `registerForPush` / `onPushReceived` / `onPushTapped` (and the hooks), and the
   `expo-notifications` shim over them. **iPhone:** permission, the APNs token, delivery
   through the APNs sandbox, and tap routing both warm (to `/detail/7`) and from a cold start
   (to `/detail/9`). **Android:** built; FCM needs the app's `google-services.json`. T3's
   relay wiring is t3code's own glue.

2. **OTA runtime-version gate.** `expo-updates` refuses an update built for a newer native layer
   (`runtimeVersion`). denext 2.8.3's OTA did not check this: an OTA UI whose JS calls a native
   plugin the installed binary lacks would boot and then fail.

   **Shipped:** in 2.9.0, the manifest's `minNative` (`denext ota manifest --min-native`,
   refused as `native_too_old`) and a signed `sequence` (a lower one is refused as
   `downgrade`), both in the v2 signed payload. In 2.10.0-rc.3, the native-layer fingerprint
   (Expo's `@expo/fingerprint` equivalent): `denext mobile fingerprint` hashes it (`--diff`
   explains a change, `--write` embeds it in the binary), and
   `denext ota manifest --native-fingerprint` stamps it into a v3 signed payload, so the native
   plugin refuses a UI built for another native layer (`native_mismatch`). **iPhone:** a signed
   manifest over LAN `http`, then prepare, apply and a reload into the new UI. The three refusal
   codes are built (unit-tested), not exercised on the phone.

3. **Auth sessions + deep links.** T3 signs in with Clerk via `expo-auth-session` /
   `expo-web-browser`: OAuth in a system browser sheet that returns to the app through a URL
   scheme or universal link. `expo-linking` also carries pairing links.

   **Shipped (2.10.0-rc.1):** `denext mobile add auth-session` / `deep-links`,
   `openAuthSession` / `completeAuthSession` and `onDeepLink` / `useDeepLink`, with the
   `expo-auth-session`, `expo-web-browser` and `expo-linking` shims over them. In 2.10.0,
   `openAuthSession` also works in a Deno Desktop window (the system browser plus a one-shot
   loopback redirect, RFC 8252; built). **iPhone:** the auth session and deep links in
   `examples/mobile`; in T3 Code's Capacitor app, deep links from a cold and a warm start, and
   the pairing link ignored as intended.

4. **App extensions.** T3 ships a share extension, home-screen widgets (`expo-widgets`,
   `t3-subscription-widget`) and Live Activities. These are native targets in either stack;
   Expo wires them in with config plugins.

   **Shipped (2.10.0-rc.3):** generators in the style of `add-ota`, each creating its Xcode
   target (embedded in the app, built before it) and sharing an App Group with the app
   (`--app-group`, default `group.<bundle id>`):
   - `denext mobile add share-extension`: an iOS Share Extension plus Android `SEND` intent
     filters, behind `onShareReceived` / `useShareReceived`;
   - `denext mobile add widget --name <Name> [--configurable <param:enum=a|b,…>]`: a WidgetKit
     extension plus an Android `AppWidgetProvider`, behind `setWidgetData` / `reloadWidgets`;
     configurable widgets use an App Intents `WidgetConfigurationIntent` (iOS 17+);
   - `denext mobile add live-activity --name <Name>`: ActivityKit UI in the same extension (iOS
     16.1+), behind `startLiveActivity` / `updateLiveActivity` / `endLiveActivity`, the push
     token events, push-to-start tokens (iOS 17.2+) and `listLiveActivities`.

   The `expo-widgets` shim drives all of it. **iPhone:** the share extension, a configurable
   widget and a Live Activity. **Built only:** a Live Activity started by a real push-to-start
   push, and every Android half (Android widgets are static). T3's own widget and Live Activity
   layouts are app work: the generated SwiftUI views are templates to edit.

5. **Native feel on Android. Open: measured on an emulator, scrolling is behind.** React Native
   brings `react-native-screens`, `gesture-handler`, `reanimated`, native menus
   (`@react-native-menu/menu`), blur/glass (`expo-blur`, `expo-glass-effect`) and SF Symbols
   (`expo-symbols`). A WebView approximates these with CSS, View Transitions, `useBackSwipe` and
   `showContextMenu`. iOS WKWebView holds up well.

   **Android emulator comparison (2026-09-25).** T3's Capacitor release APK (19.1 MB) against its
   RN/Expo release APK (96.3 MB), both opening the same 200-message thread. The emulator was API 35
   `google_apis` x86_64, a Pixel 6 profile, `-gpu host` on a 2017 Intel Mac, with the image's built-in
   WebView 124. Two runs, each with 5 interleaved cold starts and 10 flings per app:

   |                                                      |        Capacitor |          RN/Expo |
   | ---------------------------------------------------- | ---------------: | ---------------: |
   | Cold start to first frame, median                    |      1.96–2.02 s |      4.38–4.87 s |
   | PSS after launch (Capacitor: app + WebView renderer) |       221–229 MB |       247–248 MB |
   | PSS after scrolling                                  |       267–274 MB |       303–328 MB |
   | SurfaceFlinger frames missing vsync while flinging   |           67–70% |           25–28% |
   | SurfaceFlinger frame time p50 / p95                  | 31–33 / 52–63 ms | 19–20 / 35–37 ms |

   Only the comparison between the two apps means anything. On a real phone both apps would be
   much faster, and the phone would have a newer WebView than this image's version 124. Cold start
   ends at the first frame, which is the splash screen in both apps, not content. Neither measure
   captures checkerboarding.

   **Read:** Capacitor starts in less than half the time and uses less memory, but **scrolls a long
   list clearly worse than RN on Android**: it misses vsync on more than twice as many frames.
   That is the gap. It is real but not settled: the emulator composites on a weak host GPU, which
   costs a WebView more than native views.
   **Next:** a real Android device, which the user does not have yet. A device farm is an option.
   Then, if the scroll gap holds, profile T3's virtualized list in Chrome's WebView (layer count,
   `content-visibility`). No parity claim for Android scrolling until a device run.

## Covered by official Capacitor plugins (wrapped)

The pattern, applied to every row: `denext mobile add <capability>` installs the plugin and
registers it natively, and a typed function in `denext/mobile` wraps it. That keeps "no
`@capacitor/*` imports in app code" true, and each function gets a web / Deno Desktop fallback.

| T3 uses (Expo / RN)                         | Capacitor equivalent                                          | Shipped          | Verified                                 |
| ------------------------------------------- | ------------------------------------------------------------- | ---------------- | ---------------------------------------- |
| `expo-haptics`                              | `@capacitor/haptics`                                          | 2.10.0-rc.1      | iPhone                                   |
| `expo-clipboard`, `expo-paste-input`        | `@capacitor/clipboard`                                        | 2.10.0-rc.1      | iPhone (clipboard)                       |
| `expo-sharing`                              | `@capacitor/share`                                            | 2.10.0-rc.1      | iPhone                                   |
| `expo-file-system`                          | `@capacitor/filesystem`                                       | 2.10.0-rc.2      | iPhone                                   |
| `expo-device`, `expo-constants`             | `@capacitor/device`, `@capacitor/app`                         | 2.10.0-rc.1      | iPhone (device)                          |
| `expo-network`                              | `@capacitor/network`                                          | 2.10.0-rc.1      | iPhone                                   |
| `expo-splash-screen`                        | `@capacitor/splash-screen`                                    | 2.10.0-rc.1      | iPhone                                   |
| `expo-image-picker`, `expo-document-picker` | `@capacitor/camera`, `@capawesome/capacitor-file-picker`      | 2.10.0-rc.2      | iPhone (camera, photos, document picker) |
| `expo-camera` (pairing QR scan)             | `@capacitor/barcode-scanner`                                  | 2.10.0-rc.2      | iPhone                                   |
| `expo-keep-awake`                           | `@capacitor-community/keep-awake`                             | 2.10.0-rc.1      | iPhone                                   |
| `expo-quick-actions`                        | `@capawesome/capacitor-app-shortcuts`                         | 2.10.0-rc.2      | iPhone                                   |
| `expo-secure-store`                         | `@aparajita/capacitor-secure-storage`                         | 2.10.0-rc.1      | iPhone                                   |
| `expo-sqlite`                               | `@capacitor-community/sqlite`                                 | 2.10.0-rc.3      | iPhone                                   |
| `expo-audio`, `expo-video`                  | Web Audio / `<video>` in the WebView; native plugin if needed | 2.10.0-rc.3 shim | Built                                    |
| `expo-image-manipulator`                    | Canvas / OffscreenCanvas in the WebView                       | 2.10.0-rc.3 shim | Built                                    |

The functions: `haptic`, `readClipboard` / `writeClipboard`, `share`, `readFile` / `writeFile`
(and the rest of the file API), `deviceInfo`, `networkStatus`, `hideSplash`, `pickImage` /
`pickDocument`, `scanBarcode`, `useKeepAwake`, `setQuickActions` / `onQuickAction`,
`secureStore` (the general form of what T3's shell did with its own Keychain code) and
`openSqlite`. Audio, video and image manipulation use the WebView's own APIs through the
`denext/expo/*` shims. Every Android row is built, not run.

## Already covered, or better, on the denext side

- **OTA updates** (`expo-updates`): shipped in 2.7–2.8, with an app-driven update prompt and
  signed manifests (ECDSA P-256, public key in the binary); the gates from gap 2 followed.
  **iPhone:** end to end (gap 2). Deno Desktop gained a signed UI self-updater in 2.10.0
  (`denext/desktop/updater`, the same manifest and signature; built).
- **Momentum scrolling in virtualized lists** (what `FlashList` / `FlatList` get natively):
  since 2.8.3 denext keeps iOS WebKit's momentum fling alive while a virtualized list
  (LegendList, react-virtuoso, TanStack Virtual) corrects its scroll offset, on by default, in
  Capacitor and iOS Safari alike (`momentumSafeScroll: false` opts out).
- **Local database** (`expo-sqlite`): `openSqlite` in `denext/mobile` and the
  `denext/expo/sqlite` shim over it (2.10.0-rc.3): a file through
  `@capacitor-community/sqlite` in the shell (`denext mobile add sqlite`; **iPhone**), and on
  the web the app's own `@sqlite.org/sqlite-wasm` in a worker, persisted to OPFS through the
  `opfs-sahpool` VFS (no cross-origin isolation needed).
- **Context menus** (`@react-native-menu/menu`): `showContextMenu` (2.10.0) opens an accessible
  in-page menu that lists every item, or an app-registered `DenextContextMenu` native plugin
  (denext ships none). Built.
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

- **Live reload on device** (`expo-dev-client` + Metro): **shipped (2.10.0-rc.3).**
  `denext mobile dev` points the Capacitor shell at `denext dev` for the session (`--lan` for a
  physical device, restored on exit), and `allowedDevOrigins` / `denext dev --lan` let the
  phone in. **Verified on the iPhone (2026-09-25):** a source edit reloads on the device.
  Getting there found three bugs, all fixed for 2.10.0: iOS needs `NSAllowsLocalNetworking` and a
  local-network usage string in `Info.plist` (now added for the session); the restore now scrubs
  the dev URL from the native config copies itself; and unbundled dev sent an SPA's own
  `import "./styles.css"` through the JS transform, which failed the page before it hid the
  splash. The desktop half of dev-server attach is open (ROADMAP).
- **Build + CI** (EAS Build / Submit, preview builds, `mobile-fingerprint-check`): **shipped
  (2.10.0-rc.3)** as `examples/capacitor-ci`, a GitHub Actions recipe that runs the fingerprint
  check from gap 2 and either ships a signed OTA manifest or builds signed binaries
  (`xcodebuild archive` with an App Store Connect API key, a keystore-signed `bundleRelease`).
  A recipe, not run in this repository's CI. Store submission and preview builds stay the
  app's own steps.
- **Surface parity gate:** `deno task parity:native` (2.10.0) diffs react-native-web's runtime
  exports against React Native's declared ones, failing on any deviation not waived or already
  in the known-gaps ledger; it runs on PRs to `main`. Its `expo` half diffs each
  `denext/expo/*` shim against the pinned `expo-*` package's types (a committed baseline,
  refreshed with `deno task parity:native:refresh -- expo`) minus the shim's `omitted` list.

## Compatibility layer: running Expo / React Native apps

Everything above is about denext/Capacitor apps consuming Capacitor plugins the way Expo apps
consume `expo-*` packages. A different, larger question: could an existing Expo / React Native
app's source run on denext mostly unchanged, the way a Next.js app does? That's a compatibility
layer, in three parts. **Final state:** T3's Expo app builds with zero `expo` / `expo-*`
aliases, all 41 swept routes render, and pairing persists across reloads through the
`expo-sqlite` shim (in headless Chromium; see Integration below).

1. **Components** (`<View>`, `<Text>`, `StyleSheet`, `FlatList`, `Pressable`, `Animated`,
   `Platform`, `Linking` …). react-native-web implements the React Native primitives on the
   DOM, on top of React/ReactDOM, which denext's compat stands in for; T3's 5,121 vitest tests
   pass against denext's React compat. **Shipped:**
   - **`reactNative: true`** (2.10.0-rc.2; SPA mode;
     [guide](https://denext.dev/docs/react-native)): the resolve mode from the spike, covering
     every item of the spec below except uniwind (a documented recipe).
     `require("./img.png")` works through the file loader; `@2x`/`@3x` variants are not picked
     by pixel ratio (documented). rc.3 added `Appearance.setColorScheme`, the codegen /
     TurboModule entry points and expo-router's route context;
   - **`denext migrate --from expo`** (2.10.0-rc.3): writes `deno.json`, a `reactNative`
     `denext.config.ts` with the app's own entry and a `capacitor.config.ts`; reads the app
     config statically (never runs it); reports each `expo-*` package's shim status, the
     native-only packages and Metro-only modules, and the `denext mobile add` command. On a
     fresh copy of T3's `apps/mobile` the migrated app builds once the flagged packages get
     the app's stubs, and all 41 routes render clean.
2. **`expo-*` API shims**, aliased the way `react` → denext is. **Shipped (2.10.0-rc.3):**
   `denext/expo/*`, one module per package (35 including `expo` itself: every `expo-*`
   dependency of T3's `apps/mobile`), listed with status and omissions in `src/expo/manifest.ts`
   (`EXPO_SHIMS`). React Native mode aliases each listed package (and `expo/fetch`) to its shim
   unless `reactNative: { expoShims: false }`; the shims are prebuilt into the shared denext
   runtime, so their hooks share the app's one instance
   ([guide](https://denext.dev/docs/react-native#expo-apis); per-package table below). The
   limit: some Expo/RN APIs are synchronous because they run over JSI (the sync `expo-sqlite`
   API, MMKV). The Capacitor bridge is async, so those are omitted or answered from an index
   the shim keeps.
3. **Third-party React Native packages**, in three buckets:
   - **pure JS on RN primitives:** work once layer 1 works;
   - **packages with a web implementation** (reanimated, gesture-handler, react-native-svg,
     safe-area-context, screens, `@legendapp/list`): work through `.web.*` resolution with
     reduced features, e.g. reanimated worklets run on the main thread;
   - **native-only** (TurboModules, Nitro, JSI: vision-camera frame processors,
     `react-native-nitro-*`, T3's `t3-terminal`): can't run in a WebView. Each needs a
     Capacitor-backed shim or a web replacement of the app's own. It's the same boundary Expo
     web has. Codegen packages now load and fail only when their native module is used.

**Caveat:** the risk is performance, not feasibility. UI-thread animations, native navigation
stacks and native lists become DOM equivalents. That's fine on iOS WKWebView; Android is gap 5.

**Shim status** (Expo SDK 57, versions from T3's `apps/mobile/package.json`). Every row shipped
in 2.10.0-rc.3 (`expo-widgets` was an inert stub until rc.3 backed it). Verified: unit tests,
plus the T3 integration below; each row's native half is only as verified as the capability
it wraps (the tables above).

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

**Integration** (T3's `apps/mobile`, `reactNative: true`, measured in headless Chromium): with
every `expo` / `expo-*` alias to the spike's hand shims and stubs removed, the app builds with
its own `index.ts` (`registerRootComponent`) as the SPA entry and all 41 swept routes render
clean, with the same text as the spike's hand-shimmed build. Pairing with a T3 server succeeds
and the home screen loads the environment (`expo-secure-store` had blocked it). The
`expo-sqlite` stub and the hand `Appearance.setColorScheme` polyfill are gone too: after pairing
and a reload, the app's SQLite database (schema v1, the server-config and shell-snapshot
caches) is in OPFS through `opfs-sahpool` on a page that is not cross-origin isolated
(`SharedArrayBuffer` absent, so the engine's `"opfs"` VFS is unavailable, as expo-sqlite's own
web build found), and pairing persists. What remains are the app's stubs for non-Expo native
modules (Nitro, T3's native terminal/markdown/review-diff, `@expo/ui`) and for the two modules
its Metro config generates.

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

**Resolve-mode spec** (the workarounds that were needed; all but uniwind are now built in as
`reactNative: true`, and the web entry is retired):

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
- Open at the time: `denext dev` failed. The npm prebundle couldn't resolve react-native-web's
  own deps through the alias (`styleq`, `fbjs`, `@babel/runtime`,
  `@react-native/normalize-colors`), and a `global.css` with `@import "tailwindcss"` got a 500.
  **Since addressed:** React Native mode runs `denext dev` on the bundled loop (2.10.0-rc.2),
  so the per-module prebundle is not involved; a root-entry rebuild loop was fixed in rc.3; and
  the Tailwind input goes through the uniwind recipe's `tailwind` config.

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

## Status and next steps

1. ~~Push notifications, the OTA runtime-version gate, auth sessions + deep links, and the
   `mobile add <capability>` wrapper pattern.~~ Shipped (2.9.0, 2.10.0-rc.1–rc.3); verified on
   the iPhone.
2. ~~App extensions (share, widgets, Live Activities) and dev-server attach for phones.~~
   Shipped (2.10.0-rc.3); verified on the iPhone except a real push-to-start push. Left: the
   desktop half of dev-server attach (ROADMAP).
3. ~~The compatibility layer: the measured spike, the `react-native` resolve mode, the
   `denext/expo/*` shims, and `migrate --from expo`.~~ Shipped (2.10.0-rc.2–rc.3). Left: the
   app's own stubs for non-Expo native modules (see Integration above).
4. **Android. Open.** The emulator comparison has run (gap 5): Capacitor starts faster and uses
   less memory, and RN scrolls smoother. The Android halves of the capabilities are still built,
   not run. Next: a real device. No Android parity claim before that.
