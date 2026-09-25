# Mobile kitchen sink (Capacitor)

A denext SPA in a Capacitor 8 shell that exercises every `denext/mobile`
capability on one scrollable page: haptics, clipboard, share, device info,
network, keep-awake, the splash screen, the secure store, files, camera and
document pickers, the barcode scanner, quick actions, SQLite, deep links, push,
OAuth auth sessions, share-to-app, a configurable home-screen widget, a Live
Activity and over-the-air UI updates. Each section has a button that runs the
capability and prints the result on screen.

It is a template for your own app and a device test bed. Everything also runs in
a desktop browser through `denext/mobile`'s web fallbacks (`deno task dev`), and
the native-only capabilities say `unsupported` there.

## Run it

```sh
npm install            # the Capacitor packages and plugins (package.json)
deno task dev          # the UI in a browser: http://localhost:3000
deno task build        # production build → .denext/
deno task export       # static export → out/ (Capacitor's webDir), stamped for OTA
deno task cap:sync     # export + `cap sync` into ios/ and android/
deno task mobile:dev   # live reload on a phone on the same Wi-Fi (denext mobile dev --lan)
DENEXT_IOS_TEAM=ABCDE12345 deno task ios   # a signed Release build (xcodebuild)
```

Android: open `android/` in Android Studio, or
`cd android && ./gradlew assembleDebug`.

The `ios` task signs with automatic signing (`-allowProvisioningUpdates`) for
the team in `DENEXT_IOS_TEAM`. The team must be a paid Apple Developer team: App
Groups (the share extension, the widget and the Live Activity) and push cannot
be signed by a Personal Team.

## How it was made

The shell was generated the way you would make your own, then every capability
was added with the denext CLI. From this directory (the example runs the CLI
from the repository; an app uses `denext` or
`deno run -A jsr:@denext/denext/cli`):

```sh
npm install --save-exact @capacitor/core@8.5.2 @capacitor/ios@8.5.2 @capacitor/android@8.5.2
npm install --save-exact -D @capacitor/cli@8.5.2
npx cap init "denext mobile" com.brainwires.denext.mobile --web-dir out
deno task export
npx cap add ios
npx cap add android

DENEXT="deno run -A --node-modules-dir=none ../../cli.ts"
$DENEXT mobile add haptics clipboard share device network keep-awake splash secure-store \
  filesystem camera document-picker barcode quick-actions sqlite deep-links push auth-session \
  share-extension --scheme denextmobile --app-group group.com.brainwires.denext.mobile
$DENEXT mobile add widget --name Status --configurable "mode:enum=compact|detailed" \
  --app-group group.com.brainwires.denext.mobile
$DENEXT mobile add live-activity --name Build --app-group group.com.brainwires.denext.mobile
$DENEXT ota keygen ota.key                       # keep ota.key private (it is git-ignored)
$DENEXT mobile add-ota --public-key ota.key.pub
```

`--node-modules-dir=none` matters: next to a `package.json`, Deno would
otherwise resolve the CLI's own `npm:` imports from this `node_modules` and
fail.

The first `mobile add` installs the plugins with npm, writes the Info.plist
keys, entitlements, `AppDelegate` / `SceneDelegate` forwarding and Android
manifest entries, adds the denext native plugins (auth session, share receive)
and the `DenextShareExtension` target, and runs `cap sync`. `widget` and
`live-activity` add the `DenextWidgets` extension (the `Status` widget,
configurable on iOS 17+ with `mode`, and the `Build` Live Activity). The SwiftUI
views (`ios/App/DenextWidgets/StatusWidget.swift`, `BuildLiveActivity.swift`)
are yours to edit.

`capacitor.config.json` sets `SplashScreen.launchAutoHide: false`, so
`src/main.tsx` calls `hideSplash()` after the first frame, and `otaBooted()` to
confirm an over-the-air UI.

**The OTA public key in `ios/App/App/Info.plist` (`DenextOtaPublicKey`) and
`AndroidManifest.xml` (`dev.denext.ota.PUBLIC_KEY`) is a demo key.** Its private
half is not in the repository, so to test OTA, generate your own pair and re-run
`mobile add-ota --public-key` with it.

## The code

- `src/main.tsx`: mounts the app, adds `SAFE_AREA_CSS`, hides the splash, calls
  `otaBooted()`.
