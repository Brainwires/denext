# examples/capacitor-ci

A GitHub Actions recipe for a denext app wrapped in Capacitor: every push is fingerprinted with
`denext mobile fingerprint`, and ships over the air when the native layer is unchanged, or as
signed store binaries (an iOS `.ipa` and an Android `.aab`) when it changed. It is a template,
not an app: copy the files into your app's repository.

| File                           | Copy it to                                            |
| ------------------------------ | ----------------------------------------------------- |
| `.github/workflows/mobile.yml` | `.github/workflows/mobile.yml` in your repository     |
| `ExportOptions.plist`          | the Capacitor project (next to `ios/` and `android/`) |

Set `APP_DIR` (where `denext export` runs), `CAP_DIR` (the folder with `capacitor.config.*`) and
`WEB_OUT` in the workflow's `env` block, and pin `DENEXT` to the denext version your app uses
(keep its `--node-modules-dir=none`: next to the Capacitor project's `package.json`, Deno would
otherwise resolve the CLI's own `npm:` imports from `node_modules` and fail).

## How it decides

The `decide` job runs `denext mobile fingerprint --json`: a SHA-256 over the `ios/` and
`android/` sources (minus build output, `Pods`, `.gradle`, `xcuserdata`, `local.properties` and
what `cap sync` copies in), `capacitor.config.*` without its `server` block, and the installed
versions of `@capacitor/*` and every Capacitor or Cordova plugin in `package.json`. It compares
that with the fingerprint of the last binary release:

- **the same**: the change is web-only. The `ota` job exports the UI, stamps and signs
  `_denext/ota.json` with `denext ota manifest --native-fingerprint <fp>` (signed with
  `DENEXT_OTA_SIGNING_KEY`), and deploys it. Installed apps pick it up with `checkForUiUpdate()`
  from `denext/mobile`.
- **different** (or no release yet, or `force_binary` on a manual run): the `ios` and `android`
  jobs embed the new fingerprint with `denext mobile fingerprint --write` and build signed
  binaries; the `release` job records them.

The run summary shows `denext mobile fingerprint --diff`, which lists every native input that
changed (`+` added, `-` removed, `~` modified), so a surprising "binary" verdict explains itself.

### Where the last fingerprint lives

In a **GitHub release asset**. Each binary build ends in a release tagged
`native-<first 12 hex of the fingerprint>-<run number>`, holding `native-fingerprint.json` (the
`--json` output) next to the `.ipa` and `.aab`. The next `decide` downloads that file from the
newest `native-*` release. Nothing is committed back to the repository, so a protected `main`
branch is not a problem, and the binaries stay attached to the fingerprint they were built from.

To compare against a binary you built by hand, create such a release yourself:

```sh
denext mobile fingerprint --dir . --json > native-fingerprint.json
gh release create "native-manual-1" native-fingerprint.json --notes "hand-built binary"
```

## The native gate

`--write` puts the fingerprint in the binary (Info.plist `DenextNativeFingerprint`, the
AndroidManifest meta-data `dev.denext.native.FINGERPRINT`); `ota manifest --native-fingerprint`
puts it in the manifest, inside the signed payload. The `DenextOta` plugin refuses a manifest
whose fingerprint differs from the binary's (code `native_mismatch`, surfaced by
`checkForUiUpdate`), so a UI built for a newer native layer never lands on an older binary.
When either side carries none, that check is skipped.

Neither `--write` nor `cap sync` changes the fingerprint: the embedded values and the copied web
UI are left out of the hash.

## One-time setup

1. Install the OTA plugin with a public key, and keep the private key as a secret:

   ```sh
   denext ota keygen ota.key                       # ota.key → the DENEXT_OTA_SIGNING_KEY secret
   denext mobile add-ota --public-key ota.key.pub  # re-run after every denext upgrade
   ```

2. Point `capacitor.config.*`'s `webDir` at the export (`out`, or `WEB_OUT` if you change it).

3. Let CI set the build numbers on the command line, so the sources, and so the fingerprint,
   stay the same between releases. iOS needs nothing: the workflow passes
   `CURRENT_PROJECT_VERSION`. Android reads `-PversionCode` in `android/app/build.gradle`:

   ```groovy
   android {
       defaultConfig {
           versionCode (project.findProperty("versionCode") ?: "1") as Integer
       }
   }
   ```

   A version or build number committed to the sources counts as a native change (which is
   safe: it only means a binary build).

4. Add the secrets below under Settings → Secrets and variables → Actions.

## Secrets

