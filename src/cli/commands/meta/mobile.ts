// The help text of `denext ota` and `denext mobile` (the verb's summary, usage, flags and
// positionals: what `--help`, `denext --help`, shell completions and the CLI reference print),
// implemented in ../mobile.ts. Edit it here, then run `deno task gen:command-table` (or `deno task
// regen`). Not published: scripts/gen-command-table.ts packs it into
// src/cli/command-meta.packed.ts, and the verb's spec reads it back with `...commandMeta("<verb>")`
// (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { DEFAULT_OTA_CHANNELS_FILE } from "../../../build/ota-channels.ts";
import type { FlagSpec } from "../../command.ts";
import { OTA_SIGNING_KEY_ENV } from "../../../build/ota-signing.ts";

/** The flags `ota promote` / `ota channel` add to the `ota` verb (`--force` is shared). */
export const OTA_CHANNEL_FLAGS: FlagSpec[] = [
  {
    name: "channel",
    type: "string",
    valueName: "<name>",
    help: "promote: the source channel (its stable release is promoted)",
  },
  {
    name: "release",
    type: "string",
    valueName: "<dir>",
    help: "promote: the source export directory (instead of --channel)",
  },
  {
    name: "to",
    type: "string",
    valueName: "<name>",
    help: "promote: the target channel",
  },
  {
    name: "percent",
    type: "number",
    valueName: "<n>",
    help: "promote: the share of devices that get it (default 100 = the stable release; 0 halts)",
  },
  {
    name: "halt",
    type: "boolean",
    help: "promote: stop the target channel's staged rollout (its stable release stays)",
  },
  {
    name: "file",
    type: "string",
    valueName: "<file>",
    help: `promote, channel: the channels file (default: ${DEFAULT_OTA_CHANNELS_FILE})`,
  },
];

/** The `ota` usage lines for the two actions. */
export const OTA_CHANNEL_USAGE = "  denext ota channel beta releases/2026-09-27\n" +
  "                              Point channel beta at an export (ota-channels.json, --file)\n" +
  "  denext ota promote --channel beta --to production --percent 20\n" +
  "                              Roll beta's release out to 20% of production's devices\n" +
  "  denext ota promote --channel beta --to production\n" +
  "                              Make it production's release (100%; ends the rollout)\n" +
  "  denext ota promote --to production --halt\n" +
  "                              Stop production's rollout; its stable release stays\n";

/** The flags the build actions add to the `mobile` verb. */
export const MOBILE_BUILD_FLAGS: readonly FlagSpec[] = [
  {
    name: "icon",
    type: "string",
    valueName: "<png>",
    help:
      "assets: the app icon (default: the project's own: mobile.icon, assets/icon.png, an Expo app config, the web manifest, the apple-touch-icon)",
  },
  {
    name: "icon-foreground",
    type: "string",
    valueName: "<png>",
    help:
      "assets: Android's adaptive foreground layer (default: assets/icon-foreground.png, else the icon)",
  },
  {
    name: "icon-dark",
    type: "string",
    valueName: "<png>",
    help: "assets: the iOS 18 dark icon (default: assets/icon-dark.png)",
  },
  {
    name: "splash",
    type: "string",
    valueName: "<png>",
    help: "assets: the splash (default: assets/splash.png, else the icon on the background)",
  },
  {
    name: "splash-dark",
    type: "string",
    valueName: "<png>",
    help: "assets: the dark splash (default: assets/splash-dark.png)",
  },
  {
    name: "background-color",
    type: "string",
    valueName: "<#hex>",
    help: "assets: icon and splash background (default: #ffffff)",
  },
  {
    name: "dark-background-color",
    type: "string",
    valueName: "<#hex>",
    help: "assets: the dark splash background (writes the dark variants)",
  },
  {
    name: "flavor",
    type: "string",
    valueName: "<name>",
    help: "build, submit: a flavor from denext.config mobile.flavors",
  },
  {
    name: "unsigned",
    type: "boolean",
    help: "build ios: archive without signing (an unsigned .ipa for CI)",
  },
  { name: "apk", type: "boolean", help: "build android --release: an .apk instead of an .aab" },
  {
    name: "build-number",
    type: "number",
    valueName: "<n>",
    help: "build: the build number for this build only",
  },
  {
    name: "version-name",
    type: "string",
    valueName: "<x.y.z>",
    help: "build: the version for this build only",
  },
  {
    name: "bump",
    type: "boolean",
    help: "build: increment the build number in the native sources first (commit it)",
  },
  {
    name: "skip-export",
    type: "boolean",
    help: "build: skip `denext export` (the web export is already there)",
  },
  {
    name: "jobs",
    type: "number",
    valueName: "<n>",
    help: "build: parallel jobs (xcodebuild -jobs, gradle --max-workers)",
  },
  {
    name: "team",
    type: "string",
    valueName: "<id>",
    help: "build ios: the Apple team id (default: $DENEXT_IOS_TEAM, else the project's)",
  },
  {
    name: "asc-key",
    type: "string",
    valueName: "<p8>",
    help: "build, submit ios: App Store Connect API key file (default: $DENEXT_ASC_KEY_PATH)",
  },
  {
    name: "asc-key-id",
    type: "string",
    valueName: "<id>",
    help: "build, submit ios: its key id (default: $DENEXT_ASC_KEY_ID, or AuthKey_<id>.p8)",
  },
  {
    name: "asc-issuer",
    type: "string",
    valueName: "<id>",
    help: "build, submit ios: its issuer id (default: $DENEXT_ASC_ISSUER_ID)",
  },
  {
    name: "export-method",
    type: "string",
    valueName: "<method>",
    help:
      "build ios: app-store-connect (--release default), release-testing, debugging, enterprise",
  },
  {
    name: "export-options",
    type: "string",
    valueName: "<plist>",
    help: "build ios: your own ExportOptions.plist",
  },
  {
    name: "keystore",
    type: "string",
    valueName: "<jks>",
    help: "build android --release: the upload keystore (default: $DENEXT_ANDROID_KEYSTORE)",
  },
  {
    name: "key-alias",
    type: "string",
    valueName: "<alias>",
    help: "build android: the key alias (default: $DENEXT_ANDROID_KEY_ALIAS)",
  },
  {
    name: "out",
    type: "string",
    valueName: "<dir>",
    help: "build, submit: the artifact directory (default: dist/mobile)",
  },
  {
    name: "file",
    type: "string",
    valueName: "<ipa|aab|apk>",
    help: "submit: the artifact (default: the newest build)",
  },
  {
    name: "app-id",
    type: "string",
    valueName: "<id>",
    help: "submit: the bundle id / package name (default: the build's)",
  },
  {
    name: "service-account",
    type: "string",
    valueName: "<json>",
    help: "submit android: the Play service-account key (default: $DENEXT_PLAY_SERVICE_ACCOUNT)",
  },
  {
    name: "track",
    type: "string",
    valueName: "<track>",
    help: "submit android: the release track (default: internal)",
  },
  { name: "draft", type: "boolean", help: "submit android: leave the release as a draft" },
  { name: "offline", type: "boolean", help: "submit --dry-run: skip the network checks" },
];

