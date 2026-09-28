# denext + Capacitor as a React Native / Expo replacement

What React Native and Expo provide that `denext/mobile` + a Capacitor shell must match before
it is a credible replacement, and where denext stands against it. Two bars:

- **T3 Code's React Native app** (`apps/mobile` in pingdotgg/t3code), whose dependencies were
  audited on 2026-09-24, compared with T3's Capacitor shell (`apps/capacitor`, branch
  `denext-2.x`). The 2.10 line closed its gaps 1–4 (below).
- **The React Native / Expo ecosystem at large**, measured by the 2026-09-27 gap audit: React
  Native's core exports (0.86.3), the Expo SDK 57 packages, the most-downloaded third-party
  libraries and the behaviour React Native developers expect. The 2.11 line is the answer.

**Where it stands (denext 2.11, on `development`).** An existing React Native / Expo app's own
source builds for the web in React Native mode (`reactNative: true`) and runs in the Capacitor
shell, a browser or a Deno Desktop window. react-native-web stays pinned and unforked; denext
replaces its mocked and browser-only modules with implementations over `denext/mobile`, runs
the app's lists on `VirtualList` and its stacks and tabs on `denext/navigation`, stamps
Reanimated's worklets at build time, and resolves the Expo packages and popular community
libraries to denext implementations. The iOS half of the 2.11 mobile surface ran on an iPhone
on 2026-09-27, and native views in the page (`NativeViewSlot`) on 2026-09-28. Android has not
run on a device, and Android scrolling is the one measured gap (gap 5).

**Scope.** Native rendering is out of scope; React Native APIs and apps are supported through
react-native-web plus denext's overlay ([POLICIES.md](./POLICIES.md#engineering-guardrails)).
Rendering stays WebView / DOM. Open items are in [ROADMAP.md](./ROADMAP.md) under "2.11:
React Native / Expo replacement", and every honest limit is in
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) ("Desktop & mobile", "Deno Desktop
capabilities", "React Native mode & Expo shims").

**How each item was verified.** Nothing is claimed beyond these levels:

- **iPhone:** run on a physical iPhone 16e. The 2.10 set ran on 2026-09-25 (iOS 26.x) in
  [`examples/mobile`](./examples/mobile) unless another app is named. The 2.11 set ran on
  2026-09-27 (iOS 26.6.2) in the example's "denext 2.11" screens: an automatic self-test (27
  of 27 checks passed) and a manual checklist walked by hand.
- **Built:** unit- or DOM-tested and compiled (iOS `xcodebuild`, Android Gradle), not run on a
  device. React Native mode itself is tested by building apps with it and rendering them in
  headless Chromium.
- **Emulator:** Android runs only on an emulator, and only the whole-app T3 comparison (gap 5).

**Android has not run on a device.** Every Android capability claim in this file is "built".

## Shipped in 2.11

### React Native mode

Every item below is built and tested (unit, DOM, and app builds rendered in headless Chromium).
React Native mode has not run on a phone as such; the iPhone run exercised a denext app that
uses the same implementations the overlay binds (the dialog behind `Alert`, `PullToRefresh`
behind `RefreshControl`, `VirtualList` behind the lists, `StackView` / `TabsView` behind the
navigators).

- **Shell-backed React Native APIs.** `Keyboard`, `KeyboardAvoidingView`, `BackHandler`,
  `StatusBar`, `AccessibilityInfo`, `I18nManager`, `Alert`, `RefreshControl`, `Linking`,
  `AppState`, `Vibration`, `Share`, `Clipboard`, `SafeAreaView` and `InputAccessoryView` are
  replaced inside the pinned react-native-web for every importer.
- **The core exports react-native-web lacks:** `requireNativeComponent`, `useAnimatedValue` /
  `useAnimatedValueXY` / `useAnimatedColor`, `PermissionsAndroid`, `ToastAndroid`,
  `ActionSheetIOS`, `DevSettings`, `PlatformColor` / `DynamicColorIOS`, `RootTagContext`,
  `NativeAppEventEmitter`, `unstable_batchedUpdates`, and load-safe no-ops for React Native
  internals (`CodegenTypes`, `DevMenu`, `NativeComponentRegistry`, `PushNotificationIOS`,
  `registerCallableModule`, `Systrace`).
