# denext native example — desktop + mobile

One [denext](../../) app packaged three ways: the **web**, a **native desktop
app** via [`deno desktop`](https://docs.deno.com/runtime/desktop/), and **iOS /
Android** via [Capacitor](https://capacitorjs.com). All three serve the same
static export (`deno task export` → `out/`).

## The app

A single hydrated page (`app/`) that shows off what denext's React runtime can
do — identically on web, desktop, and mobile:

- **A grid of hook demos**, each card labeled with the hooks it drives — 18 in
  all: `useState`, `useReducer`, `useCallback`, `useMemo`, `useRef`,
  `useEffect`, `useLayoutEffect`, `useInsertionEffect`, `useContext`, `useId`,
  `useSyncExternalStore`, `useDebugValue`, `useDeferredValue`, `useTransition`,
  `useOptimistic`, `useImperativeHandle`, `useEffectEvent`, and `memo`.
- **A time-sliced 2,000-row filter** (`useTransition` + `useDeferredValue`)
  whose input stays smooth while the list re-renders.
- **A cat** that runs on top of everything, chasing your pointer (mouse or
  touch), wandering when idle, and napping on command — driven by a
  `requestAnimationFrame` loop writing straight to the DOM (no re-renders), plus
  `useImperativeHandle` so a card can `summon()` it.
- **A live accent theme** injected as a CSS variable via `useInsertionEffect`.

Files: `app/page.tsx` (composition), `app/demos.tsx` (the cards + theme
context), `app/cat.tsx` (the cat), `public/styles.css`.

## Web

```sh
deno task dev      # → http://localhost:3000
deno task start    # serve the production build
```

## Desktop (`deno desktop`, Deno 2.9+)

`desktop.ts` is a `Deno.serve()` handler over the static export; `deno desktop`
wraps it in a native window (native WebView, single binary).

```sh
deno task desktop           # export + open the app in a native window
deno task desktop:package   # export + build a distributable (./dist/)
```

The app name / bundle id live in the `desktop` block of `deno.json`.
Cross-compile with `deno desktop --all-targets desktop.ts`. (Experimental in
Deno 2.9.)

## Mobile (Capacitor)

Capacitor bundles the static export (`webDir: "out"`) into native iOS/Android
shells. Its CLI and platforms are Node packages, so install them once:

```sh
deno install                       # installs the @capacitor/* devDependencies
deno task mobile:sync              # export + copy web assets into the native projects
deno run -A --node-modules-dir npm:@capacitor/cli add ios        # first time only
deno task mobile:ios               # open in Xcode   (needs Xcode)
deno task mobile:android           # open in Android Studio (needs Android Studio)
```

## Releasing (fastlane)

[fastlane](https://fastlane.tools) automates the App Store / Play releases of
the Capacitor shells. It's Ruby, so install it with Bundler, then configure it
with a gitignored `fastlane/.env`:

```sh
gem install bundler && bundle install     # installs fastlane (see Gemfile)
cp fastlane/.env.example fastlane/.env     # then fill in the values below
```

Every app-specific value is read from the environment (via `fastlane/.env`) — no
real ids or secrets are committed. Copy `fastlane/.env.example` and fill in what
the lane you want to run needs:

| Env var                                                                              | Used by | What it is                                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ID` / `ANDROID_PACKAGE`                                                         | both    | Bundle id / package name. Default `com.example.denext-native`.                                                                                                                            |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_FILEPATH`                                    | iOS     | App Store Connect API key (Users and Access → Integrations → App Store Connect API). The `.p8` path should live **outside** the repo.                                                     |
| `TEAM_ID`                                                                            | iOS     | Apple Developer Team id used to sign the archive.                                                                                                                                         |
| `TESTFLIGHT_GROUP`                                                                   | iOS     | External TestFlight group to release to (default `External Testers`; create it with `fastlane ios create_group`).                                                                         |
| `REVIEW_DESCRIPTION`, `FASTLANE_FEEDBACK_EMAIL`, `REVIEW_WHATS_NEW`, `REVIEW_DEMO_*` | iOS     | Optional external Beta App Review metadata. A description is required by Apple for external testing; the demo-account vars only if your app is behind sign-in. Omitted steps are skipped. |
| `XCODE_WORKSPACE` / `XCODE_SCHEME`                                                   | iOS     | Optional. Build a CocoaPods `.xcworkspace` instead of the SwiftPM `.xcodeproj`; scheme defaults to `App`.                                                                                 |
| `PLAY_JSON_KEY`, `PLAY_TRACK`                                                        | Android | Play service-account JSON path (Play Console → Setup → API access) and target track (default `internal`).                                                                                 |

Then, from this directory:

```sh
bundle exec fastlane ios auth_check       # verify the ASC API key (no build)
bundle exec fastlane ios beta             # export → archive → TestFlight → submit for review
bundle exec fastlane android beta         # export → build AAB → upload to the Play internal track
```

See [`fastlane/README.md`](fastlane/README.md) for every lane (including the
diagnostic and recovery lanes). The native projects (`ios/`, `android/`) must
exist first — run the Capacitor `add` commands under **Mobile** above.

## Files

```
deno.json            tasks + the `desktop` app block
desktop.ts           Deno.serve() over out/  (deno desktop entry)
capacitor.config.ts  appId / appName / webDir: "out"
package.json         Capacitor CLI + platform devDependencies
app/                 the shared denext app
Gemfile              fastlane (Ruby) dependency
fastlane/            Fastfile (ios + android lanes), Appfile, .env.example
```

`out/`, `dist/`, `node_modules/`, `ios/`, `android/`, `fastlane/.env`, `build/`,
and `vendor/` are all generated (or secret) and git-ignored.