/** The build actions' usage lines. */
export const MOBILE_BUILD_USAGE =
  "  denext mobile assets          Every icon and splash from the project's icon (+ splash.png)\n" +
  "  denext mobile assets --icon logo.png --background-color '#0f172a' --dark-background-color '#000'\n" +
  "                                Icons + splash, dark variants included\n" +
  "  denext mobile build android   Export, cap sync, gradle assembleDebug → dist/mobile/android/*.apk\n" +
  "  denext mobile build ios --release\n" +
  "                                Export, cap sync, xcodebuild archive + export → a signed .ipa\n" +
  "  denext mobile build ios --unsigned\n" +
  "                                An unsigned .ipa (CI without certificates)\n" +
  "  denext mobile build android --release --flavor staging\n" +
  "                                A signed .aab with the staging flavor's id, name and URL\n" +
  "  denext mobile build ios --dry-run\n" +
  "                                The plan: commands, signing, artifact (nothing runs)\n" +
  "  denext mobile submit ios --dry-run\n" +
  "                                Check the .ipa, the API key and the app in App Store Connect\n" +
  "  denext mobile submit android --track internal\n" +
  "                                Upload the newest .aab to Google Play's internal track\n";

/** The build actions' long help. */
export const MOBILE_BUILD_HELP = "\n" +
  "  assets: writes the iOS app icon (1024², RGB: App Store Connect refuses an alpha channel)\n" +
  "  and its iOS 18 dark variant, the iOS splash set, Android's legacy, round, adaptive\n" +
  "  (foreground + background colour) and themed (monochrome) launcher icons for every density,\n" +
  "  and the portrait / landscape splash drawables; the dark splash variants (asset catalog\n" +
  "  appearances, drawable-night) when --splash-dark or --dark-background-color is given.\n" +
  "  Without --icon the icon is the project's own, and the report names it: denext.config\n" +
  "  mobile.icon, assets/icon.png, an Expo app config's icon (a sibling monorepo app's too;\n" +
  "  app.config.ts is read statically, never run), the web manifest's largest icon, the\n" +
  "  apple-touch-icon, then the largest PNG favicon. Under 1024² it is upscaled with a warning;\n" +
  "  transparency is flattened onto the background for iOS. The other sources default to\n" +
  "  assets/ (or resources/): icon-foreground.png, icon-dark.png, splash.png, splash-dark.png.\n" +
  "  Decoding and resizing run on @denext/photon (wasm).\n" +
  "\n" +
  "  build: `denext export` (--app, default the Capacitor project; a flavor's env is added),\n" +
  "  the flavor's edits, `npx --no cap sync <platform>` (the project's own @capacitor/cli),\n" +
  "  with --release `denext mobile doctor --release` (its release-security errors stop the build;\n" +
  "  the rest print as warnings), then the native\n" +
  "  build. The export and cap sync never see the signing variables. Without --release:\n" +
  "  a Debug build (Android: a debug-signed .apk). iOS signs automatically (-allowProvisioning\n" +
  "  Updates) for --team / DENEXT_IOS_TEAM, with DENEXT_ASC_KEY_PATH / _KEY_ID / _ISSUER_ID as the\n" +
  "  API key on a machine with no Apple ID signed in; --unsigned needs no certificate. Android\n" +
  "  --release signs with DENEXT_ANDROID_KEYSTORE, DENEXT_ANDROID_KEY_ALIAS,\n" +
  "  DENEXT_ANDROID_KEYSTORE_PASSWORD and DENEXT_ANDROID_KEY_PASSWORD, passed to Gradle through\n" +
  "  the environment (never argv, never printed). --build-number / --version-name apply to this\n" +
  "  build only; --bump increments the build number in the sources. Flavors\n" +
  "  (denext.config mobile.flavors) change the app id, name, server.url and icons for the build\n" +
  "  and are restored afterwards; a killed build is restored by the next one or by\n" +
  "  `mobile build --restore`. Capacitor's placeholder icon and splash, left by `cap add`, are\n" +
  "  replaced for good, each while it is still the placeholder, from the project's icon (as\n" +
  "  `assets` finds it; the splash is that icon on its background colour). The artifact and a\n" +
  "  <artifact>.json sidecar land in dist/mobile/<platform>[-<flavor>]/.\n" +
  "\n" +
  "  submit: checks the artifact (signed, well formed) and the credentials, then uploads: iOS\n" +
  "  with `xcrun altool --upload-app` and the App Store Connect API key, Android through the\n" +
  "  Google Play Developer API with a service account (edit → upload → track → commit).\n" +
  "  --dry-run uploads nothing: it signs a token with the key and, unless --offline, looks the\n" +
  "  app up (App Store Connect) or opens and deletes an edit (Play). Exits 1 on a failed check.";

