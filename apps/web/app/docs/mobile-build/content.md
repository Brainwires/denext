---
title: Mobile builds & store submission
slug: mobile-build
lead: denext mobile assets, build and submit turn a Capacitor project into store-ready binaries and upload them, on your machine or in CI, with no hosted build service. Icons and splash come from one image, flavors give a staging app its own id and name, secrets stay out of the command line, and every step has a dry run.
---

## The pipeline

Three verbs cover what Expo's EAS Build and EAS Submit do, run where you are:

| Verb                              | What it does                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `denext mobile assets`            | Every iOS and Android icon and splash from one icon (and optionally a splash image)          |
| `denext mobile build <platform>`  | `denext export`, `npx cap sync`, then Xcode or Gradle, ending in an `.ipa`, `.aab` or `.apk` |
| `denext mobile submit <platform>` | Checks the build and your credentials, then uploads to App Store Connect or Google Play      |

They work on any Capacitor 8 project (`capacitor.config.*` with `ios/` and `android/`), so the
setup in [Mobile (Capacitor)](/docs/mobile) comes first. iOS builds need a Mac with Xcode (a
GitHub `macos` runner works); Android builds run anywhere with a JDK and the Android SDK.

```sh
denext mobile assets --icon assets/icon.png --background-color "#0f172a"
denext mobile build android --release          # dist/mobile/android/<App>-release.aab
denext mobile build ios --release --team ABCDE12345
denext mobile submit ios --dry-run             # checks everything, uploads nothing
denext mobile submit android --track internal
```

Every verb takes `--dir <capacitor project>` (default: the current directory), `--dry-run` and
`--json`.

## Icons and splash

`denext mobile assets` reads `assets/icon.png` (or `--icon`), ideally a 1024×1024 or larger
square, and writes:

- **iOS**: the App Store icon `AppIcon-512@2x.png` (1024×1024, flattened onto the background as
  RGB, because App Store Connect refuses an icon with an alpha channel), the splash set
  (`splash-2732x2732*.png` at three scales) and both asset catalogs' `Contents.json`.
- **Android**, for mdpi through xxxhdpi: the legacy `ic_launcher.png`, the circular
  `ic_launcher_round.png`, the adaptive icon's foreground layer (108dp, the icon scaled into
  the 72dp safe viewport) and a themed-icon monochrome layer (Android 13+), the
  `mipmap-anydpi-v26` XML that ties them together, the background colour, and the portrait and
  landscape `splash.png` drawables.

| Source (default)                       | Flag                      | Used for                                                    |
| -------------------------------------- | ------------------------- | ----------------------------------------------------------- |
| `assets/icon.png` (or `icon-only.png`) | `--icon`                  | every icon                                                  |
| `assets/icon-foreground.png`           | `--icon-foreground`       | Android's adaptive foreground, filling the 108dp canvas     |
| `assets/icon-dark.png`                 | `--icon-dark`             | the iOS 18 dark icon                                        |
| `assets/splash.png`                    | `--splash`                | the splash, cropped to cover each size (2732×2732 is ideal) |
| `assets/splash-dark.png`               | `--splash-dark`           | the dark splash                                             |
| `#ffffff`                              | `--background-color`      | the icon background and a splash without an image           |
| none                                   | `--dark-background-color` | the dark splash background                                  |

Without a splash image, the splash is the icon centred on the background colour. The dark
variants (an asset catalog `luminosity: dark` appearance on iOS, `drawable-night*` on Android)
are written when `--splash-dark`, `assets/splash-dark.png` or `--dark-background-color` is
given. `--platform ios|android` limits the output; `--dry-run` lists every file and its size.

The images are decoded and resized with `@denext/photon` (WebAssembly) and encoded by denext
itself, so the verb needs no npm package and no ImageMagick. Icons and splash are native
resources: rebuild the app to see them.

## Building

`denext mobile build <platform>` runs, in order:

1. `denext export` in the app (`--app <dir>`, default the Capacitor project), unless
   `--skip-export`;
2. the flavor's edits, when `--flavor` names one (see [Flavors](#flavors));
3. `npx cap sync <platform>`;
4. the native build:

| Command                         | Runs                                                                        | Produces                               |
| ------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| `build android`                 | `./gradlew assembleDebug`                                                   | a debug-signed `.apk`                  |
| `build android --release`       | `./gradlew bundleRelease`                                                   | an `.aab`, signed with your upload key |
| `build android --release --apk` | `./gradlew assembleRelease`                                                 | a release `.apk`                       |
| `build ios`                     | `xcodebuild archive` (Debug), then `-exportArchive` (`debugging`)           | a development-signed `.ipa`            |
| `build ios --release`           | `xcodebuild archive` (Release), then `-exportArchive` (`app-store-connect`) | an App Store `.ipa`                    |
| `build ios --unsigned`          | `xcodebuild archive` with `CODE_SIGNING_ALLOWED=NO`, zipped                 | an unsigned `.ipa` (CI, or re-signing) |