- `src/app.tsx`: the two routes (`/` and `/detail/:id`), `runtimePlatform()` at
  the top, and the listeners that must subscribe at startup: `useDeepLink`,
  `usePushReceived`, `usePushTapped`, `useQuickAction` and `useShareReceived`.
- `src/sections/`: one component per capability, grouped by file (`basics`,
  `files`, `inbound`, `ios-extras`, `ota`).
- `src/ui.tsx`: the section card, the result box and a 20-line history router
  that follows `popstate` (which is how deep links and push taps navigate).
- `serve.ts`: `deno task ota:serve`, the OTA server for the device test.

## Testing each capability on a device

| Section                   | How to test it                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Haptics … Secure store    | Press the buttons.                                                                                                                                                                                                                                                                                                                                                                 |
| Filesystem                | Write, Read, List, then Download (`https://example.com/` into `downloads/example.html`; natively not subject to CORS; in a browser example.com's missing CORS headers make it fail).                                                                                                                                                                                               |
| Camera, photos, documents | The pickers; cancelling prints `cancelled`.                                                                                                                                                                                                                                                                                                                                        |
| Barcode                   | Scan any QR code.                                                                                                                                                                                                                                                                                                                                                                  |
| SQLite                    | Insert a row, then Select. The browser build needs `@sqlite.org/sqlite-wasm` installed; without it `openSqlite` reports the engine is missing.                                                                                                                                                                                                                                     |
| Deep links                | Open `denextmobile://detail/42` from Safari, Notes or Chrome: the app opens on `/detail/42` and the link shows in the section.                                                                                                                                                                                                                                                     |
| Push                      | Request permission, Register, Copy token. Send an APNs (sandbox) push to the token with the topic `com.brainwires.denext.mobile` and a custom key `"path": "/detail/7"`: in the foreground it shows as "last received"; tapping it from the background opens `/detail/7`. Android needs `android/app/google-services.json` from a Firebase project for this app id (not included). |
| Auth session              | "Sign in" opens `https://httpbin.org/redirect-to?url=denextmobile://auth?code=test` in the system sheet, which redirects straight to the callback: the result shows `code: test`. "Open, then cancel" opens example.com: press Cancel (iOS) or close the tab (Android) to see `[cancelled]`.                                                                                       |
| Quick actions             | Set quick actions, go home, long-press the icon, pick "Open detail 1": the app opens `/detail/1`.                                                                                                                                                                                                                                                                                  |
| Share to this app         | Share a link, text or a photo to "denext mobile" from Safari or Photos.                                                                                                                                                                                                                                                                                                            |
| Widget                    | Add the Status widget, then Save default / Save for mode and Reload. On iOS 17+ long-press the widget → Edit to pick `compact` or `detailed`: that widget shows the snapshot saved for its mode.                                                                                                                                                                                   |
| Live Activity             | Start, Update, End; lock the phone to see it. Push token needs the push entitlement; push-to-start needs iOS 17.2+. Both tokens are for APNs `liveactivity` pushes from your server.                                                                                                                                                                                               |
| Over-the-air update       | See below.                                                                                                                                                                                                                                                                                                                                                                         |

The auth-session test depends on httpbin.org, a public redirect service. Any
https page of yours that answers `302 Location: denextmobile://auth?code=test`
works the same. The web fallback (a popup finished by `completeAuthSession()` on
a callback page of the app's own origin) is not exercised here, since that
redirect goes to the app's scheme.

### Over-the-air update

1. Build and install the app (it embeds the public key of your key pair).
2. Change something visible in `src/`, then on your machine:
   `DENEXT_OTA_SIGNING_KEY="$(cat ota.key)" deno task ota:serve` (exports a
   signed UI to `out/` and serves it on port 8787).
3. In the app, put `http://<your machine's LAN IP>:8787` in the OTA section,
   press Check (`ready` with a version), then Apply: the app reloads into the
   new UI. Reset goes back to the bundled one.

Without the signing key the manifest is unsigned and the app refuses it (the
result shows the native error). The manifest travels over plain http here, which
is fine on a LAN test with a signed manifest; serve it over https in production.
If iOS refuses the plain-http request (an App Transport Security error in the
result), serve the export over https instead, e.g. through a tunnel.