/** `denext ota`. */
export const otaMeta: CommandMeta = {
  name: "ota",
  summary: "Over-the-air UI manifest for Capacitor apps",
  usage:
    "  denext ota manifest out     Write out/_denext/ota.json (paths, SHA-256s, sizes, version)\n" +
    '  denext ota manifest out --required --notes "Fixes sign-in"\n' +
    "                              Also mark the UI required and attach release notes\n" +
    "  denext ota manifest out --sign ota.key\n" +
    "                              Also sign it (or set " + OTA_SIGNING_KEY_ENV +
    " to the PEM);\n" +
    "                              signing stamps --sequence (default: the Unix time) so apps\n" +
    "                              refuse an older release, and an expiry (default 30 days;\n" +
    "                              --expires-in <days> / --expires-at <rfc3339>) after which\n" +
    "                              apps refuse it (code expired; re-sign before then), and\n" +
    "                              --min-native <build> refuses app binaries older than that\n" +
    "                              build number\n" +
    "  denext ota manifest out --native-fingerprint auto --dir .\n" +
    "                              Also stamp the native fingerprint of the Capacitor project at\n" +
    "                              --dir; a binary embedding another one (`denext mobile\n" +
    "                              fingerprint --write`) refuses it (code native_mismatch)\n" +
    "  denext ota manifest out --platform ios\n" +
    "                              Name the target the export was built for (`denext export\n" +
    "                              --platform ios` stamps it already); a shell of another target\n" +
    "                              refuses it (code platform_mismatch)\n" +
    "  denext ota keygen ota.key   Write a P-256 signing key (0600) and ota.key.pub\n" +
    OTA_CHANNEL_USAGE +
    "\n" +
    "  Run it after anything that changes the export (e.g. swapping brand icons in), and before\n" +
    "  `cap sync`, so the bundled UI and the served UI carry the right version. `spa.ota: true`\n" +
    "  makes `denext export` write it for you. `*.gz` files are never listed. `--required` and\n" +
    "  `--notes` feed the app's own update prompt (prepareUiUpdate in denext/mobile); they are\n" +
    "  not part of the version, but the signature covers them. An app whose binary embeds the\n" +
    "  public key (`denext mobile add-ota --public-key ota.key.pub`) refuses an unsigned or\n" +
    "  wrongly signed manifest; one without a key refuses plain http beyond loopback. Signing\n" +
    "  protects integrity only: over plain http the headers (bearer tokens) are visible on the\n" +
    "  network. `keygen --force` rotates the key, which breaks OTA for every installed binary\n" +
    "  that embeds the old public key.",
  positionals: [
    { name: "action", help: "manifest | keygen | channel | promote", required: true },
    {
      name: "path",
      help:
        "manifest: the static export directory (e.g. out); keygen: the private key file; channel: <name> <dir>",
    },
  ],
  flags: [
    {
      name: "required",
      type: "boolean",
      help: "Mark this UI as a required update (the app should not let users decline it)",
    },
    {
      name: "notes",
      type: "string",
      valueName: "<text>",
      help: "Release notes for the app's update prompt (at most 2000 characters)",
    },
    {
      name: "sign",
      type: "string",
      valueName: "<keyfile>",
      help: `Sign the manifest with this PKCS#8 PEM key (default: $${OTA_SIGNING_KEY_ENV}, if set)`,
    },
    {
      name: "sequence",
      type: "number",
      valueName: "<n>",
      help:
        "Release sequence (a non-negative integer that only grows; default when signing: the Unix time in seconds)",
    },
    {
      name: "expires-in",
      type: "number",
      valueName: "<days>",
      help:
        "manifest: days until apps refuse this release (code expired; default when signing: 30)",
    },
    {
      name: "expires-at",
      type: "string",
      valueName: "<rfc3339>",
      help: "manifest: when apps start refusing this release, as an RFC 3339 time",
    },
    {
      name: "min-native",
      type: "number",
      valueName: "<build>",
      help:
        "Refuse this UI on app binaries whose build number (CFBundleVersion / versionCode) is lower",
    },
    {
      name: "native-fingerprint",
      type: "string",
      valueName: "<fp|auto>",
      help:
        "Stamp the native fingerprint this UI was built for (auto: compute it for --dir); binaries embedding another refuse it",
    },
    {
      name: "platform",
      type: "string",
      valueName: "<target>",
      help:
        "manifest: the target the export was built for (ios, android, macos, windows, linux); shells of another target refuse it. web names no target (no stamp), as `denext export` does",
    },
    {
      name: "app-id",
      type: "string",
      valueName: "<id>",
      help:
        "manifest: the app this release is for (iOS bundle id / Android application id / desktop.app.identifier), signed; shells of another app refuse it. Default when signing: $DENEXT_OTA_APP_ID, else the Capacitor appId of --dir for an ios / android export",
    },
    {
      name: "dir",
      type: "string",
      valueName: "<dir>",
      help:
        "manifest --native-fingerprint auto / the default --app-id: the Capacitor project (default: the current directory)",
    },
    {
      name: "force",
      type: "boolean",
      help:
        "keygen: replace existing key files (breaks OTA for binaries that embed the old public key); channel / promote: skip the signature and sequence checks",
    },
    ...OTA_CHANNEL_FLAGS,
  ],
};

