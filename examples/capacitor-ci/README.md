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

The App Store Connect API key is what makes signing work on a runner: `xcodebuild` gets
`-allowProvisioningUpdates -authenticationKeyPath … -authenticationKeyID … -authenticationKeyIssuerID …`
and signs automatically, so no Apple ID ever has to be signed in to Xcode (a CI machine never
has one). The distribution certificate is still imported, so Xcode does not mint a new
certificate on every run.

## Store submission

Left to you on purpose. The `release` job attaches the `.ipa` and `.aab` to the GitHub release.
To go further: set `destination` to `upload` in `ExportOptions.plist` (the export step then
sends the build to App Store Connect and TestFlight), and upload the `.aab` with the Google Play
Developer API (for example `r0adkll/upload-google-play`) or fastlane.

## Try the pieces locally

```sh
denext mobile fingerprint                       # the fingerprint alone
denext mobile fingerprint --json > before.json  # every input, hashed
# …edit a native file, add a plugin…
denext mobile fingerprint --diff before.json    # what changed, and the verdict
denext mobile fingerprint --write               # embed it (idempotent)
denext ota manifest out --native-fingerprint auto --dir . --sign ota.key
```
