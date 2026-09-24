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
   catches a UI that never boots. denext 2.9.0 shipped the fix: the manifest carries `minNative`
   (`denext ota manifest --min-native`), and the native plugin refuses with code `native_too_old`
   when the installed binary is older; a signed `sequence` makes native refuse a lower one with
   code `downgrade`. Both live inside the v2 signed payload. Still open: a fingerprint check of
   the native layer (Expo's `mobile-fingerprint-check` equivalent) so CI knows whether a change
   can ship over the air or needs a binary release.

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
  downgrade protection (gap 2) shipped in 2.9.0.
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
       with `@2x`/`@3x`;
     - `denext migrate --from expo`.
2. **`expo-*` API shims**, aliased the same way `react` → denext is.
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

**Resolve-mode spec** (the workarounds that were needed):

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
`denext/mobile`'s deep-link and push functions, which are in progress.

## Suggested order

1. Push notifications, the OTA runtime-version gate, auth sessions + deep links, and the
   `mobile add <capability>` wrapper pattern. These are what T3 would hit on day one.
2. App extensions (share, widgets, Live Activities) and dev-server attach.
3. Android native feel: measure on a real device first, then decide what to build.
4. The compatibility layer: start the measured spike in parallel with item 1, then the
   `react-native` resolve mode, the `denext/expo/*` shims, and `migrate --from expo`.