/** `denext mobile`. */
export const mobileMeta: CommandMeta = {
  name: "mobile",
  summary:
    "Capacitor helpers (add: native capabilities; add-ota: over-the-air UI updates; dev: live reload; fingerprint: native-layer hash; assets / build / submit: icons, store builds, store uploads)",
  usage: "  denext mobile add <capability...>\n" +
    "                                Add the Capacitor plugins behind denext/mobile's\n" +
    "                                capability functions, then `npx cap sync`\n" +
    "  denext mobile add deep-links --scheme myapp --domain app.example.com\n" +
    "                                Register a URL scheme and universal / app link domains\n" +
    "  denext mobile add push        Push notifications (entitlement, AppDelegate, permission)\n" +
    "  denext mobile add auth-session --scheme myapp\n" +
    "                                OAuth in a system browser sheet (openAuthSession)\n" +
    "  denext mobile add share-extension --app-group group.com.example.app\n" +
    "                                Receive shared links, text and images (onShareReceived)\n" +
    "  denext mobile add widget --name Status\n" +
    "                                A home-screen widget fed by setWidgetData\n" +
    "  denext mobile add widget --name Usage --configurable period:enum=session|weekly\n" +
    "                                An iOS 17+ configurable widget (App Intents enum)\n" +
    "  denext mobile add live-activity --name Delivery\n" +
    "                                An iOS Live Activity (startLiveActivity)\n" +
    "  denext mobile add native-module --name Scanner\n" +
    "                                Your own Swift + Kotlin plugin (nativeModule, TurboModules)\n" +
    "  denext mobile add fastlane --ci\n" +
    "                                fastlane lanes (match, TestFlight, Play tracks) over\n" +
    "                                `mobile build`, a Gemfile, and a GitHub Actions workflow\n" +
    "  denext mobile add --list      List the capabilities and the plugins they install\n" +
    "  denext mobile add-ota [dir]   Install the DenextOta plugin into ios/ and android/\n" +
    "  denext mobile dev [project] --lan\n" +
    "                                Live reload on a device: point the app at `denext dev`\n" +
    "  denext mobile fingerprint --json > native.json\n" +
    "                                Hash the native layer (OTA-able vs needs a binary)\n" +
    "  denext mobile fingerprint --diff native.json\n" +
    "                                Explain which native inputs changed since native.json\n" +
    "  denext mobile fingerprint --write\n" +
    "                                Embed it in Info.plist + AndroidManifest (OTA gate)\n" +
    "  denext mobile privacy --check Validate ios/App/App/PrivacyInfo.xcprivacy (--write merges\n" +
    "                                every installed capability's required-reason entries)\n" +
    "  denext mobile doctor --store  App Review readiness (server.url, usage strings, privacy\n" +
    "                                manifest, icons, account deletion, …); exits 1 on errors\n" +
    "  denext mobile doctor --release\n" +
    "                                Release security (debuggable WebView, cleartext, mixed\n" +
    "                                content, allowNavigation *, CSP, secrets in the export)\n" +
    "  denext mobile inspect         Attach Safari Web Inspector / chrome://inspect to the app\n" +
    MOBILE_BUILD_USAGE +
    "\n" +
    "  Native paths below are Capacitor's default layout (ios/App/App/…, android/app/…). When\n" +
    "  capacitor.config.* sets ios.path / android.path, every mobile command reads and writes the\n" +
    "  native projects there, and its reports and manual steps name those paths.\n" +
    "\n" +
    "  fingerprint: SHA-256 over the ios/ and android/ sources (minus build output, Pods,\n" +
    "  .gradle, xcuserdata, local.properties and what `cap sync` copies in; text with CRLF\n" +
    "  normalised), capacitor.config.* without its server block, and the installed versions of\n" +
    "  @capacitor/* and every Capacitor / Cordova plugin package.json declares. The same\n" +
    "  fingerprint means the change can ship over the air; a different one needs a new binary.\n" +
    "  --write stores it as Info.plist DenextNativeFingerprint and the\n" +
    "  dev.denext.native.FINGERPRINT meta-data (never changing the value itself); a manifest\n" +
    "  stamped with `denext ota manifest --native-fingerprint` is then refused by a binary with\n" +
    "  another one (code native_mismatch).\n" +
    "\n" +
    "  dev: starts `denext dev` for [project] (default: .) on --port (default 3000), or attaches\n" +
    "  to a server already answering there; writes server: { url, cleartext: true } into the\n" +
    "  Capacitor project's capacitor.config.* (--dir, else the current directory) and runs\n" +
    "  `npx cap copy`, so the app loads the dev server and reloads on every edit. --lan binds\n" +
    "  the LAN IPv4 (a physical device on the same network); without it the URL is\n" +
    "  localhost (the iOS simulator, or Android behind `adb reverse`). On iOS it also adds\n" +
    "  NSAppTransportSecurity > NSAllowsLocalNetworking and (when absent) an\n" +
    "  NSLocalNetworkUsageDescription to ios/App/App/Info.plist, without which the WebView\n" +
    "  never reaches a LAN server; a changed Info.plist needs a rebuild from Xcode. The edits\n" +
    "  are temporary: Ctrl-C, SIGTERM or an error puts the original bytes back and runs\n" +
    "  `cap copy` again. A killed run leaves a backup in .denext/; the next `mobile dev`, or\n" +
    "  `mobile dev --restore`, restores it first. The restore also takes the dev URL out of\n" +
    "  the native config copies itself, so they are clean even when `cap copy` fails because\n" +
    "  the webDir was never built (export and `npx cap copy` before a release build).\n" +
    "\n" +
    "  sync: `npx cap sync` (ios, android or both), then the iOS shell's CapApp-SPM/Package.swift\n" +
    "  plugin paths rewritten from pnpm's store (node_modules/.pnpm/<name>@<version>_<hash>/…) to\n" +
    "  the package's node_modules/<name> entry, so a committed ios/ builds on any checkout of the\n" +
    "  same dependencies. `add` and `build` do the same after their `cap sync`.\n" +
    "\n" +
    "  add: finds the Capacitor project (the folder with capacitor.config.*: --dir when given,\n" +
    "  with no fallback, else the current directory), refuses when its @capacitor/core major\n" +
    "  is not the one the pinned plugins target, adds the packages with the package manager\n" +
    "  the nearest lockfile names (pnpm, npm, bun or yarn, looking up to the repository root\n" +
    "  for a workspace's; else a packageManager field; else npm) as caret ranges, or as exact\n" +
    "  versions (the range's minimum) when package.json pins every @capacitor/* package\n" +
    "  exactly, adds any Info.plist keys (never replacing yours) and Android permissions the\n" +
    "  capability needs, and runs `npx cap sync`. When the web export (capacitor.config webDir)\n" +
    "  has no index.html yet it runs `npx cap update` instead (the native half of sync, which\n" +
    "  cannot fail on the missing folder) and says to run `denext export`, then `npx cap sync`.\n" +
    "  --dry-run prints the plan and changes nothing. Ship a new app binary afterwards.\n" +
    "\n" +
    "  deep-links takes --scheme (CFBundleURLTypes + a VIEW intent filter) and --domain\n" +
    "  (applinks: in the entitlements + an autoVerify https intent filter); give several as\n" +
    "  a comma-separated list. The domains must also serve apple-app-site-association and\n" +
    "  assetlinks.json. push writes aps-environment (development) into the entitlements, the\n" +
    "  token forwarding into AppDelegate.swift and POST_NOTIFICATIONS into the manifest, and\n" +
    "  warns when android/app/google-services.json (FCM) is missing. A new entitlements file\n" +
    "  (ios/App/App/App.entitlements) must be selected in Xcode (Code Signing Entitlements);\n" +
    "  the steps left to do by hand are printed.\n" +
    "\n" +
    "  auth-session has no npm package: it writes denext's DenextAuthSession plugin\n" +
    "  (ios/App/App/DenextAuthSessionPlugin.swift, an ASWebAuthenticationSession sheet, added to\n" +
    "  the App target; android dev/denext/authsession/*.java, a Custom Tab) and registers it\n" +
    "  through DenextBridgeViewController and MainActivity, which it shares with add-ota (either\n" +
    "  order works). --scheme registers the OAuth callback scheme as deep-links does; Android\n" +
    "  needs it to receive the redirect. No install or `cap sync` runs for it alone.\n" +
    "\n" +
    "  back (Android) adds @capacitor/app, denext's DenextBack plugin (predictive-back progress\n" +
    "  for onBack / useBackProgress) registered in MainActivity, and\n" +
    '  android:enableOnBackInvokedCallback="true" on <application>. system-bars has no npm\n' +
    "  package (SystemBars ships in @capacitor/core 8): it sets\n" +
    "  UIViewControllerBasedStatusBarAppearance in Info.plist and calls EdgeToEdge.enable(this)\n" +
    "  in MainActivity. keyboard adds @capacitor/keyboard for useKeyboard and the keyboard views.\n" +
    "  dialog adds @capacitor/dialog, so React Native mode's Alert.alert / Alert.prompt show\n" +
    "  system dialogs.\n" +
    "\n" +
    "  accessibility has no npm package: it writes denext's DenextAccessibility plugin\n" +
    "  (VoiceOver / TalkBack state for isScreenReaderEnabled, and React Native mode's\n" +
    "  AccessibilityInfo), registered like auth-session. background-location adds\n" +
    "  @capgo/background-geolocation, UIBackgroundModes location,\n" +
    "  NSLocationAlwaysAndWhenInUseUsageDescription and Android's FOREGROUND_SERVICE_LOCATION\n" +
    "  (not ACCESS_BACKGROUND_LOCATION), and prints the App Store and Play review steps.\n" +
    "  background-audio has no npm package: it writes denext's DenextNowPlaying plugin\n" +
    "  (setNowPlaying / onMediaControl / setAudioSession: lock-screen and notification\n" +
    "  controls), UIBackgroundModes audio, and Android's media-playback foreground service\n" +
    "  with FOREGROUND_SERVICE_MEDIA_PLAYBACK.\n" +
    "  file-transfer has no npm package: it writes denext's DenextTransfer plugin\n" +
    "  (downloadToFile / uploadFile with progress, pause, resume and cancel in a URLSession\n" +
    "  background session on iOS and WorkManager on Android), AppDelegate's\n" +
    "  handleEventsForBackgroundURLSession forwarding, and androidx.work:work-runtime.\n" +
    "  application adds @capacitor/app and @capacitor/device (expo-application). camera also\n" +
    "  adds NSMicrophoneUsageDescription (video recorded in the page has sound).\n" +
    "  text-to-speech adds @capacitor-community/text-to-speech (expo-speech on the OS speech\n" +
    "  engine; the Android WebView has no speechSynthesis).\n" +
    "  contacts, calendar, print, brightness and intent-launcher add the plugins behind\n" +
    "  expo-contacts (@capgo/capacitor-contacts), expo-calendar (@ebarooni/capacitor-calendar),\n" +
    "  expo-print (@capgo/capacitor-printer), expo-brightness\n" +
    "  (@capacitor-community/screen-brightness) and expo-intent-launcher\n" +
    "  (@capgo/capacitor-intent-launcher, Android); contacts and calendar write their usage\n" +
    "  strings and permissions. contacts, calendar, print and brightness also write denext's\n" +
    "  DenextContacts / DenextCalendar / DenextPrint / DenextBrightness plugin beside the npm\n" +
    "  one (registered like context-menu) for the Expo calls it lacks: containers and change\n" +
    "  events, attendees and single occurrences, HTML to PDF and the iOS printer picker,\n" +
    "  Android's system brightness (brightness also declares WRITE_SETTINGS).\n" +
    "  app-config has no npm package: it writes an Expo app's own native config, read\n" +
    "  statically from app.json / app.config.* as `migrate --from expo` does, into the shell:\n" +
    "  ios.infoPlist usage strings and the ones its config plugins set (Info.plist, each only\n" +
    "  when absent), android.permissions (AndroidManifest.xml), and expo-build-properties'\n" +
    "  ios.deploymentTarget (project.pbxproj), android min / compile / target SDK\n" +
    "  (variables.gradle; each only raised) and usesCleartextTraffic. Run it with the other\n" +
    "  capabilities so the app's usage strings win over their defaults.\n" +
    "\n" +
    "  context-menu has no npm package: it writes denext's DenextContextMenu plugin (the\n" +
    "  UIContextMenuInteraction long-press menu with its lifted preview and UIMenu on iOS, a\n" +
    "  PopupMenu on Android) behind showContextMenu / useContextMenu. system-icons writes the\n" +
    "  DenextSystemIcon plugin (iOS only) that renders SF Symbols for <SystemIcon>.\n" +
    "\n" +
    "  share-extension, widget and live-activity add app extensions (no npm package either).\n" +
    "  share-extension: an iOS Share Extension target (ios/App/DenextShareExtension, embedded in\n" +
    "  the app) that queues shares in the App Group container and opens the app with its URL\n" +
    "  scheme (--scheme, else the app's first CFBundleURLSchemes entry), and Android SEND /\n" +
    "  SEND_MULTIPLE intent filters. widget --name <Name>: a WidgetKit extension target\n" +
    "  (ios/App/DenextWidgets) with <Name>Widget.swift, and an Android AppWidgetProvider with its\n" +
    "  layout and manifest receiver. --configurable <param:enum=a|b,...> makes it configurable on\n" +
    "  iOS 17+ (an App Intents enum per parameter; static on 14-16 and on Android), and\n" +
    "  setWidgetData(kind, data, { params }) stores the snapshot for the chosen values.\n" +
    "  live-activity --name <Name> (iOS 16.1+, the app keeps its\n" +
    "  deployment target): an ActivityKit UI in the same extension and NSSupportsLiveActivities.\n" +
    "  Each writes a denext plugin into the app, and the App Group (--app-group, default\n" +
    "  group.<bundle id>) into the app's and the extension's entitlements; the group must exist\n" +
    "  in the Apple Developer portal (automatic signing usually registers it). Several names are\n" +
    "  comma-separated. The widget and Live Activity views are yours to edit: an edited file is\n" +
    "  kept on the next run.\n" +
    "\n" +
    "  fastlane is release tooling for teams that already use fastlane (`mobile build` and\n" +
    "  `mobile submit` need none of it): it writes fastlane/Appfile (capacitor.config appId; the\n" +
    "  team and Play key from the environment), fastlane/Fastfile (ios and android build, beta\n" +
    "  and release lanes that run `denext mobile build <platform> --release` and hand its\n" +
    "  artifact to match, upload_to_testflight / upload_to_app_store and upload_to_play_store;\n" +
    "  flavor:, build_number:, bump: and track: pass through), fastlane/Matchfile, a\n" +
    "  fastlane/.gitignore and a Gemfile pinning fastlane. --ci also writes\n" +
    "  .github/workflows/mobile-release.yml at the repository root (ruby/setup-ruby, then\n" +
    "  `bundle exec fastlane <platform> <lane>`, credentials as repository secrets). Edited files\n" +
    "  are kept on a re-run (--force replaces them); nothing is installed and no `cap sync` runs.\n" +
    "\n" +
    "  iOS: writes DenextOtaPlugin.swift, DenextOtaStore.swift and DenextBridgeViewController.swift\n" +
    "  into ios/App/App/, adds them to the App target in project.pbxproj, and switches\n" +
    "  Main.storyboard and SceneDelegate to DenextBridgeViewController when they still use\n" +
    "  CAPBridgeViewController. Android: writes dev/denext/ota/*.java and calls\n" +
    "  DenextOta.prepare(this, bridgeBuilder) from MainActivity, when it is the stock one or one\n" +
    "  denext generated (recognised by its marker line, or as a shape an earlier denext shipped).\n" +
    "  Customised files are left alone and listed as one-line manual steps, as are a MainActivity\n" +
    "  or bridge view controller a newer denext wrote (never downgraded). Safe to run again, and\n" +
    "  run it after every denext upgrade: unedited templates from an earlier denext are upgraded\n" +
    "  in place (ship a new app binary afterwards).\n" +
    "\n" +
    "  --public-key ota.key.pub (from `denext ota keygen`) embeds the verifying key as Info.plist\n" +
    "  DenextOtaPublicKey and the dev.denext.ota.PUBLIC_KEY meta-data in AndroidManifest.xml\n" +
    "  (replacing an earlier one); the app then refuses any manifest not signed with its key.\n" +
    "  It exits non-zero when the key cannot be embedded on an installed platform, or an edited\n" +
    "  template was kept. --dry-run lists what it would write, upgrade or keep and changes\n" +
    "  nothing.\n" +
    "\n" +
    "  privacy: prints ios/App/App/PrivacyInfo.xcprivacy and validates it against Apple's\n" +
    "  required-reason categories and codes, the collected-data values, the entries the\n" +
    "  installed capabilities need (`mobile add` merges them; --write merges them now, never\n" +
    "  removing an entry) and whether Xcode copies it into the app. --check exits 1 on an error.\n" +
    "\n" +
    "  doctor: --store checks what App Review looks at (a leftover server.url, cleartext / ATS\n" +
    "  exceptions, a debuggable WebView, usage strings for installed plugins, the privacy\n" +
    "  manifest, icons and splash, allowNavigation *, the CSP, source maps and secrets in the\n" +
    "  export, account deletion when the app signs users in). --release checks the release\n" +
    "  security settings (debuggable WebView, cleartext, mixed content, allowNavigation *,\n" +
    "  android:debuggable, the CSP, secrets in the export). Both read the native config copies\n" +
    "  `cap sync` wrote (what ships) as well as capacitor.config.*; run them after export + sync.\n" +
    "  With a fastlane/ folder, --release also checks it: the Appfile ids against capacitor.config,\n" +
    "  a Gemfile with its lock, a Fastfile that skips `denext export` + `cap sync`, and secrets in\n" +
    "  or written into fastlane/.\n" +
    "\n" +
    "  inspect: prints how to attach Safari's Web Inspector (iOS) and chrome://inspect (Android)\n" +
    "  to the app's WebView, opens Safari (macOS) and Chrome at chrome://inspect/#devices, and\n" +
    "  lists `adb devices`, best effort. `mobile dev` turns WebView debugging on for its session\n" +
    "  only.\n" +
    MOBILE_BUILD_HELP,
  positionals: [
    {
      name: "action",
      help:
        "add | add-ota | sync | dev | fingerprint | privacy | doctor | inspect | assets | build | submit",
      required: true,
    },
    {
      name: "args",
      help:
        "add: capability names (see --list); add-ota, fingerprint, privacy, doctor, inspect: the Capacitor project (default: .); dev: the denext project (default: .); sync: ios or android (default: both); build, submit: ios or android",
      variadic: true,
    },
  ],
  flags: [
    {
      name: "force",
      type: "boolean",
      help:
        "Replace native template files that differ from denext's (loses local edits; add-ota, add auth-session / share-extension / widget / live-activity / native-module / fastlane)",
    },
    {
      name: "public-key",
      type: "string",
      valueName: "<file>",
      help:
        "Embed this OTA public key (base64 SPKI or PUBLIC KEY PEM) so the app verifies signatures",
    },
    {
      name: "ota-origin",
      type: "string",
      repeatable: true,
      valueName: "<origin>",
      help:
        "add-ota: pin an https origin the app takes UI updates from; the only one unsigned updates come from (repeatable, or comma-separated)",
    },
    {
      name: "dir",
      type: "string",
      valueName: "<dir>",
      help:
        "add, dev, fingerprint, privacy, doctor, inspect, assets, build, submit: the Capacitor project, with no fallback (default: the current directory)",
    },
    {
      name: "diff",
      type: "string",
      valueName: "<old.json>",
      help: "fingerprint: explain which inputs changed since an earlier `fingerprint --json`",
    },
    {
      name: "write",
      type: "boolean",
      help:
        "fingerprint: embed it in Info.plist (DenextNativeFingerprint) and AndroidManifest (dev.denext.native.FINGERPRINT); privacy: merge every installed capability's entries into PrivacyInfo.xcprivacy",
    },
    {
      name: "check",
      type: "boolean",
      help: "privacy: exit 1 when the privacy manifest has an error (a CI gate)",
    },
    {
      name: "store",
      type: "boolean",
      help: "doctor: App Review readiness checks (exit 1 on an error)",
    },
    {
      name: "release",
      type: "boolean",
      help:
        "doctor: release security checks (exit 1 on an error); build: a Release build (.ipa, .aab)",
    },
    {
      name: "app",
      type: "string",
      valueName: "<dir>",
      help:
        "doctor: the denext app scanned for sign-in and account deletion; build: the denext app to export (default: the Capacitor project)",
    },
    {
      name: "platform",
      type: "string",
      valueName: "<ios|android>",
      help: "inspect: one platform's steps; assets: one platform's files (default: both)",
    },
    {
      name: "lan",
      type: "boolean",
      help: "dev: serve on the LAN IPv4 so a physical device on the network can load it",
    },
    {
      name: "port",
      alias: "p",
      type: "number",
      valueName: "<port>",
      help: "dev: the dev server port (default: 3000)",
    },
    {
      name: "host",
      type: "string",
      valueName: "<host>",
      help: "dev: the host to bind and load (default: localhost; --lan picks the LAN IPv4)",
    },
    {
      name: "restore",
      type: "boolean",
      help:
        "dev: only put back what an interrupted session left (capacitor.config, Info.plist, the " +
        "dev URL in the native config copies), then run `cap copy`; build: put back what an " +
        "interrupted build's flavor edits left",
    },
    {
      name: "dry-run",
      type: "boolean",
      help:
        "add, add-ota, privacy --write, assets, build: print the plan (packages, native files, config, commands) and change nothing; inspect: print the steps without opening anything; submit: check everything, upload nothing",
    },
    {
      name: "list",
      type: "boolean",
      help: "add: list the capabilities and the plugins they install",
    },
    {
      name: "ci",
      type: "boolean",
      help:
        "add fastlane: also write .github/workflows/mobile-release.yml (fastlane in GitHub Actions)",
    },
    {
      name: "encrypted",
      type: "boolean",
      help:
        "add storage: also link SQLCipher, for openKeyValueStore(name, { encrypted: true }) (keys in secureStore)",
    },
    {
      name: "scheme",
      type: "string",
      valueName: "<scheme[,scheme]>",
      help:
        "add deep-links / auth-session / share-extension: custom URL schemes to register (comma-separated)",
    },
    {
      name: "domain",
      type: "string",
      valueName: "<host[,host]>",
      help: "add deep-links: universal link / app link domains (comma-separated)",
    },
    {
      name: "app-group",
      type: "string",
      valueName: "<group>",
      help:
        "add share-extension / widget / live-activity: the App Group shared with the extension (default: group.<bundle id>)",
    },
    {
      name: "name",
      type: "string",
      valueName: "<Name[,Name]>",
      help: "add widget / live-activity / native-module: PascalCase names (comma-separated)",
    },
    {
      name: "configurable",
      type: "string",
      valueName: "<param:enum=a|b[,…]>",
      help:
        "add widget: iOS 17+ configurable widget with these enum parameters (the first value is the default; re-runs keep them)",
    },
    ...MOBILE_BUILD_FLAGS,
  ],
};