The artifact lands in `dist/mobile/<platform>[-<flavor>]/` next to a `<artifact>.json` sidecar
(app id, version, build number, whether it is signed, size and SHA-256), which
`denext mobile submit` reads. Add `dist/` to `.gitignore`. Intermediate output (the archive,
DerivedData, the generated `ExportOptions.plist`) stays in `.denext/mobile-build/`.

`--dry-run` prints the plan (the commands, the signing, the version and the artifact path) and
runs nothing. `--jobs <n>` caps the parallelism (`xcodebuild -jobs`, Gradle `--max-workers`).
A CocoaPods project (`ios/App/Podfile` and `App.xcworkspace`) is built through the workspace;
a Swift Package Manager project (the Capacitor 8 default) through the project.

### Versions and build numbers

- `--build-number <n>` and `--version-name <x.y.z>` apply to this build only. iOS gets
  `CURRENT_PROJECT_VERSION` / `MARKETING_VERSION` on the xcodebuild command line; Android's
  `versionCode` / `versionName` in `android/app/build.gradle` are changed for the build and put
  back afterwards. The sources stay as they were, and so does the
  [native fingerprint](/docs/mobile#native-fingerprint).
- `--bump` increments the build number in the sources (every `CURRENT_PROJECT_VERSION` in
  `project.pbxproj`, or `versionCode` in `build.gradle`) before building, and leaves it:
  commit it.

In CI, pass the run number: `--build-number "${{ github.run_number }}"`.

## Signing

Secrets never appear on the command line (where `ps` shows them) or in the output. Each input
is a flag or an environment variable:

| Input                          | Flag             | Environment                                                      |
| ------------------------------ | ---------------- | ---------------------------------------------------------------- |
| Apple team id                  | `--team`         | `DENEXT_IOS_TEAM` (or `APPLE_TEAM_ID`)                           |
| App Store Connect API key file | `--asc-key`      | `DENEXT_ASC_KEY_PATH`                                            |
| its key id                     | `--asc-key-id`   | `DENEXT_ASC_KEY_ID`, or read from an `AuthKey_<ID>.p8` file name |
| its issuer id                  | `--asc-issuer`   | `DENEXT_ASC_ISSUER_ID`                                           |
| Android upload keystore        | `--keystore`     | `DENEXT_ANDROID_KEYSTORE`                                        |
| its key alias                  | `--key-alias`    | `DENEXT_ANDROID_KEY_ALIAS`                                       |
| keystore password              | environment only | `DENEXT_ANDROID_KEYSTORE_PASSWORD`                               |
| key password                   | environment only | `DENEXT_ANDROID_KEY_PASSWORD` (default: the keystore password)   |

**iOS** signs automatically (`-allowProvisioningUpdates`). On a Mac with your Apple ID in Xcode,
the team is all it needs. On a CI runner, which has no Apple ID, add the App Store Connect API
key (Users and Access → Integrations, role App Manager or Admin): xcodebuild then fetches
certificates and profiles with `-authenticationKeyPath`. Import your distribution certificate
into a keychain first so Xcode does not mint a new one per run (the
[CI recipe](https://github.com/Brainwires/denext/tree/main/examples/capacitor-ci) shows how).
`--export-method` picks another export (`release-testing` for ad hoc, `enterprise`), and
`--export-options <plist>` uses your own `ExportOptions.plist` verbatim.

**Android** release builds are signed with your upload keystore. The passwords reach Gradle as
`android.injected.signing.*` properties inside `GRADLE_OPTS` (the same properties Android
Studio's "Generate Signed Bundle" uses, so `build.gradle` needs no `signingConfig`); the plan
prints `[env: GRADLE_OPTS]`, never a value. A password with whitespace, a quote, `\`, `$` or a
backtick cannot travel that way and is refused with a message. Without a keystore the release
build is unsigned, with a warning: Google Play refuses it.

After the build, the artifact itself is checked: the sidecar's `signed` says what the file
carries (a JAR signature, an APK Signing Block, `_CodeSignature`), not what was configured.

## Flavors

A flavor is a variant of the app: a staging build that installs next to the release one, a
white-label brand. Declare them in `denext.config.ts`:

```ts
export default {
  mode: "spa",
  spa: { entry: "./src/main.tsx" },
  mobile: {
    flavors: {
      staging: {
        appIdSuffix: ".staging", // com.example.app → com.example.app.staging
        appName: "Example (staging)",
        serverUrl: "https://staging.example.com", // capacitor server.url
        env: { API_URL: "https://api.staging.example.com" }, // for the flavor's denext export
      },
      acme: {
        appId: "com.acme.app",
        appName: "Acme",
        icon: "brands/acme/icon.png",
        backgroundColor: "#0b3d91",
      },
    },
  },
};
```

and build one with `denext mobile build android --release --flavor staging`. For that build:

- `appId` (or the base id plus `appIdSuffix`) replaces `appId` in `capacitor.config.*`, every
  `PRODUCT_BUNDLE_IDENTIFIER` in `project.pbxproj` that is the app's id or starts with it (so
  app extensions follow: `com.example.app.widgets` becomes `com.example.app.staging.widgets`),
  and `applicationId` in `build.gradle`;
- `appName` replaces `appName`, `CFBundleDisplayName` and Android's `app_name`;
- `serverUrl` sets `server.url` (the app loads that origin instead of the bundled UI);
- `icon`, `splash` and `backgroundColor` run `denext mobile assets` for the flavor;
- `env` is added to the environment of `denext export`.

Every edit is undone when the build ends, successfully or not, byte for byte. The originals
are also copied to `.denext/mobile-build/backup/`, so a build that was killed is restored by
the next `denext mobile build`, or by `denext mobile build --restore`. The artifact is named
after the flavor (`dist/mobile/android-staging/`). A flavor's new bundle id needs its own App
ID (and App Group, if the app uses one) in the Apple Developer portal, and its own app in App
Store Connect and Google Play.

## Submitting

`denext mobile submit ios|android` uploads the newest store build in `dist/mobile/` (or
`--file`, with `--flavor` to pick a flavor's), after checking that it can succeed:

- **iOS**: the `.ipa` holds a signed `Payload/*.app`; the API key file is a PKCS#8 P-256 key that
  signs an App Store Connect token (ES256, 20 minutes); the account has an app with the build's
  bundle id (a read-only `GET /v1/apps` lookup). Then `xcrun altool --upload-app` uploads it
  with the same key: no Apple ID and no app-specific password. altool looks for the key as
  `AuthKey_<id>.p8`; a key file named otherwise is linked into a private temporary directory
  for the upload and removed afterwards. The build then shows in TestFlight.
- **Android**: the `.aab` (or `.apk`) is a signed bundle; `--service-account <json>` (or
  `DENEXT_PLAY_SERVICE_ACCOUNT`, or `GOOGLE_APPLICATION_CREDENTIALS`) is a service-account key
  whose token Google accepts. The upload is one Google Play Developer API edit: insert, upload
  the bundle, set the release on `--track` (default `internal`; `--draft` leaves it as a draft
  instead of rolling it out), commit. The service account needs the "Release to testing
  tracks" (or production) permission in Play Console, and the app must exist there (the first
  upload of a new app is done in the console).

`--dry-run` runs every check and uploads nothing. With the network it also makes the
read-only calls: the App Store Connect app lookup, and for Play an edit that is opened and
deleted, never committed (which proves the account may edit the app). `--offline` skips the
network. A failed check exits 1 with the reason, so `submit --dry-run` works as a CI gate.

The key files are read into WebCrypto only: nothing prints, logs or copies their contents.

## In CI

`.github/workflows/mobile-build.yml` in the denext repository runs this pipeline nightly on
[`examples/mobile`](https://github.com/Brainwires/denext/tree/main/examples/mobile): a debug
`.apk`, a signed release `.aab` of its `staging` flavor (a throwaway keystore made in the job),
`submit android --dry-run --offline`, and an unsigned iOS `.ipa` on a macOS runner. For your
own app, [`examples/capacitor-ci`](https://github.com/Brainwires/denext/tree/main/examples/capacitor-ci)
is the fuller recipe: the native fingerprint decides between an over-the-air update and a
store build, and the store build signs with your certificates. In either, the build step is
one line:

```yaml
- name: Signed .aab
  run: denext mobile build android --release --build-number "${{ github.run_number }}"
  env:
    DENEXT_ANDROID_KEYSTORE: ${{ runner.temp }}/upload.jks
    DENEXT_ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
    DENEXT_ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
    DENEXT_ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
- name: Upload to the internal track
  run: denext mobile submit android --service-account "$RUNNER_TEMP/play.json"
```

## What it does not do

- There is no hosted builder: iOS still needs a Mac (yours, or a CI macOS runner).
- Store metadata (screenshots, descriptions, review notes) and the first upload of a new app
  stay in App Store Connect and Play Console.
- A flavor changes ids, names, the server URL, icons and the export's environment. Anything
  else native (entitlements, a different Firebase project, per-flavor source sets) is yours to
  switch, for example in a `commands` verb in `denext.config.ts` that runs before the build.
