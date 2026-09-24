# denext + Capacitor as a React Native / Expo replacement

What React Native and Expo provide that `denext/mobile` + a Capacitor shell must match before
it is a credible replacement. The bar is concrete: T3 Code's React Native app (`apps/mobile`
in pingdotgg/t3code), whose dependencies were audited on 2026-09-24. The comparison target is
T3's Capacitor shell (`apps/capacitor`, branch `denext-2.x`), which wraps T3's existing web UI.

Most items are "an official Capacitor plugin exists; denext should wrap it in a typed hook".
A few are real gaps. Not yet audited: which T3 screens use which dependency, so the ranking
below is by expected day-one impact, not measured usage.

This is about matching what React Native / Expo **apps** get, not about rendering natively:
per [POLICIES.md](./POLICIES.md#engineering-guardrails), React Native / native rendering is
out of scope and Capacitor/WebView stays the mobile story. The actionable items are tracked in
[ROADMAP.md](./ROADMAP.md) under "Mobile (Capacitor) parity".

## Real gaps (denext work)

1. **Push notifications.** T3 uses `expo-notifications` plus its own relay (APNs/FCM through
   `/v1/mobile/devices`) and a custom `t3-agent-notifications` module. A coding-agent app
   depends on "your agent finished" pushes. Capacitor has a push plugin; denext needs:
   - a `denext/mobile` registration + permission API;
   - notification-tap → deep-link routing;
   - T3's relay wiring as thin glue in t3code.

   The single biggest gap.

2. **OTA runtime-version gate.** `expo-updates` refuses an update built for a newer native layer
   (`runtimeVersion`). In 2.8.3 denext's OTA did not check this: an OTA UI whose JS calls a
   native plugin the installed binary lacks would boot and then fail, and the 15 s watchdog only
   catches a UI that never boots. A native-version gate (a version field in `_denext/ota.json`
   compared natively before download/apply) and downgrade protection are being added in the next
   release. Still open after that: a fingerprint check of the native layer (Expo's
   `mobile-fingerprint-check` equivalent) so CI knows whether a change can ship over the air or
   needs a binary release.

3. **Auth sessions + deep links.** T3 signs in with Clerk via `expo-auth-session` /
   `expo-web-browser`: OAuth in a system browser sheet that returns to the app through a URL
   scheme or universal link. `expo-linking` also carries pairing links. Needed in
   `denext/mobile`:
   - `openAuthSession()` (ASWebAuthenticationSession on iOS, Custom Tabs on Android);
   - an `onDeepLink` hook (app URL open events, cold and warm start).

4. **App extensions.** T3 ships a share extension, home-screen widgets (`expo-widgets`,
   `t3-subscription-widget`) and Live Activities. These are native targets in either stack;
   Expo's advantage is config plugins that wire them into the Xcode/Gradle project. denext's
   equivalent is `denext mobile add-<thing>`, like `add-ota`: doable, but each is real native
   work.

5. **Native feel on Android.** The honest weak spot. React Native brings `react-native-screens`,
   `gesture-handler`, `reanimated`, native menus (`@react-native-menu/menu`), blur/glass
   (`expo-blur`, `expo-glass-effect`) and SF Symbols (`expo-symbols`). A WebView approximates
   these with CSS, View Transitions and `useBackSwipe`. iOS WKWebView holds up well. The
   Android emulator numbers (a software-rendered emulator on a build host without a GPU) showed
   heavy jank and are not representative. A real Android device measurement is needed before claiming parity
   either way.

## Covered by official Capacitor plugins (denext should wrap them)

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

The pattern:

- `denext mobile add <capability>` installs the plugin and registers it natively;
- a typed hook in `denext/mobile` wraps it.

That keeps "no `@capacitor/*` imports in app code" true, and each hook gets a web / Deno Desktop
fallback for free. Secure storage note: T3's Capacitor shell already keeps saved connections in
the iOS Keychain through T3's own storage code; a `denext/mobile` secure-store API would make
that general.

## Already covered, or better, on the denext side

- **OTA updates** (`expo-updates`): done in denext 2.7–2.8, with an app-driven update prompt
  and signed manifests (ECDSA P-256, public key in the binary). The native-version gate and
  downgrade protection (gap 2) are added in the next release.
- **Momentum scrolling in virtualized lists** (what `FlashList` / `FlatList` get natively):
  denext 2.8.3 keeps iOS WebKit's momentum fling alive while a virtualized list (LegendList,
  react-virtuoso, TanStack Virtual) corrects its scroll offset — on by default, in Capacitor and
  iOS Safari alike (`momentumSafeScroll: false` opts out).
- **Local database** (`expo-sqlite`): IndexedDB / OPFS in the WebView; denext ships OPFS hooks.
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

- **Live reload on device** (`expo-dev-client` + Metro): today a change means rebuilding or
  pushing an OTA. The ROADMAP item "Dev server attach for desktop and Capacitor apps (the Metro
  model)" closes it: the shell points at `denext dev` with HMR. Matters a lot for adoption.
- **Build + CI** (EAS Build / Submit, preview builds, `mobile-fingerprint-check`): denext has
  `cap sync` + xcodebuild/gradle, but no "build signed artifacts in CI" story. Needed:
  - a GitHub Actions recipe;
  - the fingerprint check from gap 2.

  Together they cover what T3 actually uses.

## Suggested order

1. Push notifications, the OTA runtime-version gate, auth sessions + deep links, and the
   `mobile add <capability>` wrapper pattern. These are what T3 would hit on day one.
2. App extensions (share, widgets, Live Activities) and dev-server attach.
3. Android native feel: measure on a real device first, then decide what to build.