- **`Platform`.** `Platform.OS` stays `"web"` (react-native-web and libraries choose their DOM
  paths by it). `Platform.select` falls back to the shell's own `ios` / `android` key (the
  host OS's `macos` / `windows` / `linux` key on Deno Desktop) when the spec has no `web` key;
  `Platform.constants` carries `denextShell`, `denextDesktop`, `osVersion` and the rest.
- **Safe areas.** A `viewport-fit=cover` default viewport, `SafeAreaView` and
  react-native-safe-area-context's provider over `denext/mobile`'s insets.
- **Reanimated without its Babel plugin.** An swc pass stamps each worklet's `__closure` and
  `__workletHash`, so hooks need no dependency arrays. Worklets still run on the main thread,
  but declarative `transform` / `opacity` animations (`withTiming`, `withSpring`, `withDelay`,
  `withSequence`, `withRepeat`) run as Web Animations on the compositor: in headless Chromium
  one kept drawing through a 500 ms main-thread block (`tests/e2e/reanimated.e2e.test.ts`).
  `LayoutAnimation.configureNext` animates the next commit (FLIP).
- **Lists on `VirtualList`.** `FlatList`, `SectionList`, `VirtualizedList`, FlashList v2 and
  LegendList run on denext's engine (`reactNative: { lists: "library" }` keeps the libraries'
  own).
- **expo-router's `Stack` / `Tabs`** and React Navigation's native-stack and bottom-tabs
  are drawn by `denext/navigation`. A real-browser test builds an expo-router 57.0.23 app and
  drives its `Stack` and `Tabs`; it caught two bugs, both fixed: the generated navigator
  module's own imports did not resolve in a real build, and the navigators must be built over
  expo-router's bundled copy of React Navigation (55+), not `@react-navigation/native`.
- **Community packages.** 31 aliases (`src/react-native-compat/manifest.ts`; 8 full, 23
  partial): react-native-keyboard-controller, react-native-safe-area-context,
  react-native-permissions, react-native-keychain, react-native-webview (an `<iframe>`),
  react-native-pager-view, the date pickers, linear-gradient, blur, masked-view,
  `@react-native-menu/menu`, AsyncStorage and MMKV (durable, below), react-native-maps and
  react-native-video (the native views, below), react-native-fast-image (React Native's
  `Image`), NativeWind v4's JSX runtime, `.svg` components and more.