| Secret                            | Used by | What it holds                                                                                                                   |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DENEXT_OTA_SIGNING_KEY`          | ota     | The PEM contents of `ota.key` (`denext ota keygen`).                                                                            |
| `OTA_DEPLOY_TARGET`               | ota     | Optional: wherever the placeholder deploy step should upload the export. Replace that step with your own.                       |
| `IOS_DIST_CERT_P12_BASE64`        | ios     | Your Apple Distribution certificate and its private key, exported from Keychain Access as `.p12`, then `base64 -i dist.p12`.    |
| `IOS_DIST_CERT_PASSWORD`          | ios     | The password you gave the `.p12`.                                                                                               |
| `IOS_PROVISIONING_PROFILE_BASE64` | ios     | Optional: the App Store provisioning profile, `base64 -i app.mobileprovision`. Without it Xcode downloads one with the API key. |
| `KEYCHAIN_PASSWORD`               | ios     | Any random string: the password of the temporary keychain the certificate is imported into.                                     |
| `ASC_API_KEY_P8_BASE64`           | ios     | An App Store Connect API key (Users and Access → Integrations, role App Manager or Admin): `base64 -i AuthKey_XXXX.p8`.         |
| `ASC_KEY_ID`                      | ios     | That key's ID.                                                                                                                  |
| `ASC_ISSUER_ID`                   | ios     | The issuer ID shown above the key list.                                                                                         |
| `APPLE_TEAM_ID`                   | ios     | Your 10-character team ID (written into `ExportOptions.plist` and the build).                                                   |
| `ANDROID_KEYSTORE_BASE64`         | android | The upload keystore (`keytool -genkeypair -keystore upload.jks …`), `base64 -w0 upload.jks`.                                    |
| `ANDROID_KEYSTORE_PASSWORD`       | android | The keystore password.                                                                                                          |
| `ANDROID_KEY_ALIAS`               | android | The key's alias in the keystore.                                                                                                |
| `ANDROID_KEY_PASSWORD`            | android | The key's password.                                                                                                             |
| `SENTRY_AUTH_TOKEN`               | ota ios | Optional: a Sentry auth token with `project:releases` (Settings → Auth Tokens). Without it the source-map uploads are skipped.  |

The App Store Connect API key is what makes signing work on a runner: `xcodebuild` gets
`-allowProvisioningUpdates -authenticationKeyPath … -authenticationKeyID … -authenticationKeyIssuerID …`
and signs automatically, so no Apple ID ever has to be signed in to Xcode (a CI machine never
has one). The distribution certificate is still imported, so Xcode does not mint a new
certificate on every run.

## Checks and crash reporting

Before a binary is built, the `ios` job runs `denext mobile doctor --store --release` and the
`android` job `denext mobile doctor --release` on what ships (the export and the native config
copies `cap sync` wrote). An error fails the job with its fix printed: a leftover `server.url`, a
debuggable WebView, cleartext or mixed content, `allowNavigation: ["*"]`, no CSP, a secret in the
export, and (for the store) a missing usage string, privacy manifest problem, missing icons, or
sign-in without account deletion. See
[App Store review](https://denext.dev/docs/mobile#app-store-review).

Every export runs with `--sourcemaps hidden`: source maps are built but moved out of the export
into `$APP_DIR/.denext/sourcemaps`, so none ships. With the `SENTRY_AUTH_TOKEN` secret (and the
`SENTRY_ORG` / `SENTRY_PROJECT` repository variables) set, the `ota` and `ios` jobs upload them
with `npx @sentry/cli sourcemaps upload --release <version> --url-prefix "~/"`, where the release
is the `version` of `_denext/ota.json`: the same value `initCrashReporting()` from
`denext/mobile` reports at runtime, so stack traces of the bundled UI and of every over-the-air
UI resolve. It needs `spa.ota: true` (the bundled UI stamped at export). See
[Crash reporting](https://denext.dev/docs/mobile#crash-reporting).

## Store submission

The `release` job attaches the `.ipa` and `.aab` to the GitHub release. To upload them too, add
a step after each build with `denext mobile submit` (see
[Mobile builds & store submission](https://denext.dev/docs/mobile-build)):

```yaml
# ios job, after "Export the .ipa" (the App Store Connect API key is already on disk)
- run: $DENEXT mobile submit ios --file "$RUNNER_TEMP"/export/*.ipa --app-id com.example.app
  env:
    DENEXT_ASC_KEY_PATH: ${{ runner.temp }}/AuthKey.p8
    DENEXT_ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
    DENEXT_ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}
# android job, after "Build the signed .aab" (a Play service-account key as a secret)
- run: |
    echo "$PLAY_SERVICE_ACCOUNT_JSON" > "$RUNNER_TEMP/play.json"
    $DENEXT mobile submit android --dir "$CAP_DIR" --app-id com.example.app --track internal \
      --file "$CAP_DIR"/android/app/build/outputs/bundle/release/*.aab \
      --service-account "$RUNNER_TEMP/play.json"
  env:
    PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
```

`--dry-run` checks the build and the credentials and uploads nothing. The build steps
themselves can also be one `denext mobile build ios --release` / `denext mobile build android
--release` each, with the signing inputs in the environment; this template spells the
`xcodebuild` and Gradle calls out so every flag is visible. The denext repository runs that
pipeline nightly on `examples/mobile` (`.github/workflows/mobile-build.yml`).

## Try the pieces locally

```sh
denext mobile fingerprint                       # the fingerprint alone
denext mobile fingerprint --json > before.json  # every input, hashed
# …edit a native file, add a plugin…
denext mobile fingerprint --diff before.json    # what changed, and the verdict
denext mobile fingerprint --write               # embed it (idempotent)
denext ota manifest out --native-fingerprint auto --dir . --sign ota.key
```