- **Expo shims.** 59 manifest entries (8 full, 45 partial, 6 stub) covering 48 packages,
  including the three that used to stop the bundle at import (expo-tracking-transparency,
  expo-maps, `@expo/ui`) and, over `denext/mobile` capabilities, `expo-store-review`,
  `expo-screen-orientation`, `expo-navigation-bar`, `expo-screen-capture` and
  `expo-media-library` (SDK 57's class API, plus `/legacy`). The generated table is at
  [/docs/react-native#expo-apis](https://denext.dev/docs/react-native#expo-apis).
- **Native primitives behind the packages apps import.** `expo-maps`' `AppleMaps.View` /
  `GoogleMaps.View` and `react-native-maps`' `MapView` are the native `map` view, and
  `expo-video`'s `VideoView` and `react-native-video`'s `Video` the native `video` view, where
  the app registered them (`denext mobile add native-map` / `native-views`); elsewhere a
  labelled placeholder and an HTML `<video>`. `expo-symbols`' `SymbolView` is `<SystemIcon>`.
  This wiring is built and tested; the phone run below used `NativeViewSlot` directly.
- **Your own native code.** `TurboModuleRegistry`, `NativeModules`, `NativeEventEmitter` and
  Expo's `requireNativeModule` / `EventEmitter` reach the app's Capacitor plugin (or desktop
  extension) of that name, asynchronously; `requireNativeComponent` / `codegenNativeComponent`
  and Expo's `requireNativeView` are a native view slot of that type. A top-level
  `requireNativeModule` no longer throws off-device: the stand-in throws only when called.
- **Fast Refresh.** `denext dev` serves React Native mode on the per-module loop: a component
  edit hot-swaps with its state kept (about 75 ms against about 980 ms for a bundled reload with
  the state lost, on a small react-native-web app).
- **Durable storage.** `@react-native-async-storage/async-storage` and `react-native-mmkv`
  write through `denext/mobile`'s key-value store (a SQLite file with `denext mobile add
  storage`); MMKV keeps its synchronous API over an in-memory mirror.
- **More of React Native's surface.** `@2x` / `@3x` image variants picked by pixel ratio; the
  snap props as CSS scroll snap; `Text` and `PixelRatio.getFontScale()` following the OS text
  size (`denext mobile add accessibility`); `onContentSizeChange` on every list;
  `useReducedMotion()` in `denext/mobile`; `DrawerLayoutAndroid`, `Settings`,
  `ProgressBarAndroid`, `TouchableNativeFeedback` and `Image.resolveAssetSource` /
  `getSizeWithHeaders` / `prefetchWithMetadata`.
- **Desktop packages.** `react-native-windows` and `react-native-macos` resolve to
  `react-native` plus their additions (`Flyout`, `Popup`, `Glyph`, `AppTheme`,
  `DynamicColorMacOS`, the desktop `View` props), and `reactNative.desktopPackage` builds the
  app's own bare `react-native` imports as one of them, as Metro does (`migrate --from expo`
  writes it).
- **The parity gate** (`deno task parity:native`) builds the bundle apps actually get, checks
  class statics and object members, and covers the lists and the desktop packages. Its ledger
  holds 41 open React Native deviations: the 32 `*Base` / `*Component` type aliases and
  missing members on 9 exports (`scripts/parity/native/baselines/known-gaps.json`).

### Lists and navigation (denext apps and React Native mode alike)

| Surface                                          | Verified                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VirtualList` / `useVirtualList`                 | **iPhone:** `scrollToIndex` exact on a 100,000-row list, a fling with 0 of 60 blank frames, a chat list anchored to its end, sticky headers, and the feel of scrolling by hand |
| `VirtualMasonry`, `useVirtualReorder`            | Built                                                                                                                                                                          |
| `denext/navigation`: `StackLayout` / `StackView` | **iPhone:** kept screens' state and scroll, the swipe back that follows the finger                                                                                             |
| `TabsLayout` / `TabsView`                        | **iPhone:** each tab keeps its state and scroll                                                                                                                                |
| `Sheet`                                          | **iPhone:** detents                                                                                                                                                            |
| Android predictive back in the stack             | Built                                                                                                                                                                          |

The scroll-bench (`examples/scroll-bench`) compares `VirtualList` and React Native's
`FlatList` API on denext's engine with react-native-web's own engine; the emulator and iPhone
runs of the bench are still to be published in `/docs/lists`.

### `denext/mobile` capabilities

Each is `denext mobile add <capability>` plus typed functions in `denext/mobile`, with a web
fallback where one exists.

| Capability                                                                           | Verified                                                                            |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `keyboard` (`useKeyboard`, `KeyboardAvoidingView`, `KeyboardStickyView`)             | **iPhone:** a chat composer riding the keyboard, and a form                         |
| `system-bars` (`setSystemBars`, `useSystemBarsFollowTheme`)                          | **iPhone:** style, hide and show, following the light / dark theme                  |
| `dialog` (React Native mode's `Alert`)                                               | **iPhone:** the system alert and prompt; the in-page dialog for three buttons       |
| `PullToRefresh` / `RefreshControl`                                                   | **iPhone**                                                                          |
| `permissions` (`checkPermission`, `openAppSettings`)                                 | **iPhone:** statuses and opening Settings                                           |
| `local-notifications`                                                                | **iPhone:** scheduling, action buttons, tap routing                                 |
| `geolocation`                                                                        | **iPhone**                                                                          |
| `screen-orientation`                                                                 | **iPhone:** lock and unlock                                                         |
| `privacy-screen`                                                                     | **iPhone**                                                                          |
| `tracking` (App Tracking Transparency)                                               | **iPhone:** the prompt                                                              |
| `app-review`                                                                         | **iPhone:** the review sheet                                                        |
| `media-library`                                                                      | **iPhone:** saving an image to Photos                                               |
| Safe areas v2 (`useSafeAreaInsets`)                                                  | **iPhone:** the self-test's inset checks; the bottom inset is **not validated** yet |
| `biometrics`                                                                         | Built (Face ID was not enrolled on the test phone)                                  |
| `social-login` (Sign in with Apple / Google)                                         | Built                                                                               |
| `purchases` (RevenueCat)                                                             | Built (no sandbox purchase run)                                                     |
| `sentry` (`initCrashReporting`)                                                      | Built                                                                               |
| `background` (`defineBackgroundTask`), `background-location`                         | Built                                                                               |
| `back` (Android back and predictive back), `restore` (Android process death)         | Built (Android only)                                                                |
| `app-update`, `accessibility` (screen reader state), `application`, `offline-screen` | Built                                                                               |
| `toast`, `action-sheet` (the system UI behind `ToastAndroid` / `ActionSheetIOS`)     | Built                                                                               |
| `readSafeAreaInsets()` / `watchSafeAreaInsets(cb)` (insets outside a component)      | Built                                                                               |
| `native-views`, `native-map` (`NativeViewSlot`)                                      | **iPhone:** see below                                                               |
| `native-module` (`nativeModule`, `onNativeEvent`)                                    | Built                                                                               |
| `storage` (`openKeyValueStore`, durable AsyncStorage / MMKV)                         | Built                                                                               |
| `system-icons` (`<SystemIcon>`), `context-menu` (`useContextMenu`)                   | Built                                                                               |
| `accessibility` font scale (`getFontScale`, `applyFontScale`), `useReducedMotion`    | Built                                                                               |

**Native views on the iPhone** (2026-09-28, [`examples/native-views`](./examples/native-views):
maps and a video in a `VirtualList`): the video drawn under the WebView as an
`AVPlayerViewController` with the system controls and AVKit's fullscreen (`placement: "auto"`
picks `"under"` for `video` on iOS, `"embed"` for other types, `"over"` on Android); taps
reaching embedded views; under / over views following a fling natively; a vertical swipe that
starts on the video scrolling the list with native momentum (`scrollPassthrough`, the default
for `video`, iOS only); a Fast Refresh edit keeping the list position and the playing video;
and a reload removing the old page's views. The Android native views are built, not run.

Store and release tooling is built and tested, not device-run: `denext mobile assets | build |
submit` (a nightly workflow builds `examples/mobile` for both platforms), the iOS privacy
manifest (`denext mobile privacy`), `denext mobile doctor --store | --release`, `denext mobile inspect`,
hidden source maps (`denext export --sourcemaps hidden`) and the `appLinks` association files.

### The app's backend

Built and tested (unit and integration), not run from a device: the `cors` config,
`denextAuth({ native })` native sessions (PKCE code exchange, bearer plus rotating refresh,
the absolute lifetime and the concurrent-refresh grace window), native Sign in with Apple /
Google (`POST /auth/native/:provider`), account deletion (`POST /auth/account/delete`),
`createApiClient({ base, auth })` with `nativeSession()`, `createPushSender` / `sendPush`
(APNs and FCM with no npm package), OTA channels with staged rollouts, and
`verifyRevenueCatWebhook`.

### Deno Desktop

`denext/mobile`'s capability functions reach the desktop runtime through a token-gated bridge,
and the runtime answers `fs`, `sqlite`, `device`, `dialogs` (native open / save / folder
panels, returning picked-file handles), `shell`, `keep-awake`, `secure-store` (macOS Keychain,
Linux libsecret; it fails closed on Windows) and the app's own `defineDesktopExtension`
modules. `context-menu`, `clipboard` and `notifications` stay WebView-backed (no runtime
capability; a scheduled notification rejects). `denext desktop add` writes
`desktop.capabilities`, the runtime's allowlist, and the packaging scripts derive
least-privilege `--allow-*` flags from it instead of `-A`
(`denext desktop package --regenerate-scripts` updates an older project's scripts). Built and
unit-tested; a real `deno desktop` build with the derived flags launched and served its bundle
on macOS. React Native apps run in a Deno Desktop window like any SPA
(`examples/rn-desktop`).

## Android

**Android has run on an emulator only, and only the T3 comparison below.** Every Android half
of `denext/mobile`, the `denext mobile add` generators and React Native mode's shell-backed
APIs is built (unit-tested, Gradle-compiled), not run. Android scrolling is the one measured
gap against React Native (gap 5). There is no Android parity claim until a real device run;
the user has no Android device yet, and a device farm is an option.

## Remaining gaps

The honest ones, deduplicated; KNOWN-LIMITATIONS.md has the user-facing wording and ROADMAP.md
the open work.

- **No UI-thread animation or gesture runtime.** Reanimated's worklets run on the page's main
  thread, sharing it with React and layout; only declarative `transform` / `opacity`
  animations move to the compositor. WKWebView also caps `requestAnimationFrame` at 60 Hz on
  120 Hz iPhones (WebKit bug 294338), and nothing has been measured on a 120 Hz display.
- **No synchronous JSI APIs:** the sync `expo-sqlite` API, MMKV-class sync stores,
  `expo-secure-store`'s `getItem` / `setItem`, Nitro HybridObjects, camera frame processors.
- **Native views are layers, not DOM.** Maps and video are native views on a slot
  (`NativeViewSlot`), embedded in the page's scroll view on iOS or drawn under / over the
  WebView; on the web the Expo and community map packages show a placeholder (MapLibre or
  Leaflet in a `.web.tsx` twin). Liquid Glass, native tab bars and headers are CSS, and
  `@expo/ui` SwiftUI / Compose views are stand-ins. Android's native views have not run.
- **Background execution.** JavaScript does not run in the page while the WebView is suspended;
  background tasks run in Capacitor's Background Runner without the DOM.
- **Accessibility settings:** Dynamic Type and Android's font scale reach the page through
  `denext mobile add accessibility`, but bold text and grayscale always read false, and focus
  is not moved to a new screen.
- **Fast Refresh reloads for dependency changes.** A component edit hot-swaps with state kept;
  the first import of a new package (or of a new name from one), an added or removed
  expo-router route, and a `package.json` / lockfile change rebuild the dependency bundle and
  reload the page.
- **Build-time failures** remain for unlisted packages whose `main` is Flow source.
- **Expo services:** no Expo Go-style client, no hosted push, build or update service.
- **Android:** no device run; scrolling measured worse than React Native on an emulator.
- **Desktop:** no runtime capability for context menus, the clipboard or notifications;
  `secureStore` fails closed on Windows; no app menu, tray or single-instance API; Deno Desktop
  itself is experimental.

## The T3 Code bar (2.10)

The 2.10 line was measured against T3 Code's app. Its gaps and the compatibility layer's first
version are kept here as the record; the status above supersedes them where they differ.

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
   widget, a Live Activity, and a Live Activity started by a real APNs push-to-start push
   (2026-09-27: `event: start`, `attributes-type: DenextActivityAttributes`, topic
   `<bundle>.push-type.liveactivity`, HTTP 200 and on the Lock Screen). **Built only:** every
   Android half (Android widgets are static). T3's own widget and Live Activity
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

### Covered by official Capacitor plugins (wrapped)

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

### Already covered, or better, on the denext side

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
  in-page menu that lists every item; since 2.11 `denext mobile add context-menu` ships the
  `DenextContextMenu` plugin (`UIContextMenuInteraction` / `UIMenu` on iOS, `PopupMenu` on
  Android). Built.
- **Keyboard + safe areas**: in 2.10, `useKeyboardInset`, `SAFE_AREA_CSS`, `useBackSwipe` and
  `useAppResume`; 2.11 adds `useKeyboard`, `KeyboardAvoidingView`, `KeyboardStickyView`,
  `useSafeAreaInsets` and Android back (see "Shipped in 2.11").
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

### Developer-experience gaps

- **Live reload on device** (`expo-dev-client` + Metro): **shipped (2.10.0-rc.3).**
  `denext mobile dev` points the Capacitor shell at `denext dev` for the session (`--lan` for a
  physical device, restored on exit), and `allowedDevOrigins` / `denext dev --lan` let the
  phone in. **Verified on the iPhone (2026-09-25):** a source edit reloads on the device.
  Getting there found three bugs, all fixed for 2.10.0: iOS needs `NSAllowsLocalNetworking` and a
  local-network usage string in `Info.plist` (now added for the session); the restore now scrubs
  the dev URL from the native config copies itself; and unbundled dev sent an SPA's own
  `import "./styles.css"` through the JS transform, which failed the page before it hid the
  splash. The desktop half of dev-server attach shipped too: `denext desktop dev` opens a Deno
  Desktop window whose runtime reverse-proxies HTTP + HMR to `denext dev`.
- **Build + CI** (EAS Build / Submit, preview builds, `mobile-fingerprint-check`): **shipped
  (2.10.0-rc.3)** as `examples/capacitor-ci`, a GitHub Actions recipe that runs the fingerprint
  check from gap 2 and either ships a signed OTA manifest or builds signed binaries
  (`xcodebuild archive` with an App Store Connect API key, a keystore-signed `bundleRelease`).
  Since 2.11 the pipeline is also three verbs, `denext mobile assets` (icons and splash),
  `denext mobile build ios|android` (signed `.ipa` / `.aab`, flavors) and `denext mobile submit`
  (App Store Connect / Google Play), and `.github/workflows/mobile-build.yml` runs it nightly on
  `examples/mobile` (Android debug + signed flavor release, unsigned iOS). Preview builds and a
  hosted macOS builder remain the app's own.
- **Surface parity gate:** `deno task parity:native` (2.10.0) diffs the React Native surface
  denext serves against React Native's declared one, failing on any deviation not waived or
  already in the known-gaps ledger; it runs on PRs to `main`. Its `expo` half diffs each
  `denext/expo/*` shim against the pinned `expo-*` package's types (a committed baseline,
  refreshed with `deno task parity:native:refresh -- expo`) minus the shim's `omitted` list.
  In 2.11 it builds the bundle React Native mode actually produces (overlay and added exports
  included) instead of reading raw react-native-web, checks class statics and object members,
  and gained the lists and the `react-native-windows` / `react-native-macos` halves.

### Compatibility layer: running Expo / React Native apps

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
     `require("./img.png")` works through the file loader; `@2x`/`@3x` variants were not picked
     by pixel ratio then (2.11 picks them). rc.3 added `Appearance.setColorScheme`, the codegen /
     TurboModule entry points and expo-router's route context;
   - **`denext migrate --from expo`** (2.10.0-rc.3): writes `deno.json`, a `reactNative`
     `denext.config.ts` with the app's own entry and a `capacitor.config.ts`; reads the app
     config statically (never runs it); reports each `expo-*` package's shim status, the
     native-only packages and Metro-only modules, and the `denext mobile add` command. On a
     fresh copy of T3's `apps/mobile` the migrated app builds once the flagged packages get
     the app's stubs, and all 41 routes render clean.
2. **`expo-*` API shims**, aliased the way `react` → denext is. **Shipped (2.10.0-rc.3):**
   `denext/expo/*`, one module per package (35 in 2.10.0-rc.3, including `expo` itself: every
   `expo-*` dependency of T3's `apps/mobile`; 53 manifest entries in 2.11), listed with status
   and omissions in `src/expo/manifest.ts` (`EXPO_SHIMS`). React Native mode aliases each listed package (and `expo/fetch`) to its shim
   unless `reactNative: { expoShims: false }`; the shims are prebuilt into the shared denext
   runtime, so their hooks share the app's one instance
   ([guide](https://denext.dev/docs/react-native#expo-apis), with the per-package table). The
   limit: some Expo/RN APIs are synchronous because they run over JSI (the sync `expo-sqlite`
   API, MMKV). The Capacitor bridge is async, so those are omitted or answered from an index
   the shim keeps.
3. **Third-party React Native packages**, in three buckets:
   - **pure JS on RN primitives:** work once layer 1 works;
   - **packages with a web implementation** (reanimated, gesture-handler, react-native-svg,
     screens): work through `.web.*` resolution with reduced features, e.g. reanimated
     worklets run on the main thread (safe-area-context and `@legendapp/list` were in this
     bucket until 2.11 resolved them to denext implementations). React Native mode
     stamps each worklet's `__closure` / `__workletHash` at build time, as Reanimated's Babel
     plugin does, so hooks need no dependency arrays
     ([guide](https://denext.dev/docs/react-native#reanimated-and-worklets));
   - **native-only** (TurboModules, Nitro, JSI: vision-camera frame processors,
     `react-native-nitro-*`, T3's `t3-terminal`): can't run in a WebView. Each needs a
     Capacitor-backed shim or a web replacement of the app's own. It's the same boundary Expo
     web has. A TurboModule / Fabric codegen package (and, since 2.11, a
     `requireNativeComponent` view) loads and fails only when its native module is used. Two
     kinds still fail earlier: a package whose `main` is Flow source (a parse error at build
     time) and an Expo module that calls `requireNativeModule` at the top level (it throws at
     import). 2.11's community-package aliases and Expo shims cover the common ones
     (datetimepicker, linear-gradient, expo-tracking-transparency, expo-maps, `@expo/ui`, …).

**Caveat:** the risk is performance, not feasibility. UI-thread animations, native navigation
stacks and native lists become DOM equivalents. That's fine on iOS WKWebView; Android is gap 5.

**Shim status.** The per-package table (status, the version matched, what each shim leaves
out) is generated from `EXPO_SHIMS` into
[/docs/react-native#expo-apis](https://denext.dev/docs/react-native#expo-apis)
(`scripts/gen-expo-shim-docs.ts`; a test fails when it is stale), so it is not repeated here.
The 2.10.0-rc.3 set was 35 shims for T3's `expo-*` dependencies; 2.11 has 53 manifest entries
for 43 packages. Each row's native half is only as verified as the capability it wraps (the
tables above).

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

#### Spike results (2026-09-24)

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
  **Since addressed:** React Native mode ran `denext dev` on the bundled loop (2.10.0-rc.2), so
  the per-module prebundle was not involved; a root-entry rebuild loop was fixed in rc.3; the
  Tailwind input goes through the uniwind recipe's `tailwind` config; and 2.11 moved React
  Native mode to the per-module loop with Fast Refresh, its packages in one dependency bundle.

**Third-party packages through web builds:**

| Worked                                                                                       | Didn't                                    |
| -------------------------------------------------------------------------------------------- | ----------------------------------------- |
| react-native-web: all 12 primitives, zero console errors                                     | react-native-webview (no web platform)    |
| gesture-handler 2.32                                                                         | react-native-image-viewing (no web build) |
| reanimated 4.5.5 (`withTiming` settled near its first frame, same as with real React)        |                                           |
| react-native-svg + tabler icons; safe-area-context\*; keyboard-controller\*; uniwind         |                                           |
| react-native-screens + react-navigation native-stack: headers, back, navigate, URL linking   |                                           |
| `@legendapp/list` (1000 items virtualized); `@react-native-menu/menu` (rendered, not opened) |                                           |

\* They rendered, but keyboard-controller's web binding does nothing and safe-area-context's
insets were 0 in the iOS shell (no `viewport-fit=cover`). Since 2.11 React Native mode resolves
both to `denext/mobile` implementations and defaults the viewport to `viewport-fit=cover`.

**What it means:** the component layer works today on denext compat. What decides B2's scope
is the resolve mode (above) plus about 18 shims, led by `expo-secure-store`, `expo-sqlite`,
`expo-file-system`, `expo-font` and `expo-linking`/`expo-notifications`. The last two map onto
`denext/mobile`'s deep-link and push functions (since shipped, with their shims).

## Status and next steps

1. ~~Push notifications, the OTA runtime-version gate, auth sessions + deep links, and the
   `mobile add <capability>` wrapper pattern.~~ Shipped (2.9.0, 2.10.0-rc.1–rc.3); verified on
   the iPhone.
2. ~~App extensions (share, widgets, Live Activities) and dev-server attach for phones and
   Deno Desktop.~~ Shipped (2.10); verified on the iPhone, including a real push-to-start push.
3. ~~The compatibility layer: the resolve mode, the `denext/expo/*` shims and
   `migrate --from expo`.~~ Shipped (2.10).
4. ~~The 2.11 React Native / Expo replacement: the overlay, lists, navigation, the platform
   capabilities, store tooling and the app backend.~~ Shipped on `development` for 2.11; the
   iOS capabilities listed above verified on the iPhone on 2026-09-27.
5. ~~The desktop runtime behind the desktop capabilities (storage that persists,
   capability-derived packaging permissions).~~ Shipped for 2.11 (built and unit-tested).
   **Still open:** the iPhone items not yet validated (the bottom safe-area inset, biometrics
   with Face ID enrolled, social login, a sandbox purchase, Sentry, background tasks and
   location, and the round-3 items marked "Built" above); a migrated React Native app on a
   phone; the scroll-bench numbers in `/docs/lists`.
6. **Android. Open.** The emulator comparison has run (gap 5): Capacitor starts faster and uses
   less memory, and React Native scrolls smoother. Next: a real device. No Android parity claim
   before that.
